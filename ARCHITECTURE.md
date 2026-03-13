# Architecture

## What This System Is

This is a self-hosted, persistent AI employee system. It runs on a single VPS, deploys
from a monorepo through Docker Compose with Caddy as the reverse proxy, and exposes one
mandatory interface: an admin panel for direct human-to-system communication.

The root domain is optional public surface area. The system can use it when it needs to
publish something customer-facing, but the system is not fundamentally a website builder.
It is a durable operating environment where AI agents hold persistent identities, claim
and execute work from a queue, remember what they learn across sessions, and hand work
to other agents or back to the operator.

The system starts with six foundational agents that can bootstrap into any configuration.
When it encounters a class of work it cannot handle well, it can design, build, and
activate new specialized agents without redeploying the runtime.

## Why This Shape

Two forces drive the architecture:

**The context window is not memory.** LLM context is finite, expensive, and ephemeral.
Durable state must live outside the model in a database that survives process exits.

**Agent sessions are disposable.** Any long-running autonomous session can stall, crash,
or veer off course. The correct design assumes each session can die at any point. Work,
state, and progress must be recoverable from the database alone.

Every run begins by reading a context pack from Supabase and ends by writing a handoff
note plus any relevant memories and events back to the database.

## Execution Model

All agents run as native coding CLI processes. The active runtime provider is selected by
the operator and stored in `system_settings.runtime_provider`.

Today the supervisor supports:

- Claude Code through the native `claude` CLI
- OpenAI Codex through the native `codex` CLI

### Native CLI, Not Session Extraction

The system never extracts provider session tokens from local auth storage and reuses them
for API calls. That is both a security rule and, for Claude subscriptions, a compliance
rule.

The supervisor is a process manager, not an auth proxy. It launches the vendor CLI as a
child process and lets that CLI use its own persisted login:

- Claude auth lives under `~/.claude`
- Codex auth lives under `~/.codex`

If programmatic API access is needed for something like embeddings or a non-agent
workflow, the operator must provide a separate vendor API key. Subscription logins and
API keys are separate credentials for separate purposes.

### How Agents Are Spawned

The supervisor launches the selected provider in autonomous headless mode. Example
launches:

```sh
claude -p "your task instructions" \
  --dangerously-skip-permissions \
  --model opus \
  --effort high \
  --mcp-config /path/to/mcp-config.json \
  --output-format stream-json

codex exec \
  --skip-git-repo-check \
  --dangerously-bypass-approvals-and-sandbox \
  --disable apps \
  --json \
  -m gpt-5.4 \
  -c model_reasoning_effort="high" \
  "your task instructions"
```

Headless bypass mode is required. Without it, the provider CLI stops for human approval
prompts and unattended operation becomes impossible.

The system keeps this safe by running the agents inside Docker with scoped volumes and a
restricted tool surface. The isolation boundary is the container plus the MCP allowlist,
not the provider CLI's interactive permission system.

The supervisor prepares provider-specific runtime state before launch:

- Claude: prewrites `~/.claude/settings.json` with
  `skipDangerousModePermissionPrompt: true`
- Codex: prepares an isolated `.provider-home/.codex/config.toml` inside the task
  workspace with apps disabled and the selected reasoning settings

### Base Profiles, Reasoning Effort, and Provider Mapping

The schema still stores compatibility slugs in `roles.model`: `haiku`, `sonnet`, and
`opus`. Treat those as provider-neutral base profiles:

- `haiku` = fast profile
- `sonnet` = balanced profile
- `opus` = frontier profile

`roles.effort` stores the default reasoning effort. The active runtime provider then
resolves that base profile into a concrete provider model and, when configured, a
provider-specific effort override.

Current defaults:

| Role | Base profile | Base effort | Example Claude launch | Example Codex launch | Why |
|------|--------------|-------------|-----------------------|----------------------|-----|
| Relay | Fast (`haiku`) | medium | `haiku` + `medium` | `gpt-5.4` + `low` | Routing is mostly classification and prioritization. |
| Sage | Frontier (`opus`) | high | `opus` + `high` | `gpt-5.4` + `xhigh` | Strategic planning quality matters more than speed. |
| Builder | Frontier (`opus`) | high | `opus` + `high` | `gpt-5.4` + `high` | Produces the system's output. Failure is expensive. |
| Reviewer | Frontier (`opus`) | high | `opus` + `high` | `gpt-5.4` + `high` | Must be at least as capable as the builder. |
| Architect | Frontier (`opus`) | high | `opus` + `high` | `gpt-5.4` + `high` | System-level mistakes cascade widely. |
| Sentinel | Balanced (`sonnet`) | high | `sonnet` + `high` | `gpt-5.3-codex` + `medium` | Monitoring needs strong reasoning, but not always frontier depth. |

These are examples, not a hard-coded vendor commitment. The role intent lives in the
base profile plus effort; the supplier-specific model lives in runtime settings.

### No Token Budgets

Agents do not have artificial token budgets. A provider-native CLI process runs until the
task completes or the agent decides it cannot proceed.

The sentinel monitors spending trends, queue delay, and rate-limit behavior. The system
does not kill productive work because it crossed an arbitrary token ceiling.

### Concurrency

The supervisor manages parallel agent processes. Default concurrency is 5 and can be
changed in the admin panel.

The system does not allow unbounded fan-out. The sentinel watches queue depth, task
creation rate, and service health. If something starts creating work faster than the VPS
can absorb it, the sentinel can freeze the queue and alert the operator.

## System Components

Seven major components run together on one VPS:

```text
┌───────────────────────────────────────────────────────────────────┐
│  VPS (Docker Compose + Caddy)                                    │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ admin.domain │  │  domain.com  │  │  Supabase              │  │
│  │  Admin App   │  │ Public Root  │  │  Postgres + Auth +     │  │
│  │              │  │ or generated │  │  Storage + Realtime    │  │
│  │              │  │ subdomains   │  │                        │  │
│  └──────┬───────┘  └──────▲───────┘  └──────────┬─────────────┘  │
│         │                 │                      │                │
│  ┌──────▼──────▼──────────┴────────┐  ┌─────────▼─────────────┐  │
│  │  Supervisor Daemon               │  │  MCP Server           │  │
│  │  process manager for native      │  │  database + policy +  │  │
│  │  coding CLI agents               │  │  service control      │  │
│  └──────────┬───────────────────────┘  └─────────┬─────────────┘  │
│             │                                     │                │
│  ┌──────────▼─────────────┐        ┌─────────────▼────────────┐  │
│  │  Agent CLI Processes   │        │  Browser Service         │  │
│  │  claude or codex       │        │  auth, research, QA      │  │
│  │  up to N parallel      │        │  via headless Chromium   │  │
│  └────────────────────────┘        └──────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────┐                                      │
│  │  Telegram Bot          │  webhook -> Supabase Edge Function   │
│  └────────────────────────┘                                      │
└───────────────────────────────────────────────────────────────────┘
```

### 1. Supabase

Supabase is the durable operating system. It holds tasks, agents, roles, memories,
events, approvals, artifacts, schedules, service registry entries, system settings, and
message history.

It also provides Auth, Storage, Realtime, and Edge Functions. The admin UI uses the anon
key. The supervisor and MCP server use the service key. Agents never receive the service
key directly.

### 2. Admin App

The admin app is the primary human interface. It is served at `admin.domain.com` behind
basic credentials set at install time.

The app provides:

- Chat with the system
- Task dashboard and approvals
- Agent and role configuration
- Runtime provider controls
- Memory and event inspection
- Service connection management
- Operational health views

#### Provider Authentication

The admin surface handles connection of the active coding provider:

- Claude provider: launch `claude login` via the browser service
- Codex provider: start `codex login --device-auth` or an equivalent persisted Codex CLI
  login flow

The system never extracts provider tokens. It only checks whether the native CLI can run
successfully after login.

#### Service Connections

The admin app also manages non-runtime credentials such as Stripe, SendGrid, OpenAI,
Anthropic, ElevenLabs, and similar API keys.

If an agent needs a missing service, it registers a `key_needed` request in
`service_registry`. The operator supplies the key in the admin app. Agents do not read
raw secrets directly.

### 3. Public Surface

The public root domain is optional. The system can run indefinitely with only the admin
panel.

For direct VPS deployments, the DNS assumption is fixed:

- an A record for `domain.com`
- a wildcard A record for `*.domain.com`

That allows the system to expose:

- `admin.domain.com` for the admin UI
- `domain.com` for the root public site
- generated public subdomains such as `ojiw8fwfw9.domain.com` when a service truly needs
  public ingress

Internal services such as Supabase stay internal unless a task explicitly requires public
exposure and has the appropriate approval.

The root public site is published into a shared volume and switched atomically between
release directories so updates do not take the domain offline mid-deploy.

### 4. Supervisor Daemon

The supervisor is a long-running Node.js process. It contains no AI logic. Its job is to
manage agent lifecycle and work scheduling.

Responsibilities:

1. Claim eligible tasks when a process slot is free.
2. Build the context pack for that task.
3. Render runtime docs into the workspace:
   - `AGENTS_INSCTRUCTIONS.md`
   - `ROLE_POLICY.md`
   - `ROLE_DIRECTORY.md`
   - `AGENT_IDENTITY.md`
   - `TASK_BRIEFING.md`
4. Resolve provider-specific launch settings.
5. Start the native CLI (`claude` or `codex`) with MCP configured.
6. Stream output for observability.
7. Record the run outcome and update the task.
8. Recover orphaned work after restarts.

Task eligibility is dependency-aware. A task can be created early with `depends_on`
prerequisites and remain queued until each dependency task is `completed`. This lets the
system execute multi-phase plans autonomously without manually waiting between steps.

### 5. MCP Server

The MCP server is the agent's only sanctioned control plane. Agents do not connect to the
database directly and should not manipulate the VPS stack with ad hoc shell commands when
a managed MCP action exists.

The MCP server:

- validates identity and scope
- enforces approval policy
- writes events and memories
- mediates access to service credentials
- publishes the public site
- exposes managed service status/restart/reload actions on the VPS

Current tools:

| Tool | Purpose |
|------|---------|
| `task_claim` | Claim the next ready task for your role |
| `task_update` | Update task state and handoff details |
| `task_create` | Create sub-tasks or delegated work, including dependency-aware follow-up tasks |
| `memory_search` | Scoped hybrid memory retrieval |
| `memory_write` | Write semantic or episodic memory |
| `event_log` | Record a side effect or operational event |
| `artifact_put` | Register a file, report, PR, or other artifact |
| `handoff_create` | Explicitly hand work to another role or agent |
| `public_site_publish` | Publish a new atomic release of the public site |
| `public_site_route` | Create, remove, or verify public hostname routing |
| `public_site_verify` | Verify public URLs and record route evidence |
| `approval_request` | Ask the operator for a high-stakes approval |
| `observability_snapshot` | Read queue, auth, service, approval, and usage health for sentinel checks |
| `service_control` | Check, restart, or reload allowlisted VPS services |
| `service_require` | Require a configured third-party service before implementation proceeds |
| `context_refresh` | Rebuild the current context pack mid-run |
| `message_send` | Send an operator-facing message |
| `schedule_update` | Modify an existing recurring schedule |
| `schedule_create` | Create a new recurring schedule |
| `role_upsert` | Create or update a role definition |
| `agent_upsert` | Create or update a persistent agent identity |

`service_control` is intentionally narrow. It is designed for supported Compose-managed
services such as `supervisor`, `mcp`, `caddy`, `public`, and the internal Supabase
services. It is not a blank check for arbitrary host operations.

### 6. Browser Service

Headless browser automation via `agent-browser`. This is a standard capability, not a
special-case tool reserved for one role. Visual QA tasks should use the preinstalled
browser workflow rather than trying to install Chromium or Playwright inside a task
workspace.

Use cases:

- provider login flows
- third-party OAuth flows
- research and documentation review
- QA and deployment verification
- scraping structured web data when no API exists

### 7. Telegram Bot

Telegram uses webhook mode through a Supabase Edge Function. Messages land in the same
queue the admin chat uses, so the relay handles them the same way.

## The Six Foundational Agents

The system starts with six roles because a self-improving, self-monitoring work system
needs six capabilities:

1. Understand the operator
2. Think strategically
3. Build
4. Review
5. Evolve itself
6. Watch its own health

| Role | Base profile | Reasoning | Example Claude | Example Codex | Responsibility |
|------|--------------|-----------|----------------|---------------|----------------|
| Relay | Fast (`haiku`) | medium | `haiku` | `gpt-5.4` | Front door. Classifies requests, routes work, keeps the conversation coherent. |
| Sage | Frontier (`opus`) | high | `opus` | `gpt-5.4` | Planning and decomposition. Advises, does not execute. |
| Builder | Frontier (`opus`) | high | `opus` | `gpt-5.4` | Executes code, content, integrations, and implementation work. |
| Reviewer | Frontier (`opus`) | high | `opus` | `gpt-5.4` | Validates output against acceptance criteria and catches regressions. |
| Architect | Frontier (`opus`) | high | `opus` | `gpt-5.4` | Governs system changes and long-term evolution. |
| Sentinel | Balanced (`sonnet`) | high | `sonnet` | `gpt-5.3-codex` | Periodic watchdog for queue, auth, cost, and service health. |

### Relay

The relay receives every human message first. It decides whether the input is:

- a new task
- a question answerable from memory
- a modification to an existing task
- a system-level request
- ordinary conversation

Why the fast profile: the relay is in the critical path of every interaction. It needs
good judgment, but more often than not it is classifying and routing rather than doing
deep synthesis.

### Sage

The sage plans but does not implement. It is used when the system needs high-quality
decomposition, tradeoff analysis, or strategic advice.

Why the frontier profile: a weak plan makes every downstream execution step weaker. The
sage runs less often than the builder, so quality dominates speed.

### Builder

The builder is the workhorse. It writes code, content, integrations, scripts, and system
configuration changes that have already been approved.

Why the frontier profile: the builder creates the thing that eventually ships. A failed
build costs more than extra model usage.

### Reviewer

The reviewer validates completed work. It checks correctness, completeness, security,
policy compliance, and whether the output actually satisfies the task.

Why the frontier profile: the reviewer must be at least as capable as the builder or it
will miss the builder's mistakes.

### Architect

The architect is the only role that approves system modifications. It decides whether the
system should add a new role, change a policy, alter routing, or evolve part of its own
configuration.

Why the frontier profile: system-level errors have long half-lives. Bad architectural
judgment contaminates future sessions, not just the current task.

### Sentinel

The sentinel monitors:

- queue depth and throughput
- launchable queue versus dependency-waiting backlog
- stuck tasks
- provider auth validity
- service health
- approval backlog
- memory freshness
- cost and rate-limit trends

Why the balanced profile: monitoring needs solid reasoning, but not every check warrants
frontier depth. The sentinel also runs often, so recurring cost and latency matter more.

## The Self-Evolution Mechanism

New agents are not new binaries and not new containers. A new agent is:

- a row in `roles`
- a row in `agents`
- Supabase-backed policy content
- optional RLS and schedule changes
- optional tool permission changes

The builder creates those artifacts under architect approval. The supervisor then sees
the new role automatically in future context packs and can launch it through the same
native provider CLI runtime.

What still requires redeployment:

- new MCP tools
- supervisor logic changes
- admin UI changes
- new Docker services
- fundamental schema or extension changes

## Task Lifecycle

Task states are enforced by a database trigger. Agents cannot invent new states.

```text
Human message
     |
     v
  Relay classifies and routes
     |
     +-- simple work ----------------------+
     |                                     |
     +-- complex work -> Sage plans -------+
     |                                     |
     v                                     v
 backlog -> ready -> claimed -> running -> in_review -> completed
                             |        |
                             |        +-> blocked_on_human / blocked_on_agent
                             |
                             +-> failed -> dead_letter
```

Every transition out of `running`, blocked, or failed requires a handoff note.

### Dependency-Aware Task Graphs

The queue supports DAG-style execution through `tasks.depends_on`.

Typical pattern:

1. Sage creates an implementation task.
2. Sage creates desktop and mobile review tasks that both depend on the implementation
   task.
3. Sage, builder, or reviewer creates a follow-up remediation or re-planning task that
   depends on both reviews.

Those follow-up tasks can be created immediately. They remain in `ready`, but the
supervisor and `task_claim` only treat them as launchable after every dependency is
completed. Dependency-waiting tasks are not treated as stale queue failures.

## Memory System

Core rule: structured data first, vector search second.

Five layers matter:

- working memory: the current context window
- episodic memory: what happened
- semantic memory: distilled facts
- procedural memory: how to do things
- artifact memory: files, PRs, reports, and similar outputs

Memory retrieval follows scope order:

1. current task
2. current project or customer
3. current role
4. company-wide context

Hybrid search combines full-text search with vector similarity through Reciprocal Rank
Fusion. Tables are still the source of truth. Embeddings are a retrieval aid.

## Agent Authentication

Core operation uses the operator's subscription login with the active provider CLI. No
provider API key is required for the core agent loop.

### Login Flow

**Claude provider**

1. Operator selects Claude as the active runtime provider.
2. The system launches `claude login` through the browser service.
3. Claude stores its own session under `~/.claude`.
4. The system verifies the login by running a minimal `claude` command.

**Codex provider**

1. Operator selects OpenAI Codex as the active runtime provider.
2. The admin panel starts `codex login --device-auth` or an equivalent persisted Codex
   login flow.
3. Codex stores auth under `~/.codex`.
4. The system verifies the login by running a minimal `codex` command.

The sentinel periodically re-checks auth validity and alerts the operator when the active
provider session expires.

### What the System Never Does

- read provider auth files in order to extract reusable secrets
- proxy subscription logins through third-party APIs
- treat a CLI session as an API key

### API Keys for Non-Agent Work

The service registry can store provider API keys for tasks that genuinely require direct
API billing, such as embeddings or non-agent integrations. Those keys are separate from
the subscription runtime used by the agents.

## Service Registry and API Key Management

The `service_registry` table tracks external services, credentials, and status.

When an agent needs an external capability:

1. it checks the registry through MCP
2. if valid credentials exist, the MCP server uses them on the agent's behalf
3. if credentials are missing, the agent creates a `key_needed` request with context
4. the operator adds the key in the admin app
5. the task resumes

Agents do not receive decrypted secrets directly.

For credentialed third-party work, the intended execution path is:

1. plan first when the work is non-trivial
2. call `service_require`
3. if the service is missing or inactive, stop and request operator configuration
4. only implement after the service is active

Shipping a placeholder integration without the required service is considered incorrect.

## Security Model

### Agents Never Hold Privileged Keys

Supabase service keys, provider API keys, and third-party credentials are held by the
MCP server, Edge Functions, or tightly scoped admin paths. Agents call tools that act on
their behalf.

### Native Provider CLI Only

The supervisor launches `claude` or `codex`. It does not turn provider session state into
SDK tokens or share those credentials with arbitrary code.

### Scope Enforcement

Every MCP call is validated against `agent_id`, `role_id`, and `run_id`. Agents only see
data inside their scope chain unless the system explicitly hands them work that broadens
that scope.

### System Modification Requires Architect Approval

Roles, agents, policy rules, core infrastructure, and similar system-level changes must
go through architect-approved tasks.

### Container Isolation Plus Managed Control Paths

Agent autonomy depends on container isolation and allowlisted tool paths:

- agents run inside Docker, not on the bare host
- workspaces are scoped
- the database is reached through MCP, not raw credentials
- service restarts and reloads should go through `service_control` when supported
- high-impact host operations still require approval

## Deployment

### Prerequisites

- a VPS sized for the expected workload
- Docker Engine with Compose
- a root domain pointed at the VPS with:
  - an A record for the root domain
  - a wildcard A record for `*.domain.com`

### Domain Policy

The deployment assumes:

- `admin.domain.com` is reserved for the admin app
- `domain.com` is the public root site
- generated public services can use random subdomains under the wildcard
- Supabase and control-plane services stay internal by default

Caddy obtains and renews certificates for the hosts it serves.

### VPS Services

| Service | Exposure | Notes |
|---------|----------|-------|
| Supabase (`db`, `auth`, `rest`, `realtime`, `storage`) | internal | self-hosted durable state |
| Admin app | `admin.domain.com` | operator-facing control plane |
| Public surface | `domain.com` and approved subdomains | customer-facing output |
| Supervisor | internal | agent lifecycle manager |
| MCP server | internal | control plane and policy gate |
| Browser service | internal | auth and QA browser automation |
| Caddy | `80/443` | TLS and routing |

### First Boot Sequence

1. Run `bash scripts/install-vps.sh` on the VPS.
2. Enter the admin username, admin password, and root domain when prompted.
3. The installer writes `.env.vps`, prepares `/srv/agent-os`, and starts the stack with
   `docker compose`.
4. Supabase starts and migrations seed the foundational data.
5. Caddy obtains certificates for `admin.domain.com` and `domain.com`.
6. The operator opens `admin.domain.com` and signs in.
7. The operator connects the active coding provider.
8. The system verifies provider auth and the sentinel begins health checks.
9. The first message enters the queue and the relay starts the work loop.

## What This System Does Not Do

- run local foundation models on the VPS
- extract or proxy provider subscription tokens
- expose Supabase publicly by default
- give agents unrestricted host control
- let agents create arbitrary new infrastructure without approval
- impose fake per-task token caps that break useful work
