# Decisions

This document records the major architectural decisions in Agent-OS, what was chosen,
what was rejected, and why.

Do not change these decisions casually. If a decision should be revisited, create an
architect-approved task with the reasoning and the expected impact.

---

## D-001: Native Provider CLI, Not Session Extraction

**Decision:** All agent inference runs through the active vendor CLI (`claude` or
`codex`). No component may extract, proxy, or reuse provider session tokens for API
calls.

**Why:** This keeps the system aligned with vendor expectations for subscription-based
CLI products and removes an entire class of secret-handling risk. The supervisor is a
process manager, not an auth relay.

**Rejected:** OAuth/session extraction, custom wrappers that replay subscription auth,
and third-party tools that depend on session token reuse.

**Consequence:** Core operation depends on a valid provider CLI login, not on hidden
token plumbing.

---

## D-002: All Agents Run Through the Active Coding CLI

**Decision:** Every role, including lightweight ones like relay and sentinel, runs as a
native coding CLI process. There is no separate inline LLM path for core agent work.

**Why:** One execution model is simpler to reason about, debug, audit, and secure than a
hybrid system where some work happens in child processes and some happens in direct API
calls.

**Rejected:** Hybrid runtime where "small" agents call provider APIs directly while only
"heavy" agents use the CLI.

**Trade-off:** Provider CLI launch has more overhead than a direct API request. We accept
that because durability and simplicity matter more than shaving a second off routing.

---

## D-003: No Token Budgets Per Task

**Decision:** Agents do not get artificial token ceilings per task.

**Why:** Mid-task exhaustion creates half-finished work and expensive cleanup. The
correct optimization target is completed high-quality work, not superficial token
containment.

**Rejected:** Per-task token caps, per-run hard cost caps, and supervisor-enforced
termination of productive work.

**Consequence:** The sentinel monitors cost, throughput, and provider pressure. The
operator sets expectations at the system level, not the individual task level.

---

## D-004: Base Profile and Reasoning Effort Are Assigned by Role

**Decision:** Each role has a default base profile and reasoning effort stored in the
`roles` table. The active provider maps those settings to concrete launch parameters.

**Current base profile mapping:**

- `haiku` = fast profile
- `sonnet` = balanced profile
- `opus` = frontier profile

**Current defaults:**

| Role | Base profile | Base effort | Example Claude launch | Example Codex launch |
|------|--------------|-------------|-----------------------|----------------------|
| Relay | Fast (`haiku`) | medium | `haiku` + `medium` | `gpt-5.4` + `low` |
| Sage | Frontier (`opus`) | high | `opus` + `high` | `gpt-5.4` + `xhigh` |
| Builder | Frontier (`opus`) | high | `opus` + `high` | `gpt-5.4` + `high` |
| Reviewer | Frontier (`opus`) | high | `opus` + `high` | `gpt-5.4` + `high` |
| Architect | Frontier (`opus`) | high | `opus` + `high` | `gpt-5.4` + `high` |
| Sentinel | Balanced (`sonnet`) | high | `sonnet` + `high` | `gpt-5.3-codex` + `medium` |

**Why:** The role intent should stay stable even if the supplier changes. The system
cares about fast vs balanced vs frontier behavior more than it cares about a specific
vendor model name.

---

## D-005: Start with Six Foundational Agents

**Decision:** The system starts with exactly six foundational roles: relay, sage,
builder, reviewer, architect, sentinel.

**Why:** Those roles cover communication, planning, execution, verification, evolution,
and monitoring without premature specialization.

**Rejected:** Fewer roles that collapse review/evolution into execution, and more roles
that fragment responsibility before the system has enough work to justify it.

---

## D-006: Structured Data First, Vectors Second

**Decision:** The primary memory system is structured Postgres data. Vector search is a
secondary retrieval aid.

**Why:** Structured state is auditable and deterministic. Vector search is useful for
recall, not for canonical truth.

**Rejected:** Vector-only memory systems that are hard to audit and hard to trust.

---

## D-007: Reciprocal Rank Fusion for Hybrid Search

**Decision:** Hybrid search combines full-text search and vector similarity using
Reciprocal Rank Fusion.

**Why:** RRF fuses differently scaled ranking signals without brittle score
normalization.

**Rejected:** Weighted score blending, vector-only retrieval, and expensive re-ranking by
default.

---

## D-008: Self-Hosted Supabase in the Monorepo

**Decision:** Supabase is self-hosted and lives in the same repository as the rest of the
stack.

**Why:** The deployment should be a single unit that can be installed on a VPS without
manual cross-system wiring.

**Rejected:** Cloud-only Supabase as a hard dependency for the base system.

---

## D-009: Headless Bypass Mode Is Mandatory

**Decision:** The active provider CLI always runs in its fully autonomous headless mode.
Today that means:

- Claude: `--dangerously-skip-permissions`
- Codex: `--dangerously-bypass-approvals-and-sandbox`

**Why:** Interactive permission prompts make autonomous background work impossible.

**How safety is maintained:** Scoped workspaces, MCP allowlists, and explicit supervisor
env scrubbing so agent subprocesses do not inherit the full control-plane secret set.
This does not create a hard sandbox boundary, but it materially reduces blast radius
when the provider CLIs must run in bypass mode.

---

## D-010: The Public Root Domain Is Optional

**Decision:** `domain.com` is optional output surface, not a mandatory product
requirement.

**Why:** Agent-OS can operate as a private assistant, operations system, research worker,
or internal coordinator without exposing anything publicly.

**Consequence:** The system can run indefinitely with only `admin.domain.com`.

---

## D-011: Default Concurrency of 5

**Decision:** The supervisor allows up to 5 parallel provider CLI runs by default.

**Why:** This is enough to support specialized roles without letting runaway task
creation consume the VPS immediately.

**Rejected:** Single-threaded operation, unlimited concurrency, and hard CPU/RAM caps as
the primary control mechanism.

---

## D-012: Task State Machine Is Enforced in the Database

**Decision:** Task transitions are enforced by a Postgres trigger, not by trusting the
application layer.

**Why:** The database is the source of truth. Invalid transitions must be impossible no
matter which service initiates the update.

---

## D-013: Handoff Notes Are Mandatory

**Decision:** Every task leaving `running`, blocked, or failed states must include a
handoff note.

**Why:** Sessions are disposable. Handoffs are the durable explanation of what happened
and what the next agent should do.

---

## D-014: Relay Uses the Fast Profile by Default

**Decision:** The relay defaults to the fast profile with medium reasoning.

**Why:** Relay work is mostly classification, prioritization, and routing. It is on the
critical path of every operator interaction, so speed matters more here than anywhere
else.

**Consequence:** If routing quality proves insufficient, the operator can raise the relay
to a stronger provider-specific launch profile.

---

## D-015: Only the Architect Can Approve System Modifications

**Decision:** System-modification tasks require architect approval. Builders can
implement the change, but they cannot self-approve it.

**Why:** Changes to roles, agents, policy, routing, schema, or infrastructure affect all
future sessions and need a single control point.

---

## D-016: Memory Retrieval Follows the Scope Chain

**Decision:** Memory retrieval proceeds from narrow to broad scope: task, project or
customer, role, company.

**Why:** That prevents scope leakage and keeps retrieval relevant to the current work.

---

## D-017: Browser Automation Is a Standard Capability

**Decision:** A headless browser service is a core part of the system and available to
all agents.

**Why:** Provider login flows, third-party OAuth, research, QA, and deployment checks all
require browser automation.

**Rejected:** Browser-less architecture or forcing every role to script raw browser tools
itself.

---

## D-018: Telegram Uses Webhooks, Not Polling

**Decision:** Telegram runs in webhook mode through a Supabase Edge Function.

**Why:** Webhooks are event-driven and resource-efficient. Polling burns resources to do
nothing when idle.

---

## D-019: Self-Evolution Happens Through Configuration, Not New Runtime Code

**Decision:** New agents are created as data and policy, not as new binaries or services.

**Why:** The system should be able to add roles without rebuilding the runtime. New roles
should appear through `roles`, `agents`, Supabase-backed policy docs, schedules, and
permissions.

---

## D-020: MCP Does Not Get Direct Docker Socket Access on VPS

**Decision:** On the VPS overlay, the Docker socket is mounted into the supervisor only,
not into MCP.

**Why:** MCP already reaches runtime-side infrastructure changes through the supervisor
control-plane endpoint. Giving MCP a direct Docker socket mount would widen the runtime
trust boundary without adding necessary capability.

**Consequence:** Supervisor remains the only container with direct Docker control. MCP
must continue to route service control and public-site route actions through supervisor.

**What still requires redeploy:** New MCP tools, supervisor logic changes, admin UI
changes, new Docker services, and fundamental schema changes.

---

## D-020: Sentinel Runs on a Schedule and Event Triggers

**Decision:** The sentinel is not a permanently running agent. It is invoked on schedule
and by selected events.

**Why:** Monitoring tasks are bursty and quick. Keeping a dedicated provider CLI session
alive all day would waste capacity.

---

## D-021: Append First, Distill Later

**Decision:** Memory writes during a run are append-first. Distillation into higher-level
semantic memory happens asynchronously.

**Why:** Capturing facts and events immediately is cheap and robust. Distillation can be
done later without blocking the task that produced the information.

---

## D-022: Service Registry Uses the "Key Needed" Pattern

**Decision:** Missing third-party credentials are represented explicitly in
`service_registry` with `status = key_needed`.

**Why:** Agents should surface missing capabilities as actionable requests instead of
failing silently or inventing unsafe workarounds.

**Consequence:** The operator gets a concrete request with context and can provide the
credential through the admin UI.

---

## D-023: Single Monorepo, Single VPS Deployment

**Decision:** The whole stack deploys as one monorepo onto a VPS through Docker Compose
and Caddy.

**Why:** The system should be installable from a terminal on a VPS with minimal manual
assembly. One repo, one compose topology, one reverse proxy, one domain policy.

**Consequence:** `admin.domain.com` and `domain.com` are first-class routes, wildcard
subdomains are available for generated public services, and agents use the MCP
`service_control` tool for supported service status, restart, and reload operations
instead of treating Docker access as a general-purpose shell escape hatch.
