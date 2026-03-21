# Incident Log: Telegram Relay Loop

Date: 2026-03-20
Status: Contained, code fix in progress
Primary impact: repeated Telegram and admin-chat outbound messages for Hans's hourly cat-joke workflow

## Summary

The live VPS entered a request-replay loop in the relay workflow. Two relay root tasks kept reopening after their builder children completed:

- `c672e020-791e-4176-8d31-64f47d70c1aa`
- `eec5b1fd-b579-4057-94fc-8710e4e001e4`

Each resumed relay run created another near-duplicate builder child, which produced another outbound progress/update message. This repeated across Telegram and the mirrored admin-chat feed.

## Operator-visible symptoms

- Hans kept receiving repeated progress updates such as "I've started builder work on this request..."
- The admin chat mirrored the same repeated lifecycle traffic.
- A direct operator stop message was accepted as a new relay task, but it did not suppress the already-looping roots.

## Live evidence

### Repeating root tasks

- `c672e020-791e-4176-8d31-64f47d70c1aa`
  - Title: `Process message: Please update the schedule/ logic so that the syst...`
  - State during incident: `blocked_on_agent`
  - Requirement state: `downstream_task = passed`
  - Child pattern: many completed builder children with similar titles such as `Enforce Hans joke rating gate before next send`

- `eec5b1fd-b579-4057-94fc-8710e4e001e4`
  - Title: `Process message: 2...`
  - State during incident: `blocked_on_agent`
  - Requirement state: `downstream_task = passed`
  - Child pattern: many completed builder children with similar titles such as `Absorb Hans's latest 2 rating into the hourly cat-joke workflow`

### Why the stop request did not stop it

Hans sent:

- `You are sending messages in a loop please stop this...`
- `No something is wrong with the AgentOS system. There is an infinite loop going on. Please stop it`

Those messages created new relay work:

- `4b07b017-598c-4d94-a74c-4e12a1889e8e`
- `8705ea6d-72ff-412c-8ad2-9f8e38aa5775`

But there was no runtime circuit breaker that paused the already-looping relay roots. The system treated the stop request as another normal request instead of a suppression action on the active request lineage.

## Root cause

The loop was not caused by Telegram echoing its own outbound messages back into inbound routing.

The actual failure was this:

1. A relay root task created a downstream builder child.
2. The parent `downstream_task` requirement was satisfied on child creation.
3. The relay task remained in `blocked_on_agent`.
4. After the child reached a terminal state, supervisor reconciliation moved the parent back to `ready`.
5. The relay ran again and created another near-duplicate child instead of closing the request.
6. Each new child generated more outbound lifecycle and completion traffic.

This created an infinite replay loop for the same root request.

## Contributing factor

The stop request path was weak:

- it created follow-up work,
- but it did not pause the active looping roots,
- and it did not suspend the already-enabled live workflow immediately.

## Immediate containment

To stop the messages without deleting any tasks, messages, or other evidence:

- the `supervisor` container on the VPS was stopped;
- all database rows were preserved for analysis and remediation.

Containment timestamp:

- 2026-03-20 22:14 UTC

## Re-evaluation

After reviewing the live task graph and task requirements, the issue is best described as a relay re-entry bug with missing loop suppression.

The most important facts are:

- the parent `downstream_task` requirement was already `passed`;
- the relay kept reopening anyway;
- the repeated child titles were near-duplicates, not distinct work phases;
- the system had no automatic guard to quarantine a repeating relay root;
- the operator's stop message had no direct control-plane effect on the active loop.

## Code fix plan

1. Change blocked-task reconciliation so relay roots do not reopen after successful terminal child completion when the required downstream work has already passed and no other required blockers remain.
2. Auto-close those relay roots directly in supervisor instead of re-running the relay role.
3. Preserve the existing tasks, messages, and child outcomes so the full history remains auditable.

## Self-healing plan

1. Detect repeated near-duplicate child-task clusters under a relay root.
2. If the cluster crosses a threshold, quarantine the root automatically instead of reopening it again.
3. Record a structured event for the suppression so it is visible in operations review.
4. Keep the root and children intact in the database so the incident can still be inspected and resumed manually after a real fix.

## Live deployment plan

1. Apply the supervisor code fix.
2. Rebuild and redeploy the supervisor on the VPS.
3. Park the known looping tasks so the restarted supervisor does not immediately resume stale duplicate work.
4. Verify that:
   - no new relay re-entry loop occurs,
   - no repeated Telegram progress spam resumes,
   - the hourly schedule remains preserved but muted until its queued work is safe again.
