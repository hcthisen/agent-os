# Iteration Log

## Template

- Iteration:
- Commit:
- Reset state:
- Observed behavior:
- First wrong action:
- Root cause:
- Fix:
- VPS redeploy:
- Result after rerun:

## Iteration 1

- Iteration: `1`
- Commit: `working tree live-deploy on 2026-03-19`
- Reset state: `Live reset completed; only the openai service connection remained active and bootstrap/pre-build skills were preserved.`
- Observed behavior: `Relay acknowledged quickly and moved the request into the proper execution path, but the blocked update surfaced an internal orchestration dump instead of a clean operator-facing checklist. The same run also treated Gemini as required now even though the prompt only said replacement visuals were optional if helpful.`
- First wrong action: `The operator-facing blocker exposed internal routing/classification text and over-blocked on an optional image-generation service.`
- Root cause: `Blocked relay updates were delivered directly from the raw handoff note without enough sanitization, and the relay requested-service classifier treated any mention of visuals as a required production-media dependency even when the wording was explicitly optional.`
- Fix: `Sanitized blocked relay checklists into operator-facing sections, filtered out internal task-only bullets, tightened blocked handoff guidance in the runtime prompt, and changed relay preflight so optional visual support does not create a required-now Gemini blocker.`
- VPS redeploy: `Yes. Supervisor changes were redeployed to the VPS after local build/test verification.`
- Result after rerun: `Pending rerun`

## Iteration 2

- Iteration: `2`
- Commit: `working tree live-deploy on 2026-03-19`
- Reset state: `Live reset completed again; only the openai service remained active before replaying the same prompt.`
- Observed behavior: `Relay acknowledged quickly, surfaced a clean blocked checklist, stated that nothing else was needed from the operator to start the build, routed execution to builder, and kept GitHub/Vercel as later requirements instead of blocking on optional visuals. The builder started inspecting the repository snapshot and the live prospect site without requiring extra operator input up front.`
- First wrong action: `None on this rerun. The blocked-path behavior matched the intended contract.`
- Root cause: `n/a`
- Fix: `No new code change for this rerun. This run validated the deployed blocked-checklist cleanup and optional-visual gating fix on the live system.`
- VPS redeploy: `Yes. The supervisor changes from Iteration 1 were already deployed before the rerun.`
- Result after rerun: `Blocked-path pass. Scenario is now ready for the resumed run after reset with GitHub and Vercel re-added from the local service-key file.`

## Iteration 3

- Iteration: `3`
- Commit: `working tree live-deploy on 2026-03-19`
- Reset state: `Live reset completed again; only the openai service remained. GitHub and Vercel were then re-added from SERVICE_KEYS.local.md before replaying the same prompt.`
- Observed behavior: `Relay acknowledged quickly, the builder completed the local Next.js implementation work, captured browser QA screenshots for both pages, and confirmed local QA looked clean. After that, instead of using the active GitHub and Vercel service connections for live execution, the agent pivoted into web-searching GitHub and Vercel API docs and never produced a repo, deployment, or final operator handoff.`
- First wrong action: `Once local build and QA were complete, the agent started API-doc web searches for GitHub and Vercel instead of attempting live service actions through the already-active service connections.`
- Root cause: `The runtime prompt and service-connection briefing were strong enough to get through local build and QA, but not explicit enough about the execution order once active credentialed services were already attached. The agent treated the post-build phase as an API research problem instead of a live execution problem.`
- Fix: `Added a generic live-service-first rule to the runtime prompt and expanded sanitized service-connection usage hints so active GitHub and Vercel connections push the agent toward direct service_request execution before any API-doc search.`
- VPS redeploy: `Pending`
- Result after rerun: `Pending rerun`

## Iteration 4

- Iteration: `4`
- Commit: `working tree live-deploy on 2026-03-19`
- Reset state: `The resumed run from Iteration 3 stayed live long enough to inspect in-place without another reset. GitHub and Vercel were already active for the task.`
- Observed behavior: `The builder created a fresh Next.js app, installed dependencies, validated that GitHub and Vercel were active, and then announced that it was about to replace the scaffold with the real two-page site. In practice, the workspace remained the untouched Next starter app and no repo, deployment, artifacts, or final relay completion were produced.`
- First wrong action: `After scaffolding and dependency install, the agent ran a broad recursive project scan that pulled generated dependency content into context instead of keeping inspection focused on the source files it needed to edit.`
- Root cause: `The runtime image still lacked ripgrep and git, and the runtime prompt did not explicitly forbid broad scans through generated trees like node_modules or .next after scaffolding. That let the agent fall back to noisy recursive inspection, drove token usage sharply upward, and stalled useful implementation progress.`
- Fix: `Added ripgrep and git to the supervisor runtime image and tightened the generic runtime prompt so agents must keep file inspection focused, explicitly avoid node_modules/.next/dist/.provider-home scans, and use pruned searches after scaffolding or package installation.`
- VPS redeploy: `Pending`
- Result after rerun: `Pending rerun`

## Iteration 5

- Iteration: `5`
- Commit: `working tree live-deploy on 2026-03-19`
- Reset state: `Live reset completed again; only openai remained, GitHub and Vercel were re-added, and the same prompt was replayed from a clean baseline.`
- Observed behavior: `Relay acknowledged quickly, reused the active GitHub/Vercel connections correctly, and the builder progressed further than before: it inspected the repo with ripgrep, created the new demo app directories, and announced that it was moving into file creation. After that, the Codex worker process disappeared from the supervisor container entirely, but the builder task remained stuck in running state and the task_run stayed in started status with no completion, failure, or relay follow-up.`
- First wrong action: `The runtime lost the builder child process mid-run and left the task marked as running instead of reconciling the vanished worker into a completed or failed terminal state.`
- Root cause: `Supervisor currently relies on normal child-process exit handling, but it has no watchdog for the case where a worker process disappears without a cleanly observed exit/close path. When that happens, the task tree hangs indefinitely instead of failing fast or resuming the parent request.`
- Fix: `Add a generic live-process watchdog in supervisor so active task runs verify that the child PID still exists. If the worker vanishes, synthesize process-exit handling, mark the run terminal, and let the task recover or fail cleanly instead of hanging forever.`
- VPS redeploy: `Pending`
- Result after rerun: `Pending rerun`

## Iteration 6

- Iteration: `6`
- Commit: `working tree live-deploy on 2026-03-19`
- Reset state: `The resumed run was recovered after the supervisor redeploy for the watchdog fix, with the same active GitHub and Vercel connections still attached.`
- Observed behavior: `This time the builder genuinely progressed: it started the local Next preview, built the demo pages and SVG visuals, created the fresh GitHub repository, and began publishing the app files into the repo through the live GitHub service connection. From the operator perspective, however, relay still went quiet after the initial acknowledgement and checklist. No relay lifecycle update surfaced when the builder actually started the implementation phase, even though the run had moved into real build/publish work and continued for many minutes.`
- First wrong action: `After the acknowledgement and blocked-style checklist, the operator was left without a meaningful relay update when the direct builder task actually started live implementation and publishing work.`
- Root cause: `The poller currently suppresses the first direct-child relay start update too aggressively. That made sense for avoiding the original double-confirm problem when the only prior relay message was the bare acknowledgement, but it also suppresses useful builder-start visibility even after relay has already sent a richer lifecycle message such as a blocked checklist or requirements update.`
- Fix: `Keep the anti-double-confirm behavior only for the narrow case where the only recent relay lifecycle message is the initial acknowledgement. If relay has already sent another richer lifecycle update, allow the first direct child start notification through so the operator sees that execution has actually begun.`
- VPS redeploy: `Pending`
- Result after rerun: `Pending rerun`

## Iteration 7

- Iteration: `7`
- Commit: `working tree live-deploy on 2026-03-19`
- Reset state: `Live reset completed again; only openai remained, GitHub and Vercel were re-added, and the same prompt was replayed from a clean baseline.`
- Observed behavior: `Relay acknowledged immediately and sent a much cleaner blocked-style checklist saying nothing else was needed from the operator because GitHub and Vercel were already active. The downstream builder did start and moved into real site inspection and service verification, but the operator still never saw an explicit relay update that execution was underway. The new direct-child start fix did not surface because the blocked checklist itself was emitted after the builder had already launched.`
- First wrong action: `The operator-facing relay checklist still did not explicitly say that builder work was already underway, so the run remained too silent once live execution began.`
- Root cause: `Allowing the first direct-child start update after a richer relay lifecycle message was not sufficient on its own, because in this request shape the root blocked checklist is produced only after the child builder has already been launched. By the time the checklist reached the operator, the start update opportunity had already been suppressed.`
- Fix: `Enrich blocked relay checklist delivery so that when the request already has an active non-relay child task, the message begins with an execution-status section stating that work is already underway and naming the active role/title. This keeps the no-double-confirm behavior while still telling the operator that real implementation has started.`
- VPS redeploy: `Pending`
- Result after rerun: `Pending rerun`

## Iteration 8

- Iteration: `8`
- Commit: `working tree live-deploy on 2026-03-19`
- Reset state: `Live reset completed again; only openai remained, GitHub and Vercel were re-added, and the same prompt was replayed from a clean baseline.`
- Observed behavior: `Relay acknowledged immediately and sent the improved blocked checklist with execution-status context. The builder then completed the real implementation path: it built the two-page demo, ran local browser QA, created the GitHub repo, created the Vercel project, and made a live deployment attempt. The builder eventually stopped in blocked_on_human with a substantive handoff explaining that publishing was only partially complete because authenticated git transport was unavailable and the first Vercel deployment payload was intentionally minimal. The operator never received that final blocker through relay.`
- First wrong action: `When a later child task produced a newer blocked_on_human handoff, relay still surfaced only the earlier root blocked checklist and never forwarded the child blocker back to the operator.`
- Root cause: `Blocked request update selection currently hard-prefers the root relay checklist over any later blocked child note, even when the child blocker is newer, more specific, and is the real terminal outcome of the execution path.`
- Fix: `Change blocked request update selection to prefer the freshest actionable blocked note in the request tree instead of always preferring the root checklist, then add coverage for the newer-child-blocker case so relay forwards the true end-of-run blocker generically across scenarios.`
- VPS redeploy: `Pending`
- Result after rerun: `Pending rerun`
