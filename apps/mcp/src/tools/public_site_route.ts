import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveComposeRuntime, runDocker } from "../compose_runtime.js";
import { getAgentContext } from "../context.js";
import { getDb } from "../db.js";
import { requireCurrentTaskContext } from "../scope.js";
import { upsertTaskRequirement } from "../task_requirements.js";

type RouteAction = "delete" | "upsert" | "verify";
type DesiredRouteState = "active" | "removed";
type ObservedRouteState = "active" | "error" | "pending" | "removed";

interface RouteRow {
  desired_state: DesiredRouteState;
  hostname: string;
  id: string;
  target_path: string | null;
}

export const publicSiteRouteDef = {
  name: "public_site_route",
  description:
    "Create, verify, update, or remove a tracked Caddy subdomain snippet that serves a path from the public site service, then record external verification.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        description: "One of: upsert, delete, verify.",
        enum: ["upsert", "delete", "verify"],
      },
      hostname: {
        type: "string",
        description:
          "Full hostname under the configured root domain, for example weather.dploy.cc.",
      },
      target_path: {
        type: "string",
        description:
          "Absolute path served by the public site container, for example /weather. Required for upsert.",
      },
      reload: {
        type: "boolean",
        description: "When true, reload Caddy after writing the snippet.",
      },
    },
    required: ["action", "hostname"],
  },
};

export async function publicSiteRoute(args: {
  action?: string;
  hostname?: string;
  target_path?: string;
  reload?: boolean;
}): Promise<unknown> {
  const db = getDb();
  const task = await requireCurrentTaskContext();
  const action = normalizeAction(args.action);
  const rootDomain = normalizeRootDomain(process.env.ROOT_DOMAIN);
  const snippetsDir = normalizeSnippetsDir(process.env.CADDY_SITE_SNIPPETS_DIR);
  const hostname = normalizeHostname(args.hostname, rootDomain);
  const snippetPath = join(snippetsDir, `${hostname}.caddy`);
  const routeRow = await loadRoute(hostname);

  let previousContents: string | null = null;
  let nextContents: string | null = null;
  let targetPath = routeRow?.target_path || null;

  try {
    previousContents = await readFile(snippetPath, "utf8");
  } catch {
    previousContents = null;
  }

  if (action === "delete") {
    await rm(snippetPath, { force: true });
    targetPath = null;
  } else if (action === "upsert") {
    targetPath = normalizeTargetPath(args.target_path);
    nextContents = buildSnippet(hostname, targetPath);
    await mkdir(snippetsDir, { recursive: true });
    await writeFile(snippetPath, nextContents, "utf8");
  }

  const shouldReload =
    typeof args.reload === "boolean" ? args.reload : action !== "verify";
  let reloadResult: Record<string, unknown> | null = null;
  if (shouldReload) {
    reloadResult = reloadCaddy();
  }

  const desiredState = resolveDesiredState(action, routeRow, previousContents);
  const verification = await verifyHostname(hostname, desiredState);

  const trackedRoute = await upsertRouteRow({
    desiredState,
    hostname,
    observedState: verification.observed_state as ObservedRouteState,
    targetPath,
    taskId: task.id,
    verification,
  });

  const requirement = await upsertTaskRequirement({
    expected: {
      desired_state: desiredState,
      target_path: targetPath,
    },
    lastResult: verification,
    requirementType: "public_route",
    status: verification.matches_expectation ? "passed" : "failed",
    target: hostname,
    taskId: task.id,
  });

  await logRouteEvent({
    action,
    hostname,
    previousContents,
    reloadResult,
    requirementId: String(requirement.id || ""),
    snippetPath,
    targetPath,
    taskId: task.id,
    verification,
  });

  return {
    success: true,
    action,
    changed: previousContents !== (action === "delete" ? null : nextContents),
    hostname,
    reloaded: shouldReload,
    reload_result: reloadResult,
    route: trackedRoute,
    snippet_path: snippetPath,
    target_path: targetPath,
    task_requirement: requirement,
    verification,
  };
}

function normalizeAction(value: string | undefined): RouteAction {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (normalized === "upsert" || normalized === "delete" || normalized === "verify") {
    return normalized;
  }

  throw new Error("public_site_route requires action=upsert|delete|verify");
}

function normalizeRootDomain(value: string | undefined): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");

  if (!normalized) {
    throw new Error("public_site_route requires ROOT_DOMAIN to be configured");
  }

  return normalized;
}

function normalizeSnippetsDir(value: string | undefined): string {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error("public_site_route requires CADDY_SITE_SNIPPETS_DIR to be configured");
  }
  return normalized;
}

function normalizeHostname(value: string | undefined, rootDomain: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");

  if (!normalized) {
    throw new Error("public_site_route requires hostname");
  }

  if (!/^[a-z0-9.-]+$/.test(normalized)) {
    throw new Error(`Invalid hostname '${normalized}'`);
  }

  if (!normalized.endsWith(`.${rootDomain}`)) {
    throw new Error(`Hostname '${normalized}' must be under ${rootDomain}`);
  }

  if (normalized === rootDomain) {
    throw new Error("public_site_route only manages subdomains, not the root domain");
  }

  return normalized;
}

function normalizeTargetPath(value: string | undefined): string {
  const normalized = String(value || "").trim();

  if (!normalized) {
    throw new Error("public_site_route upsert requires target_path");
  }

  if (!normalized.startsWith("/")) {
    throw new Error("target_path must start with '/'");
  }

  if (/[?#]/.test(normalized)) {
    throw new Error("target_path must not include a query string or fragment");
  }

  if (normalized === "/") {
    return normalized;
  }

  return normalized.replace(/\/+$/, "");
}

function buildSnippet(hostname: string, targetPath: string): string {
  const lines = [`${hostname} {`, "  encode zstd gzip"];

  if (targetPath !== "/") {
    lines.push(`  rewrite * ${targetPath}{uri}`);
  }

  lines.push("  reverse_proxy public:80", "}", "");
  return lines.join("\n");
}

function reloadCaddy(): Record<string, unknown> {
  const runtime = resolveComposeRuntime();
  const containerId = runDocker([
    "ps",
    "-aq",
    "--no-trunc",
    "--filter",
    `label=com.docker.compose.project=${runtime.project}`,
    "--filter",
    "label=com.docker.compose.service=caddy",
    "--latest",
  ]).trim();

  if (!containerId) {
    throw new Error(`No running caddy service found for project '${runtime.project}'`);
  }

  runDocker(["exec", containerId, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"]);

  return {
    container_id: containerId,
    project: runtime.project,
    service: "caddy",
    state: "reloaded",
  };
}

function resolveDesiredState(
  action: RouteAction,
  route: RouteRow | null,
  snippetContents: string | null
): DesiredRouteState {
  if (action === "upsert") {
    return "active";
  }

  if (action === "delete") {
    return "removed";
  }

  if (route?.desired_state) {
    return route.desired_state;
  }

  return snippetContents ? "active" : "removed";
}

async function verifyHostname(
  hostname: string,
  desiredState: DesiredRouteState
): Promise<Record<string, unknown>> {
  const url = `https://${hostname}/`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await response.text();
    const observedState: ObservedRouteState =
      response.status >= 400 ? "removed" : "active";
    const matchesExpectation =
      desiredState === "active"
        ? observedState === "active"
        : observedState === "removed";

    return {
      checked_at: new Date().toISOString(),
      content_type: response.headers.get("content-type"),
      final_url: response.url,
      http_status: response.status,
      matches_expectation: matchesExpectation,
      observed_state: matchesExpectation || desiredState === "removed" ? observedState : "error",
      response_snippet: body.slice(0, 200),
      url,
    };
  } catch (error) {
    const observedState: ObservedRouteState = "removed";
    return {
      checked_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      final_url: url,
      http_status: null,
      matches_expectation: desiredState === "removed",
      observed_state: desiredState === "removed" ? observedState : "error",
      url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function loadRoute(hostname: string): Promise<RouteRow | null> {
  const db = getDb();
  const { data, error } = await db
    .from("public_site_routes")
    .select("id,hostname,target_path,desired_state")
    .eq("hostname", hostname)
    .maybeSingle<RouteRow>();

  if (error) {
    throw new Error(`Failed to load public route '${hostname}': ${error.message}`);
  }

  return data || null;
}

async function upsertRouteRow(args: {
  desiredState: DesiredRouteState;
  hostname: string;
  observedState: ObservedRouteState;
  targetPath: string | null;
  taskId: string;
  verification: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const db = getDb();
  const ctx = getAgentContext();
  const existing = await loadRoute(args.hostname);
  const payload = {
    desired_state: args.desiredState,
    hostname: args.hostname,
    last_error:
      typeof args.verification.error === "string" ? args.verification.error : null,
    last_http_status:
      typeof args.verification.http_status === "number"
        ? args.verification.http_status
        : null,
    last_task_id: args.taskId,
    last_verified_at: String(args.verification.checked_at || new Date().toISOString()),
    last_verified_url: String(args.verification.final_url || `https://${args.hostname}/`),
    observed_state: args.observedState,
    target_path: args.targetPath,
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { data, error } = await db
      .from("public_site_routes")
      .update(payload)
      .eq("id", existing.id)
      .select()
      .single<Record<string, unknown>>();

    if (error) {
      throw new Error(`Failed to update public route '${args.hostname}': ${error.message}`);
    }

    return data;
  }

  const { data, error } = await db
    .from("public_site_routes")
    .insert({
      ...payload,
      created_by: ctx.agent_id,
    })
    .select()
    .single<Record<string, unknown>>();

  if (error) {
    throw new Error(`Failed to create public route '${args.hostname}': ${error.message}`);
  }

  return data;
}

async function logRouteEvent(input: {
  action: RouteAction;
  hostname: string;
  previousContents: string | null;
  reloadResult: Record<string, unknown> | null;
  requirementId: string;
  snippetPath: string;
  targetPath: string | null;
  taskId: string;
  verification: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  const ctx = getAgentContext();

  const { error } = await db.from("events").insert({
    trace_id: ctx.trace_id,
    agent_id: ctx.agent_id,
    event_type: "public.site.route",
    severity: input.verification.matches_expectation === true ? "info" : "warning",
    scope_type: "task",
    scope_id: input.taskId,
    summary:
      input.action === "delete"
        ? `Removed public route ${input.hostname}.`
        : input.action === "verify"
          ? `Verified public route ${input.hostname}.`
          : `Upserted public route ${input.hostname} -> ${input.targetPath}.`,
    detail: {
      action: input.action,
      changed:
        input.previousContents !==
        (input.action === "delete"
          ? null
          : input.action === "verify"
            ? input.previousContents
            : buildSnippet(input.hostname, input.targetPath || "/")),
      hostname: input.hostname,
      reload_result: input.reloadResult,
      requirement_id: input.requirementId,
      snippet_path: input.snippetPath,
      target_path: input.targetPath,
      verification: input.verification,
    },
  });

  if (error) {
    console.error("Failed to record public site route event:", error);
  }
}
