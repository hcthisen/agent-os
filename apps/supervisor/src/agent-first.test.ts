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
      "If there is anything you genuinely need from me or from the GoHighLevel account, tell me exactly what it is."
    ),
    true
  );

  assert.equal(
    messageRouterTestHooks.looksLikeRequirementsWalkthroughRequest(
      "If you need image or voice services, or if there is something missing that would make the output unsafe or off-brand, ask for exactly what you need and then continue once you have it."
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

test("media-generation requests that mention missing services recommend sage first", () => {
  assert.equal(
    messageRouterTestHooks.determineRelayRecommendedRole(
      [],
      "Prepare a small asset pack with 3 image concepts, short ad copy, and one short voiceover version. If you need image or voice services, ask for exactly what you need and then continue once you have it."
    ),
    "sage"
  );
});

test("optional replacement visuals do not make image generation required now", () => {
  assert.equal(
    messageRouterTestHooks.looksLikeOptionalVisualSupportRequest(
      "Build a 2-page demo that looks materially better than the current site. If it helps, you can also generate replacement visuals."
    ),
    true
  );
  assert.equal(
    messageRouterTestHooks.shouldRequireImageServiceNow(
      "Build a 2-page demo that looks materially better than the current site. If it helps, you can also generate replacement visuals."
    ),
    false
  );
});

test("explicit image deliverables still make image generation required now", () => {
  assert.equal(
    messageRouterTestHooks.shouldRequireImageServiceNow(
      "Prepare a small asset pack with 3 image concepts, short ad copy, and one short voiceover version."
    ),
    true
  );
});

test("github push plus vercel deploy defaults to fresh targets when none are specified", () => {
  assert.equal(
    messageRouterTestHooks.shouldDefaultToFreshRepoAndDeploymentTargets(
      "Push everything to GitHub and deploy it on Vercel when you have what you need."
    ),
    true
  );

  assert.equal(
    messageRouterTestHooks.shouldDefaultToFreshRepoAndDeploymentTargets(
      "Use the existing GitHub repo and deploy to the existing Vercel project once the changes are ready."
    ),
    false
  );
});

test("recurring schedule setup requests recommend architect for live activation", () => {
  assert.equal(
    messageRouterTestHooks.determineRelayRecommendedRole(
      [],
      "Every Monday at 07:30 my time, set up a recurring owner brief and send it automatically."
    ),
    "architect"
  );
});

test("credentialed recurring automation requests still recommend sage first", () => {
  assert.equal(
    messageRouterTestHooks.determineRelayRecommendedRole(
      [],
      "Set up a recurring GoHighLevel missed-call text-back workflow and automate the follow-up."
    ),
    "sage"
  );
});

test("credentialed implementation follow-ups with concrete execution details recommend builder", () => {
  assert.equal(
    messageRouterTestHooks.determineRelayRecommendedRole(
      [],
      'Yes, the GoHighLevel service connection is already set up in the system for location ID e5bbkTW6urr3zew52cxA. Use Europe/Copenhagen, create or use a pipeline named "Missed Call Follow-Up", set the stage to "Missed Calls - New", and apply the tag "missed-call-textback".'
    ),
    "builder"
  );
});

test("credentialed implementation follow-ups with live workflow rules still recommend builder", () => {
  assert.equal(
    messageRouterTestHooks.determineRelayRecommendedRole(
      [],
      'Use the GoHighLevel location already connected by the active service. Set the pipeline to "Aalborg El-service", move new items into the stage "Missed Call - Needs Follow-up", apply the tag "missed-call-textback", use Europe/Copenhagen business hours Monday to Friday 07:30-16:30, treat voicemail as a missed call, and create a morning team-queue task at 08:00 local time.'
    ),
    "builder"
  );
});

test("blocked_on_agent tasks resume once all child tasks are terminal", () => {
  assert.equal(
    taskPollerTestHooks.shouldResumeBlockedTask(
      { state: "blocked_on_agent" },
      [
        {
          completed_at: "2026-03-19T06:24:23.473535+00:00",
          id: "child-1",
          last_handoff_note: null,
          parent_task_id: "parent-1",
          state: "completed",
          title: "Create weekly owner brief schedule as architect",
          updated_at: "2026-03-19T06:24:23.473535+00:00",
        },
      ]
    ),
    true
  );
});

test("blocked_on_agent tasks stay parked while any child task is still active", () => {
  assert.equal(
    taskPollerTestHooks.shouldResumeBlockedTask(
      { state: "blocked_on_agent" },
      [
        {
          completed_at: null,
          id: "child-1",
          last_handoff_note: null,
          parent_task_id: "parent-1",
          state: "running",
          title: "Create weekly owner brief schedule as architect",
          updated_at: "2026-03-19T06:24:23.473535+00:00",
        },
      ]
    ),
    false
  );
});

test("immediate child-start updates are suppressed when the relay acknowledgement just went out", () => {
  assert.equal(
    taskPollerTestHooks.shouldSuppressImmediateStartUpdate([
      {
        created_at: "2026-03-19T10:16:00.000Z",
        metadata: {
          notification_key: "request-received:relay-root",
          notification_type: "task_progress",
          relay_update_kind: "received",
        },
        sender: "relay",
      },
    ]),
    true
  );

  assert.equal(
    taskPollerTestHooks.shouldSuppressImmediateStartUpdate([
      {
        created_at: "2026-03-19T10:16:00.000Z",
        metadata: {
          notification_key: "request-received:relay-root",
          notification_type: "task_progress",
          relay_update_kind: "received",
        },
        sender: "relay",
      },
      {
        created_at: "2026-03-19T10:16:20.000Z",
        metadata: {
          notification_key: "request-blocked:relay-root",
          notification_type: "task_progress",
          relay_update_kind: "blocked",
        },
        sender: "relay",
      },
    ]),
    false
  );
});

test("first direct child launch under relay is suppressed to avoid double-confirming the request", () => {
  assert.equal(
    taskPollerTestHooks.shouldSuppressFirstDirectChildStartUpdate(
      { parent_task_id: "relay-root" },
      "relay-root"
    ),
    true
  );

  assert.equal(
    taskPollerTestHooks.shouldSuppressFirstDirectChildStartUpdate(
      { parent_task_id: "sage-task" },
      "relay-root"
    ),
    false
  );
});

test("first direct child launch is allowed once relay already sent a richer lifecycle update", () => {
  assert.equal(
    taskPollerTestHooks.shouldSuppressDirectChildStartLifecycleUpdate(
      { parent_task_id: "relay-root" },
      "relay-root",
      1,
      [
        {
          created_at: "2026-03-19T10:16:00.000Z",
          metadata: {
            notification_key: "request-received:relay-root",
            notification_type: "task_progress",
            relay_update_kind: "received",
          },
          sender: "relay",
        },
        {
          created_at: "2026-03-19T10:16:20.000Z",
          metadata: {
            notification_key: "request-blocked:relay-root",
            notification_type: "task_progress",
            relay_update_kind: "blocked",
          },
          sender: "relay",
        },
      ]
    ),
    false
  );

  assert.equal(
    taskPollerTestHooks.shouldSuppressDirectChildStartLifecycleUpdate(
      { parent_task_id: "relay-root" },
      "relay-root",
      1,
      [
        {
          created_at: "2026-03-19T10:16:00.000Z",
          metadata: {
            notification_key: "request-received:relay-root",
            notification_type: "task_progress",
            relay_update_kind: "received",
          },
          sender: "relay",
        },
      ]
    ),
    true
  );
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
