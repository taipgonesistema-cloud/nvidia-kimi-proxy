<p align="center">
  <img src="https://raw.githubusercontent.com/MoonshotAI/Kimi-K2/main/figures/kimi-logo.png" alt="Kimi K2.6" width="120"/>
</p>

# NVIDIA Playground Proxy

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/Playwright-1.57+-45ba4b?logo=playwright&logoColor=white" alt="Playwright"/>
  <img src="https://img.shields.io/badge/Chromium-powered-blue?logo=googlechrome&logoColor=white" alt="Chromium"/>
  <img src="https://img.shields.io/badge/OpenAI-Compatible-black?logo=openai&logoColor=white" alt="OpenAI Compatible"/>
  <img src="https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white" alt="Docker Ready"/>
</p>

Proxy OpenAI-compatible para modelos do NVIDIA Build Playground. Ele usa Playwright + Chromium com perfil persistente, abre o playground real da NVIDIA, dispara uma requisição legítima no navegador e intercepta o request `/v2/predict/models/*` para substituir o payload pelo formato recebido em `/v1/chat/completions`.

Suporta chat, streaming, tool calling, API key local e `reasoning_content` quando o modelo da NVIDIA retorna thinking/reasoning.

## Modelos

Disponíveis em `GET /v1/models`:

| Modelo | Reasoning | Observações |
|---|---:|---|
| `moonshotai/kimi-k2.6` | Não validado | Modelo padrão |
| `deepseek-ai/deepseek-v4-pro` | Sim | Envia `reasoning_effort=max` por padrão e retorna `reasoning_content` |
| `deepseek-ai/deepseek-v4-flash` | Sim | Envia `reasoning_effort=max` por padrão e retorna `reasoning_content` |
| `stepfun-ai/step-3.7-flash` | Sim | Retorna `reasoning_content` quando a NVIDIA envia |

## Requisitos

- Node.js 18+ para execução local
- Chrome, Edge ou Chromium instalado para execução local
- Docker opcional para container/EasyPanel
- Acesso de rede ao `build.nvidia.com` e `api.ngc.nvidia.com`

## Configuração

Copie `.env.example` para `.env` e ajuste:

```env
PORT=4874
HOST_PORT=4874
API_KEY=dummy
HEADLESS=true
NVIDIA_THINKING=false
NVIDIA_MAX_TOKENS=131072
NVIDIA_TEMPERATURE=0.2
NVIDIA_TOP_P=0.8
NVIDIA_DEEPSEEK_REASONING_EFFORT=max
NVIDIA_REQUEST_TIMEOUT_MS=120000
PLAYWRIGHT_USER_DATA_DIR=
PLAYWRIGHT_CHROME=
PLAYWRIGHT_CHROMIUM_ARGS=
PLAYWRIGHT_BROWSER_IDLE_TIMEOUT_MS=60000
```

Variáveis principais:

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `4874` | Porta HTTP dentro do processo/container |
| `HOST_PORT` | `4874` | Porta publicada no host pelo Docker Compose |
| `API_KEY` | vazio | Se definido, exige `Authorization: Bearer <API_KEY>` ou `X-API-Key` em `/v1/*` e `/debug/*` |
| `HEADLESS` | `false` local, `true` Docker | Roda Chromium oculto |
| `NVIDIA_THINKING` | `false` | Enviado em `chat_template_kwargs.thinking` para modelos que usam esse campo. Não é injetado nos DeepSeek V4 |
| `NVIDIA_MAX_TOKENS` | `131072` | `max_tokens` padrão quando o cliente não envia |
| `NVIDIA_TEMPERATURE` | `0.2` | `temperature` padrão quando o cliente não envia |
| `NVIDIA_TOP_P` | `0.8` | `top_p` padrão quando o cliente não envia |
| `NVIDIA_DEEPSEEK_REASONING_EFFORT` | `max` | `reasoning_effort` padrão dos modelos DeepSeek V4 |
| `NVIDIA_REQUEST_TIMEOUT_MS` | `120000` | Timeout máximo por requisição |
| `PLAYWRIGHT_USER_DATA_DIR` | `./playwright-profile` | Diretório persistente do Chromium |
| `PLAYWRIGHT_CHROME` | auto-detecção | Caminho do Chrome/Edge/Chromium |
| `PLAYWRIGHT_CHROMIUM_ARGS` | vazio local | Flags extras do Chromium. No Docker use `--no-sandbox --disable-dev-shm-usage` |
| `PLAYWRIGHT_BROWSER_IDLE_TIMEOUT_MS` | `60000` no Docker, `300000` local | Fecha o Chromium após esse tempo ocioso para reduzir CPU/RAM. Use `0` para manter sempre aberto |

## Execução Local

Instale dependências:

```bash
npm install
```

Modo visível para debug:

```env
HEADLESS=false
PORT=4874
```

```bash
node playwright-proxy.mjs
```

Modo headless local:

```env
HEADLESS=true
PORT=4874
```

```bash
node playwright-proxy.mjs
```

Também existem atalhos Windows:

```bat
run-playwright-proxy.bat
run-playwright-proxy-headless.bat
```

## Docker

O container instala Chromium via `apt`, roda com `HEADLESS=true` e salva o perfil persistente em `/app/profile`.

Build:

```bash
docker build -t nvidia-kimi-proxy .
```

Run:

```bash
docker run -d \
  --name nvidia-kimi-proxy \
  -p 4874:4874 \
  -e API_KEY="dummy" \
  -v nvidia-kimi-profile:/app/profile \
  --restart unless-stopped \
  nvidia-kimi-proxy
```

Com `.env`:

```bash
docker run -d \
  --name nvidia-kimi-proxy \
  -p 4874:4874 \
  --env-file .env \
  -e PORT=4874 \
  -e HEADLESS=true \
  -e PLAYWRIGHT_CHROME=/usr/bin/chromium \
  -e PLAYWRIGHT_USER_DATA_DIR=/app/profile \
  -e PLAYWRIGHT_CHROMIUM_ARGS="--no-sandbox --disable-dev-shm-usage" \
  -v nvidia-kimi-profile:/app/profile \
  --restart unless-stopped \
  nvidia-kimi-proxy
```

Docker Compose:

```bash
docker compose up -d
```

Outra porta no host:

```bash
HOST_PORT=4875 docker compose up -d
```

No Windows `cmd`:

```bat
set HOST_PORT=4875
docker compose up -d
```

## EasyPanel

Deploy validado via Dockerfile a partir do GitHub.

Variáveis recomendadas:

```env
PORT=4874
HOST_PORT=4874
API_KEY=dummy
HEADLESS=true
NVIDIA_THINKING=false
NVIDIA_MAX_TOKENS=131072
NVIDIA_TEMPERATURE=0.2
NVIDIA_TOP_P=0.8
NVIDIA_DEEPSEEK_REASONING_EFFORT=max
NVIDIA_REQUEST_TIMEOUT_MS=120000
PLAYWRIGHT_USER_DATA_DIR=/app/profile
PLAYWRIGHT_CHROME=/usr/bin/chromium
PLAYWRIGHT_CHROMIUM_ARGS=--no-sandbox --disable-dev-shm-usage --single-process
PLAYWRIGHT_BROWSER_IDLE_TIMEOUT_MS=60000
```

Configure volume persistente em:

```txt
/app/profile
```

Endpoint de exemplo em produção:

```txt
https://evo-kimi.ebmtg1.easypanel.host/v1/chat/completions
```

O deploy em EasyPanel foi validado com:

- `GET /`
- `GET /debug/status`
- `GET /v1/models`
- `POST /v1/chat/completions`
- Os modelos listados acima

## API

Base local:

```txt
http://localhost:4874/v1
```

Health check sem autenticação:

```bash
curl http://localhost:4874/
```

Listar modelos:

```bash
curl http://localhost:4874/v1/models \
  -H "Authorization: Bearer dummy"
```

Chat non-stream:

```bash
curl http://localhost:4874/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dummy" \
  -d '{
    "model": "moonshotai/kimi-k2.6",
    "messages": [{"role": "user", "content": "Responda apenas: ok"}],
    "max_tokens": 128
  }'
```

Chat streaming:

```bash
curl -N http://localhost:4874/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dummy" \
  -d '{
    "model": "deepseek-ai/deepseek-v4-pro",
    "stream": true,
    "messages": [{"role": "user", "content": "Responda apenas: ok"}],
    "max_tokens": 512
  }'
```

Tool calling:

```bash
curl http://localhost:4874/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dummy" \
  -d '{
    "model": "deepseek-ai/deepseek-v4-pro",
    "messages": [{"role": "user", "content": "Use a ferramenta get_weather para consultar o clima de Paris."}],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Consulta o clima de uma cidade",
          "parameters": {
            "type": "object",
            "properties": {
              "city": { "type": "string" }
            },
            "required": ["city"]
          }
        }
      }
    ],
    "tool_choice": {"type": "function", "function": {"name": "get_weather"}},
    "max_tokens": 512
  }'
```

## Reasoning

Quando a NVIDIA retorna thinking/reasoning, o proxy preserva o campo OpenAI-style:

Resposta non-stream:

```json
{
  "message": {
    "role": "assistant",
    "content": "ok",
    "reasoning_content": "..."
  }
}
```

Resposta stream:

```txt
data: {"choices":[{"delta":{"reasoning_content":"..."}}]}
data: {"choices":[{"delta":{"content":"ok"}}]}
```

No DeepSeek V4 Pro e V4 Flash, o payload enviado inclui por padrão:

```json
{
  "reasoning_effort": "max"
}
```

Você pode sobrescrever por request:

```json
{
  "model": "deepseek-ai/deepseek-v4-pro",
  "reasoning_effort": "max",
  "messages": []
}
```

## Debug

Endpoints protegidos por `API_KEY` quando configurada:

```bash
curl http://localhost:4874/debug/status \
  -H "Authorization: Bearer dummy"
```

```bash
curl http://localhost:4874/debug/page \
  -H "Authorization: Bearer dummy"
```

`/debug/status` mostra `browserReady`, URL atual, perfil usado, modo headless e último rewrite.

`/debug/page` mostra estado do playground: textarea, botão Send, modais visíveis e snapshot textual.

## Comportamento Validado

Validado localmente e em EasyPanel/Docker:

- Headless com profile limpo
- Aceite automático de cookies e modal “Acknowledge & Continue”
- Navegação entre os 3 playgrounds
- Chat non-stream nos 3 modelos
- Chat streaming nos 3 modelos
- Tool calling non-stream nos 3 modelos
- Tool calling stream nos 3 modelos
- `reasoning_content` nos modelos DeepSeek V4 e StepFun quando retornado pela NVIDIA
- API key via `Authorization: Bearer ...`

## Como Funciona

1. O servidor recebe chamadas OpenAI-compatible em `/v1/chat/completions`.
2. O Playwright mantém um Chromium persistente com perfil salvo.
3. Para cada modelo, o proxy abre o playground NVIDIA correspondente.
4. O proxy preenche o textarea e clica em Send para gerar uma requisição real do browser.
5. A rota `https://api.ngc.nvidia.com/v2/predict/models/**` é interceptada.
6. O body original é substituído pelo payload OpenAI-compatible convertido.
7. A resposta SSE da NVIDIA é convertida para resposta OpenAI-compatible.
8. Tool calls, streaming, usage e `reasoning_content` são preservados quando presentes.

## Integração pi.dev

Exemplo de provider em `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "nvidia-playground": {
      "baseUrl": "http://localhost:4874/v1",
      "api": "openai-completions",
      "apiKey": "dummy",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": true,
        "supportsUsageInStreaming": true
      },
      "models": [
        {
          "id": "moonshotai/kimi-k2.6",
          "name": "NVIDIA Kimi K2.6",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 131072,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "deepseek-ai/deepseek-v4-pro",
          "name": "NVIDIA DeepSeek V4 Pro",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 1000000,
          "maxTokens": 131072,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "deepseek-ai/deepseek-v4-flash",
          "name": "NVIDIA DeepSeek V4 Flash",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 1000000,
          "maxTokens": 131072,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "stepfun-ai/step-3.7-flash",
          "name": "NVIDIA StepFun Step 3.7 Flash",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 131072,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

## Estrutura

```txt
nvidia-kimi-proxy/
├── playwright-proxy.mjs              # Proxy principal Node.js + Playwright
├── package.json                      # Dependências npm
├── package-lock.json
├── Dockerfile                        # Imagem Node + Chromium
├── docker-compose.yml                # Compose com volume persistente
├── .dockerignore
├── .env.example                      # Exemplo de variáveis
├── .gitignore
├── README.md
├── cmd/                              # Caminho Go legado/auxiliar
├── internal/                         # Utilitários Go legados/auxiliares
├── run-playwright-proxy.bat          # Atalho Windows visível
└── run-playwright-proxy-headless.bat # Atalho Windows headless
```

## Notas

- Não commite `.env` nem perfis Chromium. Eles ficam ignorados por `.gitignore`.
- O healthcheck usa `GET /`, que não exige `API_KEY`.
- Em Windows, `curl` pode falhar em HTTPS público com `CRYPT_E_NO_REVOCATION_CHECK`; para teste local do deploy foi usado `curl -k`.
- O Dockerfile foi feito para Linux container com `/usr/bin/chromium`.

## CPU/RAM

Para VPS pequena, o proxy aplica algumas economias por padrão:

- Bloqueia imagens, fontes, mídia e trackers conhecidos no Chromium.
- Usa viewport menor (`1024x768`).
- Desativa recursos de background do Chromium via flags.
- Fecha o browser após `PLAYWRIGHT_BROWSER_IDLE_TIMEOUT_MS` sem requisições.

### Idle do Chromium

O idle funciona como um ciclo automático:

1. Uma requisição chega em `/v1/chat/completions`.
2. O proxy chama `ensureBrowser()`.
3. Se o Chromium estiver fechado, ele abre de novo e carrega o playground do modelo pedido.
4. A requisição é processada normalmente.
5. Quando termina, o proxy agenda o timer de idle.
6. Se não chegar nenhuma nova requisição até `PLAYWRIGHT_BROWSER_IDLE_TIMEOUT_MS`, o Chromium é fechado.
7. A próxima requisição reabre o Chromium automaticamente.

Isso reduz CPU/RAM quando o serviço fica parado. O custo é que a primeira requisição depois do idle demora mais, porque precisa iniciar o navegador e carregar o playground outra vez.

Configuração recomendada no Docker/EasyPanel:

```env
HEADLESS=true
PLAYWRIGHT_CHROMIUM_ARGS=--no-sandbox --disable-dev-shm-usage --single-process
PLAYWRIGHT_BROWSER_IDLE_TIMEOUT_MS=60000
```

Se quiser zerar CPU quando não estiver usando, reduza o idle timeout:

```env
PLAYWRIGHT_BROWSER_IDLE_TIMEOUT_MS=60000
```

Para manter o Chromium sempre aberto, desative o idle:

```env
PLAYWRIGHT_BROWSER_IDLE_TIMEOUT_MS=0
```

Trade-off: quando o Chromium fecha por idle, a próxima requisição demora mais porque precisa abrir o navegador e carregar o playground novamente.
