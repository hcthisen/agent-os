import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "./db.js";

export type RuntimeProvider = "anthropic" | "openai";
export type OpenAiReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface OpenAiRoleAlignment {
  effort: OpenAiReasoningEffort;
  model: string;
}

export interface RuntimeProviderConfig {
  activeProvider: RuntimeProvider;
  openaiModelMap: Record<string, string>;
  openaiRoleConfig: Record<string, OpenAiRoleAlignment>;
}

export interface RuntimeProviderStatus {
  activeProvider: RuntimeProvider;
  openaiModelMap: Record<string, string>;
  openaiRoleConfig: Record<string, OpenAiRoleAlignment>;
  providers: Record<
    RuntimeProvider,
    {
      authDetected: boolean;
      authPath: string;
      cli: string;
      cliInstalled: boolean;
      label: string;
    }
  >;
}

export const DEFAULT_OPENAI_MODEL_MAP = {
  haiku: "gpt-5.4",
  opus: "gpt-5.4",
  sonnet: "gpt-5.4",
} as const;

export const DEFAULT_OPENAI_ROLE_CONFIG = {
  architect: {
    effort: "high",
    model: "gpt-5.4",
  },
  builder: {
    effort: "high",
    model: "gpt-5.4",
  },
  relay: {
    effort: "low",
    model: "gpt-5.4",
  },
  reviewer: {
    effort: "high",
    model: "gpt-5.4",
  },
  sage: {
    effort: "xhigh",
    model: "gpt-5.4",
  },
  sentinel: {
    effort: "medium",
    model: "gpt-5.3-codex",
  },
} as const;

const RUNTIME_PROVIDER_SETTING_KEY = "runtime_provider";

export async function getRuntimeProviderConfig(): Promise<RuntimeProviderConfig> {
  const db = getDb();
  const { data, error } = await db
    .from("system_settings")
    .select("value")
    .eq("key", RUNTIME_PROVIDER_SETTING_KEY)
    .maybeSingle();

  if (error || !data?.value) {
    return defaultRuntimeProviderConfig();
  }

  const value = data.value as Record<string, unknown>;
  const activeProvider =
    value.activeProvider === "openai" ? "openai" : "anthropic";
  const rawMap =
    value.openaiModelMap && typeof value.openaiModelMap === "object"
      ? (value.openaiModelMap as Record<string, unknown>)
      : {};
  const rawRoleConfig =
    value.openaiRoleConfig && typeof value.openaiRoleConfig === "object"
      ? (value.openaiRoleConfig as Record<string, unknown>)
      : {};

  return {
    activeProvider,
    openaiModelMap: {
      ...DEFAULT_OPENAI_MODEL_MAP,
      ...normalizeModelMap(rawMap),
    },
    openaiRoleConfig: {
      ...DEFAULT_OPENAI_ROLE_CONFIG,
      ...normalizeRoleConfig(rawRoleConfig),
    },
  };
}

export async function getRuntimeProviderStatus(
  agentHomeDir: string
): Promise<RuntimeProviderStatus> {
  const config = await getRuntimeProviderConfig();
  const anthropicAuthPath = join(agentHomeDir, ".claude", ".credentials.json");
  const openAiAuthPath = join(agentHomeDir, ".codex", "auth.json");

  return {
    activeProvider: config.activeProvider,
    openaiModelMap: config.openaiModelMap,
    openaiRoleConfig: config.openaiRoleConfig,
    providers: {
      anthropic: {
        authDetected:
          (await pathExists(anthropicAuthPath)) ||
          (await pathExists(join(agentHomeDir, ".claude.json"))),
        authPath: anthropicAuthPath,
        cli: "claude",
        cliInstalled: commandAvailable("claude"),
        label: "Anthropic subscription",
      },
      openai: {
        authDetected: await pathExists(openAiAuthPath),
        authPath: openAiAuthPath,
        cli: "codex",
        cliInstalled: commandAvailable("codex"),
        label: "ChatGPT subscription",
      },
    },
  };
}

export function resolveProviderModel(
  provider: RuntimeProvider,
  requestedModel: string,
  config: RuntimeProviderConfig
): string | null {
  if (provider === "anthropic") {
    return requestedModel;
  }

  const normalized = requestedModel.trim().toLowerCase();
  return config.openaiModelMap[normalized] || requestedModel || null;
}

export function resolveProviderLaunch(
  provider: RuntimeProvider,
  roleId: string,
  requestedModel: string,
  requestedEffort: string,
  config: RuntimeProviderConfig
): { effort: string; model: string | null } {
  if (provider === "anthropic") {
    return {
      effort: normalizeReasoningEffort(requestedEffort),
      model: requestedModel || null,
    };
  }

  const roleOverride = config.openaiRoleConfig[roleId];
  return {
    effort: normalizeReasoningEffort(roleOverride?.effort || requestedEffort),
    model:
      roleOverride?.model ||
      resolveProviderModel(provider, requestedModel, config) ||
      requestedModel ||
      null,
  };
}

function defaultRuntimeProviderConfig(): RuntimeProviderConfig {
  return {
    activeProvider: "anthropic",
    openaiModelMap: { ...DEFAULT_OPENAI_MODEL_MAP },
    openaiRoleConfig: { ...DEFAULT_OPENAI_ROLE_CONFIG },
  };
}

function normalizeModelMap(
  modelMap: Record<string, unknown>
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(modelMap)) {
    if (typeof value === "string" && value.trim()) {
      normalized[key.trim().toLowerCase()] = value.trim();
    }
  }

  return normalized;
}

function normalizeRoleConfig(
  roleConfig: Record<string, unknown>
): Record<string, OpenAiRoleAlignment> {
  const normalized: Record<string, OpenAiRoleAlignment> = {};

  for (const [roleId, value] of Object.entries(roleConfig)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const entry = value as Record<string, unknown>;
    const modelValue = entry.model;
    const model = typeof modelValue === "string" ? modelValue.trim() : "";
    const effort = normalizeReasoningEffort(
      entry.effort
    );

    if (!model) {
      continue;
    }

    normalized[roleId.trim().toLowerCase()] = { effort, model };
  }

  return normalized;
}

function normalizeReasoningEffort(value: unknown): OpenAiReasoningEffort {
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
