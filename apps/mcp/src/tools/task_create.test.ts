import assert from "node:assert/strict";
import test from "node:test";
import { taskCreateTestHooks } from "./task_create.js";

test("requirements walkthrough roots block implementation delegation", () => {
  assert.equal(
    taskCreateTestHooks.shouldBlockRequirementsWalkthroughDelegation(
      {
        assigned_role: "relay",
        id: "root-task",
        objective:
          "Process this inbound message.\nRequirements walkthrough requested: yes.\nRecommended downstream role: sage.",
        parent_task_id: null,
        title: "Process message: Website skill planning...",
      },
      "builder"
    ),
    true
  );

  assert.equal(
    taskCreateTestHooks.shouldBlockRequirementsWalkthroughDelegation(
      {
        assigned_role: "relay",
        id: "root-task",
        objective:
          "Process this inbound message.\nRequirements walkthrough requested: yes.\nRecommended downstream role: sage.",
        parent_task_id: null,
        title: "Process message: Website skill planning...",
      },
      "sage"
    ),
    false
  );
});
