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

test("browser-capable prompts include concrete agent-browser commands and no-daemon guidance", () => {
  const prompt = processManagerTestHooks.buildPrompt(
    "builder-1",
    "builder",
    {
      task: {
        acceptance_criteria: [],
        id: "task-1",
        objective: "Review a public website in a real browser and capture evidence.",
        title: "Review website",
      },
    },
    "openai"
  );

  assert.match(prompt, /agent-browser open <url>/);
  assert.match(prompt, /agent-browser snapshot -i/);
  assert.match(prompt, /agent-browser screenshot <path>/);
  assert.match(prompt, /agent-browser close/);
  assert.match(prompt, /Do not launch a bare `agent-browser` daemon/i);
  assert.match(
    prompt,
    /Never recursively scan dependency or build-output trees such as node_modules, \.next, dist,\s+coverage, \.provider-home/i
  );
  assert.match(
    prompt,
    /After scaffolding or package installation, inspect only targeted files or use rg\/find\s+with explicit pruning/i
  );
  assert.match(prompt, /Do not run broad recursive listings on a newly scaffolded app or dependency tree/i);
});

test("isProcessAlive returns false for missing pid and true for the current process", () => {
  assert.equal(processManagerTestHooks.isProcessAlive(undefined), false);
  assert.equal(processManagerTestHooks.isProcessAlive(process.pid), true);
});

test("shouldReconcileMissingProcess ignores already-terminated runs and healthy pids", () => {
  const active = {
    proc: { pid: process.pid },
    terminationReason: null,
  } as Parameters<typeof processManagerTestHooks.shouldReconcileMissingProcess>[0];

  assert.equal(processManagerTestHooks.shouldReconcileMissingProcess(active), false);

  active.terminationReason = "missing_process";
  assert.equal(processManagerTestHooks.shouldReconcileMissingProcess(active), false);
});

test("shouldReconcileMissingProcess returns true when the pid is absent", () => {
  const active = {
    proc: { pid: undefined },
    terminationReason: null,
  } as Parameters<typeof processManagerTestHooks.shouldReconcileMissingProcess>[0];

  assert.equal(processManagerTestHooks.shouldReconcileMissingProcess(active), true);
});

test("prompts explain dependency chains for staged execution", () => {
  const prompt = processManagerTestHooks.buildPrompt(
    "sage-1",
    "sage",
    {
      task: {
        acceptance_criteria: [],
        id: "task-2",
        objective: "Plan a staged implementation with review after builder work.",
        title: "Plan staged execution",
      },
    },
    "openai"
  );

  assert.match(prompt, /planner -> builder -> reviewer/i);
  assert.match(
    prompt,
    /review or verification tasks depend only on the current planning task/i
  );
  assert.match(
    prompt,
    /reuse those exact identifiers in downstream service requests/i
  );
  assert.match(
    prompt,
    /If the task blocks on missing input, missing access, or missing services, make the handoff note operator-facing/i
  );
});

test("prompts require actual media generation when active services are available", () => {
  const prompt = processManagerTestHooks.buildPrompt(
    "builder-1",
    "builder",
    {
      task: {
        acceptance_criteria: [],
        id: "task-3",
        objective: "Generate campaign images and audio with active services.",
        title: "Generate campaign media",
      },
    },
    "openai"
  );

  assert.match(prompt, /generate the actual media files/i);
  assert.match(prompt, /move into live generation early/i);
  assert.match(prompt, /planning-only briefs before the first real generation attempt/i);
  assert.match(prompt, /prefer output_path/i);
  assert.match(prompt, /If body_base64 is returned instead/i);
  assert.match(prompt, /register that file with artifact_put/i);
  assert.match(
    prompt,
    /default to creating a new repo and a new Vercel project for this initiative/i
  );
  assert.match(
    prompt,
    /make a live attempt through the available tool surface before you browse API docs/i
  );
  assert.match(
    prompt,
    /Use docs or web search only after a concrete live API attempt fails/i
  );
  assert.match(
    prompt,
    /Do not spend the first post-build or post-QA phase on GitHub, Vercel, CRM, or media API doc searches/i
  );
  assert.match(
    prompt,
    /Git operations in this runtime are non-interactive/i
  );
  assert.match(
    prompt,
    /If a plain `git push` cannot authenticate immediately, stop that path and use the active GitHub service connection through API calls/i
  );
  assert.match(
    prompt,
    /upload the full source tree recursively/i
  );
  assert.match(
    prompt,
    /important nested source paths are visible on the target branch/i
  );
  assert.match(
    prompt,
    /If you start a local preview server such as `serve`, `next dev`, or `vite` for QA, stop it once the screenshots and checks are done/i
  );
  assert.match(
    prompt,
    /use the active Vercel service connection to create the project and send a complete deployment payload/i
  );
  assert.match(
    prompt,
    /prefer deploying that local output directly to Vercel instead of blocking on GitHub repo visibility/i
  );
  assert.match(prompt, /POST \/v2\/files/i);
  assert.match(prompt, /POST \/v13\/deployments/i);
  assert.match(
    prompt,
    /incorrect_git_source_info.*not the final answer/i
  );
});

test("codex config includes remote MCP servers with env-backed auth headers", () => {
  const toml = processManagerTestHooks.buildCodexConfigToml(
    {
      AGENT_RUNTIME_JWT: "jwt",
      TASK_ID: "task-1",
    },
    [
      {
        bearerTokenEnvVar: "AGENT_OS_REMOTE_MCP_GOHIGHLEVEL_TOKEN",
        envHttpHeaders: {
          locationId: "AGENT_OS_REMOTE_MCP_GOHIGHLEVEL_LOCATION_ID",
        },
        name: "gohighlevel",
        startupTimeoutSec: 30,
        toolTimeoutSec: 120,
        url: "https://services.leadconnectorhq.com/mcp/",
      },
    ]
  );

  assert.match(toml, /\[mcp_servers\.gohighlevel\]/);
  assert.match(toml, /rmcp_client = true/);
  assert.match(
    toml,
    /bearer_token_env_var = "AGENT_OS_REMOTE_MCP_GOHIGHLEVEL_TOKEN"/
  );
  assert.match(toml, /\[mcp_servers\.gohighlevel\.env_http_headers\]/);
  assert.match(
    toml,
    /"locationId" = "AGENT_OS_REMOTE_MCP_GOHIGHLEVEL_LOCATION_ID"/
  );
});
