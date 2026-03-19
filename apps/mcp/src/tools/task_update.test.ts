import assert from "node:assert/strict";
import test from "node:test";
import { taskUpdateTestHooks } from "./task_update.js";

test("completion updates are held open when child work should still finish", () => {
  assert.equal(
    taskUpdateTestHooks.shouldBlockCompletionForActiveChildren("completed"),
    true
  );
  assert.equal(
    taskUpdateTestHooks.shouldBlockCompletionForActiveChildren("in_review"),
    false
  );
  assert.equal(
    taskUpdateTestHooks.shouldBlockCompletionForActiveChildren("blocked_on_agent"),
    false
  );
});
