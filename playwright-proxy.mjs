import "dotenv/config";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_MODEL = "moonshotai/kimi-k2.6";
const MODELS = {
  "moonshotai/kimi-k2.6": {
    id: "moonshotai/kimi-k2.6",
    playgroundURL: "https://build.nvidia.com/moonshotai/kimi-k2.6/playground",
  },
  "deepseek-ai/deepseek-v4-pro": {
    id: "deepseek-ai/deepseek-v4-pro",
    playgroundURL: "https://build.nvidia.com/deepseek-ai/deepseek-v4-pro/playground",
    reasoningEffort: true,
  },
  "deepseek-ai/deepseek-v4-flash": {
    id: "deepseek-ai/deepseek-v4-flash",
    playgroundURL: "https://build.nvidia.com/deepseek-ai/deepseek-v4-flash/playground",
    reasoningEffort: true,
  },
  "stepfun-ai/step-3.7-flash": {
    id: "stepfun-ai/step-3.7-flash",
    playgroundURL: "https://build.nvidia.com/stepfun-ai/step-3.7-flash/playground",
  },
};
const PREDICT_ROUTE = "https://api.ngc.nvidia.com/v2/predict/models/**";
const PORT = Number(process.env.PORT || process.env.PLAYWRIGHT_PROXY_PORT || 4874);
const USER_DATA_DIR = process.env.PLAYWRIGHT_USER_DATA_DIR || path.join(__dirname, "playwright-profile");
const HEADLESS = ["1", "true", "yes"].includes(String(process.env.HEADLESS || "").toLowerCase());
const REQUEST_TIMEOUT_MS = Number(process.env.NVIDIA_REQUEST_TIMEOUT_MS || 120000);
const DEFAULT_MAX_TOKENS = Number(process.env.NVIDIA_MAX_TOKENS || 131072);
const DEFAULT_TEMPERATURE = Number(process.env.NVIDIA_TEMPERATURE || 0.2);
const DEFAULT_TOP_P = Number(process.env.NVIDIA_TOP_P || 0.8);
const API_KEY = process.env.API_KEY || "";
const DEFAULT_DEEPSEEK_REASONING_EFFORT = process.env.NVIDIA_DEEPSEEK_REASONING_EFFORT || "max";
const BROWSER_IDLE_TIMEOUT_MS = Number(process.env.PLAYWRIGHT_BROWSER_IDLE_TIMEOUT_MS || 300000);

let context = null;
let page = null;
let currentPending = null;
let lock = Promise.resolve();
let lastRewrite = null;
let browserInitPromise = null;
let routeInstalled = false;
let browserIdleTimer = null;

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function profileHasState() {
  try {
    const defaultDir = path.join(USER_DATA_DIR, "Default");
    if (!fs.existsSync(defaultDir)) return false;
    const cookies = path.join(defaultDir, "Cookies");
    const network = path.join(defaultDir, "Network Action");
    return fs.existsSync(cookies) || fs.existsSync(network);
  } catch { return false; }
}

function findBrowserExecutable() {
  if (process.env.PLAYWRIGHT_CHROME && fs.existsSync(process.env.PLAYWRIGHT_CHROME)) {
    return process.env.PLAYWRIGHT_CHROME;
  }

  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function chromiumArgs() {
  const defaultArgs = [
    "--disable-blink-features=AutomationControlled",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-client-side-phishing-detection",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,InterestFeedContentSuggestions",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-notifications",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-default-browser-check",
    "--no-first-run",
  ];
  const extraArgs = String(process.env.PLAYWRIGHT_CHROMIUM_ARGS || "")
    .split(/\s+/)
    .map((arg) => arg.trim())
    .filter(Boolean);
  return [...new Set([...defaultArgs, ...extraArgs])];
}

function scheduleBrowserIdleClose() {
  if (browserIdleTimer) clearTimeout(browserIdleTimer);
  if (!BROWSER_IDLE_TIMEOUT_MS) return;
  browserIdleTimer = setTimeout(async () => {
    if (currentPending) return scheduleBrowserIdleClose();
    await context?.close().catch(() => {});
    context = null;
    page = null;
    routeInstalled = false;
  }, BROWSER_IDLE_TIMEOUT_MS);
}

function keepBrowserAwake() {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
}

function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

function randomID(prefix = "chatcmpl") {
  return `${prefix}-${crypto.randomBytes(12).toString("hex")}`;
}

function createdTime() {
  return Math.floor(Date.now() / 1000);
}

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
}

function sendJSON(res, status, data) {
  setCORS(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: { message, type: "error", code: String(status) } });
}

function requestHasValidAPIKey(req) {
  if (!API_KEY) return true;
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer === API_KEY || req.headers["x-api-key"] === API_KEY;
}

function requireAPIKey(req, res) {
  if (requestHasValidAPIKey(req)) return true;
  sendError(res, 401, "invalid or missing API key");
  return false;
}

async function readRequestBody(req, limit = 2 << 20) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function convertLegacyFunctions(req, payload) {
  if (!payload.tools && Array.isArray(req.functions)) {
    payload.tools = req.functions.map((fn) => ({ type: "function", function: fn }));
  }

  if (payload.tool_choice === undefined && req.function_call !== undefined) {
    if (typeof req.function_call === "string") {
      payload.tool_choice = req.function_call;
    } else if (req.function_call?.name) {
      payload.tool_choice = { type: "function", function: { name: req.function_call.name } };
    }
  }
}

function resolveModel(model) {
  const modelId = model || DEFAULT_MODEL;
  const modelInfo = MODELS[modelId];
  if (!modelInfo) {
    throw new Error(`unsupported model: ${modelId}`);
  }
  return modelInfo;
}

function buildPredictPayload(req) {
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new Error("messages is required");
  }

  const modelInfo = resolveModel(req.model);

  const payload = {
    model: modelInfo.id,
    messages: req.messages,
    max_tokens: DEFAULT_MAX_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
    top_p: DEFAULT_TOP_P,
    stream: true,
  };
  if (modelInfo.reasoningEffort) {
    payload.reasoning_effort = DEFAULT_DEEPSEEK_REASONING_EFFORT;
  } else {
    payload.chat_template_kwargs = { thinking: parseBool(process.env.NVIDIA_THINKING, false) };
  }

  const copiedFields = [
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "seed",
    "user",
    "stop",
    "response_format",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning_effort",
    "stream_options",
  ];
  for (const field of copiedFields) {
    if (req[field] !== undefined && req[field] !== null) payload[field] = req[field];
  }
  convertLegacyFunctions(req, payload);
  return { payload, modelInfo };
}

function mergeToolCall(toolCalls, delta, fallbackIndex) {
  const index = Number.isInteger(delta?.index) ? delta.index : fallbackIndex;
  let target = toolCalls.find((item) => Number.isInteger(item.index) && item.index === index);
  if (!target && delta?.id) target = toolCalls.find((item) => item.id === delta.id);
  if (!target) {
    target = { index, id: "", type: "function", function: { name: "", arguments: "" } };
    toolCalls.push(target);
  }

  if (delta.id) target.id = delta.id;
  if (delta.type) target.type = delta.type;
  if (delta.function?.name) target.function.name = delta.function.name;
  if (delta.function?.arguments) target.function.arguments += delta.function.arguments;
}

function messageToolCalls(toolCalls) {
  return toolCalls.map((toolCall) => ({
    id: toolCall.id,
    type: toolCall.type || "function",
    function: toolCall.function,
  }));
}

function streamToolCalls(toolCalls) {
  return toolCalls.map((toolCall, index) => ({
    index,
    id: toolCall.id,
    type: toolCall.type || "function",
    function: toolCall.function,
  }));
}

function convertSSEToResponse(sseText, modelId) {
  const response = {
    id: randomID(),
    object: "chat.completion",
    created: createdTime(),
    model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
  };

  let fullContent = "";
  let fullReasoningContent = "";
  let finishReason = null;
  const toolCalls = [];

  for (const rawLine of String(sseText || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") continue;

    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.usage) response.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta || {};
    if (typeof delta.content === "string") fullContent += delta.content;
    if (typeof delta.reasoning_content === "string") fullReasoningContent += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((toolCall, index) => mergeToolCall(toolCalls, toolCall, index));
    }
  }

  if (toolCalls.length > 0) {
    response.choices[0].message = { role: "assistant", tool_calls: messageToolCalls(toolCalls) };
    if (fullReasoningContent) response.choices[0].message.reasoning_content = fullReasoningContent;
    response.choices[0].finish_reason = finishReason && finishReason !== "stop" ? finishReason : "tool_calls";
  } else {
    response.choices[0].message.content = fullContent;
    if (fullReasoningContent) response.choices[0].message.reasoning_content = fullReasoningContent;
    if (finishReason) response.choices[0].finish_reason = finishReason;
  }
  return response;
}

function writeSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendOpenAIStream(res, response) {
  setCORS(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const choice = response.choices?.[0] || {};
  writeSSE(res, {
    id: response.id,
    object: "chat.completion.chunk",
    created: response.created,
    model: response.model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });

  if (choice.message?.reasoning_content) {
    writeSSE(res, {
      id: response.id,
      object: "chat.completion.chunk",
      created: response.created,
      model: response.model,
      choices: [{ index: 0, delta: { reasoning_content: choice.message.reasoning_content }, finish_reason: null }],
    });
  }

  if (choice.message?.tool_calls?.length) {
    writeSSE(res, {
      id: response.id,
      object: "chat.completion.chunk",
      created: response.created,
      model: response.model,
      choices: [{ index: 0, delta: { tool_calls: streamToolCalls(choice.message.tool_calls) }, finish_reason: null }],
    });
  } else if (choice.message?.content) {
    writeSSE(res, {
      id: response.id,
      object: "chat.completion.chunk",
      created: response.created,
      model: response.model,
      choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: null }],
    });
  }

  writeSSE(res, {
    id: response.id,
    object: "chat.completion.chunk",
    created: response.created,
    model: response.model,
    choices: [{ index: 0, delta: { content: "" }, finish_reason: choice.finish_reason || "stop" }],
  });

  if (response.usage) {
    writeSSE(res, {
      id: response.id,
      object: "chat.completion.chunk",
      created: response.created,
      model: response.model,
      choices: [],
      usage: response.usage,
    });
  }
  res.end("data: [DONE]\n\n");
}

async function ensureBrowser(modelInfo = MODELS[DEFAULT_MODEL]) {
  keepBrowserAwake();
  if (context && page && !page.isClosed() && page.url().startsWith(modelInfo.playgroundURL)) {
    scheduleBrowserIdleClose();
    return;
  }
  if (browserInitPromise) return browserInitPromise;

  browserInitPromise = (async () => {
    if (context && page && !page.isClosed()) {
      await openPlayground(modelInfo, false);
      return;
    }

    const executablePath = findBrowserExecutable();
    if (!executablePath) {
      throw new Error("Chrome/Edge not found. Set PLAYWRIGHT_CHROME to a Chromium executable path.");
    }

    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      executablePath,
      headless: HEADLESS,
      viewport: { width: 1024, height: 768 },
      args: chromiumArgs(),
    });

    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(30000);
    routeInstalled = false;
    if (!routeInstalled) {
      await context.route("**/*", handleRoute);
      routeInstalled = true;
    }
    await openPlayground(modelInfo, false);
    scheduleBrowserIdleClose();
  })();

  try {
    await browserInitPromise;
  } finally {
    browserInitPromise = null;
  }
}

async function playgroundControlsReady() {
  return page.evaluate(() => {
    const input = document.querySelector('[data-testid="nv-text-area-element"]')
      || document.querySelector('.nv-text-area-element')
      || document.querySelector('textarea');
    const send = [...document.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Send");
    return !!(input && send
      && (input.offsetWidth || input.offsetHeight || input.getClientRects().length)
      && (send.offsetWidth || send.offsetHeight || send.getClientRects().length));
  }).catch(() => false);
}

async function waitForPlaygroundReady() {
  await dismissCookieBanner();
  await page.waitForFunction(() => document.readyState === "complete", null, { timeout: 60000 }).catch(() => {});
  await dismissCookieBanner();
  await page.waitForSelector('[data-testid="nv-text-area-element"], .nv-text-area-element, textarea', { timeout: 60000 });
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="nv-text-area-element"]')
      || document.querySelector('.nv-text-area-element')
      || document.querySelector('textarea');
    const send = [...document.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Send");
    return input && send
      && !!(input.offsetWidth || input.offsetHeight || input.getClientRects().length)
      && !!(send.offsetWidth || send.offsetHeight || send.getClientRects().length);
  }, null, { timeout: 60000 });
  await dismissCookieBanner();
}

async function openPlayground(modelInfo, forceReload) {
  if (forceReload || !page.url().startsWith(modelInfo.playgroundURL)) {
    await page.goto(modelInfo.playgroundURL, { waitUntil: "load", timeout: 90000 });
  }
  await waitForPlaygroundReady();
}

async function preparePlayground(modelInfo) {
  await ensureBrowser(modelInfo);
  if (!page.url().startsWith(modelInfo.playgroundURL)) {
    await openPlayground(modelInfo, true);
    return;
  }
  if (await playgroundControlsReady()) return;
  await waitForPlaygroundReady();
}

async function handleRoute(route) {
  const request = route.request();
  const url = new URL(request.url());
  const host = url.hostname;
  const resourceType = request.resourceType();

  if (!request.url().includes("/v2/predict/models/")) {
    if (["image", "media", "font"].includes(resourceType)
      || host.includes("google-analytics")
      || host.includes("googletagmanager")
      || host.includes("doubleclick")
      || host.includes("linkedin")
      || host.includes("nr-data")
      || host.includes("newrelic")) {
      await route.abort().catch(() => {});
      return;
    }
    await route.continue();
    return;
  }

  if (request.method() !== "POST" || !request.url().includes("/v2/predict/models/")) {
    await route.continue();
    return;
  }

  const pending = currentPending;
  if (!pending) {
    await route.continue();
    return;
  }

  pending.request = request;
  pending.url = request.url();
  pending.originalPostData = request.postData() || "";
  const originalSummary = payloadSummary(pending.originalPostData);
  const rewrittenSummary = payloadSummary(pending.postData);
  lastRewrite = {
    id: pending.id,
    url: pending.url,
    originalThinking: originalSummary.thinking,
    rewrittenThinking: rewrittenSummary.thinking,
    rewrittenMaxTokens: rewrittenSummary.maxTokens,
    rewrittenMaxCompletionTokens: rewrittenSummary.maxCompletionTokens,
    rewrittenTemperature: rewrittenSummary.temperature,
    rewrittenTopP: rewrittenSummary.topP,
    rewrittenReasoningEffort: rewrittenSummary.reasoningEffort,
    rewrittenSeed: rewrittenSummary.seed,
    rewrittenToolsCount: rewrittenSummary.toolsCount,
    rewrittenToolNames: rewrittenSummary.toolNames,
    rewrittenToolChoice: rewrittenSummary.toolChoice,
    rewrittenParallelToolCalls: rewrittenSummary.parallelToolCalls,
    originalLength: pending.originalPostData.length,
    rewrittenLength: pending.postData.length,
    at: Date.now(),
  };
  try {
    const response = await route.fetch({ postData: pending.postData, timeout: REQUEST_TIMEOUT_MS });
    const body = await response.text();
    await route.fulfill({ response, body });
    pending.resolve({
      status: response.status(),
      url: pending.url,
      mimeType: response.headers()["content-type"] || "",
      body,
    });
  } catch (error) {
    await route.abort().catch(() => {});
    pending.reject(error);
  }
}

function payloadSummary(postData) {
  try {
    const payload = JSON.parse(postData || "{}");
    return {
      thinking: payload.chat_template_kwargs?.thinking,
      maxTokens: payload.max_tokens,
      maxCompletionTokens: payload.max_completion_tokens,
      temperature: payload.temperature,
      topP: payload.top_p,
      reasoningEffort: payload.reasoning_effort,
      seed: payload.seed,
      toolsCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
      toolNames: Array.isArray(payload.tools)
        ? payload.tools.map((tool) => tool?.function?.name).filter(Boolean)
        : [],
      toolChoice: payload.tool_choice,
      parallelToolCalls: payload.parallel_tool_calls,
    };
  } catch {
    return {};
  }
}

async function elementCenter(selectorExpression) {
  return page.evaluate((expression) => {
    const element = Function(`return (${expression});`)();
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
    };
  }, selectorExpression);
}

async function cdpClick(cdp, point) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function cdpSetTextareaValue(cdp, text) {
  const expression = `(() => {
    const input = document.querySelector('[data-testid="nv-text-area-element"]')
      || document.querySelector('.nv-text-area-element')
      || document.querySelector('textarea');
    if (!input) return { ok: false, error: 'textarea not found' };
    const proto = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    descriptor.set.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    return { ok: true, value: input.value };
  })()`;
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (!result.result?.value?.ok) {
    throw new Error(result.result?.value?.error || "failed to set textarea via CDP Runtime.evaluate");
  }
}

async function cdpClearTextarea(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector('[data-testid="nv-text-area-element"]')
        || document.querySelector('.nv-text-area-element')
        || document.querySelector('textarea');
      if (!input) return { ok: false, error: 'textarea not found' };
      const proto = Object.getPrototypeOf(input);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
        || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      descriptor.set.call(input, '');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
      return { ok: true };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (!result.result?.value?.ok) {
    throw new Error(result.result?.value?.error || "failed to clear textarea");
  }
}

async function sendButtonEnabled(timeout = 3000) {
  try {
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === "Send");
      return button && !button.disabled;
    }, null, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function dismissCookieBanner() {
  const clickButton = async (selector, text) => {
    try {
      if (selector) {
        const el = await page.$(selector);
        if (el) { await el.click().catch(() => {}); return true; }
      }
      if (text) {
        await page.evaluate((t) => {
          const btn = [...document.querySelectorAll("button")].find(
            b => (b.innerText || b.textContent || "").trim() === t
          );
          if (btn && !btn.disabled) btn.click();
        }, text).catch(() => {});
        return true;
      }
    } catch {}
    return false;
  };

  await clickButton("#onetrust-accept-btn-handler", "Accept All");
  await page.waitForTimeout(2000);

  await clickButton(null, "Acknowledge & Continue");
  await page.waitForTimeout(1000);
}

async function cdpClickSendFallback(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === 'Send');
      if (!button) return { ok: false, error: 'send button not found' };
      if (button.disabled) return { ok: false, error: 'send button disabled' };
      button.click();
      return { ok: true };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (!result.result?.value?.ok) {
    throw new Error(result.result?.value?.error || "send fallback failed");
  }
}

async function triggerPlaygroundRequest() {
  await page.bringToFront();
  const cdp = await context.newCDPSession(page);
  const triggerText = `bridge trigger ${Date.now()}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const inputPoint = await elementCenter(`document.querySelector('[data-testid="nv-text-area-element"]') || document.querySelector('.nv-text-area-element') || document.querySelector('textarea')`);
    if (!inputPoint) throw new Error("textarea not found");

    await cdpClick(cdp, inputPoint);
    await cdpClearTextarea(cdp);
    await cdp.send("Input.insertText", { text: triggerText }).catch(() => {});
    if (await sendButtonEnabled()) break;

    await cdpSetTextareaValue(cdp, triggerText);
    if (await sendButtonEnabled()) break;

    if (attempt === 3) throw new Error("send button did not enable after CDP input");
    await page.waitForTimeout(500);
  }

  const sendPoint = await elementCenter(`[...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === 'Send')`);
  if (!sendPoint) throw new Error("send button not found");
  await cdpClick(cdp, sendPoint);
  await new Promise((resolve) => setTimeout(resolve, 750));
  if (currentPending && !currentPending.request) await cdpClickSendFallback(cdp);
}

async function pageDebugState() {
  await ensureBrowser();
  return page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="nv-text-area-element"]')
      || document.querySelector('.nv-text-area-element')
      || document.querySelector('textarea');
    const send = [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Send");
    const buttons = [...document.querySelectorAll("button")]
      .filter((button) => !!(button.offsetWidth || button.offsetHeight || button.getClientRects().length))
      .map((button) => ({
        text: (button.innerText || button.textContent || "").trim().slice(0, 80),
        aria: button.getAttribute("aria-label"),
        pressed: button.getAttribute("aria-pressed"),
        disabled: button.disabled,
        testid: button.getAttribute("data-testid"),
        className: String(button.className || "").slice(0, 160),
      }));
    return {
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      activeTag: document.activeElement?.tagName || null,
      activeTestId: document.activeElement?.getAttribute?.("data-testid") || null,
      textarea: textarea ? {
        tag: textarea.tagName,
        value: textarea.value || "",
        disabled: textarea.disabled,
        visible: !!(textarea.offsetWidth || textarea.offsetHeight || textarea.getClientRects().length),
        testid: textarea.getAttribute("data-testid"),
        placeholder: textarea.getAttribute("placeholder"),
      } : null,
      send: send ? {
        disabled: send.disabled,
        visible: !!(send.offsetWidth || send.offsetHeight || send.getClientRects().length),
        className: String(send.className || "").slice(0, 160),
      } : null,
      buttons,
      bodyTail: (document.body?.innerText || "").slice(-1500),
    };
  });
}

async function predict(postData, modelInfo) {
  return withLock(async () => {
    await preparePlayground(modelInfo);

    const pending = {};
    const responsePromise = new Promise((resolve, reject) => {
      Object.assign(pending, {
        id: randomID("predict"),
        postData,
        request: null,
        resolve,
        reject,
      });
    });

    currentPending = pending;
    try {
      await triggerPlaygroundRequest();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("predict timed out waiting for NVIDIA response")), REQUEST_TIMEOUT_MS);
      });
      const response = await Promise.race([responsePromise, timeoutPromise]);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`predict HTTP ${response.status}: ${response.body.slice(0, 1000)}`);
      }
      if (!String(response.body || "").includes("data: [DONE]")) {
        throw new Error("predict response did not finish with data: [DONE]");
      }
      return response.body;
    } finally {
      currentPending = null;
      scheduleBrowserIdleClose();
    }
  });
}

async function chatCompletions(req, res) {
  let bodyText;
  try {
    bodyText = await readRequestBody(req);
  } catch (error) {
    sendError(res, 400, error.message);
    return;
  }

  let chatReq;
  try {
    chatReq = JSON.parse(bodyText || "{}");
  } catch (error) {
    sendError(res, 400, `invalid JSON: ${error.message}`);
    return;
  }

  let payload;
  let modelInfo;
  try {
    ({ payload, modelInfo } = buildPredictPayload(chatReq));
  } catch (error) {
    sendError(res, 400, error.message);
    return;
  }

  try {
    const sseText = await predict(JSON.stringify(payload), modelInfo);
    const openAIResponse = convertSSEToResponse(sseText, modelInfo.id);
    if (chatReq.stream) sendOpenAIStream(res, openAIResponse);
    else sendJSON(res, 200, openAIResponse);
  } catch (error) {
    sendError(res, 502, `predict failed: ${error.message}`);
  }
}

const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/") {
    sendJSON(res, 200, { service: "nvidia-playwright-proxy", status: "running", port: PORT });
    return;
  }
  if (req.method === "GET" && url.pathname === "/debug/status") {
    if (!requireAPIKey(req, res)) return;
    sendJSON(res, 200, {
      service: "nvidia-playwright-proxy",
      browserReady: !!context,
      pageURL: page && !page.isClosed() ? page.url() : null,
      pending: currentPending ? { id: currentPending.id, matched: !!currentPending.request } : null,
      lastRewrite,
      userDataDir: USER_DATA_DIR,
      headless: HEADLESS,
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/debug/page") {
    if (!requireAPIKey(req, res)) return;
    try {
      sendJSON(res, 200, await pageDebugState());
    } catch (error) {
      sendError(res, 500, error.message);
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    if (!requireAPIKey(req, res)) return;
    sendJSON(res, 200, {
      object: "list",
      data: Object.values(MODELS).map((model) => ({
        id: model.id,
        object: "model",
        created: createdTime(),
        owned_by: "nvidia",
      })),
    });
    return;
  }
  if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/chat/completions/")) {
    if (!requireAPIKey(req, res)) return;
    await chatCompletions(req, res);
    return;
  }

  sendError(res, 404, "not found");
});

server.listen(PORT, () => {
  console.log(`[nvidia-playwright-proxy] listening on http://localhost:${PORT}`);
  ensureBrowser().catch((error) => console.error(`[nvidia-playwright-proxy] browser init failed: ${error.message}`));
});

process.on("SIGINT", async () => {
  await context?.close().catch(() => {});
  process.exit(0);
});
