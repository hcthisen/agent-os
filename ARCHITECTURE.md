# Architecture

## What This System Is

This is a self-hosted, persistent AI employee system. It runs on a single VPS, deploys
through Coolify from a monorepo, and presents one mandatory interface — an admin panel
for direct human-to-system communication — plus an optional public domain that the system
can use to surface anything it builds.

The system is not a chatbot and not a website builder. It is a durable operating
environment where AI agents hold persistent identities, claim and execute work from a
task queue, remember what they have learned across sessions, and hand off work to each
other or back to the human operator. What the system does depends entirely on the
instructions and tools it is given. It could:

- Build and maintain a company website.
- Act as a personal assistant managing email and calendar.
- Monitor a Stripe account and deliver daily business briefings.
- Run customer support via a chat widget.
- Research topics and produce audio briefings.
- Manage a content pipeline with daily publishing.
- All of the above, simultaneously, evolving as needs change.

The system starts with six foundational agents that can bootstrap into any configuration.
When the system encounters a class of work it cannot handle well, it designs, builds, and
activates new specialized agents — without redeployment.

## Why This Shape

Two fundamental forces shaped this architecture:

**The context window is not memory.** LLM context windows are expensive, finite, and
ephemeral. If the system's knowledge lives only in the current conversation, it forgets
everything when the session ends. Durable state must live outside the model — in a
database that the agent reads from and writes to at the boundaries of each work session.

**Agents crash, stall, and hallucinate.** Any system that depends on an agent maintaining
a long unbroken session will fail. The correct design assumes every session will end
unexpectedly. Work items, state, and progress must be recoverable from the database
alone, without any data from the dead session. Every run begins by reading a context pack
from the database and ends by writing a handoff note back.

## Execution Model

All agents run as native Claude Code CLI processes. This is non-negotiable.

### Native CLI, Not Token Extraction

In January 2026, Anthropic deployed server-side blocks against third-party tools using
subscription OAuth tokens for API calls, and in February 2026 published official legal
documentation formalizing the ban. Using OAuth tokens from Claude subscriptions "in any
other product, tool, or service — including the Agent SDK" is a Terms of Service
violation that can result in account termination.

This system does not extract, read, proxy, or reuse OAuth tokens. It launches the actual
`claude` CLI binary as a child process. Claude Code runs natively, authenticates with its
own session, manages its own token lifecycle. The supervisor is a process manager —
conceptually identical to running multiple Claude Code sessions in tmux, which is how
Gas Town operates and what Anthropic explicitly supports.

**The hard rule:** No component in this system may ever extract a Claude Code session
token and use it for direct API calls. All inference goes through the native `claude`
CLI binary. If a future contributor needs programmatic API access, they must use a
separate API key from the Anthropic Console, billed per token. The subscription auth
and the API key are separate credentials for separate purposes.

### How Agents Are Spawned

The supervisor launches Claude Code in fully autonomous headless mode:

```
claude -p "your task instructions" \
  --dangerously-skip-permissions \
  --model opus \
  --effort high \
  --mcp-server /path/to/mcp-config.json \
  --output-format stream-json
```

The `--dangerously-skip-permissions` flag is mandatory. Without it, Claude Code pauses
for human confirmation on every file write, shell command, and network request — making
unattended operation impossible. This flag bypasses all permission prompts and lets the
agent run to completion without intervention.

**This is safe because agents run inside Docker containers.** Every Claude Code process
is launched within the supervisor's container, which is isolated from the host VPS by
Coolify's Docker setup. The agent has write access only to its designated working
directory (mounted as a volume). It cannot reach the host filesystem, other containers'
filesystems, or system-level resources. The "dangerously" in the flag name refers to
running it on a bare host machine — inside a container with scoped volume mounts, the
blast radius is contained.

The supervisor pre-configures Claude Code's settings at container build time:

```json
// ~/.claude/settings.json (baked into container image)
{
  "skipDangerousModePermissionPrompt": true
}
```

This suppresses the bypass-mode warning dialog that would otherwise block headless
launches.

Each agent type has a fixed model and effort configuration:

| Agent     | Model   | Effort | Why                                                  |
|-----------|---------|--------|------------------------------------------------------|
| Relay     | Haiku   | Medium | Routing is fast classification. Speed matters.       |
| Sage      | Opus    | High   | Deep strategic thinking. Quality is everything.      |
| Builder   | Opus    | High   | Builds the system's output. Must fail as rarely as   |
|           |         |        | possible. The cost of a bad build exceeds the cost   |
|           |         |        | of more tokens.                                      |
| Reviewer  | Opus    | High   | Catches what the builder misses. Must be at least    |
|           |         |        | as capable as the builder.                           |
| Architect | Opus    | High   | Makes system-level decisions. Mistakes here cascade. |
| Sentinel  | Sonnet  | High   | Monitoring and anomaly detection. Needs strong       |
|           |         |        | reasoning but not frontier-level inference.          |

These are stored in the `roles` table and can be changed in the admin panel. The defaults
are deliberately set to the highest quality available. The system should be as smart as
possible — the cost of a failed task (wasted time, broken output, human cleanup) almost
always exceeds the cost of using a more capable model.

**No token budgets.** Agents do not have artificial token limits. A Claude Code process
runs until the task is complete or until it determines it cannot proceed. The sentinel
monitors cost trends and alerts the operator if spending is anomalous, but it does not
kill processes based on token count. The operator sets the overall spending expectations,
not per-task ceilings.

### Concurrency

The supervisor manages parallel Claude Code processes. Default concurrency: 5. This is
configurable in the admin panel. The sentinel monitors system health and alerts the
operator if the VPS is under resource pressure, but the system does not enforce hard
resource ceilings — if you need more capacity, scale the VPS.

The system will not spin up unbounded parallel processes. New agents created through the
evolution mechanism inherit the default concurrency limit. The sentinel watches queue
depth and task creation rate; if something attempts to spawn hundreds of tasks in a burst,
the sentinel freezes the queue and alerts the operator before any of those tasks claim
process slots.

## System Components

Seven components, all in one monorepo, deployed as Coolify services.

```
┌───────────────────────────────────────────────────────────────────┐
│  COOLIFY (on Hetzner VPS)                                         │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ admin.domain │  │  domain.com  │  │  Supabase              │  │
│  │ (Admin App)  │  │  (Optional   │  │  (self-hosted)         │  │
│  │ React SPA    │  │   Public     │  │  Postgres + Auth       │  │
│  │ + OAuth gate │  │   Surface)   │  │  + Storage + Edge Fn   │  │
│  └──────┬───────┘  └──────▲───────┘  └──────────┬─────────────┘  │
│         │                 │                      │                │
│         │      ┌──────────┴──────────────────────┤                │
│         │      │                                 │                │
│  ┌──────▼──────▼──────────┐        ┌─────────────▼────────────┐  │
│  │  Supervisor Daemon     │◄──────►│  MCP Server              │  │
│  │  (process manager for  │        │  (tool interface,        │  │
│  │   native Claude Code   │        │   enforces policy,       │  │
│  │   CLI processes)       │        │   service registry)      │  │
│  └──────────┬─────────────┘                                      │
│             │                      └──────────────────────────┘  │
│  ┌──────────▼─────────────┐  ┌────────────────────────────────┐  │
│  │  Claude Code Processes │  │  Browser Service               │  │
│  │  (native CLI, up to N  │  │  (headless Chromium via        │  │
│  │   parallel, default 5) │  │   agent-browser, for auth,     │  │
│  │  Auth: own session     │  │   research, testing)           │  │
│  │  Tokens: never exposed │  │                                │  │
│  └────────────────────────┘  └────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────┐                                      │
│  │  Telegram Bot          │  (webhook → Supabase Edge Fn)        │
│  └────────────────────────┘                                      │
└───────────────────────────────────────────────────────────────────┘
```

### 1. Supabase (self-hosted)

Supabase is the durable operating system. It holds all state: tasks, agents, roles,
memories, events, approvals, artifacts, schedules, the service registry, and the cost
ledger. It also provides Auth (GoTrue), Storage (for files and artifacts), Edge Functions
(for webhooks and async processing), and Realtime (for pushing updates to the admin UI).

Supabase is included in the monorepo as a Docker Compose configuration with migration
files. On first deployment, migrations create the schema, seed the six foundational agent
roles, and configure Row Level Security. Environment variables (set in Coolify) provide
the Postgres password, JWT secret, and the generated anon/service keys.

The anon key is used by the admin UI. The service key is used only by the MCP server and
supervisor daemon — never by agents directly. Agents authenticate via scoped JWT tokens
that enforce RLS by role.

**Why self-hosted:** The system must be a single-deployment unit. Cloud Supabase would
add an external dependency, a separate account, and manual key wiring. Self-hosted means
the repo contains everything: schema, seed data, key generation, and pre-wired
connections.

### 2. Admin App (admin.domain.com)

A React single-page application behind a simple OAuth gate. Login credentials are set
via environment variables — no user registration, no public access.

The admin app is the primary human-to-system interface:

- **Chat interface**: Real-time conversation with the system. Messages are received by
  the relay agent, which routes them as tasks or instructions.

- **Task dashboard**: All tasks by state, project, agent. Approve or reject pending
  approvals. Reassign stuck tasks. Inspect dead letter queue.

- **Agent status**: Active agents, roles, current tasks, parallel processes running,
  model/effort configuration, evolution history.

- **Memory browser**: Search and inspect memories. Edit, verify, or expire facts. See
  provenance chains.

- **Event log**: Chronological audit trail of everything the system has done.

- **Cost dashboard**: Token usage and cost by agent, role, project, period.

- **System health**: Live sentinel view — process count, queue depth, cost trends,
  service status, alerts.

- **Service connections**:

  **Claude Code authentication** — The operator clicks "Connect Claude Code." The system
  opens the `claude login` flow via the browser service. The operator sees the Claude.ai
  login page (proxied to the admin panel), enters their credentials, and completes the
  OAuth flow. Claude Code stores its own session. The system never extracts or reads the
  token — it only verifies that `claude` CLI commands succeed. If the session expires,
  the sentinel detects it and requests re-authentication via admin panel and Telegram.

  **API keys** — Key-value store for external service credentials (ElevenLabs, OpenAI,
  Stripe, SendGrid, etc.). When an agent discovers it needs a service without a
  configured key, it creates a request that appears here with an explanation of what it
  needs and why. The operator pastes the key; the agent resumes. A separate Anthropic
  API key can optionally be added here — this is used only for non-Claude-Code purposes
  (e.g., embedding generation) and is billed per token, independent of the subscription.

  **Connected services** — Status of all integrations: active, missing key, errored.

- **Settings**: Concurrency limit, agent model/effort overrides, role configurations,
  system policies, schedule management.

### 3. Public Surface (domain.com) — Optional

The public domain is not required. The system can run indefinitely with only the admin
interface, acting as a personal assistant, business monitor, research agent, or any
non-public-facing role.

When the operator wants a public presence, they instruct the system to build one. The
public surface starts as an empty container (Node/Bun runtime). The system chooses the
tech stack, builds the site, and deploys via git push → Coolify auto-redeploy.

Lives in `/sites/public/` within the monorepo. Agents have write access only to this
directory.

### 4. Supervisor Daemon

A long-running process (Node.js or Deno) that manages all Claude Code processes. The
supervisor contains no AI logic — it is purely a process manager and work queue processor.

**Launches agents.** When a task is ready and a process slot is available:
1. Claims the task for the appropriate agent identity.
2. Calls `build_context_pack()` from the database.
3. Prepares the working directory and writes `AGENTS.md`, `AGENTS_INSCTRUCTIONS.md`,
   and `TASK_BRIEFING.md`.
4. Launches `claude -p [instructions] --model [model] --effort [effort]` as a child
   process with the MCP server configured.
5. Streams stdout for progress tracking.

**Manages concurrency.** Tracks active processes. Enforces the concurrency limit
(default 5, configurable). Queues work when all slots are occupied. Prioritizes by
task urgency.

**Records outcomes.** When a Claude Code process exits, the supervisor parses the
structured output, records a `task_run`, updates the task state, and writes the
handoff note.

**Handles failures.** Crashed, timed-out, or error-exiting processes → task marked
`failed`, `attempt_count` incremented, routed to `dead_letter` if max attempts reached.

**Routes messages.** Human messages from admin chat or Telegram → queued as relay tasks
with high priority.

**Runs schedules.** Checks `schedules` table for fired cron expressions, creates tasks.

**Recovers from restart.** On startup, checks for orphaned tasks (`running` or `claimed`
with no active process) and returns them to `ready`.

### 5. MCP Server

The agent's tool interface to the database. Claude Code processes call MCP tools to
interact with the system — they never access the database directly.

The MCP server:

- Connects to Supabase with the service key internally.
- Validates every request against the agent's identity (agent_id, role_id, run_id).
- Enforces scope: agents access only data within their role's scope chain.
- Enforces policy: blocks actions requiring approval and creates approval requests.
- Checks the service registry before external service calls.
- Tracks cost per tool call for the cost ledger.
- Sets trace_id on every event for observability.

10 tools:

| Tool              | Purpose                                              |
|-------------------|------------------------------------------------------|
| task_claim        | Claim next ready task for your role                  |
| task_update       | Update task state (state machine enforced by DB)     |
| task_create       | Create a sub-task or delegate to another role        |
| memory_search     | Hybrid FTS + vector search, scoped                   |
| memory_write      | Write a structured memory (episodic or semantic)     |
| event_log         | Log any side effect or occurrence                    |
| artifact_put      | Register a file, doc, PR, report                     |
| handoff_create    | Hand off work to another agent or role               |
| approval_request  | Request human sign-off for high-stakes action        |
| context_refresh   | Re-fetch context pack mid-run                        |

### 6. Browser Service

Headless Chromium via Vercel's agent-browser. Standard capability for all agents.

- **Authentication**: Claude Code login flow, external service OAuth.
- **Research**: Browse docs, reference sites, competitor pages.
- **Testing**: Verify deployed pages, check content and functionality.
- **Data extraction**: Scrape structured data from pages without APIs.
- **Interaction**: Fill forms, navigate multi-step flows.

Runs as a Docker container. Idle when unused, starts sessions on demand.

### 7. Telegram Bot

Webhook mode. Telegram sends updates to a Supabase Edge Function, which inserts the
message into the same queue the admin chat uses. The relay processes it identically.

## The Six Foundational Agents

The system starts with six agents that together can bootstrap into any configuration.
All six run as native Claude Code CLI processes with different model and effort settings.

### Why These Six

A self-evolving, self-monitoring system needs six capabilities:

1. **Communicate** — understand what the human wants
2. **Think** — plan how to achieve it
3. **Build** — execute the plan
4. **Verify** — check if it was done right
5. **Evolve** — improve the system itself
6. **Watch** — monitor the system's own health

```
    Human (admin chat / Telegram)
         │
         ▼
    ┌──────────┐
    │  RELAY   │  Haiku · Medium effort
    │  routes  │  "What does the human want?"
    └────┬─────┘
         │
         ├──── simple task ──────────────────────┐
         │                                       ▼
         ├──── complex task ──► ┌─────────┐  ┌─────────┐
         │                     │  SAGE    │  │ BUILDER │
         │                     │  Opus    │  │ Opus    │
         │                     │  High    │  │ High    │
         │                     └────┬─────┘  └────┬────┘
         │                          │              │
         │                     plan doc        completed work
         │                          │              │
         │                          └──────┐       │
         │                                 ▼       ▼
         │                            ┌──────────────┐
         │                            │   REVIEWER   │
         │                            │   Opus·High  │
         │                            └──────┬───────┘
         │                                   │
         │                            review report
         │                                   │
         │                                   ▼
         │                            ┌──────────────┐
         │                            │  ARCHITECT   │
         │                            │  Opus·High   │
         │                            └──────────────┘
         │
    ┌────────────┐
    │  SENTINEL  │  Sonnet · High effort
    │  monitors  │  (independent of task flow)
    └────────────┘
```

### Relay

**Model: Haiku · Medium effort**

The front door. Every human message passes through the relay first.

What it does:
- Receives messages from admin chat and Telegram.
- Classifies intent: new task, question answerable from memory, modification to existing
  task, policy change, casual conversation.
- For new tasks: determines complexity, assigns to a role, sets priority, creates the
  task. Simple tasks go directly to the builder. Complex or novel tasks route through the
  sage first.
- For questions: searches memory and responds directly if possible. Escalates to sage
  for deep analysis.
- For conversation: maintains natural dialogue. Remembers communication preferences.

Persistent memory: Communication patterns, user preferences, frequently referenced
projects, operator shorthand, preferred update formats and timing.

Why Haiku: The relay's job is classification and routing — pattern matching, not deep
reasoning. Haiku handles this well and responds fast. Speed matters because the relay
sits in the critical path of every human interaction. If routing decisions prove too
shallow, this can be upgraded to Sonnet in the admin panel.

### Sage

**Model: Opus · High effort**

Deep thinker. Strategic advisor. Never executes — only plans and advises.

What it does:
- Produces structured plans for complex tasks: objectives, steps, dependencies, risks,
  acceptance criteria.
- Advises the architect on system evolution decisions.
- Decomposes ambiguous or large requests into concrete task graphs.
- Evaluates competing approaches when the builder encounters a decision point.

When invoked:
- By the relay, when a task is complex or novel.
- By the architect, when considering system changes.
- By the builder, when it encounters a strategic fork.
- Never unprompted. The sage waits to be asked.

Persistent memory: Architectural decisions and rationale, past plans and outcomes,
operator preferences and priorities, domain knowledge about the business.

Why Opus High: The sage's entire value is the quality of its reasoning. A sage that
produces mediocre plans cascades mediocrity through everything the builder then
implements. The extra cost per invocation is justified because the sage runs infrequently
— only for planning and strategy, not routine work.

### Builder

**Model: Opus · High effort**

General-purpose executor. The workhorse.

What it does:
- Writes code: websites, APIs, integrations, scripts, configurations.
- Creates content: blog posts, reports, documentation, emails, audio scripts.
- Implements integrations: Stripe, email, calendar, Slack, any API.
- Builds new agent configurations when directed by the architect — role definitions,
  policy documents, `AGENTS_INSCTRUCTIONS.md` sections, RLS policies, MCP tool permissions.
- Runs tests and verifies its own work before marking complete.

What it cannot do without architect approval:
- Modify the system's own role or agent configuration.
- Change RLS policies or database schema.
- Alter the supervisor, MCP server, or admin app code.

Persistent memory: Technical decisions, codebase patterns, framework preferences, past
implementations, known bugs and workarounds.

Why Opus High: The builder produces the system's actual output — the code, the content,
the integrations that the operator and their customers see. A failed build costs more
than just tokens: it costs the operator's time to debug, the reviewer's time to catch,
and the builder's time to redo. Using the strongest model with highest effort minimizes
failure rate, which is the most important metric for the builder.

### Reviewer

**Model: Opus · High effort**

Quality gate. Every completed piece of work passes through review.

What it does:
- Reviews completed builder output against acceptance criteria.
- Checks: correctness, completeness, security, style consistency, policy compliance.
- Three outcomes: approved (→ completed), revision needed (→ back to builder with
  feedback), escalate (→ architect for system-level concern).
- Generates structured review reports logged as events.
- Tags recurring issues. If the same problem type recurs across tasks, flags the pattern
  to the architect.

Persistent memory: Quality standards, recurring issues, review history, operator feedback.

Why Opus High: The reviewer must be at least as capable as the builder, or it will miss
the builder's mistakes. A weaker reviewer creates false confidence.

### Architect

**Model: Opus · High effort**

The system's self-improvement loop. Meta-level oversight.

What it does:
- Receives review reports. Spots patterns across tasks.
- Decides when the system needs to evolve: new role, updated policy, new integration.
- Consults the sage for planning system changes.
- Creates system-modification tasks for the builder with explicit approval requirements.
- Is the only agent that can approve changes to the system's own configuration.

The evolution loop:
1. Reviewer flags a pattern: "Builder keeps struggling with customer support tasks."
2. Architect analyzes: skill gap, missing tool, or need for a new role?
3. Architect consults sage: "Design a support_agent role."
4. Sage produces a plan: role definition, policies, permissions, initial knowledge.
5. Architect creates a task for the builder: "Implement this new role."
6. Builder implements: DB migration, `AGENTS_INSCTRUCTIONS.md` section, RLS policies.
7. Reviewer checks the implementation.
8. Architect activates the new role.
9. Relay starts routing relevant tasks to the new role.

Persistent memory: System evolution history, architectural decisions, performance trends,
cost analysis, operator's strategic goals.

### Sentinel

**Model: Sonnet · High effort**

Watches the system itself. Operates independently of the task flow.

**Queue monitoring:** Watches task queue depth and creation rate. If tasks are being
created faster than processed (possible runaway loop):
1. Freezes the queue.
2. Identifies the source.
3. Alerts the operator via admin panel and Telegram.
4. Waits for operator decision before unfreezing.

**Cost monitoring:** Tracks spending trends. If spend deviates significantly from
established patterns, alerts the operator. Does not kill processes — the operator decides.

**Stuck task detection:** Identifies tasks in `claimed` or `running` state too long
without progress events. Returns them to `ready` or escalates.

**Process health:** Checks that supervisor, MCP server, and Supabase are responsive.
Alerts on degradation.

**Auth monitoring:** Periodically verifies that the Claude Code session is valid by
running a minimal test command. If auth has expired, surfaces re-authentication request
immediately.

**Approval expiry:** Flags approvals approaching their deadline.

**Memory staleness:** Checks for memories past verification date or expiry.

How it runs: Triggered by a cron schedule (default: every 30 minutes) and by event-driven
triggers (e.g., Supabase trigger when queue depth exceeds threshold).

Escalation chain:
1. Log the anomaly as an event.
2. Warning: note in admin dashboard.
3. Error: Telegram notification.
4. Critical: freeze affected queue/agent, Telegram, blocking alert in admin panel.

Why Sonnet: Monitoring is pattern recognition and threshold analysis — important reasoning
but not frontier-level inference. Sonnet with high effort handles this well and costs less
per invocation than Opus. The sentinel runs periodically (every 30 minutes), so per-run cost
matters more here than for the sage (which runs rarely).

## The Self-Evolution Mechanism

The six foundational agents form a closed loop that can produce new agents without
redeployment.

A new agent is not new code. It is:
- A row in the `roles` table (name, policy document, model, effort, permissions).
- A row in the `agents` table (identity, role assignment).
- An `AGENTS_INSCTRUCTIONS.md` section (behavioral instructions, skill references).
- RLS policies (scope restrictions).
- Optionally: new MCP tool permissions, new schedules, new integration requirements.

All of this is data and configuration. The builder creates it. The Claude Code process
that runs "as" the new agent reads different context, policies, and memory — but it is
the same `claude` CLI binary launched by the same supervisor.

The system can go from "personal assistant" to "personal assistant + website manager +
customer support + content pipeline" without redeployment, without changing the admin app,
and without modifying the supervisor.

### Model and Effort for New Agents

When the architect designs a new agent, it assigns a model and effort level based on the
role's requirements. The defaults for new agents are Opus · High (matching the builder),
but the architect can specify Sonnet or Haiku for roles where speed matters more than
depth. The operator can override any agent's model/effort in the admin panel.

### What Cannot Self-Evolve (Requires Redeployment)

- New MCP tools (the tool contract itself, not permissions).
- Changes to the supervisor's core logic.
- Changes to the admin app's UI.
- New Supabase extensions or fundamental schema changes.
- New Docker services.

## The Task Lifecycle

State transitions are enforced by a database trigger — agents cannot invent states.

```
  Human message
       │
       ▼
     RELAY (classifies, routes)
       │
       ├─── simple ──────────────────────────┐
       │                                     │
       ├─── complex ──► SAGE (plans) ────────┤
       │                                     │
       ▼                                     ▼
  ┌──────────┐                         ┌──────────┐
  │ BACKLOG  │ ─── prioritized ──────► │  READY   │
  └──────────┘                         └────┬─────┘
                                            │
                                   supervisor claims
                                            │
                                       ┌────▼─────┐
                                       │ CLAIMED  │
                                       └────┬─────┘
                                            │
                                   claude CLI starts
                                            │
                                       ┌────▼─────┐
                                  ┌────┤ RUNNING  ├────┐
                                  │    └──────────┘    │
                                  │                    │
                           ┌──────▼──────┐    ┌───────▼────────┐
                           │  COMPLETED  │    │ BLOCKED_ON_    │
                           └──────┬──────┘    │ HUMAN / AGENT  │
                                  │           └───────┬────────┘
                              REVIEWER                │
                              checks             approval /
                                  │              unblock
                                  ▼                   │
                           approved / failed     back to RUNNING
                                  │
                                  ▼
                             ARCHITECT
                          sees patterns
```

Tasks in `dead_letter` surface in the admin dashboard for human intervention.

Every transition out of `running`, `blocked`, or `failed` requires a handoff note:
what was done, what changed, what is blocked, what to do next.

## The Memory System

Core rule: **structured data first, vector search second.**

### Five Layers

**Working memory** — Current context window. Ephemeral. Dies with the session.

**Episodic memory** — What happened. Every side effect creates an event; important events
become episodic memories.

**Semantic memory** — Distilled facts. Extracted from episodic memories by agents or by
async distillation.

**Procedural memory** — How to do things. Role policies, SOPs, checklists. Lives in the
database and in `AGENTS_INSCTRUCTIONS.md`.

**Artifact memory** — Files, PRs, docs, reports, invoices. Files in Supabase Storage or
git. The `artifacts` table is the searchable index.

### Memory Scope

Every memory has a scope: task, project, customer, role, department, or company. Retrieval
filters by scope chain — narrowest first:

1. Current task
2. Current project / customer
3. Agent's role
4. Company-wide

### Hybrid Search

Full-text search (exact terms) + vector search (semantic similarity), combined via
Reciprocal Rank Fusion, filtered by scope.

### When to Write Memory

**Immediately:** Task state changes, external side effects, human instructions, approval
decisions, durable facts, handoff notes, failure causes.

**Asynchronously:** Run summaries, embeddings, deduplication, contradiction detection,
freshness checks.

**Never:** Chain-of-thought, raw hypotheses, duplicate search results, scratch notes,
credentials, facts without sources.

### Memory Provenance

Every memory records: creator, source event, confidence (0.0–1.0), last verified, expiry.
Superseded memories are marked inactive and linked. Full traceability: memory → event →
task run → original instruction.

## Agent Authentication

The system uses the operator's Claude Max subscription via native Claude Code CLI. No
API key is required for core operation.

### Login Flow

1. Operator clicks "Connect Claude Code" in the admin panel.
2. The system runs `claude login` via the browser service.
3. The operator sees the Claude.ai login page and enters credentials.
4. Claude Code stores its session in its own config directory on the VPS.
5. The system verifies auth by running a minimal `claude -p "ping" --model haiku` test.
6. All subsequent agent processes use this authenticated `claude` binary.
7. The sentinel periodically verifies the session is still valid.

### What the System Never Does

- Extracts OAuth tokens from Claude Code's session storage.
- Passes subscription tokens to third-party APIs or SDKs.
- Uses the subscription token for anything other than launching the native `claude` CLI.

This is not a policy preference — it is a Terms of Service requirement. Violating it
risks account termination.

### API Keys for Non-Claude Services

The service registry in the admin panel holds API keys for external services: ElevenLabs
(TTS), OpenAI (embeddings, image generation), Stripe (payments), SendGrid (email), etc.
These are stored encrypted in Supabase, accessible only to the MCP server and Edge
Functions.

An optional Anthropic API key can also be added for per-token billing use cases
(embedding generation, lightweight classification tasks). This is completely separate
from the Claude Code subscription and is billed independently.

## Service Registry and API Key Management

The `service_registry` table tracks external services, credentials, and status.

When an agent needs an external capability:

1. Checks the registry via MCP server.
2. If valid credentials exist → proceed.
3. If credentials are missing → creates a `key_needed` task that surfaces in the admin
   panel: "I need an ElevenLabs API key to generate your morning audio briefing. You can
   get one at [URL]. Please paste it in the API Keys section."
4. The operator pastes the key. The agent resumes.

Keys are never exposed to agents. The MCP server and Edge Functions use them on the
agent's behalf.

## Browser Service

Headless Chromium via Vercel's agent-browser. Standard capability for all agents.

- **Authentication**: Claude Code login, external OAuth flows.
- **Research**: Documentation, reference sites, competitor pages.
- **Testing**: Verify deployments, check content and functionality.
- **Data extraction**: Scrape structured data from pages without APIs.
- **Interaction**: Fill forms, navigate multi-step flows.

Docker container. Idle when unused, sessions on demand.

## Security Model

### Agents Never Hold Privileged Keys

Supabase service key, API keys, and auth tokens are held only by the MCP server, Edge
Functions, and supervisor. Agents authenticate via scoped JWTs.

### Native CLI Only

The Claude Code subscription session lives in Claude Code's own config directory on the
VPS filesystem. The supervisor launches `claude` processes but never reads or extracts
the session token. This is the critical security and compliance boundary.

### Scope Enforcement

Every MCP tool call is validated against the agent's identity (agent_id, role_id, run_id).
Agents cannot access data outside their scope chain.

### System Modification Requires Architect Approval

Tasks modifying roles, agents, policies, or schema require architect approval. The builder
implements; it cannot self-approve.

### Container Isolation and --dangerously-skip-permissions

All Claude Code processes run with `--dangerously-skip-permissions` inside Docker
containers. This is the only way to achieve fully autonomous headless operation. The
flag is safe in this context because:

- Agents run inside the supervisor's Docker container, isolated from the host.
- Working directories are mounted as scoped Docker volumes.
- Agents cannot access the host filesystem, other containers, or system resources.
- The MCP server is the only path to the database and external services.

The supervisor prepares each agent's working directory before launch and mounts only
that directory into the process's scope. An agent building a website gets `/sites/public/`
mounted. An agent implementing a system change (with architect approval) gets the
relevant system directory. No agent gets access to the full repo, Supabase data
directory, or other containers' volumes.

### Secrets Flow

```
Coolify env vars (Postgres password, JWT secret)
    │
    ▼
Supervisor (launches claude CLI, manages process lifecycle)
    │
MCP Server + Edge Functions (hold service key + API keys)
    │
    ▼
Agents: see NOTHING. Call MCP tools that act on their behalf.

Claude Code session: lives in ~/.claude/ on VPS filesystem.
Only the claude binary reads it. No other process touches it.
```

## Deployment

### Prerequisites
- Hetzner VPS (size appropriate for workload)
- Domain with DNS pointed to VPS
- Coolify installed on VPS
- GitHub repo connected to Coolify

### Coolify Services

| Service         | Source dir          | Domain              | Notes                     |
|-----------------|---------------------|----------------------|---------------------------|
| Supabase        | `/supabase/`        | internal only        | Docker Compose, no Studio |
| Admin App       | `/apps/admin/`      | admin.domain.com     | SSL via Coolify           |
| Public Surface  | `/sites/public/`    | domain.com           | SSL via Coolify, optional |
| Supervisor      | `/apps/supervisor/` | internal only        | Long-running daemon       |
| MCP Server      | `/apps/mcp/`        | internal only        | Docker network only       |
| Browser Service | `/apps/browser/`    | internal only        | Headless Chromium         |

### Environment Variables (set in Coolify)

```

# Telegram (optional)
TELEGRAM_BOT_TOKEN=

# Admin/public domains are configured per service in Coolify's Domains UI.
# Remaining secrets and admin credentials are auto-generated on first boot.

# Agent auth is managed through admin panel → stored in Claude Code's
# own config directory on the VPS. Not an env var.
# API keys are stored encrypted in Supabase, managed through admin panel.
```

### First Boot Sequence

1. Push repo to GitHub. Coolify builds all services.
2. Supabase starts. Migrations create schema, seed six foundational roles and agents.
3. Supervisor starts. No tasks exist. Enters idle state.
4. Operator opens admin.domain.com and logs in.
5. Operator clicks "Connect Claude Code" → completes login via browser service.
6. System verifies auth with a test command.
7. Operator sends first message via chat.
8. Relay receives the message, classifies it, creates tasks.
9. Supervisor claims the first task, builds context, launches `claude` CLI.
10. The system is operational.

## What This System Does Not Do

- **Run models locally.** All inference is remote via Claude Code subscription.
- **Extract or proxy OAuth tokens.** All inference goes through the native `claude` CLI.
- **Impose artificial token limits.** Agents run until complete. Cost is monitored by the
  sentinel, not capped per task.
- **Replace human judgment.** High-stakes actions require explicit approval.
- **Manage its own infrastructure.** Coolify, VPS, DNS, and domains are the operator's
  responsibility.
- **Self-deploy new Docker services.** Infrastructure changes require a code push.
