import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import {
  access,
  chown,
  cp,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { getDb } from "./db.js";
import { config } from "./config.js";
import { getAnthropicAuthSnapshot } from "./provider-auth.js";
import {
  getRuntimeProviderConfig,
  resolveProviderLaunch,
  type RuntimeProvider,
} from "./runtime-provider.js";

interface ActiveProcess {
  durationCheck: ReturnType<typeof setInterval> | null;
  heartbeatInFlight: Promise<void> | null;
  inactivityCheck: ReturnType<typeof setInterval> | null;
  lastActivityAt: Date;
  lastActivitySummary: string | null;
  lastHeartbeatAt: Date | null;
  maxRunDurationMs: number;
  proc: ChildProcess;
  provider: RuntimeProvider;
  responsePath: string | null;
  roleId: string;
  taskId: string;
  terminationReason: "inactivity_timeout" | "max_duration_timeout" | null;
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
const CHILD_ENV_ALLOWLIST = [
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "GIT_ASKPASS",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
] as const;

export function getActiveCount(): number {
  return activeProcesses.size;
}

export function hasCapacity(): boolean {
  return activeProcesses.size < config.concurrencyLimit;
}

export function getActiveTaskIds(): string[] {
  return [...new Set([...activeProcesses.values()].map((active) => active.taskId))];
}

export async function cleanupWorkspaces(): Promise<void> {
  const db = getDb();
  const cutoffMs = Date.now() - config.workspaceCleanupHours * 60 * 60 * 1000;
  const { data: runs, error } = await db
    .from("task_runs")
    .select("task_id,finished_at,status")
    .in("status", ["completed", "failed", "timeout", "interrupted"])
    .not("finished_at", "is", null)
    .order("finished_at", { ascending: false })
    .limit(2000)
    .returns<Array<{ finished_at: string; status: string; task_id: string }>>();

  if (error) {
    console.error("Failed to load task runs for workspace cleanup:", error);
    return;
  }

  const latestFinishedByTask = new Map<string, number>();
  const recentKeepTaskIds = new Set<string>();

  for (const run of runs || []) {
    if (!run.task_id || !run.finished_at) {
      continue;
    }

    if (!latestFinishedByTask.has(run.task_id)) {
      latestFinishedByTask.set(run.task_id, new Date(run.finished_at).getTime());
    }

    if (recentKeepTaskIds.size < 5) {
      recentKeepTaskIds.add(run.task_id);
    }
  }

  const keepTaskIds = new Set([
    ...getActiveTaskIds(),
    ...recentKeepTaskIds,
  ]);

  let workspaceEntries: string[];
  try {
    workspaceEntries = await readdir(config.workspacesDir);
  } catch (workspaceError) {
    const code = (workspaceError as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return;
    }

    console.error("Failed to read workspaces directory:", workspaceError);
    return;
  }

  const deleted: string[] = [];
  for (const entry of workspaceEntries) {
    if (!entry || keepTaskIds.has(entry)) {
      continue;
    }

    try {
      const workspacePath = join(config.workspacesDir, entry);
      const stats = await lstat(workspacePath);
      if (!stats.isDirectory()) {
        continue;
      }

      const latestFinishedAt = latestFinishedByTask.get(entry) || null;
      const shouldDelete = latestFinishedAt
        ? latestFinishedAt < cutoffMs
        : stats.mtimeMs < cutoffMs;

      if (!shouldDelete) {
        continue;
      }

      await rm(workspacePath, {
        force: true,
        recursive: true,
      });
      deleted.push(entry);
    } catch (cleanupError) {
      console.error(`Failed to remove workspace for task ${entry}:`, cleanupError);
    }
  }

  if (deleted.length) {
    const preview = deleted.slice(0, 10).join(", ");
    console.log(
      `Workspace cleanup removed ${deleted.length} workspace(s): ${preview}${deleted.length > 10 ? ", ..." : ""}`
    );
  }
}

export async function launchAgent(
  taskId: string,
  agentId: string,
  agentName: string,
  roleId: string,
  model: string,
  effort: string,
  contextPack: Record<string, unknown>,
  maxRunDurationMs = config.maxRunDurationMs
): Promise<string> {
  const db = getDb();
  const runId = randomUUID();
  const traceId = `run-${runId.slice(0, 8)}`;
  const runtimeProviderConfig = await getRuntimeProviderConfig();
  const activeProvider = await resolveLaunchProviderForTask(
    runtimeProviderConfig.activeProvider,
    contextPack
  );
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
  const mcpServerEnv = buildPerTaskMcpEnv({
    agentId,
    isSystemTask:
      Boolean(
        (contextPack.task as Record<string, unknown> | undefined)?.is_system_modification
      ) || roleId === "architect",
    maxRunDurationMs,
    roleId,
    runId,
    taskId,
    traceId,
    workDir,
  });
  const providerHomeDir =
    activeProvider === "openai"
      ? await prepareCodexHome(workDir, mcpServerEnv)
      : config.agentHomeDir;

  // Write MCP config with env vars resolved
  const mcpConfig = {
    mcpServers: {
      "agent-os": {
        command: "node",
        args: ["/app/apps/mcp/dist/index.js"],
        env: mcpServerEnv,
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
    taskId,
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
    durationCheck: null,
    heartbeatInFlight: null,
    inactivityCheck: null,
    lastActivityAt: new Date(),
    lastActivitySummary: "Agent process launched.",
    lastHeartbeatAt: null,
    maxRunDurationMs,
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
      if (active.inactivityCheck) {
        clearInterval(active.inactivityCheck);
      }
      return;
    }

    const inactivityMs = Date.now() - current.lastActivityAt.getTime();
    if (inactivityMs < config.processInactivityTimeoutMs || current.terminationReason) {
      return;
    }

    current.terminationReason = "inactivity_timeout";
    if (current.inactivityCheck) {
      clearInterval(current.inactivityCheck);
      current.inactivityCheck = null;
    }
    if (current.durationCheck) {
      clearInterval(current.durationCheck);
      current.durationCheck = null;
    }
    console.warn(
      `Process ${runId} inactive for ${inactivityMs}ms, killing task ${current.taskId}`
    );
    void logInactivityTimeout(current, inactivityMs);
    current.proc.kill("SIGTERM");
    setTimeout(() => {
      const activeProcess = activeProcesses.get(runId);
      if (activeProcess) {
        activeProcess.proc.kill("SIGKILL");
      }
    }, 10000);
  }, config.processInactivityCheckMs);

  active.durationCheck = setInterval(() => {
    const current = activeProcesses.get(runId);
    if (!current) {
      if (active.durationCheck) {
        clearInterval(active.durationCheck);
      }
      return;
    }

    const durationMs = Date.now() - current.startedAt.getTime();
    if (durationMs < current.maxRunDurationMs || current.terminationReason) {
      return;
    }

    current.terminationReason = "max_duration_timeout";
    if (current.inactivityCheck) {
      clearInterval(current.inactivityCheck);
      current.inactivityCheck = null;
    }
    if (current.durationCheck) {
      clearInterval(current.durationCheck);
      current.durationCheck = null;
    }
    console.warn(
      `Process ${runId} exceeded max duration after ${durationMs}ms, killing task ${current.taskId}`
    );
    void logMaxDurationTimeout(current, durationMs);
    current.proc.kill("SIGTERM");
    setTimeout(() => {
      const activeProcess = activeProcesses.get(runId);
      if (activeProcess) {
        activeProcess.proc.kill("SIGKILL");
      }
    }, 10000);
  }, config.processInactivityCheckMs);

  return runId;
}

async function resolveLaunchProviderForTask(
  configuredProvider: RuntimeProvider,
  contextPack: Record<string, unknown>
): Promise<RuntimeProvider> {
  if (configuredProvider !== "anthropic") {
    return configuredProvider;
  }

  const task = isRecord(contextPack.task) ? contextPack.task : null;
  const attemptCount =
    task && typeof task.attempt_count === "number" ? task.attempt_count : 0;
  const lastHandoffNote =
    task && typeof task.last_handoff_note === "string" ? task.last_handoff_note : "";

  if (attemptCount < 1 || !isTransientProviderFailureDetail("anthropic", lastHandoffNote)) {
    return configuredProvider;
  }

  try {
    await access(join(config.agentHomeDir, ".codex", "auth.json"));
    console.warn(
      "Falling back to OpenAI for a task retry after transient Anthropic provider failures."
    );
    return "openai";
  } catch {
    return configuredProvider;
  }
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
  if (active.durationCheck) {
    clearInterval(active.durationCheck);
  }
  activeProcesses.delete(runId);
  const db = getDb();
  const success = code === 0;

  // Parse output for structured result
  let outcome: Record<string, unknown> = {};
  let handoffNote: string | null = null;
  let structuredFailureDetail: string | null = null;

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
      const parsedOutput = extractStructuredProcessOutput(active.output);
      outcome = parsedOutput.outcome;
      handoffNote = parsedOutput.handoffNote;
      structuredFailureDetail = parsedOutput.isError ? parsedOutput.handoffNote : null;
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
          : active.terminationReason === "inactivity_timeout" ||
              active.terminationReason === "max_duration_timeout"
            ? "timeout"
            : signal === "SIGTERM"
              ? "timeout"
              : "failed",
      outcome,
      handoff_note: handoffNote,
      error_message: success
        ? null
        : buildProcessExitMessage(active, code, signal, structuredFailureDetail),
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
    // Mark task as failed, then requeue transient provider-side failures.
    const { data: task } = await db
      .from("tasks")
      .select("state")
      .eq("id", active.taskId)
      .single();

    if (task?.state === "running" || task?.state === "claimed") {
      const failureNote = buildFailedTaskNote(
        active,
        code,
        signal,
        structuredFailureDetail
      );
      const shouldRetry = shouldRetryTransientProviderFailure({
        code,
        provider: active.provider,
        signal,
        structuredFailureDetail,
        terminationReason: active.terminationReason,
      });

      const { data: failedTask } = await db
        .from("tasks")
        .update({
          state: "failed",
          last_handoff_note: failureNote,
        })
        .eq("id", active.taskId)
        .select("attempt_count,max_attempts,state")
        .maybeSingle<{
          attempt_count: number;
          max_attempts: number;
          state: string;
        }>();

      if (shouldRetry && failedTask?.state === "failed") {
        const retryNote = buildTransientRetryTaskNote(
          failedTask.attempt_count,
          failedTask.max_attempts,
          failureNote
        );

        const [retryUpdate, retryEvent] = await Promise.all([
          db
            .from("tasks")
            .update({
              blocked_reason: null,
              claimed_by: null,
              last_handoff_note: retryNote,
              state: "ready",
            })
            .eq("id", active.taskId)
            .eq("state", "failed"),
          db.from("events").insert({
            trace_id: active.traceId,
            agent_id: active.agentId,
            event_type: "task.auto_retry_scheduled",
            severity: "warning",
            scope_type: "task",
            scope_id: active.taskId,
            summary: buildTransientRetryEventSummary(active.provider, failureNote),
            detail: {
              attempt_count: failedTask.attempt_count,
              max_attempts: failedTask.max_attempts,
              retry_reason: failureNote,
              run_id: active.runId,
            },
          }),
        ]);

        if (retryUpdate.error) {
          console.error(
            `Failed to requeue transient provider failure for task ${active.taskId}:`,
            retryUpdate.error
          );
        }
        if (retryEvent.error) {
          console.error(
            `Failed to log transient retry event for task ${active.taskId}:`,
            retryEvent.error
          );
        }
      }
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

async function logMaxDurationTimeout(
  active: ActiveProcess,
  durationMs: number
): Promise<void> {
  const db = getDb();
  const durationMinutes = Math.max(1, Math.round(durationMs / 60000));
  const { error } = await db.from("events").insert({
    trace_id: active.traceId,
    agent_id: active.agentId,
    event_type: "task.max_duration_timeout",
    severity: "warning",
    scope_type: "task",
    scope_id: active.taskId,
    summary: `Agent stopped after reaching the max duration of ${durationMinutes} minutes.`,
    detail: {
      duration_ms: durationMs,
      max_run_duration_ms: active.maxRunDurationMs,
      run_id: active.runId,
      started_at: active.startedAt.toISOString(),
    },
  });

  if (error) {
    console.error(
      `Failed to log max-duration timeout for task ${active.taskId}:`,
      error
    );
  }
}

function buildProcessExitMessage(
  active: ActiveProcess,
  code: number | null,
  signal: string | null,
  structuredFailureDetail: string | null = null
): string {
  if (active.terminationReason === "inactivity_timeout") {
    return `Restarted after ${Math.max(
      1,
      Math.round(config.processInactivityTimeoutMs / 60000)
    )} minutes without agent activity.`;
  }

  if (active.terminationReason === "max_duration_timeout") {
    return `Stopped after exceeding the max run duration of ${Math.max(
      1,
      Math.round(active.maxRunDurationMs / 60000)
    )} minutes.`;
  }

  if (structuredFailureDetail) {
    return structuredFailureDetail;
  }

  return `Exit code: ${code}, signal: ${signal}`;
}

function buildFailedTaskNote(
  active: ActiveProcess,
  code: number | null,
  signal: string | null,
  structuredFailureDetail: string | null = null
): string {
  if (active.terminationReason === "inactivity_timeout") {
    const lastActivity = active.lastActivitySummary || "No activity summary recorded.";
    return `Agent restarted after ${Math.max(
      1,
      Math.round(config.processInactivityTimeoutMs / 60000)
    )} minutes without activity. Last activity: ${lastActivity}`;
  }

  if (active.terminationReason === "max_duration_timeout") {
    return `Agent stopped after exceeding the max run duration of ${Math.max(
      1,
      Math.round(active.maxRunDurationMs / 60000)
    )} minutes.`;
  }

  if (structuredFailureDetail) {
    return structuredFailureDetail;
  }

  return `Process exited with code ${code}${signal ? `, signal ${signal}` : ""}. Output tail: ${active.output.slice(-500)}`;
}

function shouldRetryTransientProviderFailure(input: {
  code: number | null;
  provider: RuntimeProvider;
  signal: string | null;
  structuredFailureDetail: string | null;
  terminationReason: ActiveProcess["terminationReason"];
}): boolean {
  if (input.provider !== "anthropic") {
    return false;
  }

  if (input.code === 0 || input.signal || input.terminationReason) {
    return false;
  }

  const detail = String(input.structuredFailureDetail || "").trim();
  if (!detail) {
    return false;
  }

  return isTransientProviderFailureDetail(input.provider, detail);
}

function isTransientProviderFailureDetail(
  provider: RuntimeProvider,
  detail: string
): boolean {
  if (provider !== "anthropic") {
    return false;
  }

  return /(API Error:\s*(500|502|503|504|529)\b|Internal server error|overloaded_error|temporar(?:ily)? unavailable|"type":"api_error")/i.test(
    detail
  );
}

function buildTransientRetryTaskNote(
  attemptCount: number,
  maxAttempts: number,
  failureDetail: string
): string {
  return `Transient provider failure detected. The task was requeued automatically after attempt ${attemptCount} of ${maxAttempts}. Last provider error: ${summarizeFailureDetail(failureDetail)} Continue from the existing workspace and avoid discarding partial progress.`;
}

function buildTransientRetryEventSummary(
  provider: RuntimeProvider,
  failureDetail: string
): string {
  return `Supervisor requeued the task after a transient ${provider} failure: ${summarizeFailureDetail(
    failureDetail
  )}`;
}

function summarizeFailureDetail(detail: string): string {
  const compact = detail.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function extractStructuredProcessOutput(output: string): {
  handoffNote: string | null;
  isError: boolean;
  outcome: Record<string, unknown>;
} {
  const lines = output.split("\n").filter((line) => line.trim());

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }

      const message =
        firstNonEmptyString(
          parsed.final_message,
          parsed.result,
          extractAssistantText(parsed)
        ) || null;

      if (!parsed.result && !parsed.type && !parsed.final_message) {
        continue;
      }

      return {
        handoffNote: message,
        isError: parsed.is_error === true || typeof parsed.error === "string",
        outcome: parsed,
      };
    } catch {
      // Ignore non-JSON lines.
    }
  }

  return {
    handoffNote: null,
    isError: false,
    outcome: {},
  };
}

function extractAssistantText(parsed: Record<string, unknown>): string | null {
  const message = parsed.message;
  if (!isRecord(message)) {
    return null;
  }

  const content = message.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.text !== "string") {
        return [];
      }

      const trimmed = entry.text.trim();
      return trimmed ? [trimmed] : [];
    })
    .join("\n")
    .trim();

  return text || null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  taskId: string;
  traceId: string;
  workDir: string;
}

let composeRuntimeEnvCache: Record<string, string> | null = null;

function buildLaunchSpec(input: BuildLaunchSpecInput): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const commonEnv = buildChildProcessEnv({
    AGENT_ID: input.agentId,
    ...buildProviderAuthEnv(input.activeProvider, input.homeDir),
    MCP_CONFIG_PATH: input.mcpConfigPath,
    HOME: input.homeDir,
    PUBLIC_LIVE_DIR: config.publicLiveDir,
    PUBLIC_SITE_URL: config.publicSiteUrl,
    ROLE_ID: input.roleId,
    ROOT_DOMAIN: config.rootDomain,
    RUN_ID: input.runId,
    TASK_ID: input.taskId,
    TRACE_ID: input.traceId,
    USERPROFILE: input.homeDir,
    WORKSPACE_DIR: input.workDir,
  });

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

function buildChildProcessEnv(
  extraEnv: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(extraEnv)) {
    env[key] = value;
  }

  return env;
}

function buildPerTaskMcpEnv(input: {
  agentId: string;
  isSystemTask: boolean;
  roleId: string;
  runId: string;
  taskId: string;
  traceId: string;
  workDir: string;
  maxRunDurationMs: number;
}): Record<string, string> {
  const composeRuntimeEnv = getComposeRuntimeEnv();
  const runtimeJwt = buildAgentRuntimeJwt({
    agentId: input.agentId,
    isSystemTask: input.isSystemTask,
    roleId: input.roleId,
    runId: input.runId,
    taskId: input.taskId,
    maxRunDurationMs: input.maxRunDurationMs,
  });
  return {
    POSTGREST_URL: process.env.POSTGREST_URL || process.env.SUPABASE_URL || "",
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "",
    AGENT_RUNTIME_JWT: runtimeJwt,
    AGENT_ID: input.agentId,
    CADDY_SITE_SNIPPETS_DIR: config.caddySiteSnippetsDir,
    COMPOSE_CURRENT_CONTAINER_ID:
      composeRuntimeEnv.COMPOSE_CURRENT_CONTAINER_ID || "",
    COMPOSE_CURRENT_SERVICE: composeRuntimeEnv.COMPOSE_CURRENT_SERVICE || "",
    COMPOSE_PROJECT: composeRuntimeEnv.COMPOSE_PROJECT || "",
    ROOT_DOMAIN: config.rootDomain,
    WORKSPACE_DIR: input.workDir,
    PUBLIC_LIVE_DIR: config.publicLiveDir,
    PUBLIC_SITE_URL: config.publicSiteUrl,
    ROLE_ID: input.roleId,
    RUN_ID: input.runId,
    TASK_ID: input.taskId,
    TRACE_ID: input.traceId,
  };
}

function buildAgentRuntimeJwt(input: {
  agentId: string;
  isSystemTask: boolean;
  roleId: string;
  runId: string;
  taskId: string;
  maxRunDurationMs: number;
}): string {
  const secret = String(process.env.JWT_SECRET || "").trim();
  if (!secret) {
    throw new Error("Missing JWT_SECRET required to sign per-run MCP tokens");
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt =
    issuedAt + Math.max(2 * 60 * 60, Math.ceil(input.maxRunDurationMs / 1000) + 60 * 60);
  const header = base64UrlEncodeJson({ alg: "HS256", typ: "JWT" });
  const payload = base64UrlEncodeJson({
    role: "authenticated",
    iss: "supabase",
    iat: issuedAt,
    exp: expiresAt,
    sub: input.agentId,
    agent_id: input.agentId,
    role_id: input.roleId,
    run_id: input.runId,
    task_id: input.taskId,
    system_task: input.isSystemTask,
  });
  const unsignedToken = `${header}.${payload}`;
  const signature = createHmac("sha256", secret)
    .update(unsignedToken)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  return `${unsignedToken}.${signature}`;
}

function base64UrlEncodeJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildProviderAuthEnv(
  provider: RuntimeProvider,
  homeDir: string
): Record<string, string> {
  if (provider === "anthropic") {
    return {
      CLAUDE_CONFIG_DIR: join(homeDir, ".claude"),
      CLAUDE_CREDENTIALS_PATH: join(homeDir, ".claude", ".credentials.json"),
      CLAUDE_LEGACY_CREDENTIALS_PATH: join(homeDir, ".claude.json"),
    };
  }

  return {
    CODEX_AUTH_PATH: join(homeDir, ".codex", "auth.json"),
    CODEX_HOME: join(homeDir, ".codex"),
  };
}

export const processManagerTestHooks = {
  buildChildProcessEnv,
  buildPerTaskMcpEnv,
  extractStructuredProcessOutput,
  isTransientProviderFailureDetail,
  resolveLaunchProviderForTask,
  shouldRetryTransientProviderFailure,
};

async function ensureProviderAuth(provider: RuntimeProvider): Promise<void> {
  if (provider === "anthropic") {
    const snapshot = await getAnthropicAuthSnapshot(config.agentHomeDir);
    if (snapshot.loggedIn) {
      return;
    }

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

async function prepareCodexHome(
  workDir: string,
  mcpServerEnv: Record<string, string>
): Promise<string> {
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
    buildCodexConfigToml(mcpServerEnv)
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

function buildCodexConfigToml(mcpServerEnv: Record<string, string>): string {
  const mcpEnvLines = Object.entries(mcpServerEnv)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `"${key}" = ${tomlString(value)}`);

  return [
    'model = "gpt-5.4"',
    'model_reasoning_effort = "high"',
    "",
    "[features]",
    "apps = false",
    "",
    "[mcp_servers.agent_os]",
    `command = ${tomlString("node")}`,
    `args = [${tomlString("/app/apps/mcp/dist/index.js")}]`,
    "enabled = true",
    "startup_timeout_sec = 30",
    "",
    "[mcp_servers.agent_os.env]",
    ...mcpEnvLines,
    "",
  ].join("\n");
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
    relevant_skills: relevantSkills,
    role: _role,
    role_policy: _rolePolicy,
    ...briefingContext
  } = contextPack;
  const skillSection = formatRelevantSkills(relevantSkills);
  const simulationOnly = Boolean(
    (briefingContext.task as { simulation_only?: unknown } | undefined)
      ?.simulation_only
  );
  const simulationSection = simulationOnly
    ? `## Simulation Mode

This task is running in simulation-only mode.
- Do not mutate external systems.
- Do not create durable runtime changes such as new tasks, schedules, shared skills, projects, or outbound operator messages.
- Report the intended procedure and expected outcomes in your task handoff instead.

`
    : "";

  return `# Task Briefing

${simulationSection}${JSON.stringify(briefingContext, null, 2)}
${skillSection}
`;
}

function formatRelevantSkills(value: unknown): string {
  const skills = Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object"
      )
    : [];

  if (!skills.length) {
    return "";
  }

  const blocks = skills.map((skill) => {
    const steps = Array.isArray(skill.steps)
      ? skill.steps
          .map((step) => String((step as Record<string, unknown>).instruction || "").trim())
          .filter(Boolean)
      : [];
    const lines = [
      `### Skill: ${String(skill.display_name || skill.name || "Unknown Skill")}`,
      `Trigger: ${String(skill.trigger_when || "").trim() || "Not specified"}`,
      "Steps:",
      ...(steps.length
        ? steps.map((instruction, index) => `${index + 1}. ${instruction}`)
        : ["1. Review the skill definition in memory before acting."]),
    ];

    return lines.join("\n");
  });

  return `\n## Relevant Skills\n\n${blocks.join("\n\n")}\n`;
}

async function writeRuntimeDocs(
  workDir: string,
  contextPack: Record<string, unknown>,
  agentName: string,
  roleId: string,
  activeProvider: RuntimeProvider
): Promise<void> {
  const agentsInstructions = await loadAgentInstructions();

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

async function loadAgentInstructions(): Promise<string> {
  const db = getDb();

  try {
    const { data, error } = await db
      .from("system_settings")
      .select("value")
      .eq("key", "agent_instructions_override")
      .maybeSingle<{ value?: { content?: string } }>();

    if (!error) {
      const override = String(data?.value?.content || "").trim();
      if (override) {
        return override;
      }
    }
  } catch (error) {
    console.warn("Failed to load agent instructions override:", error);
  }

  return await readFile(config.agentsInstructionsPath, "utf8");
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
- If the task produces findings, recommendations, a review, a plan, or research, make the handoff include a concise operator-ready summary of the actual result, not just artifact or workspace paths.
- Log all side effects via event_log.
- Write durable facts to memory via memory_write.
- If you use a shared skill from TASK_BRIEFING.md, call skill_log_use before completion so the system can track reuse and improve ranking over time.
- If you discover a reusable procedure or materially improve an old one, create or update a shared skill before you finish. If you cannot do that cleanly inside this task, include a "Reusable procedure:" block in the handoff note with Name, Scope, Trigger, optional Tags, and ordered Steps so the supervisor can persist it automatically.
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
