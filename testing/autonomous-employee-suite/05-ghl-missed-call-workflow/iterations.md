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
- Commit: `uncommitted`
- Reset state: `Fresh reset via testing/website-demo-skill/reset_live_system.py. Only openai remained in service_registry. No GoHighLevel service or placeholder row existed at prompt start.`
- Observed behavior: `Relay acknowledged the request quickly and the system created a key_needed gohighlevel service entry. Relay also surfaced an early start update for downstream sage work. The root request then moved to blocked_on_agent with a concrete checklist in the task handoff covering the missing GoHighLevel connection and the remaining policy details, while the child sage task stayed running during the polling window.`
- First wrong action: `The concrete blocked checklist never reached the operator through relay, so the operator only saw acknowledgement/start chatter instead of the actionable missing-service requirements needed to continue.`
- Root cause: `Operator updates are currently synthesized from completed tasks and completions only. A task that becomes blocked_on_agent with a requirements checklist does not trigger a relay-visible blocked update, so the useful handoff stays internal in task metadata.`
- Fix: `Pending. Add a generic relay blocked-update path for blocked_on_agent tasks with actionable requirement checklists, and reduce redundant early start chatter so the first actionable update is more useful.`
- VPS redeploy: `Pending`
- Result after rerun: `Pending`

## Iteration 2

- Iteration: `2`
- Commit: `uncommitted`
- Reset state: `Fresh reset via testing/website-demo-skill/reset_live_system.py. Only openai remained in service_registry before the rerun. The scenario was rerun from the same saved prompt with no GoHighLevel service present.`
- Observed behavior: `Relay acknowledged the request quickly, did not emit the redundant early started message, and then surfaced a relay-owned blocked message that clearly asked for the GoHighLevel Service Connection plus the minimum remaining policy details. The run also created the expected gohighlevel key_needed row in service_registry.`
- First wrong action: `None on the blocked path.`
- Root cause: `The earlier failure came from blocked requirement checklists never becoming operator-visible and from the first direct child launch producing redundant chatter immediately after the acknowledgement.`
- Fix: `Added a generic relay blocked-update path for blocked_on_agent requirement checklists and suppressed the first redundant direct-child start update under relay so the first actionable follow-up is the blocker itself.`
- VPS redeploy: `Yes. Supervisor redeployed to the VPS after the local build and focused test pass.`
- Result after rerun: `Blocked-path pass. The next step is the resumed run after re-adding GoHighLevel and providing the requested pipeline/tag details.`

## Iteration 3

- Iteration: `3`
- Commit: `uncommitted`
- Reset state: `Fresh reset via testing/website-demo-skill/reset_live_system.py, then GoHighLevel was re-added from SERVICE_KEYS.local.md before the prompt. The saved prompt was rerun, and the operator then supplied the minimum requested policy details: stage Missed Calls - New, tag missed-call-textback, after-hours or missed-call only, Europe/Copenhagen timezone, and the live location ID.`
- Observed behavior: `The resumed run did move into deeper execution. Sage planned the workflow, created builder and reviewer follow-up tasks, and the new service_request path was used for live HighLevel API probes. However, downstream builder and reviewer work launched before the planning dependency had actually completed, creating overlapping execution trees. Relay also surfaced a misleading sage progress message whose main visible payload was a docs URL rather than the real workflow status.`
- First wrong action: `Dependency-gated downstream work started while its depends_on planning task was still running.`
- Root cause: `Staged execution is only being guarded in part of the queue path, so a task with dependencies can still reach live launch under some task-state combinations or race windows. Separately, relay progress summarization is treating arbitrary URLs inside planner notes as user-meaningful status, which turns research notes into noisy operator updates.`
- Fix: `Pending. Enforce dependency validation immediately before process launch for any queued task state, and tighten relay progress/completion summarization so documentation/research URLs are not surfaced as faux live-result updates.`
- VPS redeploy: `Pending`
- Result after rerun: `Stopped at the first material resumed-path failure. The next run should start from reset after the dependency-gating and relay-summary fixes are deployed.`

## Iteration 4

- Iteration: `4`
- Commit: `uncommitted`
- Reset state: `Fresh reset via testing/website-demo-skill/reset_live_system.py. Only openai remained in service_registry, and the bootstrap procedural skills still existed after reset (4 active skill memories). No GoHighLevel credential or placeholder row existed at prompt start.`
- Observed behavior: `Relay acknowledged the request quickly, the root relay task moved to blocked_on_human, the run created the expected gohighlevel key_needed row, and the operator received a relay-owned blocked checklist covering the missing Service Connection plus the minimum remaining pipeline and business-rule details.`
- First wrong action: `None on the blocked path.`
- Root cause: `The prior resumed-path failure came from the execution path drifting back to raw HighLevel REST probing and web research even when a dedicated remote MCP path was configured.`
- Fix: `Added a generic remote-MCP runtime path for GoHighLevel, enabled Codex RMCP support in OpenAI task runtimes, strengthened the task prompt so service-specific MCP servers are treated as a hard execution rule, and blocked service_request fallback whenever a dedicated remote service MCP is already configured.`
- VPS redeploy: `Yes. Supervisor redeployed to the VPS after the local build and focused test pass.`
- Result after rerun: `Blocked-path pass. The next step is the resumed run after reset, GoHighLevel re-activation, and operator replies with only the minimum requested workflow details.`

## Iteration 5

- Iteration: `5`
- Commit: `uncommitted`
- Reset state: `Fresh reset via testing/website-demo-skill/reset_live_system.py, then GoHighLevel was re-added from SERVICE_KEYS.local.md before the prompt. Only openai and the live GoHighLevel service entry were present at prompt start, and the bootstrap procedural skills still existed after reset.`
- Observed behavior: `Relay acknowledged the request quickly, routed the active-service path into planning, and surfaced a relay-owned blocker that reused the stored location ID from the active GoHighLevel service connection instead of asking the operator to restate it. After the operator supplied only the remaining workflow details, the follow-up routed to builder, the builder reused the stored location ID, inspected the live location and accessible pipelines/conversations through the approved GoHighLevel MCP surface, and then returned a relay-owned completion with concrete blockers: no verifiable SMS-capable line, requested pipeline/stage missing from accessible data, and no approved mutation/tool surface for workflow, pipeline/stage/tag, or phone-number admin work.`
- First wrong action: `None on the resumed path after the generic service-context fix.`
- Root cause: `The prior resumed-path failure came from active service connections exposing only readiness, not the non-secret scoped identifiers already stored in those connections. That caused the planner to ask the operator for the location/account ID again even though the service connection already contained it.`
- Fix: `Added sanitized active-service context to task briefings so agents can reuse stored non-secret service identifiers such as location IDs, workspace IDs, and service URLs without exposing secrets, and tightened the runtime instructions so operators are not asked to repeat identifiers already present in active service connections.`
- VPS redeploy: `Yes. Supervisor redeployed to the VPS after the local build and focused tests passed.`
- Result after rerun: `Resumed-path pass. The system now gets all the way to approved live-account inspection and reports legitimate external/tooling blockers clearly instead of re-requesting stored identifiers or hiding behind planning chatter.`
