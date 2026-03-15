import test from "node:test";
import assert from "node:assert/strict";
import { taskOutcomeTestHooks } from "./task-outcomes.js";

test("review completions prefer report artifact summary over generic artifact path handoff text", () => {
  const task = {
    objective:
      "Review the live public website scalebytech.com and produce evidence-backed recommendations.",
    title: "Review scalebytech.com and recommend changes to promote Skool community",
  };
  const note = [
    "What changed: the task workspace now contains a concrete recommendation report and screenshot evidence under artifacts/scalebytech-review/.",
    "What is blocked: nothing blocked completion.",
  ].join("\n");
  const artifactSummary =
    "Evidence-backed review of scalebytech.com focused on improving promotion and conversion into the Vibe Coding MicroApps Skool community. Includes CTA placement analysis, offer clarity gaps, funnel dilution, trust-signal issues, SEO/content mismatches, and prioritized recommendations.";

  const outcome = taskOutcomeTestHooks.summarizeOutcome(
    task,
    note,
    "builder",
    artifactSummary
  );

  assert.match(String(outcome), /^Review complete for scalebytech\.com/i);
  assert.doesNotMatch(String(outcome), /workspace now contains/i);
  assert.doesNotMatch(String(outcome), /artifacts\/scalebytech-review/i);
});

test("generic completions still use handoff text when no report artifact summary exists", () => {
  const task = {
    objective: "Implement the ShortPixel CDN rollout.",
    title: "Implement ShortPixel CDN on homepage",
  };
  const note = "What changed: The public site is rebuilt and live at https://dploy.cc/.";

  const outcome = taskOutcomeTestHooks.summarizeOutcome(task, note, "builder", null);

  assert.match(String(outcome), /live at https:\/\/dploy\.cc\//i);
});

test("request completion prefers the richer report-producing task over a generic reviewer leaf", () => {
  const builderTask = {
    assigned_role: "builder",
    attempt_count: 0,
    claimed_by: "builder-1",
    completed_at: "2026-03-15T16:37:00.000Z",
    customer_id: null,
    department_id: null,
    id: "builder-task",
    last_handoff_note:
      "What changed: the task workspace now contains a concrete recommendation report and screenshot evidence under artifacts/scalebytech-review/.",
    objective:
      "Review the live public website scalebytech.com and produce evidence-backed recommendations.",
    parent_task_id: "relay-root",
    project_id: "project-1",
    simulation_only: false,
    state: "completed",
    title: "Review scalebytech.com and recommend changes to promote Skool community",
    updated_at: "2026-03-15T16:37:30.000Z",
  };
  const reviewerTask = {
    assigned_role: "reviewer",
    attempt_count: 0,
    claimed_by: "reviewer-1",
    completed_at: "2026-03-15T16:38:00.000Z",
    customer_id: null,
    department_id: null,
    id: "reviewer-task",
    last_handoff_note: "What changed: Review passed with no additional site changes needed.",
    objective: "Verify the review package and evidence.",
    parent_task_id: "builder-task",
    project_id: "project-1",
    simulation_only: false,
    state: "completed",
    title: "Review the scalebytech.com evidence package",
    updated_at: "2026-03-15T16:38:10.000Z",
  };
  const artifactSummaries = new Map<string, string>([
    [
      "builder-task",
      "Evidence-backed review of scalebytech.com focused on improving promotion and conversion into the Vibe Coding MicroApps Skool community. Includes CTA placement analysis, offer clarity gaps, funnel dilution, trust-signal issues, SEO/content mismatches, and prioritized recommendations.",
    ],
  ]);

  const candidate = taskOutcomeTestHooks.pickBestCompletionCandidate(
    [builderTask, reviewerTask],
    artifactSummaries,
    "reviewer-task"
  );

  assert.ok(candidate);
  assert.equal(candidate?.task.id, "builder-task");
  assert.match(String(candidate?.artifactSummary), /Evidence-backed review of scalebytech\.com/i);
});

test("telegram-originated relay requests resolve completion delivery back to telegram", () => {
  const target = taskOutcomeTestHooks.chooseOperatorDeliveryTarget([
    {
      channel: "admin_chat",
      created_at: "2026-03-15T16:20:00.000Z",
      direction: "inbound",
      id: "admin-mirror",
      metadata: {
        chat_id: 123456,
        mirrored_from: "telegram",
        source_channel: "telegram",
        source_message_id: "telegram-source",
      },
      sender: "telegram:Hans",
    },
    {
      channel: "telegram",
      created_at: "2026-03-15T16:19:59.000Z",
      direction: "inbound",
      id: "telegram-source",
      metadata: {
        chat_id: 123456,
      },
      sender: "telegram:Hans",
    },
  ]);

  assert.equal(target.channel, "telegram");
  assert.equal(target.chatId, 123456);
  assert.equal(target.sourceMessageId, "telegram-source");
});
