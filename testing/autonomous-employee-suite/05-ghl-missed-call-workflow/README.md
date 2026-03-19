# GoHighLevel Missed-Call Workflow

This scenario tests whether the system can handle a real CRM automation request, recognize when external system access and business rules are missing, and then move into actual setup once those prerequisites are satisfied.

## Goal

- set up a missed-call text-back workflow for a service business in GoHighLevel;
- request the minimum missing CRM access and business-rule details needed for a safe live setup;
- continue into real workflow creation after the operator provides what is required.

## Prompt Type

- gated

## Before Running

- replace `{{SERVICE_BUSINESS_TYPE}}` with the business category you want to test;
- keep the prompt natural and do not insert the correct tags, pipeline stages, or trigger logic into the saved prompt;
- prepare the real GoHighLevel values in `../SERVICE_KEYS.local.md` and use `../SERVICE_KEYS.example.md` as the reference template;
- keep `../SERVICE_KEYS.local.md` minimal for this scenario: API key and location ID only;
- if you want the second run to continue into execution, be ready to provide the GoHighLevel account access and any essential business rules after the first run.

## Expected Behavior

- relay should acknowledge the request quickly after routing and keep the operator informed as the workflow moves between blocked and active execution states;
- normal progress and completion messages should come from `relay`, while `system` should be reserved for Service Connections or hard errors;
- the system should treat this as a real setup request, not just a brainstorming task;
- the first run should ask for the minimum missing account access and operating rules that are genuinely required for a live workflow;
- once the service is active and missing rules are supplied, the rerun should perform the setup work and report what was created.

## Loop

1. Reset the live runtime with `python testing/website-demo-skill/reset_live_system.py`.
   Start from a clean service state where only `openai` may remain in `service_registry`.
2. Submit the saved prompt from `prompt.md`.
3. Monitor `messages`, `tasks`, `events`, `handoffs`, `memories`, `service_registry`, and any artifacts or notes the system creates.
4. Stop the run as soon as something materially wrong is observed.
5. Fix the general service-gating, requirements, or execution logic and do not make the prompt carry the hidden implementation answer.
6. Build, redeploy, reset, and rerun the same prompt.
7. After a correct first-run block, and after any reset you perform, use the values from `../SERVICE_KEYS.local.md` to activate GoHighLevel in the admin app service registry, provide any missing policy details the system requested, rerun, and record the result in `iterations.md`.

## Generic Fix Rule

- do not special-case GoHighLevel, this exact workflow name, or this business type in a way that only helps one saved scenario;
- do not paste the correct pipeline design or message copy into the prompt to force success;
- make the fix broad enough that the same logic works for other CRM automations that require access checks and missing-rule clarification.

## Monitoring Focus

- relay acknowledgement timing and lifecycle communication during the run;
- sender correctness, where `relay` owns normal updates and `system` is reserved for errors or service prompts;
- service activation and `service_registry` behavior;
- clarity and minimalism of the operator-facing request for missing information;
- movement from blocked state into real workflow execution after prerequisites are provided;
- final confirmation of what was configured and how the operator can verify it.
