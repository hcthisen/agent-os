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
const LOGIN_RATE_LIMIT = { max: 10, windowMs: 60 * 1000 };
const API_RATE_LIMIT = { max: 100, windowMs: 60 * 1000 };
const STREAM_REFRESH_MS = 2000;
const MODEL_OPTIONS = new Set(["haiku", "sonnet", "opus"]);
const EFFORT_OPTIONS = new Set(["low", "medium", "high", "xhigh"]);
const AGENT_STATUS_OPTIONS = new Set(["active", "paused", "disabled"]);
const MEMORY_LAYER_OPTIONS = new Set(["episodic", "semantic", "procedural"]);
const TASK_PRIORITY_OPTIONS = new Set(["low", "normal", "high", "critical"]);
const SCOPE_TYPE_OPTIONS = new Set([
  "task",
  "project",
  "customer",
  "role",
  "department",
  "company",
]);
const SKILL_TAG = "skill";
const SKILL_DRAFT_STATUS_OPTIONS = new Set([
  "pending",
  "confirmed",
  "rejected",
  "expired",
]);
const KNOWLEDGE_BASE_TAGS = new Set([
  "operator-preference",
  "operator-taught",
  "operator-training",
  "operator_preference",
  "operator_taught",
  "operator_training",
]);
const rateLimitBuckets = new Map();
const streamClients = new Set();
let streamHeartbeatCounter = 0;
let streamIntervalHandle = null;
let streamLastSignature = "";
let streamRefreshInFlight = null;

function startOfDayIso(value) {
  return value ? `${value}T00:00:00.000Z` : null;
}

function endOfDayIso(value) {
  return value ? `${value}T23:59:59.999Z` : null;
}

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

function getRateLimitKey(req, scope) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const remoteAddress = req.socket?.remoteAddress || "unknown";
  return `${scope}:${forwarded || remoteAddress}`;
}

function isRateLimited(key, options) {
  const now = Date.now();
  const existing = rateLimitBuckets.get(key);
  const bucket =
    existing && now - existing.startedAt < options.windowMs
      ? existing
      : { count: 0, startedAt: now };
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  return bucket.count > options.max;
}

function normalizeString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeStringArray(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => normalizeString(entry))
      .filter(Boolean)
  )];
}

function isKnowledgeBaseMemory(memory) {
  if (!memory || typeof memory !== "object") {
    return false;
  }

  if (memory.source_agent_id === null) {
    return true;
  }

  return normalizeStringArray(memory.tags).some((tag) =>
    KNOWLEDGE_BASE_TAGS.has(tag.toLowerCase())
  );
}

function splitKnowledgeImportContent(content, splitMode) {
  const normalized = normalizeString(content);
  if (!normalized) {
    return [];
  }

  const chunks =
    splitMode === "sentence"
      ? normalized
          .split(/(?<=[.!?])\s+/)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length >= 12)
      : normalized
          .split(/\n\s*\n+/)
          .map((entry) => entry.replace(/\s+/g, " ").trim())
          .filter((entry) => entry.length >= 20);

  return [...new Set(chunks)].slice(0, 100);
}

function deriveImportedMemorySubject(content, subjectPrefix, index) {
  const prefix = normalizeString(subjectPrefix);
  if (prefix) {
    return `${prefix} ${index + 1}`;
  }

  const firstLine = content
    .split(/\r?\n/, 1)[0]
    .replace(/^[\-\*\d\.\)\s]+/, "")
    .trim();
  const compact = firstLine.replace(/\s+/g, " ");
  if (!compact) {
    return `Imported memory ${index + 1}`;
  }

  if (compact.length <= 72) {
    return compact;
  }

  return `${compact.slice(0, 69).trimEnd()}...`;
}

function safeJsonParse(value, fallback = {}) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseSkillMemory(memory) {
  const payload = safeJsonParse(memory.content, {});
  return {
    id: memory.id,
    name: String(memory.subject || "").replace(/^skill:/, ""),
    display_name: normalizeString(payload.display_name) || normalizeString(memory.subject),
    description: normalizeString(payload.description),
    trigger_when: normalizeString(payload.trigger_when),
    steps: Array.isArray(payload.steps)
      ? payload.steps.map((step, index) => ({
          instruction: normalizeString(step?.instruction),
          order: Number(step?.order || index + 1),
          required: step?.required !== false,
          tool_hint: normalizeString(step?.tool_hint) || null,
        }))
      : [],
    input_schema:
      payload.input_schema && typeof payload.input_schema === "object"
        ? payload.input_schema
        : {},
    output_schema:
      payload.output_schema && typeof payload.output_schema === "object"
        ? payload.output_schema
        : {},
    required_services: normalizeStringArray(payload.required_services),
    scope_type: memory.scope_type,
    scope_id: memory.scope_id,
    tags: normalizeStringArray(memory.tags),
    version: Math.max(1, Number(payload.version || 1)),
    last_used_at:
      typeof payload.last_used_at === "string" && payload.last_used_at.trim()
        ? payload.last_used_at
        : null,
    use_count: Math.max(0, Number(payload.use_count || 0)),
    is_active: memory.is_active,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
    superseded_by: memory.superseded_by || null,
    memory_subject: memory.subject,
    source_agent_id: memory.source_agent_id || null,
  };
}

function buildSkillContent(payload, version) {
  return JSON.stringify(
    {
      description: normalizeString(payload.description),
      display_name:
        normalizeString(payload.display_name) ||
        normalizeString(payload.name).replace(/-/g, " "),
      input_schema:
        payload.input_schema && typeof payload.input_schema === "object"
          ? payload.input_schema
          : {},
      last_used_at: payload.last_used_at || null,
      output_schema:
        payload.output_schema && typeof payload.output_schema === "object"
          ? payload.output_schema
          : {},
      required_services: normalizeStringArray(payload.required_services),
      steps: (Array.isArray(payload.steps) ? payload.steps : [])
        .map((step, index) => ({
          instruction: normalizeString(step?.instruction),
          order: Number(step?.order || index + 1),
          required: step?.required !== false,
          tool_hint: normalizeString(step?.tool_hint) || null,
        }))
        .filter((step) => step.instruction),
      trigger_when: normalizeString(payload.trigger_when),
      use_count: Math.max(0, Number(payload.use_count || 0)),
      version,
    },
    null,
    2
  );
}

function buildSkillChunkContent(payload) {
  const steps = (Array.isArray(payload.steps) ? payload.steps : [])
    .map((step, index) => ({
      instruction: normalizeString(step?.instruction),
      order: Number(step?.order || index + 1),
      tool_hint: normalizeString(step?.tool_hint) || null,
    }))
    .filter((step) => step.instruction);

  return [
    `Skill: ${normalizeString(payload.display_name) || normalizeString(payload.name)}`,
    normalizeString(payload.description)
      ? `Description: ${normalizeString(payload.description)}`
      : null,
    normalizeString(payload.trigger_when)
      ? `Trigger: ${normalizeString(payload.trigger_when)}`
      : null,
    steps.length
      ? `Steps: ${steps
          .map(
            (step) =>
              `${step.order}. ${step.instruction}${step.tool_hint ? ` (tool hint: ${step.tool_hint})` : ""}`
          )
          .join(" ")}`
      : null,
    normalizeStringArray(payload.required_services).length
      ? `Required services: ${normalizeStringArray(payload.required_services).join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function upsertMemoryChunk(memoryId, scopeType, scopeId, content) {
  const existing = await postgrest("/memory_chunks", {
    query: {
      limit: "1",
      select: "id",
      source_id: `eq.${memoryId}`,
      source_type: "eq.memory",
    },
  });

  if (existing?.[0]?.id) {
    await postgrest("/memory_chunks", {
      body: { content, scope_id: scopeId, scope_type: scopeType },
      method: "PATCH",
      query: { id: `eq.${existing[0].id}` },
    });
    return;
  }

  await postgrest("/memory_chunks", {
    body: {
      content,
      scope_id: scopeId,
      scope_type: scopeType,
      source_id: memoryId,
      source_type: "memory",
    },
    method: "POST",
  });
}

async function loadTaskRuns(taskId) {
  const runs = await postgrest("/task_runs", {
    query: {
      order: "started_at.desc",
      select:
        "id,task_id,agent_id,trace_id,status,context_pack,outcome,handoff_note,model_used,effort_used,error_message,started_at,finished_at,created_at",
      task_id: `eq.${taskId}`,
    },
  });
  const agentIds = [...new Set((runs || []).map((run) => run.agent_id).filter(Boolean))];
  const agents = agentIds.length
    ? await postgrest("/agents", {
        query: {
          id: `in.(${agentIds.join(",")})`,
          select: "id,name",
        },
      })
    : [];
  const agentMap = new Map((agents || []).map((agent) => [agent.id, agent.name]));
  return (runs || []).map((run) => ({
    ...run,
    agent_name: agentMap.get(run.agent_id) || null,
    duration_ms:
      run.finished_at && run.started_at
        ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
        : null,
  }));
}

async function loadMessagesFeed(options = {}) {
  const channel = normalizeString(options.channel, "admin_chat") || "admin_chat";
  const before = normalizeString(options.before);
  const rawLimit = Number.parseInt(String(options.limit || "50"), 10);
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

  return Array.isArray(visibleData) ? [...visibleData].reverse() : visibleData;
}

async function loadTasksFeed(options = {}) {
  const state = normalizeString(options.state);
  const before = normalizeString(options.before);
  const projectId = normalizeString(options.projectId);
  const queryText = normalizeString(options.queryText);
  const rawLimit = Number.parseInt(String(options.limit || "50"), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(rawLimit, 200))
    : 50;
  const data = await postgrest("/tasks", {
    query: {
      ...(before ? { created_at: `lt.${before}` } : {}),
      ...(projectId ? { project_id: `eq.${projectId}` } : {}),
      ...(queryText
        ? { or: `(title.ilike.*${queryText}*,objective.ilike.*${queryText}*)` }
        : {}),
      ...(state && state !== "all" ? { state: `eq.${state}` } : {}),
      limit: String(limit),
      order: "created_at.desc",
      select:
        "id,title,objective,acceptance_criteria,state,priority,assigned_role,claimed_by,attempt_count,last_handoff_note,created_at,updated_at,blocked_reason,parent_task_id,project_id,due_at",
    },
  });
  const activityMap = await loadLatestTaskActivityMap(
    Array.isArray(data) ? data.map((task) => task.id) : []
  );

  return Array.isArray(data)
    ? data.map((task) => ({
        ...task,
        ...(activityMap.get(task.id) || {
          last_activity_at: null,
          last_activity_summary: null,
        }),
      }))
    : [];
}

async function loadLiveActivity() {
  const tasks = await postgrest("/tasks", {
    query: {
      limit: "12",
      order: "updated_at.desc",
      select:
        "id,title,state,assigned_role,claimed_by,created_at,updated_at",
      state: "in.(claimed,running,blocked_on_agent,in_review)",
    },
  }).catch(() => []);

  const taskList = Array.isArray(tasks) ? tasks : [];
  const taskIds = taskList.map((task) => task.id);
  const agentIds = [...new Set(taskList.map((task) => task.claimed_by).filter(Boolean))];
  const [activityMap, agents, taskRuns] = await Promise.all([
    loadLatestTaskActivityMap(taskIds),
    agentIds.length
      ? postgrest("/agents", {
          query: {
            id: `in.(${agentIds.join(",")})`,
            select: "id,name",
          },
        }).catch(() => [])
      : [],
    taskIds.length
      ? postgrest("/task_runs", {
          query: {
            limit: "50",
            order: "started_at.desc",
            select: "task_id,started_at,status",
            task_id: `in.(${taskIds.join(",")})`,
          },
        }).catch(() => [])
      : [],
  ]);
  const agentMap = new Map((agents || []).map((agent) => [agent.id, agent.name]));
  const runMap = new Map();
  for (const run of taskRuns || []) {
    if (!run?.task_id || runMap.has(run.task_id)) {
      continue;
    }
    runMap.set(run.task_id, run);
  }

  return taskList.map((task) => {
    const activity = activityMap.get(task.id) || null;
    const latestRun = runMap.get(task.id) || null;
    return {
      agent_id: task.claimed_by || null,
      agent_name: task.claimed_by ? agentMap.get(task.claimed_by) || null : null,
      last_activity_at: activity?.created_at || null,
      last_activity_summary: activity?.summary || null,
      role_id: task.assigned_role,
      started_at: latestRun?.started_at || null,
      task_id: task.id,
      task_state: task.state,
      task_title: task.title,
    };
  });
}

async function buildAdminStreamSnapshot() {
  const [messages, tasks, liveActivity] = await Promise.all([
    loadMessagesFeed({ channel: "admin_chat", limit: 50 }),
    loadTasksFeed({ limit: 50 }),
    loadLiveActivity(),
  ]);

  return {
    generated_at: new Date().toISOString(),
    live_activity: liveActivity,
    messages,
    tasks,
  };
}

function sendSseMessage(res, eventName, payload) {
  const json = JSON.stringify(payload);
  res.write(`event: ${eventName}\n`);
  for (const line of json.split("\n")) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n");
}

async function refreshAdminStream(force = false) {
  if (!streamClients.size) {
    return;
  }

  if (streamRefreshInFlight) {
    await streamRefreshInFlight;
    return;
  }

  streamRefreshInFlight = (async () => {
    try {
      const snapshot = await buildAdminStreamSnapshot();
      const signature = JSON.stringify({
        live_activity: snapshot.live_activity,
        messages: snapshot.messages,
        tasks: snapshot.tasks,
      });

      if (!force && signature === streamLastSignature) {
        streamHeartbeatCounter += 1;
        if (streamHeartbeatCounter >= 5) {
          for (const client of [...streamClients]) {
            client.write(": keep-alive\n\n");
          }
          streamHeartbeatCounter = 0;
        }
        return;
      }

      streamLastSignature = signature;
      streamHeartbeatCounter = 0;
      for (const client of [...streamClients]) {
        sendSseMessage(client, "snapshot", snapshot);
      }
    } catch (error) {
      console.error("[admin] Failed to refresh SSE stream:", error);
    } finally {
      streamRefreshInFlight = null;
    }
  })();

  await streamRefreshInFlight;
}

function ensureAdminStreamLoop() {
  if (streamIntervalHandle || !streamClients.size) {
    return;
  }

  streamIntervalHandle = setInterval(() => {
    void refreshAdminStream(false);
  }, STREAM_REFRESH_MS);
}

function maybeStopAdminStreamLoop() {
  if (streamClients.size || !streamIntervalHandle) {
    return;
  }

  clearInterval(streamIntervalHandle);
  streamIntervalHandle = null;
  streamLastSignature = "";
  streamHeartbeatCounter = 0;
}

async function addAdminStreamClient(res) {
  streamClients.add(res);
  ensureAdminStreamLoop();
  await refreshAdminStream(true);
}

function removeAdminStreamClient(res) {
  streamClients.delete(res);
  maybeStopAdminStreamLoop();
}

async function loadProjectsWithStats() {
  const [projects, tasks, artifacts] = await Promise.all([
    postgrest("/projects", { query: { order: "display_name.asc", select: "*" } }),
    postgrest("/tasks", {
      query: { limit: "500", order: "created_at.desc", select: "id,project_id,state" },
    }),
    postgrest("/artifacts", {
      query: { limit: "500", order: "created_at.desc", select: "id,project_id" },
    }),
  ]);

  const taskCounts = new Map();
  const activeTaskCounts = new Map();
  for (const task of tasks || []) {
    if (!task.project_id) continue;
    taskCounts.set(task.project_id, (taskCounts.get(task.project_id) || 0) + 1);
    if (!["completed", "failed", "dead_letter"].includes(task.state)) {
      activeTaskCounts.set(
        task.project_id,
        (activeTaskCounts.get(task.project_id) || 0) + 1
      );
    }
  }

  const artifactCounts = new Map();
  for (const artifact of artifacts || []) {
    if (!artifact.project_id) continue;
    artifactCounts.set(
      artifact.project_id,
      (artifactCounts.get(artifact.project_id) || 0) + 1
    );
  }

  return (projects || []).map((project) => ({
    ...project,
    active_task_count: activeTaskCounts.get(project.id) || 0,
    artifact_count: artifactCounts.get(project.id) || 0,
    task_count: taskCounts.get(project.id) || 0,
  }));
}

async function buildUsageSummary() {
  const now = Date.now();
  const taskRuns = await postgrest("/task_runs", {
    query: {
      limit: "500",
      order: "started_at.desc",
      select: "id,task_id,model_used,started_at,finished_at",
    },
  });
  const taskIds = [...new Set((taskRuns || []).map((run) => run.task_id).filter(Boolean))];
  const tasks = taskIds.length
    ? await postgrest("/tasks", {
        query: {
          id: `in.(${taskIds.join(",")})`,
          select: "id,assigned_role",
        },
      })
    : [];
  const taskMap = new Map((tasks || []).map((task) => [task.id, task.assigned_role]));

  function summarizeWindow(startMs) {
    const runs = (taskRuns || []).filter(
      (run) => new Date(run.started_at).getTime() >= startMs
    );
    const runsPerRole = new Map();
    const modelDistribution = new Map();
    for (const run of runs) {
      const roleId = taskMap.get(run.task_id) || "unknown";
      const durationMs =
        run.finished_at && run.started_at
          ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
          : null;
      const current = runsPerRole.get(roleId) || { durationSum: 0, durationCount: 0, run_count: 0 };
      current.run_count += 1;
      if (durationMs !== null) {
        current.durationSum += durationMs;
        current.durationCount += 1;
      }
      runsPerRole.set(roleId, current);
      modelDistribution.set(run.model_used, (modelDistribution.get(run.model_used) || 0) + 1);
    }

    return {
      model_distribution: [...modelDistribution.entries()].map(([model, count]) => ({
        count,
        model,
      })),
      run_count: runs.length,
      runs_per_role: [...runsPerRole.entries()].map(([role_id, value]) => ({
        average_duration_ms:
          value.durationCount > 0 ? Math.round(value.durationSum / value.durationCount) : null,
        role_id,
        run_count: value.run_count,
      })),
    };
  }

  const providerUsageEvents = await postgrest("/events", {
    query: {
      event_type: "eq.provider.usage",
      limit: "500",
      order: "created_at.desc",
      select: "detail",
    },
  }).catch(() => []);
  const providerUsageMap = new Map();

  for (const event of providerUsageEvents || []) {
    const detail = event?.detail && typeof event.detail === "object" ? event.detail : {};
    const provider = normalizeString(detail.provider || detail.vendor || "unknown");
    const totalTokens = Number(detail.total_tokens || detail.prompt_tokens || 0) || 0;
    const estimatedCostRaw = detail.estimated_cost_usd;
    const estimatedCost =
      typeof estimatedCostRaw === "number"
        ? estimatedCostRaw
        : typeof estimatedCostRaw === "string" && estimatedCostRaw.trim()
          ? Number(estimatedCostRaw)
          : null;
    const current = providerUsageMap.get(provider) || {
      estimated_cost_known: true,
      estimated_cost_usd: 0,
      event_count: 0,
      provider,
      total_tokens: 0,
    };

    current.event_count += 1;
    current.total_tokens += totalTokens;

    if (estimatedCost === null || Number.isNaN(estimatedCost)) {
      current.estimated_cost_known = false;
    } else if (current.estimated_cost_known) {
      current.estimated_cost_usd += estimatedCost;
    }

    providerUsageMap.set(provider, current);
  }

  const providerUsage = [...providerUsageMap.values()]
    .map((entry) => ({
      estimated_cost_usd: entry.estimated_cost_known ? entry.estimated_cost_usd : null,
      event_count: entry.event_count,
      provider: entry.provider,
      total_tokens: entry.total_tokens,
    }))
    .sort((left, right) => right.total_tokens - left.total_tokens);
  const knownCosts = providerUsage.filter((entry) => entry.estimated_cost_usd !== null);

  const recentArtifacts = await postgrest("/artifacts", {
    query: {
      limit: "8",
      order: "created_at.desc",
      select: "id,name,artifact_type,task_id,project_id,created_at,external_url,storage_path,metadata",
    },
  });
  const recentProjects = (await loadProjectsWithStats()).slice(0, 6);

  return {
    provider_usage: {
      estimated_cost_usd:
        knownCosts.length === providerUsage.length
          ? knownCosts.reduce((total, entry) => total + (entry.estimated_cost_usd || 0), 0)
          : null,
      event_count: providerUsage.reduce((total, entry) => total + entry.event_count, 0),
      providers: providerUsage,
      total_tokens: providerUsage.reduce((total, entry) => total + entry.total_tokens, 0),
    },
    recent_artifacts: recentArtifacts || [],
    recent_projects: recentProjects,
    task_runs: {
      month: summarizeWindow(now - 30 * 24 * 60 * 60 * 1000),
      today: summarizeWindow(now - 24 * 60 * 60 * 1000),
      week: summarizeWindow(now - 7 * 24 * 60 * 60 * 1000),
    },
  };
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

function normalizeAgentRoleBaseId(name) {
  const normalized = normalizeString(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized || "agent";
}

function buildRoleProfilePatch(body, options = {}) {
  const patch = {};
  const displayNameFallback = normalizeString(options.displayNameFallback);

  if (typeof body.display_name === "string") {
    patch.display_name = body.display_name.trim();
  } else if (displayNameFallback) {
    patch.display_name = displayNameFallback;
  }

  for (const field of [
    "description",
    "handoff_when",
    "policy_doc",
    "usage_summary",
  ]) {
    if (typeof body[field] === "string") {
      patch[field] = body[field].trim();
    }
  }

  if (typeof body.model === "string" && MODEL_OPTIONS.has(body.model.trim())) {
    patch.model = body.model.trim();
  } else if (options.requireCreate) {
    patch.model = "sonnet";
  }

  if (typeof body.effort === "string" && EFFORT_OPTIONS.has(body.effort.trim())) {
    patch.effort = body.effort.trim();
  } else if (options.requireCreate) {
    patch.effort = "medium";
  }

  if (body.max_concurrent_tasks !== undefined) {
    patch.max_concurrent_tasks = Math.max(1, Number(body.max_concurrent_tasks || 1));
  } else if (options.requireCreate) {
    patch.max_concurrent_tasks = 3;
  }

  if (options.requireCreate) {
    patch.display_name = requireTrimmedString(
      patch.display_name,
      "display_name"
    );
    patch.description = requireTrimmedString(
      patch.description,
      "description"
    );
    patch.policy_doc = requireTrimmedString(
      patch.policy_doc,
      "policy_doc"
    );
  }

  return patch;
}

async function loadRoleById(roleId) {
  const rows = await postgrest("/roles", {
    query: { id: `eq.${roleId}`, limit: "1", select: "*" },
  });
  return rows?.[0] || null;
}

async function loadAgentById(agentId) {
  const rows = await postgrest("/agents", {
    query: { id: `eq.${agentId}`, limit: "1", select: "*" },
  });
  return rows?.[0] || null;
}

async function loadAgentByRoleId(roleId) {
  const rows = await postgrest("/agents", {
    query: { role_id: `eq.${roleId}`, limit: "1", select: "*" },
  });
  return rows?.[0] || null;
}

async function allocateAgentRoleId(name) {
  const baseId = normalizeAgentRoleBaseId(name);
  let candidate = baseId;
  let suffix = 2;

  while (await loadRoleById(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

async function hydrateAgentsWithRoleProfiles(agents) {
  const rows = Array.isArray(agents) ? agents : [];
  const roleIds = [...new Set(rows.map((agent) => agent.role_id).filter(Boolean))];

  if (!roleIds.length) {
    return rows.map((agent) => ({ ...agent, role_profile: null }));
  }

  const roles = await postgrest("/roles", {
    query: {
      id: `in.(${roleIds.join(",")})`,
      select: "*",
    },
  });
  const roleMap = new Map((roles || []).map((role) => [role.id, role]));

  return rows.map((agent) => ({
    ...agent,
    role_profile: roleMap.get(agent.role_id) || null,
  }));
}

async function loadAgentsWithRoleProfiles() {
  const agents = await postgrest("/agents", {
    query: { order: "name.asc", select: "*" },
  });
  const hydrated = await hydrateAgentsWithRoleProfiles(agents || []);
  return hydrated.sort((left, right) => {
    const leftName =
      normalizeString(left.role_profile?.display_name) ||
      normalizeString(left.name) ||
      normalizeString(left.role_id);
    const rightName =
      normalizeString(right.role_profile?.display_name) ||
      normalizeString(right.name) ||
      normalizeString(right.role_id);
    return leftName.localeCompare(rightName);
  });
}

async function loadAgentWithRoleProfile(agentId) {
  const agent = await loadAgentById(agentId);
  if (!agent) {
    return null;
  }

  const hydrated = await hydrateAgentsWithRoleProfiles([agent]);
  return hydrated[0] || null;
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
  const relayRouting = await prepareRelayTaskRouting(message);

  const rows = await postgrest("/tasks", {
    body: {
      acceptance_criteria: buildRelayAcceptanceCriteria(relayRouting),
      assigned_role: "relay",
      objective: relayRouting.objective,
      priority: "high",
      state: "ready",
      title,
    },
    method: "POST",
    preferRepresentation: true,
  });

  const relayTask = rows?.[0] || null;
  if (relayTask && relayRouting.requires_execution) {
    await createRelayExecutionRequirement(relayTask.id, relayRouting);
  }

  return relayTask
    ? {
        ...relayTask,
        routing_hints: relayRouting,
      }
    : null;
}

async function prepareRelayTaskRouting(message) {
  const content = normalizeString(message.content);
  const teachMode = detectRelayTeachMode(content);
  const history = await loadRecentConversationMessages(message);
  const matchedSkills = await loadRelayMatchedSkills(content);
  const executionDecision = classifyRelayExecutionRequest(
    content,
    matchedSkills,
    teachMode
  );
  const transcript = [...history, {
    content,
    created_at: new Date().toISOString(),
    direction: "inbound",
    sender: message.sender,
  }]
    .map(formatConversationMessage)
    .join("\n");

  const objective = `Process this inbound message from ${message.sender} via ${message.channel}. Classify intent and route appropriately.

Current message:
${content}

Recent conversation transcript:
${transcript}

Routing reminders:
- If the request depends on a third-party service, account, API key, CDN, email provider, or similar credentialed integration, route to sage for a plan before builder implementation unless an approved plan already exists.
- If the message states a stable operator preference or constraint, record it as durable memory. Do not store secrets in memory.
- If the request creates or removes a public hostname, treat route activation or teardown plus external verification as required work, not optional follow-up.
- If the message begins with "Remember:", "Always:", "Rule:", or a "When...do..." procedure, treat it as explicit training. Create a semantic memory for durable facts or a shared skill for repeatable procedures at company scope, then confirm back to the operator what was stored.
- If matched shared skills are listed below and one clearly applies, reference it explicitly when you create downstream work so execution roles can follow the existing procedure instead of recreating it.
- When execution is required, direct response alone is insufficient. Create at least one downstream child task for the appropriate role, reference the matched skill by name, and keep any operator reply to a brief acknowledgement instead of a false completion claim.

Matched shared skills for this message:
${formatRelayMatchedSkills(matchedSkills)}

Teach mode detected: ${teachMode ? "yes" : "no"}.
Execution request detected: ${executionDecision.requiresExecution ? "yes" : "no"}.
Recommended downstream role: ${executionDecision.recommendedRole || "none"}.
Routing requirement: ${
  executionDecision.requiresExecution
    ? "Create at least one downstream child task before completing this relay task."
    : "Direct answer is allowed when confidence is high."
}`;

  return {
    execution_reason: executionDecision.reason,
    matched_skills: matchedSkills,
    objective,
    recommended_role: executionDecision.recommendedRole,
    requires_execution: executionDecision.requiresExecution,
    teach_mode: teachMode,
  };
}

function buildRelayAcceptanceCriteria(relayRouting) {
  if (relayRouting?.requires_execution) {
    return [
      "Message classified",
      "Appropriate downstream child task created",
      "Operator kept informed without falsely claiming the work is already complete",
    ];
  }

  return [
    "Message classified",
    "Appropriate action taken or task created",
    "Response sent",
  ];
}

async function createRelayExecutionRequirement(taskId, relayRouting) {
  try {
    await postgrest("/task_requirements", {
      body: {
        expected: {
          execution_reason: relayRouting.execution_reason,
          matched_skill_names: (relayRouting.matched_skills || []).map((skill) => skill.name),
          recommended_role: relayRouting.recommended_role || "builder",
        },
        last_result: {},
        required_for_completion: true,
        requirement_type: "downstream_task",
        status: "pending",
        target: "execution",
        task_id: taskId,
      },
      method: "POST",
    });
  } catch (error) {
    console.error(
      `[admin] Failed to create downstream-task requirement for relay task ${taskId}:`,
      error
    );
  }
}

function detectRelayTeachMode(content) {
  return /^(remember:|always:|rule:|when\b.+\bdo\b)/i.test(content);
}

function classifyRelayExecutionRequest(content, matchedSkills, teachMode) {
  if (teachMode) {
    return {
      reason: "explicit_training",
      recommendedRole: null,
      requiresExecution: false,
    };
  }

  if (!matchedSkills.length) {
    return {
      reason: "no_matched_skill",
      recommendedRole: null,
      requiresExecution: false,
    };
  }

  const imperativeLead =
    /^(please\s+)?(do|run|handle|follow|use|apply|execute|perform|send|deploy|fix|update|create|remove|delete|verify|check|review|build|make|treat)\b/i.test(
      content
    );
  const actionPhrase =
    /\b(please|go ahead|follow the|use the|apply the|run the|execute the|handle this|do this|verify this|treat this as|ship this|deploy this|fix this|update this|create this|remove this)\b/i.test(
      content
    );
  const informationalQuestion = looksLikeInformationalRelayQuestion(content);
  const requiresExecution = imperativeLead || actionPhrase || !informationalQuestion;

  return {
    reason: requiresExecution
      ? imperativeLead || actionPhrase
        ? "matched_skill_action_request"
        : "matched_skill_non_question"
      : "matched_skill_information_request",
    recommendedRole: requiresExecution
      ? determineRelayRecommendedRole(matchedSkills, content)
      : null,
    requiresExecution,
  };
}

function looksLikeInformationalRelayQuestion(content) {
  const normalized = normalizeString(content);
  if (!normalized.endsWith("?")) {
    return false;
  }

  return (
    /^(what|why|how|when|where|who|which|is|are|does|do|did|can|could|would|should|will)\b/i.test(
      normalized
    ) &&
    !/\b(use|follow|apply|run|execute|handle|do|send|fix|update|create|remove|deploy|verify|build|make|treat)\b/i.test(
      normalized
    )
  );
}

function determineRelayRecommendedRole(matchedSkills, content) {
  const requiresService =
    matchedSkills.some(
      (skill) =>
        Array.isArray(skill.required_services) && skill.required_services.length > 0
    ) ||
    /\b(api key|credential|login|service connection|service slot|cloudflare|stripe|sendgrid|resend|smtp|cdn|dns|domain)\b/i.test(
      content
    );

  return requiresService ? "sage" : "builder";
}

async function loadRelayMatchedSkills(content) {
  if (!content) {
    return [];
  }

  const rows = await postgrest("/memories", {
    query: {
      is_active: "eq.true",
      layer: "eq.procedural",
      limit: "50",
      order: "updated_at.desc",
      select:
        "id,subject,content,tags,scope_type,scope_id,is_active,created_at,updated_at,superseded_by,source_agent_id",
    },
  }).catch((error) => {
    console.error("[admin] Failed to load relay skill matches:", error);
    return [];
  });

  return (rows || [])
    .filter((row) => Array.isArray(row.tags) && row.tags.includes(SKILL_TAG))
    .map(parseSkillMemoryRow)
    .filter((skill) =>
      skill &&
      (skill.scope_type === "company" ||
        (skill.scope_type === "role" && skill.scope_id === "relay"))
    )
    .map((skill) => ({
      ...skill,
      match_score: scoreRelaySkillMatch(skill, content),
    }))
    .filter((skill) => skill.match_score > 0)
    .sort((left, right) => {
      if (right.match_score !== left.match_score) {
        return right.match_score - left.match_score;
      }
      if (right.use_count !== left.use_count) {
        return right.use_count - left.use_count;
      }
      return right.updated_at.localeCompare(left.updated_at);
    })
    .slice(0, 3);
}

function formatRelayMatchedSkills(skills) {
  if (!skills.length) {
    return "- No obvious shared skill match detected.";
  }

  return skills
    .map((skill) => {
      const steps = skill.steps
        .slice(0, 3)
        .map((step) => `${step.order}. ${step.instruction}`)
        .join(" ");
      return [
        `- ${skill.display_name} (${skill.name})`,
        skill.trigger_when ? `  Trigger: ${skill.trigger_when}` : null,
        steps ? `  Steps: ${steps}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

function scoreRelaySkillMatch(skill, content) {
  const haystack = normalizeRelayMatchText(content);
  if (!haystack) {
    return 0;
  }

  const fields = [
    skill.name,
    skill.display_name,
    skill.description,
    skill.trigger_when,
    ...(skill.tags || []),
    ...(skill.steps || []).map((step) => step.instruction),
  ]
    .map((value) => normalizeRelayMatchText(value))
    .filter(Boolean);

  let score = 0;
  for (const field of fields) {
    if (!field) {
      continue;
    }

    if (haystack.includes(field) || field.includes(haystack)) {
      score += 6;
      continue;
    }

    const fieldTokens = new Set(tokenizeRelayMatchText(field));
    const sharedTokens = tokenizeRelayMatchText(haystack).filter((token) =>
      fieldTokens.has(token)
    );
    score += sharedTokens.length;
  }

  return score;
}

function normalizeRelayMatchText(value) {
  return normalizeString(value).toLowerCase().replace(/[^a-z0-9\s:-]+/g, " ");
}

function tokenizeRelayMatchText(value) {
  return normalizeRelayMatchText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function formatConversationMessage(message) {
  const timestamp = message.created_at
    ? new Date(message.created_at).toISOString()
    : "current";
  return `[${timestamp}] ${message.direction}/${message.sender}: ${message.content}`;
}

function shouldHideAdminMessage(message) {
  return (
    (message?.sender === "system" && message?.metadata?.operator_visible !== true) ||
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

function getOptionalTrimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireTrimmedString(value, fieldName) {
  const normalized = getOptionalTrimmedString(value);
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function normalizeSlug(value, fieldName = "id") {
  const normalized = requireTrimmedString(value, fieldName).toLowerCase();
  if (!/^[a-z0-9._:-]+$/.test(normalized)) {
    throw new Error(`${fieldName} must be a lowercase slug`);
  }
  return normalized;
}

function normalizeEnum(value, allowedValues, fieldName) {
  const normalized = requireTrimmedString(value, fieldName).toLowerCase();
  if (!allowedValues.has(normalized)) {
    throw new Error(`${fieldName} must be one of: ${[...allowedValues].join(", ")}`);
  }
  return normalized;
}

function normalizeJsonObject(value, fieldName) {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  return value;
}

function normalizeOptionalNumber(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a number`);
  }

  return parsed;
}

function ensureUuidLike(value, fieldName) {
  const normalized = requireTrimmedString(value, fieldName);
  if (!/^[0-9a-f-]{8,}$/i.test(normalized)) {
    throw new Error(`${fieldName} must be a UUID`);
  }
  return normalized;
}

function buildSkillSubject(name) {
  return `skill:${normalizeSlug(name, "name")}`;
}

function normalizeSkillPayload(body, options = {}) {
  const steps = Array.isArray(body?.steps)
    ? body.steps.map((step, index) => ({
        instruction: requireTrimmedString(step?.instruction, `steps[${index}].instruction`),
        order:
          typeof step?.order === "number" && Number.isFinite(step.order)
            ? step.order
            : index + 1,
        required: step?.required !== false,
        tool_hint: getOptionalTrimmedString(step?.tool_hint),
      }))
    : [];

  return {
    description: requireTrimmedString(body?.description, "description"),
    display_name: requireTrimmedString(body?.display_name || body?.name, "display_name"),
    input_schema: normalizeJsonObject(body?.input_schema || {}, "input_schema") || {},
    name: normalizeSlug(body?.name, "name"),
    output_schema: normalizeJsonObject(body?.output_schema || {}, "output_schema") || {},
    required_services: normalizeStringArray(body?.required_services),
    scope_id:
      body?.scope_type === "company"
        ? "company"
        : requireTrimmedString(body?.scope_id, "scope_id"),
    scope_type: normalizeEnum(body?.scope_type || "company", SCOPE_TYPE_OPTIONS, "scope_type"),
    steps,
    tags: normalizeStringArray(["skill", ...(body?.tags || [])]),
    trigger_when: requireTrimmedString(body?.trigger_when, "trigger_when"),
  };
}

function parseSkillMemoryRow(row) {
  const content = safeJsonParse(row?.content, {});
  if (!content || typeof content !== "object") {
    return null;
  }

  const name =
    getOptionalTrimmedString(content.name) ||
    getOptionalTrimmedString(String(row?.subject || "").replace(/^skill:/, ""));

  if (!name) {
    return null;
  }

  const steps = Array.isArray(content.steps)
    ? content.steps.map((step, index) => ({
        instruction: String(step?.instruction || "").trim(),
        order:
          typeof step?.order === "number" && Number.isFinite(step.order)
            ? step.order
            : index + 1,
        required: step?.required !== false,
        tool_hint: getOptionalTrimmedString(step?.tool_hint),
      }))
    : [];

  return {
    id: row.id,
    name,
    display_name:
      getOptionalTrimmedString(content.display_name) ||
      getOptionalTrimmedString(content.name) ||
      name,
    description: getOptionalTrimmedString(content.description) || "",
    trigger_when: getOptionalTrimmedString(content.trigger_when) || "",
    steps,
    input_schema:
      content.input_schema && typeof content.input_schema === "object"
        ? content.input_schema
        : {},
    output_schema:
      content.output_schema && typeof content.output_schema === "object"
        ? content.output_schema
        : {},
    required_services: normalizeStringArray(content.required_services),
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    tags: normalizeStringArray(row.tags),
    version:
      typeof content.version === "number" && Number.isFinite(content.version)
        ? content.version
        : 1,
    last_used_at: getOptionalTrimmedString(content.last_used_at),
    use_count:
      typeof content.use_count === "number" && Number.isFinite(content.use_count)
        ? content.use_count
        : 0,
    is_active: row.is_active !== false,
    created_at: row.created_at,
    updated_at: row.updated_at,
    memory_id: row.id,
    subject: row.subject,
    superseded_by: row.superseded_by || null,
  };
}

function serializeSkillContent(skill, previousSkill = null) {
  return JSON.stringify(
    {
      name: skill.name,
      display_name: skill.display_name,
      description: skill.description,
      trigger_when: skill.trigger_when,
      steps: skill.steps,
      input_schema: skill.input_schema,
      output_schema: skill.output_schema,
      required_services: skill.required_services,
      tags: skill.tags,
      version: (previousSkill?.version || 0) + 1,
      last_used_at: previousSkill?.last_used_at || null,
      use_count: previousSkill?.use_count || 0,
    },
    null,
    2
  );
}

async function loadTaskFullPayload(taskId) {
  const [taskRows, taskRuns, contextPack, events] = await Promise.all([
    postgrest("/tasks", {
      query: {
        id: `eq.${taskId}`,
        limit: "1",
        select: "*",
      },
    }).catch(() => []),
    loadTaskRuns(taskId),
    postgrest("/rpc/build_context_pack", {
      body: { p_task_id: taskId },
      method: "POST",
    }).catch(() => null),
    postgrest("/events", {
      query: {
        limit: "50",
        order: "created_at.desc",
        scope_id: `eq.${taskId}`,
        scope_type: "eq.task",
        select: "*",
      },
    }).catch(() => []),
  ]);

  return {
    task: taskRows?.[0] || null,
    task_runs: taskRuns,
    context_pack: contextPack,
    related_artifacts: contextPack?.related_artifacts || [],
    related_events: events || [],
    related_memories: contextPack?.related_memories || [],
  };
}

async function loadAgentActivity(agentId) {
  const [taskRuns, events] = await Promise.all([
    postgrest("/task_runs", {
      query: {
        agent_id: `eq.${agentId}`,
        limit: "20",
        order: "started_at.desc",
        select:
          "id,task_id,status,model_used,effort_used,error_message,started_at,finished_at,task:tasks(title)",
      },
    }).catch(() => []),
    postgrest("/events", {
      query: {
        agent_id: `eq.${agentId}`,
        limit: "20",
        order: "created_at.desc",
        select: "*",
      },
    }).catch(() => []),
  ]);

  return {
    events: events || [],
    task_runs: (taskRuns || []).map((run) => ({
      ...run,
      task_title: run?.task?.title || null,
    })),
  };
}

async function loadSkillVersions(skillRow) {
  if (!skillRow?.subject) {
    return [];
  }

  const rows =
    (await postgrest("/memories", {
      query: {
        layer: "eq.procedural",
        order: "created_at.desc",
        scope_id: `eq.${skillRow.scope_id}`,
        scope_type: `eq.${skillRow.scope_type}`,
        select: "id,subject,content,tags,is_active,scope_type,scope_id,created_at,updated_at,superseded_by",
        subject: `eq.${skillRow.subject}`,
      },
    }).catch(() => [])) || [];

  return rows
    .map(parseSkillMemoryRow)
    .filter(Boolean)
    .map((skill) => ({
      id: skill.id,
      updated_at: skill.updated_at,
      version: skill.version,
    }));
}

async function createSkillMemory(skillPayload, existingSkill = null) {
  const now = new Date().toISOString();
  const content = serializeSkillContent(skillPayload, existingSkill);

  const rows = await postgrest("/memories", {
    body: {
      confidence: 1,
      content,
      created_at: now,
      is_active: true,
      layer: "procedural",
      scope_id: skillPayload.scope_type === "company" ? "company" : skillPayload.scope_id,
      scope_type: skillPayload.scope_type,
      source_agent_id: null,
      subject: buildSkillSubject(skillPayload.name),
      superseded_by: null,
      tags: skillPayload.tags,
      updated_at: now,
    },
    method: "POST",
    preferRepresentation: true,
  });

  const row = rows?.[0];

  if (!row) {
    throw new Error("Failed to create skill memory");
  }

  await upsertMemoryChunk(
    row.id,
    row.scope_type,
    row.scope_id,
    buildSkillChunkContent(skillPayload)
  );

  if (existingSkill?.id) {
    await postgrest("/memories", {
      body: {
        is_active: false,
        superseded_by: row.id,
        updated_at: now,
      },
      method: "PATCH",
      query: { id: `eq.${existingSkill.id}` },
    });
  }

  return row;
}

function parseSkillDraftCommand(content) {
  const normalized = normalizeString(content);
  const confirmMatch = normalized.match(
    /^(save|confirm|approve)\s+skill\s+draft\s+([0-9a-f-]{8,})$/i
  );
  if (confirmMatch) {
    return {
      action: "confirm",
      draft_id: confirmMatch[2],
    };
  }

  const rejectMatch = normalized.match(
    /^(reject|discard|cancel)\s+skill\s+draft\s+([0-9a-f-]{8,})$/i
  );
  if (rejectMatch) {
    return {
      action: "reject",
      draft_id: rejectMatch[2],
    };
  }

  return null;
}

function isProceduralSkillDraftCandidate(content) {
  const normalized = normalizeString(content);
  if (!/^(remember:|always:|rule:|when\b)/i.test(normalized)) {
    return false;
  }

  if (/^when\b.+\b(do|then)\b/i.test(normalized)) {
    return true;
  }

  const explicitStepCount = extractSkillDraftSteps(normalized, normalized).length;
  if (explicitStepCount >= 2) {
    return true;
  }

  return /\b(first|then|after that|finally|next)\b/i.test(normalized);
}

function buildSkillDraftDisplayName(name) {
  return name
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildSkillDraftName(seed) {
  const collapsed = normalizeString(seed)
    .toLowerCase()
    .replace(/^(when|always|remember|rule)\b[:\s-]*/i, "")
    .replace(/\b(do|then|first|next|finally)\b.*$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return collapsed || `shared-skill-${Date.now().toString(36)}`;
}

function extractSkillDraftSteps(content, proceduralBody) {
  const lines = normalizeString(content)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const explicitSteps = lines
    .map(
      (line) =>
        line.match(/^\d+[.)]\s+(.*)$/)?.[1]?.trim() ||
        line.match(/^[-*]\s+(.*)$/)?.[1]?.trim() ||
        ""
    )
    .filter(Boolean);

  if (explicitSteps.length >= 2) {
    return explicitSteps.slice(0, 8);
  }

  const normalizedBody = normalizeString(proceduralBody)
    .replace(/\b(and then|then|after that|next|finally)\b/gi, "|")
    .replace(/\s*;\s*/g, "|")
    .replace(/\.\s+/g, "|");
  const fragments = normalizedBody
    .split("|")
    .map((fragment) =>
      fragment
        .replace(/^(do|always|remember to|rule:)\s+/i, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((fragment) => fragment.length >= 10);

  return [...new Set(fragments)].slice(0, 8);
}

function buildSkillDraftFromMessage(content) {
  if (!isProceduralSkillDraftCandidate(content)) {
    return null;
  }

  const normalized = normalizeString(content);
  const cleaned = normalized.replace(/^(remember:|always:|rule:)\s*/i, "").trim();
  const whenMatch =
    cleaned.match(/^when\s+(.+?)\s+do\s+(.+)$/i) ||
    cleaned.match(/^when\s+(.+?),(.+)$/i);
  const triggerWhen = whenMatch
    ? `When ${normalizeString(whenMatch[1])}`
    : normalizeString(cleaned.split(/\r?\n/, 1)[0]).slice(0, 180);
  const proceduralBody = whenMatch ? normalizeString(whenMatch[2]) : cleaned;
  const steps = extractSkillDraftSteps(cleaned, proceduralBody);

  if (steps.length < 2) {
    return null;
  }

  const name = buildSkillDraftName(triggerWhen || steps[0]);
  return {
    description: cleaned,
    display_name: buildSkillDraftDisplayName(name),
    input_schema: {},
    name,
    output_schema: {},
    required_services: [],
    scope_id: "company",
    scope_type: "company",
    steps: steps.map((instruction, index) => ({
      instruction,
      order: index + 1,
      required: true,
      tool_hint: null,
    })),
    tags: normalizeStringArray([SKILL_TAG, "operator_taught", "chat_imported"]),
    trigger_when:
      triggerWhen ||
      `Use the ${buildSkillDraftDisplayName(name)} procedure when the operator request matches this pattern.`,
  };
}

function normalizeSkillDraftRow(row) {
  if (!row) {
    return null;
  }

  return {
    confirmed_skill_id: row.confirmed_skill_id || null,
    created_at: row.created_at,
    description: normalizeString(row.description),
    display_name: normalizeString(row.display_name),
    expires_at: row.expires_at,
    id: row.id,
    input_schema:
      row.input_schema && typeof row.input_schema === "object" ? row.input_schema : {},
    name: normalizeString(row.name),
    output_schema:
      row.output_schema && typeof row.output_schema === "object" ? row.output_schema : {},
    required_services: normalizeStringArray(row.required_services),
    scope_id: normalizeString(row.scope_id, "company") || "company",
    scope_type: normalizeString(row.scope_type, "company") || "company",
    source_content: normalizeString(row.source_content),
    source_message_id: row.source_message_id || null,
    status: SKILL_DRAFT_STATUS_OPTIONS.has(normalizeString(row.status))
      ? normalizeString(row.status)
      : "pending",
    steps: Array.isArray(row.steps)
      ? row.steps
          .map((step, index) => ({
            instruction: normalizeString(step?.instruction),
            order: Number(step?.order || index + 1),
            required: step?.required !== false,
            tool_hint: normalizeString(step?.tool_hint) || null,
          }))
          .filter((step) => step.instruction)
      : [],
    tags: normalizeStringArray(row.tags),
    trigger_when: normalizeString(row.trigger_when),
    updated_at: row.updated_at,
  };
}

function formatSkillDraftMessage(draft) {
  const steps = draft.steps
    .map((step) => `${step.order}. ${step.instruction}`)
    .join("\n");

  return [
    `Drafted shared skill "${draft.display_name}".`,
    `Trigger: ${draft.trigger_when}`,
    steps ? `Steps:\n${steps}` : null,
    `Confirm to save or discard it. Draft ID: ${draft.id}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function postAdminSystemMessage({ content, metadata, taskId = null }) {
  const rows = await postgrest("/messages", {
    body: {
      channel: "admin_chat",
      content,
      direction: "outbound",
      metadata,
      processed: true,
      sender: "system",
      task_id: taskId,
    },
    method: "POST",
    preferRepresentation: true,
  }).catch(() => []);

  return rows?.[0] || null;
}

async function loadSkillDraftById(draftId) {
  const rows = await postgrest("/skill_drafts", {
    query: {
      id: `eq.${draftId}`,
      limit: "1",
      select: "*",
    },
  }).catch(() => []);

  return normalizeSkillDraftRow(rows?.[0] || null);
}

async function createSkillDraftRecord({ content, sourceMessageId }) {
  const draft = buildSkillDraftFromMessage(content);
  if (!draft) {
    return null;
  }

  const rows = await postgrest("/skill_drafts", {
    body: {
      description: draft.description,
      display_name: draft.display_name,
      input_schema: draft.input_schema,
      name: draft.name,
      output_schema: draft.output_schema,
      required_services: draft.required_services,
      scope_id: draft.scope_id,
      scope_type: draft.scope_type,
      source_content: normalizeString(content),
      source_message_id: sourceMessageId || null,
      status: "pending",
      steps: draft.steps,
      tags: draft.tags,
      trigger_when: draft.trigger_when,
    },
    method: "POST",
    preferRepresentation: true,
  });

  return normalizeSkillDraftRow(rows?.[0] || null);
}

async function confirmSkillDraftRecord(draftId) {
  const draft = await loadSkillDraftById(draftId);
  if (!draft) {
    throw new Error("Skill draft not found");
  }

  if (draft.status === "rejected") {
    throw new Error("Skill draft has already been rejected");
  }

  if (draft.status === "confirmed" && draft.confirmed_skill_id) {
    const existingSkillRow = await postgrest("/memories", {
      query: {
        id: `eq.${draft.confirmed_skill_id}`,
        limit: "1",
        select:
          "id,subject,content,tags,is_active,scope_type,scope_id,created_at,updated_at,superseded_by",
      },
    }).catch(() => []);

    return {
      draft,
      skill: parseSkillMemoryRow(existingSkillRow?.[0] || null),
    };
  }

  const existingSkill = (
    await postgrest("/memories", {
      query: {
        layer: "eq.procedural",
        limit: "1",
        order: "created_at.desc",
        scope_id: `eq.${draft.scope_id}`,
        scope_type: `eq.${draft.scope_type}`,
        select:
          "id,subject,content,tags,is_active,scope_type,scope_id,created_at,updated_at,superseded_by",
        subject: `eq.${buildSkillSubject(draft.name)}`,
      },
    }).catch(() => [])
  )
    .map(parseSkillMemoryRow)
    .filter(Boolean)?.[0] || null;

  const skillRow = await createSkillMemory(
    {
      description: draft.description,
      display_name: draft.display_name,
      input_schema: draft.input_schema,
      name: draft.name,
      output_schema: draft.output_schema,
      required_services: draft.required_services,
      scope_id: draft.scope_id,
      scope_type: draft.scope_type,
      steps: draft.steps,
      tags: draft.tags,
      trigger_when: draft.trigger_when,
    },
    existingSkill
  );

  const now = new Date().toISOString();
  const updatedDraftRows = await postgrest("/skill_drafts", {
    body: {
      confirmed_at: now,
      confirmed_by: "operator",
      confirmed_skill_id: skillRow.id,
      status: "confirmed",
      updated_at: now,
    },
    method: "PATCH",
    preferRepresentation: true,
    query: { id: `eq.${draftId}` },
  });

  const updatedDraft = normalizeSkillDraftRow(updatedDraftRows?.[0] || draft);
  const skill = parseSkillMemoryRow(skillRow);

  await postAdminSystemMessage({
    content: `Saved shared skill "${updatedDraft.display_name}" as ${updatedDraft.name}.`,
    metadata: {
      operator_visible: true,
      saved_skill_id: skill?.id || null,
      skill_draft_id: updatedDraft.id,
      skill_draft_status: "confirmed",
    },
  });

  return { draft: updatedDraft, skill };
}

async function rejectSkillDraftRecord(draftId) {
  const draft = await loadSkillDraftById(draftId);
  if (!draft) {
    throw new Error("Skill draft not found");
  }

  if (draft.status === "confirmed") {
    throw new Error("Skill draft has already been confirmed");
  }

  const now = new Date().toISOString();
  const rows = await postgrest("/skill_drafts", {
    body: {
      rejected_at: now,
      rejected_by: "operator",
      status: "rejected",
      updated_at: now,
    },
    method: "PATCH",
    preferRepresentation: true,
    query: { id: `eq.${draftId}` },
  });

  const updatedDraft = normalizeSkillDraftRow(rows?.[0] || draft);

  await postAdminSystemMessage({
    content: `Discarded skill draft "${updatedDraft.display_name}".`,
    metadata: {
      operator_visible: true,
      skill_draft_id: updatedDraft.id,
      skill_draft_status: "rejected",
    },
  });

  return { draft: updatedDraft };
}

async function processInboundOperatorMessage({
  channel,
  content,
  currentMessageId,
  metadata = {},
  sender,
}) {
  const baseMetadata = { ...metadata };
  const draftCommand = parseSkillDraftCommand(content);

  if (draftCommand) {
    const result =
      draftCommand.action === "confirm"
        ? await confirmSkillDraftRecord(draftCommand.draft_id)
        : await rejectSkillDraftRecord(draftCommand.draft_id);
    return {
      processed: true,
      relayTask: null,
      metadata: {
        ...baseMetadata,
        skill_draft_action: draftCommand.action,
        skill_draft_id: draftCommand.draft_id,
      },
      result,
    };
  }

  const skillDraft = await createSkillDraftRecord({
    content,
    sourceMessageId: currentMessageId,
  });

  if (skillDraft) {
    await postAdminSystemMessage({
      content: formatSkillDraftMessage(skillDraft),
      metadata: {
        operator_visible: true,
        skill_draft: skillDraft,
        skill_draft_id: skillDraft.id,
        skill_draft_status: "pending",
      },
    });

    return {
      processed: true,
      relayTask: null,
      metadata: {
        ...baseMetadata,
        skill_draft_candidate: true,
        skill_draft_id: skillDraft.id,
        teach_mode: true,
      },
      result: {
        draft: skillDraft,
      },
    };
  }

  const relayTask = await createRelayTaskForInboundMessage({
    channel,
    content,
    currentMessageId,
    sender,
  });

  return {
    processed: true,
    relayTask,
    metadata: {
      ...baseMetadata,
      matched_skill_names:
        relayTask?.routing_hints?.matched_skills?.map((skill) => skill.name) || [],
      recommended_role: relayTask?.routing_hints?.recommended_role || null,
      relay_task_id: relayTask?.id || null,
      requires_execution: relayTask?.routing_hints?.requires_execution || false,
      routing: "direct_relay_task",
      teach_mode: relayTask?.routing_hints?.teach_mode || false,
    },
    result: null,
  };
}

async function getSystemSetting(key) {
  const rows = await postgrest("/system_settings", {
    query: {
      key: `eq.${key}`,
      limit: "1",
      select: "key,value,updated_at",
    },
  }).catch(() => []);

  return rows?.[0] || null;
}

async function saveSystemSetting(key, value) {
  const existing = await getSystemSetting(key);

  if (existing?.key) {
    await postgrest("/system_settings", {
      body: {
        updated_at: new Date().toISOString(),
        value,
      },
      method: "PATCH",
      query: { key: `eq.${key}` },
    });
    return;
  }

  await postgrest("/system_settings", {
    body: {
      key,
      updated_at: new Date().toISOString(),
      value,
    },
    method: "POST",
  });
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

  const telegramRows = await postgrest("/messages", {
    body: {
      channel: "telegram",
      content,
      direction: "inbound",
      metadata: {
        chat_id: chatId,
        from: message.from || null,
        message_id: message.message_id || null,
        telegram_update_id: update?.update_id || null,
      },
      processed: false,
      sender,
      task_id: null,
    },
    method: "POST",
    preferRepresentation: true,
  });

  const sourceMessageId = telegramRows?.[0]?.id || null;
  const mirroredRows = await postgrest("/messages", {
    body: {
      channel: "admin_chat",
      content,
      direction: "inbound",
      metadata: {
        chat_id: chatId,
        mirrored_from: "telegram",
        source_channel: "telegram",
        source_message_id: sourceMessageId,
        telegram_message_id: message.message_id || null,
      },
      processed: false,
      sender,
      task_id: null,
    },
    method: "POST",
    preferRepresentation: true,
  });

  const mirroredMessageId = mirroredRows?.[0]?.id || null;
  let routing = "direct_relay_task";
  let routingError = null;
  let relayTask = null;
  let processedMetadata = {
    chat_id: chatId,
    from: message.from || null,
    message_id: message.message_id || null,
    mirrored_from: "telegram",
    source_channel: "telegram",
    source_message_id: sourceMessageId,
    telegram_message_id: message.message_id || null,
    telegram_update_id: update?.update_id || null,
  };

  try {
    const result = await processInboundOperatorMessage({
      channel: "telegram",
      content,
      currentMessageId: mirroredMessageId,
      metadata: processedMetadata,
      sender,
    });
    relayTask = result.relayTask;
    processedMetadata = result.metadata;
  } catch (error) {
    routing = "fallback_poll";
    routingError = error instanceof Error ? error.message : String(error);
    processedMetadata = {
      ...processedMetadata,
      routing,
      routing_error: routingError,
    };
  }

  if (mirroredMessageId) {
    await postgrest("/messages", {
      body: {
        metadata: processedMetadata,
        processed: routing !== "fallback_poll",
        task_id: relayTask?.id || null,
      },
      method: "PATCH",
      query: { id: `eq.${mirroredMessageId}` },
    });
  }

  if (sourceMessageId) {
    await postgrest("/messages", {
      body: {
        metadata: processedMetadata,
        processed: routing !== "fallback_poll",
        task_id: relayTask?.id || null,
      },
      method: "PATCH",
      query: { id: `eq.${sourceMessageId}` },
    });
  }

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
    if (isRateLimited(getRateLimitKey(req, "login"), LOGIN_RATE_LIMIT)) {
      sendJson(res, 429, { error: "Too many login attempts. Try again shortly." });
      return;
    }

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

  if (isRateLimited(getRateLimitKey(req, "api"), API_RATE_LIMIT)) {
    sendJson(res, 429, { error: "Too many requests. Slow down." });
    return;
  }

  if (pathname === "/api/stream" && req.method === "GET") {
    res.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    await addAdminStreamClient(res);
    req.on("close", () => removeAdminStreamClient(res));
    return;
  }

  if (pathname === "/api/messages" && req.method === "GET") {
    sendJson(
      res,
      200,
      await loadMessagesFeed({
        before: searchParams.get("before"),
        channel: searchParams.get("channel") || "admin_chat",
        limit: searchParams.get("limit") || "50",
      })
    );
    return;
  }

  if (pathname === "/api/messages" && req.method === "POST") {
    const body = await readJson(req);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const teachMode = /^(remember:|always:|rule:|when\b.+\bdo\b)/i.test(content);
    const draftCommand = parseSkillDraftCommand(content);
    const skillDraftCandidate = isProceduralSkillDraftCandidate(content);

    if (!content) {
      sendJson(res, 400, { error: "Message content is required" });
      return;
    }

    const rows = await postgrest("/messages", {
      body: {
        channel: "admin_chat",
        content,
        direction: "inbound",
        metadata: {
          teach_mode: teachMode,
        },
        processed: false,
        sender: "operator",
        task_id: null,
      },
      method: "POST",
      preferRepresentation: true,
    });

    const messageId = rows?.[0]?.id || null;

    try {
      const result = await processInboundOperatorMessage({
        channel: "admin_chat",
        content,
        currentMessageId: messageId,
        metadata: {
          teach_mode: teachMode,
        },
        sender: "operator",
      });

      if (messageId) {
        await postgrest("/messages", {
          body: {
            metadata: result.metadata,
            processed: result.processed,
            task_id: result.relayTask?.id || null,
          },
          method: "PATCH",
          query: { id: `eq.${messageId}` },
        });
      }

      sendJson(res, 200, {
        messageId,
        relayTaskId: result.relayTask?.id || null,
      });
      return;
    } catch (taskError) {
      if (draftCommand || skillDraftCandidate) {
        if (messageId) {
          await postgrest("/messages", {
            body: {
              metadata: {
                skill_draft_error:
                  taskError instanceof Error ? taskError.message : String(taskError),
                teach_mode: teachMode,
              },
              processed: true,
              task_id: null,
            },
            method: "PATCH",
            query: { id: `eq.${messageId}` },
          });
        }

        sendJson(res, 400, {
          error:
            taskError instanceof Error
              ? taskError.message
              : "Failed to process skill draft message.",
        });
        return;
      }

      if (messageId) {
        await postgrest("/messages", {
          body: {
            metadata: {
              routing: "fallback_poll",
              routing_error:
                taskError instanceof Error ? taskError.message : String(taskError),
              teach_mode: teachMode,
            },
            processed: false,
            task_id: null,
          },
          method: "PATCH",
          query: { id: `eq.${messageId}` },
        });
      }

      sendJson(res, 202, {
        queuedForPolling: true,
        relayTaskId: null,
      });
      return;
    }
  }

  const skillDraftConfirmMatch = pathname.match(
    /^\/api\/skill-drafts\/([^/]+)\/confirm$/
  );
  if (skillDraftConfirmMatch && req.method === "POST") {
    try {
      const [, draftId] = skillDraftConfirmMatch;
      const result = await confirmSkillDraftRecord(draftId);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : "Failed to confirm skill draft.",
      });
    }
    return;
  }

  const skillDraftRejectMatch = pathname.match(/^\/api\/skill-drafts\/([^/]+)\/reject$/);
  if (skillDraftRejectMatch && req.method === "POST") {
    try {
      const [, draftId] = skillDraftRejectMatch;
      const result = await rejectSkillDraftRecord(draftId);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : "Failed to reject skill draft.",
      });
    }
    return;
  }

  if (pathname === "/api/tasks" && req.method === "GET") {
    sendJson(
      res,
      200,
      await loadTasksFeed({
        before: searchParams.get("before"),
        limit: searchParams.get("limit") || "50",
        projectId: searchParams.get("project_id"),
        queryText: searchParams.get("q"),
        state: searchParams.get("state"),
      })
    );
    return;
  }

  if (pathname === "/api/live-activity" && req.method === "GET") {
    sendJson(res, 200, await loadLiveActivity());
    return;
  }

  if (pathname === "/api/tasks" && req.method === "POST") {
    const body = await readJson(req);
    const assignedRole = normalizeString(body.assigned_role).toLowerCase();
    const title = normalizeString(body.title);
    const objective = normalizeString(body.objective);

    if (!title || !objective || !assignedRole) {
      sendJson(res, 400, { error: "title, objective, and assigned_role are required" });
      return;
    }

    const role = await postgrest("/roles", {
      query: { id: `eq.${assignedRole}`, limit: "1", select: "id" },
    });
    if (!role?.[0]?.id) {
      sendJson(res, 400, { error: `Role '${assignedRole}' does not exist` });
      return;
    }

    const rows = await postgrest("/tasks", {
      body: {
        acceptance_criteria: Array.isArray(body.acceptance_criteria)
          ? body.acceptance_criteria.map((entry) => String(entry))
          : [],
        assigned_role: assignedRole,
        customer_id: normalizeString(body.customer_id) || null,
        department_id: normalizeString(body.department_id) || null,
        objective,
        parent_task_id: normalizeString(body.parent_task_id) || null,
        priority: normalizeString(body.priority, "normal") || "normal",
        project_id: normalizeString(body.project_id) || null,
        state: "ready",
        title,
      },
      method: "POST",
      preferRepresentation: true,
    });

    sendJson(res, 201, rows?.[0] || null);
    return;
  }

  const taskEditMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskEditMatch && req.method === "PATCH") {
    const [, taskId] = taskEditMatch;
    const body = await readJson(req);
    const patch = {};

    if (typeof body.title === "string" && body.title.trim()) {
      patch.title = body.title.trim();
    }
    if (typeof body.objective === "string" && body.objective.trim()) {
      patch.objective = body.objective.trim();
    }
    if (Array.isArray(body.acceptance_criteria)) {
      patch.acceptance_criteria = body.acceptance_criteria
        .map((entry) => normalizeString(entry))
        .filter(Boolean);
    }
    if (
      typeof body.assigned_role === "string" &&
      body.assigned_role.trim()
    ) {
      patch.assigned_role = body.assigned_role.trim().toLowerCase();
    }
    if (
      typeof body.priority === "string" &&
      TASK_PRIORITY_OPTIONS.has(body.priority.trim().toLowerCase())
    ) {
      patch.priority = body.priority.trim().toLowerCase();
    }
    if (typeof body.project_id === "string") {
      patch.project_id = body.project_id.trim() || null;
    }
    if (typeof body.customer_id === "string") {
      patch.customer_id = body.customer_id.trim() || null;
    }
    if (typeof body.department_id === "string") {
      patch.department_id = body.department_id.trim() || null;
    }
    if (typeof body.parent_task_id === "string") {
      patch.parent_task_id = body.parent_task_id.trim() || null;
    }
    if (typeof body.due_at === "string") {
      patch.due_at = body.due_at.trim() || null;
    }

    const rows = await postgrest("/tasks", {
      body: patch,
      method: "PATCH",
      preferRepresentation: true,
      query: { id: `eq.${taskId}` },
    });
    sendJson(res, 200, rows?.[0] || null);
    return;
  }

  const taskRunsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/runs$/);
  if (taskRunsMatch && req.method === "GET") {
    const [, taskId] = taskRunsMatch;
    sendJson(res, 200, await loadTaskRuns(taskId));
    return;
  }

  const taskFullMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/full$/);
  if (taskFullMatch && req.method === "GET") {
    const [, taskId] = taskFullMatch;
    const [contextPack, taskRuns] = await Promise.all([
      postgrest("/rpc/build_context_pack", {
        body: { p_task_id: taskId },
        method: "POST",
      }),
      loadTaskRuns(taskId),
    ]);
    const task = contextPack?.task || null;
    const parentTask =
      task?.parent_task_id
        ? (
            await postgrest("/tasks", {
              query: {
                id: `eq.${task.parent_task_id}`,
                limit: "1",
                select:
                  "id,title,state,priority,assigned_role,parent_task_id,project_id,customer_id,department_id,created_at,updated_at",
              },
            })
          )?.[0] || null
        : null;

    sendJson(res, 200, {
      artifacts: contextPack?.related_artifacts || [],
      child_tasks: contextPack?.child_tasks || [],
      parent_task: parentTask,
      project: contextPack?.project || null,
      related_events: contextPack?.recent_events || [],
      related_memories: contextPack?.related_memories || [],
      task,
      task_runs: taskRuns,
    });
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
    const data = await loadAgentsWithRoleProfiles();
    sendJson(res, 200, data || []);
    return;
  }

  if (pathname === "/api/agents" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const name = requireTrimmedString(body.name, "name");
      const roleId = getOptionalTrimmedString(body.role_id)
        ? normalizeSlug(body.role_id, "role_id")
        : await allocateAgentRoleId(name);

      const existingAgent = await loadAgentByRoleId(roleId);
      if (existingAgent) {
        sendJson(res, 409, {
          error:
            "An agent already owns this runtime profile. Edit the existing agent instead.",
        });
        return;
      }

      const existingRole = await loadRoleById(roleId);
      if (existingRole) {
        const rolePatch = buildRoleProfilePatch(body, {
          displayNameFallback: name,
        });
        if (Object.keys(rolePatch).length > 0) {
          await postgrest("/roles", {
            body: rolePatch,
            method: "PATCH",
            preferRepresentation: true,
            query: { id: `eq.${roleId}` },
          });
        }
      } else {
        await postgrest("/roles", {
          body: {
            ...buildRoleProfilePatch(body, {
              displayNameFallback: name,
              requireCreate: true,
            }),
            id: roleId,
            is_system_role: false,
          },
          method: "POST",
          preferRepresentation: true,
        });
      }

      const rows = await postgrest("/agents", {
        body: {
          config: body.config && typeof body.config === "object" ? body.config : {},
          name,
          role_id: roleId,
          status: AGENT_STATUS_OPTIONS.has(normalizeString(body.status))
            ? normalizeString(body.status)
            : "active",
        },
        method: "POST",
        preferRepresentation: true,
      });
      const created = rows?.[0]?.id
        ? await loadAgentWithRoleProfile(rows[0].id)
        : null;
      sendJson(res, 201, created);
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : "Failed to create agent.",
      });
    }
    return;
  }

  const agentActivityMatch = pathname.match(/^\/api\/agents\/([^/]+)\/activity$/);
  if (agentActivityMatch && req.method === "GET") {
    const [, agentId] = agentActivityMatch;
    const [agents, taskRuns, events] = await Promise.all([
      loadAgentWithRoleProfile(agentId),
      postgrest("/task_runs", {
        query: {
          agent_id: `eq.${agentId}`,
          limit: "20",
          order: "started_at.desc",
          select:
            "id,task_id,agent_id,trace_id,status,context_pack,outcome,handoff_note,model_used,effort_used,error_message,started_at,finished_at,created_at",
        },
      }),
      postgrest("/events", {
        query: {
          agent_id: `eq.${agentId}`,
          limit: "20",
          order: "created_at.desc",
          select: "*",
        },
      }),
    ]);
    const taskIds = [...new Set((taskRuns || []).map((run) => run.task_id).filter(Boolean))];
    const tasks = taskIds.length
      ? await postgrest("/tasks", {
          query: {
            id: `in.(${taskIds.join(",")})`,
            select: "id,title",
          },
        })
      : [];
    const taskMap = new Map((tasks || []).map((task) => [task.id, task.title]));
    sendJson(res, 200, {
      agent: agents || null,
      events: events || [],
      task_runs: (taskRuns || []).map((run) => ({
        ...run,
        duration_ms:
          run.finished_at && run.started_at
            ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
            : null,
        task_title: taskMap.get(run.task_id) || null,
      })),
    });
    return;
  }

  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch && req.method === "GET") {
    const [, agentId] = agentMatch;
    const data = await loadAgentWithRoleProfile(agentId);
    sendJson(res, 200, data || null);
    return;
  }

  if (agentMatch && req.method === "PATCH") {
    try {
      const [, agentId] = agentMatch;
      const body = await readJson(req);
      const currentAgent = await loadAgentById(agentId);

      if (!currentAgent) {
        sendJson(res, 404, { error: "Agent not found" });
        return;
      }

      const patch = {};

      if (typeof body.name === "string" && body.name.trim()) {
        patch.name = body.name.trim();
      }
      if (typeof body.role_id === "string" && body.role_id.trim()) {
        patch.role_id = normalizeSlug(body.role_id, "role_id");
      }
      if (
        typeof body.status === "string" &&
        AGENT_STATUS_OPTIONS.has(body.status.trim())
      ) {
        patch.status = body.status.trim();
      }
      if (body.config && typeof body.config === "object") {
        patch.config = body.config;
      }

      const nextRoleId = patch.role_id || currentAgent.role_id;
      const rolePatch = buildRoleProfilePatch(body, {
        displayNameFallback: patch.name,
      });

      if (Object.keys(rolePatch).length > 0 || nextRoleId !== currentAgent.role_id) {
        if (nextRoleId !== currentAgent.role_id) {
          const existingOwner = await loadAgentByRoleId(nextRoleId);
          if (existingOwner && existingOwner.id !== agentId) {
            sendJson(res, 409, {
              error:
                "Another agent already owns that runtime profile. Edit that agent instead.",
            });
            return;
          }
        }
        const targetRole = await loadRoleById(nextRoleId);
        if (!targetRole) {
          sendJson(res, 400, { error: "Backing agent profile was not found." });
          return;
        }
      }

      if (Object.keys(rolePatch).length > 0) {
        await postgrest("/roles", {
          body: rolePatch,
          method: "PATCH",
          preferRepresentation: true,
          query: { id: `eq.${nextRoleId}` },
        });
      }

      if (Object.keys(patch).length > 0) {
        await postgrest("/agents", {
          body: patch,
          method: "PATCH",
          preferRepresentation: true,
          query: { id: `eq.${agentId}` },
        });
      }

      const updated = await loadAgentWithRoleProfile(agentId);
      sendJson(res, 200, updated || null);
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : "Failed to update agent.",
      });
    }
    return;
  }

  if (pathname === "/api/roles" && req.method === "GET") {
    const data = await postgrest("/roles", {
      query: { order: "id.asc", select: "*" },
    });
    sendJson(res, 200, data || []);
    return;
  }

  if (pathname === "/api/roles" && req.method === "POST") {
    const body = await readJson(req);
    const roleId = normalizeString(body.id).toLowerCase();
    if (
      !roleId ||
      !normalizeString(body.display_name) ||
      !normalizeString(body.description) ||
      !normalizeString(body.policy_doc)
    ) {
      sendJson(res, 400, {
        error: "id, display_name, description, and policy_doc are required",
      });
      return;
    }

    const model = normalizeString(body.model, "sonnet").toLowerCase();
    const effort = normalizeString(body.effort, "medium").toLowerCase();
    const rows = await postgrest("/roles", {
      body: {
        description: body.description.trim(),
        display_name: body.display_name.trim(),
        effort: EFFORT_OPTIONS.has(effort) ? effort : "medium",
        handoff_when: normalizeString(body.handoff_when),
        id: roleId,
        is_system_role: false,
        max_concurrent_tasks: Number(body.max_concurrent_tasks || 3),
        model: MODEL_OPTIONS.has(model) ? model : "sonnet",
        policy_doc: body.policy_doc.trim(),
        usage_summary: normalizeString(body.usage_summary),
      },
      method: "POST",
      preferRepresentation: true,
    });
    sendJson(res, 201, rows?.[0] || null);
    return;
  }

  const roleMatch = pathname.match(/^\/api\/roles\/([^/]+)$/);
  if (roleMatch && req.method === "GET") {
    const [, roleId] = roleMatch;
    const data = await postgrest("/roles", {
      query: { id: `eq.${roleId}`, limit: "1", select: "*" },
    });
    sendJson(res, 200, data?.[0] || null);
    return;
  }

  if (roleMatch && req.method === "PATCH") {
    const [, roleId] = roleMatch;
    const body = await readJson(req);
    const patch = {};
    for (const field of [
      "description",
      "handoff_when",
      "policy_doc",
      "usage_summary",
    ]) {
      if (typeof body[field] === "string") {
        patch[field] = body[field].trim();
      }
    }
    if (typeof body.model === "string" && MODEL_OPTIONS.has(body.model.trim())) {
      patch.model = body.model.trim();
    }
    if (typeof body.effort === "string" && EFFORT_OPTIONS.has(body.effort.trim())) {
      patch.effort = body.effort.trim();
    }
    if (body.max_concurrent_tasks !== undefined) {
      patch.max_concurrent_tasks = Math.max(1, Number(body.max_concurrent_tasks || 1));
    }

    const rows = await postgrest("/roles", {
      body: patch,
      method: "PATCH",
      preferRepresentation: true,
      query: { id: `eq.${roleId}` },
    });
    sendJson(res, 200, rows?.[0] || null);
    return;
  }

  if (pathname === "/api/memories" && req.method === "GET") {
    const query = searchParams.get("q");
    const before = searchParams.get("before");
    const layer = searchParams.get("layer");
    const scopeType = searchParams.get("scope_type");
    const scopeId = searchParams.get("scope_id");
    const mode = searchParams.get("mode");
    const rawLimit = Number.parseInt(searchParams.get("limit") || "50", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(rawLimit, 200))
      : 50;
    const data = await postgrest("/memories", {
      query: {
        ...(before ? { created_at: `lt.${before}` } : {}),
        ...(query ? { subject: `ilike.*${query}*` } : {}),
        ...(layer ? { layer: `eq.${layer}` } : {}),
        ...(scopeType ? { scope_type: `eq.${scopeType}` } : {}),
        ...(scopeId ? { scope_id: `eq.${scopeId}` } : {}),
        is_active: "eq.true",
        limit: String(limit),
        order: "created_at.desc",
        select: "*",
      },
    });
    const filtered =
      mode === "knowledge" || mode === "knowledge_base"
        ? (data || []).filter((memory) => isKnowledgeBaseMemory(memory))
        : data || [];
    sendJson(res, 200, filtered);
    return;
  }

  if (pathname === "/api/memories/bulk-import" && req.method === "POST") {
    const body = await readJson(req);
    const splitMode = normalizeString(body.split_mode, "paragraph").toLowerCase();
    const chunks = splitKnowledgeImportContent(body.content, splitMode);

    if (!chunks.length) {
      sendJson(res, 400, { error: "content must contain at least one importable fact" });
      return;
    }

    const scopeType = normalizeString(body.scope_type, "company").toLowerCase();
    const scopeId = normalizeString(body.scope_id, scopeType === "company" ? "system" : "");
    const tags = normalizeStringArray(body.tags);
    const confidence = Number(body.confidence ?? 1);
    const created = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const content = chunks[index];
      const rows = await postgrest("/memories", {
        body: {
          confidence,
          content,
          is_active: true,
          layer: "semantic",
          scope_id: scopeId,
          scope_type: scopeType,
          source_agent_id: null,
          subject: deriveImportedMemorySubject(content, body.subject_prefix, index),
          tags,
        },
        method: "POST",
        preferRepresentation: true,
      });
      const memory = rows?.[0] || null;
      if (!memory?.id) {
        continue;
      }

      await upsertMemoryChunk(
        memory.id,
        memory.scope_type,
        memory.scope_id,
        `${memory.subject}: ${memory.content}`
      );
      created.push(memory);
    }

    sendJson(res, 201, {
      count: created.length,
      memories: created,
      split_mode: splitMode === "sentence" ? "sentence" : "paragraph",
    });
    return;
  }

  if (pathname === "/api/memories" && req.method === "POST") {
    const body = await readJson(req);
    const layer = normalizeString(body.layer).toLowerCase();
    if (!MEMORY_LAYER_OPTIONS.has(layer)) {
      sendJson(res, 400, { error: "layer must be episodic, semantic, or procedural" });
      return;
    }

    const rows = await postgrest("/memories", {
      body: {
        confidence: Number(body.confidence ?? 1),
        content: normalizeString(body.content),
        is_active: true,
        layer,
        scope_id: normalizeString(body.scope_id),
        scope_type: normalizeString(body.scope_type),
        source_agent_id: null,
        subject: normalizeString(body.subject),
        tags: normalizeStringArray(body.tags),
      },
      method: "POST",
      preferRepresentation: true,
    });
    const memory = rows?.[0] || null;
    if (memory?.id) {
      await upsertMemoryChunk(
        memory.id,
        memory.scope_type,
        memory.scope_id,
        `${memory.subject}: ${memory.content}`
      );
    }
    sendJson(res, 201, memory);
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

  const memoryMatch = pathname.match(/^\/api\/memories\/([^/]+)$/);
  if (memoryMatch && req.method === "PATCH") {
    const [, memoryId] = memoryMatch;
    const body = await readJson(req);
    const patch = {};
    if (typeof body.subject === "string") patch.subject = body.subject.trim();
    if (typeof body.content === "string") patch.content = body.content.trim();
    if (Array.isArray(body.tags)) patch.tags = normalizeStringArray(body.tags);
    if (body.confidence !== undefined) patch.confidence = Number(body.confidence);

    const rows = await postgrest("/memories", {
      body: patch,
      method: "PATCH",
      preferRepresentation: true,
      query: { id: `eq.${memoryId}` },
    });
    const memory = rows?.[0] || null;
    if (memory?.id) {
      await upsertMemoryChunk(
        memory.id,
        memory.scope_type,
        memory.scope_id,
        `${memory.subject}: ${memory.content}`
      );
    }
    sendJson(res, 200, memory);
    return;
  }

  if (pathname === "/api/events" && req.method === "GET") {
    const before = searchParams.get("before");
    const eventType = normalizeString(searchParams.get("event_type"));
    const severity = normalizeString(searchParams.get("severity"));
    const agentId = normalizeString(searchParams.get("agent_id"));
    const dateFrom = startOfDayIso(normalizeString(searchParams.get("date_from")));
    const dateTo = endOfDayIso(normalizeString(searchParams.get("date_to")));
    const rawLimit = Number.parseInt(searchParams.get("limit") || "50", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(rawLimit, 200))
      : 50;
    const data = await postgrest("/events", {
      query: {
        ...(agentId ? { agent_id: `eq.${agentId}` } : {}),
        ...(before ? { created_at: `lt.${before}` } : {}),
        ...(dateFrom ? { created_at: `gte.${dateFrom}` } : {}),
        ...(dateTo ? { created_at: `lte.${dateTo}` } : {}),
        ...(eventType ? { event_type: `ilike.*${eventType}*` } : {}),
        limit: String(limit),
        order: "created_at.desc",
        ...(severity ? { severity: `eq.${severity}` } : {}),
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
          "id,service_name,display_name,description,base_url,auth_type,status,error_message,last_verified,updated_at",
      },
    });
    sendJson(res, 200, data || []);
    return;
  }

  if (pathname === "/api/services" && req.method === "POST") {
    const body = await readJson(req);
    const credential = normalizeString(body.credential);
    const rows = await postgrest("/service_registry", {
      body: {
        auth_type: normalizeString(body.auth_type, "api_key") || "api_key",
        base_url: normalizeString(body.base_url) || null,
        credential: credential || null,
        description: normalizeString(body.description),
        display_name: normalizeString(body.display_name),
        last_verified: credential ? new Date().toISOString() : null,
        service_name: normalizeString(body.service_name).toLowerCase(),
        status: credential ? "active" : "key_needed",
      },
      method: "POST",
      preferRepresentation: true,
    });
    sendJson(res, 201, rows?.[0] || null);
    return;
  }

  const serviceEditMatch = pathname.match(/^\/api\/services\/([^/]+)$/);
  if (serviceEditMatch && req.method === "PATCH") {
    const [, serviceId] = serviceEditMatch;
    const body = await readJson(req);
    const patch = {};
    for (const field of ["display_name", "description", "base_url", "auth_type", "status"]) {
      if (typeof body[field] === "string") {
        patch[field] = body[field].trim();
      }
    }
    if (typeof body.credential === "string") {
      patch.credential = body.credential.trim();
      patch.last_verified = new Date().toISOString();
      patch.status = "active";
    }
    const rows = await postgrest("/service_registry", {
      body: patch,
      method: "PATCH",
      preferRepresentation: true,
      query: { id: `eq.${serviceId}` },
    });
    sendJson(res, 200, rows?.[0] || null);
    return;
  }

  if (serviceEditMatch && req.method === "DELETE") {
    const [, serviceId] = serviceEditMatch;
    await postgrest("/service_registry", {
      method: "DELETE",
      query: { id: `eq.${serviceId}` },
    });
    sendNoContent(res);
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

  if (pathname === "/api/usage/summary" && req.method === "GET") {
    sendJson(res, 200, await buildUsageSummary());
    return;
  }

  if (pathname === "/api/artifacts" && req.method === "GET") {
    const rawLimit = Number.parseInt(searchParams.get("limit") || "50", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(rawLimit, 200))
      : 50;
    const data = await postgrest("/artifacts", {
      query: {
        ...(searchParams.get("artifact_type")
          ? { artifact_type: `eq.${searchParams.get("artifact_type")}` }
          : {}),
        ...(searchParams.get("project_id")
          ? { project_id: `eq.${searchParams.get("project_id")}` }
          : {}),
        ...(searchParams.get("task_id")
          ? { task_id: `eq.${searchParams.get("task_id")}` }
          : {}),
        limit: String(limit),
        order: "created_at.desc",
        select:
          "id,project_id,task_id,artifact_type,name,storage_path,external_url,mime_type,size_bytes,metadata,created_by,created_at",
      },
    });
    sendJson(res, 200, data || []);
    return;
  }

  const artifactMatch = pathname.match(/^\/api\/artifacts\/([^/]+)$/);
  if (artifactMatch && req.method === "GET") {
    const [, artifactId] = artifactMatch;
    const data = await postgrest("/artifacts", {
      query: {
        id: `eq.${artifactId}`,
        limit: "1",
        select:
          "id,project_id,task_id,artifact_type,name,storage_path,external_url,mime_type,size_bytes,metadata,created_by,created_at",
      },
    });
    sendJson(res, 200, data?.[0] || null);
    return;
  }

  if (pathname === "/api/projects" && req.method === "GET") {
    sendJson(res, 200, await loadProjectsWithStats());
    return;
  }

  if (pathname === "/api/projects" && req.method === "POST") {
    const body = await readJson(req);
    const rows = await postgrest("/projects", {
      body: {
        description: normalizeString(body.description),
        display_name: normalizeString(body.display_name),
        repo_url: normalizeString(body.repo_url) || null,
        slug: normalizeString(body.slug).toLowerCase(),
      },
      method: "POST",
      preferRepresentation: true,
    });
    sendJson(res, 201, rows?.[0] || null);
    return;
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && req.method === "PATCH") {
    const [, projectId] = projectMatch;
    const body = await readJson(req);
    const patch = {};
    for (const field of ["description", "display_name", "repo_url", "slug"]) {
      if (typeof body[field] === "string") {
        patch[field] = field === "slug" ? body[field].trim().toLowerCase() : body[field].trim();
      }
    }
    const rows = await postgrest("/projects", {
      body: patch,
      method: "PATCH",
      preferRepresentation: true,
      query: { id: `eq.${projectId}` },
    });
    sendJson(res, 200, rows?.[0] || null);
    return;
  }

  if (pathname === "/api/skills" && req.method === "GET") {
    const rawLimit = Number.parseInt(searchParams.get("limit") || "100", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(rawLimit, 200))
      : 100;
    const skillQuery = normalizeString(searchParams.get("q"));
    const rows = await postgrest("/memories", {
      query: {
        ...(skillQuery
          ? { or: `(subject.ilike.*${skillQuery}*,content.ilike.*${skillQuery}*)` }
          : {}),
        ...(searchParams.get("scope_type")
          ? { scope_type: `eq.${searchParams.get("scope_type")}` }
          : {}),
        contains: undefined,
        is_active: "eq.true",
        layer: "eq.procedural",
        limit: String(limit),
        order: "updated_at.desc",
        select:
          "id,subject,content,tags,scope_type,scope_id,is_active,created_at,updated_at,superseded_by,source_agent_id",
      },
    });
    const requiredTags = normalizeStringArray(
      String(searchParams.get("tags") || "")
        .split(",")
        .map((part) => part.trim())
    );
    const skills = (rows || [])
      .filter((row) => Array.isArray(row.tags) && row.tags.includes(SKILL_TAG))
      .map(parseSkillMemory)
      .filter((skill) =>
        requiredTags.length ? requiredTags.every((tag) => skill.tags.includes(tag)) : true
      );
    sendJson(res, 200, skills);
    return;
  }

  if (pathname === "/api/skills" && req.method === "POST") {
    const body = await readJson(req);
    const name = normalizeString(body.name).replace(/^skill:/, "");
    const tags = [SKILL_TAG, ...normalizeStringArray(body.tags)];
    const scopeType = normalizeString(body.scope_type, "company") || "company";
    const scopeId =
      scopeType === "company"
        ? normalizeString(body.scope_id, "system") || "system"
        : normalizeString(body.scope_id);
    const rows = await postgrest("/memories", {
      body: {
        content: buildSkillContent(body, 1),
        layer: "procedural",
        scope_id: scopeId,
        scope_type: scopeType,
        source_agent_id: null,
        subject: `skill:${name}`,
        tags,
      },
      method: "POST",
      preferRepresentation: true,
    });
    const memory = rows?.[0] || null;
    if (memory?.id) {
      await upsertMemoryChunk(
        memory.id,
        memory.scope_type,
        memory.scope_id,
        buildSkillChunkContent({ ...body, name })
      );
    }
    sendJson(res, 201, memory ? parseSkillMemory(memory) : null);
    return;
  }

  const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
  if (skillMatch && req.method === "GET") {
    const [, skillId] = skillMatch;
    const data = await postgrest("/memories", {
      query: {
        id: `eq.${skillId}`,
        limit: "1",
        select:
          "id,subject,content,tags,scope_type,scope_id,is_active,created_at,updated_at,superseded_by,source_agent_id",
      },
    });
    const memory = data?.[0] || null;
    if (!memory) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }
    const versions = await postgrest("/memories", {
      query: {
        layer: "eq.procedural",
        scope_id: `eq.${memory.scope_id}`,
        scope_type: `eq.${memory.scope_type}`,
        subject: `eq.${memory.subject}`,
        order: "created_at.desc",
        select:
          "id,subject,content,tags,scope_type,scope_id,is_active,created_at,updated_at,superseded_by,source_agent_id",
      },
    });
    sendJson(res, 200, {
      skill: parseSkillMemory(memory),
      versions: (versions || []).map((version) => {
        const parsed = parseSkillMemory(version);
        return {
          created_at: parsed.created_at,
          id: parsed.id,
          is_active: parsed.is_active,
          updated_at: parsed.updated_at,
          use_count: parsed.use_count,
          version: parsed.version,
        };
      }),
    });
    return;
  }

  if (skillMatch && req.method === "PATCH") {
    const [, skillId] = skillMatch;
    const body = await readJson(req);
    const existing = await postgrest("/memories", {
      query: {
        id: `eq.${skillId}`,
        limit: "1",
        select:
          "id,subject,content,tags,scope_type,scope_id,is_active,created_at,updated_at,superseded_by,source_agent_id",
      },
    });
    const previous = existing?.[0] || null;
    if (!previous) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }
    const previousSkill = parseSkillMemory(previous);
    const rows = await postgrest("/memories", {
      body: {
        content: buildSkillContent(
          {
            ...previousSkill,
            ...body,
            last_used_at: previousSkill.last_used_at,
            use_count: previousSkill.use_count,
          },
          previousSkill.version + 1
        ),
        layer: "procedural",
        scope_id: previous.scope_id,
        scope_type: previous.scope_type,
        source_agent_id: null,
        subject: previous.subject,
        superseded_by: null,
        tags: [SKILL_TAG, ...normalizeStringArray(body.tags || previous.tags)],
      },
      method: "POST",
      preferRepresentation: true,
    });
    const memory = rows?.[0] || null;
    if (memory?.id) {
      await postgrest("/memories", {
        body: { is_active: false, superseded_by: memory.id },
        method: "PATCH",
        query: { id: `eq.${skillId}` },
      });
      await upsertMemoryChunk(
        memory.id,
        memory.scope_type,
        memory.scope_id,
        buildSkillChunkContent({
          ...previousSkill,
          ...body,
          name: previousSkill.name,
        })
      );
    }
    sendJson(res, 200, memory ? parseSkillMemory(memory) : null);
    return;
  }

  if (skillMatch && req.method === "DELETE") {
    const [, skillId] = skillMatch;
    await postgrest("/memories", {
      body: { is_active: false },
      method: "PATCH",
      query: { id: `eq.${skillId}` },
    });
    sendNoContent(res);
    return;
  }

  if (pathname === "/api/settings/agent-instructions" && req.method === "GET") {
    const setting = await getSystemSetting("agent_instructions_override");
    sendJson(res, 200, {
      content:
        typeof setting?.value?.content === "string" ? setting.value.content : "",
      updated_at: setting?.updated_at || null,
    });
    return;
  }

  if (pathname === "/api/settings/agent-instructions" && req.method === "PATCH") {
    const body = await readJson(req);
    const content = typeof body.content === "string" ? body.content : "";
    await saveSystemSetting("agent_instructions_override", { content });
    sendJson(res, 200, {
      content,
      updated_at: new Date().toISOString(),
    });
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
        query: { state: "eq.blocked_on_agent" },
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
        blocked_on_agent: blocked,
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
