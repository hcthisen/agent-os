import test from "node:test";
import assert from "node:assert/strict";
import { skillAutocaptureTestHooks } from "./skill-autocapture.js";

test("extractReusableSkillSection captures structured handoff block", () => {
  const note = [
    "What changed: Published the improved workflow.",
    "Reusable procedure:",
    "Name: shortpixel-cdn-rollout",
    "Display name: ShortPixel CDN Rollout",
    "Scope: project",
    "Trigger: When a site must switch image delivery to ShortPixel CDN.",
    "Tags: cdn, shortpixel",
    "Steps:",
    "- Audit the current image pipeline and where image URLs are generated.",
    "- Apply the ShortPixel integration or configuration change.",
    "- Verify transformed assets in a real browser before closing the task.",
    "What is blocked: Nothing blocked.",
  ].join("\n");

  const section = skillAutocaptureTestHooks.extractReusableSkillSection(note);
  assert.ok(section);
  assert.match(String(section), /shortpixel-cdn-rollout/i);
  assert.doesNotMatch(String(section), /What is blocked/i);
});

test("parseReusableSkillFromTask defaults to project scope and normalizes steps", () => {
  const parsed = skillAutocaptureTestHooks.parseReusableSkillFromTask({
    assigned_role: "builder",
    attempt_count: 1,
    claimed_by: "agent-1",
    customer_id: null,
    department_id: null,
    id: "task-1",
    last_handoff_note: [
      "What changed: The improved pipeline is live.",
      "Reusable procedure:",
      "Display name: Image Pipeline Recovery",
      "Trigger: When cached image delivery keeps serving stale assets.",
      "Steps:",
      "- Inspect the current image path and confirm where stale assets are produced.",
      "- Replace the stale pipeline with the working asset path.",
      "- Verify the live result in a browser and record evidence.",
    ].join("\n"),
    objective: "Repair the image delivery path.",
    project_id: "project-1",
    simulation_only: false,
    title: "Repair the image delivery path",
  });

  assert.ok(parsed);
  assert.equal(parsed?.scope_type, "project");
  assert.equal(parsed?.scope_id, "project-1");
  assert.equal(parsed?.steps.length, 3);
  assert.equal(parsed?.name, "image-pipeline-recovery");
  assert.match(String(parsed?.tags.join(",")), /auto-captured/);
});

test("parseReusableSkillFromTask returns null when the block is missing enough steps", () => {
  const parsed = skillAutocaptureTestHooks.parseReusableSkillFromTask({
    assigned_role: "builder",
    attempt_count: 0,
    claimed_by: null,
    customer_id: null,
    department_id: null,
    id: "task-2",
    last_handoff_note: [
      "Reusable procedure:",
      "Name: too-short",
      "Steps:",
      "- Verify it.",
    ].join("\n"),
    objective: "Test",
    project_id: null,
    simulation_only: false,
    title: "Test",
  });

  assert.equal(parsed, null);
});
