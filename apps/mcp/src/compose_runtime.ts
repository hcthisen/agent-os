import { spawnSync } from "node:child_process";

export const MANAGED_SERVICES = [
  "admin",
  "auth",
  "autoheal",
  "browser",
  "caddy",
  "db",
  "mcp",
  "public",
  "realtime",
  "rest",
  "storage",
  "supervisor",
] as const;

export type ManagedServiceName = (typeof MANAGED_SERVICES)[number];
export type ManagedServiceLifecycle = "always_on" | "manual";

export interface DockerInspectState {
  ExitCode?: number;
  Health?: {
    Status?: string;
  };
  Running?: boolean;
  StartedAt?: string;
  Status?: string;
}

interface DockerInspectConfig {
  Labels?: Record<string, string>;
}

interface DockerInspectNetworkSettings {
  Networks?: Record<string, { IPAddress?: string }>;
}

export interface DockerInspectResult {
  Config?: DockerInspectConfig;
  Id: string;
  Name?: string;
  NetworkSettings?: DockerInspectNetworkSettings;
  State?: DockerInspectState;
}

export interface ComposeRuntime {
  currentContainerId: string | null;
  currentService: string;
  project: string;
}

export interface ManagedServiceStatus {
  attention_required: boolean;
  container_id: string | null;
  container_name: string | null;
  health: string | null;
  ip_addresses: string[];
  lifecycle: ManagedServiceLifecycle;
  lifecycle_note: string;
  self_target: boolean;
  service: string;
  state: string;
  status_reason: string;
}

function isManagedServiceEnabled(service: ManagedServiceName): boolean {
  if (service !== "caddy") {
    return true;
  }

  return normalizeBooleanEnv("CADDY_ENABLED", true);
}

function buildDisabledManagedServiceStatus(
  service: ManagedServiceName
): ManagedServiceStatus {
  return {
    attention_required: false,
    container_id: null,
    container_name: null,
    health: null,
    ip_addresses: [],
    lifecycle: SERVICE_LIFECYCLE[service].lifecycle,
    lifecycle_note: "This service is disabled because domain setup was skipped.",
    self_target: false,
    service,
    state: "disabled",
    status_reason: "Service is intentionally disabled for no-domain installs.",
  };
}

const SERVICE_LIFECYCLE: Record<
  ManagedServiceName,
  { idle_states?: string[]; lifecycle: ManagedServiceLifecycle; note: string }
> = {
  admin: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  auth: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  autoheal: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  browser: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  caddy: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  db: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  mcp: {
    idle_states: ["created", "exited", "missing"],
    lifecycle: "manual",
    note: "The MCP container is on the manual Compose profile and may be stopped when no agent session needs it.",
  },
  public: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  realtime: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  rest: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  storage: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
  supervisor: {
    lifecycle: "always_on",
    note: "This service should stay running under normal operation.",
  },
};

export function resolveComposeRuntime(): ComposeRuntime {
  const explicitProject = normalizeEnv("COMPOSE_PROJECT");
  const explicitService = normalizeEnv("COMPOSE_CURRENT_SERVICE");
  const explicitContainerId = normalizeEnv("COMPOSE_CURRENT_CONTAINER_ID");

  if (explicitProject && explicitService) {
    return {
      currentContainerId: explicitContainerId || null,
      currentService: explicitService,
      project: explicitProject,
    };
  }

  const currentContainerId = explicitContainerId || normalizeEnv("HOSTNAME");
  if (!currentContainerId) {
    throw new Error(
      "Compose runtime requires COMPOSE_PROJECT and COMPOSE_CURRENT_SERVICE or HOSTNAME"
    );
  }

  const [inspect] = inspectContainers([currentContainerId]);
  const labels = inspect?.Config?.Labels || {};
  const project = labels["com.docker.compose.project"];
  const currentService = labels["com.docker.compose.service"];

  if (!project || !currentService) {
    throw new Error("Compose runtime could not resolve the current Compose project");
  }

  return {
    currentContainerId,
    currentService,
    project,
  };
}

export function inspectServices(
  runtime: ComposeRuntime,
  services: readonly ManagedServiceName[]
): ManagedServiceStatus[] {
  return services.map((service) => inspectService(runtime, service));
}

export function inspectService(
  runtime: ComposeRuntime,
  service: ManagedServiceName
): ManagedServiceStatus {
  if (!isManagedServiceEnabled(service)) {
    return buildDisabledManagedServiceStatus(service);
  }

  const lifecycle = SERVICE_LIFECYCLE[service];
  const containerId = runDocker([
    "ps",
    "-aq",
    "--no-trunc",
    "--filter",
    `label=com.docker.compose.project=${runtime.project}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
    "--latest",
  ]).trim();

  if (!containerId) {
    const classification = classifyManagedServiceState(service, "missing", null);
    return {
      attention_required: classification.attention_required,
      container_id: null,
      container_name: null,
      health: null,
      ip_addresses: [],
      lifecycle: lifecycle.lifecycle,
      lifecycle_note: lifecycle.note,
      self_target: false,
      service,
      state: "missing",
      status_reason: classification.status_reason,
    };
  }

  const [inspect] = inspectContainers([containerId]);
  const state = inspect?.State || {};
  const networks = inspect?.NetworkSettings?.Networks || {};
  const health = state.Health?.Status || null;
  const normalizedState =
    state.Status || (state.Running ? "running" : "stopped") || "unknown";
  const classification = classifyManagedServiceState(service, normalizedState, health);

  return {
    attention_required: classification.attention_required,
    container_id: inspect.Id,
    container_name: inspect.Name ? inspect.Name.replace(/^\/+/, "") : null,
    health,
    ip_addresses: Object.values(networks)
      .map((network) => network.IPAddress || "")
      .filter(Boolean),
    lifecycle: lifecycle.lifecycle,
    lifecycle_note: lifecycle.note,
    self_target: runtime.currentContainerId
      ? inspect.Id.startsWith(runtime.currentContainerId)
      : false,
    service,
    state: normalizedState,
    status_reason: classification.status_reason,
  };
}

function classifyManagedServiceState(
  service: ManagedServiceName,
  state: string,
  health: string | null
): { attention_required: boolean; status_reason: string } {
  const lifecycle = SERVICE_LIFECYCLE[service];
  if (lifecycle.lifecycle === "manual") {
    if (lifecycle.idle_states?.includes(state)) {
      return {
        attention_required: false,
        status_reason: "Manual-profile service is idle, which is expected when no task is using it.",
      };
    }

    if (state === "running" && health === "unhealthy") {
      return {
        attention_required: true,
        status_reason: "Manual-profile service is active but unhealthy.",
      };
    }

    if (state === "running") {
      return {
        attention_required: false,
        status_reason: "Manual-profile service is running and available.",
      };
    }

    return {
      attention_required: true,
      status_reason: `Manual-profile service is in unexpected state '${state}'.`,
    };
  }

  if (state !== "running") {
    return {
      attention_required: true,
      status_reason: `Always-on service is not running (state '${state}').`,
    };
  }

  if (health === "unhealthy") {
    return {
      attention_required: true,
      status_reason: "Always-on service is running but unhealthy.",
    };
  }

  return {
    attention_required: false,
    status_reason: "Always-on service is running normally.",
  };
}

export function inspectContainers(containerIds: string[]): DockerInspectResult[] {
  if (!containerIds.length) {
    return [];
  }

  const output = runDocker(["inspect", ...containerIds]);
  return JSON.parse(output) as DockerInspectResult[];
}

export function runDocker(args: string[]): string {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "docker command failed").trim());
  }

  return result.stdout.trim();
}

function normalizeEnv(name: string): string {
  return String(process.env[name] || "").trim();
}

function normalizeBooleanEnv(name: string, fallback: boolean): boolean {
  const normalized = normalizeEnv(name).toLowerCase();
  if (!normalized) {
    return fallback;
  }

  return ["1", "true", "yes", "y", "on"].includes(normalized);
}
