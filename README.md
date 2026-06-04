# NVIDIA Kimi K2.6 Proxy

Proxy compatível com OpenAI que redireciona requisições para o modelo `moonshotai/kimi-k2.6` no playground da NVIDIA, usando Playwright + Chromium para autenticação via sessão do navegador.

Suporta **tool calling**, **streaming** e integração direta com o [pi.dev](https://pi.dev).

## Pré-requisitos

- **Node.js** 18+ (com `npm`)
- **Google Chrome** ou **Microsoft Edge** instalado
- Conexão com internet

## Instalação

```bash
# 1. Clone ou copie os arquivos para uma pasta
cd NVIDIA-PROXY

# 2. Instale as dependências
npm install

# 3. Inicie o proxy em modo visível (primeira execução)
node playwright-proxy.mjs
```

O navegador abrirá sozinho na página do playground da NVIDIA.

### Primeira execução — aceitar os termos

Na primeira vez, a NVIDIA exibe um modal de **"Acknowledge & Continue"**.
Clique nele **uma única vez** — o proxy salva a aceitação no perfil do navegador e nunca mais pedirá isso.

Após aceitar, o proxy já está pronto para uso.

## Uso

### Modo visível (testes)

```bash
npm start
# ou
node playwright-proxy.mjs
```

### Modo headless (produção)

Após já ter aceito os termos uma vez no modo visível:

```bash
set HEADLESS=true
node playwright-proxy.mjs
```

Ou use o atalho:

```bash
run-playwright-proxy-headless.bat
```

## Endpoint

```
http://localhost:3000/v1/chat/completions
```

### Exemplo com curl

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "moonshotai/kimi-k2.6",
    "messages": [{"role": "user", "content": "Olá, tudo bem?"}],
    "max_tokens": 100
  }'
```

### Exemplo com tool calling

```bash
curl http://localhost:3000/v1/chat/completions \
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
| `PORT` | `3000` | Porta do servidor proxy |
| `HEADLESS` | `false` | `true` para rodar o Chromium em modo oculto |
| `NVIDIA_THINKING` | `false` | Habilita raciocínio (thinking) do modelo |
| `NVIDIA_MAX_TOKENS` | `131072` | `max_tokens` padrão quando o cliente não envia |
| `NVIDIA_REQUEST_TIMEOUT_MS` | `120000` | Timeout máximo por requisição (ms) |
| `PLAYWRIGHT_USER_DATA_DIR` | `./playwright-profile` | Pasta do perfil do Chromium |
| `PLAYWRIGHT_CHROME` | (auto-detecção) | Caminho do executável do Chrome/Edge |

## Integração com pi.dev

Adicione o provider no `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "nvidia-kimi": {
      "baseUrl": "http://localhost:3000/v1",
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
6. O campo `chat_template_kwargs.thinking` é sempre definido como `false` (a menos que `NVIDIA_THINKING=true`)

## Estrutura de Arquivos

```
NVIDIA-PROXY/
├── playwright-proxy.mjs        # Proxy principal (Node.js + Playwright)
├── package.json                # Dependências npm
├── go.mod                      # Módulo Go (funcionalidade adicional)
├── cmd/                        # Código-fonte Go
├── internal/                   # Pacotes internos Go
├── nvidia-proxy.exe            # Binário Go compilado
├── playwright-profile/         # Perfil do Chromium (criado na primeira execução)
├── run-playwright-proxy.bat    # Atalho para modo visível
└── run-playwright-proxy-headless.bat  # Atalho para modo headless
```

## Licença

MIT
