# Decisions

This document records every significant architectural decision, what was chosen, what was
rejected, and why. It exists to prevent future contributors (human or agent) from
unknowingly reversing deliberate choices.

Do not change any of these decisions without explicit operator approval. If you believe a
decision should be revisited, create a task for the architect with your reasoning.

---

## D-001: Native Claude Code CLI, Not Token Extraction

**Decision:** All agents run as native `claude` CLI processes. No component may extract,
read, proxy, or reuse Claude Code's OAuth session tokens for API calls.

**Why:** In January 2026, Anthropic deployed server-side blocks against third-party tools
using subscription OAuth tokens. In February 2026, they published official legal
documentation formalizing the ban: using subscription OAuth tokens "in any other product,
tool, or service — including the Agent SDK" is a Terms of Service violation. Our system
launches the actual `claude` binary as a child process, which is explicitly supported.
Token extraction would risk immediate account termination.

**Rejected:** API-only approach (expensive — subscription is flat-rate vs. per-token API
billing); hybrid OAuth extraction (violates ToS); third-party wrappers like OpenCode
(explicitly blocked by Anthropic).

**Consequence:** The system has exactly one auth dependency: a valid Claude Code session.
All six foundational agents and all evolved agents share this. If the session expires,
the entire system pauses until the operator re-authenticates.

---

## D-002: All Agents Run Through Claude Code, No Inline API Calls

**Decision:** Every agent — including lightweight ones like relay and sentinel — runs as
a Claude Code process. There is no separate "inline LLM call" execution path.

**Why:** One execution model is simpler to build, debug, and maintain than two. The
supervisor is purely a process manager, not a hybrid that sometimes calls APIs and
sometimes launches processes. This also means the system works with only a subscription
login — no API key required for core operation.

**Rejected:** Hybrid model where relay/sage/reviewer run as direct Anthropic API calls
(requires a separate API key, doubles the auth surface, makes the supervisor more
complex); local model inference for lightweight tasks (no GPU on VPS, adds significant
complexity).

**Trade-off:** The relay is slower than an inline API call (process spawn overhead). We
accept this because routing latency of a few seconds is irrelevant in a system where
tasks queue anyway.

---

## D-003: No Token Budgets Per Task

**Decision:** Agents do not have artificial token limits. A Claude Code process runs
until the task is complete or until it determines it cannot proceed.

**Why:** Token budgets create a false economy. A builder that hits its token limit
mid-task produces incomplete work that costs more to clean up than the tokens saved. The
cost of a failed build (wasted operator time, reviewer time, rework) almost always exceeds
the cost of more tokens.

**Rejected:** Per-task token budgets (creates mid-task failures); per-run cost caps
(same problem); hard spending limits enforced by the supervisor (kills productive work
alongside wasteful work).

**How cost is managed instead:** The sentinel monitors spending patterns and alerts the
operator on anomalies. The operator sets expectations, not ceilings. Claude Code
subscription is flat-rate, so per-run token usage doesn't directly translate to cost
anyway — it translates to rate limiting and queue wait times.

**Note on task_runs table:** We deliberately do not store token counts or cost_cents in
task_runs. The subscription model does not expose per-request token usage. If the operator
adds an API key for some operations, those can be tracked separately.

---

## D-004: Model and Effort Assignment by Role

**Decision:** Each role has a default model (opus/sonnet/haiku) and effort (low/medium/
high), stored in the `roles` table and overridable per-agent via the admin panel.

**Defaults:**

| Role      | Model  | Effort | Reasoning                                        |
|-----------|--------|--------|--------------------------------------------------|
| Relay     | Haiku  | Medium | Routing is classification, not reasoning. Speed  |
|           |        |        | matters — relay is in the critical path of every |
|           |        |        | human interaction.                               |
| Sage      | Opus   | High   | The sage's entire value is reasoning quality. A  |
|           |        |        | mediocre plan cascades mediocrity through         |
|           |        |        | everything the builder implements.               |
| Builder   | Opus   | High   | Produces the system's actual output. Failed builds|
|           |        |        | cost more than tokens: operator time, reviewer    |
|           |        |        | time, rework. Minimize failure rate.             |
| Reviewer  | Opus   | High   | Must be at least as capable as the builder, or   |
|           |        |        | it will miss the builder's mistakes.             |
| Architect | Opus   | High   | Makes system-level decisions. Mistakes cascade    |
|           |        |        | across all future sessions.                      |
| Sentinel  | Sonnet | High   | Monitoring is pattern recognition — important but |
|           |        |        | not frontier-level. Runs periodically (every 30 min)|
|           |        |        | so per-run cost matters more here.               |

**Why not Opus everywhere:** The relay processes every single human message. On a busy
day, that could be dozens of runs. Haiku handles classification well and responds much
faster. The sentinel runs every 30 minutes — 48 times/day. Sonnet is sufficient for
threshold analysis. Saving frontier-model capacity for the agents that need it.

---

## D-005: Six Foundational Agents, Not More, Not Fewer

**Decision:** The system starts with exactly six agents: relay, sage, builder, reviewer,
architect, sentinel.

**Why these six:** They map to the five capabilities a self-evolving system needs
(communicate, think, build, verify, evolve) plus one for self-monitoring (watch). No
fewer than six covers all loops. No more than six avoids over-specialization before the
system has enough work to justify it.

**Why not a separate agent_builder:** The builder already has the capability to create
new agent configurations. A separate agent_builder would be another process competing
for the same execution slot with no capability the builder doesn't have. System
modification is a permission level (requires architect approval), not a separate identity.

**Why not a chief_of_staff as the human interface:** The relay is a dedicated fast
router, not a coordinator. The "chief of staff" concept evolved into the architect,
which provides meta-level oversight by analyzing reviewer reports and driving system
evolution. The relay handles human communication; the architect handles system strategy.
Separating these prevents the human-facing agent from being slow because it's also
doing deep strategic analysis.

**Rejected:** 3-agent model (relay + builder + reviewer — no evolution capability);
8-agent model (separate agent_builder, separate policy_manager — over-specialized for
a system with no work yet); single-agent model (no specialization, no review, no
evolution).

---

## D-006: Structured Data First, Vectors Second

**Decision:** The primary memory system is structured Postgres tables (memories, events,
tasks, artifacts). Vector search is a secondary recall aid built on top, stored in a
separate `memory_chunks` table.

**Why:** Vector search is probabilistic — it returns "similar" results, not "correct"
results. For questions like "what are ACME's billing terms?" or "what tasks are blocked?",
you need deterministic SQL queries on structured data. For questions like "have we seen
something like this before?", you need semantic search. Most agent memory systems start
with vectors and end up with something they cannot audit, query deterministically, or
trust for finance/compliance.

**The hierarchy:** Tables are truth. Events are history. Vectors are recall aids.
Summaries are convenience.

**Memory chunks are derived, not canonical.** They can be fully regenerated from the
source `memories` and `artifacts` tables. If the vector index gets corrupted or the
embedding model changes, drop and regenerate — no data loss.

---

## D-007: Reciprocal Rank Fusion for Hybrid Search

**Decision:** The `hybrid_memory_search` function combines full-text search (tsvector)
and vector search (pgvector) using Reciprocal Rank Fusion (RRF) with a default k=60.

**Why RRF:** It fuses two differently-scaled ranking signals without requiring score
normalization, weight tuning, or calibration data. FTS and vector similarity produce
scores on completely different scales — RRF sidesteps this by using rank positions
instead of raw scores. It is simple to implement, well-studied, and robust.

**Rejected:** Weighted linear combination of scores (requires tuning weights and
normalizing scores); re-ranking with a cross-encoder (adds latency and complexity);
vector-only search (misses exact-term matches); FTS-only search (misses semantic
similarity).

---

## D-008: Self-Hosted Supabase in the Monorepo

**Decision:** Supabase runs self-hosted via Docker Compose, included in the monorepo with
migration files. No Supabase Studio in production.

**Why:** The system must be a single-deployment unit. Cloud Supabase would add an external
dependency, a separate account, manual key wiring, and a monthly bill. Self-hosted means
the repo contains everything: schema, seed data, key generation, and pre-wired
connections. The migration files control exactly what runs on deployment.

**Trade-off:** Self-hosted Supabase is heavier on resources and the operator owns backups.
We accept this for the deployment simplicity.

**Studio disabled:** Supabase Studio is a web UI for database management. It adds resource
overhead and is unnecessary when all schema changes go through migrations. If the operator
needs to inspect the database, they use the admin panel or connect directly via psql.

---

## D-009: --dangerously-skip-permissions Is Mandatory

**Decision:** All Claude Code processes run with `--dangerously-skip-permissions`. There
is no permission-prompt mode.

**Why:** Without this flag, Claude Code pauses for human confirmation on every file write,
shell command, and network request. This makes unattended autonomous operation impossible.
The system has no human sitting at a terminal to approve each action.

**How safety is maintained:** Container isolation, not permission prompts. Each Claude
Code process runs inside a Docker container with scoped volume mounts. The agent can only
write to its designated working directory. It cannot reach the host filesystem, other
containers, or system resources. The MCP server is the only path to the database and
external services.

**The container image pre-configures `skipDangerousModePermissionPrompt: true`** in
`~/.claude/settings.json` to suppress the bypass-mode warning dialog that would otherwise
block headless launches.

**Risk:** Subagents spawned by Claude Code inherit full bypass permissions. The
AGENTS_INSCTRUCTIONS.md
scope rules are instruction-based, not permission-based. An agent that ignores its
instructions could write outside its designated scope within the container. The container
boundary is the real isolation — not the permission system.

---

## D-010: The Public Domain Is Optional

**Decision:** The system does not require a public-facing website. The `domain.com`
surface is optional and can be left empty indefinitely.

**Why:** The system is a general-purpose AI employee, not a website builder. It can act
as a personal assistant, business monitor, research agent, content pipeline, or any
combination. The public domain is one possible output surface, not the core purpose.

**Consequence:** The public surface container starts empty. If the operator never
instructs the system to build a public site, it stays empty. The admin panel is the
only mandatory interface.

---

## D-011: Default Concurrency of 5, No Hard Resource Ceiling

**Decision:** The supervisor allows up to 5 parallel Claude Code processes by default.
This is configurable in the admin panel. There are no hard memory or CPU limits.

**Why:** Designing around resource constraints that can be removed with a VPS upgrade is
the wrong optimization. If the system needs more capacity, the operator scales the server.
The sentinel monitors system health and alerts on resource pressure, but it does not
refuse to work.

**Rejected:** Single-agent concurrency (unnecessarily sequential for a system with
multiple roles); unlimited concurrency (a runaway loop could exhaust the VPS); hard
RAM/CPU caps (prevents legitimate work when resources are tight but functional).

**Protection against runaway:** The sentinel watches queue depth and task creation rate.
If tasks are being created faster than processed (possible infinite loop), the sentinel
freezes the queue and alerts the operator.

---

## D-012: Task State Machine Enforced by Database Trigger

**Decision:** The task state machine is enforced by a Postgres `BEFORE UPDATE` trigger,
not by application code in the MCP server or supervisor.

**Why:** The database is the source of truth. If the state machine is enforced only in
application code, a bug, race condition, or direct database access could put a task in
an invalid state. The trigger guarantees that no task can ever make an invalid transition,
regardless of how the update was initiated.

**What the trigger enforces:** Valid transitions, handoff note requirement when leaving
running/blocked/failed states, automatic attempt_count increment on failure, automatic
dead_letter routing when max_attempts is reached, timestamp setting.

---

## D-013: Handoff Notes Are Mandatory

**Decision:** Every task transition out of `running`, `blocked`, or `failed` states
requires a non-null `last_handoff_note`. The database trigger rejects updates without it.

**Why:** When an agent session ends, the handoff note is the only structured record of
what happened. Without it, the next agent (or the same agent in a new session) has no
context beyond git commits. Handoff notes are what make the system durable across session
boundaries.

**Format:** "What I did / what changed / what is blocked / what to do next." This is
documented in AGENTS_INSCTRUCTIONS.md and enforced by the trigger.

---

## D-014: Relay Uses Haiku, Not Opus

**Decision:** The relay agent uses Haiku with medium effort, not Opus.

**Why:** The relay's job is intent classification and routing. It reads a human message,
decides whether it's a new task / question / modification / conversation, and routes
accordingly. This is pattern matching, not deep reasoning. Haiku handles it well and
responds significantly faster than Opus. The relay is in the critical path of every human
interaction — latency matters here more than anywhere else.

**If routing quality is insufficient:** The operator can upgrade the relay to Sonnet or
Opus in the admin panel. The architecture supports any model for any role. Haiku is the
starting default, not a permanent constraint.

---

## D-015: The Architect Is the Only Agent That Can Approve System Modifications

**Decision:** Tasks tagged with `is_system_modification = true` require architect
approval. The builder can implement system changes but cannot self-approve them.

**Why:** System modifications (new roles, agents, policies, RLS rules, schema changes)
have cascading effects across all future sessions. A single access control point prevents
accidental or misguided modifications. The architect is the agent with the broadest
system context and is specifically designed to evaluate whether changes serve the
operator's goals.

**The evolution loop:** reviewer spots pattern → architect analyzes → architect consults
sage → sage plans → architect approves → builder implements → reviewer verifies →
architect activates. No shortcut bypasses the architect.

---

## D-016: Scope Chain for Memory Retrieval

**Decision:** Memory search filters by scope chain, narrowest first: task → project/
customer → role → company-wide.

**Why:** This prevents scope leakage. A financial agent should not see support ticket
details. A support agent should not see financial data. The scoping ensures that agents
only retrieve information relevant to their current work context.

**How it works in practice:** When the MCP server handles a `memory_search` call, it
filters results by the agent's current task scope, then broadens to project, role, and
company scopes. The agent receives a merged result set that respects the hierarchy.

---

## D-017: Browser Service as Standard Capability

**Decision:** A headless Chromium browser (via Vercel's agent-browser) is a standard
system component, available to all agents.

**Why:** Three critical needs require a browser: (1) Claude Code authentication — the
OAuth login flow requires navigating a web page; (2) research — agents need to read
documentation, check competitor sites, find reference implementations; (3) testing —
verifying deployed pages, checking content, running visual checks.

**Rejected:** Browser-less architecture (would require manual auth setup, no web research
capability, no deployment verification); Playwright/Puppeteer directly (agent-browser
provides higher-level agentic control).

---

## D-018: Webhook Mode for Telegram, Not Polling

**Decision:** The Telegram bot uses webhook mode (Telegram pushes updates to a Supabase
Edge Function) rather than polling mode (a process periodically pulls from the Telegram
API).

**Why:** Polling requires a persistent process that periodically calls the Telegram API.
Webhook mode is event-driven and costs zero resources when idle. The Edge Function
receives the update, inserts it into the `messages` table, and exits. The relay picks it
up from there.

---

## D-019: Self-Evolution Through Configuration, Not Code

**Decision:** New agents are data and configuration (rows in `roles` and `agents`, an
`AGENTS_INSCTRUCTIONS.md` section, RLS policies), not new application code. The Claude
Code process that
runs "as" a new agent is the same `claude` binary — it reads different context.

**Why:** This means the system can evolve without redeployment. The builder creates a new
role, the architect activates it, the relay starts routing to it. No Docker rebuild, no
Coolify redeploy, no code push.

**What still requires redeployment:** New MCP tools, supervisor logic changes, admin app
changes, new Supabase extensions, new Docker services. These are infrastructure, not
agent evolution.

---

## D-020: Sentinel Runs on Schedule, Not Continuously

**Decision:** The sentinel is triggered by a cron schedule (every 30 minutes) and by
event-driven Supabase triggers (e.g., queue depth threshold), not as a continuously
running process.

**Why:** A continuous sentinel process would occupy a Claude Code slot permanently. The
sentinel's job — check queue depth, check cost trends, verify auth, check service health
— takes seconds per invocation. Running it every 30 minutes provides adequate monitoring
without consuming resources continuously.

**Event-driven triggers supplement the schedule:** If the task count in `ready` state
exceeds a threshold, a Supabase trigger fires the sentinel immediately rather than
waiting for the next scheduled run.

---

## D-021: Append-First Memory, Distill Later

**Decision:** Memory writes during agent runs are immediate appends (episodic events,
raw facts). Distillation into semantic facts happens asynchronously after the run.

**Why:** Distillation requires reasoning about which facts are important, whether they
contradict existing knowledge, and how to summarize them. Doing this synchronously during
a builder run would slow down the actual work. Appending is cheap and fast. Distillation
can run in the background.

**Who distills:** A scheduled task or the sentinel triggers a distillation pass that reads
recent episodic memories, extracts semantic facts, and marks superseded facts as inactive.

---

## D-022: Service Registry with "Key Needed" Pattern

**Decision:** When an agent discovers it needs an external service that has no API key
configured, it creates a row in `service_registry` with `status: key_needed` and a
human-readable explanation. This surfaces in the admin panel as an actionable request.

**Why:** Agents should not silently fail when a service is unavailable. They should not
hardcode keys. They should not guess at workarounds. The "key needed" pattern creates a
clear feedback loop: agent needs something → operator sees the need with context →
operator provides the key → agent resumes.

**The explanation matters:** The agent writes not just "need ElevenLabs key" but "I need
an ElevenLabs API key to generate your morning audio briefing. You can create one at
elevenlabs.io/api." This reduces the operator's cognitive load.

---

## D-023: Single Monorepo, Single Deployment

**Decision:** Everything — Supabase config, admin app, supervisor, MCP server, browser
service, public surface — lives in one Git repository and deploys as a unit through
Coolify.

**Why:** The system must be deployable by connecting a GitHub repo to Coolify and setting
environment variables. No manual wiring between services, no separate deployments, no
multi-repo coordination. The migration files run on startup. The services discover each
other via the Docker network. The keys are derived from the JWT secret.

**Consequence:** A push to `main` rebuilds affected services. The monorepo structure
determines the Coolify service boundaries.
