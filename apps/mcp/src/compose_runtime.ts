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
  container_id: string | null;
  container_name: string | null;
  health: string | null;
  ip_addresses: string[];
  self_target: boolean;
  service: string;
  state: string;
}

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
    return {
      container_id: null,
      container_name: null,
      health: null,
      ip_addresses: [],
      self_target: false,
      service,
      state: "missing",
    };
  }

  const [inspect] = inspectContainers([containerId]);
  const state = inspect?.State || {};
  const networks = inspect?.NetworkSettings?.Networks || {};
  const health = state.Health?.Status || null;

  return {
    container_id: inspect.Id,
    container_name: inspect.Name ? inspect.Name.replace(/^\/+/, "") : null,
    health,
    ip_addresses: Object.values(networks)
      .map((network) => network.IPAddress || "")
      .filter(Boolean),
    self_target: runtime.currentContainerId
      ? inspect.Id.startsWith(runtime.currentContainerId)
      : false,
    service,
    state: state.Status || (state.Running ? "running" : "stopped") || "unknown",
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
