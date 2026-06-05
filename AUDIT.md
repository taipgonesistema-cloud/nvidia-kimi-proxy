# Code Audit

Date: 2026-06-05

Scope: Node.js Playwright proxy, Go backend, Docker/runtime config, README alignment, and operational risks.

## Correction Pass 1

Applied after the initial audit:

- Fixed production auth posture: `API_KEY` is now required in `NODE_ENV=production` unless `ALLOW_UNAUTHENTICATED=true` is explicitly set.
- Fixed Flash reasoning leak: client-supplied `reasoning_effort` is now accepted only for models with `reasoningEffort` enabled, currently DeepSeek V4 Pro.
- Added bounded pending request protection with `PLAYWRIGHT_MAX_PENDING_REQUESTS`.
- Added controlled multi-request support with `PLAYWRIGHT_MAX_CONCURRENT_REQUESTS` using a page pool.
- Tightened predict interception to `api.ngc.nvidia.com` and `/v2/predict/models/`.
- Added trigger correlation to reduce stale request cross-contamination.
- Added real upstream-to-client SSE forwarding for `stream: true` requests.
- Added playground reset after predict failures/timeouts.
- Added `/healthz` and Docker healthcheck coverage for browser init failures.
- Added `SIGTERM` shutdown handling for Docker/EasyPanel.
- Avoided default `max_tokens` when client sends only `max_completion_tokens`.
- Updated README for Flash reasoning, auth, healthcheck, queue limit, concurrency, and real streaming behavior.

Still pending:

- Go backend alignment or legacy cleanup.
- Stronger Docker sandbox posture beyond non-root container user.
- Automated tests.

## TL;DR

- Runtime deployed by Docker is `playwright-proxy.mjs`, not the Go backend.
- Main production streaming issue was addressed: `stream: true` now forwards upstream SSE incrementally.
- Main security issue from the audit was addressed for production: empty `API_KEY` now fails closed in `NODE_ENV=production` unless explicitly allowed.
- Main reliability issue is partially addressed: the queue is bounded, stale correlation was improved, and configurable page-level concurrency was added.
- Go backend is divergent/parallel and should be aligned or marked legacy.

## Findings

### 1. Resolved: Streaming Is Now Incremental In Node Runtime

References:

- `playwright-proxy.mjs:558-560`
- `playwright-proxy.mjs:869-872`
- `playwright-proxy.mjs:343-405`

Original finding: the proxy waited for `response.text()` to complete before sending anything to the client. Correction pass added incremental upstream SSE forwarding for `stream: true` requests.

Impact:

- Streamed clients can now receive chunks while upstream is still generating.
- Non-stream requests still aggregate before returning JSON.

Recommended fix:

- Keep monitoring DeepSeek latency. Real streaming reduces first-token timeout risk but does not make slow models fast.

### 2. High: Empty `API_KEY` Leaves Service Open

References:

- `playwright-proxy.mjs:166-170`
- `.env.example:3`
- `docker-compose.yml:10`

If `API_KEY` is empty, `requestHasValidAPIKey()` returns `true` and `/v1/*` plus `/debug/*` are publicly usable. Compose currently defaults `API_KEY` to empty.

Impact:

- A public deployment can become an unauthenticated free proxy.
- CORS allows any origin, so browser-based abuse is possible if exposed publicly.

Recommended fix:

- In production/Docker, fail startup when `API_KEY` is missing.
- If unauthenticated mode is needed, require explicit `ALLOW_UNAUTHENTICATED=true`.

### 3. High: Flash Can Still Receive Client-Supplied `reasoning_effort`

References:

- `playwright-proxy.mjs:228-231`
- `playwright-proxy.mjs:234-247`

The default `reasoningEffort` was removed from `deepseek-ai/deepseek-v4-flash`, but `reasoning_effort` is still copied from the client request when present.

Impact:

- Clients such as pi.dev may send `reasoning_effort` if model/provider config advertises reasoning support.
- Flash can still become slow if clients send `reasoning_effort=max`.

Recommended fix:

- Filter `reasoning_effort` by model.
- Only allow it for `deepseek-ai/deepseek-v4-pro`, unless explicitly needed for other models.

### 4. Medium: Requests Are Serialized With No Queue Limit

References:

- `playwright-proxy.mjs:135-139`
- `playwright-proxy.mjs:807-840`
- `playwright-proxy.mjs:927-930`

All predictions go through one global lock. Concurrent clients wait in a hidden queue, and the request timeout starts only after the lock is acquired.

Impact:

- One slow DeepSeek call can block all other users.
- Client sockets can pile up.
- Callers may time out without getting a clear busy response.

Recommended fix:

- Add a bounded queue.
- Return `429` or `503` when saturated.
- Eventually add multi-request support with multiple browser contexts/pages.

### 5. Medium: Stale Browser Requests Can Affect The Next Client Request

References:

- `playwright-proxy.mjs:527-535`
- `playwright-proxy.mjs:822-837`

Route handling depends on global `currentPending`. If request A times out and the browser fires its predict request late while request B is pending, the late browser request can be rewritten with B's payload or resolve B incorrectly.

Impact:

- Wrong response can be associated with a later request.
- Timeout recovery is fragile.

Recommended fix:

- Correlate each request with a nonce/id embedded in the trigger text or payload.
- Reject stale intercepted requests.
- Reload/reset the playground after timeouts.

### 6. Medium: Intercepted Predict Route Does Not Validate Exact Host

References:

- `playwright-proxy.mjs:501-522`

The code defines `PREDICT_ROUTE` for NVIDIA, but `handleRoute()` checks only whether the URL includes `/v2/predict/models/`.

Impact:

- Any script/request in the browser page targeting another host with that path could be treated as a predict request.
- This broad matching increases risk of leaking rewritten payloads.

Recommended fix:

- Require `url.hostname === "api.ngc.nvidia.com"` and matching path prefix.
- Use the `PREDICT_ROUTE` constant consistently or remove it.

### 7. Medium: Healthcheck Does Not Validate Chromium Readiness

References:

- `Dockerfile:29-30`
- `playwright-proxy.mjs:887-890`
- `playwright-proxy.mjs:936-938`

Docker healthcheck calls `GET /`, which returns healthy even if Chromium failed to initialize. Startup logs the browser init error but keeps the HTTP process alive.

Impact:

- EasyPanel/Docker can route traffic to a broken proxy.
- Failures show up only at request time.

Recommended fix:

- Add `/healthz` that checks browser/page readiness.
- Or fail process startup if initial browser launch fails in production.

### 8. Medium: Go Backend Diverges From Node And Is Not The Deployed Runtime

References:

- `Dockerfile:32`
- `internal/server/handler.go:92-95`
- `internal/server/handler.go:113-118`
- `playwright-proxy.mjs:872-873`
- `internal/bridge/client.go:25-29`

Docker runs `node playwright-proxy.mjs`. The Go backend exists in parallel, but behaves differently and depends on an external bridge at `localhost:9223` with a default hard-coded `TAB_ID`.

Impact:

- Fixes in Go do not affect production.
- Go defaults omitted `stream` to true, while Node returns JSON when `stream` is omitted.
- Go is not self-contained for Docker/EasyPanel.

Recommended fix:

- Either align Go with Node and provide a real deployment path, or mark/remove Go as legacy.

### 9. Medium: Docker Runs Chromium As Root With `--no-sandbox`

References:

- `Dockerfile:1-8`
- `docker-compose.yml:20`

The container uses the default root user and launches Chromium with `--no-sandbox`.

Impact:

- Browser compromise has higher impact inside the container.
- Reduced Chromium isolation.

Recommended fix:

- Create and run as a non-root user.
- Chown `/app/profile`.
- Drop container capabilities where possible.
- Avoid `--no-sandbox` if the environment allows it.

### 10. Low: `max_completion_tokens` Can Conflict With Default `max_tokens`

References:

- `playwright-proxy.mjs:220-247`

The payload always includes default `max_tokens: 131072`, then copies `max_completion_tokens` if provided.

Impact:

- Some OpenAI-compatible APIs reject or misinterpret requests containing both fields.
- NVIDIA behavior may be inconsistent depending on model.

Recommended fix:

- If the client sends `max_completion_tokens`, omit default `max_tokens` or normalize to one upstream field.

### 11. Low: README Is Out Of Date For Flash Reasoning

References:

- `README.md:26-27`
- `README.md:352-363`
- `README.md:384-419`

README still says `deepseek-ai/deepseek-v4-flash` sends `reasoning_effort=max` by default, but code no longer does that.

Impact:

- Users may configure clients such as pi.dev to send reasoning options to Flash.
- Docs no longer match runtime behavior.

Recommended fix:

- Update README and pi.dev example to mark Flash as non-reasoning or reasoning optional without default `reasoning_effort`.

### 12. Low: Missing Real Tests

References:

- `package.json:6-8`
- `go test ./...` output: `[no test files]`

There are no automated tests for payload building, SSE conversion, tool calls, streaming behavior, timeouts, or concurrency.

Impact:

- Compatibility regressions are easy to introduce.
- Current Go/Node divergence is not guarded.

Recommended fix:

- Add tests for `buildPredictPayload()` behavior.
- Add tests for SSE-to-OpenAI conversion.
- Add tests for tool call parsing.
- Add integration tests for `stream: false`, `stream: true`, timeout, and concurrent request behavior.

## Verified Behavior During Audit

- Kimi chat on local proxy worked.
- Kimi tool calling worked.
- StepFun tool calling worked and returned `reasoning_content`.
- DeepSeek V4 Flash worked on VPS for a tiny request after removing default reasoning effort, but remains latency-sensitive.
- DeepSeek V4 Pro still timed out in VPS testing and should be treated as unreliable unless proxy/server timeouts are increased.

## Commands Run

```bash
node --check playwright-proxy.mjs
go test ./...
npm audit --omit=dev --audit-level=moderate
git status --short
```

Results:

- `node --check playwright-proxy.mjs`: passed.
- `go test ./...`: passed compilation, but no test files exist.
- `npm audit --omit=dev --audit-level=moderate`: 0 vulnerabilities.
- `git status --short`: clean after audit.

## Suggested Priority Order

1. Validate real streaming and page-pool concurrency in EasyPanel under load.
2. Decide whether Go backend is supported or legacy.
3. Improve Docker sandbox posture beyond non-root runtime.
4. Add automated tests.
5. Consider `max_completion_tokens` compatibility tests across models.
