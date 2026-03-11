import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

type OpenAiDeviceAuthStatus =
  | "idle"
  | "starting"
  | "waiting"
  | "complete"
  | "failed"
  | "canceled";

interface OpenAiDeviceAuthSession {
  authDetected: boolean;
  child: ChildProcess | null;
  completedAt: string | null;
  createdAt: string;
  error: string | null;
  expiresAt: string | null;
  id: string;
  killedByOperator: boolean;
  status: OpenAiDeviceAuthStatus;
  updatedAt: string;
  userCode: string | null;
  verificationUrl: string | null;
}

interface OpenAiDeviceAuthResponse {
  authDetected: boolean;
  completedAt: string | null;
  createdAt: string | null;
  error: string | null;
  expiresAt: string | null;
  sessionId: string | null;
  status: OpenAiDeviceAuthStatus;
  updatedAt: string | null;
  userCode: string | null;
  verificationUrl: string | null;
}

const DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;
const ANSI_PATTERN =
  // ANSI escapes from Codex output are stripped before parsing URL/code.
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

let openAiSession: OpenAiDeviceAuthSession | null = null;

export async function getOpenAiDeviceAuthState(): Promise<OpenAiDeviceAuthResponse> {
  if (!openAiSession) {
    return {
      authDetected: await openAiAuthDetected(),
      completedAt: null,
      createdAt: null,
      error: null,
      expiresAt: null,
      sessionId: null,
      status: "idle",
      updatedAt: null,
      userCode: null,
      verificationUrl: null,
    };
  }

  await refreshSessionState(openAiSession);
  return serializeSession(openAiSession);
}

export async function startOpenAiDeviceAuth(): Promise<OpenAiDeviceAuthResponse> {
  if (await openAiAuthDetected()) {
    return {
      authDetected: true,
      completedAt: new Date().toISOString(),
      createdAt: null,
      error: null,
      expiresAt: null,
      sessionId: null,
      status: "complete",
      updatedAt: new Date().toISOString(),
      userCode: null,
      verificationUrl: null,
    };
  }

  if (openAiSession) {
    await refreshSessionState(openAiSession);
    if (
      openAiSession.status === "starting" ||
      openAiSession.status === "waiting"
    ) {
      return serializeSession(openAiSession);
    }
  }

  const codexHome = join(config.agentHomeDir, ".codex");
  await mkdir(codexHome, { recursive: true });

  const session: OpenAiDeviceAuthSession = {
    authDetected: await openAiAuthDetected(),
    child: null,
    completedAt: null,
    createdAt: new Date().toISOString(),
    error: null,
    expiresAt: null,
    id: randomUUID(),
    killedByOperator: false,
    status: "starting",
    updatedAt: new Date().toISOString(),
    userCode: null,
    verificationUrl: null,
  };

  const child = spawn("codex", ["login", "--device-auth"], {
    cwd: config.agentHomeDir,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      FORCE_COLOR: "0",
      HOME: config.agentHomeDir,
      NO_COLOR: "1",
      TERM: "dumb",
    },
    gid: config.agentRunAsGid,
    stdio: ["ignore", "pipe", "pipe"],
    uid: config.agentRunAsUid,
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
        const urlMatch = trimmed.match(/https:\/\/\S+/);
        if (urlMatch) {
          session.verificationUrl = urlMatch[0];
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
    await refreshSessionState(session);

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

  return serializeSession(session);
}

export async function cancelOpenAiDeviceAuth(): Promise<OpenAiDeviceAuthResponse> {
  if (!openAiSession) {
    return {
      authDetected: await openAiAuthDetected(),
      completedAt: null,
      createdAt: null,
      error: null,
      expiresAt: null,
      sessionId: null,
      status: "idle",
      updatedAt: null,
      userCode: null,
      verificationUrl: null,
    };
  }

  openAiSession.killedByOperator = true;
  openAiSession.status = "canceled";
  openAiSession.updatedAt = new Date().toISOString();

  if (openAiSession.child && openAiSession.child.exitCode === null) {
    openAiSession.child.kill("SIGTERM");
  }

  await refreshSessionState(openAiSession);
  return serializeSession(openAiSession);
}

async function refreshSessionState(session: OpenAiDeviceAuthSession): Promise<void> {
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

async function openAiAuthDetected(): Promise<boolean> {
  try {
    await access(join(config.agentHomeDir, ".codex", "auth.json"));
    return true;
  } catch {
    return false;
  }
}

function serializeSession(
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

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}
