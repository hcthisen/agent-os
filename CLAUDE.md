# CLAUDE.md

This file documents the repository for Claude Code, Codex CLI, and compatible
coding-agent runtimes. The filename remains `CLAUDE.md` for tool compatibility.

## What This Is

A self-hosted, persistent AI employee system deployed on a single VPS via Docker Compose
and Caddy. AI agents run as native coding CLI processes, claim tasks from a queue,
execute work, write handoff notes, and pass work to each other. The active runtime
provider can be Claude Code or OpenAI Codex; the supervisor resolves each agent's launch
settings for the selected provider.

## Repository Structure

Monorepo with seven containerized services:

| Directory | Service | Notes |
|---|---|---|
| `/supabase/` | Self-hosted Supabase | Postgres + Auth + Storage + Edge Functions. All durable state lives here. |
| `/apps/supervisor/` | Supervisor daemon | Process manager for the active coding provider CLI. Claims tasks, builds context packs, launches agents. |
| `/apps/mcp/` | MCP server | Managed tool interface between agents and DB/services. Enforces scope and policy. Agents never access DB directly. |
| `/apps/admin/` | Admin panel | React SPA, auth-gated. Chat, task dashboard, runtime-provider controls, memory browser, cost and health views. |
| `/apps/browser/` | Browser service | Headless Chromium via agent-browser. Auth flows, research, testing. |
| `/sites/public/` | Public surface | Optional. Empty until the operator instructs the system to build something public. |
| Edge Function | Telegram bot | Webhook mode, inserts into the same message queue as admin chat. |

## Runtime Providers and Role Defaults

The supervisor can launch either:

- `claude` using the operator's Claude Code subscription login
- `codex` using the operator's ChatGPT/Codex CLI login

The `roles.model` column still stores compatibility slugs today: `haiku`, `sonnet`,
and `opus`. In practice those mean base reasoning profiles:

- `haiku` = fast profile
- `sonnet` = balanced profile
- `opus` = frontier profile

At launch time the supervisor maps that base profile to the concrete provider model and
reasoning effort. Current defaults are:

| Role | Base profile | Default effort | Example Claude launch | Example Codex launch | Purpose |
|---|---|---|---|---|---|
| relay | Fast (`haiku`) | medium | `haiku` + `medium` | `gpt-5.4` + `low` | Classifies human messages and routes work quickly. |
| sage | Frontier (`opus`) | high | `opus` + `high` | `gpt-5.4` + `xhigh` | Strategic planning and decomposition. |
| builder | Frontier (`opus`) | high | `opus` + `high` | `gpt-5.4` + `high` | Executes code, content, and integration work. |
| reviewer | Frontier (`opus`) | high | `opus` + `high` | `gpt-5.4` + `high` | Quality gate for completed work. |
| architect | Frontier (`opus`) | high | `opus` + `high` | `gpt-5.4` + `high` | Governs system changes and evolution. |
| sentinel | Balanced (`sonnet`) | high | `sonnet` + `high` | `gpt-5.3-codex` + `medium` | Periodic watchdog for queue, auth, and service health. |

New agents are created as data in the `roles` and `agents` tables plus Supabase-backed
policy documents and permissions. They are not new binaries or new services.

## Key Architecture Decisions

- **Native provider CLI only**: all core inference runs through the selected vendor CLI
  (`claude` or `codex`), not through extracted session tokens.
- **No session/token extraction**: auth lives in provider-owned config directories such
  as `~/.claude` or `~/.codex`; the system never reads those secrets for API calls.
- **Headless bypass mode is required**: the supervisor uses the provider's autonomous
  execution mode so agents can run unattended inside Docker.
- **No token budgets**: agents run to completion; the sentinel monitors overall cost and
  rate-limit pressure instead of killing work mid-task.
- **Task state machine enforced by DB trigger**: invalid transitions are rejected at the
  Postgres level.
- **Handoff notes are mandatory**: runs leaving `running`, blocked, or failed states must
  leave a structured handoff.
- **Structured data first, vectors second**: tables are truth; vector search is a recall
  aid.
- **Self-hosted Supabase**: included in the monorepo and bootstrapped on first deploy.
- **Managed VPS deployment**: the stack runs on a VPS through Docker Compose + Caddy.
- **MCP-driven service control**: agents should use `service_control` for supported VPS
  service status, restart, and reload operations.
- **Agent Browser is the standard browser path**: when an agent needs a real browser, it
  should use the preinstalled `agent-browser` workflow instead of installing its own
  browser runtime.
- **Shared skills capture proven procedures**: recurring jobs, repeated requests, and
  hard-won multi-step workflows should become scoped shared skills, not just ad hoc notes.

## Database Schema

Defined in `SCHEMA.md`. Key tables: `roles`, `agents`, `projects`, `tasks` (strict state
machine), `task_runs`, `events` (append-only), `memories`, `memory_chunks` (derived
vector index), `artifacts`, `handoffs`, `schedules`, `service_registry`,
`messages`, and `system_settings`.

Required Postgres extensions: `pgcrypto`, `vector` (pgvector), `pg_trgm`.

The `build_context_pack()` function assembles everything an agent needs before launch:
task, project, role policy, agent identity, available roles, last handoff, scoped
memories, recent events, artifacts, and the role's base profile/effort.

## MCP Tools

Current tool surface:

`task_claim`, `task_update`, `task_create`, `memory_search`, `memory_write`,
`event_log`, `artifact_put`, `handoff_create`, `public_site_publish`,
`service_control`, `context_refresh`, `message_send`,
`schedule_update`, `schedule_create`, `role_upsert`, `agent_upsert`

## Protected Infrastructure

Only modify shared infrastructure when the assigned task scope requires it:

- `/apps/supervisor/`, `/apps/mcp/`, `/apps/admin/`, `/apps/browser/`
- `/supabase/` (migrations and config)
- `AGENTS.md`, `AGENTS_INSCTRUCTIONS.md`, `docker-compose*.yaml`, `Dockerfile*`,
  `.env` files, `scripts/`

## Git Conventions

- **Branch naming**: `agent/{role_id}/{task_id_short}`
- **Commit messages**: prefix with task ID, for example `[a1b2c3] Add Stripe webhook handler`
- **Never commit to `main` directly**. Use a branch for traceability. If deployment is
  in scope, deploy the managed VPS stack separately.
- Commit frequently in small logical units.

## Environment Variables

Direct VPS deployments use `.env.vps` plus `docker-compose.vps.yaml`. `ROOT_DOMAIN`,
`ADMIN_PUBLIC_URL`, and `PUBLIC_SITE_URL` define public routing. `TELEGRAM_BOT_TOKEN`
is optional. `ADMIN_USER` and `ADMIN_PASS` are optional overrides: if unset, they are
generated on first boot by the `init` service (`scripts/init-secrets.mjs`) and stored
in the `config` Docker volume at `/config/.env.generated`.

The remaining bootstrap secrets (`POSTGRES_PASSWORD`, `JWT_SECRET`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`) are auto-generated on first boot and stored
in the same volume. Services source generated config via `scripts/entrypoint.sh`.

Agent auth is managed through the admin panel for the active provider:

- Claude provider: `claude auth login`
- Codex provider: `codex login --device-auth` or equivalent persisted Codex login

External API keys are stored encrypted in `service_registry`.

**Compose files**: `docker-compose.yaml` plus `docker-compose.vps.yaml`.

## Task State Machine

``` 
backlog -> ready -> claimed -> running -> {blocked_on_agent, in_review, completed, failed}
blocked_on_agent -> {running, ready, failed}
in_review -> {completed, running, failed}
failed -> {ready, dead_letter}
dead_letter -> ready (human override only)
completed -> (terminal)
```

## Build Plan

**PLAN.md is the persistent execution tracker for this project.** Before starting work:

1. Read `PLAN.md` to find the current phase and next unchecked task.
2. Execute that task, plus any parallel-safe tasks in the same phase.
3. After completing a task, update `PLAN.md` by checking the box.
4. Do not skip ahead while the current phase still has unresolved dependencies.
5. When resuming a session, re-read `PLAN.md` first.

## Detailed Documentation

- `AGENTS.md` - Repository guidelines for Codex and human contributors
- `AGENTS_INSCTRUCTIONS.md` - Foundational agent rules, collaboration model, and the non-negotiable checklist
- `ARCHITECTURE.md` - Full system architecture, runtime-provider model, component details, memory system, security model, deployment
- `DECISIONS.md` - Architectural decisions with rationale and rejected alternatives
- `SCHEMA.md` - Complete data model, table definitions, indexes, RLS policies, hybrid search function, async processing
