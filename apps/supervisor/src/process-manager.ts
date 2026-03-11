import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chown,
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "./db.js";
import { config } from "./config.js";
import {
  getRuntimeProviderConfig,
  resolveProviderLaunch,
  type RuntimeProvider,
} from "./runtime-provider.js";

interface ActiveProcess {
  proc: ChildProcess;
  provider: RuntimeProvider;
  responsePath: string | null;
  taskId: string;
  agentId: string;
  runId: string;
  traceId: string;
  startedAt: Date;
  output: string;
}

const activeProcesses = new Map<string, ActiveProcess>();

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
  await chown(workDir, config.agentRunAsUid, config.agentRunAsGid);

  // Copy the runtime bootstrap and durable instructions into the task workspace.
  const [agentsInit, agentsInstructions] = await Promise.all([
    readFile(config.agentsMdPath, "utf8"),
    readFile(config.agentsInstructionsPath, "utf8"),
  ]);

  await Promise.all([
    writeFile(join(workDir, "AGENTS.md"), agentsInit),
    writeFile(join(workDir, "AGENTS_INSCTRUCTIONS.md"), agentsInstructions),
  ]);

  // Write task briefing
  const briefing = formatBriefing(contextPack);
  await writeFile(join(workDir, "TASK_BRIEFING.md"), briefing);

  // Build the prompt
  const prompt = buildPrompt(agentName, roleId, contextPack);
  const responsePath =
    activeProvider === "openai" ? join(workDir, "codex-last-message.txt") : null;
  const providerHomeDir =
    activeProvider === "openai"
      ? await prepareCodexHome(workDir)
      : config.agentHomeDir;

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
    chown(join(workDir, "AGENTS.md"), config.agentRunAsUid, config.agentRunAsGid),
    chown(
      join(workDir, "AGENTS_INSCTRUCTIONS.md"),
      config.agentRunAsUid,
      config.agentRunAsGid
    ),
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
    proc,
    provider: activeProvider,
    responsePath,
    taskId,
    agentId,
    runId,
    traceId,
    startedAt: new Date(),
    output: "",
  };

  activeProcesses.set(runId, active);

  // Collect stdout
  proc.stdout?.on("data", (chunk: Buffer) => {
    active.output += chunk.toString();
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    active.output += chunk.toString();
  });

  // Handle exit
  proc.on("exit", (code, signal) => {
    handleProcessExit(runId, code, signal).catch((err) =>
      console.error(`Error handling process exit for ${runId}:`, err)
    );
  });

  // Timeout
  setTimeout(() => {
    if (activeProcesses.has(runId)) {
      console.warn(`Process ${runId} timed out, killing`);
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (activeProcesses.has(runId)) proc.kill("SIGKILL");
      }, 10000);
    }
  }, config.processTimeoutMs);

  return runId;
}

async function handleProcessExit(
  runId: string,
  code: number | null,
  signal: string | null
): Promise<void> {
  const active = activeProcesses.get(runId);
  if (!active) return;

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
      status: success ? "completed" : signal === "SIGTERM" ? "timeout" : "failed",
      outcome,
      handoff_note: handoffNote,
      error_message: success ? null : `Exit code: ${code}, signal: ${signal}`,
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
      await db
        .from("tasks")
        .update({
          state: "in_review",
          last_handoff_note:
            handoffNote || "Agent process completed successfully.",
        })
        .eq("id", active.taskId);
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
          last_handoff_note: `Process exited with code ${code}${signal ? `, signal ${signal}` : ""}. Output tail: ${active.output.slice(-500)}`,
        })
        .eq("id", active.taskId);
    }
  }

  console.log(
    `Process ${runId} exited: code=${code} signal=${signal} task=${active.taskId}`
  );
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

function buildLaunchSpec(input: BuildLaunchSpecInput): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
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

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ")} }`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function formatBriefing(contextPack: Record<string, unknown>): string {
  return `# Task Briefing

${JSON.stringify(contextPack, null, 2)}
`;
}

function buildPrompt(
  agentName: string,
  roleId: string,
  contextPack: Record<string, unknown>
): string {
  const task = contextPack.task as Record<string, unknown>;
  const rolePolicy = (contextPack.role_policy as string) || "";
  const lastHandoff = contextPack.last_handoff as Record<string, unknown> | null;

  let prompt = `You are ${agentName}, a ${roleId} agent in the agent-os system.

## Your Task
Title: ${task?.title || "Unknown"}
Objective: ${task?.objective || "Unknown"}
Task ID: ${task?.id || "Unknown"}

## Acceptance Criteria
${JSON.stringify(task?.acceptance_criteria || [], null, 2)}

## Role Policy
${rolePolicy}

## Instructions
- Read AGENTS.md, AGENTS_INSCTRUCTIONS.md, and TASK_BRIEFING.md from the working directory before you act.
- Use the MCP tools (task_update, memory_write, event_log, etc.) to interact with the system.
- When done, update the task state and write a handoff note.
- Log all side effects via event_log.
- Write durable facts to memory via memory_write.
`;

  if (lastHandoff) {
    prompt += `
## Last Handoff
${JSON.stringify(lastHandoff, null, 2)}
`;
  }

  return prompt;
}
