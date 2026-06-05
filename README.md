<p align="center">
  <img src="https://raw.githubusercontent.com/MoonshotAI/Kimi-K2/main/figures/kimi-logo.png" alt="Kimi K2.6" width="120"/>
</p>

# NVIDIA Kimi K2.6 Proxy

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/Playwright-1.57+-45ba4b?logo=playwright&logoColor=white" alt="Playwright"/>
  <img src="https://img.shields.io/badge/Chromium-powered-blue?logo=googlechrome&logoColor=white" alt="Chromium"/>
  <img src="https://img.shields.io/badge/OpenAI-Compatible-black?logo=openai&logoColor=white" alt="OpenAI Compatible"/>
</p>

Proxy compatível com OpenAI que redireciona requisições para o modelo `moonshotai/kimi-k2.6` no playground da NVIDIA, usando Playwright + Chromium para autenticação via sessão do navegador.

Suporta **tool calling**, **streaming** e integração direta com o [pi.dev](https://pi.dev).

## Pré-requisitos

- **Node.js** 18+ (com `npm`)
- **Google Chrome** ou **Microsoft Edge** instalado
- **Docker** opcional, para rodar em container
- Conexão com internet

## Instalação

```bash
# 1. Clone o repositório
git clone https://github.com/taipgonesistema-cloud/nvidia-kimi-proxy
cd nvidia-kimi-proxy

# 2. Instale as dependências
npm install

# 3. Copie e configure o .env
cp .env.example .env
# Edite o .env conforme necessário (PORT, HEADLESS, etc.)

# 4. Inicie o proxy em modo visível (primeira execução)
node playwright-proxy.mjs
```

O navegador abrirá sozinho na página do playground da NVIDIA.

### Primeira execução — aceitar os termos

Na primeira vez, execute no **modo visível** (`HEADLESS=false`). O proxy automaticamente aceita os termos e salva no perfil do navegador.

Após isso, pode usar `HEADLESS=true` nas próximas execuções.

## Configuração

O proxy carrega automaticamente as variáveis do arquivo `.env` (via dotenv).
Copie o `.env.example` para `.env` e ajuste:

```env
PORT=4874              # Porta do proxy
API_KEY=               # Opcional: exige Authorization: Bearer <API_KEY>
HEADLESS=false         # true para Chromium oculto
NVIDIA_THINKING=false  # Habilita raciocínio do modelo
NVIDIA_MAX_TOKENS=131072
NVIDIA_TEMPERATURE=0.2 # Mais baixo = respostas mais determinísticas
NVIDIA_TOP_P=0.8       # Limita amostragem para reduzir deriva/alucinação
NVIDIA_DEEPSEEK_REASONING_EFFORT=max
```

## Uso

### Modo visível (testes)

```bash
node playwright-proxy.mjs
```

### Modo headless (produção)

Após já ter aceito os termos uma vez no modo visível, edite o `.env`:

```env
HEADLESS=true
PORT=4874
```

E inicie:

```bash
node playwright-proxy.mjs
```

## Endpoint

```
http://localhost:4874/v1/chat/completions
```

(ou a porta definida no `.env`)

Modelos disponíveis em `/v1/models`:

- `moonshotai/kimi-k2.6`
- `deepseek-ai/deepseek-v4-pro`
- `stepfun-ai/step-3.7-flash`

### Exemplo com curl

```bash
curl http://localhost:4874/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "moonshotai/kimi-k2.6",
    "messages": [{"role": "user", "content": "Olá, tudo bem?"}],
    "max_tokens": 100
  }'
```

### Exemplo com tool calling

```bash
curl http://localhost:4874/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "moonshotai/kimi-k2.6",
    "messages": [{"role": "user", "content": "Qual a temperatura em Paris?"}],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Obtém a temperatura de uma cidade",
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
    "tool_choice": "auto",
    "max_tokens": 200
  }'
```

## Variáveis de Ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `4874` | Porta do servidor proxy |
| `HOST_PORT` | `4874` | Porta publicada no host pelo `docker-compose.yml` |
| `API_KEY` | vazio | Se definido, exige `Authorization: Bearer <API_KEY>` ou `X-API-Key` nos endpoints `/v1/*` e `/debug/*` |
| `HEADLESS` | `false` | `true` para rodar o Chromium em modo oculto |
| `NVIDIA_THINKING` | `false` | Habilita raciocínio (thinking) do modelo |
| `NVIDIA_MAX_TOKENS` | `131072` | `max_tokens` padrão quando o cliente não envia |
| `NVIDIA_TEMPERATURE` | `0.2` | `temperature` padrão quando o cliente não envia |
| `NVIDIA_TOP_P` | `0.8` | `top_p` padrão quando o cliente não envia |
| `NVIDIA_DEEPSEEK_REASONING_EFFORT` | `max` | `reasoning_effort` padrão para `deepseek-ai/deepseek-v4-pro` |
| `NVIDIA_REQUEST_TIMEOUT_MS` | `120000` | Timeout máximo por requisição (ms) |
| `PLAYWRIGHT_USER_DATA_DIR` | `./playwright-profile` | Pasta do perfil do Chromium |
| `PLAYWRIGHT_CHROME` | (auto-detecção) | Caminho do executável do Chrome/Edge |

## Integração com pi.dev

Adicione o provider no `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "nvidia-kimi": {
      "baseUrl": "http://localhost:4874/v1",
      "api": "openai-completions",
      "apiKey": "dummy",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false
      },
      "models": [
        {
          "id": "nvidia-kimi-k2.6",
          "name": "NVIDIA Kimi K2.6",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 131072,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

E defina como padrão no `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "nvidia-kimi",
  "defaultModel": "nvidia-kimi-k2.6"
}
```

## Como funciona

1. O Playwright abre uma janela do Chromium com um perfil persistente
2. O proxy escuta requisições no formato OpenAI `/v1/chat/completions`
3. Ao receber uma requisição, insere o payload no textarea do playground e clica em Enviar
4. Intercepta a requisição de predição e substitui o body pelos dados do cliente
5. A resposta SSE é convertida de volta para o formato OpenAI
6. Modelos com suporte a reasoning expõem `reasoning_content` quando a NVIDIA envia esse campo
7. Para DeepSeek V4 Pro, `reasoning_effort=max` é enviado por padrão e `chat_template_kwargs.thinking` não é injetado

## Docker

O container instala Chromium via `apt`, roda em `HEADLESS=true` e salva o perfil persistente em `/app/profile`.

> A primeira subida em profile limpo foi validada em headless. O proxy tenta aceitar automaticamente os termos/cookies do playground e reutiliza o perfil salvo no volume.

### Construir e executar

```bash
# Construir a imagem
docker build -t nvidia-kimi-proxy .

# Executar o container
docker run -d \
  --name nvidia-kimi-proxy \
  -p 4874:4874 \
  -e API_KEY="sua-chave-local" \
  -v nvidia-kimi-profile:/app/profile \
  --restart unless-stopped \
  nvidia-kimi-proxy
```

Se quiser reaproveitar variáveis do `.env`, passe-as explicitamente com `--env-file`, mas sobrescreva o perfil para o caminho Linux do container:

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

### Docker Compose

```bash
docker compose up -d
```

Por padrão o compose publica `localhost:4874`. Para outra porta no host:

```bash
HOST_PORT=4875 docker compose up -d
```

No Windows `cmd`:

```bat
set HOST_PORT=4875
docker compose up -d
```

### Notas sobre Docker

- Na **primeira execução**, o proxy aceita automaticamente os termos da NVIDIA via `dismissCookieBanner`. O perfil é salvo no volume `nvidia-kimi-profile` e reutilizado nas próximas execuções.
- O container usa o Chromium instalado via apt (`/usr/bin/chromium`).
- `PLAYWRIGHT_CHROME`, `PLAYWRIGHT_USER_DATA_DIR` e `PLAYWRIGHT_CHROMIUM_ARGS` já vêm configurados no `Dockerfile` e no `docker-compose.yml`.
- Use `HOST_PORT` para mudar a porta publicada pelo compose. Mantenha `PORT=4874` dentro do container salvo se souber que precisa alterar.
- O healthcheck chama `GET /`, que não exige `API_KEY`.

## Estrutura de Arquivos

```
nvidia-kimi-proxy/
├── playwright-proxy.mjs        # Proxy principal (Node.js + Playwright)
├── package.json                # Dependências npm
├── Dockerfile                  # Imagem Node + Chromium
├── docker-compose.yml          # Serviço Docker com volume persistente
├── .dockerignore
├── .env.example                # Exemplo de configuração
├── .gitignore
├── README.md
├── playwright-profile/         # Perfil do Chromium (criado na primeira execução)
├── run-playwright-proxy.bat    # Atalho para modo visível
└── run-playwright-proxy-headless.bat  # Atalho para modo headless
```
