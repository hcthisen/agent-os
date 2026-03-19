# Offer Campaign Asset Pack

This scenario tests whether the system can take a realistic marketing request, identify the minimum missing brand and service prerequisites, and then create a useful multi-asset package once those prerequisites are available.

## Goal

- prepare a small campaign asset pack with image concepts, short copy, and a voiceover variant;
- request only the missing brand, offer, and service inputs that are genuinely needed for safe and useful output;
- continue into live asset generation after those prerequisites are provided.

## Prompt Type

- gated

## Before Running

- replace `{{BUSINESS_NAME}}`, `{{OFFER_NAME}}`, `{{OFFER_DETAILS}}`, and `{{BRAND_TONE}}` with real campaign context;
- keep the prompt natural and do not preload the final copy, image concepts, or voice direction into it;
- prepare the image-service and voice-service values in `../SERVICE_KEYS.local.md` and use `../SERVICE_KEYS.example.md` as the reference template;
- keep `../SERVICE_KEYS.local.md` minimal for this scenario: Gemini API key only for image generation and ElevenLabs API key only for voice generation;
- if you want the second run to generate the full asset pack, be ready to provide the image and voice services after the first run blocks correctly.

## Expected Behavior

- relay should acknowledge the request quickly after routing and keep the operator informed as the task moves through blocked, generation, and delivery stages;
- normal progress and completion messages should come from `relay`, while `system` should be reserved for Service Connections or hard errors;
- the system should recognize that this is a real creation request rather than a brainstorming exercise;
- the first run should identify the minimum missing brand, compliance, and external-service inputs required now;
- once the services and missing inputs are available, the rerun should generate the assets and return them in an operator-usable way.

## Loop

1. Reset the live runtime with `python testing/website-demo-skill/reset_live_system.py`.
   Start from a clean service state where only `openai` may remain in `service_registry`.
2. Submit the saved prompt from `prompt.md`.
3. Monitor `messages`, `tasks`, `events`, `handoffs`, `memories`, `artifacts`, workspace output, and `service_registry`.
4. Stop the run as soon as something materially wrong is observed.
5. Fix the general creation, service-gating, approval, or delivery logic. Do not smuggle the correct creative answer into the saved prompt.
6. Build, redeploy, reset, and rerun the same prompt.
7. After a correct first-run block, and after any reset you perform, use the values from `../SERVICE_KEYS.local.md` to activate the requested services in the admin app service registry, provide any missing context the system requested, rerun, and record the result in `iterations.md`.

## Generic Fix Rule

- do not special-case one offer, one tone, one brand, or one provider integration;
- do not hardcode a fixed creative template just to satisfy this saved prompt;
- make the fix broad enough that other asset-generation requests can request missing inputs, resume correctly, and return useful outputs.

## Monitoring Focus

- relay acknowledgement timing and lifecycle communication during the run;
- sender correctness, where `relay` owns normal updates and `system` is reserved for errors or service prompts;
- service activation behavior for image and voice tooling;
- clarity of the request for missing offer, brand, and compliance inputs;
- artifact creation, packaging, and operator-visible delivery of the finished assets;
- prompt propagation and task continuity once the first blocked run is resumed.
