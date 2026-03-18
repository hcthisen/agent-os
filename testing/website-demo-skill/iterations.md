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

## 2026-03-18

- Iteration: 1
- Commit: local working tree
- Reset state: full runtime wipe with auth preserved
- Observed behavior: relay created a bogus persistent project from `next.js` and sent a useless internal classification summary
- First wrong action: auto-created project `next-js`
- Root cause: hostname extraction treated stack keywords/reference hosts as initiative hosts; interim progress surfaced relay orchestration instead of substantive planning
- Fix: filtered initiative hostnames more conservatively and suppressed relay-root progress when downstream planning exists
- VPS redeploy: yes
- Result after rerun: project bug removed, but operator still received no checklist

- Iteration: 2
- Commit: local working tree
- Reset state: full runtime wipe with auth preserved
- Observed behavior: no bogus project, but relay objective on the live intake path did not include requirements-walkthrough instructions
- First wrong action: relay/sage kept running without an operator-visible checklist
- Root cause: `apps/admin/server.mjs` had not been kept in sync with the supervisor relay routing logic
- Fix: mirrored requirements-walkthrough detection and checklist-oriented relay instructions into the admin intake path
- VPS redeploy: yes
- Result after rerun: relay generated the right checklist internally, but delivery still preferred a generic handoff note

- Iteration: 3
- Commit: local working tree
- Reset state: full runtime wipe with auth preserved
- Observed behavior: relay final message contained the correct checklist, but the operator saw only a short summary
- First wrong action: outcome delivery used the generic handoff note instead of the richer `final_message`
- Root cause: process manager stored/kept a weaker handoff note and the outcome formatter collapsed checklist replies to a first sentence
- Fix: prefer richer `final_message` text for task notes, preserve checklist-shaped replies in full, and avoid duplicate system notifications when an agent already replied
- VPS redeploy: yes
- Result after rerun: operator received one concrete checklist reply, no project was auto-created, and no builder/reviewer task was spawned during the requirements walkthrough window
