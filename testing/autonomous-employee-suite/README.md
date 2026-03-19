# Autonomous Employee Stress-Test Suite

This folder holds six reusable operator-style scenarios for testing the system as an autonomous digital employee. The prompts are intentionally written in natural business-owner language and are meant to stress routing, planning, execution, service gating, schedule creation, artifact delivery, and task completion quality.

## Goal

The suite should verify that the system can:

- complete clear one-shot requests end-to-end without unnecessary clarification;
- pause and ask for the minimum missing information or service activation when a task genuinely needs operator input;
- create useful operator-facing outputs rather than internal orchestration summaries;
- make generic product and logic improvements after a failure, then succeed when the exact same prompt is rerun.
- keep the operator informed through the relay agent as work moves through the system.

## Operator Communication Contract

These rules apply to every scenario in this suite:

- `relay` is the normal operator-facing voice for request acknowledgement, progress, blocked-state explanations, and final completion;
- `system` should message the operator only for hard errors, stale-task attention, or service/API-key actions that require the operator to use Service Connections;
- after the request is routed, the operator should see a relay acknowledgement quickly rather than experiencing long silent periods;
- relay updates should appear on meaningful lifecycle changes such as request received, downstream work started, blocked waiting on input, and completion;
- a long-running task that stays silent and then returns only a short truncated message is a failure.

## Deliverable Contract

These rules also apply across the suite:

- review, audit, research, and report-style work should default to a rich operator-facing deliverable, not a chat-only summary;
- when a full result page or report is the best format, the system should create it and surface it clearly to the operator;
- if screenshots or visual evidence are collected, they should be embedded in the delivered report whenever practical instead of being left buried in a workspace;
- the chat reply can be concise, but it must point clearly to the full result and still read like a complete relay message rather than a clipped fragment.

## Scenario Matrix

- `01-local-service-site-audit`: one-shot website and competitor teardown for a local service business.
- `02-local-prospect-research`: one-shot local-market prospecting and outreach-angle research.
- `03-weekly-exec-brief-schedule`: one-shot recurring owner brief plus dry-run schedule creation.
- `04-prospect-demo-build`: gated GitHub, deployment, and optional image-generation workflow.
- `05-ghl-missed-call-workflow`: gated CRM automation setup in GoHighLevel.
- `06-offer-campaign-asset-pack`: gated image and voice asset generation workflow.

## Suite Tracker

Use `TEST_PLAN.md` in this folder as the suite-level status board for all six scenarios. Keep the per-scenario `iterations.md` files as the detailed run logs and use `TEST_PLAN.md` to track current status, blockers, latest iteration, and next actions across the full suite.

## Loop

1. Reset the live VPS runtime while preserving provider auth and only the `openai` service entry.
2. Submit the saved prompt from the scenario `prompt.md`.
3. Monitor the full run across `messages`, `tasks`, `events`, `handoffs`, `memories`, `artifacts`, workspace output, `service_registry`, and `schedules` where relevant.
4. Stop the run as soon as something materially wrong is observed.
5. Patch the repo for the general logic or process failure. Do not patch the system to satisfy one saved prompt by hardcoding an answer, special-casing an exact phrase, or stuffing missing guidance into the prompt.
6. Build locally.
7. Redeploy the affected services to the VPS.
8. Reset again and rerun the same prompt.
9. Record the result in the scenario `iterations.md`.

## Reset

Run:

```powershell
python testing/website-demo-skill/reset_live_system.py
```

The reset script clears runtime history, projects, memories, skills, schedules, workspaces, and all non-OpenAI service connections while preserving:

- provider auth volumes;
- the `openai` service registry entry only;
- stack configuration and env values.

The reset helper now accepts either `VPS_PASSWD` or `VPS_SSH_PASSWD` from `.env`.

After each reset, any previously added third-party service connection or `key_needed` placeholder row should be gone. If a gated scenario needs GitHub, Vercel, GoHighLevel, Gemini, ElevenLabs, or another external service for the resumed run, re-add it after the reset and before rerunning the prompt.

## Shared Service-Key File

Use the shared local key file here:

```text
testing/autonomous-employee-suite/SERVICE_KEYS.local.md
```

Reference template:

```text
testing/autonomous-employee-suite/SERVICE_KEYS.example.md
```

Use that file to prepare the real values needed by gated scenarios. Do not place secrets in prompts or iteration logs. The default flow for gated tests is to let the first run block correctly, then reset if needed, activate the requested service in the admin app service registry using the values from `SERVICE_KEYS.local.md`, and rerun the same prompt. Do not assume non-OpenAI service connections survive the reset.

That shared key file should contain credentials only. Do not turn it into a config dump. Model selection, current API usage, voice choice, repo naming, and similar operational details should be discovered by the system during the task or requested explicitly only if they are genuinely needed.

## Prompt Style Rule

These prompts should stay natural. They should sound like a normal owner handing work to a digital employee, not like an eval harness telling the system how to solve the task. Keep the asks realistic, leave room for the system to reason, and avoid writing the answer into the prompt.

## Generic Fix Rule

This rule applies to every scenario in this suite:

- monitor the whole system, not only the final chat reply;
- stop at the first materially wrong action;
- fix the general routing, planning, execution, delivery, or service-gating logic;
- do not solve the scenario by adding the missing answer directly to the saved prompt;
- do not special-case one company, one niche, one URL, one provider, or one phrasing pattern;
- rerun the same prompt after reset so the improvement proves it is generic.

## Monitoring Focus

- relay-visible acknowledgement and lifecycle communication appear early enough to avoid silent execution gaps;
- normal operator-facing messages come from `relay`, while `system` is reserved for errors and service-connection prompts;
- operator-visible outbound messages are delivered when meaningful work is complete or when the system is genuinely blocked;
- report-style work produces a usable rich deliverable, with visual evidence embedded when it exists;
- child-task creation and role selection match the request instead of drifting into unrelated work;
- service requests are precise, minimal, and only used when a real external dependency is missing;
- memory, artifact, and schedule writes stay concise and relevant to the scenario;
- prompt propagation stays coherent across relay, sage, builder, reviewer, and any downstream tasks.
