import { randomUUID } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnSyncReturns,
} from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

export type ProviderAuthSessionStatus =
  | "idle"
  | "starting"
  | "waiting"
  | "complete"
  | "failed"
  | "canceled";

export interface AnthropicAuthSnapshot {
  apiProvider: string | null;
  authMethod: string | null;
  email: string | null;
  loggedIn: boolean;
  organizationId: string | null;
  organizationName: string | null;
  subscriptionType: string | null;
}

interface AnthropicSubscriptionAuthSession {
  authDetected: boolean;
  child: ChildProcess | null;
  completedAt: string | null;
  createdAt: string;
  error: string | null;
  id: string;
  killedByOperator: boolean;
  snapshot: AnthropicAuthSnapshot;
  status: ProviderAuthSessionStatus;
  updatedAt: string;
  verificationUrl: string | null;
}

export interface AnthropicSubscriptionAuthResponse {
  apiProvider: string | null;
  authDetected: boolean;
  authMethod: string | null;
  completedAt: string | null;
  createdAt: string | null;
  email: string | null;
  error: string | null;
  organizationId: string | null;
  organizationName: string | null;
  sessionId: string | null;
  status: ProviderAuthSessionStatus;
  subscriptionType: string | null;
  updatedAt: string | null;
  verificationUrl: string | null;
}

interface OpenAiDeviceAuthSession {
  authDetected: boolean;
  child: ChildProcess | null;
  completedAt: string | null;
  createdAt: string;
  error: string | null;
  expiresAt: string | null;
  id: string;
  killedByOperator: boolean;
  status: ProviderAuthSessionStatus;
  updatedAt: string;
  userCode: string | null;
  verificationUrl: string | null;
}

export interface OpenAiDeviceAuthResponse {
  authDetected: boolean;
  completedAt: string | null;
  createdAt: string | null;
  error: string | null;
  expiresAt: string | null;
  sessionId: string | null;
  status: ProviderAuthSessionStatus;
  updatedAt: string | null;
  userCode: string | null;
  verificationUrl: string | null;
}

const DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;
const ANSI_PATTERN =
  // ANSI escapes from provider CLI output are stripped before parsing URLs/codes.
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

let anthropicSession: AnthropicSubscriptionAuthSession | null = null;
let openAiSession: OpenAiDeviceAuthSession | null = null;

export async function getAnthropicSubscriptionAuthState(): Promise<AnthropicSubscriptionAuthResponse> {
  const snapshot = await getAnthropicAuthSnapshot();

  if (!anthropicSession) {
    return serializeAnthropicIdle(snapshot);
  }

  await refreshAnthropicSessionState(anthropicSession);
  return serializeAnthropicSession(anthropicSession);
}

export async function startAnthropicSubscriptionAuth(): Promise<AnthropicSubscriptionAuthResponse> {
  const snapshot = await getAnthropicAuthSnapshot();

  if (snapshot.loggedIn) {
    return serializeAnthropicCompleted(snapshot);
  }

  if (anthropicSession) {
    await refreshAnthropicSessionState(anthropicSession);
    if (
      anthropicSession.status === "starting" ||
      anthropicSession.status === "waiting"
    ) {
      return serializeAnthropicSession(anthropicSession);
    }
  }

  await mkdir(join(config.agentHomeDir, ".claude"), { recursive: true });

  const now = new Date().toISOString();
  const session: AnthropicSubscriptionAuthSession = {
    authDetected: snapshot.loggedIn,
    child: null,
    completedAt: null,
    createdAt: now,
    error: null,
    id: randomUUID(),
    killedByOperator: false,
    snapshot,
    status: "starting",
    updatedAt: now,
    verificationUrl: null,
  };

  const child = spawn("claude", ["auth", "login"], {
    cwd: config.agentHomeDir,
    env: buildAnthropicAuthEnv(config.agentHomeDir),
    ...buildProcessIdentityOptions(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  session.child = child;
  anthropicSession = session;

  const handleChunk = (chunk: Buffer) => {
    const text = stripAnsi(chunk.toString("utf8"));
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      if (!session.verificationUrl) {
        const url = extractVerificationUrl(trimmed);
        if (url) {
          session.verificationUrl = url;
        }
      }

      if (trimmed.toLowerCase().includes("error")) {
        session.error = trimmed;
      }
    }

    if (session.verificationUrl && !session.authDetected) {
      session.status = "waiting";
    }

    session.updatedAt = new Date().toISOString();
  };

  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);

  child.on("error", (error) => {
    session.error = error.message;
    session.status = "failed";
    session.updatedAt = new Date().toISOString();
    session.child = null;
  });

  child.on("exit", async (code, signal) => {
    session.child = null;
    await refreshAnthropicSessionState(session);

    if (session.authDetected) {
      session.status = "complete";
      if (!session.completedAt) {
        session.completedAt = new Date().toISOString();
      }
    } else if (session.killedByOperator) {
      session.status = "canceled";
    } else {
      session.status = "failed";
      if (!session.error) {
        session.error =
          code === 0
            ? "Claude login finished without a persisted subscription session."
            : signal
              ? `Claude login exited on signal ${signal}.`
              : `Claude login exited with code ${code ?? "unknown"}.`;
      }
    }

    session.updatedAt = new Date().toISOString();
  });

  return serializeAnthropicSession(session);
}

export async function cancelAnthropicSubscriptionAuth(): Promise<AnthropicSubscriptionAuthResponse> {
  const snapshot = await getAnthropicAuthSnapshot();

  if (!anthropicSession) {
    return serializeAnthropicIdle(snapshot);
  }

  anthropicSession.killedByOperator = true;
  anthropicSession.status = "canceled";
  anthropicSession.updatedAt = new Date().toISOString();

  if (anthropicSession.child && anthropicSession.child.exitCode === null) {
    anthropicSession.child.kill("SIGTERM");
  }

  await refreshAnthropicSessionState(anthropicSession);
  return serializeAnthropicSession(anthropicSession);
}

export async function getOpenAiDeviceAuthState(): Promise<OpenAiDeviceAuthResponse> {
  if (!openAiSession) {
    return serializeOpenAiIdle(await openAiAuthDetected());
  }

  await refreshOpenAiSessionState(openAiSession);
  return serializeOpenAiSession(openAiSession);
}

export async function startOpenAiDeviceAuth(): Promise<OpenAiDeviceAuthResponse> {
  if (await openAiAuthDetected()) {
    return serializeOpenAiCompleted();
  }

  if (openAiSession) {
    await refreshOpenAiSessionState(openAiSession);
    if (openAiSession.status === "starting" || openAiSession.status === "waiting") {
      return serializeOpenAiSession(openAiSession);
    }
  }

  const codexHome = join(config.agentHomeDir, ".codex");
  await mkdir(codexHome, { recursive: true });

  const now = new Date().toISOString();
  const session: OpenAiDeviceAuthSession = {
    authDetected: await openAiAuthDetected(),
    child: null,
    completedAt: null,
    createdAt: now,
    error: null,
    expiresAt: null,
    id: randomUUID(),
    killedByOperator: false,
    status: "starting",
    updatedAt: now,
    userCode: null,
    verificationUrl: null,
  };

  const child = spawn("codex", ["login", "--device-auth"], {
    cwd: config.agentHomeDir,
    env: buildOpenAiAuthEnv(config.agentHomeDir),
    ...buildProcessIdentityOptions(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  session.child = child;
  openAiSession = session;

  const handleChunk = (chunk: Buffer) => {
    const text = stripAnsi(chunk.toString("utf8"));
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      if (!session.verificationUrl) {
        const url = extractVerificationUrl(trimmed);
        if (url) {
          session.verificationUrl = url;
          if (!session.expiresAt) {
            session.expiresAt = new Date(
              Date.now() + DEVICE_CODE_TTL_MS
            ).toISOString();
          }
        }
      }

      if (!session.userCode) {
        const codeMatch = trimmed.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/);
        if (codeMatch) {
          session.userCode = codeMatch[0];
        }
      }

      if (
        trimmed.toLowerCase().includes("error") &&
        !trimmed.toLowerCase().startsWith("follow these steps")
      ) {
        session.error = trimmed;
      }
    }

    if (session.verificationUrl || session.userCode) {
      session.status = "waiting";
    }
    session.updatedAt = new Date().toISOString();
  };

  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);

  child.on("error", (error) => {
    session.error = error.message;
    session.status = "failed";
    session.updatedAt = new Date().toISOString();
    session.child = null;
  });

  child.on("exit", async (code, signal) => {
    session.child = null;
    await refreshOpenAiSessionState(session);

    if (session.authDetected) {
      session.status = "complete";
      if (!session.completedAt) {
        session.completedAt = new Date().toISOString();
      }
    } else if (session.killedByOperator) {
      session.status = "canceled";
    } else if (code === 0) {
      session.status = "complete";
      session.completedAt = new Date().toISOString();
    } else {
      session.status = "failed";
      if (!session.error) {
        session.error =
          signal
            ? `Codex login exited on signal ${signal}.`
            : `Codex login exited with code ${code ?? "unknown"}.`;
      }
    }

    session.updatedAt = new Date().toISOString();
  });

  return serializeOpenAiSession(session);
}

export async function cancelOpenAiDeviceAuth(): Promise<OpenAiDeviceAuthResponse> {
  if (!openAiSession) {
    return serializeOpenAiIdle(await openAiAuthDetected());
  }

  openAiSession.killedByOperator = true;
  openAiSession.status = "canceled";
  openAiSession.updatedAt = new Date().toISOString();

  if (openAiSession.child && openAiSession.child.exitCode === null) {
    openAiSession.child.kill("SIGTERM");
  }

  await refreshOpenAiSessionState(openAiSession);
  return serializeOpenAiSession(openAiSession);
}

export async function getAnthropicAuthSnapshot(
  agentHomeDir: string = config.agentHomeDir
): Promise<AnthropicAuthSnapshot> {
  const result = spawnSync("claude", ["auth", "status", "--json"], {
    cwd: agentHomeDir,
    encoding: "utf8",
    env: buildAnthropicAuthEnv(agentHomeDir),
    ...buildProcessIdentityOptions(),
  });

  const parsed = parseAnthropicAuthStatusPayload(result);
  if (parsed) {
    return parsed;
  }

  const authDetected = await anthropicAuthDetected(agentHomeDir);
  return {
    apiProvider: null,
    authMethod: authDetected ? "unknown" : "none",
    email: null,
    loggedIn: authDetected,
    organizationId: null,
    organizationName: null,
    subscriptionType: null,
  };
}

async function refreshAnthropicSessionState(
  session: AnthropicSubscriptionAuthSession
): Promise<void> {
  session.snapshot = await getAnthropicAuthSnapshot();
  session.authDetected = session.snapshot.loggedIn;

  if (session.authDetected && session.status !== "canceled") {
    session.status = "complete";
    if (!session.completedAt) {
      session.completedAt = new Date().toISOString();
    }
  } else if (session.status === "starting" && session.verificationUrl) {
    session.status = "waiting";
  }

  session.updatedAt = new Date().toISOString();
}

async function refreshOpenAiSessionState(session: OpenAiDeviceAuthSession): Promise<void> {
  session.authDetected = await openAiAuthDetected();
  if (session.authDetected && session.status !== "canceled") {
    session.status = "complete";
    if (!session.completedAt) {
      session.completedAt = new Date().toISOString();
    }
  } else if (
    session.status === "starting" &&
    (session.verificationUrl || session.userCode)
  ) {
    session.status = "waiting";
  }

  if (!session.verificationUrl) {
    session.verificationUrl = DEVICE_AUTH_URL;
  }

  session.updatedAt = new Date().toISOString();
}

async function anthropicAuthDetected(agentHomeDir: string): Promise<boolean> {
  return (
    (await pathExists(join(agentHomeDir, ".claude", ".credentials.json"))) ||
    (await pathExists(join(agentHomeDir, ".claude.json")))
  );
}

async function openAiAuthDetected(): Promise<boolean> {
  return pathExists(join(config.agentHomeDir, ".codex", "auth.json"));
}

function serializeAnthropicIdle(
  snapshot: AnthropicAuthSnapshot
): AnthropicSubscriptionAuthResponse {
  return {
    apiProvider: snapshot.apiProvider,
    authDetected: snapshot.loggedIn,
    authMethod: snapshot.authMethod,
    completedAt: null,
    createdAt: null,
    email: snapshot.email,
    error: null,
    organizationId: snapshot.organizationId,
    organizationName: snapshot.organizationName,
    sessionId: null,
    status: snapshot.loggedIn ? "complete" : "idle",
    subscriptionType: snapshot.subscriptionType,
    updatedAt: null,
    verificationUrl: null,
  };
}

function serializeAnthropicCompleted(
  snapshot: AnthropicAuthSnapshot
): AnthropicSubscriptionAuthResponse {
  const now = new Date().toISOString();
  return {
    apiProvider: snapshot.apiProvider,
    authDetected: true,
    authMethod: snapshot.authMethod,
    completedAt: now,
    createdAt: null,
    email: snapshot.email,
    error: null,
    organizationId: snapshot.organizationId,
    organizationName: snapshot.organizationName,
    sessionId: null,
    status: "complete",
    subscriptionType: snapshot.subscriptionType,
    updatedAt: now,
    verificationUrl: null,
  };
}

function serializeAnthropicSession(
  session: AnthropicSubscriptionAuthSession
): AnthropicSubscriptionAuthResponse {
  return {
    apiProvider: session.snapshot.apiProvider,
    authDetected: session.authDetected,
    authMethod: session.snapshot.authMethod,
    completedAt: session.completedAt,
    createdAt: session.createdAt,
    email: session.snapshot.email,
    error: session.error,
    organizationId: session.snapshot.organizationId,
    organizationName: session.snapshot.organizationName,
    sessionId: session.id,
    status: session.status,
    subscriptionType: session.snapshot.subscriptionType,
    updatedAt: session.updatedAt,
    verificationUrl: session.verificationUrl,
  };
}

function serializeOpenAiIdle(authDetected: boolean): OpenAiDeviceAuthResponse {
  return {
    authDetected,
    completedAt: null,
    createdAt: null,
    error: null,
    expiresAt: null,
    sessionId: null,
    status: authDetected ? "complete" : "idle",
    updatedAt: null,
    userCode: null,
    verificationUrl: null,
  };
}

function serializeOpenAiCompleted(): OpenAiDeviceAuthResponse {
  const now = new Date().toISOString();
  return {
    authDetected: true,
    completedAt: now,
    createdAt: null,
    error: null,
    expiresAt: null,
    sessionId: null,
    status: "complete",
    updatedAt: now,
    userCode: null,
    verificationUrl: null,
  };
}

function serializeOpenAiSession(
  session: OpenAiDeviceAuthSession
): OpenAiDeviceAuthResponse {
  return {
    authDetected: session.authDetected,
    completedAt: session.completedAt,
    createdAt: session.createdAt,
    error: session.error,
    expiresAt: session.expiresAt,
    sessionId: session.id,
    status: session.status,
    updatedAt: session.updatedAt,
    userCode: session.userCode,
    verificationUrl: session.verificationUrl || DEVICE_AUTH_URL,
  };
}

function buildAnthropicAuthEnv(agentHomeDir: string): NodeJS.ProcessEnv {
  return {
    ...buildCommonAuthEnv(agentHomeDir),
    CLAUDE_CONFIG_DIR: join(agentHomeDir, ".claude"),
    CLAUDE_CREDENTIALS_PATH: join(agentHomeDir, ".claude", ".credentials.json"),
    CLAUDE_LEGACY_CREDENTIALS_PATH: join(agentHomeDir, ".claude.json"),
  };
}

function buildOpenAiAuthEnv(agentHomeDir: string): NodeJS.ProcessEnv {
  const codexHome = join(agentHomeDir, ".codex");
  return {
    ...buildCommonAuthEnv(agentHomeDir),
    CODEX_HOME: codexHome,
  };
}

function buildCommonAuthEnv(agentHomeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORCE_COLOR: "0",
    HOME: agentHomeDir,
    NO_COLOR: "1",
    TERM: "dumb",
    USERPROFILE: agentHomeDir,
  };
}

function buildProcessIdentityOptions(): { gid?: number; uid?: number } {
  if (process.platform === "win32") {
    return {};
  }

  return {
    gid: config.agentRunAsGid,
    uid: config.agentRunAsUid,
  };
}

function parseAnthropicAuthStatusPayload(
  result: Pick<SpawnSyncReturns<string>, "stdout">
): AnthropicAuthSnapshot | null {
  const raw = String(result.stdout || "").trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      apiProvider: optionalString(parsed.apiProvider),
      authMethod: optionalString(parsed.authMethod),
      email: optionalString(parsed.email),
      loggedIn: parsed.loggedIn === true,
      organizationId: optionalString(parsed.orgId),
      organizationName: optionalString(parsed.orgName),
      subscriptionType: optionalString(parsed.subscriptionType),
    };
  } catch {
    return null;
  }
}

function extractVerificationUrl(value: string): string | null {
  const match = value.match(/https:\/\/\S+/);
  return match ? match[0] : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export const providerAuthTestHooks = {
  extractVerificationUrl,
  parseAnthropicAuthStatusPayload,
};
