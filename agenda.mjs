// Agenda: lê o endereço secreto iCal do Google (state/agenda.ics-url, só leitura) e devolve os eventos de uma janela,
// já com recorrências expandidas, link do Meet e uma marca de trabalho/pessoal. Cache de 2 min para não martelar o Google.
import { readFileSync, existsSync } from "node:fs";

const TZ_PADRAO = "America/Sao_Paulo";
const TTL = 120e3;
let cache = { at: 0, ics: "" };

// Palavras que indicam faculdade e trabalho; ajuste ao seu caso (MANAGER_AGENDA_TRABALHO sobrescreve). O resto conta como pessoal.
const UNIVERSIDADE = /(faculdade|universidade|prova|mat[eé]ria|disciplina|est[aá]gio|aula|professor|tcc|semestre)/i;
const TRABALHO = process.env.MANAGER_AGENDA_TRABALHO ? new RegExp(process.env.MANAGER_AGENDA_TRABALHO, "i")
  : /(cliente|proposta|reuni[aã]o|call|alinhamento|demo|treinamento|implanta[cç][aã]o|sprint|daily|weekly)/i;

async function lerIcs(urlFile) {
  if (Date.now() - cache.at < TTL && cache.ics) return cache.ics;
  if (!existsSync(urlFile)) throw new Error("agenda não configurada (falta state/agenda.ics-url)");
  const r = await fetch(readFileSync(urlFile, "utf8").trim(), { signal: AbortSignal.timeout(20e3) });
  if (!r.ok) throw new Error(`Google respondeu ${r.status}`);
  cache = { at: Date.now(), ics: await r.text() };
  return cache.ics;
}

// --- parser iCal mínimo -----------------------------------------------------------------------
function unfold(ics) { return ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, ""); }
const unesc = (s) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

function eventos(ics) {
  const out = []; let cur = null;
  for (const linha of unfold(ics).split("\n")) {
    if (linha === "BEGIN:VEVENT") { cur = { props: {} }; continue; }
    if (linha === "END:VEVENT") { if (cur) out.push(cur.props); cur = null; continue; }
    if (!cur) continue;
    const i = linha.indexOf(":"); if (i < 0) continue;
    const [nome, ...params] = linha.slice(0, i).split(";");
    const p = Object.fromEntries(params.map((x) => x.split("=")));
    const v = linha.slice(i + 1);
    if (nome === "EXDATE" || nome === "ATTENDEE") (cur.props[nome] ||= []).push({ v, p });
    else cur.props[nome] = { v, p };
  }
  return out;
}

// Hora "de parede" num fuso → instante UTC (ms). Usa Intl para achar o deslocamento do fuso naquela data.
function offsetMs(tz, utc) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const o = Object.fromEntries(f.formatToParts(new Date(utc)).map((x) => [x.type, x.value]));
  return Date.UTC(+o.year, o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - utc;
}
function wallToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  try { return guess - offsetMs(tz, guess - offsetMs(tz, guess)); } catch { return guess - offsetMs(TZ_PADRAO, guess); }
}
function quando(prop) {
  if (!prop) return null;
  const m = prop.v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/); if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { ms: wallToUtc(+y, mo - 1, +d, 0, 0, 0, TZ_PADRAO), allDay: true, wall: [+y, mo - 1, +d, 0, 0, 0], tz: TZ_PADRAO };
  const tz = prop.p.TZID || TZ_PADRAO;
  if (z) return { ms: Date.UTC(+y, mo - 1, +d, +h, +mi, +s), allDay: false, utc: true };
  return { ms: wallToUtc(+y, mo - 1, +d, +h, +mi, +s, tz), allDay: false, wall: [+y, mo - 1, +d, +h, +mi, +s], tz };
}

// Expande RRULE (DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY semanal) dentro de [ini, fim].
const DIAS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function ocorrencias(start, rrule, ini, fim) {
  if (!rrule) return [start.ms];
  const r = Object.fromEntries(rrule.split(";").map((x) => x.split("=")));
  const intervalo = +(r.INTERVAL || 1), max = r.COUNT ? +r.COUNT : Infinity;
  const ate = r.UNTIL ? quando({ v: r.UNTIL, p: {} }).ms : Infinity;
  // trabalha em hora de parede para atravessar mudanças de fuso sem deslocar o horário
  const w = start.wall || (() => { const d = new Date(start.ms - 3 * 3600e3); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), 0]; })();
  const tz = start.tz || TZ_PADRAO;
  const mk = (y, mo, d) => wallToUtc(y, mo, d, w[3], w[4], w[5], tz);
  const out = []; let n = 0;
  const base = new Date(Date.UTC(w[0], w[1], w[2]));
  const byday = r.FREQ === "WEEKLY" && r.BYDAY ? r.BYDAY.split(",").map((x) => DIAS[x.slice(-2)]).sort() : null;
  for (let k = 0; k < 3000; k++) {
    let datas = [];
    if (r.FREQ === "DAILY") { const d = new Date(base); d.setUTCDate(d.getUTCDate() + k * intervalo); datas = [d]; }
    else if (r.FREQ === "WEEKLY") {
      const sem = new Date(base); sem.setUTCDate(sem.getUTCDate() - sem.getUTCDay() + k * 7 * intervalo);
      datas = (byday || [base.getUTCDay()]).map((dw) => { const d = new Date(sem); d.setUTCDate(d.getUTCDate() + dw); return d; }).filter((d) => d >= base);
    } else if (r.FREQ === "MONTHLY") { const d = new Date(Date.UTC(w[0], w[1] + k * intervalo, w[2])); if (d.getUTCDate() === w[2]) datas = [d]; }
    else if (r.FREQ === "YEARLY") { const d = new Date(Date.UTC(w[0] + k * intervalo, w[1], w[2])); if (d.getUTCMonth() === w[1]) datas = [d]; }
    else return [start.ms];
    for (const d of datas) {
      const ms = mk(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      if (ms > ate || n >= max || ms > fim) return out;
      n++; if (ms >= ini) out.push(ms);
    }
  }
  return out;
}

function meetDe(e) {
  const txt = [e["X-GOOGLE-CONFERENCE"]?.v, e.LOCATION?.v, e.DESCRIPTION?.v, e.URL?.v].filter(Boolean).join(" ");
  return (txt.match(/https:\/\/meet\.google\.com\/[a-z0-9-]+/i) || txt.match(/https:\/\/[\w.-]*(zoom\.us|teams\.microsoft\.com)\/[^\s"<>\\]+/i) || [])[0] || "";
}

// Lista os eventos entre agora-1 dia e agora+dias (padrão 14), em ordem.
export async function agenda(urlFile, { dias = 14, desde = Date.now() - 86400e3, fim: fimMs } = {}) {
  const ics = await lerIcs(urlFile);
  const fim = fimMs ?? Date.now() + dias * 86400e3;
  const lista = eventos(ics);
  // RECURRENCE-ID: ocorrências editadas substituem a da série
  const editadas = new Map();
  for (const e of lista) if (e["RECURRENCE-ID"]) editadas.set(e.UID?.v + "|" + quando(e["RECURRENCE-ID"])?.ms, e);
  const out = [];
  for (const e of lista) {
    const ini = quando(e.DTSTART); if (!ini) continue;
    const dur = (quando(e.DTEND)?.ms ?? ini.ms + (ini.allDay ? 86400e3 : 3600e3)) - ini.ms;
    const exc = new Set((e.EXDATE || []).flatMap((x) => x.v.split(",").map((v) => quando({ v, p: x.p })?.ms)));
    const series = e["RECURRENCE-ID"] ? [ini.ms] : ocorrencias(ini, e.RRULE?.v, desde, fim);
    for (const ms of series) {
      if (ms < desde || ms > fim || exc.has(ms)) continue;
      if (!e["RECURRENCE-ID"] && e.RRULE && editadas.has(e.UID?.v + "|" + ms)) continue;
      if (e.STATUS?.v === "CANCELLED") continue;
      const titulo = unesc(e.SUMMARY?.v || "(sem título)"), local = unesc(e.LOCATION?.v || "");
      const desc = unesc(e.DESCRIPTION?.v || "");
      const convidados = (e.ATTENDEE || []).map((a) => unesc(a.p.CN || a.v.replace(/^mailto:/i, ""))).slice(0, 12);
      const externos = (e.ATTENDEE || []).some((a) => !/@gmail\.com$/i.test(a.v) && /@/.test(a.v));
      out.push({
        id: (e.UID?.v || titulo) + "|" + ms, titulo, local, inicio: ms, fim: ms + dur, diaInteiro: ini.allDay,
        meet: meetDe(e), convidados, recorrente: !!e.RRULE,
        tipo: UNIVERSIDADE.test(`${titulo} ${local}`) ? "universidade" : TRABALHO.test(`${titulo} ${local} ${desc.slice(0, 400)}`) || externos ? "trabalho" : "pessoal",
      });
    }
  }
  return out.sort((a, b) => a.inicio - b.inicio);
}

// Para a UI: próximos eventos (a partir do começo de hoje) e, para contexto, os últimos já passados.
export async function painelAgenda(urlFile, dias = 14) {
  const hoje = new Date(new Date().toLocaleString("en-US", { timeZone: TZ_PADRAO })); hoje.setHours(0, 0, 0, 0);
  const iniHoje = Date.now() - (new Date(new Date().toLocaleString("en-US", { timeZone: TZ_PADRAO })) - hoje);
  const proximos = await agenda(urlFile, { desde: iniHoje, dias });
  const recentes = (await agenda(urlFile, { desde: Date.now() - 180 * 86400e3, fim: iniHoje - 1 })).slice(-5).reverse();
  return { proximos, recentes, atualizado: cache.at };
}
