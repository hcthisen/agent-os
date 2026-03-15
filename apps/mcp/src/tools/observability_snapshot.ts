import { access } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  MANAGED_SERVICES,
  inspectServices,
  resolveComposeRuntime,
  type ManagedServiceStatus,
} from "../compose_runtime.js";
import { getDb } from "../db.js";

const STALE_THRESHOLDS_MS = {
  claimed: parseThreshold("CLAIMED_TASK_ALERT_MS", 5 * 60 * 1000),
  in_review: parseThreshold("RUNNING_TASK_ALERT_MS", 15 * 60 * 1000),
  ready: parseThreshold("READY_TASK_ALERT_MS", 5 * 60 * 1000),
  running: parseThreshold("RUNNING_TASK_ALERT_MS", 15 * 60 * 1000),
} as const;

type QueueTaskState =
  | "blocked_on_agent"
  | "claimed"
  | "dead_letter"
  | "failed"
  | "in_review"
  | "ready"
  | "running";

interface QueueTaskRow {
  assigned_role: string;
  claimed_by: string | null;
  created_at: string;
  id: string;
  priority: string;
  state: QueueTaskState;
  title: string;
  updated_at: string;
}

interface LatestTaskActivityRow {
  created_at: string | null;
  scope_id: string;
  summary: string | null;
}

interface ServiceRegistryRow {
  auth_type: string;
  base_url: string | null;
  description: string;
  display_name: string;
  error_message: string | null;
  last_verified: string | null;
  service_name: string;
  status: string;
}

interface ProviderUsageEventRow {
  created_at: string;
  detail: Record<string, unknown> | null;
}

export const observabilitySnapshotDef = {
  name: "observability_snapshot",
  description:
    "Read a queue, provider-auth, service, and usage snapshot for sentinel-style health checks.",
  inputSchema: {
    type: "object" as const,
    properties: {
      usage_event_limit: {
        type: "number",
        description: "How many recent provider usage events to inspect. Defaults to 200.",
        minimum: 10,
        maximum: 1000,
      },
    },
  },
};

export async function observabilitySnapshot(args: {
  usage_event_limit?: number;
}): Promise<unknown> {
  const db = getDb();
  const usageEventLimit = normalizeUsageEventLimit(args.usage_event_limit);

  const [queue, serviceRegistry, runtimeProvider, usage] =
    await Promise.all([
      buildQueueSnapshot(),
      loadServiceRegistrySnapshot(),
      loadRuntimeProviderSnapshot(),
      loadProviderUsageSnapshot(usageEventLimit),
    ]);

  const managedServices = loadManagedServiceSnapshot();

  return {
    success: true,
    generated_at: new Date().toISOString(),
    managed_services: managedServices,
    queue,
    runtime_provider: runtimeProvider,
    service_registry: serviceRegistry,
    usage,
  };

  async function buildQueueSnapshot(): Promise<Record<string, unknown>> {
    const trackedStates: QueueTaskState[] = [
      "ready",
      "claimed",
      "running",
      "in_review",
      "blocked_on_agent",
      "failed",
      "dead_letter",
    ];

    const { data, error } = await db
      .from("tasks")
      .select("id,title,state,priority,assigned_role,claimed_by,created_at,updated_at")
      .in("state", trackedStates)
      .returns<QueueTaskRow[]>();

    if (error) {
      throw new Error(`Failed to load queue snapshot: ${error.message}`);
    }

    const tasks = data || [];
    const activityMap = await loadLatestTaskActivity(tasks.map((task) => task.id));
    const counts = Object.fromEntries(trackedStates.map((state) => [state, 0])) as Record<
      QueueTaskState,
      number
    >;

    for (const task of tasks) {
      counts[task.state] += 1;
    }

    return {
      counts,
      stale: buildStaleSnapshot(tasks, activityMap),
      totals: {
        actionable:
          counts.ready + counts.claimed + counts.running + counts.in_review,
        blocked: counts.blocked_on_agent,
        terminal_attention: counts.failed + counts.dead_letter,
      },
    };
  }

  async function loadServiceRegistrySnapshot(): Promise<Record<string, unknown>> {
    const { data, error } = await db
      .from("service_registry")
      .select(
        "service_name,display_name,description,base_url,auth_type,status,last_verified,error_message"
      )
      .order("service_name", { ascending: true })
      .returns<ServiceRegistryRow[]>();

    if (error) {
      throw new Error(`Failed to load service registry snapshot: ${error.message}`);
    }

    const rows = data || [];
    const statusCounts = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {});

    return {
      counts: statusCounts,
      entries: rows.map((row) => ({
        auth_type: row.auth_type,
        base_url: row.base_url,
        display_name: row.display_name,
        error_message: row.error_message,
        last_verified: row.last_verified,
        service_name: row.service_name,
        status: row.status,
      })),
    };
  }

  async function loadRuntimeProviderSnapshot(): Promise<Record<string, unknown>> {
    const { data, error } = await db
      .from("system_settings")
      .select("value,updated_at")
      .eq("key", "runtime_provider")
      .maybeSingle<{ updated_at: string; value: Record<string, unknown> }>();

    if (error) {
      throw new Error(`Failed to load runtime provider setting: ${error.message}`);
    }

    const value =
      data?.value && typeof data.value === "object" ? data.value : {};
    const activeProvider =
      value.activeProvider === "openai" ? "openai" : "anthropic";
    const agentHomeDir = process.env.HOME || process.env.USERPROFILE || "/home/node";
    const anthropicPrimaryAuthPath = join(agentHomeDir, ".claude", ".credentials.json");
    const anthropicFallbackAuthPath = join(agentHomeDir, ".claude.json");
    const openAiAuthPath = join(agentHomeDir, ".codex", "auth.json");

    const anthropicAuthDetected =
      (await pathExists(anthropicPrimaryAuthPath)) ||
      (await pathExists(anthropicFallbackAuthPath));
    const openAiAuthDetected = await pathExists(openAiAuthPath);

    return {
      active_provider: activeProvider,
      providers: {
        anthropic: {
          auth_detected: anthropicAuthDetected,
          auth_paths: [anthropicPrimaryAuthPath, anthropicFallbackAuthPath],
          cli: "claude",
          cli_installed: commandAvailable("claude"),
        },
        openai: {
          auth_detected: openAiAuthDetected,
          auth_paths: [openAiAuthPath],
          cli: "codex",
          cli_installed: commandAvailable("codex"),
        },
      },
      updated_at: data?.updated_at || null,
    };
  }

  async function loadProviderUsageSnapshot(
    limit: number
  ): Promise<Record<string, unknown>> {
    const { data, error } = await db
      .from("events")
      .select("created_at,detail")
      .eq("event_type", "provider.usage")
      .eq("scope_type", "company")
      .eq("scope_id", "system")
      .order("created_at", { ascending: false })
      .limit(limit)
      .returns<ProviderUsageEventRow[]>();

    if (error) {
      throw new Error(`Failed to load provider usage events: ${error.message}`);
    }

    const rows = data || [];
    const now = Date.now();
    const window24h = rows.filter(
      (row) => now - new Date(row.created_at).getTime() <= 24 * 60 * 60 * 1000
    );
    const window7d = rows.filter(
      (row) => now - new Date(row.created_at).getTime() <= 7 * 24 * 60 * 60 * 1000
    );

    return {
      available: rows.length > 0,
      note:
        rows.length > 0
          ? "Usage-based cost signals come from API-billed provider events."
          : "No provider usage events have been recorded yet.",
      recent_sample: rows.slice(0, 10).map((row) => normalizeUsageEvent(row)),
      windows: {
        last_24h: aggregateUsageWindow(window24h),
        last_7d: aggregateUsageWindow(window7d),
      },
    };
  }
}

function normalizeUsageEventLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 200;
  }

  return Math.max(10, Math.min(1000, Math.floor(value!)));
}

function buildStaleSnapshot(
  tasks: QueueTaskRow[],
  activityMap: Map<string, { created_at: string | null; summary: string | null }>
): Record<string, unknown> {
  return {
    claimed: buildStaleState("claimed", tasks, activityMap),
    in_review: buildStaleState("in_review", tasks, activityMap),
    ready: buildStaleState("ready", tasks, activityMap),
    running: buildStaleState("running", tasks, activityMap),
  };
}

function buildStaleState(
  state: keyof typeof STALE_THRESHOLDS_MS,
  tasks: QueueTaskRow[],
  activityMap: Map<string, { created_at: string | null; summary: string | null }>
): Record<string, unknown> {
  const thresholdMs = STALE_THRESHOLDS_MS[state];
  const staleTasks = tasks
    .filter((task) => task.state === state)
    .map((task) => {
      const activity = activityMap.get(task.id) || null;
      const referenceTimestamp = resolveTaskReferenceTimestamp(task, activity);
      return {
        age_minutes: minutesSince(referenceTimestamp),
        assigned_role: task.assigned_role,
        id: task.id,
        last_activity_at: activity?.created_at || null,
        last_activity_summary: activity?.summary || null,
        reference_timestamp: referenceTimestamp,
        title: task.title,
      };
    })
    .filter((task) => Date.now() - new Date(task.reference_timestamp).getTime() >= thresholdMs)
    .sort((left, right) => right.age_minutes - left.age_minutes);

  return {
    count: staleTasks.length,
    sample: staleTasks.slice(0, 10),
    threshold_minutes: Math.round(thresholdMs / 60000),
  };
}

async function loadLatestTaskActivity(
  taskIds: string[]
): Promise<Map<string, { created_at: string | null; summary: string | null }>> {
  const activityMap = new Map<string, { created_at: string | null; summary: string | null }>();

  if (!taskIds.length) {
    return activityMap;
  }

  const db = getDb();
  const { data, error } = await db.rpc("latest_task_activity", {
    p_task_ids: taskIds,
  });

  if (error) {
    throw new Error(`Failed to load latest task activity: ${error.message}`);
  }

  for (const row of (data || []) as LatestTaskActivityRow[]) {
    if (!row.scope_id || activityMap.has(row.scope_id)) {
      continue;
    }

    activityMap.set(row.scope_id, {
      created_at: typeof row.created_at === "string" ? row.created_at : null,
      summary: typeof row.summary === "string" ? row.summary : null,
    });
  }

  return activityMap;
}

function resolveTaskReferenceTimestamp(
  task: QueueTaskRow,
  activity: { created_at: string | null } | null
): string {
  if ((task.state === "running" || task.state === "in_review") && activity?.created_at) {
    return activity.created_at;
  }

  return task.updated_at || task.created_at;
}

function loadManagedServiceSnapshot(): Record<string, unknown> {
  try {
    const runtime = resolveComposeRuntime();
    const services = inspectServices(runtime, MANAGED_SERVICES);
    const summarized = summarizeManagedServices(services);

    return {
      attention_required: summarized
        .filter((service) => service.attention_required)
        .map((service) => ({
          health: service.health,
          service: service.service,
          state: service.state,
          status_reason: service.status_reason,
        })),
      current_service: runtime.currentService,
      project: runtime.project,
      services: summarized,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      services: [],
    };
  }
}

function summarizeManagedServices(
  services: ManagedServiceStatus[]
): Array<Record<string, unknown>> {
  return services.map((service) => ({
    attention_required: service.attention_required,
    container_id: service.container_id,
    container_name: service.container_name,
    health: service.health,
    ip_addresses: service.ip_addresses,
    lifecycle: service.lifecycle,
    lifecycle_note: service.lifecycle_note,
    service: service.service,
    state: service.state,
    status_reason: service.status_reason,
  }));
}

function aggregateUsageWindow(
  rows: ProviderUsageEventRow[]
): Record<string, unknown> {
  const byProvider = new Map<
    string,
    {
      estimated_cost_usd: number | null;
      event_count: number;
      total_tokens: number;
    }
  >();

  for (const row of rows) {
    const normalized = normalizeUsageEvent(row);
    const current = byProvider.get(normalized.provider) || {
      estimated_cost_usd: 0,
      event_count: 0,
      total_tokens: 0,
    };

    current.event_count += 1;
    current.total_tokens += normalized.total_tokens;

    if (normalized.estimated_cost_usd === null) {
      current.estimated_cost_usd = null;
    } else if (current.estimated_cost_usd !== null) {
      current.estimated_cost_usd += normalized.estimated_cost_usd;
    }

    byProvider.set(normalized.provider, current);
  }

  return {
    by_provider: [...byProvider.entries()].map(([provider, aggregate]) => ({
      provider,
      ...aggregate,
    })),
    event_count: rows.length,
    total_tokens: rows.reduce(
      (total, row) => total + normalizeUsageEvent(row).total_tokens,
      0
    ),
  };
}

function normalizeUsageEvent(row: ProviderUsageEventRow): {
  created_at: string;
  estimated_cost_usd: number | null;
  model: string | null;
  provider: string;
  service_name: string | null;
  total_tokens: number;
} {
  const detail = row.detail || {};
  const estimatedCost = normalizeNumber(detail.estimated_cost_usd);

  return {
    created_at: row.created_at,
    estimated_cost_usd: estimatedCost,
    model: normalizeString(detail.model),
    provider: normalizeString(detail.provider) || "unknown",
    service_name: normalizeString(detail.service_name),
    total_tokens:
      normalizeNumber(detail.total_tokens) ??
      normalizeNumber(detail.prompt_tokens) ??
      0,
  };
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseThreshold(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function minutesSince(timestamp: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60000));
}

function minutesUntil(timestamp: string): number {
  return Math.round((new Date(timestamp).getTime() - Date.now()) / 60000);
}

function commandAvailable(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
  });

  return result.status === 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
