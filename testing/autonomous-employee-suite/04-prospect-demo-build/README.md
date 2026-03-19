# Prospect Demo Build

This scenario tests whether the system can treat a normal owner request as a real build-and-deploy workflow, inspect the target business, identify the minimum missing dependencies, and then continue once those dependencies are available.

## Goal

- inspect a prospect site and prepare a materially better two-page demo in the normal website stack;
- ask for the minimum missing access needed now instead of flooding the operator with a giant requirements list;
- continue into real implementation, GitHub push, and deployment once the services are active.

## Prompt Type

- gated

## Before Running

- replace `{{PROSPECT_NAME}}` and `{{PROSPECT_URL}}` with a real business and live public site;
- keep the prompt natural and do not add hidden instructions that tell the system which tokens or services to ask for;
- prepare any real GitHub, Vercel, and optional image-service values in `../SERVICE_KEYS.local.md` and use `../SERVICE_KEYS.example.md` as the reference template;
- keep `../SERVICE_KEYS.local.md` minimal: token-only for GitHub and Vercel, and API-key-only for Gemini if image generation is used;
- if you want the second run to execute end-to-end, be ready to provide the needed GitHub, deployment, and image-generation access after the first run blocks correctly.

## Expected Behavior

- relay should acknowledge the request quickly after routing and keep the operator informed as the blocked path or build path progresses;
- normal progress and completion messages should come from `relay`, while `system` should be reserved for Service Connections or hard errors;
- the system should inspect the live prospect site and identify what it can do immediately versus what requires external access;
- the first run should ask for the minimum missing access or operator input that is genuinely required now;
- once the services are active, the rerun should move into build, review, repository creation, and deployment rather than repeating a planning-only response.

## Loop

1. Reset the live runtime with `python testing/website-demo-skill/reset_live_system.py`.
   Start from a clean service state where only `openai` may remain in `service_registry`.
2. Submit the saved prompt from `prompt.md`.
3. Monitor `messages`, `tasks`, `events`, `handoffs`, `memories`, `artifacts`, workspace output, and `service_registry`.
4. Stop the run as soon as something materially wrong is observed.
5. Fix the general routing, requirements, service-gating, implementation, or delivery logic. Do not rewrite the prompt so it pre-answers what credentials are needed or how the demo should look.
6. Build, redeploy, reset, and rerun the same prompt.
7. After a correct first-run block, and after any reset you perform, use the values from `../SERVICE_KEYS.local.md` to activate only the requested services in the admin app service registry, then rerun again and record the end-to-end result in `iterations.md`.

## Generic Fix Rule

- do not special-case this exact prospect, stack wording, or URL pattern;
- do not hardcode GitHub, Vercel, or image-service behavior to satisfy one prompt;
- make the fix general enough that any similar demo-build request would ask for the right missing access and then continue correctly.

## Monitoring Focus

- relay acknowledgement timing and lifecycle communication during the run;
- sender correctness, where `relay` owns normal updates and `system` is reserved for errors or service prompts;
- inspection of the live prospect site before implementation decisions are made;
- precise service-gating behavior and operator-visible requests for missing access;
- progression from planning into actual build and deployment once prerequisites are satisfied;
- artifact, repo, and deployment outputs being surfaced clearly back to the operator.
