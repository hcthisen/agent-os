# Website Demo Skill Iteration Loop

This folder holds the reusable prompt, reset tooling, and iteration notes for the website-demo-skill workflow.

## Goal

The system should treat this prompt as a requirements and feasibility walkthrough first.

Expected behavior:

- relay classifies the request and routes planning to `sage`
- the operator receives a concrete checklist of what is needed now, later, and optionally helpful
- the repository reference is reviewed and included in the operator-facing answer
- the system does not silently move into builder/reviewer implementation in the same request tree
- a reference GitHub URL does not become a durable project by itself

## Loop

1. Reset the live VPS runtime while preserving provider auth and only the `openai` service entry.
2. Submit the saved prompt from `prompt.md`.
3. Monitor `messages`, `tasks`, `events`, `handoffs`, and memory writes.
4. Stop the run as soon as the system does something materially wrong.
5. Patch the repo for the general logic failure, not the single prompt wording.
6. Build locally.
7. Redeploy the affected services to the VPS.
8. Reset again and rerun the same prompt.
9. Record the result in `iterations.md`.

## Reset

Run:

```powershell
python testing/website-demo-skill/reset_live_system.py
```

The reset script clears runtime history, projects, memories, skills, schedules, workspaces, and all non-OpenAI service connections while preserving:

- provider auth volumes
- the `openai` service registry entry only
- stack configuration and env values

Any other `service_registry` row, including active third-party credentials and `key_needed` placeholder rows created during a blocked test, is removed on reset.

## Monitoring Focus

- operator-visible outbound messages are delivered when relay or sage finishes meaningful planning work
- child-task creation respects operator intent
- memory and skill writes stay concise and relevant
- prompt propagation stays coherent across relay, sage, and downstream tasks
