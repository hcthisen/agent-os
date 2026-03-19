# Weekly Executive Brief Schedule

This scenario tests whether the system can create a recurring operational cadence from a natural owner request, configure the schedule, and deliver a dry-run output immediately instead of stopping at a planning summary.

## Goal

- create a live recurring owner brief;
- confirm cadence and next-run details back to the operator;
- send a useful dry-run example immediately from the same prompt.

## Prompt Type

- one-shot

## Before Running

- no prompt edits are needed unless you want to change the schedule time;
- keep the request concise and do not add internal implementation hints about cron or tables.

## Expected Behavior

- relay should acknowledge the request quickly after routing and keep the operator informed when the schedule work starts and completes;
- normal progress and completion messages should come from `relay`, not `system`;
- the system should create the recurring schedule rather than only explain how it would be done;
- it should produce a dry-run owner brief right away so the operator can inspect the format and usefulness;
- the final reply should clearly confirm that the schedule exists and when it will run next.

## Loop

1. Reset the live runtime with `python testing/website-demo-skill/reset_live_system.py`.
   Start from a clean service state where only `openai` may remain in `service_registry`.
2. Submit the saved prompt from `prompt.md`.
3. Monitor `messages`, `tasks`, `events`, `handoffs`, `memories`, `schedules`, and any created follow-up tasks.
4. Stop the run as soon as something materially wrong is observed.
5. Fix the general scheduling, routing, or operator-delivery logic and do not turn the prompt into a step-by-step tool script.
6. Build, redeploy, reset, and rerun the same prompt.
7. Record the result in `iterations.md`.

## Generic Fix Rule

- do not special-case this exact day, time, or summary wording;
- do not patch the system to only respond correctly when the prompt mentions a recurring brief;
- make the fix general enough that similar schedule-creation requests behave correctly across different cadences and summary types.

## Monitoring Focus

- relay acknowledgement timing and lifecycle communication during the run;
- sender correctness, where `relay` owns normal updates and `system` is reserved for errors or service prompts;
- schedule creation and persisted schedule state;
- correctness and usefulness of the dry-run owner brief;
- operator-visible confirmation of cadence and next-run timing;
- prompt propagation staying coherent if the work fans out into planning, execution, and review tasks.
