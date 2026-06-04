# NVIDIA Playwright Proxy

Standalone OpenAI-compatible proxy for `moonshotai/kimi-k2.6` using a dedicated Playwright Chromium profile instead of BrowserBridge.

## Setup

```bat
npm install
node playwright-proxy.mjs
```

Headless launcher:

```bat
run-playwright-proxy-headless.bat
```

Default endpoint:

```text
http://localhost:3000/v1/chat/completions
```

The browser profile is stored in `playwright-profile/`. If NVIDIA asks for login or consent, complete it once in the opened browser window and retry the request.

## Environment

```text
PORT=3000
NVIDIA_THINKING=false
NVIDIA_MAX_TOKENS=131072
HEADLESS=false
PLAYWRIGHT_USER_DATA_DIR=C:\path\to\profile
PLAYWRIGHT_CHROME=C:\path\to\chrome.exe
```

## Notes

- The proxy always rewrites the NVIDIA Playground request body with `chat_template_kwargs.thinking=false` unless `NVIDIA_THINKING=true` is set.
- If the client does not send `max_tokens`, the proxy defaults to `NVIDIA_MAX_TOKENS` (`131072`). Client-provided `max_tokens` still wins.
- OpenAI `tools`, `tool_choice`, `parallel_tool_calls`, legacy `functions`, and legacy `function_call` are forwarded to Kimi.
- Use `HEADLESS=true` after the persistent profile has already completed NVIDIA login/terms once in visible mode.
- Responses are converted back to OpenAI chat completion format, including `tool_calls` and streaming chunks.
