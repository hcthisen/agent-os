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

test("dry-run handoffs mention that the example is included", () => {
  const task = {
    objective: "Set up recurring owner brief schedule and dry-run format.",
    title: "Set up recurring owner brief schedule and dry-run format",
  };
  const note = [
    "Stored the shared skill and configured the recurring schedule.",
    "",
    "Dry-run example:",
    "```text",
    "What changed last week",
    "- The recurring schedule is enabled.",
    "```",
  ].join("\n");

  const outcome = taskOutcomeTestHooks.summarizeOutcome(task, note, "architect", null);

  assert.match(String(outcome), /dry-run example is included/i);
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

test("delivered completion message appends a full result link and keeps a compact summary", () => {
  const content =
    "Done. Review complete. This is a long result summary that should still keep the main point visible in chat while moving the full report into a richer result page for the operator.";
  const delivered = taskOutcomeTestHooks.formatDeliveredCompletionMessage(
    content,
    {
      path: "/deliveries/task-123/token-456",
      url: "https://admin.example.com/deliveries/task-123/token-456",
    },
    "telegram"
  );

  assert.match(delivered, /Full result: https:\/\/admin\.example\.com\/deliveries\/task-123\/token-456/);
  assert.match(delivered, /^Done\. Review complete\./);
});

test("admin completion messages stay concise and rely on metadata-driven result links", () => {
  const content =
    "Done. Review complete. This is a long result summary that should stay readable in chat while the full report is opened from the admin result page.";
  const delivered = taskOutcomeTestHooks.formatDeliveredCompletionMessage(
    content,
    {
      path: "/deliveries/task-123/token-456",
      url: null,
    },
    "admin_chat"
  );

  assert.doesNotMatch(delivered, /Full result:/);
  assert.match(delivered, /^Done\. Review complete\./);
});

test("completed planning tasks with downstream execution do not emit synthesized interim progress", () => {
  const rootTask = {
    assigned_role: "relay",
    id: "relay-root",
    parent_task_id: null,
    title: "Process message: Website skill planning...",
  };
  const sageTask = {
    assigned_role: "sage",
    attempt_count: 0,
    claimed_by: "sage-1",
    completed_at: "2026-03-18T13:07:00.000Z",
    customer_id: null,
    department_id: null,
    id: "sage-task",
    last_handoff_note:
      "What changed: Reviewed the repository, drafted the reusable workflow, and listed the credentials still needed.",
    objective: "Plan the reusable website-demo workflow and gather requirements.",
    parent_task_id: "relay-root",
    project_id: null,
    simulation_only: false,
    state: "completed",
    title: "Plan the website-demo workflow",
    updated_at: "2026-03-18T13:07:10.000Z",
  };
  const builderTask = {
    assigned_role: "builder",
    attempt_count: 0,
    claimed_by: null,
    completed_at: null,
    customer_id: null,
    department_id: null,
    id: "builder-task",
    last_handoff_note: null,
    objective: "Implement the generated workflow.",
    parent_task_id: "sage-task",
    project_id: null,
    simulation_only: false,
    state: "ready",
    title: "Implement the website-demo workflow",
    updated_at: "2026-03-18T13:07:11.000Z",
  };

  assert.equal(
    taskOutcomeTestHooks.shouldSendInterimProgressUpdate(
      sageTask,
      rootTask,
      [sageTask, builderTask]
    ),
    false
  );
});

test("blocked relay updates prefer the freshest actionable blocked note over a stale root checklist", () => {
  const rootTask = {
    assigned_role: "relay",
    id: "relay-root",
    parent_task_id: null,
    title: "Process message: Set up a missed-call workflow...",
  };
  const rootBlockedTask = {
    assigned_role: "relay",
    attempt_count: 0,
    claimed_by: null,
    completed_at: null,
    customer_id: null,
    department_id: null,
    id: "relay-root",
    last_handoff_note: [
      "Required now:",
      "1. GoHighLevel API key or private integration token.",
      "2. Exact pipeline name and stage for missed-call leads.",
      "Optional but helpful:",
      "- Final SMS wording approval if they want to review the copy.",
    ].join("\n"),
    objective: "Process inbound message and coordinate the missed-call workflow setup.",
    parent_task_id: null,
    project_id: null,
    simulation_only: false,
    state: "blocked_on_agent",
    title: "Process message: Set up a missed-call workflow...",
    updated_at: "2026-03-19T10:16:00.000Z",
  };
  const childBlockedTask = {
    assigned_role: "sage",
    attempt_count: 0,
    claimed_by: "sage-1",
    completed_at: null,
    customer_id: null,
    department_id: null,
    id: "sage-task",
    last_handoff_note: [
      "Need from you:",
      "- GoHighLevel account details.",
      "- The desired after-hours behavior.",
    ].join("\n"),
    objective: "Plan the GoHighLevel missed-call workflow.",
    parent_task_id: "relay-root",
    project_id: null,
    simulation_only: false,
    state: "blocked_on_agent",
    title: "Plan the GoHighLevel missed-call workflow",
    updated_at: "2026-03-19T10:16:10.000Z",
  };

  const candidate = taskOutcomeTestHooks.chooseBlockedRequestUpdateCandidate(
    rootTask,
    [rootBlockedTask, childBlockedTask]
  );

  assert.equal(candidate?.id, "sage-task");
});

test("blocked relay updates still prefer the root checklist when it is the newest blocker", () => {
  const rootTask = {
    assigned_role: "relay",
    id: "relay-root",
    parent_task_id: null,
    title: "Process message: Set up a missed-call workflow...",
  };
  const rootBlockedTask = {
    assigned_role: "relay",
    attempt_count: 0,
    claimed_by: null,
    completed_at: null,
    customer_id: null,
    department_id: null,
    id: "relay-root",
    last_handoff_note: [
      "Required now:",
      "- GoHighLevel API key or private integration token.",
      "- Exact pipeline name and stage for missed-call leads.",
      "Optional but helpful:",
      "- Final SMS wording approval if they want to review the copy.",
    ].join("\n"),
    objective: "Process inbound message and coordinate the missed-call workflow setup.",
    parent_task_id: null,
    project_id: null,
    simulation_only: false,
    state: "blocked_on_agent",
    title: "Process message: Set up a missed-call workflow...",
    updated_at: "2026-03-19T10:16:30.000Z",
  };
  const childBlockedTask = {
    assigned_role: "sage",
    attempt_count: 0,
    claimed_by: "sage-1",
    completed_at: null,
    customer_id: null,
    department_id: null,
    id: "sage-task",
    last_handoff_note: [
      "Need from you:",
      "- GoHighLevel account details.",
      "- The desired after-hours behavior.",
    ].join("\n"),
    objective: "Plan the GoHighLevel missed-call workflow.",
    parent_task_id: "relay-root",
    project_id: null,
    simulation_only: false,
    state: "blocked_on_agent",
    title: "Plan the GoHighLevel missed-call workflow",
    updated_at: "2026-03-19T10:16:10.000Z",
  };

  const candidate = taskOutcomeTestHooks.chooseBlockedRequestUpdateCandidate(
    rootTask,
    [rootBlockedTask, childBlockedTask]
  );

  assert.equal(candidate?.id, "relay-root");
});

test("blocked relay updates also recognize blocked_on_human requirement notes", () => {
  const rootTask = {
    assigned_role: "relay",
    id: "relay-root",
    parent_task_id: null,
    title: "Process message: Set up a missed-call workflow...",
  };
  const rootBlockedTask = {
    assigned_role: "relay",
    attempt_count: 0,
    claimed_by: null,
    completed_at: null,
    customer_id: null,
    department_id: null,
    id: "relay-root",
    last_handoff_note: [
      "What I need now:",
      "- Add the GoHighLevel API key in Service Connections.",
      "- Confirm the connected account is the right one.",
      "",
      "What I'll need later:",
      "- The exact pipeline and stage.",
    ].join("\n"),
    objective: "Process inbound message and coordinate the missed-call workflow setup.",
    parent_task_id: null,
    project_id: null,
    simulation_only: false,
    state: "blocked_on_human",
    title: "Process message: Set up a missed-call workflow...",
    updated_at: "2026-03-19T10:16:00.000Z",
  };

  const candidate = taskOutcomeTestHooks.chooseBlockedRequestUpdateCandidate(
    rootTask,
    [rootBlockedTask]
  );

  assert.equal(candidate?.id, "relay-root");
  assert.equal(
    taskOutcomeTestHooks.looksLikeRequirementsChecklist(
      rootBlockedTask.last_handoff_note
    ),
    true
  );
});

test("blocked checklist formatting strips internal relay preambles before explicit headings", () => {
  const formatted = taskOutcomeTestHooks.formatBlockedChecklistMessage(
    [
      "Classified the inbound admin_chat message as a new execution request for a 2-page prospect demo site.",
      "Created downstream planning task for sage.",
      "Required now:",
      "- Add GitHub access.",
      "- Add Vercel access.",
      "- Allow the downstream planning task to define the implementation approach.",
      "",
      "Optional but helpful:",
      "- Add Gemini if replacement visuals should be generated.",
    ].join("\n")
  );

  assert.doesNotMatch(formatted, /Classified the inbound admin_chat message/i);
  assert.match(formatted, /^Required now:/i);
  assert.match(formatted, /Add GitHub access/i);
  assert.doesNotMatch(formatted, /Allow the downstream planning task/i);
  assert.match(formatted, /Optional but helpful:/i);
});

test("blocked checklist formatting converts internal relay checklist guidance into clean sections", () => {
  const formatted = taskOutcomeTestHooks.formatBlockedChecklistMessage(
    "Classified the inbound admin_chat message as a new execution request for a 2-page prospect demo site. Attached to existing project aalborg-elservice.dk. Created downstream planning task db3048ba-c1d4-4c9b-8d1a-53d09d1dc166 for sage to produce a staged implementation plan. Confirmed missing required service connection Gemini is blocked on API key setup. Operator-facing checklist should ask for GitHub access/repo target and Vercel access later, while noting Gemini is required now for any replacement visuals."
  );

  assert.doesNotMatch(formatted, /Classified the inbound admin_chat message/i);
  assert.doesNotMatch(formatted, /Operator-facing checklist should ask/i);
  assert.match(formatted, /^Required now:/i);
  assert.match(formatted, /Add Gemini in Service Connections \(API key setup\)/i);
  assert.match(formatted, /Needed later:/i);
  assert.match(formatted, /GitHub access\/repo target/i);
  assert.match(formatted, /Vercel access/i);
});

test("blocked request updates mention when downstream execution is already underway", () => {
  const rootTask = {
    assigned_role: "relay",
    attempt_count: 0,
    claimed_by: "relay-1",
    completed_at: "2026-03-19T18:40:00.000Z",
    customer_id: null,
    department_id: null,
    id: "relay-root",
    last_handoff_note: [
      "Required now:",
      "- Nothing else from you to start.",
      "",
      "Needed later:",
      "- Brand assets.",
    ].join("\n"),
    objective: "Process inbound message.",
    parent_task_id: null,
    project_id: null,
    simulation_only: false,
    state: "blocked_on_agent",
    title: "Process message: Build the prospect demo...",
    updated_at: "2026-03-19T18:40:00.000Z",
  };
  const builderTask = {
    assigned_role: "builder",
    attempt_count: 0,
    claimed_by: "builder-1",
    completed_at: null,
    customer_id: null,
    department_id: null,
    id: "builder-task",
    last_handoff_note: null,
    objective: "Build the demo.",
    parent_task_id: "relay-root",
    project_id: null,
    simulation_only: false,
    state: "running",
    title: "Build Aalborg El-service demo site",
    updated_at: "2026-03-19T18:40:05.000Z",
  };

  const formatted = taskOutcomeTestHooks.formatBlockedRequestUpdateMessage(
    rootTask,
    [rootTask, builderTask]
  );

  assert.match(formatted, /^Execution status:/);
  assert.match(formatted, /Builder work has already started/i);
  assert.match(formatted, /Build Aalborg El-service demo site/i);
  assert.match(formatted, /Required now:/i);
});

test("relay root progress is suppressed when downstream planning work already exists", () => {
  const rootTask = {
    assigned_role: "relay",
    attempt_count: 0,
    claimed_by: "relay-1",
    completed_at: "2026-03-18T13:42:00.000Z",
    customer_id: null,
    department_id: null,
    id: "relay-root",
    last_handoff_note:
      "Classified the inbound message and routed it to planning.",
    objective: "Process inbound message.\nRequirements walkthrough requested: yes.",
    parent_task_id: null,
    project_id: null,
    simulation_only: false,
    state: "completed",
    title: "Process message: Website skill planning...",
    updated_at: "2026-03-18T13:42:01.000Z",
  };
  const sageTask = {
    assigned_role: "sage",
    attempt_count: 0,
    claimed_by: null,
    completed_at: null,
    customer_id: null,
    department_id: null,
    id: "sage-task",
    last_handoff_note: null,
    objective: "Plan the workflow.",
    parent_task_id: "relay-root",
    project_id: null,
    simulation_only: false,
    state: "running",
    title: "Plan the workflow",
    updated_at: "2026-03-18T13:42:02.000Z",
  };

  assert.equal(
    taskOutcomeTestHooks.shouldSendInterimProgressUpdate(
      rootTask,
      {
        assigned_role: "relay",
        id: "relay-root",
        parent_task_id: null,
        title: "Process message: Website skill planning...",
      },
      [rootTask, sageTask]
    ),
    false
  );
});

test("relay root progress is allowed when the relay note already contains a requirements checklist", () => {
  const rootTask = {
    assigned_role: "relay",
    attempt_count: 0,
    claimed_by: "relay-1",
    completed_at: "2026-03-18T13:42:00.000Z",
    customer_id: null,
    department_id: null,
    id: "relay-root",
    last_handoff_note:
      "Required now: GitHub token, Vercel token, image API docs. Needed later: prospect URL and brand assets. Optional but helpful: example sites.",
    objective: "Process inbound message.\nRequirements walkthrough requested: yes.",
    parent_task_id: null,
    project_id: null,
    simulation_only: false,
    state: "completed",
    title: "Process message: Website skill planning...",
    updated_at: "2026-03-18T13:42:01.000Z",
  };
  const sageTask = {
    assigned_role: "sage",
    attempt_count: 0,
    claimed_by: null,
    completed_at: null,
    customer_id: null,
    department_id: null,
    id: "sage-task",
    last_handoff_note: null,
    objective: "Plan the workflow.",
    parent_task_id: "relay-root",
    project_id: null,
    simulation_only: false,
    state: "running",
    title: "Plan the workflow",
    updated_at: "2026-03-18T13:42:02.000Z",
  };

  assert.equal(
    taskOutcomeTestHooks.shouldSendInterimProgressUpdate(
      rootTask,
      {
        assigned_role: "relay",
        id: "relay-root",
        parent_task_id: null,
        title: "Process message: Website skill planning...",
      },
      [rootTask, sageTask]
    ),
    true
  );
  assert.equal(
    taskOutcomeTestHooks.looksLikeRequirementsChecklist(
      rootTask.last_handoff_note
    ),
    true
  );
  assert.match(
    taskOutcomeTestHooks.formatCompletionMessage(
      rootTask,
      {
        assigned_role: "relay",
        id: "relay-root",
        parent_task_id: null,
        title: "Process message: Website skill planning...",
      },
      false,
      null
    ),
    /Required now:|What I still need now:/i
  );
});

test("summarizeOutcome prefers Vercel deployment URL over GitHub repo URL", () => {
  const task = {
    objective: "Build demo and deploy",
    title: "Build Mr. Rooter Plumbing 2-page demo and deploy",
  };
  const note = [
    "Completed.",
    "What changed: Created repository at https://github.com/TestScaleByTech/mr-rooter-demo",
    "and deployed to https://mr-rooter-demo.vercel.app/.",
  ].join(" ");

  const outcome = taskOutcomeTestHooks.summarizeOutcome(task, note, "builder", null);
  assert.match(String(outcome), /vercel\.app/i);
  assert.doesNotMatch(String(outcome), /github\.com/i);
});

test("pickBestLiveUrl prefers deployment URLs over repo URLs", () => {
  const text =
    "Created repo at https://github.com/org/repo and deployed to https://my-app.vercel.app/ successfully.";
  const url = taskOutcomeTestHooks.pickBestLiveUrl(text);
  assert.equal(url, "https://my-app.vercel.app/");
});

test("pickBestLiveUrl falls back to non-repo URL when no known deploy host", () => {
  const text =
    "Repo: https://github.com/org/repo. Live: https://custom-domain.com/site.";
  const url = taskOutcomeTestHooks.pickBestLiveUrl(text);
  assert.equal(url, "https://custom-domain.com/site");
});

test("pickBestLiveUrl returns repo URL if nothing else is available", () => {
  const text = "Created https://github.com/org/repo.";
  const url = taskOutcomeTestHooks.pickBestLiveUrl(text);
  assert.equal(url, "https://github.com/org/repo");
});

test("pickBestLiveUrl returns null for empty text", () => {
  assert.equal(taskOutcomeTestHooks.pickBestLiveUrl("No URLs here"), null);
});

test("completed sage tasks do not emit synthesized interim progress updates", () => {
  const sageTask = {
    assigned_role: "sage",
    attempt_count: 0,
    claimed_by: "sage-1",
    completed_at: "2026-03-19T13:40:36.000Z",
    customer_id: null,
    department_id: null,
    id: "sage-task",
    last_handoff_note:
      "Planning is complete. See https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken/index.html for the auth reference.",
    objective: "Plan the GoHighLevel workflow.",
    parent_task_id: "relay-root",
    project_id: null,
    simulation_only: false,
    state: "completed",
    title: "Plan workflow",
    updated_at: "2026-03-19T13:40:36.000Z",
  };
  const builderTask = {
    assigned_role: "builder",
    attempt_count: 0,
    claimed_by: null,
    completed_at: null,
    customer_id: null,
    department_id: null,
    id: "builder-task",
    last_handoff_note: null,
    objective: "Implement the workflow.",
    parent_task_id: "sage-task",
    project_id: null,
    simulation_only: false,
    state: "running",
    title: "Implement workflow",
    updated_at: "2026-03-19T13:40:37.000Z",
  };

  assert.equal(
    taskOutcomeTestHooks.shouldSendInterimProgressUpdate(
      sageTask,
      {
        assigned_role: "relay",
        id: "relay-root",
        parent_task_id: null,
        title: "Process message: GoHighLevel workflow...",
      },
      [sageTask, builderTask]
    ),
    false
  );
});
