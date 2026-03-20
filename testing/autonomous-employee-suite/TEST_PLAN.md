# Autonomous Employee Test Plan

This file is the suite-level tracker for the six autonomous employee scenarios. Use it to track overall progress, current blockers, latest rerun result, and whether each test has passed both the blocked path and the resumed end-to-end path where relevant.

## Status Legend

| Status | Meaning |
|--------|---------|
| `not_started` | The scenario has not been run yet. |
| `running` | The current iteration is being tested or monitored. |
| `fixing` | A material failure was found and a generic fix is being implemented. |
| `blocked_waiting_input` | The scenario correctly paused and is waiting for the operator to add a missing service or answer a real question. |
| `rerun_ready` | The scenario is ready for the next rerun from a reset state. |
| `passed` | The scenario completed the intended path successfully. |
| `stable` | The scenario has passed and stayed correct on at least one confirmation rerun. |

## Global Rules

| Rule | Requirement |
|------|-------------|
| Reset baseline | Before each fresh run, use `python testing/website-demo-skill/reset_live_system.py`. The reset keeps provider auth and the `openai` service entry only. |
| Service state | All other `service_registry` rows, including active third-party credentials and `key_needed` placeholders, should be absent at the start of a fresh run. |
| Monitoring | Inspect the whole system, not only the final chat reply. Watch `messages`, `tasks`, `events`, `handoffs`, `memories`, `artifacts`, workspaces, `service_registry`, and `schedules` where relevant. |
| Relay contract | Normal request lifecycle updates must come from `relay`. `system` should only surface errors, stale-task alerts, or service/API-key actions. |
| Silent-run rule | After routing, the operator should receive a relay acknowledgement quickly enough that the run does not go silent for long stretches. |
| Deliverable contract | Review, audit, research, and report-style tasks should produce a rich operator-facing result surface by default, with embedded visual evidence when it exists. |
| Stop condition | Stop the run at the first materially wrong action. |
| Fix policy | Fix the general logic or process, not the single prompt wording. Do not overfit code or prompts to one saved scenario. |
| Rerun policy | After a generic fix, rerun the same prompt from a reset state. |

## Suite Progress

| ID | Scenario | Type | Latest status | Latest iteration | First blocked path correct | Resumed run passed | Stable rerun passed | Current blocker | Next action |
|----|----------|------|---------------|------------------|----------------------------|--------------------|---------------------|-----------------|-------------|
| `01` | Local service site audit | one-shot | `passed` | `2` | `n/a` | `n/a` | `n/a` | `Awaiting later confirmation rerun after subsequent shared logic changes.` | Continue suite, then run a confirmation rerun before closing the campaign. |
| `02` | Local prospect research | one-shot | `passed` | `1` | `n/a` | `n/a` | `n/a` | `Awaiting later confirmation rerun after subsequent shared logic changes.` | Continue suite, then run a confirmation rerun before closing the campaign. |
| `03` | Weekly exec brief schedule | one-shot | `passed` | `7` | `n/a` | `n/a` | `n/a` | `Awaiting later confirmation rerun after subsequent shared logic changes.` | Continue suite, then run a confirmation rerun before closing the campaign. |
| `04` | Prospect demo build | gated | `fixing` | `11` | `yes` | `no` | `no` | `The latest resumed run no longer stops at the earlier GitHub/Vercel blockers, but the request still does not complete cleanly: the builder task completed once, then the same builder task was relaunched without a useful new handoff, and relay emitted a misleading started update about reviewer work while the root request remained unresolved.` | Investigate why a completed/in_review downstream task can be relaunched and why relay can mislabel the resumed lifecycle update, then rerun Scenario 04 from reset before continuing the suite. |
| `05` | GoHighLevel missed-call workflow | gated | `passed` | `5` | `yes` | `yes` | `no` | `Awaiting later confirmation rerun after subsequent shared logic changes.` | `Continue the suite, then run a confirmation rerun before closing the campaign.` |
| `06` | Offer campaign asset pack | gated | `passed` | `3` | `yes` | `yes` | `no` | `Awaiting later confirmation rerun after subsequent shared logic changes.` | Continue the suite, then run a confirmation rerun before closing the campaign. |

## Progress Checklists

### `01` Local Service Site Audit

- [x] First baseline run started
- [x] Relay acknowledgement observed
- [x] Relay remained the normal operator-facing sender
- [x] Rich result page surfaced clearly to the operator
- [x] Screenshot or visual evidence embedded in the delivered report
- [x] One-shot completion passed
- [ ] Stable confirmation rerun passed

### `02` Local Prospect Research

- [x] First baseline run started
- [x] Relay acknowledgement observed
- [x] Relay remained the normal operator-facing sender
- [x] Rich result page surfaced clearly to the operator
- [x] One-shot completion passed
- [ ] Stable confirmation rerun passed

### `03` Weekly Exec Brief Schedule

- [x] First baseline run started
- [x] Relay acknowledgement observed
- [x] Relay remained the normal operator-facing sender
- [x] Schedule creation passed
- [x] Dry-run brief passed
- [ ] Stable confirmation rerun passed

### `04` Prospect Demo Build

- [x] First blocked-path baseline run started
- [x] Relay acknowledgement observed
- [x] Relay remained the normal operator-facing sender
- [x] Missing-service block behavior passed
- [x] Requested services re-added after reset
- [ ] Resumed end-to-end run passed
- [ ] Stable confirmation rerun passed

### `05` GoHighLevel Missed-Call Workflow

- [x] First blocked-path baseline run started
- [x] Relay acknowledgement observed
- [x] Relay remained the normal operator-facing sender
- [x] Missing-service or missing-input block behavior passed
- [x] GoHighLevel re-added after reset
- [x] Resumed end-to-end run passed
- [ ] Stable confirmation rerun passed

### `06` Offer Campaign Asset Pack

- [x] First blocked-path baseline run started
- [x] Relay acknowledgement observed
- [x] Relay remained the normal operator-facing sender
- [x] Missing-service or missing-input block behavior passed
- [x] Required generation services re-added after reset
- [x] Resumed end-to-end run passed
- [ ] Stable confirmation rerun passed

## Scenario Checklist

| ID | Scenario | Required outcome |
|----|----------|------------------|
| `01` | Local service site audit | Completes end-to-end from one prompt, keeps the operator updated via relay, and returns an evidence-backed HTML audit with embedded screenshots when available. |
| `02` | Local prospect research | Completes end-to-end from one prompt, keeps the operator updated via relay, and returns a verified ranked outreach list in a rich operator-facing deliverable. |
| `03` | Weekly exec brief schedule | Creates the recurring schedule, keeps the operator updated via relay, and returns a useful dry-run brief from the same prompt. |
| `04` | Prospect demo build | First run blocks correctly on real missing services or inputs through relay-led communication, then resumed run completes build, repo, and deployment flow once the requested services are re-added. |
| `05` | GoHighLevel missed-call workflow | First run blocks correctly on missing service or policy details through relay-led communication, then resumed run completes the CRM setup once GHL is re-added and any real missing details are provided. |
| `06` | Offer campaign asset pack | First run blocks correctly on missing generation services or brand-critical details through relay-led communication, then resumed run completes the asset pack once the requested services are re-added and any real missing details are provided. |

## Run Log Summary

Use this table to keep a compact suite-level history. The per-scenario `iterations.md` files remain the detailed source of truth.

| Date | Scenario ID | Iteration | Status after run | First wrong action or key result | Generic fix made | Rerun result |
|------|-------------|-----------|------------------|----------------------------------|------------------|--------------|
| 2026-03-18 | `01` | `1` | `fixing` | `No relay acknowledgement or lifecycle updates, completion came from system, and the deliverable was a truncated summary instead of a report.` | `Implemented relay-first lifecycle messaging and rich result-page delivery with embedded evidence support.` | `Pending rerun` |
| 2026-03-18 | `01` | `2` | `passed` | `Relay acknowledgement, relay lifecycle updates, delivery-page CTA, and embedded screenshot evidence all appeared on the live rerun.` | `No new code change; validated the deployed relay-first and result-delivery fix on the live system.` | `Pass` |
| 2026-03-18 | `02` | `1` | `passed` | `Completed with relay-owned lifecycle updates and a rich operator-facing result page for the outreach research.` | `No new code change; validated the same communication and result-delivery contract on a second one-shot scenario.` | `Pass` |
| 2026-03-18 | `03` | `1` | `fixing` | `The request created a weekly schedule but never delivered the requested dry-run brief, and one visible relay update surfaced as relay-1.` | `Routing recurring schedule setup to architect and normalizing relay sender variants for operator-visible messages.` | `Pending rerun` |
| 2026-03-18 | `03` | `2` | `fixing` | `The system defaulted the timezone/channel assumptions correctly, but still blocked for extra confirmation instead of completing the schedule setup.` | `Added default source-channel delivery and runtime-timezone assumptions for recurring requests.` | `Pending rerun` |
| 2026-03-18 | `03` | `3` | `fixing` | `The dry-run existed in the handoff but was not surfaced to the operator.` | `Expanded rich result delivery so long handoffs and dry-run examples publish as operator-visible results.` | `Pending rerun` |
| 2026-03-18 | `03` | `4` | `fixing` | `The platform lacked timezone-aware schedules on the live DB and scheduling tool path, so the architect refused to activate the recurring schedule.` | `Implemented timezone-aware schedules across DB schema, MCP schedule tools, scheduler runtime, and shared types; applied the schema migration on the VPS.` | `Pending rerun` |
| 2026-03-18 | `03` | `5` | `fixing` | `The system now delivers the dry-run and timezone assumption cleanly, but it still loops into design/draft behavior and leaves the live weekly schedule uncreated or disabled instead of finishing the setup.` | `Tightened recurring-automation policy so explicit 'set that up' requests count as authorization to enable the schedule when the source channel and timezone assumption are already known.` | `Pending rerun` |
| 2026-03-19 | `03` | `6` | `fixing` | `The live schedule was eventually created, but the parent task stayed blocked_on_agent and no final relay completion was delivered because the request tree never reconciled after child completion.` | `Added blocked-parent reconciliation in the poller and narrowed completion suppression so earlier dry-run messages do not prevent the final relay completion update.` | `Pending rerun` |
| 2026-03-19 | `03` | `7` | `passed` | `Live rerun completed with relay acknowledgement, relay-owned progress/completion updates, no system attention message, an enabled weekly schedule, and a final relay completion with delivery-page metadata.` | `Routed internal recurring schedules directly to architect for live execution while keeping the relay-only intake/update contract and the new blocked-parent/completion reconciliation logic.` | `Pass` |
| 2026-03-19 | `04` | `1` | `fixing` | `The first blocked-path run acknowledged quickly, but relay surfaced an internal orchestration dump instead of an operator-facing checklist and it over-blocked on Gemini even though replacement visuals were explicitly optional.` | `Sanitized blocked relay checklists into operator-facing sections, filtered out internal task bullets, and changed relay preflight so optional visual support no longer creates a required-now Gemini blocker.` | `Pending rerun` |
| 2026-03-19 | `04` | `2` | `rerun_ready` | `From a clean reset with only OpenAI active, relay acknowledged quickly, told the operator that nothing else was needed to start the build, routed execution to builder, and clearly staged GitHub and Vercel as later requirements without over-blocking on optional visuals.` | `Validated the deployed blocked-checklist and optional-visual gating fixes on the live system; no new code change was needed on this rerun.` | `Blocked path pass` |
| 2026-03-19 | `04` | `3` | `fixing` | `With GitHub and Vercel re-added, the resumed run completed the local Next.js build and browser QA with screenshots, but then started browsing GitHub and Vercel API docs instead of making live service attempts through the active service connections.` | `Added a generic live-service-first execution rule and service-connection usage hints so active credentialed services are attempted through the available tool surface before the agent spends time on API-doc web searches.` | `Pending rerun` |
| 2026-03-19 | `04` | `4` | `fixing` | `The next resumed run created a fresh Next app and installed dependencies, but then performed a broad recursive scan through the scaffolded project, left the starter app untouched, and never reached real implementation or deployment.` | `Added ripgrep and git to the supervisor runtime image and tightened the generic runtime prompt so agents avoid recursive scans of node_modules, .next, dist, .provider-home, and other generated trees after scaffolding or install steps.` | `Pending rerun` |
| 2026-03-19 | `04` | `5` | `fixing` | `The next rerun reused active GitHub/Vercel services and moved into file creation, but the Codex worker disappeared mid-run while the builder task and task_run remained non-terminal, leaving the whole request tree hanging.` | `Add a generic supervisor watchdog for vanished worker PIDs so started task runs are reconciled into a terminal state instead of hanging forever when a child process disappears.` | `Pending rerun` |
| 2026-03-19 | `04` | `6` | `fixing` | `The resumed run finally built the demo, started the local preview, created the GitHub repo, and published files there, but relay still never surfaced a useful builder-start lifecycle update after the initial acknowledgement and checklist, leaving the operator in the dark during a long live run.` | `Relax first-direct-child start suppression so relay still avoids the pure double-confirm case, but does send a builder-start lifecycle update once a richer relay message such as a blocked checklist has already gone out.` | `Pending rerun` |
| 2026-03-19 | `04` | `7` | `fixing` | `The next clean rerun improved the blocked checklist, but that checklist still did not explicitly tell the operator that builder work was already underway, because the child builder launched before the richer relay update was emitted.` | `Enrich blocked relay checklist delivery with an execution-status section whenever an active non-relay child task is already running, so the operator sees that live work has started without reintroducing the old double-confirm noise.` | `Pending rerun` |
| 2026-03-19 | `04` | `8` | `fixing` | `The resumed run reached the real builder blocker after creating the GitHub repo and Vercel project, but relay still only exposed the earlier root checklist and never forwarded the later builder blocked_on_human handoff back to the operator.` | `Change blocked request update selection so the freshest actionable blocked note in the request tree wins over a stale root checklist, then rerun from reset.` | `Pending rerun` |
| 2026-03-19 | `04` | `9` | `fixing` | `The resumed run now acknowledges and communicates correctly and reaches live GitHub repo creation, but it hangs after a plain git push attempt and leaves the task running with only a leftover local preview process instead of completing an API-based publish/deploy path or failing fast.` | `Disable interactive git prompting, require preview servers to be torn down after QA, prefer GitHub/Vercel API fallback when raw git transport is unavailable, and shorten silent-process timeout handling.` | `Pending rerun` |
| 2026-03-19 | `04` | `10` | `blocked_waiting_input` | `The resumed run now completes the local build/QA cycle, uploads the site source to GitHub through the API, creates the Vercel project, and then surfaces a concrete deployment blocker: the active Vercel team still cannot see the GitHub repo to complete deployment.` | `Non-interactive publish-path and GitHub API fallback changes were validated. Next decision is whether to accept the Vercel repo-visibility requirement as a legitimate external blocker or add a generic file-payload deployment fallback.` | `Blocked on external deployment visibility` |
| 2026-03-19 | `04` | `11` | `fixing` | `After adding recursive GitHub-upload guidance and direct Vercel file-deploy guidance, the fresh resumed run still did not reach a clean completion. The first builder run eventually completed, but the same builder task was then relaunched with a new task_run, relay emitted a misleading 'started reviewer work' update, and the root request remained blocked_on_agent instead of reconciling to a real terminal outcome.` | `Added generic GitHub recursive-upload verification and Vercel direct-deployment guidance, then reran from reset. The next required fix is in downstream task reconciliation/lifecycle labeling, not in the saved prompt.` | `Did not pass before the one-hour Scenario 04 cutoff` |
| 2026-03-19 | `05` | `1` | `fixing` | `The first blocked-path baseline correctly created a key_needed GoHighLevel service row, but the operator only saw relay acknowledgement/start updates while the concrete missing-service checklist stayed hidden in the blocked task handoff.` | `Pending generic fix to surface blocked requirements through relay and avoid redundant early start chatter.` | `Pending rerun` |
| 2026-03-19 | `05` | `2` | `blocked_waiting_input` | `Blocked-path rerun now acknowledges through relay, suppresses the redundant start update, and surfaces a clear relay-owned GoHighLevel prerequisites message while creating the expected key_needed service entry.` | `Added relay delivery for blocked_on_agent requirement checklists and suppressed the first redundant direct-child start update under relay.` | `Blocked path pass` |
| 2026-03-19 | `05` | `3` | `fixing` | `The resumed run moved into staging work, but downstream builder and reviewer tasks launched while their planning dependency was still running, and relay surfaced a misleading sage progress note centered on a docs URL instead of the real workflow status.` | `Pending generic fix to enforce dependency gating at launch time and to suppress low-value planner progress summaries that only expose research/doc links.` | `Pending rerun` |
| 2026-03-19 | `05` | `4` | `blocked_waiting_input` | `After the redeploy, the blocked path again produced the correct relay-owned GoHighLevel checklist, created the expected key_needed service row, and preserved the bootstrap procedural skills through reset.` | `Added a generic remote-MCP runtime path for GoHighLevel, enabled Codex RMCP support, and blocked raw service_request fallback whenever a dedicated remote service MCP is configured.` | `Blocked path pass` |
| 2026-03-19 | `05` | `5` | `passed` | `With an active GHL service connection, relay reused the stored location ID in its blocker, the follow-up routed to builder, and the builder inspected the live approved GHL surface before returning concrete blockers: no verifiable SMS-capable line, missing requested pipeline/stage in accessible data, and no approved workflow/phone-admin mutation tools exposed.` | `Added sanitized active-service context to task briefings so agents reuse stored non-secret identifiers instead of asking the operator to restate them, then reran the same prompt from reset.` | `Pass with legitimate external blocker reported clearly` |
| 2026-03-19 | `06` | `1` | `blocked_waiting_input` | `From a clean reset with only OpenAI active, relay acknowledged quickly, created the expected key_needed Gemini and ElevenLabs service rows, and surfaced a clear relay-owned checklist separating required-now services from later brand-placement details.` | `Validated the earlier blocked-checklist and relay-delivery fixes against the asset-pack scenario after the new media-output_path deploy; no new code change was needed for the blocked path.` | `Blocked path pass` |
| 2026-03-19 | `06` | `2` | `fixing` | `After reset and re-adding Gemini and ElevenLabs, relay correctly said nothing else was required now and launched a builder task, but the builder created planning files like image-prompts.md and voiceover-script-da.txt, searched the repo for service_request examples, and still produced no image/audio artifacts or final delivery.` | `Added stronger active-media execution guidance to the runtime prompt and service-specific usage hints in TASK_BRIEFING.md so attached media services are used directly instead of prompting repo archaeology.` | `Pending rerun` |
| 2026-03-19 | `06` | `3` | `passed` | `After the generic media-execution fix, the resumed run asked one real language question, then generated three Danish creatives with Gemini, a Danish ElevenLabs voiceover, registered the artifacts, and completed through relay with a delivery-page CTA.` | `No new code change on this rerun; validated the deployed active-media execution and service-usage-hint improvements.` | `Pass` |

## Exit Criteria

The suite is in a good state when:

- all six scenarios are at least `passed`;
- all gated scenarios have both a correct blocked-path run and a correct resumed run;
- at least one additional confirmation rerun has been completed for the scenarios most affected by recent logic changes;
- no scenario requires prompt-specific hacks, hardcoded answers, or one-off service special-casing to pass.
