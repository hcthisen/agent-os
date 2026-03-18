import assert from "node:assert/strict";
import test from "node:test";
import { messageRouterTestHooks } from "./message-router.js";
import { taskPollerTestHooks } from "./task-poller.js";

test("relay project signals extract durable hostnames and slugs", () => {
  const signals = messageRouterTestHooks.extractRelayProjectSignals(
    'Please update https://dploy.cc/ and keep the "Homepage Refresh" workflow consistent.'
  );

  assert.deepEqual(signals.hostnames, ["dploy.cc"]);
  assert.equal(signals.slug, "dploy-cc");
  assert.ok(signals.candidate_labels.includes("Homepage Refresh"));
  assert.ok(signals.candidate_labels.includes("dploy.cc"));
});

test("relay project auto-create requires durable execution work", () => {
  assert.equal(
    messageRouterTestHooks.shouldAutoCreateRelayProject(
      {
        candidate_labels: ["dploy.cc"],
        hostnames: ["dploy.cc"],
        slug: "dploy-cc",
      },
      "Please update the dploy.cc website to use the ShortPixel CDN.",
      true
    ),
    true
  );

  assert.equal(
    messageRouterTestHooks.shouldAutoCreateRelayProject(
      {
        candidate_labels: ["status check"],
        hostnames: [],
        slug: "status-check",
      },
      "Can you answer this status check?",
      false
    ),
    false
  );
});

test("relay project matching tolerates a probable hostname typo for the same initiative", () => {
  const score = messageRouterTestHooks.scoreRelayProjectMatch(
    {
      display_name: "scalebytech.com",
      metadata: { hostnames: ["scalebytech.com"] },
      repo_url: null,
      slug: "scalebytech-com",
    },
    {
      candidate_labels: ["scalebytech.con"],
      hostnames: ["scalebytech.con"],
      slug: "scalebytech-con",
    }
  );

  assert.ok(score >= 6);
});

test("relay detects explicit requirements-walkthrough requests", () => {
  assert.equal(
    messageRouterTestHooks.looksLikeRequirementsWalkthroughRequest(
      "What other information or tools do you think you need? Let's go through everything else you need."
    ),
    true
  );

  assert.equal(
    messageRouterTestHooks.looksLikeRequirementsWalkthroughRequest(
      "Please build a landing page and deploy it once the copy is ready."
    ),
    false
  );
});

test("general execution requests still require action even without matched skills", () => {
  const decision = messageRouterTestHooks.classifyRelayExecutionRequest(
    "Please inspect this repository, identify what is missing, and tell me what credentials you still need.",
    [],
    false
  );

  assert.equal(decision.requiresExecution, true);
  assert.equal(decision.reason, "general_action_request");
});

test("reference URLs do not become durable initiative hostnames", () => {
  const hostnames = messageRouterTestHooks.extractInitiativeHostnames(
    "Review https://github.com/Leonxlnx/taste-skill.git and tell me whether we should use it."
  );

  assert.deepEqual(hostnames, []);
});

test("technology names are not treated as persistent initiative hostnames", () => {
  const signals = messageRouterTestHooks.extractRelayProjectSignals(
    "I want to create a skill that builds websites using Next.js, Tailwind CSS, ShadCN, and Vercel."
  );

  assert.deepEqual(signals.hostnames, []);
});

test("credentialed execution requests recommend sage before builder", () => {
  const decision = messageRouterTestHooks.classifyRelayExecutionRequest(
    "Please review the repository, tell me what GitHub token and Vercel access you still need, and stage the work.",
    [],
    false
  );

  assert.equal(decision.requiresExecution, true);
  assert.equal(decision.recommendedRole, "sage");
});

test("task continuation summary pushes adaptation and skill evolution", () => {
  const summary = taskPollerTestHooks.buildTaskContinuationSummary(
    {
      assigned_role: "builder",
      attempt_count: 1,
      customer_id: null,
      department_id: null,
      depends_on: [],
      id: "current-task",
      last_handoff_note: null,
      objective: "Switch dploy.cc to the ShortPixel CDN and verify the live site.",
      priority: "high",
      project_id: "project-1",
      state: "ready",
      title: "Change to ShortPixel CDN",
    },
    [
      {
        attempt_count: 1,
        completed_at: null,
        customer_id: null,
        department_id: null,
        id: "failed-1",
        last_handoff_note:
          "What is blocked: Repeating the old image pipeline kept serving stale assets.",
        objective: "Switch dploy.cc image delivery to a CDN.",
        project_id: "project-1",
        state: "failed",
        title: "Change to CDN",
        updated_at: "2026-03-15T10:00:00.000Z",
      },
      {
        attempt_count: 0,
        completed_at: "2026-03-14T10:00:00.000Z",
        customer_id: null,
        department_id: null,
        id: "done-1",
        last_handoff_note:
          "What changed: Published the working asset pipeline with explicit verification.",
        objective: "Update dploy.cc homepage image delivery and verify live output.",
        project_id: "project-1",
        state: "completed",
        title: "Homepage image delivery update",
        updated_at: "2026-03-14T10:00:00.000Z",
      },
      {
        attempt_count: 0,
        completed_at: "2026-03-13T10:00:00.000Z",
        customer_id: null,
        department_id: null,
        id: "done-2",
        last_handoff_note:
          "What changed: Verified the live site and recorded the durable steps.",
        objective: "Verify dploy.cc asset optimization workflow.",
        project_id: "project-1",
        state: "completed",
        title: "Asset optimization verification",
        updated_at: "2026-03-13T10:00:00.000Z",
      },
    ]
  );

  assert.ok(Array.isArray(summary.similar_task_history));
  assert.match(String(summary.adaptation_guidance || ""), /materially different approach/i);
  assert.match(String(summary.adaptation_guidance || ""), /persistent initiative/i);
  assert.match(String(summary.skill_evolution_directive || ""), /shared skill/i);
});
