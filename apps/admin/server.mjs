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
const SUPERVISOR_HEALTH_URL =
  process.env.SUPERVISOR_HEALTH_URL || "http://supervisor:3001/health";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const SESSION_SECRET = process.env.JWT_SECRET || "agent-os-admin";
const SESSION_COOKIE = "agent_os_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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

  const response = await fetch(url, {
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

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

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
    const data = await postgrest("/messages", {
      query: {
        channel: `eq.${channel}`,
        limit: "100",
        order: "created_at.asc",
        select: "id,direction,sender,content,created_at,task_id,metadata",
      },
    });
    sendJson(res, 200, data || []);
    return;
  }

  if (pathname === "/api/messages" && req.method === "POST") {
    const body = await readJson(req);
    await postgrest("/messages", {
      body: {
        channel: "admin_chat",
        content: body.content,
        direction: "inbound",
        metadata: {},
        sender: "operator",
      },
      method: "POST",
    });
    sendNoContent(res);
    return;
  }

  if (pathname === "/api/tasks" && req.method === "GET") {
    const state = searchParams.get("state");
    const data = await postgrest("/tasks", {
      query: {
        ...(state && state !== "all" ? { state: `eq.${state}` } : {}),
        limit: "200",
        order: "created_at.desc",
        select:
          "id,title,state,priority,assigned_role,claimed_by,attempt_count,last_handoff_note,created_at,blocked_reason",
      },
    });
    sendJson(res, 200, data || []);
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
    const data = await postgrest("/memories", {
      query: {
        ...(query ? { subject: `ilike.*${query}*` } : {}),
        is_active: "eq.true",
        limit: "100",
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
    const data = await postgrest("/events", {
      query: {
        limit: "200",
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
});
