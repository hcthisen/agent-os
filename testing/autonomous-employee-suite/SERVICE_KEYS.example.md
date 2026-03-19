# Service Keys Template

Use this file as the template for `SERVICE_KEYS.local.md`.

Do not put real secrets in this checked-in file. Put real values only in the local ignored file:

```text
testing/autonomous-employee-suite/SERVICE_KEYS.local.md
```

## How The Tester Should Use These Keys

1. Fill `SERVICE_KEYS.local.md` with the real values before running gated scenarios.
2. Do not paste secrets into the saved prompts.
3. Do not commit secrets into the repo, notes, or iteration logs.
4. For gated scenarios, the default test flow is:
   - run the prompt once with the needed external service not yet active in the service registry;
   - confirm the system asks for the minimum missing service or input;
   - reset if needed, then activate the requested service in the admin app service registry using the value from `SERVICE_KEYS.local.md`;
   - rerun the same prompt from a reset state and confirm the system continues end-to-end.
5. The reset script removes all non-OpenAI `service_registry` rows, including active third-party credentials and `key_needed` placeholders. Re-add the needed service after each reset.

## Scenario To Service Map

| Scenario | Extra keys needed | When the tester should use them |
|----------|-------------------|---------------------------------|
| `01-local-service-site-audit` | none beyond provider auth | No extra service activation expected. |
| `02-local-prospect-research` | none beyond provider auth | No extra service activation expected. |
| `03-weekly-exec-brief-schedule` | none beyond provider auth | No extra service activation expected unless you intentionally expand the scenario. |
| `04-prospect-demo-build` | GitHub, Vercel, optional image service such as Gemini | Let the first run block correctly, then activate the requested service entries and rerun. |
| `05-ghl-missed-call-workflow` | GoHighLevel | Let the first run block correctly, then activate GoHighLevel and rerun. |
| `06-offer-campaign-asset-pack` | image service such as Gemini, voice service such as ElevenLabs | Let the first run block correctly, then activate the requested services and rerun. |

## Recommended Service Notes

### GitHub

- Used by: `04-prospect-demo-build`
- Tester action: add GitHub only after the system has correctly identified that repo access is required.
- Store only:
  - token

### Vercel

- Used by: `04-prospect-demo-build`
- Tester action: add Vercel only after the system has correctly identified that deployment access is required.
- Store only:
  - token

### Gemini / Nano Banana

- Used by: `04-prospect-demo-build`, `06-offer-campaign-asset-pack`
- Tester action: keep this inactive for the first run unless you are explicitly testing the already-configured path.
- Store only:
  - api key
- Expectation:
  - the system should discover the current Gemini model and usage pattern itself rather than relying on a stored model note in this file

### GoHighLevel

- Used by: `05-ghl-missed-call-workflow`
- Tester action: after the first run blocks correctly, activate GoHighLevel and provide any essential account scoping details the system asked for.
- Store only:
  - api key
  - location id

### ElevenLabs

- Used by: `06-offer-campaign-asset-pack`
- Tester action: activate only after the system has correctly asked for voice-generation access or a missing voice requirement.
- Store only:
  - api key
- Expectation:
  - if a specific voice is required, the system should determine that during the task or ask the operator, not depend on a default voice field here

## Local File Skeleton

Copy this structure into `SERVICE_KEYS.local.md` and fill the real values there:

```md
# Local Service Keys

## GitHub
- token:

## Vercel
- token:

## Gemini / Nano Banana
- api key:

## GoHighLevel
- api key:
- location id:

## ElevenLabs
- api key:
```
