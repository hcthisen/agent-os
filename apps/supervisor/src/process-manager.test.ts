import test from "node:test";
import assert from "node:assert/strict";
import { processManagerTestHooks } from "./process-manager.js";

test("extracts Claude success result text from stream-json output", () => {
  const parsed = processManagerTestHooks.extractStructuredProcessOutput(
    [
      JSON.stringify({
        type: "system",
        subtype: "init",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Intermediate progress update." }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "OK",
      }),
    ].join("\n")
  );

  assert.equal(parsed.handoffNote, "OK");
  assert.equal(parsed.isError, false);
  assert.equal(parsed.outcome.type, "result");
});

test("extracts Claude error result text from stream-json output", () => {
  const parsed = processManagerTestHooks.extractStructuredProcessOutput(
    [
      JSON.stringify({
        type: "system",
        subtype: "init",
      }),
      JSON.stringify({
        type: "assistant",
        error: "invalid_request",
        message: {
          content: [
            {
              type: "text",
              text:
                "There's an issue with the selected model (definitely-not-a-model). It may not exist or you may not have access to it.",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result:
          "There's an issue with the selected model (definitely-not-a-model). It may not exist or you may not have access to it.",
      }),
    ].join("\n")
  );

  assert.equal(
    parsed.handoffNote,
    "There's an issue with the selected model (definitely-not-a-model). It may not exist or you may not have access to it."
  );
  assert.equal(parsed.isError, true);
  assert.equal(parsed.outcome.is_error, true);
});

test("retries transient Anthropic 500 failures", () => {
  const shouldRetry = processManagerTestHooks.shouldRetryTransientProviderFailure({
    code: 1,
    provider: "anthropic",
    signal: null,
    structuredFailureDetail:
      'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    terminationReason: null,
  });

  assert.equal(shouldRetry, true);
});

test("does not retry non-transient provider failures", () => {
  const shouldRetry = processManagerTestHooks.shouldRetryTransientProviderFailure({
    code: 1,
    provider: "anthropic",
    signal: null,
    structuredFailureDetail:
      "There's an issue with the selected model (definitely-not-a-model). It may not exist or you may not have access to it.",
    terminationReason: null,
  });

  assert.equal(shouldRetry, false);
});

test("prefers the richer final message over a generic handoff note", () => {
  const preferred = processManagerTestHooks.choosePreferredTaskNote(
    "What I did: Classified the request and created a downstream planning task.",
    [
      "I’ve classified this as a reusable website-demo workflow, not a one-off build.",
      "",
      "What I still need now:",
      "- The client URL",
      "- GitHub token or repo access",
      "- Vercel token",
    ].join("\n")
  );

  assert.match(String(preferred), /What I still need now:/);
  assert.ok(
    processManagerTestHooks.scoreTaskOperatorNote(String(preferred)) >
      processManagerTestHooks.scoreTaskOperatorNote(
        "What I did: Classified the request and created a downstream planning task."
      )
  );
});
