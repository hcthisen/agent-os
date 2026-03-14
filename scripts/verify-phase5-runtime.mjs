import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const TASK_STATES_TO_CLEAN = [
  "ready",
  "claimed",
  "running",
  "failed",
  "dead_letter",
  "in_review",
  "completed",
];

async function main() {
  const marker = `PHASE5_LOCAL_${Date.now()}`;
  const tempRoot = await mkdtemp(join(tmpdir(), "agentos-phase5-"));
  const fakeBinDir = join(tempRoot, "bin");
  const fakeHomeDir = join(tempRoot, "home");
  const fakeCodexHome = join(fakeHomeDir, ".codex");
  const fakeWorkspacesDir = join(tempRoot, "workspaces");
  const fakePublicLiveDir = join(tempRoot, "public-live");
  const fakeCodexPath = join(fakeBinDir, "codex");
  const maxDurationMs = 2_500;

  await chmod(tempRoot, 0o755);
  await mkdir(fakeBinDir, { recursive: true });
  await mkdir(fakeCodexHome, { recursive: true });
  await mkdir(fakeWorkspacesDir, { recursive: true });
  await mkdir(fakePublicLiveDir, { recursive: true });
  await chmod(fakeBinDir, 0o755);
  await chmod(fakeHomeDir, 0o755);
  await chmod(fakeCodexHome, 0o755);
  await chmod(fakeWorkspacesDir, 0o777);
  await chmod(fakePublicLiveDir, 0o777);
  await writeFile(fakeCodexPath, "#!/bin/sh\nexec sleep 120\n", "utf8");
  await chmod(fakeCodexPath, 0o755);
  await writeFile(join(fakeCodexHome, "auth.json"), "{\"test\":true}\n", "utf8");
  await chmod(join(fakeCodexHome, "auth.json"), 0o644);

  process.env.AGENT_HOME_DIR = fakeHomeDir;
  process.env.PROCESS_INACTIVITY_CHECK_MS = "250";
  process.env.PROCESS_INACTIVITY_TIMEOUT_MS = "60000";
  process.env.PUBLIC_LIVE_DIR = fakePublicLiveDir;
  process.env.WORKSPACES_DIR = fakeWorkspacesDir;
  process.env.TELEGRAM_BOT_TOKEN = "";
  process.env.MAX_RUN_DURATION_MS = String(maxDurationMs);
  process.env.PATH = `${fakeBinDir}${delimiter}${process.env.PATH || ""}`;

  const [{ getDb }, { pollForTasks }, { monitorTaskAttention }, { checkSchedules }] =
    await Promise.all([
      import("../apps/supervisor/dist/db.js"),
      import("../apps/supervisor/dist/task-poller.js"),
      import("../apps/supervisor/dist/task-attention.js"),
      import("../apps/supervisor/dist/scheduler.js"),
    ]);

  const db = getDb();
  const results = {
    marker,
    maxDuration: null,
    notificationCooldown: null,
    scheduleLocking: null,
  };

  let originalRuntimeProvider = null;
  let originalBuilderMaxDuration = null;
  const createdTaskIds = [];
  const createdScheduleIds = [];

  try {
    const { data: runtimeSetting, error: runtimeError } = await db
      .from("system_settings")
      .select("value")
      .eq("key", "runtime_provider")
      .single();
    if (runtimeError) {
      throw runtimeError;
    }
    originalRuntimeProvider = runtimeSetting?.value || {};

    const { data: builderRole, error: roleError } = await db
      .from("roles")
      .select("max_run_duration_ms")
      .eq("id", "builder")
      .single();
    if (roleError) {
      throw roleError;
    }
    originalBuilderMaxDuration = builderRole?.max_run_duration_ms ?? null;

    const nextRuntimeProvider = {
      ...(originalRuntimeProvider || {}),
      activeProvider: "openai",
    };
    const { error: runtimeUpdateError } = await db
      .from("system_settings")
      .update({
        value: nextRuntimeProvider,
        updated_at: new Date().toISOString(),
      })
      .eq("key", "runtime_provider");
    if (runtimeUpdateError) {
      throw runtimeUpdateError;
    }

    const { error: roleUpdateError } = await db
      .from("roles")
      .update({
        max_run_duration_ms: maxDurationMs,
      })
      .eq("id", "builder");
    if (roleUpdateError) {
      throw roleUpdateError;
    }

    results.maxDuration = await verifyMaxDurationTimeout({
      createdTaskIds,
      db,
      marker,
      pollForTasks,
      workspacesDir: fakeWorkspacesDir,
    });

    results.notificationCooldown = await verifyNotificationCooldown({
      createdTaskIds,
      db,
      marker,
      monitorTaskAttention,
    });

    results.scheduleLocking = await verifyScheduleLocking({
      checkSchedules,
      createdScheduleIds,
      createdTaskIds,
      db,
      marker,
    });
  } finally {
    await cleanupVerificationRows(db, createdTaskIds, createdScheduleIds, marker);

    if (originalRuntimeProvider !== null) {
      await db
        .from("system_settings")
        .update({
          value: originalRuntimeProvider,
          updated_at: new Date().toISOString(),
        })
        .eq("key", "runtime_provider");
    }

    await db
      .from("roles")
      .update({
        max_run_duration_ms: originalBuilderMaxDuration,
      })
      .eq("id", "builder");

    await rm(tempRoot, { force: true, recursive: true });
  }

  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

async function verifyMaxDurationTimeout(args) {
  const timeoutTaskTitle = `Phase 5 max-duration ${args.marker}`;
  const { data: task, error: taskError } = await args.db
    .from("tasks")
    .insert({
      acceptance_criteria: ["Emit a timeout event."],
      assigned_role: "builder",
      objective: "This is a runtime verification task. It should be terminated by the supervisor max-duration guard.",
      priority: "normal",
      state: "ready",
      title: timeoutTaskTitle,
    })
    .select("id")
    .single();
  if (taskError || !task?.id) {
    throw taskError || new Error("Failed to create max-duration verification task.");
  }
  args.createdTaskIds.push(task.id);

  await args.pollForTasks();

  let runSummary;
  try {
    runSummary = await waitFor(
      async () => {
        const { data: run, error: runError } = await args.db
          .from("task_runs")
          .select("id,status,started_at,finished_at,error_message")
          .eq("task_id", task.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (runError) {
          throw runError;
        }

        const { count: eventCount, error: eventError } = await args.db
          .from("events")
          .select("id", { count: "exact", head: true })
          .eq("event_type", "task.max_duration_timeout")
          .eq("scope_type", "task")
          .eq("scope_id", task.id);

        if (eventError) {
          throw eventError;
        }

        if (!run || run.status !== "timeout" || !eventCount) {
          return null;
        }

        return {
          eventCount,
          finished_at: run.finished_at,
          run_id: run.id,
          started_at: run.started_at,
          status: run.status,
          task_id: task.id,
          workspace_entries: await readdir(args.workspacesDir),
        };
      },
      20_000,
      "max-duration timeout result"
    );
  } catch (error) {
    const [taskState, runState, timeoutEvents] = await Promise.all([
      args.db
        .from("tasks")
        .select("id,state,claimed_by,last_handoff_note,updated_at")
        .eq("id", task.id)
        .maybeSingle(),
      args.db
        .from("task_runs")
        .select("id,status,error_message,started_at,finished_at,trace_id")
        .eq("task_id", task.id)
        .order("created_at", { ascending: false })
        .limit(5),
      args.db
        .from("events")
        .select("id,event_type,summary,detail,created_at")
        .eq("scope_type", "task")
        .eq("scope_id", task.id)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    throw new Error(
      `Max-duration probe failed: ${error instanceof Error ? error.message : String(error)}\n` +
        JSON.stringify(
          {
            runs: runState.data || [],
            task: taskState.data || null,
            timeout_events: timeoutEvents.data || [],
          },
          null,
          2
        )
    );
  }

  assert.equal(runSummary.status, "timeout");
  assert.ok(runSummary.eventCount >= 1);
  assert.ok(runSummary.workspace_entries.includes(task.id));

  return runSummary;
}

async function verifyNotificationCooldown(args) {
  const staleTimestamp = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: task, error: taskError } = await args.db
    .from("tasks")
    .insert({
      acceptance_criteria: [],
      assigned_role: "builder",
      created_at: staleTimestamp,
      objective: "Verify that attention notifications do not spam within the cooldown window.",
      priority: "high",
      state: "running",
      title: `Phase 5 notification cooldown ${args.marker}`,
      updated_at: staleTimestamp,
    })
    .select("id")
    .single();
  if (taskError || !task?.id) {
    throw taskError || new Error("Failed to create notification cooldown task.");
  }
  args.createdTaskIds.push(task.id);

  await args.monitorTaskAttention();

  const firstPass = await readNotificationState(args.db, task.id);
  assert.equal(firstPass.eventCount, 1);
  assert.equal(firstPass.messageCount, 1);

  const { error: deleteMessageError } = await args.db
    .from("messages")
    .delete()
    .eq("channel", "admin_chat")
    .eq("direction", "inbound")
    .eq("task_id", task.id);
  if (deleteMessageError) {
    throw deleteMessageError;
  }

  await args.monitorTaskAttention();

  const secondPass = await readNotificationState(args.db, task.id);
  assert.equal(secondPass.eventCount, 1);
  assert.equal(secondPass.messageCount, 0);

  return {
    first_pass: firstPass,
    second_pass: secondPass,
    task_id: task.id,
  };
}

async function verifyScheduleLocking(args) {
  const title = `Phase 5 scheduled task ${args.marker}`;
  const { data: schedule, error: scheduleError } = await args.db
    .from("schedules")
    .insert({
      assigned_role: "builder",
      cron_expr: "* * * * *",
      enabled: true,
      name: `phase-5-lock-${args.marker.toLowerCase()}`,
      next_run_at: new Date(Date.now() - 60_000).toISOString(),
      task_template: {
        acceptance_criteria: ["Exactly one task is created."],
        objective: "Verify concurrent scheduler checks do not double-fire.",
        priority: "normal",
        title,
      },
    })
    .select("id")
    .single();
  if (scheduleError || !schedule?.id) {
    throw scheduleError || new Error("Failed to create verification schedule.");
  }
  args.createdScheduleIds.push(schedule.id);

  await Promise.all([
    args.checkSchedules(),
    args.checkSchedules(),
    args.checkSchedules(),
  ]);

  const { data: createdTasks, error: taskError } = await args.db
    .from("tasks")
    .select("id,created_at")
    .eq("title", title)
    .eq("assigned_role", "builder");
  if (taskError) {
    throw taskError;
  }

  const createdTaskList = createdTasks || [];
  assert.equal(createdTaskList.length, 1);
  args.createdTaskIds.push(createdTaskList[0].id);

  const { data: updatedSchedule, error: updatedScheduleError } = await args.db
    .from("schedules")
    .select("id,last_run_at,next_run_at")
    .eq("id", schedule.id)
    .single();
  if (updatedScheduleError) {
    throw updatedScheduleError;
  }

  assert.ok(updatedSchedule?.last_run_at);

  return {
    created_task_count: createdTaskList.length,
    created_task_id: createdTaskList[0].id,
    last_run_at: updatedSchedule?.last_run_at || null,
    next_run_at: updatedSchedule?.next_run_at || null,
    schedule_id: schedule.id,
  };
}

async function readNotificationState(db, taskId) {
  const { count: eventCount, error: eventError } = await db
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", "operator.notification.sent")
    .eq("scope_type", "task")
    .eq("scope_id", taskId);
  if (eventError) {
    throw eventError;
  }

  const { count: messageCount, error: messageError } = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("channel", "admin_chat")
    .eq("direction", "inbound")
    .eq("task_id", taskId);
  if (messageError) {
    throw messageError;
  }

  return {
    eventCount: eventCount || 0,
    messageCount: messageCount || 0,
  };
}

async function cleanupVerificationRows(db, taskIds, scheduleIds, marker) {
  if (taskIds.length) {
    await db
      .from("messages")
      .delete()
      .in("task_id", taskIds);
    await db
      .from("events")
      .delete()
      .eq("scope_type", "task")
      .in("scope_id", taskIds);
    await db
      .from("task_runs")
      .delete()
      .in("task_id", taskIds);
    await db
      .from("tasks")
      .delete()
      .in("id", taskIds)
      .in("state", TASK_STATES_TO_CLEAN);
  }

  if (scheduleIds.length) {
    await db
      .from("schedules")
      .delete()
      .in("id", scheduleIds);
  }

  await db
    .from("messages")
    .delete()
    .eq("channel", "admin_chat")
    .ilike("content", `%${marker}%`);
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await delay(250);
  }

  throw new Error(`Timed out waiting for ${label}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
