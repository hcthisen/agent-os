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
- Observed behavior: `Relay acknowledged quickly, Gemini and ElevenLabs were both created as key_needed service rows from a clean baseline, and relay surfaced a clear blocked checklist that separated required-now services from later brand-placement details.`
- First wrong action: `None on the blocked path. The operator-facing behavior matched the intended gated baseline.`
- Root cause: `n/a`
- Fix: `No new code change for this blocked-path rerun. This run validated the earlier relay-owned blocked-checklist delivery logic after the media-output_path deploy.`
- VPS redeploy: `Yes. Supervisor and MCP changes were redeployed immediately before the rerun, including direct workspace saving for binary service_request outputs.`
- Result after rerun: `Blocked-path pass. Scenario moved to resumed-run setup with Gemini and ElevenLabs to be re-added after the next reset.`

## Iteration 2

- Iteration: `2`
- Commit: `working tree live-deploy on 2026-03-19`
- Reset state: `Live reset completed again; only the openai service remained. Gemini and ElevenLabs were then re-added as active service connections before replaying the same prompt.`
- Observed behavior: `Relay acknowledged quickly, reused the active-service state correctly, and told the operator that nothing else was required immediately. The builder task then launched, but it created planning files such as image-prompts.md, campaign-brief.md, ad-copy-variants.md, and voiceover-script-da.txt, while searching the repo for service_request examples instead of making the first live generation call.`
- First wrong action: `The builder drifted into repo archaeology and planning-only files despite active media services and an explicit live asset-generation task.`
- Root cause: `The generic prompt contract still allowed the model to spend its early phase researching internal examples and drafting support files instead of attempting the real service calls immediately. TASK_BRIEFING.md also lacked direct service-usage hints, so the builder defaulted to codebase search instead of using the attached services.`
- Fix: `Added stronger active-media execution guidance to the runtime prompt and attached per-service usage hints in sanitized service connection hints so the builder sees a direct route to Gemini and ElevenLabs generation without reverse-engineering the repo.`
- VPS redeploy: `Pending`
- Result after rerun: `Pending rerun`

## Iteration 3

- Iteration: `3`
- Commit: `working tree live-deploy on 2026-03-19`
- Reset state: `Live reset completed again; only the openai service remained. Gemini and ElevenLabs were re-added as active service connections before replaying the same prompt.`
- Observed behavior: `Relay acknowledged quickly, blocked only for one real language choice, and then routed the resumed request into live media generation. The builder used Gemini to generate three image backgrounds, composed three finished Danish SVG creatives with exact copy, used ElevenLabs to produce a Danish voiceover MP3, registered the artifacts, wrote a durable memory, and completed with a relay-owned delivery message plus a delivery-page CTA.`
- First wrong action: `None on this rerun. The resumed path completed end-to-end with the requested assets and a usable operator-facing result.`
- Root cause: `n/a`
- Fix: `No new code change for this rerun. This run validated the generic active-media execution guidance and the service-specific usage hints added after Iteration 2.`
- VPS redeploy: `Yes. The supervisor changes from the generic media-execution fix were already deployed before the rerun.`
- Result after rerun: `Pass. Scenario now has both a correct blocked path and a correct resumed path, and is ready for a later confirmation rerun after any further shared logic changes.`
