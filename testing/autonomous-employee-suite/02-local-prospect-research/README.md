# Local Prospect Research

This scenario tests whether the system can do useful local-market research from a single operator request, verify findings with real evidence, and return an actionable prospecting list instead of generic brainstorming.

## Goal

- research a real local niche and produce a ranked list of outreach targets;
- keep claims grounded in observable evidence from live websites;
- deliver something the operator can use immediately for sales outreach.

## Prompt Type

- one-shot

## Before Running

- replace `{{CITY_OR_REGION}}` with the actual market you want to test;
- keep the prompt natural and do not pre-load the best niche, businesses, or outreach angles into it.

## Expected Behavior

- relay should acknowledge the request quickly after routing and keep normal progress visible to the operator;
- normal progress and completion messages should come from `relay`, not `system`;
- the system should pick a reasonable local-service niche, find real businesses, and narrow the list to the strongest outreach targets;
- each recommended business should be backed by a verifiable website and a clear outreach angle grounded in what the system observed;
- the operator-facing output should be usable without needing a second round just to make sense of it;
- if the result grows into a substantial research pack, the system should surface it as a rich result page rather than forcing the operator to rely on a clipped chat summary.

## Loop

1. Reset the live runtime with `python testing/website-demo-skill/reset_live_system.py`.
   Start from a clean service state where only `openai` may remain in `service_registry`.
2. Submit the saved prompt from `prompt.md`.
3. Monitor `messages`, `tasks`, `events`, `handoffs`, `memories`, `artifacts`, and workspace output throughout the run.
4. Stop the run as soon as something materially wrong is observed.
5. Fix the general research, verification, routing, or delivery logic rather than rewriting the prompt to hint the right businesses or conclusions.
6. Build, redeploy, reset, and rerun the same prompt.
7. Record the result in `iterations.md`.

## Generic Fix Rule

- do not special-case this market, city, or chosen niche;
- do not add the target businesses or outreach angles directly into the prompt;
- make the fix broad enough that the same logic would produce a strong list in a different region or service category.

## Monitoring Focus

- relay acknowledgement timing and lifecycle communication during the run;
- sender correctness, where `relay` owns normal updates and `system` is reserved for errors or service prompts;
- source discovery and verification quality;
- operator-visible delivery of a ranked, evidence-backed shortlist;
- absence of made-up businesses, unverifiable claims, or vague filler output;
- task routing remaining focused on research and synthesis instead of unrelated implementation work.
