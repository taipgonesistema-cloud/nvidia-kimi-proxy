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
  },
  "stepfun-ai/step-3.7-flash": {
    id: "stepfun-ai/step-3.7-flash",
    playgroundURL: "https://build.nvidia.com/stepfun-ai/step-3.7-flash/playground",
  },
};
const PREDICT_HOST = "api.ngc.nvidia.com";
const PREDICT_PATH_PREFIX = "/v2/predict/models/";
const PORT = Number(process.env.PORT || process.env.PLAYWRIGHT_PROXY_PORT || 4874);
const USER_DATA_DIR = process.env.PLAYWRIGHT_USER_DATA_DIR || path.join(__dirname, "playwright-profile");
const HEADLESS = ["1", "true", "yes"].includes(String(process.env.HEADLESS || "").toLowerCase());
const REQUEST_TIMEOUT_MS = Number(process.env.NVIDIA_REQUEST_TIMEOUT_MS || 120000);
const DEFAULT_MAX_TOKENS = Number(process.env.NVIDIA_MAX_TOKENS || 131072);
const DEFAULT_TEMPERATURE = Number(process.env.NVIDIA_TEMPERATURE || 0.2);
const DEFAULT_TOP_P = Number(process.env.NVIDIA_TOP_P || 0.8);
const API_KEY = process.env.API_KEY || "";
const ALLOW_UNAUTHENTICATED = parseBool(process.env.ALLOW_UNAUTHENTICATED, false);
const DEFAULT_DEEPSEEK_REASONING_EFFORT = process.env.NVIDIA_DEEPSEEK_REASONING_EFFORT || "max";
const BROWSER_IDLE_TIMEOUT_MS = Number(process.env.PLAYWRIGHT_BROWSER_IDLE_TIMEOUT_MS || 300000);
const MAX_PENDING_REQUESTS = Number(process.env.PLAYWRIGHT_MAX_PENDING_REQUESTS || 8);
const MAX_CONCURRENT_REQUESTS = Number(process.env.PLAYWRIGHT_MAX_CONCURRENT_REQUESTS || 1);

let context = null;
let page = null;
let lastRewrite = null;
let browserInitPromise = null;
let routeInstalled = false;
let browserIdleTimer = null;
let lastBrowserInitError = null;
let workers = [];
let workerQueue = [];
let pendingByPage = new Map();

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

if (!API_KEY && !ALLOW_UNAUTHENTICATED && process.env.NODE_ENV === "production") {
  console.error("[nvidia-playwright-proxy] API_KEY is required in production. Set ALLOW_UNAUTHENTICATED=true to disable auth intentionally.");
  process.exit(1);
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
    if (pendingByPage.size || workers.some((worker) => worker.busy) || workerQueue.length) return scheduleBrowserIdleClose();
    await context?.close().catch(() => {});
    context = null;
    page = null;
    routeInstalled = false;
    workers = [];
    pendingByPage = new Map();
  }, BROWSER_IDLE_TIMEOUT_MS);
}

function keepBrowserAwake() {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
}

function activeWorkerCount() {
  return workers.filter((worker) => worker.busy).length;
}

function pendingRequestCount() {
  return activeWorkerCount() + workerQueue.length;
}

function reserveQueueSlot() {
  if (MAX_PENDING_REQUESTS > 0 && pendingRequestCount() >= MAX_PENDING_REQUESTS) {
    const error = new Error("proxy busy: too many pending requests");
    error.code = "PROXY_BUSY";
    throw error;
  }
}

async function createWorker() {
  const workerPage = workers.length === 0 && page && !page.isClosed() ? page : await context.newPage();
  workerPage.setDefaultTimeout(30000);
  if (!page || page.isClosed()) page = workerPage;
  const worker = { id: workers.length + 1, page: workerPage, busy: false, modelId: null };
  workers.push(worker);
  return worker;
}

async function acquireWorker() {
  reserveQueueSlot();
  keepBrowserAwake();
  await ensureBrowser();

  const idleWorker = workers.find((worker) => !worker.busy && !worker.page.isClosed());
  if (idleWorker) {
    idleWorker.busy = true;
    return idleWorker;
  }

  if (workers.length < MAX_CONCURRENT_REQUESTS) {
    const worker = await createWorker();
    worker.busy = true;
    return worker;
  }

  return new Promise((resolve, reject) => {
    workerQueue.push({ resolve, reject });
  });
}

function releaseWorker(worker) {
  pendingByPage.delete(worker.page);
  const next = workerQueue.shift();
  if (next) {
    worker.busy = true;
    next.resolve(worker);
    return;
  }
  worker.busy = false;
  scheduleBrowserIdleClose();
}

function isPredictURL(url) {
  return url.hostname === PREDICT_HOST && url.pathname.startsWith(PREDICT_PATH_PREFIX);
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
  if (!API_KEY) return process.env.NODE_ENV !== "production" || ALLOW_UNAUTHENTICATED;
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
    "stream_options",
  ];
  for (const field of copiedFields) {
    if (req[field] !== undefined && req[field] !== null) payload[field] = req[field];
  }
  if (modelInfo.reasoningEffort && req.reasoning_effort !== undefined && req.reasoning_effort !== null) {
    payload.reasoning_effort = req.reasoning_effort;
  }
  if (req.max_completion_tokens !== undefined && req.max_completion_tokens !== null
    && (req.max_tokens === undefined || req.max_tokens === null)) {
    delete payload.max_tokens;
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

function requestHeadersForFetch(request) {
  const headers = { ...request.headers() };
  for (const header of ["host", "content-length", "connection", "accept-encoding"]) {
    delete headers[header];
  }
  return headers;
}

function responseHeadersForFulfill(headers) {
  const out = {};
  headers.forEach((value, key) => {
    if (!["content-encoding", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
      out[key] = value;
    }
  });
  return out;
}

function cleanDelta(delta) {
  const out = {};
  for (const [key, value] of Object.entries(delta || {})) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

function createOpenAIStreamForwarder(res, modelId) {
  const streamId = randomID();
  const created = createdTime();
  let buffer = "";
  let started = false;
  let sawDone = false;

  const start = () => {
    if (started) return;
    started = true;
    setCORS(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    writeSSE(res, {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
  };

  const processLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith("data: ")) return;
    const data = line.slice(6);
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }

    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }

    start();
    const out = {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: Array.isArray(chunk.choices) ? chunk.choices.map((choice, index) => ({
        index: Number.isInteger(choice.index) ? choice.index : index,
        delta: cleanDelta(choice.delta || {}),
        finish_reason: choice.finish_reason ?? null,
      })) : [],
    };
    if (chunk.usage) out.usage = chunk.usage;
    if (out.choices.length || out.usage) writeSSE(res, out);
  };

  return {
    write(text) {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    },
    end() {
      if (buffer) processLine(buffer);
      start();
      if (!sawDone) {
        writeSSE(res, {
          id: streamId,
          object: "chat.completion.chunk",
          created,
          model: modelId,
          choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
        });
      }
      res.end("data: [DONE]\n\n");
    },
    fail(error) {
      start();
      writeSSE(res, { error: { message: error.message, type: "error" } });
      res.end("data: [DONE]\n\n");
    },
  };
}

async function ensureBrowser() {
  keepBrowserAwake();
  if (context && workers.some((worker) => !worker.page.isClosed())) {
    scheduleBrowserIdleClose();
    return;
  }
  if (browserInitPromise) return browserInitPromise;

  browserInitPromise = (async () => {
    if (context) {
      await context.close().catch(() => {});
      context = null;
      page = null;
      workers = [];
      pendingByPage = new Map();
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
    workers = [{ id: 1, page, busy: false, modelId: null }];
    routeInstalled = false;
    if (!routeInstalled) {
      await context.route("**/*", handleRoute);
      routeInstalled = true;
    }
    await openPlayground(page, MODELS[DEFAULT_MODEL], false);
    scheduleBrowserIdleClose();
  })();

  try {
    await browserInitPromise;
    lastBrowserInitError = null;
  } catch (error) {
    lastBrowserInitError = error.message;
    throw error;
  } finally {
    browserInitPromise = null;
  }
}

async function playgroundControlsReady(targetPage) {
  return targetPage.evaluate(() => {
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

async function waitForPlaygroundReady(targetPage) {
  await dismissCookieBanner(targetPage);
  await targetPage.waitForFunction(() => document.readyState === "complete", null, { timeout: 60000 }).catch(() => {});
  await dismissCookieBanner(targetPage);
  await targetPage.waitForSelector('[data-testid="nv-text-area-element"], .nv-text-area-element, textarea', { timeout: 60000 });
  await targetPage.waitForFunction(() => {
    const input = document.querySelector('[data-testid="nv-text-area-element"]')
      || document.querySelector('.nv-text-area-element')
      || document.querySelector('textarea');
    const send = [...document.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Send");
    return input && send
      && !!(input.offsetWidth || input.offsetHeight || input.getClientRects().length)
      && !!(send.offsetWidth || send.offsetHeight || send.getClientRects().length);
  }, null, { timeout: 60000 });
  await dismissCookieBanner(targetPage);
}

async function openPlayground(targetPage, modelInfo, forceReload) {
  if (forceReload || !targetPage.url().startsWith(modelInfo.playgroundURL)) {
    await targetPage.goto(modelInfo.playgroundURL, { waitUntil: "load", timeout: 90000 });
  }
  await waitForPlaygroundReady(targetPage);
}

async function prepareWorker(worker, modelInfo) {
  if (!worker.page.url().startsWith(modelInfo.playgroundURL)) {
    await openPlayground(worker.page, modelInfo, true);
    worker.modelId = modelInfo.id;
    return;
  }
  if (await playgroundControlsReady(worker.page)) {
    worker.modelId = modelInfo.id;
    return;
  }
  await waitForPlaygroundReady(worker.page);
  worker.modelId = modelInfo.id;
}

async function handleRoute(route) {
  const request = route.request();
  const url = new URL(request.url());
  const host = url.hostname;
  const resourceType = request.resourceType();

  if (!isPredictURL(url)) {
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

  if (request.method() !== "POST") {
    await route.continue();
    return;
  }

  let requestPage = null;
  try {
    requestPage = request.frame().page();
  } catch {}

  const pending = requestPage ? pendingByPage.get(requestPage) : null;
  if (!pending) {
    await route.continue();
    return;
  }

  const originalPostData = request.postData() || "";
  if (pending.triggerText && !originalPostData.includes(pending.triggerText)) {
    await route.abort().catch(() => {});
    return;
  }
  pending.request = request;
  pending.url = request.url();
  pending.originalPostData = originalPostData;
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
  let timeout = null;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const upstream = await fetch(request.url(), {
      method: request.method(),
      headers: requestHeadersForFetch(request),
      body: pending.postData,
      signal: controller.signal,
    });

    if (upstream.status < 200 || upstream.status >= 300) {
      const body = await upstream.text();
      await route.fulfill({
        status: upstream.status,
        headers: responseHeadersForFulfill(upstream.headers),
        body,
      });
      pending.resolve({
        status: upstream.status,
        url: pending.url,
        mimeType: upstream.headers.get("content-type") || "",
        body,
      });
      return;
    }

    const bodyChunks = [];
    const decoder = new TextDecoder();
    const reader = upstream.body?.getReader();
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bodyChunks.push(Buffer.from(value));
        if (pending.streamForwarder) {
          pending.streamForwarder.write(decoder.decode(value, { stream: true }));
        }
      }
      const tail = decoder.decode();
      if (tail && pending.streamForwarder) pending.streamForwarder.write(tail);
    }
    const body = Buffer.concat(bodyChunks).toString("utf8");
    if (pending.streamForwarder) pending.streamForwarder.end();
    await route.fulfill({
      status: upstream.status,
      headers: responseHeadersForFulfill(upstream.headers),
      body,
    });
    pending.resolve({
      status: upstream.status,
      url: pending.url,
      mimeType: upstream.headers.get("content-type") || "",
      body,
    });
  } catch (error) {
    if (pending.streamForwarder && !pending.streamResponse?.writableEnded) pending.streamForwarder.fail(error);
    await route.abort().catch(() => {});
    pending.reject(error);
  } finally {
    if (timeout) clearTimeout(timeout);
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

async function elementCenter(targetPage, selectorExpression) {
  return targetPage.evaluate((expression) => {
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

async function sendButtonEnabled(targetPage, timeout = 3000) {
  try {
    await targetPage.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === "Send");
      return button && !button.disabled;
    }, null, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function dismissCookieBanner(targetPage) {
  const clickButton = async (selector, text) => {
    try {
      if (selector) {
        const el = await targetPage.$(selector);
        if (el) { await el.click().catch(() => {}); return true; }
      }
      if (text) {
        await targetPage.evaluate((t) => {
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
  await targetPage.waitForTimeout(2000);

  await clickButton(null, "Acknowledge & Continue");
  await targetPage.waitForTimeout(1000);
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

async function triggerPlaygroundRequest(worker, triggerText) {
  const targetPage = worker.page;
  await targetPage.bringToFront();
  const cdp = await context.newCDPSession(targetPage);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const inputPoint = await elementCenter(targetPage, `document.querySelector('[data-testid="nv-text-area-element"]') || document.querySelector('.nv-text-area-element') || document.querySelector('textarea')`);
    if (!inputPoint) throw new Error("textarea not found");

    await cdpClick(cdp, inputPoint);
    await cdpClearTextarea(cdp);
    await cdp.send("Input.insertText", { text: triggerText }).catch(() => {});
    if (await sendButtonEnabled(targetPage)) break;

    await cdpSetTextareaValue(cdp, triggerText);
    if (await sendButtonEnabled(targetPage)) break;

    if (attempt === 3) throw new Error("send button did not enable after CDP input");
    await targetPage.waitForTimeout(500);
  }

  const sendPoint = await elementCenter(targetPage, `[...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === 'Send')`);
  if (!sendPoint) throw new Error("send button not found");
  await cdpClick(cdp, sendPoint);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const pending = pendingByPage.get(targetPage);
  if (pending && !pending.request) await cdpClickSendFallback(cdp);
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

async function predict(postData, modelInfo, options = {}) {
  const worker = await acquireWorker();
  try {
    await prepareWorker(worker, modelInfo);

    const pending = {};
    const pendingId = randomID("predict");
    const triggerText = `bridge trigger ${pendingId}`;
    const responsePromise = new Promise((resolve, reject) => {
      Object.assign(pending, {
        id: pendingId,
        postData,
        triggerText,
        request: null,
        streamForwarder: options.streamResponse ? createOpenAIStreamForwarder(options.streamResponse, modelInfo.id) : null,
        streamResponse: options.streamResponse || null,
        resolve,
        reject,
      });
    });

    pendingByPage.set(worker.page, pending);
    try {
      await triggerPlaygroundRequest(worker, pending.triggerText);
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
    } catch (error) {
      pendingByPage.delete(worker.page);
      await openPlayground(worker.page, modelInfo, true).catch(() => {});
      throw error;
    }
  } finally {
    releaseWorker(worker);
  }
}

function healthStatus() {
  const browserReady = !!(context && page && !page.isClosed());
  const pending = [...pendingByPage.values()].map((item) => ({ id: item.id, matched: !!item.request }));
  return {
    service: "nvidia-playwright-proxy",
    status: lastBrowserInitError ? "degraded" : "ok",
    port: PORT,
    browserReady,
    pageURL: browserReady ? page.url() : null,
    workers: workers.map((worker) => ({ id: worker.id, busy: worker.busy, model: worker.modelId, pageURL: worker.page.isClosed() ? null : worker.page.url() })),
    pending,
    queued: workerQueue.length,
    active: activeWorkerCount(),
    lastBrowserInitError,
  };
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
    const sseText = await predict(JSON.stringify(payload), modelInfo, chatReq.stream ? { streamResponse: res } : {});
    if (!chatReq.stream) {
      const openAIResponse = convertSSEToResponse(sseText, modelInfo.id);
      sendJSON(res, 200, openAIResponse);
    }
  } catch (error) {
    if (res.headersSent || res.writableEnded) return;
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
  if (req.method === "GET" && url.pathname === "/healthz") {
    const health = healthStatus();
    sendJSON(res, health.lastBrowserInitError ? 503 : 200, health);
    return;
  }
  if (req.method === "GET" && url.pathname === "/debug/status") {
    if (!requireAPIKey(req, res)) return;
    const health = healthStatus();
    sendJSON(res, 200, {
      ...health,
      pageURL: page && !page.isClosed() ? page.url() : null,
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
  ensureBrowser().catch((error) => {
    lastBrowserInitError = error.message;
    console.error(`[nvidia-playwright-proxy] browser init failed: ${error.message}`);
  });
});

async function shutdown(signal) {
  console.log(`[nvidia-playwright-proxy] ${signal} received, shutting down`);
  await new Promise((resolve) => server.close(resolve));
  await context?.close().catch(() => {});
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
