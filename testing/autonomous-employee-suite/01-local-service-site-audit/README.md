# Local Service Site Audit

This scenario tests whether the system can take a realistic owner request, use the browser, compare competitors, create an evidence-backed artifact, and deliver a useful action plan without turning the work into a planning-only exercise.

## Goal

- execute a website and competitor teardown end-to-end from one prompt;
- return a prioritized operator-facing action plan grounded in visible evidence;
- keep the work focused on review and recommendations instead of silently drifting into implementation.

## Prompt Type

- one-shot

## Before Running

- replace `{{SERVICE_BUSINESS_TYPE}}`, `{{CITY}}`, and `{{BUSINESS_URL}}` with a real local-service business and a live public site;
- keep the prompt natural after replacement and do not add hidden hints about what the system should conclude.

## Expected Behavior

- relay should acknowledge the request quickly after routing so the operator is not left in a long silent run;
- normal progress and completion messages should come from `relay`, not `system`;
- relay should route this as execution work rather than a requirements walkthrough;
- the system should browse the live site, inspect local competitors, and create a report or artifact that the operator can use immediately;
- the final operator-facing response should summarize the most important findings and clearly surface a rich HTML result page;
- when screenshots or other visual evidence are captured, the delivered report should embed them rather than leaving them hidden in the workspace;
- follow-up questions should only appear if the site is unreachable or the prompt no longer contains enough information to execute.

## Loop

1. Reset the live runtime with `python testing/website-demo-skill/reset_live_system.py`.
   Start from a clean service state where only `openai` may remain in `service_registry`.
2. Submit the saved prompt from `prompt.md`.
3. Monitor the full run across `messages`, `tasks`, `events`, `handoffs`, `memories`, `artifacts`, and workspace output.
4. Stop the run as soon as something materially wrong is observed.
5. Patch the repo for the general logic or process issue and do not rewrite the prompt to hand the system the missing answer.
6. Build locally, redeploy the affected services, reset again, and rerun the same prompt.
7. Record the result in `iterations.md`.

## Generic Fix Rule

- inspect the whole run, not only the final reply;
- do not special-case this exact business, site, competitor set, or wording;
- do not add the expected findings directly into the prompt;
- make the fix general enough that the same logic would work for a different local-service site audit.

## Monitoring Focus

- relay acknowledgement timing and lifecycle communication during the run;
- sender correctness, where `relay` owns normal updates and `system` is reserved for errors or service prompts;
- quality and visibility of the final rich result page;
- operator-visible delivery after meaningful review work finishes;
- browser usage, evidence capture, and artifact creation;
- task routing and child-task creation staying aligned with an audit request;
- memory and handoff quality staying concise and relevant to the actual site-review work.
