# Manager

UI web para conversar com o **Claude Code** (usando a sua assinatura claude.ai) de qualquer dispositivo — celular,
tablet ou outro PC. O Claude roda na sua máquina: fechar a aba não interrompe o trabalho, e você retoma de onde parou.

> Feito para uso pessoal em uma máquina Linux. Ele dá acesso total ao PC (arquivos, terminal, SSH) a quem fizer login:
> **nunca exponha na internet aberta** — use rede local ou uma VPN como o [Tailscale](https://tailscale.com).

## O que tem

- **Várias conversas em paralelo**, cada uma com sua sessão, pasta de trabalho, modelo e esforço; fila de mensagens e
  retomada automática se o serviço reiniciar.
- **Subagentes visíveis**: dá para abrir e ler o que cada agente está fazendo.
- **Explorador de arquivos**, upload/download e "abrir no PC".
- **Terminais** no navegador (shell local ou SSH para os hosts do `~/.ssh/config`), via xterm.js.
- **Catálogo de integrações**: MCPs conectados, skills, chaves SSH e serviços do systemd.
- **Uso da assinatura** (janela de 5 h e semanal) com a taxa de consumo.
- **Notificações** no navegador e web push (funciona com o app instalado como PWA, inclusive no iPhone).
- **Voz**: ditado transcrito localmente com Whisper (opcional, precisa de GPU NVIDIA).
- **Agenda**: lê o endereço iCal secreto do Google Agenda e mostra os eventos do dia (opcional).
- **WhatsApp unificado** (somente leitura): lê o SQLite do [whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) (opcional).

## Requisitos

- Linux com `systemd` (testado no Ubuntu)
- Node.js 20+
- [Claude Code](https://docs.claude.com/en/docs/claude-code) instalado e logado (`claude` em `~/.local/bin/claude`)
- Python 3 (para os terminais; e para o STT, se quiser voz)

## Instalação

```bash
git clone https://github.com/batmar125/manager.git ~/manager
cd ~/manager
npm install
cp CLAUDE.example.md CLAUDE.md   # instruções do assistente; adapte ao seu caso
node server.mjs
```

Na primeira execução é criado `state/token` com um token aleatório. Abra `http://<sua-máquina>:7777/?t=<token>`
(o cookie fica salvo) ou entre na tela de login com o token ou com a senha do seu usuário Linux.

```bash
cat ~/manager/state/token
```

### Rodando como serviço

```bash
mkdir -p ~/.config/systemd/user
cp deploy/manager.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now manager
loginctl enable-linger "$USER"   # continua rodando sem sessão aberta
```

### HTTPS (necessário para microfone e web push no celular)

Com Tailscale:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:7777
```

e defina `MANAGER_HTTPS_URL=https://<máquina>.<tailnet>.ts.net:8443` e `MANAGER_REDIRECT_HOSTS=<máquina>,<ip-tailscale>`
no serviço, para que acessos por HTTP sejam redirecionados ao HTTPS.

### Web push (opcional)

```bash
npx web-push generate-vapid-keys --json > state/vapid.json
```

### Voz / transcrição (opcional, GPU NVIDIA)

```bash
cd stt
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp ../deploy/manager-stt.service ~/.config/systemd/user/
systemctl --user enable --now manager-stt
```

Ouve só em `127.0.0.1:7778`; o modelo padrão é `large-v3-turbo` (`STT_MODEL` muda). Sem GPU, `stt/cpu_transcribe.py`
transcreve arquivos pela CPU.

### Agenda (opcional)

Cole o "endereço secreto no formato iCal" do Google Agenda em `state/agenda.ics-url`.

## Configuração

Tudo por variável de ambiente; nenhuma é obrigatória.

| Variável | Padrão | Para quê |
|---|---|---|
| `MANAGER_PORT` | `7777` | porta HTTP |
| `MANAGER_HOST` | `0.0.0.0` | interface de escuta |
| `CLAUDE_BIN` | `~/.local/bin/claude` | binário do Claude Code |
| `STT_URL` | `http://127.0.0.1:7778` | servidor de transcrição |
| `MANAGER_HTTPS_URL` | — | URL HTTPS para onde redirecionar |
| `MANAGER_REDIRECT_HOSTS` | — | hosts (separados por vírgula) que são redirecionados ao HTTPS |
| `MANAGER_PUSH_CONTACT` | `mailto:admin@localhost` | contato VAPID do web push |
| `MANAGER_WA_STORE` | `~/apps/whatsapp-mcp/whatsapp-bridge/store` | pasta do SQLite do whatsapp-bridge |
| `MANAGER_CRM_SSH` / `MANAGER_CRM_CMD` | — | host SSH e comando `psql` de um CRM com conversas de WhatsApp (avançado) |
| `MANAGER_TAREFAS_URL` | — | app de tarefas externo, servido em `/eu/` atrás do mesmo login |
| `MANAGER_AGENDA_TRABALHO` | — | regex de palavras que marcam um evento como trabalho |

## Estrutura

```
server.mjs         servidor HTTP (Agent SDK do Claude, SSE, terminais, arquivos, push)
agenda.mjs         leitor de iCal com recorrências
public/            UI (HTML/JS puro, sem build) + vendor (xterm.js, marked, DOMPurify)
term/ptybridge.py  ponte de pseudo-terminal
stt/               servidor de transcrição (faster-whisper)
deploy/            units do systemd
state/             (gerado) token, conversas, notificações — não versionado
workspace/         (gerado) arquivos de trabalho do assistente — não versionado
```

## Segurança

- Quem faz login tem o mesmo poder que o seu usuário Linux. Use só em rede confiável/VPN.
- O token fica em `state/token` (modo 600); 5 senhas erradas por IP em 10 min bloqueiam o login.
- O servidor remove `ANTHROPIC_API_KEY` do ambiente para que o uso vá sempre para a assinatura.
- `state/` e `workspace/` estão no `.gitignore`: nunca versione esses diretórios.

## Licença

MIT
