import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chown, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "./db.js";
import { config } from "./config.js";

interface ActiveProcess {
  proc: ChildProcess;
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

  // Create task_run record
  await db.from("task_runs").insert({
    task_id: taskId,
    agent_id: agentId,
    trace_id: traceId,
    status: "started",
    context_pack: contextPack,
    model_used: model,
    effort_used: effort,
  });

  // Update agent last_seen_at
  await db
    .from("agents")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", agentId);

  // Prepare working directory
  const workDir = join(config.workspacesDir, taskId);
  await mkdir(workDir, { recursive: true });
  await chown(workDir, config.claudeRunAsUid, config.claudeRunAsGid);

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
    chown(join(workDir, "AGENTS.md"), config.claudeRunAsUid, config.claudeRunAsGid),
    chown(
      join(workDir, "AGENTS_INSCTRUCTIONS.md"),
      config.claudeRunAsUid,
      config.claudeRunAsGid
    ),
    chown(
      join(workDir, "TASK_BRIEFING.md"),
      config.claudeRunAsUid,
      config.claudeRunAsGid
    ),
    chown(mcpConfigPath, config.claudeRunAsUid, config.claudeRunAsGid),
  ]);

  // Launch Claude Code
  const proc = spawn(
    "claude",
    [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      "--model",
      model,
      "--effort",
      effort,
      "--verbose",
      "--mcp-config",
      mcpConfigPath,
      "--output-format",
      "stream-json",
    ],
    {
      cwd: workDir,
      env: { ...process.env, HOME: config.claudeHomeDir },
      gid: config.claudeRunAsGid,
      uid: config.claudeRunAsUid,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const active: ActiveProcess = {
    proc,
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

  try {
    // Try to find the last JSON result in stream output
    const lines = active.output.split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.result) {
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
