// Manager: UI web para conversar com o Claude Code (assinatura claude.ai) a partir de qualquer dispositivo.
// Várias conversas em paralelo, cada uma com sua sessão, pasta e modelo; o Claude roda no servidor, então fechar a aba não interrompe o trabalho.
// Também expõe o PC: explorador de arquivos, terminais (shell/SSH), integrações (MCPs, skills, chaves) e "abrir no PC".
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, statSync, createReadStream, lstatSync, unlinkSync } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join, dirname, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, hostname } from "node:os";
import { spawn, execFile } from "node:child_process";
import { painelAgenda } from "./agenda.mjs";
import webpush from "web-push";

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const STATE = join(ROOT, "state");
const WORKSPACE = join(ROOT, "workspace");
const PORT = Number(process.env.MANAGER_PORT || 7777);
const HOST = process.env.MANAGER_HOST || "0.0.0.0";
const STT_URL = process.env.STT_URL || "http://127.0.0.1:7778"; // stt/server.py (Whisper na GPU)
const TAREFAS_URL = process.env.MANAGER_TAREFAS_URL || "";
const CLAUDE_BIN =process.env.CLAUDE_BIN || join(HOME, ".local/bin/claude");
mkdirSync(STATE, { recursive: true });
mkdirSync(WORKSPACE, { recursive: true });

// Nunca deixar uma API key desviar a cobrança da assinatura.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const tokenFile = join(STATE, "token");
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString("base64url"), { mode: 0o600 });
const TOKEN = readFileSync(tokenFile, "utf8").trim();

const sh = (cmd, args, opts = {}) => new Promise((ok) =>
  execFile(cmd, args, { timeout: 8000, ...opts }, (err, stdout) => ok(err ? "" : String(stdout))));
const expand = (p) => resolve(String(p || HOME).replace(/^~(?=$|\/)/, HOME));

// --- Estado persistido: uma conversa por arquivo em state/conversations/ ----------------
const CONVS_DIR = join(STATE, "conversations");
mkdirSync(CONVS_DIR, { recursive: true });
const convs = new Map(); // id -> { id, title, sessionId, cwd, model, effort, messages, queue, createdAt, updatedAt, archived }

const newId = () => Date.now().toString(36) + randomBytes(3).toString("hex");
const titleOf = (messages) => (messages.find((m) => m.role === "user")?.text || "Nova conversa").replace(/\s+/g, " ").slice(0, 60);

function saveConv(c) {
  const f = join(CONVS_DIR, `${c.id}.json`);
  writeFileSync(f + ".tmp", JSON.stringify(c));
  renameSync(f + ".tmp", f);
}

for (const f of readdirSync(CONVS_DIR).filter((f) => f.endsWith(".json"))) {
  try { const c = JSON.parse(readFileSync(join(CONVS_DIR, f), "utf8")); c.queue = Array.isArray(c.queue) ? c.queue : []; convs.set(c.id, c); } catch {}
}

// Filas que ficaram pendentes num reinício: retoma depois que o servidor sobe.
const RESUME_TEXT = "[retomada automática] O serviço do manager reiniciou e cortou o seu último turno no meio. "
  + "Continue exatamente de onde parou a tarefa anterior, sem repetir o que já foi feito (confira o estado antes de refazer algo). "
  + "Se o trabalho já estava concluído, diga isso em uma linha.";
setTimeout(() => {
  for (const c of convs.values()) {
    if (running.has(c.id)) continue;
    const f = c.inFlight;
    if (f && Date.now() - f.at < 6 * 3600e3 && (f.retries || 0) < 3) {
      console.log(`[retomada] conv=${c.id} tentativa=${(f.retries || 0) + 1}`);
      c._resumeRetries = (f.retries || 0) + 1;
      runTurn(c, RESUME_TEXT);
    } else if (f) { delete c.inFlight; saveConv(c); }
    else if (c.queue?.length) { const t = c.queue.shift(); saveConv(c); runTurn(c, t); }
  }
}, 4000);

// Migração do formato antigo (conversation.json + archive-*.json) para um arquivo por conversa.
for (const f of readdirSync(STATE).filter((f) => f === "conversation.json" || /^archive-\d+\.json$/.test(f))) {
  try {
    const old = JSON.parse(readFileSync(join(STATE, f), "utf8"));
    if (old.messages?.length) {
      const at = old.messages[old.messages.length - 1].at || Date.now();
      const c = { id: newId(), title: titleOf(old.messages), sessionId: old.sessionId || null, messages: old.messages,
        createdAt: old.messages[0].at || at, updatedAt: at, archived: false };
      convs.set(c.id, c); saveConv(c);
    }
    renameSync(join(STATE, f), join(STATE, f + ".migrated"));
  } catch (e) { console.error("migração", f, e.message); }
}

function createConv(opts = {}) {
  const c = { id: newId(), title: "Nova conversa", sessionId: null, cwd: opts.cwd ? expand(opts.cwd) : ROOT,
    model: opts.model || null, effort: opts.effort || null, messages: [], queue: [],
    createdAt: Date.now(), updatedAt: Date.now(), archived: false };
  convs.set(c.id, c);
  return c;
}

// Ao reiniciar o serviço, salva o que estava em andamento (o turno é perdido, o histórico não).
process.on("SIGTERM", () => {
  for (const [id, r] of running) {
    r.msg.parts.push({ kind: "text", text: "\n\n_(interrompido: o servidor reiniciou; retomo sozinho quando ele voltar)_" });
    saveConv(convs.get(id));
  }
  for (const t of terms.values()) t.proc.kill();
  process.exit(0);
});

// --- Eventos (SSE) -------------------------------------------------------------------
const clients = new Set();
const running = new Map(); // id da conversa -> { abort, msg, startedAt, activity, tail }

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(line);
}

// Trecho final do texto de uma resposta, sem markdown pesado (para cartões e notificações).
const plain = (s) => s.replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>|]+/g, "").replace(/\s+/g, " ").trim();
const snippet = (msg, n = 280) => { const t = plain(msg?.parts?.filter((p) => p.kind === "text").map((p) => p.text).join(" ") || ""); return t.length > n ? "…" + t.slice(-n) : t; };
const lastReply = (c) => { for (let i = c.messages.length - 1; i >= 0; i--) if (c.messages[i].role === "assistant") return c.messages[i]; return null; };

const meta = (c) => {
  const r = running.get(c.id);
  return { id: c.id, title: c.title, updatedAt: c.updatedAt, running: !!r, cwd: c.cwd || ROOT,
    model: c.model, effort: c.effort, goal: c.goal || null, pinned: !!c.pinned, archived: !!c.archived, queued: c.queue?.length || 0, started: !!c.messages.length,
    unread: !!c.unread, status: c.status || null, startedAt: r?.startedAt || null, activity: r?.activity || null,
    tail: r ? r.tail || "" : snippet(lastReply(c), 220) };
};

// Atividade ao vivo de cada turno (ferramenta atual e fim do texto), no máximo ~3 eventos por segundo por conversa.
function activity(conv, patch) {
  const r = running.get(conv); if (!r) return;
  Object.assign(r, patch);
  if (r.actTimer) return;
  r.actTimer = setTimeout(() => { r.actTimer = null; broadcast({ type: "activity", conv, activity: r.activity, tail: r.tail }); }, 300);
}

// --- Uso da assinatura (limites de 5 h e 7 dias): consulta o mesmo endpoint do /usage do Claude Code a cada minuto.
// A taxa de consumo é a inclinação (regressão linear) das amostras dos últimos 30 min, em pontos percentuais por hora.
const USAGE_FILE = join(STATE, "usage.json");
let usageHist = []; // [{ at, five, week }]
try { usageHist = JSON.parse(readFileSync(USAGE_FILE, "utf8")); } catch {}
let usage = null;

function slope(points, key, windowMs = 30 * 60e3) {
  const now = Date.now();
  const pts = points.filter((p) => p[key] != null && now - p.at <= windowMs);
  if (pts.length < 2 || pts[pts.length - 1].at - pts[0].at < 4 * 60e3) return null;
  const xs = pts.map((p) => (p.at - pts[0].at) / 3600e3), ys = pts.map((p) => p[key]);
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? Math.max(0, num / den) : null;
}

async function pollUsage() {
  try {
    const tok = JSON.parse(readFileSync(join(HOME, ".claude/.credentials.json"), "utf8")).claudeAiOauth?.accessToken;
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: `Bearer ${tok}`, "anthropic-beta": "oauth-2025-04-20" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const at = Date.now(), five = d.five_hour?.utilization ?? null, week = d.seven_day?.utilization ?? null;
    // Janela reiniciada: descarta amostras antigas para a queda não virar taxa negativa.
    const last = usageHist[usageHist.length - 1];
    if (last && five != null && last.five != null && five < last.five) usageHist.forEach((p) => (p.five = null));
    if (last && week != null && last.week != null && week < last.week) usageHist.forEach((p) => (p.week = null));
    usageHist.push({ at, five, week });
    usageHist = usageHist.filter((p) => at - p.at <= 6 * 3600e3);
    writeFile(USAGE_FILE, JSON.stringify(usageHist)).catch(() => {});
    usage = { at, error: null,
      five: { pct: five, resetsAt: d.five_hour?.resets_at || null, rate: slope(usageHist, "five") },
      week: { pct: week, resetsAt: d.seven_day?.resets_at || null, rate: slope(usageHist, "week", 2 * 3600e3) } };
  } catch (e) {
    usage = { ...(usage || {}), error: e.message };
  }
  broadcast({ type: "usage", usage });
}
pollUsage();
setInterval(pollUsage, 60e3);

// --- Notificações: fim de turno, erro, objetivo; persistidas e marcadas como lidas em todos os aparelhos ---------
const NOTES_FILE = join(STATE, "notes.json");
let notes = [];
try { notes = JSON.parse(readFileSync(NOTES_FILE, "utf8")); } catch {}
const saveNotes = () => { writeFileSync(NOTES_FILE + ".tmp", JSON.stringify(notes)); renameSync(NOTES_FILE + ".tmp", NOTES_FILE); };
function notify(c, kind, text) {
  const note = { id: newId(), conv: c.id, title: c.title, kind, text: String(text || "").slice(0, 400), at: Date.now(), read: false };
  notes.push(note); if (notes.length > 300) notes = notes.slice(-300);
  saveNotes();
  broadcast({ type: "note", note });
  pushNote(note);
}

// Web push (iPhone e app fechado): aparelhos inscritos em state/push-subs.json, chaves VAPID em state/vapid.json.
const PUSH_FILE = join(STATE, "push-subs.json");
const NOTE_TXT = { ok: "terminou", error: "deu erro", stopped: "foi interrompida", "goal-met": "cumpriu o objetivo", "goal-paused": "pausou o objetivo", "goal-capped": "atingiu o teto do objetivo" };
let vapid = null, pushSubs = [];
try { vapid = JSON.parse(readFileSync(join(STATE, "vapid.json"), "utf8")); webpush.setVapidDetails(process.env.MANAGER_PUSH_CONTACT || "mailto:admin@localhost", vapid.publicKey, vapid.privateKey); } catch {}
try { pushSubs = JSON.parse(readFileSync(PUSH_FILE, "utf8")); } catch {}
const savePush = () => { writeFileSync(PUSH_FILE + ".tmp", JSON.stringify(pushSubs), { mode: 0o600 }); renameSync(PUSH_FILE + ".tmp", PUSH_FILE); };
function pushSend(payload) {
  if (!vapid) return;
  const body = JSON.stringify(payload);
  for (const sub of [...pushSubs]) {
    webpush.sendNotification(sub, body, { TTL: 3600, urgency: "high" }).catch((e) => {
      if (e.statusCode === 404 || e.statusCode === 410) { pushSubs = pushSubs.filter((x) => x.endpoint !== sub.endpoint); savePush(); } // aparelho desinscrito
      else console.error("push:", e.statusCode || e.message);
    });
  }
}
function pushNote(n) {
  pushSend({ title: n.title, body: `${NOTE_TXT[n.kind] || ""}${n.text ? ": " + n.text : ""}`.slice(0, 180), tag: n.conv, conv: n.conv });
}
function markSeen(id) {
  let changed = false;
  for (const n of notes) if (!n.read && (!id || n.conv === id)) { n.read = true; changed = true; }
  for (const c of id ? [convs.get(id)].filter(Boolean) : convs.values()) if (c.unread) { c.unread = false; saveConv(c); changed = true; }
  if (changed) { saveNotes(); broadcast({ type: "seen", conv: id || null }); broadcast(listEvent()); }
}

function listEvent() {
  const items = [...convs.values()].filter((c) => !c.archived && (c.messages.length || running.has(c.id)))
    .sort((a, b) => (b.pinned - a.pinned) || b.updatedAt - a.updatedAt).map(meta);
  return { type: "list", convs: items, terms: [...terms.values()].map(termMeta) };
}

function snapshot(c) {
  return { type: "snapshot", conv: c.id, ...meta(c), messages: c.messages, queue: c.queue || [] };
}

// --- Execução de um turno -------------------------------------------------------------
const clip = (s, n = 4000) => (s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} caracteres)` : s);

function toolLabel(name, input = {}) {
  const short = name.replace(/^mcp__(claude_ai_)?/, "").replace(/__/g, " · ");
  const detail = input.command || input.description || input.query || input.url || input.file_path || input.pattern
    || input.skill || input.recipient || input.prompt || "";
  return { name: short, detail: String(detail).slice(0, 160), input: clip(JSON.stringify(input, null, 2)) };
}

function resultText(block) {
  const c = block.content;
  if (typeof c === "string") return clip(c);
  if (Array.isArray(c)) return clip(c.map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n"));
  return "";
}

const baseOptions = (c) => ({
  cwd: c.cwd || ROOT,
  pathToClaudeCodeExecutable: CLAUDE_BIN,
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  additionalDirectories: [HOME, "/"],
  extraArgs: { chrome: null },
  // /goal: o hook de parada reabre o turno até a condição ser cumprida; o teto padrão (9) é curto para tarefas longas.
  env: { ...process.env, CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP || "200" },
  ...(c.model && { model: c.model }),
  ...(c.effort && { effort: c.effort }),
});

async function runTurn(c, text) {
  const abort = new AbortController();
  const userMsg = { role: "user", text, at: Date.now() };
  const msg = { role: "assistant", parts: [], at: Date.now() };
  if (!c.messages.length || c.title === "Nova conversa") c.title = titleOf([userMsg]);
  c.messages.push(userMsg, msg);
  c.updatedAt = Date.now();
  running.set(c.id, { abort, msg, startedAt: Date.now(), activity: "pensando…", tail: "" });
  // "Em andamento" fica no disco: se o serviço cair no meio, o turno é retomado ao subir (ver retomada abaixo).
  c.inFlight = { text: text.slice(0, 2000), at: Date.now(), retries: c._resumeRetries || 0 };
  delete c._resumeRetries;
  saveConv(c);
  const autosave = setInterval(() => { try { saveConv(c); } catch {} }, 15000);
  const conv = c.id;
  broadcast({ type: "user", conv, message: userMsg });
  broadcast({ type: "start", conv });
  broadcast(listEvent());

  const toolsById = new Map();
  const subOwner = new Map(); // id de ferramenta usada por subagente → cartão do Agent de topo
  const subLog = (part, entry) => { (part.log ||= []).push(entry); if (part.log.length > 400) part.log.splice(0, part.log.length - 400); };
  let textPart = null, subagentSteps = 0, goalCapped = false;
  // /goal travado: se as continuações repetem as mesmas ferramentas, o modelo está esperando o usuário — pausa em vez de gastar mensagens
  let iterSig = [], lastSig = null, stalls = 0, goalPaused = false;
  const goalArg = text.match(/^\/goal(?:\s+([\s\S]*))?$/)?.[1]?.trim();
  if (goalArg) { // "/goal" sozinho só mostra o estado
    c.goal = goalArg !== "clear" ? { condition: goalArg, iterations: 0, at: Date.now() } : null;
    broadcast({ type: "meta", conv, meta: meta(c) });
  }
  const goalPart = (status, text) => {
    const part = { kind: "goal", status, text };
    msg.parts.push(part); textPart = null;
    broadcast({ type: "tool", conv, part });
    if (status !== "pending") notify(c, "goal-" + status, text);
  };
  const appendText = (delta) => {
    if (!textPart) { textPart = { kind: "text", text: "" }; msg.parts.push(textPart); }
    textPart.text += delta;
    broadcast({ type: "delta", conv, text: delta });
    activity(conv, { activity: "escrevendo…", tail: plain(textPart.text).slice(-220) });
  };

  try {
    const fork = c.forkFrom && !c.forked;
    const q = query({
      prompt: text,
      options: {
        ...baseOptions(c),
        resume: c.sessionId || undefined,
        ...(fork && { forkSession: true }),
        includePartialMessages: true,
        abortController: abort,
        systemPrompt: { type: "preset", preset: "claude_code",
          append: "Você está respondendo pela UI web do manager. O usuário vê markdown renderizado. Seja conciso. "
            + "Toda mensagem que contenha texto do usuário (mesmo misturada a avisos de sistema, de MCP ou de tarefas em segundo plano) deve ser atendida; "
            + "nunca responda só 'No response requested.'. Se a mensagem for apenas um aviso automático de tarefa, diga em uma linha o que ele significa e continue o trabalho em andamento." },
      },
    });

    for await (const m of q) {
      if (m.session_id && m.session_id !== c.sessionId) { c.sessionId = m.session_id; if (fork) c.forked = true; }

      if (m.type === "stream_event") {
        const ev = m.event;
        if (m.parent_tool_use_id) continue; // texto de subagentes não vai para o chat
        if (ev.type === "content_block_start" && ev.content_block?.type === "text") textPart = null;
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") appendText(ev.delta.text);
      } else if (m.type === "assistant") {
        if (m.message?.model === "<synthetic>" && !m.parent_tool_use_id) // saída de comandos locais (/goal, /compact…)
          for (const block of m.message.content || []) if (block.type === "text" && block.text) appendText(block.text + "\n\n");
        const owner = m.parent_tool_use_id && (toolsById.get(m.parent_tool_use_id) || subOwner.get(m.parent_tool_use_id));
        if (owner) { // o que o subagente escreve fica legível no cartão dele
          const txt = (m.message.content || []).filter((b) => b.type === "text" && b.text?.trim()).map((b) => b.text).join("\n\n");
          if (txt) { subLog(owner, { t: "text", text: clip(txt, 3000) }); broadcast({ type: "tool_update", conv, part: owner }); }
        }
        for (const block of m.message.content || []) {
          if (block.type !== "tool_use") continue;
          const parent = m.parent_tool_use_id && (toolsById.get(m.parent_tool_use_id) || subOwner.get(m.parent_tool_use_id));
          if (parent) { // passos de subagente contam no cartão do Agent que os disparou
            const lbl = toolLabel(block.name, block.input);
            parent.sub = (parent.sub || 0) + 1; parent.subLast = lbl.name;
            subLog(parent, { t: "tool", id: block.id, name: lbl.name, detail: lbl.detail, input: clip(lbl.input, 1500), status: "running" });
            subOwner.set(block.id, parent);
            subagentSteps++;
            broadcast({ type: "tool_update", conv, part: parent });
            activity(conv, { activity: `${parent.name} · ${parent.sub} passos, ${parent.subLast}` });
            continue;
          }
          if (m.parent_tool_use_id || toolsById.has(block.id)) continue;
          iterSig.push(block.name + JSON.stringify(block.input));
          const part = { kind: "tool", id: block.id, ...toolLabel(block.name, block.input), status: "running" };
          toolsById.set(block.id, part);
          msg.parts.push(part);
          textPart = null;
          broadcast({ type: "tool", conv, part });
          activity(conv, { activity: part.detail ? `${part.name}: ${part.detail}` : part.name });
        }
      } else if (m.type === "system" && m.subtype === "notification" && m.key === "stop-hook-block-cap") {
        goalCapped = true;
      } else if (m.type === "user") {
        for (const block of Array.isArray(m.message?.content) ? m.message.content : []) {
          if (!m.parent_tool_use_id && block.type === "text" && block.text?.startsWith("Stop hook feedback:")) {
            const reason = block.text.replace(/^Stop hook feedback:\s*(\[[^\]]*\]:\s*)?/, "");
            if (c.goal) { c.goal.iterations++; c.goal.last = reason.slice(0, 500); broadcast({ type: "meta", conv, meta: meta(c) }); }
            goalPart("pending", clip(reason, 1500));
            const sig = iterSig.join("\n"); iterSig = [];
            stalls = sig === lastSig ? stalls + 1 : 0; lastSig = sig;
            if (stalls >= 2 && !goalPaused) {
              goalPaused = true;
              goalPart("paused", "Objetivo pausado: as últimas continuações repetiram as mesmas ações sem avançar, então o que falta depende de você. Mande \"continue\" para retomar ou /goal clear para encerrar.");
              abort.abort();
            }
          }
          const owner = block.type === "tool_result" && subOwner.get(block.tool_use_id);
          const step = owner && owner.log?.find((e) => e.id === block.tool_use_id);
          if (step) {
            step.status = block.is_error ? "error" : "done";
            step.result = clip(resultText(block), 1500);
            broadcast({ type: "tool_update", conv, part: owner });
          }
          const part = block.type === "tool_result" && toolsById.get(block.tool_use_id);
          if (part) {
            part.status = block.is_error ? "error" : "done";
            part.result = resultText(block);
            broadcast({ type: "tool_update", conv, part });
            if (![...toolsById.values()].some((p) => p.status === "running")) activity(conv, { activity: "pensando…" });
          }
        }
      } else if (m.type === "result") {
        if (c.goal && m.subtype === "success" && !abort.signal.aborted) {
          if (goalCapped) goalPart("capped", "O teto de continuações foi atingido e o objetivo segue ativo. Mande \"continue\" para seguir ou /goal clear para encerrar.");
          else if (goalArg === undefined || goalArg) { goalPart("met", "Objetivo cumprido: " + c.goal.condition); c.goal = null; broadcast({ type: "meta", conv, meta: meta(c) }); }
        }
        msg.result = { ok: m.subtype === "success", turns: m.num_turns, ms: m.duration_ms, cost: m.total_cost_usd, subagentSteps };
        if (m.subtype !== "success" && !msg.parts.length) appendText(`⚠️ ${m.subtype}`);
      }
    }
  } catch (err) {
    if (goalPaused) { /* pausa do /goal já registrada */ }
    else if (abort.signal.aborted) appendText("\n\n_(interrompido)_");
    else { appendText(`\n\n⚠️ Erro: ${err.message}`); console.error(err); }
  } finally {
    for (const part of toolsById.values()) {
      if (part.status === "running") part.status = "stopped";
      for (const e of part.log || []) if (e.status === "running") e.status = "stopped";
    }
    clearInterval(autosave);
    delete c.inFlight;
    clearTimeout(running.get(c.id)?.actTimer);
    running.delete(c.id);
    c.updatedAt = Date.now();
    c.status = abort.signal.aborted ? "stopped" : msg.result && !msg.result.ok || msg.parts.some((p) => p.kind === "text" && p.text.includes("⚠️ Erro")) ? "error" : "ok";
    c.unread = true;
    saveConv(c);
    if (!goalPaused) notify(c, c.status, snippet(msg) || (c.status === "stopped" ? "interrompida" : "sem texto"));
    broadcast({ type: "end", conv, message: msg });
    // Mensagens enviadas enquanto o turno rodava entram em seguida, na ordem.
    // Parar não descarta a fila: quem para com mensagem na fila quer que ela entre já.
    const next = c.queue?.shift();
    if (next) saveConv(c);
    broadcast({ type: "queue", conv, queue: c.queue || [] });
    if (next) runTurn(c, next); else broadcast(listEvent());
  }
}

// --- Catálogo: skills, modelos, agentes, MCPs, SSH, chaves, serviços --------------------
// Sobe um processo do Claude sem prompt só para perguntar o que ele enxerga, e fecha.
let catalog = null, catalogAt = 0, catalogLoading = null;

async function probeClaude() {
  let release; const hold = new Promise((r) => (release = r));
  const q = query({ prompt: (async function* () { await hold; })(), options: baseOptions({ cwd: ROOT }) });
  try {
    const [skills, models, agents] = await Promise.all([q.supportedCommands(), q.supportedModels(), q.supportedAgents()]);
    let mcp = await q.mcpServerStatus();
    for (let i = 0; i < 12 && mcp.some((s) => s.status === "pending"); i++) {
      await new Promise((r) => setTimeout(r, 1000)); mcp = await q.mcpServerStatus();
    }
    return {
      skills: skills.map((s) => ({ name: s.name, description: s.description, hint: s.argumentHint })),
      models: models.map((m) => ({ value: m.value, name: m.displayName, description: m.description })),
      agents: agents.map((a) => ({ name: a.name, description: a.description })),
      mcp: mcp.map((s) => ({ name: s.name, status: s.status, scope: s.scope, tools: (s.tools || []).map((t) => t.name),
        server: s.serverInfo ? `${s.serverInfo.name} ${s.serverInfo.version || ""}`.trim() : "" })),
    };
  } finally { release(); q.close(); }
}

function sshHosts() {
  const out = []; let cur = null;
  let text = ""; try { text = readFileSync(join(HOME, ".ssh/config"), "utf8"); } catch { return out; }
  for (const raw of text.split("\n")) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const [k, ...rest] = line.split(/\s+/); const v = rest.join(" ");
    if (/^host$/i.test(k)) { cur = { alias: rest.find((a) => !/^[\d.]+$/.test(a)) || rest[0], aliases: rest, hostname: "", user: "" }; if (!v.includes("*")) out.push(cur); else cur = null; }
    else if (cur && /^hostname$/i.test(k)) cur.hostname = v;
    else if (cur && /^user$/i.test(k)) cur.user = v;
    else if (cur && /^identityfile$/i.test(k)) cur.key = v;
  }
  return out;
}

async function sshKeys() {
  const dir = join(HOME, ".ssh"); const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".pub"))) {
    const fp = (await sh("ssh-keygen", ["-lf", join(dir, f)])).trim().split(" ");
    out.push({ name: f.replace(/\.pub$/, ""), path: join(dir, f.replace(/\.pub$/, "")), bits: fp[0], fingerprint: fp[1],
      comment: fp.slice(2, -1).join(" "), type: (fp.at(-1) || "").replace(/[()]/g, ""), pub: readFileSync(join(dir, f), "utf8").trim() });
  }
  return out;
}

async function services() {
  const names = ["manager", "whatsapp-bridge", "manager-stt"];
  const out = await Promise.all(names.map(async (n) => ({ name: n, state: (await sh("systemctl", ["--user", "is-active", n])).trim() || "inactive" })));
  const ts = (await sh("tailscale", ["status", "--json"]));
  try { const j = JSON.parse(ts); out.push({ name: "tailscale", state: j.BackendState === "Running" ? "active" : j.BackendState, detail: j.Self?.DNSName?.replace(/\.$/, "") }); } catch {}
  return out;
}

function loadCatalog(force) {
  if (catalogLoading) return catalogLoading;
  if (catalog && !force && Date.now() - catalogAt < 5 * 60e3) return Promise.resolve(catalog);
  catalogLoading = (async () => {
    const [claude, keys, svc] = await Promise.all([probeClaude().catch((e) => ({ error: e.message, skills: [], models: [], agents: [], mcp: [] })), sshKeys().catch(() => []), services()]);
    catalog = { ...claude, ssh: sshHosts(), keys, services: svc, host: hostname(), home: HOME, root: ROOT, workspace: WORKSPACE, at: Date.now() };
    catalogAt = Date.now();
    return catalog;
  })().finally(() => { catalogLoading = null; });
  return catalogLoading;
}
loadCatalog().catch(() => {});

// --- Terminais: shell ou SSH num pty (term/ptybridge.py), transmitido por SSE ------------------
const terms = new Map(); // id -> { id, title, cmd, cwd, proc, buf, clients, alive, code, createdAt }
const termMeta = (t) => ({ id: t.id, title: t.title, cwd: t.cwd, alive: t.alive, code: t.code, createdAt: t.createdAt });

function createTerm({ ssh, cwd, cmd }) {
  const id = "t" + newId();
  const argv = ssh ? ["ssh", ssh] : cmd ? ["bash", "-lc", cmd] : [];
  const dir = expand(cwd || HOME);
  const proc = spawn("python3", ["-I", join(ROOT, "term/ptybridge.py"), ...argv], { cwd: existsSync(dir) ? dir : HOME,
    stdio: ["pipe", "pipe", "pipe", "pipe"], env: { ...process.env, TERM: "xterm-256color" } });
  const t = { id, title: ssh ? `ssh ${ssh}` : cmd || `shell ${dir.replace(HOME, "~")}`, cwd: dir, proc, buf: [], size: 0, clients: new Set(), alive: true, code: null, createdAt: Date.now() };
  const push = (chunk) => {
    t.buf.push(chunk); t.size += chunk.length;
    while (t.size > 256e3 && t.buf.length > 1) t.size -= t.buf.shift().length;
    const line = `data: ${JSON.stringify({ d: chunk.toString("base64") })}\n\n`;
    for (const res of t.clients) res.write(line);
  };
  proc.stdout.on("data", push);
  proc.stderr.on("data", push);
  proc.on("close", (code) => {
    t.alive = false; t.code = code;
    for (const res of t.clients) res.write(`data: ${JSON.stringify({ exit: code })}\n\n`);
    broadcast(listEvent());
  });
  terms.set(id, t);
  broadcast(listEvent());
  return t;
}

// --- Arquivos ------------------------------------------------------------------------
const MIME = { ".html": "text/html", ".htm": "text/html", ".json": "application/json", ".pdf": "application/pdf", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".zip": "application/zip" };

async function listDir(path, hidden) {
  const names = await readdir(path);
  const entries = await Promise.all(names.filter((n) => hidden || !n.startsWith(".")).map(async (name) => {
    const p = join(path, name);
    try {
      const l = lstatSync(p); const s = l.isSymbolicLink() ? await stat(p).catch(() => l) : l;
      return { name, dir: s.isDirectory(), size: s.size, mtime: s.mtimeMs, link: l.isSymbolicLink() };
    } catch { return { name, dir: false, size: 0, mtime: 0, broken: true }; }
  }));
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, "pt-BR", { numeric: true }));
  return { path, parent: path === "/" ? null : dirname(path), entries };
}

function openOnPc({ path, app, ssh }) {
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || ":1" };
  const go = (cmd, args) => spawn(cmd, args, { env, detached: true, stdio: "ignore" }).unref();
  if (ssh) return go("gnome-terminal", ["--", "ssh", ssh]);
  const p = expand(path);
  const dir = existsSync(p) && statSync(p).isDirectory() ? p : dirname(p);
  if (app === "code") return go("code", [p]);
  if (app === "terminal") return go("gnome-terminal", [`--working-directory=${dir}`]);
  if (app === "folder") return go("xdg-open", [dir]);
  go("xdg-open", [p]);
}

// --- WhatsApp unificado (somente leitura): pessoal (SQLite do bridge) + Comercial/Suporte (CRM em produção) ----
// Nada aqui escreve: o SQLite abre com readOnly e o Postgres roda em transação read only com statement_timeout.
const WA_STORE = process.env.MANAGER_WA_STORE || join(HOME, "apps/whatsapp-mcp/whatsapp-bridge/store");
const WA_TRANSC = join(ROOT, "controle/state/transcricoes.json");
// Opcional: host SSH e comando psql do CRM (ex.: 'docker exec -i <container> psql -U postgres -At -q'). Sem eles, só o WhatsApp pessoal aparece.
const CRM_SSH = process.env.MANAGER_CRM_SSH || "";
const CRM_CMD = process.env.MANAGER_CRM_CMD || "";
const waCache = new Map(); // chave -> { at, data, p }
function cached(key, ttl, fn) {
  const e = waCache.get(key);
  if (e?.data !== undefined && Date.now() - e.at < ttl) return Promise.resolve(e.data);
  if (e?.p) return e.p;
  const p = fn().then((data) => { waCache.set(key, { at: Date.now(), data }); return data; })
    .catch((err) => { if (e?.data !== undefined) { waCache.set(key, { ...e, p: null }); return e.data; } waCache.delete(key); throw err; });
  waCache.set(key, { ...(e || {}), p });
  if (waCache.size > 300) for (const k of [...waCache.keys()].slice(0, 100)) waCache.delete(k);
  return p;
}
let sqliteMod = null;
async function waDb(name) { sqliteMod ||= await import("node:sqlite"); return new sqliteMod.DatabaseSync(join(WA_STORE, name), { readOnly: true }); }
const waTs = (s) => Date.parse(String(s || "").replace(" ", "T")) || 0;
let transc = { at: 0, mtime: 0, map: {} };
function transcricoes() {
  try {
    if (Date.now() - transc.at < 10e3) return transc.map;
    const m = statSync(WA_TRANSC).mtimeMs; transc.at = Date.now();
    if (m !== transc.mtime) transc = { at: Date.now(), mtime: m, map: JSON.parse(readFileSync(WA_TRANSC, "utf8")) };
  } catch {}
  return transc.map;
}
function waNames() {
  return cached("names", 300e3, async () => {
    const db = await waDb("whatsapp.db");
    try {
      const n = {}, pn = {};
      for (const r of db.prepare("select their_jid, full_name, push_name, first_name, business_name from whatsmeow_contacts").all()) {
        const v = r.full_name || r.first_name || r.push_name || r.business_name; if (v) n[r.their_jid.split("@")[0]] = v;
      }
      for (const r of db.prepare("select lid, pn from whatsmeow_lid_map").all()) { pn[r.lid] = r.pn; if (n[r.pn] && !n[r.lid]) n[r.lid] = n[r.pn]; }
      return { n, pn };
    } finally { db.close(); }
  });
}
const fone = (d) => { d = String(d || ""); const m = d.match(/^55(\d\d)(\d{4,5})(\d{4})$/); return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : d ? "+" + d : ""; };
const MEDIA_LABEL = { image: "📷 Foto", audio: "🎤 Áudio", video: "🎬 Vídeo", document: "📄 Documento", sticker: "Figurinha" };

async function waPessoalChats(q) {
  const { n, pn } = await waNames();
  const db = await waDb("messages.db");
  try {
    const rows = db.prepare(`with last as (select chat_jid, id, content, timestamp, is_from_me, media_type, filename, sender,
        row_number() over (partition by chat_jid order by timestamp desc) rn from messages),
      me as (select chat_jid, max(timestamp) t from messages where is_from_me = 1 group by chat_jid),
      novas as (select m.chat_jid, count(*) k from messages m left join me on me.chat_jid = m.chat_jid where m.timestamp > coalesce(me.t, '') group by 1)
      select c.jid, c.name, l.id, l.content, l.timestamp, l.is_from_me, l.media_type, l.filename, l.sender, coalesce(novas.k, 0) novas
      from chats c join last l on l.chat_jid = c.jid and l.rn = 1 left join novas on novas.chat_jid = c.jid
      where c.jid not like '%@newsletter' and c.jid not like 'status@%' and c.jid not like '%@broadcast'
      order by l.timestamp desc`).all();
    let hits = null;
    if (q && q.length >= 3) hits = new Set(db.prepare("select distinct chat_jid from messages where content like ? escape '\\'")
      .all(`%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`).map((r) => r.chat_jid));
    const tr = transcricoes();
    const out = rows.map((r) => {
      const user = r.jid.split("@")[0], grupo = r.jid.endsWith("@g.us");
      const nome = (grupo ? r.name : n[user]) || (r.name && r.name !== user ? r.name : null) || fone(pn[user] || (r.jid.endsWith("@s.whatsapp.net") ? user : "")) || user;
      let preview = (r.content || "").trim();
      if (r.media_type === "audio") preview = "🎤 " + (tr[r.id] || "Áudio");
      else if (r.media_type) preview = `${MEDIA_LABEL[r.media_type] || r.media_type}${preview ? ": " + preview : ""}`;
      const autor = grupo && !r.is_from_me ? (n[(r.sender || "").split("@")[0]] || "").split(" ")[0] : "";
      return { fonte: "pessoal", id: r.jid, nome, sub: grupo ? "grupo" : fone(pn[user] || (r.jid.endsWith("@s.whatsapp.net") ? user : "")),
        grupo, preview: (autor ? autor + ": " : "") + preview.slice(0, 200), at: waTs(r.timestamp), eu: !!r.is_from_me,
        esperando: !r.is_from_me && !grupo, novas: r.is_from_me ? 0 : r.novas };
    });
    if (!q) return out.slice(0, 400);
    const f = q.toLowerCase();
    return out.filter((c) => hits?.has(c.id) || [c.nome, c.sub, c.preview].some((x) => String(x || "").toLowerCase().includes(f)));
  } finally { db.close(); }
}

async function waPessoalMessages(jid, antes) {
  const { n } = await waNames();
  const db = await waDb("messages.db");
  try {
    const chat = db.prepare("select jid, name from chats where jid = ?").get(jid);
    if (!chat) return null;
    const rows = db.prepare(`select id, sender, content, timestamp, is_from_me, media_type, filename from messages
      where chat_jid = ? ${antes ? "and timestamp < ?" : ""} order by timestamp desc limit 80`).all(...(antes ? [jid, antes] : [jid]));
    let files = [];
    try { files = readdirSync(join(WA_STORE, jid)); } catch {}
    const tr = transcricoes();
    const messages = rows.reverse().map((r) => {
      const f = r.media_type && files.find((x) => x.startsWith(r.id + "_"));
      return { id: r.id, eu: !!r.is_from_me, autor: r.is_from_me ? "Você" : n[(r.sender || "").split("@")[0]] || fone(r.sender), text: r.content || "",
        tipo: r.media_type || "text", nomeArquivo: r.filename || "", arquivo: f ? join(WA_STORE, jid, f) : null, transcricao: tr[r.id] || null, at: waTs(r.timestamp) };
    });
    return { messages, antes: rows.length === 80 ? rows[rows.length - 1].timestamp : null };
  } finally { db.close(); }
}

// Uma consulta ao Postgres do CRM via ssh + docker exec; o SQL vai pelo stdin e devolve uma linha JSON.
function crmQuery(select) {
  if (!CRM_SSH || !CRM_CMD) return Promise.resolve([]);
  return new Promise((ok, no) => {
    const p = spawn("ssh", ["-o", "ConnectTimeout=15", "-o", "BatchMode=yes", CRM_SSH, CRM_CMD], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill(); no(new Error("CRM: tempo esgotado")); }, 75e3);
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); no(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      // json_agg quebra linha entre elementos: o JSON vai da primeira linha que abre [ ou { até o fim.
      const lines = out.split("\n"), at = lines.findIndex((l) => /^[[{]/.test(l));
      const line = at >= 0 ? lines.slice(at).join("\n").trim() : "";
      if (code !== 0 || !line) return no(new Error(`CRM: ${((err.match(/ERROR:.*/) || [])[0] || err.trim().split("\n").pop() || "sem resposta").slice(0, 200)}`));
      try { ok(JSON.parse(line)); } catch (e) { no(e); }
    });
    p.stdin.end(`begin transaction read only;\n${select};\nrollback;\n`);
  });
}
const pgLit = (s) => { let tag; do tag = "q" + randomBytes(4).toString("hex"); while (s.includes(tag)); return `$${tag}$${s}$${tag}$`; };

function waCrmChats() {
  return cached("crm:chats", 60e3, () => crmQuery(`select coalesce(json_agg(x order by x.ts desc nulls last), '[]') from (
    select c.id, lower(l.nome) fonte, coalesce(nullif(c.nome_manual, ''), nullif(c.nome, ''), 'contato …' || right(c.wa_id, 4)) nome, c.wa_id,
      a.name cartorio, extract(epoch from c.last_message_at) * 1000 ts, c.unread_count unread, lm.direction dir, lm.type,
      left(coalesce(lm.body, c.last_message_preview, ''), 200) preview
    from whatsapp_conversation c join whatsapp_line l on l.id = c.line_id left join account a on a.id = c.account_id
    left join lateral (select direction, type, body from whatsapp_message m where m.conversation_id = c.id
      and m.type not in ('edit', 'revoke', 'reaction', 'errors') order by m.timestamp desc limit 1) lm on true
    where l.nome in ('Comercial', 'Suporte')) x`))
    .then((rows) => rows.map((r) => ({ fonte: r.fonte, id: r.id, nome: r.nome, sub: r.cartorio || fone(r.wa_id), cartorio: r.cartorio || null,
      preview: (r.dir === "out" ? "Você: " : "") + (r.preview || "").replace(/^Você: /, ""), at: Math.round(r.ts || 0),
      eu: r.dir === "out", esperando: r.dir === "in", novas: r.unread || 0 })));
}
function waCrmSearch(q) {
  const s = q.replace(/[\\\n\r\0]/g, " ").replace(/[%_]/g, (c) => "\\" + c).slice(0, 80);
  return cached("crm:q:" + s.toLowerCase(), 60e3, () => crmQuery(
    `select coalesce(json_agg(distinct conversation_id), '[]') from whatsapp_message where body ilike '%' || ${pgLit(s)} || '%'`));
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CRM_TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?$/;
function waCrmMessages(id, antes) {
  if (!UUID.test(id) || (antes && !CRM_TS.test(antes))) return Promise.resolve(null);
  return cached(`crm:m:${id}:${antes || ""}`, 30e3, () => crmQuery(`select json_build_object('msgs', coalesce((select json_agg(z order by z.ts) from (
      select m.id, m.direction dir, m.type, m.body, m.origem, m.status, u.name autor, extract(epoch from m.timestamp) * 1000 ts,
        to_char(m.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS') cur
      from whatsapp_message m left join "user" u on u.id = m.author_id
      where m.conversation_id = '${id}' and m.type not in ('edit', 'revoke', 'reaction')${antes ? ` and m.timestamp < '${antes}'` : ""}
      order by m.timestamp desc limit 80) z), '[]'))`))
    .then((r) => ({ antes: r.msgs.length === 80 ? r.msgs[0].cur : null,
      messages: r.msgs.map((m) => ({ id: m.id, eu: m.dir === "out", autor: m.dir === "out" ? (m.autor || "RT (celular)") : "", text: m.body || "",
        tipo: m.type === "text" ? "text" : m.type, at: Math.round(m.ts), origem: m.origem, status: m.status })) }));
}

async function waChats(fonte, q) {
  const want = (f) => !fonte || fonte === "todas" || fonte === f || (fonte === "crm" && f !== "pessoal");
  const erros = {};
  const [pessoal, crm] = await Promise.all([
    want("pessoal") ? waPessoalChats(q).catch((e) => { erros.pessoal = e.message; return []; }) : [],
    want("comercial") || want("suporte") ? waCrmChats().catch((e) => { erros.empresa = e.message; return []; }) : [],
  ]);
  let empresa = crm.filter((c) => want(c.fonte));
  if (q) {
    const f = q.toLowerCase();
    const hits = q.length >= 3 && empresa.length ? new Set(await waCrmSearch(q).catch(() => [])) : new Set();
    empresa = empresa.filter((c) => hits.has(c.id) || [c.nome, c.sub, c.preview].some((x) => String(x || "").toLowerCase().includes(f)));
  }
  return { chats: [...pessoal, ...empresa].sort((a, b) => b.at - a.at), erros, at: Date.now() };
}

// --- HTTP ----------------------------------------------------------------------------
function authed(req) {
  const cookie = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith("mgr="));
  const given = Buffer.from(cookie ? decodeURIComponent(cookie.slice(4)) : "");
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

// Corpo binário (áudio, upload); limite padrão de 25 MB.
function readRaw(req, limit = 25e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { req.destroy(); reject(new Error("too large")); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const sse = (res) => res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });

// Acessos pelo nome/IP do tailnet em HTTP tentam ir para o HTTPS do tailscale serve (o microfone exige HTTPS).
// O navegador testa se alcança o HTTPS; se não alcançar em 2,5 s, segue no HTTP local (?local=1).
const HTTPS_URL = process.env.MANAGER_HTTPS_URL || "";
const REDIRECT_HOSTS = new Set((process.env.MANAGER_REDIRECT_HOSTS || "").split(",").filter(Boolean));
const probePage = (target, fallback) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Manager</title><p style="font:15px system-ui;color:#888;text-align:center;margin-top:30vh">abrindo…</p><script>
const go = (u) => location.replace(u);
const t = setTimeout(() => go(${JSON.stringify(fallback)}), 2500);
fetch(${JSON.stringify(HTTPS_URL + "/favicon.svg")}, { mode: "no-cors", cache: "no-store" })
  .then(() => { clearTimeout(t); go(${JSON.stringify(target)}); }, () => { clearTimeout(t); go(${JSON.stringify(fallback)}); });
</script>`;

// Senha do usuário do Linux: valida com `sudo -k -S -v` (sem cache de credencial). 5 erros por IP em 10 min bloqueiam.
const attempts = new Map();
const tooManyAttempts = (ip) => (attempts.get(ip) || []).filter((t) => Date.now() - t < 600e3).length >= 5;
const failedAttempt = (ip) => attempts.set(ip, [...(attempts.get(ip) || []).filter((t) => Date.now() - t < 600e3), Date.now()]);
function checkPassword(pw) {
  if (!pw || pw.length > 200 || /[\r\n]/.test(pw)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const p = spawn("sudo", ["-k", "-S", "-p", "", "-v"], { stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => p.kill(), 10e3);
    p.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
    p.on("error", () => resolve(false));
    p.stdin.end(pw + "\n");
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  const host = (req.headers.host || "").replace(/:\d+$/, "");
  const isPage = req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html");
  if (isPage && HTTPS_URL && REDIRECT_HOSTS.has(host) && !url.searchParams.has("local")) {
    const local = new URL(url); local.searchParams.set("local", "1");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(probePage(HTTPS_URL + req.url, local.pathname + local.search));
  }

  // Login pelo formulário: aceita o token ou a senha do usuário do Linux (conferida com sudo).
  if (url.pathname === "/login" && req.method === "POST") {
    const { secret } = await readBody(req).catch(() => ({}));
    const ip = req.socket.remoteAddress;
    if (tooManyAttempts(ip)) return json(res, 429, { error: "muitas tentativas; espere 10 minutos" });
    const s = String(secret || "");
    const ok = (s.length === TOKEN.length && timingSafeEqual(Buffer.from(s), Buffer.from(TOKEN))) || await checkPassword(s);
    if (!ok) { failedAttempt(ip); return json(res, 401, { error: "token ou senha inválidos" }); }
    res.writeHead(200, { "content-type": "application/json", "set-cookie": `mgr=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
    return res.end('{"ok":true}');
  }

  // Login: /?t=TOKEN grava o cookie e limpa a URL.
  if (url.searchParams.get("t")) {
    const ok = url.searchParams.get("t") === TOKEN;
    res.writeHead(302, {
      location: "/",
      ...(ok && { "set-cookie": `mgr=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` }),
    });
    return res.end();
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    if (!authed(req)) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(join(ROOT, "public/login.html")));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(readFileSync(join(ROOT, "public/index.html")));
  }

  // Opcional: app de tarefas externo (MANAGER_TAREFAS_URL, ex.: http://127.0.0.1:8792) repassado aqui, atrás do mesmo login.
  if (TAREFAS_URL && (url.pathname.startsWith("/eu/") || url.pathname === "/eu" || url.pathname.startsWith("/api/tarefas") || url.pathname.startsWith("/api/dia"))) {
    if (!authed(req)) { res.writeHead(401); return res.end(); }
    const body = req.method === "POST" ? await readRaw(req, 1e6) : undefined;
    try {
      const r = await fetch(TAREFAS_URL + (url.pathname === "/eu" ? "/eu/" : url.pathname) + url.search,
        { method: req.method, body, headers: { "content-type": req.headers["content-type"] || "application/json" } });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.writeHead(502); return res.end("tarefas indisponíveis: " + e.message); }
  }

  // UI nova (v2) e seus arquivos locais (bibliotecas e fontes, sem CDN); tudo atrás do mesmo login.
  if (req.method === "GET" && (url.pathname === "/v2" || url.pathname === "/v2/")) {
    if (!authed(req)) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(join(ROOT, "public/login.html"), "utf8").replace('location.replace("/" + location.search)', "location.replace(location.pathname + location.search)"));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(readFileSync(join(ROOT, "public/index.html")));
  }
  if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
    const name = basename(url.pathname);
    const p = join(ROOT, "public/vendor", name);
    if (!authed(req)) { res.writeHead(401); return res.end(); }
    if (!/^[\w.-]+$/.test(name) || !existsSync(p)) { res.writeHead(404); return res.end(); }
    const type = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[extname(name)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "private, max-age=604800" });
    return createReadStream(p).pipe(res);
  }

  if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg") {
    res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#1d2a33"/><circle cx="50" cy="50" r="15" fill="#f0b23a"/><circle cx="50" cy="50" r="30" fill="none" stroke="#f0b23a" stroke-width="6" stroke-dasharray="24 14"/></svg>`);
  }

  if (url.pathname === "/sw.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" });
    return res.end(readFileSync(join(ROOT, "public/sw.js")));
  }

  if (url.pathname === "/manifest.webmanifest") {
    res.writeHead(200, { "content-type": "application/manifest+json" });
    return res.end(readFileSync(join(ROOT, "public/manifest.webmanifest")));
  }

  if (!url.pathname.startsWith("/api/")) { res.writeHead(404); return res.end(); }
  if (!authed(req)) return json(res, 401, { error: "unauthorized" });

  try {
    if (req.method === "GET") {
      if (url.pathname === "/api/push/key") return json(res, 200, { key: vapid?.publicKey || null, n: pushSubs.length });
      if (url.pathname === "/api/events") {
        sse(res);
        res.write(`data: ${JSON.stringify(listEvent())}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "notes", notes: notes.slice(-150) })}\n\n`);
        if (usage) res.write(`data: ${JSON.stringify({ type: "usage", usage })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25000);
        req.on("close", () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (url.pathname === "/api/conv") {
        const c = convs.get(url.searchParams.get("id"));
        return c ? json(res, 200, snapshot(c)) : json(res, 404, { error: "not found" });
      }
      if (url.pathname === "/api/archived") {
        return json(res, 200, [...convs.values()].filter((c) => c.archived).sort((a, b) => b.updatedAt - a.updatedAt).map(meta));
      }
      if (url.pathname === "/api/wa/chats") {
        const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
        return json(res, 200, await waChats(url.searchParams.get("fonte") || "todas", q));
      }
      // QR de pareamento: o bridge grava store/qr.txt e o vigia (apps/whatsapp-mcp/qr-display.py) gera qr.png
      if (url.pathname === "/api/wa/qr") {
        const png = join(WA_STORE, "qr.png"), txt = join(WA_STORE, "qr.txt");
        const fresco = existsSync(txt) && existsSync(png) && Date.now() - statSync(txt).mtimeMs < 90e3;
        return json(res, 200, fresco ? { precisa: true, img: "data:image/png;base64," + readFileSync(png).toString("base64"), at: statSync(png).mtimeMs } : { precisa: false });
      }
      if (url.pathname === "/api/wa/messages") {
        const fonte = url.searchParams.get("fonte"), id = url.searchParams.get("id") || "", antes = url.searchParams.get("antes") || "";
        const r = fonte === "pessoal" ? await waPessoalMessages(id, antes.slice(0, 40)) : ["comercial", "suporte"].includes(fonte) ? await waCrmMessages(id, antes) : null;
        return r ? json(res, 200, r) : json(res, 404, { error: "conversa não encontrada" });
      }
      // CRM de pessoas e workloads (trabalho/universidade/pessoal), gerado por workspace/pessoas/build.py
      if (url.pathname === "/api/pessoas") {
        const f = join(WORKSPACE, "pessoas/crm.json");
        return existsSync(f) ? json(res, 200, JSON.parse(readFileSync(f, "utf8"))) : json(res, 200, { pessoas: [], grupos: [] });
      }
      if (url.pathname === "/api/pessoas.vcf") {
        const f = join(WORKSPACE, "pessoas/contatos.vcf");
        if (!existsSync(f)) return json(res, 404, { error: "vCard ainda não gerado" });
        res.writeHead(200, { "content-type": "text/vcard; charset=utf-8", "content-disposition": 'attachment; filename="contatos.vcf"', "cache-control": "no-store" });
        return res.end(readFileSync(f));
      }
      if (url.pathname === "/api/agenda") return json(res, 200, await painelAgenda(join(STATE, "agenda.ics-url"), Math.min(60, +url.searchParams.get("dias") || 14)));
      if (url.pathname === "/api/catalog") return json(res, 200, await loadCatalog(url.searchParams.has("refresh")));
      if (url.pathname === "/api/fs") {
        const p = expand(url.searchParams.get("path"));
        const s = await stat(p);
        if (!s.isDirectory()) return json(res, 200, { path: p, file: true, size: s.size, parent: dirname(p) });
        return json(res, 200, await listDir(p, url.searchParams.has("hidden")));
      }
      if (url.pathname === "/api/file") {
        const p = expand(url.searchParams.get("path"));
        const s = await stat(p);
        if (s.isDirectory()) return json(res, 400, { error: "é uma pasta" });
        const type = MIME[extname(p).toLowerCase()] || (url.searchParams.has("text") ? "text/plain; charset=utf-8" : "application/octet-stream");
        const headers = { "content-type": type, "content-length": s.size, "cache-control": "no-store" };
        if (url.searchParams.has("dl")) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(p))}`;
        if (type === "text/html" || type === "image/svg+xml") headers["content-security-policy"] = "sandbox"; // não executa script de arquivo local
        res.writeHead(200, headers);
        return createReadStream(p).pipe(res);
      }
      if (url.pathname === "/api/term/stream") {
        const t = terms.get(url.searchParams.get("id"));
        if (!t) return json(res, 404, { error: "not found" });
        sse(res);
        if (t.buf.length) res.write(`data: ${JSON.stringify({ d: Buffer.concat(t.buf).toString("base64") })}\n\n`);
        if (!t.alive) res.write(`data: ${JSON.stringify({ exit: t.code })}\n\n`);
        t.clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25000);
        req.on("close", () => { clearInterval(ping); t.clients.delete(res); });
        return;
      }
      return json(res, 404, { error: "not found" });
    }

    if (req.method !== "POST") return json(res, 405, { error: "method" });

    if (url.pathname === "/api/transcribe") {
      const audio = await readRaw(req).catch(() => null);
      if (!audio?.length) return json(res, 400, { error: "empty" });
      try {
        const r = await fetch(`${STT_URL}/transcribe`, { method: "POST", body: audio });
        return json(res, r.status, await r.json());
      } catch (err) {
        // Whisper da GPU parado (modo jogo): transcreve na CPU, em prioridade baixa, sem tocar na placa de vídeo.
        const tmp = join(STATE, `stt-${Date.now()}.audio`);
        try {
          writeFileSync(tmp, audio);
          const out = await new Promise((ok, no) => execFile("nice", ["-n", "19", join(ROOT, "stt/.venv/bin/python"), "-I", join(ROOT, "stt/cpu_transcribe.py"), tmp],
            { timeout: 180e3, maxBuffer: 1e6 }, (e, so) => (e ? no(e) : ok(so))));
          return json(res, 200, JSON.parse(out));
        } catch (e2) {
          return json(res, 503, { error: `transcrição indisponível: ${err.message}; CPU: ${e2.message}` });
        } finally { try { unlinkSync(tmp); } catch {} }
      }
    }
    if (url.pathname === "/api/upload") {
      const dir = expand(url.searchParams.get("dir") || join(WORKSPACE, "uploads"));
      const name = basename(url.searchParams.get("name") || `upload-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      let dest = join(dir, name);
      if (existsSync(dest)) dest = join(dir, `${Date.now().toString(36)}-${name}`);
      await writeFile(dest, await readRaw(req, 500e6));
      return json(res, 200, { ok: true, path: dest });
    }

    const body = await readBody(req).catch(() => ({}));
    const c = body.conv && convs.get(body.conv);

    switch (url.pathname) {
      case "/api/chat": {
        const text = body.text?.trim();
        if (!text) return json(res, 400, { error: "empty" });
        const conv = c || createConv(body);
        if (running.has(conv.id)) { // já trabalhando: entra na fila
          conv.queue.push(text);
          saveConv(conv); // a fila sobrevive a um reinício do serviço
          broadcast({ type: "queue", conv: conv.id, queue: conv.queue });
          broadcast(listEvent());
          return json(res, 202, { ok: true, conv: conv.id, queued: true });
        }
        runTurn(conv, text);
        return json(res, 202, { ok: true, conv: conv.id });
      }
      case "/api/push/subscribe": { // inscrição de web push deste aparelho (troca a anterior de mesmo endpoint)
        const sub = body.subscription;
        if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return json(res, 400, { error: "inscrição inválida" });
        pushSubs = [...pushSubs.filter((x) => x.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: sub.keys, ua: (req.headers["user-agent"] || "").slice(0, 80), at: Date.now() }];
        savePush();
        if (body.test) pushSend({ title: "Manager", body: "Notificações ligadas neste aparelho ✅", tag: "teste" });
        return json(res, 200, { ok: true, n: pushSubs.length });
      }
      case "/api/seen": // conversa vista (ou todas, sem conv): limpa não lidas em todos os aparelhos
        if (c || body.all) markSeen(c ? c.id : null);
        return json(res, 200, { ok: true });
      case "/api/stop":
        if (running.has(body.conv)) console.log(`[stop] conv=${body.conv} origem=${body.src || "?"} ua=${(req.headers["user-agent"] || "").slice(0, 60)}`);
        running.get(body.conv)?.abort.abort();
        return json(res, 200, { ok: true });
      case "/api/unqueue":
        if (c) { c.queue.splice(body.index, 1); broadcast({ type: "queue", conv: c.id, queue: c.queue }); }
        return json(res, 200, { ok: true });
      case "/api/new": return json(res, 200, { ok: true, conv: meta(createConv(body)) });
      case "/api/settings": { // pasta só muda antes da primeira mensagem (a sessão fica presa à pasta)
        if (!c) return json(res, 404, { error: "not found" });
        if ("model" in body) c.model = body.model || null;
        if ("effort" in body) c.effort = body.effort || null;
        if ("title" in body && body.title?.trim()) c.title = body.title.trim().slice(0, 80);
        if ("pinned" in body) c.pinned = !!body.pinned;
        if ("cwd" in body && !c.messages.length) c.cwd = expand(body.cwd);
        if ("archived" in body) { if (running.has(c.id)) return json(res, 409, { error: "busy" }); c.archived = !!body.archived; }
        if (c.messages.length) saveConv(c);
        broadcast({ type: "meta", conv: c.id, meta: meta(c) });
        broadcast(listEvent());
        return json(res, 200, { ok: true, conv: meta(c) });
      }
      case "/api/archive": // compatibilidade
        if (!c) return json(res, 404, { error: "not found" });
        if (running.has(c.id)) return json(res, 409, { error: "busy" });
        c.archived = true; saveConv(c); broadcast(listEvent());
        return json(res, 200, { ok: true });
      case "/api/fork": { // ramifica: nova conversa com o mesmo histórico, sessão própria
        if (!c?.sessionId) return json(res, 400, { error: "conversa sem sessão" });
        const f = createConv(c);
        Object.assign(f, { title: `${c.title} (ramo)`, sessionId: c.sessionId, forkFrom: c.id, model: c.model, effort: c.effort,
          messages: structuredClone(c.messages) });
        saveConv(f); broadcast(listEvent());
        return json(res, 200, { ok: true, conv: meta(f) });
      }
      case "/api/open":
        openOnPc(body);
        return json(res, 200, { ok: true });
      case "/api/term/new": return json(res, 200, termMeta(createTerm(body)));
      case "/api/term/input": {
        const t = terms.get(body.id);
        if (t?.alive) t.proc.stdin.write(body.data);
        return json(res, 200, { ok: !!t?.alive });
      }
      case "/api/term/resize": {
        const t = terms.get(body.id);
        if (t?.alive) t.proc.stdio[3].write(`${body.cols | 0} ${body.rows | 0}\n`);
        return json(res, 200, { ok: true });
      }
      case "/api/term/close": {
        const t = terms.get(body.id);
        if (t) { t.proc.kill(); terms.delete(t.id); broadcast(listEvent()); }
        return json(res, 200, { ok: true });
      }
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, err.code === "ENOENT" ? 404 : err.code === "EACCES" ? 403 : 500, { error: err.message });
  }
}).listen(PORT, HOST, () => console.log(`manager ouvindo em http://${HOST}:${PORT}`));
