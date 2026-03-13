import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chown,
  cp,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { getDb } from "./db.js";
import { config } from "./config.js";
import {
  getRuntimeProviderConfig,
  resolveProviderLaunch,
  type RuntimeProvider,
} from "./runtime-provider.js";

interface ActiveProcess {
  heartbeatInFlight: Promise<void> | null;
  inactivityCheck: ReturnType<typeof setInterval> | null;
  lastActivityAt: Date;
  lastActivitySummary: string | null;
  lastHeartbeatAt: Date | null;
  proc: ChildProcess;
  provider: RuntimeProvider;
  responsePath: string | null;
  roleId: string;
  taskId: string;
  terminationReason: "inactivity_timeout" | null;
  agentId: string;
  runId: string;
  traceId: string;
  startedAt: Date;
  output: string;
}

const activeProcesses = new Map<string, ActiveProcess>();
const WORKSPACE_TEMPLATE_ENTRIES = [
  ".dockerignore",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  "AGENTS.md",
  "AGENTS_INSCTRUCTIONS.md",
  "ARCHITECTURE.md",
  "CLAUDE.md",
  "DECISIONS.md",
  "PLAN.md",
  "SCHEMA.md",
  "apps",
  "docker",
  "docker-compose.vps.yaml",
  "docker-compose.yaml",
  "package-lock.json",
  "package.json",
  "packages",
  "scripts",
  "sites",
  "supabase",
  "tsconfig.json",
] as const;
const WORKSPACE_EXCLUDED_NAMES = new Set([
  ".git",
  ".next",
  ".provider-home",
  ".tmp",
  "dist",
  "node_modules",
  "public-live",
  "workspaces",
]);

export function getActiveCount(): number {
  return activeProcesses.size;
}

export function hasCapacity(): boolean {
  return activeProcesses.size < config.concurrencyLimit;
}

export async function launchAgent(
  taskId: string,
  agentId: string,
  agentName: string,
  roleId: string,
  model: string,
  effort: string,
  contextPack: Record<string, unknown>
): Promise<string> {
  const db = getDb();
  const runId = randomUUID();
  const traceId = `run-${runId.slice(0, 8)}`;
  const runtimeProviderConfig = await getRuntimeProviderConfig();
  const activeProvider = runtimeProviderConfig.activeProvider;
  const resolvedLaunch = resolveProviderLaunch(
    activeProvider,
    roleId,
    model,
    effort,
    runtimeProviderConfig
  );

  // Create task_run record
  await db.from("task_runs").insert({
    task_id: taskId,
    agent_id: agentId,
    trace_id: traceId,
    status: "started",
    context_pack: contextPack,
    model_used: resolvedLaunch.model || model,
    effort_used: resolvedLaunch.effort,
  });

  // Update agent last_seen_at
  await db
    .from("agents")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", agentId);

  // Prepare working directory
  const workDir = join(config.workspacesDir, taskId);
  await mkdir(workDir, { recursive: true });
  await seedWorkspaceFromTemplate(workDir);

  await writeRuntimeDocs(workDir, contextPack, agentName, roleId, activeProvider);
  await setOwnershipRecursive(workDir, config.agentRunAsUid, config.agentRunAsGid);

  // Build the prompt
  const prompt = buildPrompt(agentName, roleId, contextPack, activeProvider);
  const responsePath =
    activeProvider === "openai" ? join(workDir, "codex-last-message.txt") : null;
  const providerHomeDir =
    activeProvider === "openai"
      ? await prepareCodexHome(workDir)
      : config.agentHomeDir;
  const composeRuntimeEnv = getComposeRuntimeEnv();

  // Write MCP config with env vars resolved
  const mcpConfig = {
    mcpServers: {
      "agent-os": {
        command: "node",
        args: ["/app/apps/mcp/dist/index.js"],
        env: {
          POSTGREST_URL:
            process.env.POSTGREST_URL || process.env.SUPABASE_URL || "",
          SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || "",
          AGENT_ID: agentId,
          CADDY_SITE_SNIPPETS_DIR: config.caddySiteSnippetsDir,
          COMPOSE_CURRENT_CONTAINER_ID:
            composeRuntimeEnv.COMPOSE_CURRENT_CONTAINER_ID || "",
          COMPOSE_CURRENT_SERVICE: composeRuntimeEnv.COMPOSE_CURRENT_SERVICE || "",
          COMPOSE_PROJECT: composeRuntimeEnv.COMPOSE_PROJECT || "",
          TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
          ROOT_DOMAIN: config.rootDomain,
          WORKSPACE_DIR: workDir,
          PUBLIC_LIVE_DIR: config.publicLiveDir,
          PUBLIC_SITE_URL: config.publicSiteUrl,
          ROLE_ID: roleId,
          RUN_ID: runId,
          TRACE_ID: traceId,
        },
      },
    },
  };

  const mcpConfigPath = join(workDir, "mcp-config.json");
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

  await Promise.all([
    chown(
      join(workDir, "AGENTS_INSCTRUCTIONS.md"),
      config.agentRunAsUid,
      config.agentRunAsGid
    ),
    chown(join(workDir, "ROLE_POLICY.md"), config.agentRunAsUid, config.agentRunAsGid),
    chown(join(workDir, "ROLE_DIRECTORY.md"), config.agentRunAsUid, config.agentRunAsGid),
    chown(join(workDir, "AGENT_IDENTITY.md"), config.agentRunAsUid, config.agentRunAsGid),
    chown(
      join(workDir, "TASK_BRIEFING.md"),
      config.agentRunAsUid,
      config.agentRunAsGid
    ),
    chown(mcpConfigPath, config.agentRunAsUid, config.agentRunAsGid),
  ]);

  await ensureProviderAuth(activeProvider);

  const launchSpec = buildLaunchSpec({
    activeProvider,
    agentId,
    effort: resolvedLaunch.effort,
    homeDir: providerHomeDir,
    mcpConfigPath,
    model: resolvedLaunch.model,
    prompt,
    responsePath,
    roleId,
    runId,
    traceId,
    workDir,
  });

  const proc = spawn(
    launchSpec.command,
    launchSpec.args,
    {
      cwd: workDir,
      env: launchSpec.env,
      gid: config.agentRunAsGid,
      uid: config.agentRunAsUid,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const active: ActiveProcess = {
    heartbeatInFlight: null,
    inactivityCheck: null,
    lastActivityAt: new Date(),
    lastActivitySummary: "Agent process launched.",
    lastHeartbeatAt: null,
    proc,
    provider: activeProvider,
    responsePath,
    roleId,
    taskId,
    terminationReason: null,
    agentId,
    runId,
    traceId,
    startedAt: new Date(),
    output: "",
  };

  activeProcesses.set(runId, active);

  // Collect stdout
  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    active.output += text;
    void recordProcessActivity(runId, "stdout", text);
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    active.output += text;
    void recordProcessActivity(runId, "stderr", text);
  });

  // Handle exit
  proc.on("exit", (code, signal) => {
    handleProcessExit(runId, code, signal).catch((err) =>
      console.error(`Error handling process exit for ${runId}:`, err)
    );
  });

  active.inactivityCheck = setInterval(() => {
    const current = activeProcesses.get(runId);
    if (!current) {
      clearInterval(active.inactivityCheck!);
      return;
    }

    const inactivityMs = Date.now() - current.lastActivityAt.getTime();
    if (inactivityMs < config.processInactivityTimeoutMs) {
      return;
    }

    current.terminationReason = "inactivity_timeout";
    clearInterval(current.inactivityCheck!);
    current.inactivityCheck = null;
    console.warn(
      `Process ${runId} inactive for ${inactivityMs}ms, killing task ${current.taskId}`
    );
    void logInactivityTimeout(current, inactivityMs);
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (activeProcesses.has(runId)) proc.kill("SIGKILL");
    }, 10000);
  }, config.processInactivityCheckMs);

  return runId;
}

async function handleProcessExit(
  runId: string,
  code: number | null,
  signal: string | null
): Promise<void> {
  const active = activeProcesses.get(runId);
  if (!active) return;

  if (active.inactivityCheck) {
    clearInterval(active.inactivityCheck);
  }
  activeProcesses.delete(runId);
  const db = getDb();
  const success = code === 0;

  // Parse output for structured result
  let outcome: Record<string, unknown> = {};
  let handoffNote: string | null = null;

  if (active.provider === "openai" && active.responsePath) {
    try {
      const finalMessage = await readFile(active.responsePath, "utf8");
      if (finalMessage.trim()) {
        handoffNote = finalMessage.trim();
        outcome = { final_message: finalMessage.trim() };
      }
    } catch {
      // Best effort only.
    }
  }

  if (!Object.keys(outcome).length) {
    try {
      // Try to find the last JSON result in stream output
      const lines = active.output.split("\n").filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.result || parsed.type || parsed.final_message) {
            outcome = parsed;
            if (
              typeof parsed.final_message === "string" &&
              parsed.final_message.trim()
            ) {
              handoffNote = parsed.final_message.trim();
            }
            break;
          }
        } catch {
          // not JSON, skip
        }
      }
    } catch {
      // couldn't parse output
    }
  }

  // Update task_run
  await db
    .from("task_runs")
    .update({
      status:
        success
          ? "completed"
          : active.terminationReason === "inactivity_timeout"
            ? "timeout"
            : signal === "SIGTERM"
              ? "timeout"
              : "failed",
      outcome,
      handoff_note: handoffNote,
      error_message: success
        ? null
        : buildProcessExitMessage(active, code, signal),
      finished_at: new Date().toISOString(),
    })
    .eq("trace_id", active.traceId);

  // Update task state
  if (success) {
    // The agent should have already updated state via MCP tools.
    // If task is still in 'running', move to 'in_review' as a fallback.
    const { data: task } = await db
      .from("tasks")
      .select("state")
      .eq("id", active.taskId)
      .single();

    if (task?.state === "running") {
      const fallbackState = shouldAutoReviewOnSuccess(active.roleId)
        ? "in_review"
        : "completed";
      const { error: fallbackError } = await db
        .from("tasks")
        .update({
          state: fallbackState,
          last_handoff_note:
            handoffNote || buildFallbackHandoffNote(active.roleId, fallbackState),
        })
        .eq("id", active.taskId);

      if (fallbackError) {
        console.warn(
          `Fallback task completion for ${active.taskId} was blocked: ${fallbackError.message}`
        );
        await db
          .from("tasks")
          .update({
            blocked_reason: `Automatic completion blocked: ${fallbackError.message}`,
            last_handoff_note:
              handoffNote ||
              `Automatic completion was blocked. Resolve the outstanding task requirements and continue from review.`,
            state: "blocked_on_agent",
          })
          .eq("id", active.taskId)
          .eq("state", "running");
      }
    }
  } else {
    // Mark task as failed
    const { data: task } = await db
      .from("tasks")
      .select("state")
      .eq("id", active.taskId)
      .single();

    if (task?.state === "running" || task?.state === "claimed") {
      await db
        .from("tasks")
        .update({
          state: "failed",
          last_handoff_note: buildFailedTaskNote(active, code, signal),
        })
        .eq("id", active.taskId);
    }
  }

  console.log(
    `Process ${runId} exited: code=${code} signal=${signal} task=${active.taskId}`
  );
}

async function recordProcessActivity(
  runId: string,
  source: "stderr" | "stdout",
  rawChunk: string
): Promise<void> {
  const active = activeProcesses.get(runId);
  if (!active) {
    return;
  }

  const now = new Date();
  active.lastActivityAt = now;
  active.lastActivitySummary = buildActivitySummary(source, rawChunk);

  if (
    active.heartbeatInFlight ||
    (active.lastHeartbeatAt &&
      now.getTime() - active.lastHeartbeatAt.getTime() <
        config.processActivityHeartbeatMs)
  ) {
    return;
  }

  active.lastHeartbeatAt = now;
  const db = getDb();
  const summary = active.lastActivitySummary || `Agent activity detected on ${source}.`;

  active.heartbeatInFlight = Promise.all([
    db.from("events").insert({
      trace_id: active.traceId,
      agent_id: active.agentId,
      event_type: "task.heartbeat",
      severity: "info",
      scope_type: "task",
      scope_id: active.taskId,
      summary,
      detail: {
        run_id: active.runId,
        source,
        activity_at: now.toISOString(),
      },
    }),
    db
      .from("agents")
      .update({ last_seen_at: now.toISOString() })
      .eq("id", active.agentId),
  ])
    .then(([eventResult, agentResult]) => {
      if (eventResult.error) {
        console.error(
          `Failed to write heartbeat event for task ${active.taskId}:`,
          eventResult.error
        );
      }
      if (agentResult.error) {
        console.error(
          `Failed to update last_seen_at for agent ${active.agentId}:`,
          agentResult.error
        );
      }
    })
    .catch((error) => {
      console.error(`Failed to record process activity for ${runId}:`, error);
    })
    .finally(() => {
      const current = activeProcesses.get(runId);
      if (current) {
        current.heartbeatInFlight = null;
      }
    });
}

function buildActivitySummary(
  source: "stderr" | "stdout",
  rawChunk: string
): string {
  const lines = rawChunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1) || "";

  try {
    const parsed = JSON.parse(lastLine);
    const payload =
      parsed && typeof parsed === "object" && parsed.payload && typeof parsed.payload === "object"
        ? (parsed.payload as Record<string, unknown>)
        : null;
    const payloadType =
      payload && typeof payload.type === "string" ? payload.type : null;
    const name = payload && typeof payload.name === "string" ? payload.name : null;

    if (payloadType === "function_call" && name) {
      return `Agent invoked tool \`${name}\`.`;
    }

    if (payloadType === "function_call_output") {
      return "Agent received tool output.";
    }

    if (payloadType === "message") {
      return "Agent produced a progress message.";
    }

    if (payloadType === "reasoning") {
      return "Agent is still reasoning.";
    }
  } catch {
    // Fall back to plain-text summary.
  }

  if (!lastLine) {
    return `Agent activity detected on ${source}.`;
  }

  const compact = lastLine.replace(/\s+/g, " ").slice(0, 120);
  return `Agent activity on ${source}: ${compact}`;
}

async function logInactivityTimeout(
  active: ActiveProcess,
  inactivityMs: number
): Promise<void> {
  const db = getDb();
  const inactivityMinutes = Math.max(1, Math.round(inactivityMs / 60000));
  const { error } = await db.from("events").insert({
    trace_id: active.traceId,
    agent_id: active.agentId,
    event_type: "task.inactivity_timeout",
    severity: "warning",
    scope_type: "task",
    scope_id: active.taskId,
    summary: `Agent restarted after ${inactivityMinutes} minutes without activity.`,
    detail: {
      inactivity_ms: inactivityMs,
      last_activity_at: active.lastActivityAt.toISOString(),
      last_activity_summary: active.lastActivitySummary,
      run_id: active.runId,
    },
  });

  if (error) {
    console.error(
      `Failed to log inactivity timeout for task ${active.taskId}:`,
      error
    );
  }
}

function buildProcessExitMessage(
  active: ActiveProcess,
  code: number | null,
  signal: string | null
): string {
  if (active.terminationReason === "inactivity_timeout") {
    return `Restarted after ${Math.max(
      1,
      Math.round(config.processInactivityTimeoutMs / 60000)
    )} minutes without agent activity.`;
  }

  return `Exit code: ${code}, signal: ${signal}`;
}

function buildFailedTaskNote(
  active: ActiveProcess,
  code: number | null,
  signal: string | null
): string {
  if (active.terminationReason === "inactivity_timeout") {
    const lastActivity = active.lastActivitySummary || "No activity summary recorded.";
    return `Agent restarted after ${Math.max(
      1,
      Math.round(config.processInactivityTimeoutMs / 60000)
    )} minutes without activity. Last activity: ${lastActivity}`;
  }

  return `Process exited with code ${code}${signal ? `, signal ${signal}` : ""}. Output tail: ${active.output.slice(-500)}`;
}

function shouldAutoReviewOnSuccess(roleId: string): boolean {
  return roleId !== "relay" && roleId !== "reviewer" && roleId !== "sentinel";
}

function buildFallbackHandoffNote(
  roleId: string,
  fallbackState: "completed" | "in_review"
): string {
  if (fallbackState === "in_review") {
    return `${roleId} process completed successfully and is ready for review.`;
  }

  return `${roleId} process completed successfully.`;
}

interface BuildLaunchSpecInput {
  activeProvider: RuntimeProvider;
  agentId: string;
  effort: string;
  homeDir: string;
  mcpConfigPath: string;
  model: string | null;
  prompt: string;
  responsePath: string | null;
  roleId: string;
  runId: string;
  traceId: string;
  workDir: string;
}

let composeRuntimeEnvCache: Record<string, string> | null = null;

function buildLaunchSpec(input: BuildLaunchSpecInput): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const composeRuntimeEnv = getComposeRuntimeEnv();
  const commonEnv = {
    ...process.env,
    HOME: input.homeDir,
    USERPROFILE: input.homeDir,
  };

  if (input.activeProvider === "anthropic") {
    const anthropicModel = input.model || "opus";
    return {
      command: "claude",
      args: [
        "-p",
        input.prompt,
        "--dangerously-skip-permissions",
        "--model",
        anthropicModel,
        "--effort",
        input.effort,
        "--verbose",
        "--mcp-config",
        input.mcpConfigPath,
        "--output-format",
        "stream-json",
      ],
      env: commonEnv,
    };
  }

  const mcpEnv = {
    POSTGREST_URL: process.env.POSTGREST_URL || process.env.SUPABASE_URL || "",
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || "",
    AGENT_ID: input.agentId,
    CADDY_SITE_SNIPPETS_DIR: config.caddySiteSnippetsDir,
    COMPOSE_CURRENT_CONTAINER_ID:
      composeRuntimeEnv.COMPOSE_CURRENT_CONTAINER_ID || "",
    COMPOSE_CURRENT_SERVICE: composeRuntimeEnv.COMPOSE_CURRENT_SERVICE || "",
    COMPOSE_PROJECT: composeRuntimeEnv.COMPOSE_PROJECT || "",
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
    ROOT_DOMAIN: config.rootDomain,
    WORKSPACE_DIR: input.workDir,
    PUBLIC_LIVE_DIR: config.publicLiveDir,
    PUBLIC_SITE_URL: config.publicSiteUrl,
    ROLE_ID: input.roleId,
    RUN_ID: input.runId,
    TRACE_ID: input.traceId,
  };

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--disable",
    "apps",
    "--json",
    "-C",
    input.workDir,
    "-c",
    `model_reasoning_effort=${tomlString(input.effort)}`,
    "-c",
    `mcp_servers.agent_os.command=${tomlString("node")}`,
    "-c",
    `mcp_servers.agent_os.args=[${tomlString("/app/apps/mcp/dist/index.js")}]`,
    "-c",
    `mcp_servers.agent_os.env=${tomlInlineTable(mcpEnv)}`,
    "-c",
    "mcp_servers.agent_os.enabled=true",
    "-c",
    "mcp_servers.agent_os.startup_timeout_sec=30",
  ];

  if (input.model) {
    args.push("-m", input.model);
  }

  if (input.responsePath) {
    args.push("-o", input.responsePath);
  }

  args.push(input.prompt);

  return {
    command: "codex",
    args,
    env: commonEnv,
  };
}

async function ensureProviderAuth(provider: RuntimeProvider): Promise<void> {
  if (provider === "anthropic") {
    const credentialPaths = [
      join(config.agentHomeDir, ".claude", ".credentials.json"),
      join(config.agentHomeDir, ".claude.json"),
    ];

    for (const credentialPath of credentialPaths) {
      try {
        await access(credentialPath);
        return;
      } catch {
        // Check the next known path.
      }
    }

    throw new Error(
      `Anthropic is active, but no Claude CLI login was found under ${config.agentHomeDir}.`
    );
  }

  try {
    await access(join(config.agentHomeDir, ".codex", "auth.json"));
  } catch {
    throw new Error(
      `ChatGPT is active, but no Codex CLI login was found under ${join(config.agentHomeDir, ".codex")}.`
    );
  }
}

async function prepareCodexHome(workDir: string): Promise<string> {
  const homeDir = join(workDir, ".provider-home");
  const codexDir = join(homeDir, ".codex");
  await mkdir(codexDir, { recursive: true });

  await copyOptionalFile(
    join(config.agentHomeDir, ".codex", "auth.json"),
    join(codexDir, "auth.json")
  );
  await copyOptionalFile(
    join(config.agentHomeDir, ".codex", "cap_sid"),
    join(codexDir, "cap_sid")
  );
  await copyOptionalFile(
    join(config.agentHomeDir, ".codex", "version.json"),
    join(codexDir, "version.json")
  );

  await writeFile(
    join(codexDir, "config.toml"),
    [
      'model = "gpt-5.4"',
      'model_reasoning_effort = "high"',
      "",
      "[features]",
      "apps = false",
      "",
    ].join("\n")
  );

  await Promise.all([
    chown(homeDir, config.agentRunAsUid, config.agentRunAsGid),
    chown(codexDir, config.agentRunAsUid, config.agentRunAsGid),
    chown(join(codexDir, "config.toml"), config.agentRunAsUid, config.agentRunAsGid),
  ]);

  for (const fileName of ["auth.json", "cap_sid", "version.json"]) {
    try {
      await chown(join(codexDir, fileName), config.agentRunAsUid, config.agentRunAsGid);
    } catch {
      // Optional files may not exist.
    }
  }

  return homeDir;
}

async function copyOptionalFile(source: string, destination: string): Promise<void> {
  try {
    await access(source);
    await copyFile(source, destination);
  } catch {
    // Best effort only.
  }
}

async function seedWorkspaceFromTemplate(workDir: string): Promise<void> {
  for (const entry of WORKSPACE_TEMPLATE_ENTRIES) {
    const source = join(config.workspaceTemplateDir, entry);
    const destination = join(workDir, entry);

    try {
      await cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: false,
        filter: (src) => shouldCopyWorkspacePath(src),
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

function shouldCopyWorkspacePath(sourcePath: string): boolean {
  return !WORKSPACE_EXCLUDED_NAMES.has(basename(sourcePath));
}

async function setOwnershipRecursive(
  path: string,
  uid: number,
  gid: number
): Promise<void> {
  await chown(path, uid, gid);
  const stats = await lstat(path);

  if (!stats.isDirectory()) {
    return;
  }

  const entries = await readdir(path);
  for (const entry of entries) {
    await setOwnershipRecursive(join(path, entry), uid, gid);
  }
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ")} }`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function getComposeRuntimeEnv(): Record<string, string> {
  if (composeRuntimeEnvCache) {
    return composeRuntimeEnvCache;
  }

  const explicitProject = String(process.env.COMPOSE_PROJECT || "").trim();
  const explicitService = String(process.env.COMPOSE_CURRENT_SERVICE || "").trim();
  const explicitContainerId = String(
    process.env.COMPOSE_CURRENT_CONTAINER_ID || ""
  ).trim();

  if (explicitProject && explicitService) {
    composeRuntimeEnvCache = {
      COMPOSE_CURRENT_CONTAINER_ID: explicitContainerId,
      COMPOSE_CURRENT_SERVICE: explicitService,
      COMPOSE_PROJECT: explicitProject,
    };
    return composeRuntimeEnvCache;
  }

  const currentContainerId =
    explicitContainerId || String(process.env.HOSTNAME || "").trim();
  if (!currentContainerId) {
    composeRuntimeEnvCache = {
      COMPOSE_CURRENT_CONTAINER_ID: "",
      COMPOSE_CURRENT_SERVICE: "",
      COMPOSE_PROJECT: "",
    };
    return composeRuntimeEnvCache;
  }

  const inspectResult = spawnSync("docker", ["inspect", currentContainerId], {
    encoding: "utf8",
    timeout: 30000,
  });

  if (inspectResult.error || inspectResult.status !== 0) {
    composeRuntimeEnvCache = {
      COMPOSE_CURRENT_CONTAINER_ID: currentContainerId,
      COMPOSE_CURRENT_SERVICE: "",
      COMPOSE_PROJECT: "",
    };
    return composeRuntimeEnvCache;
  }

  try {
    const [inspect] = JSON.parse(inspectResult.stdout) as Array<{
      Config?: { Labels?: Record<string, string> };
      Id?: string;
    }>;
    const labels = inspect?.Config?.Labels || {};

    composeRuntimeEnvCache = {
      COMPOSE_CURRENT_CONTAINER_ID: inspect?.Id || currentContainerId,
      COMPOSE_CURRENT_SERVICE: labels["com.docker.compose.service"] || "",
      COMPOSE_PROJECT: labels["com.docker.compose.project"] || "",
    };
  } catch {
    composeRuntimeEnvCache = {
      COMPOSE_CURRENT_CONTAINER_ID: currentContainerId,
      COMPOSE_CURRENT_SERVICE: "",
      COMPOSE_PROJECT: "",
    };
  }

  return composeRuntimeEnvCache;
}

function formatBriefing(contextPack: Record<string, unknown>): string {
  const {
    agent_identity: _agentIdentity,
    available_roles: _availableRoles,
    role: _role,
    role_policy: _rolePolicy,
    ...briefingContext
  } = contextPack;

  return `# Task Briefing

${JSON.stringify(briefingContext, null, 2)}
`;
}

async function writeRuntimeDocs(
  workDir: string,
  contextPack: Record<string, unknown>,
  agentName: string,
  roleId: string,
  activeProvider: RuntimeProvider
): Promise<void> {
  const agentsInstructions = await readFile(config.agentsInstructionsPath, "utf8");

  await Promise.all([
    writeFile(join(workDir, "AGENTS_INSCTRUCTIONS.md"), agentsInstructions),
    writeFile(join(workDir, "ROLE_POLICY.md"), formatRolePolicy(contextPack)),
    writeFile(join(workDir, "ROLE_DIRECTORY.md"), formatRoleDirectory(contextPack)),
    writeFile(
      join(workDir, "AGENT_IDENTITY.md"),
      formatAgentIdentity(contextPack, agentName, roleId, activeProvider)
    ),
    writeFile(join(workDir, "TASK_BRIEFING.md"), formatBriefing(contextPack)),
  ]);
}

function formatRolePolicy(contextPack: Record<string, unknown>): string {
  const role = (contextPack.role as Record<string, unknown> | null) || null;
  const fallbackPolicy = String((contextPack.role_policy as string) || "").trim();
  const displayName = String(role?.display_name || role?.id || "Unknown Role");
  const description = String(role?.description || "").trim();
  const usageSummary = String(role?.usage_summary || "").trim();
  const handoffWhen = String(role?.handoff_when || "").trim();
  const policyDoc = String(role?.policy_doc || fallbackPolicy).trim();

  return `# Role Policy

Role: ${displayName}
${description ? `Description: ${description}` : ""}
${usageSummary ? `Use this role when: ${usageSummary}` : ""}
${handoffWhen ? `Hand off to this role when: ${handoffWhen}` : ""}

${policyDoc}
`;
}

function formatRoleDirectory(contextPack: Record<string, unknown>): string {
  const availableRoles = Array.isArray(contextPack.available_roles)
    ? (contextPack.available_roles as Array<Record<string, unknown>>)
    : [];

  const lines = availableRoles.map((role) => {
    const displayName = String(role.display_name || role.id || "Unknown");
    const roleId = String(role.id || "unknown");
    const usageSummary = String(role.usage_summary || role.description || "").trim();
    const handoffWhen = String(role.handoff_when || "").trim();
    const activeAgentCount = Number(role.active_agent_count || 0);
    const foundational = role.is_system_role ? "foundational" : "evolved";

    return [
      `## ${displayName} (${roleId})`,
      `Type: ${foundational}`,
      `Active agents: ${activeAgentCount}`,
      usageSummary ? `Use for: ${usageSummary}` : "",
      handoffWhen ? `Handoff guidance: ${handoffWhen}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  return `# Role Directory

This directory lists the currently available roles in the system and when to use them.

${lines.join("\n\n")}
`;
}

function formatAgentIdentity(
  contextPack: Record<string, unknown>,
  agentName: string,
  roleId: string,
  activeProvider: RuntimeProvider
): string {
  const agentIdentity =
    (contextPack.agent_identity as Record<string, unknown> | null) || null;

  return `# Agent Identity

Name: ${agentName}
Role: ${roleId}
Agent ID: ${String(agentIdentity?.id || "unclaimed")}
Status: ${String(agentIdentity?.status || "active")}
Active coding provider: ${activeProvider}

Config overrides:
${JSON.stringify(agentIdentity?.config || {}, null, 2)}
`;
}

function buildPrompt(
  agentName: string,
  roleId: string,
  contextPack: Record<string, unknown>,
  activeProvider: RuntimeProvider
): string {
  const task = contextPack.task as Record<string, unknown>;
  const lastHandoff = contextPack.last_handoff as Record<string, unknown> | null;

  let prompt = `You are ${agentName}, a ${roleId} agent in the agent-os system.

## Your Task
Title: ${task?.title || "Unknown"}
Objective: ${task?.objective || "Unknown"}
Task ID: ${task?.id || "Unknown"}

## Runtime
Active coding provider: ${activeProvider}

## Acceptance Criteria
${JSON.stringify(task?.acceptance_criteria || [], null, 2)}

## Instructions
- Read AGENTS_INSCTRUCTIONS.md, ROLE_POLICY.md, ROLE_DIRECTORY.md, AGENT_IDENTITY.md,
  and TASK_BRIEFING.md from the working directory before you act.
- The working directory contains the task workspace and, when available, a snapshot of the
  repository. Prefer editing the existing project files there instead of scaffolding a
  fresh app unless the task explicitly calls for greenfield work.
- Use the MCP tools (task_update, memory_write, event_log, etc.) to interact with the system.
- When done, update the task state and write a handoff note.
- Log all side effects via event_log.
- Write durable facts to memory via memory_write.
- Use task_create with depends_on when the work benefits from a staged task graph. You can start implementation now and queue follow-up review or remediation tasks that wait on prerequisite tasks automatically.
- For visual QA, screenshots, layout review, login flows, or browser interaction, use the preinstalled agent-browser workflow. Do not try to install Chromium, Playwright, or other browser runtimes inside the task workspace.
- Use service_require before credentialed third-party integrations and block if the service is not active yet.
- Use public_site_verify for public-facing changes and public_site_route for hostname lifecycle changes; do not mark the task complete without verification evidence.
`;

  if (lastHandoff) {
    prompt += `
## Last Handoff
${JSON.stringify(lastHandoff, null, 2)}
`;
  }

  return prompt;
}
