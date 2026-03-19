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
      "builder",
      true
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
      "sage",
      true
    ),
    false
  );
});

test("requirements walkthrough roots allow implementation delegation once blockers are cleared", () => {
  assert.equal(
    taskCreateTestHooks.shouldBlockRequirementsWalkthroughDelegation(
      {
        assigned_role: "relay",
        id: "root-task",
        objective:
          "Process this inbound message.\nRequirements walkthrough requested: yes.\nRecommended downstream role: builder.",
        parent_task_id: null,
        title: "Process message: Asset pack production...",
      },
      "builder",
      false
    ),
    false
  );
});

test("direct child tasks do not keep a depends_on cycle on their own parent", () => {
  assert.deepEqual(
    taskCreateTestHooks.normalizeDependencyIdsForParent(
      ["relay-root", "builder-2", "relay-root"],
      "relay-root"
    ),
    ["builder-2"]
  );
});
