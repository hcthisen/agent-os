import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OPENAI_MODEL_MAP,
  DEFAULT_OPENAI_ROLE_CONFIG,
} from "./runtime-provider.js";

test("default Codex role alignments use the intended GPT-5.4 profiles", () => {
  assert.deepEqual(DEFAULT_OPENAI_MODEL_MAP, {
    haiku: "gpt-5.4-mini",
    opus: "gpt-5.4",
    sonnet: "gpt-5.4-mini",
  });

  assert.deepEqual(DEFAULT_OPENAI_ROLE_CONFIG.relay, {
    effort: "low",
    model: "gpt-5.4-mini",
  });
  assert.deepEqual(DEFAULT_OPENAI_ROLE_CONFIG.sentinel, {
    effort: "medium",
    model: "gpt-5.4-mini",
  });
  assert.deepEqual(DEFAULT_OPENAI_ROLE_CONFIG.reviewer, {
    effort: "high",
    model: "gpt-5.4-mini",
  });
});
