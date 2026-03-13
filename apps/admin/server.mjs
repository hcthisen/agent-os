import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import http from "node:http";
import { extname, join, normalize } from "node:path";

const PORT = parseInt(process.env.PORT || "3000", 10);
const DIST_DIR = "/app/dist";
const POSTGREST_URL = (process.env.POSTGREST_URL || "http://rest:3000").replace(
  /\/+$/,
  ""
);
const ADMIN_PUBLIC_URL = (
  process.env.ADMIN_PUBLIC_URL ||
  process.env.SERVICE_URL_ADMIN ||
  ""
).replace(/\/+$/, "");
const SUPERVISOR_HEALTH_URL =
  process.env.SUPERVISOR_HEALTH_URL || "http://supervisor:3001/health";
const SUPERVISOR_API_URL = (process.env.SUPERVISOR_API_URL || "http://supervisor:3001").replace(
  /\/+$/,
  ""
);
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SESSION_SECRET = process.env.JWT_SECRET || "agent-os-admin";
const SESSION_COOKIE = "agent_os_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TELEGRAM_WEBHOOK_URL = (
  process.env.TELEGRAM_WEBHOOK_URL ||
  (ADMIN_PUBLIC_URL ? `${ADMIN_PUBLIC_URL}/api/integrations/telegram/webhook` : "")
).replace(/\/+$/, "");
const TELEGRAM_WEBHOOK_SECRET =
  process.env.TELEGRAM_WEBHOOK_SECRET ||
  (TELEGRAM_BOT_TOKEN
    ? createHmac("sha256", "agent-os-telegram-webhook")
        .update(TELEGRAM_BOT_TOKEN)
        .digest("hex")
    : "");
const DEFAULT_OPENAI_MODEL_MAP = {
  haiku: "gpt-5.4",
  opus: "gpt-5.4",
  sonnet: "gpt-5.4",
};
const DEFAULT_ANTHROPIC_ROLE_CONFIG = {
  architect: { effort: "high", model: "opus" },
  builder: { effort: "high", model: "opus" },
  relay: { effort: "medium", model: "haiku" },
  reviewer: { effort: "high", model: "opus" },
  sage: { effort: "high", model: "opus" },
  sentinel: { effort: "high", model: "sonnet" },
};
const DEFAULT_OPENAI_ROLE_CONFIG = {
  architect: { effort: "high", model: "gpt-5.4" },
  builder: { effort: "high", model: "gpt-5.4" },
  relay: { effort: "low", model: "gpt-5.4" },
  reviewer: { effort: "high", model: "gpt-5.4" },
  sage: { effort: "xhigh", model: "gpt-5.4" },
  sentinel: { effort: "medium", model: "gpt-5.3-codex" },
};
const RELAY_HISTORY_LIMIT = 15;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const TRANSIENT_FETCH_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

if (!SERVICE_KEY) {
  console.warn(
    "[admin] SUPABASE_SERVICE_KEY is missing; API routes will fail until init secrets are loaded."
  );
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendNoContent(res, headers = {}) {
  res.writeHead(204, headers);
  res.end();
}

function calculateNextRun(cronExpr) {
  const parts = String(cronExpr || "").trim().split(/\s+/);
  if (parts.length !== 5) {
    return new Date(Date.now() + 5 * 60 * 1000).toISOString();
  }

  const [minPart] = parts;
  if (minPart.startsWith("*/")) {
    const interval = parseInt(minPart.slice(2), 10);
    if (!Number.isNaN(interval) && interval > 0) {
      return new Date(Date.now() + interval * 60 * 1000).toISOString();
    }
  }

  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function setSessionCookie(res, username) {
  const payload = Buffer.from(
    JSON.stringify({
      exp: Date.now() + SESSION_TTL_MS,
      user: username,
    })
  ).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  const value = `${payload}.${signature}`;

  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${value}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${
      SESSION_TTL_MS / 1000
    }`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`
  );
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return raw.split(";").reduce((cookies, entry) => {
    const [name, ...rest] = entry.trim().split("=");
    if (!name) return cookies;
    cookies[name] = decodeURIComponent(rest.join("="));
    return cookies;
  }, {});
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  try {
    const provided = Buffer.from(signature);
    const actual = Buffer.from(expected);
    if (provided.length !== actual.length) return null;
    if (!timingSafeEqual(provided, actual)) return null;
  } catch {
    return null;
  }

  try {
    const session = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
    if (
      typeof session.exp !== "number" ||
      session.exp <= Date.now() ||
      typeof session.user !== "string" ||
      !session.user
    ) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientFetchError(error) {
  const code = error?.cause?.code || error?.code;
  return typeof code === "string" && TRANSIENT_FETCH_ERROR_CODES.has(code);
}

async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const attempts = retryOptions.attempts || 4;
  const baseDelayMs = retryOptions.baseDelayMs || 250;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;

      if (!isTransientFetchError(error) || attempt === attempts) {
        throw error;
      }

      await sleep(baseDelayMs * attempt);
    }
  }

  throw lastError || new Error("Fetch failed");
}

async function postgrest(path, options = {}) {
  const {
    body,
    headers = {},
    method = "GET",
    preferRepresentation = false,
    query = {},
  } = options;
  const url = new URL(path.replace(/^\/+/, ""), `${POSTGREST_URL}/`);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetchWithRetry(url, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...(body !== undefined
        ? { "Content-Type": "application/json; charset=utf-8" }
        : {}),
      ...(preferRepresentation ? { Prefer: "return=representation" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (method === "HEAD") {
    return response.headers.get("content-range");
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(
      data?.message || data?.hint || data?.details || response.statusText
    );
  }

  return data;
}

async function requireAuth(req, res) {
  if (!getSession(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

function normalizeRuntimeProviderValue(value) {
  const anthropicRoleConfig =
    value?.anthropicRoleConfig && typeof value.anthropicRoleConfig === "object"
      ? value.anthropicRoleConfig
      : {};
  const openaiModelMap =
    value?.openaiModelMap && typeof value.openaiModelMap === "object"
      ? value.openaiModelMap
      : {};
  const openaiRoleConfig =
    value?.openaiRoleConfig && typeof value.openaiRoleConfig === "object"
      ? value.openaiRoleConfig
      : {};

  return {
    activeProvider: value?.activeProvider === "openai" ? "openai" : "anthropic",
    anthropicRoleConfig: {
      ...DEFAULT_ANTHROPIC_ROLE_CONFIG,
      ...Object.fromEntries(
        Object.entries(anthropicRoleConfig)
          .map(([roleId, entry]) => {
            const model =
              typeof entry?.model === "string" ? entry.model.trim() : "";
            const effort = normalizeReasoningEffort(entry?.effort);

            if (!model) return null;
            return [roleId.toLowerCase(), { effort, model }];
          })
          .filter(Boolean)
      ),
    },
    openaiModelMap: {
      ...DEFAULT_OPENAI_MODEL_MAP,
      ...Object.fromEntries(
        Object.entries(openaiModelMap).filter(
          ([, mappedModel]) =>
            typeof mappedModel === "string" && mappedModel.trim()
        ).map(([tier, mappedModel]) => [tier.toLowerCase(), mappedModel.trim()])
      ),
    },
    openaiRoleConfig: {
      ...DEFAULT_OPENAI_ROLE_CONFIG,
      ...Object.fromEntries(
        Object.entries(openaiRoleConfig)
          .map(([roleId, entry]) => {
            const model =
              typeof entry?.model === "string" ? entry.model.trim() : "";
            const effort = normalizeReasoningEffort(entry?.effort);

            if (!model) return null;
            return [roleId.toLowerCase(), { effort, model }];
          })
          .filter(Boolean)
      ),
    },
  };
}

function normalizeReasoningEffort(value) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "medium";

  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }

  return "medium";
}

async function getRuntimeProviderSetting() {
  const rows = await postgrest("/system_settings", {
    query: {
      key: "eq.runtime_provider",
      limit: "1",
      select: "key,value,updated_at",
    },
  }).catch(() => []);

  return rows?.[0]
    ? {
        updated_at: rows[0].updated_at || null,
        ...normalizeRuntimeProviderValue(rows[0].value || {}),
      }
    : normalizeRuntimeProviderValue({});
}

async function saveRuntimeProviderSetting(nextValue) {
  const current = await postgrest("/system_settings", {
    query: {
      key: "eq.runtime_provider",
      limit: "1",
      select: "key",
    },
  }).catch(() => []);

  if (current?.[0]?.key) {
    await postgrest("/system_settings", {
      body: {
        updated_at: new Date().toISOString(),
        value: nextValue,
      },
      method: "PATCH",
      query: { key: "eq.runtime_provider" },
    });
    return;
  }

  await postgrest("/system_settings", {
    body: {
      key: "runtime_provider",
      updated_at: new Date().toISOString(),
      value: nextValue,
    },
    method: "POST",
  });
}

async function getSupervisorRuntimeProvider() {
  try {
    const response = await fetch(SUPERVISOR_HEALTH_URL);
    if (!response.ok) return null;
    const payload = await response.json();
    return payload.runtime_provider || null;
  } catch {
    return null;
  }
}

async function createRelayTaskForInboundMessage(message) {
  const title = `Process message: ${message.content.slice(0, 50)}...`;
  const objective = await buildRelayObjective(message);

  const rows = await postgrest("/tasks", {
    body: {
      acceptance_criteria: [
        "Message classified",
        "Appropriate action taken or task created",
        "Response sent",
      ],
      assigned_role: "relay",
      objective,
      priority: "high",
      state: "ready",
      title,
    },
    method: "POST",
    preferRepresentation: true,
  });

  return rows?.[0] || null;
}

async function buildRelayObjective(message) {
  const history = await loadRecentConversationMessages(message);
  const transcript = [...history, {
    content: message.content,
    created_at: new Date().toISOString(),
    direction: "inbound",
    sender: message.sender,
  }]
    .map(formatConversationMessage)
    .join("\n");

  return `Process this inbound message from ${message.sender} via ${message.channel}. Classify intent and route appropriately.

Current message:
${message.content}

Recent conversation transcript:
${transcript}

Routing reminders:
- If the request depends on a third-party service, account, API key, CDN, email provider, or similar credentialed integration, route to sage for a plan before builder implementation unless an approved plan already exists.
- If the message states a stable operator preference or constraint, record it as durable memory. Do not store secrets in memory.
- If the request creates or removes a public hostname, treat route activation or teardown plus external verification as required work, not optional follow-up.`;
}

function formatConversationMessage(message) {
  const timestamp = message.created_at
    ? new Date(message.created_at).toISOString()
    : "current";
  return `[${timestamp}] ${message.direction}/${message.sender}: ${message.content}`;
}

function shouldHideAdminMessage(message) {
  return (
    message?.sender === "system" ||
    message?.metadata?.hidden_from_operator === true ||
    message?.metadata?.operator_visible === false
  );
}

async function loadRecentConversationMessages(message) {
  const query = {
    channel: `eq.${message.channel}`,
    limit: String(RELAY_HISTORY_LIMIT),
    order: "created_at.desc",
    select: "id,direction,sender,content,created_at,metadata",
  };
  const chatId =
    message.channel === "telegram" &&
    (typeof message.chatId === "string" || typeof message.chatId === "number")
      ? message.chatId
      : null;

  if (message.currentMessageId) {
    query.id = `neq.${message.currentMessageId}`;
  }

  if (chatId !== null) {
    query.metadata = `cs.${JSON.stringify({ chat_id: chatId })}`;
  }

  try {
    const rows = await postgrest("/messages", { query });
    return Array.isArray(rows)
      ? [...rows]
          .filter((row) => !shouldHideAdminMessage(row))
          .reverse()
      : [];
  } catch (error) {
    console.error("[admin] Failed to load recent relay conversation history:", error);
    return [];
  }
}

async function callSupervisor(path, options = {}) {
  const { body, method = "GET" } = options;
  const response = await fetchWithRetry(`${SUPERVISOR_API_URL}${path}`, {
    method,
    headers:
      body === undefined
        ? undefined
        : { "Content-Type": "application/json; charset=utf-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(
      payload?.error || payload?.message || response.statusText || "Supervisor request failed"
    );
  }

  return payload;
}

async function loadLatestTaskActivityMap(taskIds) {
  const normalizedTaskIds = (Array.isArray(taskIds) ? taskIds : []).filter(
    (taskId) => typeof taskId === "string"
  );
  const activityMap = new Map();

  if (!normalizedTaskIds.length) {
    return activityMap;
  }

  const rows = await postgrest("/rpc/latest_task_activity", {
    body: {
      p_task_ids: normalizedTaskIds,
    },
    method: "POST",
  }).catch(() => []);

  for (const row of Array.isArray(rows) ? rows : []) {
    const taskId = typeof row?.scope_id === "string" ? row.scope_id : null;
    if (!taskId || activityMap.has(taskId)) {
      continue;
    }

    activityMap.set(taskId, {
      last_activity_at:
        typeof row?.created_at === "string" ? row.created_at : null,
      last_activity_summary:
        typeof row?.summary === "string" ? row.summary : null,
    });
  }

  return activityMap;
}

async function callTelegramApi(method, body) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    throw new Error(
      payload?.description || response.statusText || "Telegram request failed"
    );
  }

  return payload?.result ?? payload;
}

async function ensureTelegramWebhookRegistered() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log("[admin] Telegram integration disabled: TELEGRAM_BOT_TOKEN missing.");
    return;
  }

  if (!TELEGRAM_WEBHOOK_URL) {
    console.warn(
      "[admin] Telegram integration not registered: ADMIN_PUBLIC_URL / TELEGRAM_WEBHOOK_URL missing."
    );
    return;
  }

  try {
    const webhookInfo = await callTelegramApi("getWebhookInfo");
    if (webhookInfo?.url === TELEGRAM_WEBHOOK_URL) {
      console.log(`[admin] Telegram webhook already set to ${TELEGRAM_WEBHOOK_URL}`);
      return;
    }

    await callTelegramApi("setWebhook", {
      allowed_updates: ["message"],
      secret_token: TELEGRAM_WEBHOOK_SECRET,
      url: TELEGRAM_WEBHOOK_URL,
    });
    console.log(`[admin] Telegram webhook registered at ${TELEGRAM_WEBHOOK_URL}`);
  } catch (error) {
    console.error("[admin] Failed to register Telegram webhook:", error);
  }
}

async function handleTelegramWebhook(req, res) {
  if (!TELEGRAM_BOT_TOKEN) {
    sendJson(res, 503, { error: "Telegram integration is not configured" });
    return;
  }

  const providedSecret =
    req.headers["x-telegram-bot-api-secret-token"] || "";
  const expectedSecret = TELEGRAM_WEBHOOK_SECRET;

  if (expectedSecret && providedSecret !== expectedSecret) {
    sendJson(res, 401, { error: "Invalid Telegram webhook secret" });
    return;
  }

  const update = await readJson(req);
  const message = update?.message;

  if (!message?.text) {
    sendJson(res, 200, { ok: true, ignored: true });
    return;
  }

  const chatId = message.chat?.id;
  const fromUser =
    message.from?.first_name || message.from?.username || "unknown";
  const sender = `telegram:${fromUser}`;
  const content = String(message.text || "").trim();

  if (!content) {
    sendJson(res, 200, { ok: true, ignored: true });
    return;
  }

  let relayTask = null;
  let routing = "direct_relay_task";
  let routingError = null;

  try {
    relayTask = await createRelayTaskForInboundMessage({
      channel: "telegram",
      chatId,
      content,
      sender,
    });
  } catch (error) {
    routing = "fallback_poll";
    routingError = error instanceof Error ? error.message : String(error);
  }

  const telegramRows = await postgrest("/messages", {
    body: {
      channel: "telegram",
      content,
      direction: "inbound",
      metadata: {
        chat_id: chatId,
        from: message.from || null,
        message_id: message.message_id || null,
        relay_task_id: relayTask?.id || null,
        routing,
        routing_error: routingError,
        telegram_update_id: update?.update_id || null,
      },
      processed: routing !== "fallback_poll",
      sender,
      task_id: relayTask?.id || null,
    },
    method: "POST",
    preferRepresentation: true,
  });

  const sourceMessageId = telegramRows?.[0]?.id || null;

  await postgrest("/messages", {
    body: {
      channel: "admin_chat",
      content,
      direction: "inbound",
      metadata: {
        chat_id: chatId,
        mirrored_from: "telegram",
        relay_task_id: relayTask?.id || null,
        routing,
        routing_error: routingError,
        source_channel: "telegram",
        source_message_id: sourceMessageId,
        telegram_message_id: message.message_id || null,
      },
      processed: true,
      sender,
      task_id: relayTask?.id || null,
    },
    method: "POST",
  });

  sendJson(res, 200, {
    ok: true,
    relayTaskId: relayTask?.id || null,
    routed: routing === "direct_relay_task",
  });
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (pathname === "/api/integrations/telegram/webhook" && req.method === "POST") {
    await handleTelegramWebhook(req, res);
    return;
  }

  if (pathname === "/api/auth/session" && req.method === "GET") {
    const session = getSession(req);
    sendJson(res, 200, {
      authenticated: !!session,
      user: session?.user || null,
    });
    return;
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readJson(req);
    if (body.user === ADMIN_USER && body.pass === ADMIN_PASS) {
      setSessionCookie(res, body.user);
      sendJson(res, 200, { authenticated: true, user: body.user });
      return;
    }

    clearSessionCookie(res);
    sendJson(res, 401, { error: "Invalid credentials" });
    return;
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    clearSessionCookie(res);
    sendNoContent(res);
    return;
  }

  if (!(await requireAuth(req, res))) return;

  if (pathname === "/api/messages" && req.method === "GET") {
    const channel = searchParams.get("channel") || "admin_chat";
    const before = searchParams.get("before");
    const rawLimit = Number.parseInt(searchParams.get("limit") || "50", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(rawLimit, 200))
      : 50;
    const data = await postgrest("/messages", {
      query: {
        ...(before ? { created_at: `lt.${before}` } : {}),
        channel: `eq.${channel}`,
        limit: String(limit),
        order: "created_at.desc",
        select: "id,direction,sender,content,created_at,task_id,metadata",
      },
    });
    const visibleData =
      channel === "admin_chat" && Array.isArray(data)
        ? data.filter((message) => !shouldHideAdminMessage(message))
        : data || [];
    sendJson(
      res,
      200,
      Array.isArray(visibleData) ? [...visibleData].reverse() : visibleData
    );
    return;
  }

  if (pathname === "/api/messages" && req.method === "POST") {
    const body = await readJson(req);
    const content = typeof body.content === "string" ? body.content.trim() : "";

    if (!content) {
      sendJson(res, 400, { error: "Message content is required" });
      return;
    }

    let relayTask = null;

    try {
      relayTask = await createRelayTaskForInboundMessage({
        channel: "admin_chat",
        content,
        sender: "operator",
      });
    } catch (taskError) {
      await postgrest("/messages", {
        body: {
          channel: "admin_chat",
          content,
          direction: "inbound",
          metadata: {
            routing: "fallback_poll",
            routing_error:
              taskError instanceof Error ? taskError.message : String(taskError),
          },
          processed: false,
          sender: "operator",
        },
        method: "POST",
      });
      sendJson(res, 202, {
        queuedForPolling: true,
        relayTaskId: null,
      });
      return;
    }

    const rows = await postgrest("/messages", {
      body: {
        channel: "admin_chat",
        content,
        direction: "inbound",
        metadata: {
          relay_task_id: relayTask?.id || null,
          routing: "direct_relay_task",
        },
        processed: true,
        sender: "operator",
        task_id: relayTask?.id || null,
      },
      method: "POST",
      preferRepresentation: true,
    });

    sendJson(res, 200, {
      messageId: rows?.[0]?.id || null,
      relayTaskId: relayTask?.id || null,
    });
    return;
  }

  if (pathname === "/api/tasks" && req.method === "GET") {
    const state = searchParams.get("state");
    const before = searchParams.get("before");
    const rawLimit = Number.parseInt(searchParams.get("limit") || "50", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(rawLimit, 200))
      : 50;
    const data = await postgrest("/tasks", {
      query: {
        ...(before ? { created_at: `lt.${before}` } : {}),
        ...(state && state !== "all" ? { state: `eq.${state}` } : {}),
        limit: String(limit),
        order: "created_at.desc",
        select:
          "id,title,state,priority,assigned_role,claimed_by,attempt_count,last_handoff_note,created_at,updated_at,blocked_reason,parent_task_id",
      },
    });
    const activityMap = await loadLatestTaskActivityMap(
      Array.isArray(data) ? data.map((task) => task.id) : []
    );
    const tasksWithActivity = Array.isArray(data)
      ? data.map((task) => ({
          ...task,
          ...(activityMap.get(task.id) || {
            last_activity_at: null,
            last_activity_summary: null,
          }),
        }))
      : [];
    sendJson(res, 200, tasksWithActivity);
    return;
  }

  if (pathname === "/api/approvals" && req.method === "GET") {
    const data = await postgrest("/approvals", {
      query: {
        limit: "100",
        order: "created_at.desc",
        select: "id,task_id,action_type,description,status,created_at",
        status: "eq.pending",
      },
    });
    sendJson(res, 200, data || []);
    return;
  }

  const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
  if (approvalMatch && req.method === "POST") {
    const [, approvalId] = approvalMatch;
    const body = await readJson(req);
    const decision = body.decision === "approved" ? "approved" : "rejected";
    const approvals = await postgrest("/approvals", {
      query: {
        id: `eq.${approvalId}`,
        limit: "1",
        select: "id,task_id,action_type,description,status",
      },
    });
    const approval = approvals?.[0];

    if (!approval) {
      sendJson(res, 404, { error: "Approval not found" });
      return;
    }

    await postgrest("/approvals", {
      body: {
        decided_at: new Date().toISOString(),
        decided_by: "operator",
        status: decision,
      },
      method: "PATCH",
      query: { id: `eq.${approvalId}` },
    });

    if (decision === "approved") {
      await postgrest("/tasks", {
        body: {
          blocked_reason: null,
          last_handoff_note: `Approval granted for ${approval.action_type}: ${approval.description}`,
          state: "ready",
        },
        method: "PATCH",
        query: { id: `eq.${approval.task_id}` },
      });
    } else {
      await postgrest("/tasks", {
        body: {
          blocked_reason: `Approval rejected for ${approval.action_type}`,
          last_handoff_note: `Approval rejected for ${approval.action_type}: ${approval.description}`,
          state: "failed",
        },
        method: "PATCH",
        query: { id: `eq.${approval.task_id}` },
      });
    }

    sendNoContent(res);
    return;
  }

  const retryMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/retry$/);
  if (retryMatch && req.method === "POST") {
    const [, taskId] = retryMatch;
    await postgrest("/tasks", {
      body: {
        attempt_count: 0,
        last_handoff_note: "Manually retried by operator.",
        state: "ready",
      },
      method: "PATCH",
      query: { id: `eq.${taskId}` },
    });
    sendNoContent(res);
    return;
  }

  if (pathname === "/api/agents" && req.method === "GET") {
    const data = await postgrest("/agents", {
      query: { order: "name.asc", select: "*" },
    });
    sendJson(res, 200, data || []);
    return;
  }

  if (pathname === "/api/roles" && req.method === "GET") {
    const data = await postgrest("/roles", {
      query: { order: "id.asc", select: "*" },
    });
    sendJson(res, 200, data || []);
    return;
  }

  if (pathname === "/api/memories" && req.method === "GET") {
    const query = searchParams.get("q");
    const before = searchParams.get("before");
    const rawLimit = Number.parseInt(searchParams.get("limit") || "50", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(rawLimit, 200))
      : 50;
    const data = await postgrest("/memories", {
      query: {
        ...(before ? { created_at: `lt.${before}` } : {}),
        ...(query ? { subject: `ilike.*${query}*` } : {}),
        is_active: "eq.true",
        limit: String(limit),
        order: "created_at.desc",
        select: "*",
      },
    });
    sendJson(res, 200, data || []);
    return;
  }

  const expireMatch = pathname.match(/^\/api\/memories\/([^/]+)\/expire$/);
  if (expireMatch && req.method === "POST") {
    const [, memoryId] = expireMatch;
    await postgrest("/memories", {
      body: { is_active: false },
      method: "PATCH",
      query: { id: `eq.${memoryId}` },
    });
    sendNoContent(res);
    return;
  }

  if (pathname === "/api/events" && req.method === "GET") {
    const before = searchParams.get("before");
    const rawLimit = Number.parseInt(searchParams.get("limit") || "50", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(rawLimit, 200))
      : 50;
    const data = await postgrest("/events", {
      query: {
        ...(before ? { created_at: `lt.${before}` } : {}),
        limit: String(limit),
        order: "created_at.desc",
        select: "*",
      },
    });
    sendJson(res, 200, data || []);
    return;
  }

  if (pathname === "/api/services" && req.method === "GET") {
    const data = await postgrest("/service_registry", {
      query: {
        order: "service_name.asc",
        select:
          "id,service_name,display_name,description,status,error_message,last_verified",
      },
    });
    sendJson(res, 200, data || []);
    return;
  }

  const serviceMatch = pathname.match(/^\/api\/services\/([^/]+)\/credential$/);
  if (serviceMatch && req.method === "POST") {
    const [, serviceId] = serviceMatch;
    const body = await readJson(req);
    await postgrest("/service_registry", {
      body: {
        credential: body.credential,
        last_verified: new Date().toISOString(),
        status: "active",
      },
      method: "PATCH",
      query: { id: `eq.${serviceId}` },
    });
    sendNoContent(res);
    return;
  }

  if (pathname === "/api/runtime/provider" && req.method === "GET") {
    const [setting, supervisorRuntime] = await Promise.all([
      getRuntimeProviderSetting(),
      getSupervisorRuntimeProvider(),
    ]);

    sendJson(res, 200, {
      activeProvider: setting.activeProvider,
      anthropicRoleConfig: setting.anthropicRoleConfig,
      openaiModelMap: setting.openaiModelMap,
      openaiRoleConfig: setting.openaiRoleConfig,
      providerStatus: supervisorRuntime?.providers || null,
      supervisorActiveProvider:
        supervisorRuntime?.activeProvider || setting.activeProvider,
      updatedAt: setting.updated_at || null,
    });
    return;
  }

  if (pathname === "/api/runtime/provider" && req.method === "POST") {
    const body = await readJson(req);
    const nextValue = normalizeRuntimeProviderValue(body || {});
    await saveRuntimeProviderSetting(nextValue);
    sendJson(res, 200, nextValue);
    return;
  }

  if (pathname === "/api/runtime/provider/openai/device-auth" && req.method === "GET") {
    const payload = await callSupervisor("/provider-auth/openai/device-auth");
    sendJson(res, 200, payload || {});
    return;
  }

  if (
    pathname === "/api/runtime/provider/openai/device-auth/start" &&
    req.method === "POST"
  ) {
    const payload = await callSupervisor("/provider-auth/openai/device-auth/start", {
      method: "POST",
    });
    sendJson(res, 200, payload || {});
    return;
  }

  if (
    pathname === "/api/runtime/provider/openai/device-auth/cancel" &&
    req.method === "POST"
  ) {
    const payload = await callSupervisor("/provider-auth/openai/device-auth/cancel", {
      method: "POST",
    });
    sendJson(res, 200, payload || {});
    return;
  }

  if (pathname === "/api/schedules" && req.method === "GET") {
    const data = await postgrest("/schedules", {
      query: { order: "name.asc", select: "*" },
    });
    sendJson(res, 200, data || []);
    return;
  }

  const scheduleMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/toggle$/);
  if (scheduleMatch && req.method === "POST") {
    const [, scheduleId] = scheduleMatch;
    const body = await readJson(req);
    await postgrest("/schedules", {
      body: { enabled: !!body.enabled },
      method: "PATCH",
      query: { id: `eq.${scheduleId}` },
    });
    sendNoContent(res);
    return;
  }

  const scheduleUpdateMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (scheduleUpdateMatch && req.method === "POST") {
    const [, scheduleId] = scheduleUpdateMatch;
    const body = await readJson(req);
    const update = {};

    if (typeof body.enabled === "boolean") {
      update.enabled = body.enabled;
    }

    if (typeof body.cron_expr === "string" && body.cron_expr.trim()) {
      update.cron_expr = body.cron_expr.trim();
      update.next_run_at = calculateNextRun(body.cron_expr);
    }

    await postgrest("/schedules", {
      body: update,
      method: "PATCH",
      query: { id: `eq.${scheduleId}` },
    });
    sendNoContent(res);
    return;
  }

  if (pathname === "/api/system/health" && req.method === "GET") {
    const [healthResponse, ready, blocked, deadLetter] = await Promise.all([
      fetch(SUPERVISOR_HEALTH_URL).then(async (response) =>
        response.ok ? response.json() : { status: "error" }
      ),
      postgrest("/tasks", {
        headers: { Prefer: "count=exact" },
        method: "HEAD",
        query: { state: "eq.ready" },
      }).catch(() => null),
      postgrest("/tasks", {
        headers: { Prefer: "count=exact" },
        method: "HEAD",
        query: { state: "eq.blocked_on_human" },
      }).catch(() => null),
      postgrest("/tasks", {
        headers: { Prefer: "count=exact" },
        method: "HEAD",
        query: { state: "eq.dead_letter" },
      }).catch(() => null),
    ]);

    sendJson(res, 200, {
      supervisor: healthResponse,
      summary: {
        blocked_on_human: blocked,
        dead_letter: deadLetter,
        ready,
      },
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(res, pathname) {
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const requestedPath =
    safePath === "/" ? join(DIST_DIR, "index.html") : join(DIST_DIR, safePath);
  const assetRequest = safePath.startsWith("/assets/");

  try {
    await access(requestedPath);
    const mimeType = MIME_TYPES[extname(requestedPath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mimeType });
    createReadStream(requestedPath).pipe(res);
    return;
  } catch {
    if (assetRequest) {
      res.writeHead(404);
      res.end();
      return;
    }
  }

  res.writeHead(200, { "Content-Type": MIME_TYPES[".html"] });
  createReadStream(join(DIST_DIR, "index.html")).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    console.error("[admin] Request failed:", error);
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

server.listen(PORT, () => {
  console.log(`[admin] Server listening on port ${PORT}`);
  void ensureTelegramWebhookRegistered();
});
