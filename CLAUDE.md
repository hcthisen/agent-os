# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A self-hosted, persistent AI employee system deployed on a single Hetzner VPS via Coolify. AI agents (running as native Claude Code CLI processes) claim tasks from a queue, execute work, write handoff notes, and pass work to each other. The system can self-evolve by creating new agent roles without redeployment.

## Repository Structure

Monorepo with seven Coolify services:

| Directory | Service | Notes |
|---|---|---|
| `/supabase/` | Self-hosted Supabase | Postgres + Auth + Storage + Edge Functions. All durable state lives here. |
| `/apps/supervisor/` | Supervisor daemon | Process manager for Claude Code CLI. Claims tasks, builds context packs, launches agents. |
| `/apps/mcp/` | MCP server | 10-tool interface between agents and DB. Enforces scope/policy. Agents never access DB directly. |
| `/apps/admin/` | Admin panel | React SPA, OAuth-gated. Chat, task dashboard, memory browser, cost monitoring, service connections. |
| `/apps/browser/` | Browser service | Headless Chromium via agent-browser. Auth flows, research, testing. |
| `/sites/public/` | Public surface | Optional. Empty until operator instructs system to build something public. |
| Edge Function | Telegram bot | Webhook mode, inserts into same message queue as admin chat. |

## Six Foundational Agents

| Role | Model | Effort | Purpose |
|---|---|---|---|
| relay | Haiku | Medium | Classifies human messages, routes to correct agent. Speed-critical. |
| sage | Opus | High | Strategic planning. Produces plan docs, never executes. |
| builder | Opus | High | Executes tasks: code, content, integrations, agent configs. |
| reviewer | Opus | High | Quality gate. Approves, requests revision, or escalates. |
| architect | Opus | High | System evolution. Only agent that can approve system modifications. |
| sentinel | Sonnet | High | Monitors queue health, cost, auth, services. Runs every 5 min. |

New agents are created as data (rows in `roles`/`agents` tables + `AGENTS_INSCTRUCTIONS.md`
sections + RLS policies), not new code. Same `claude` binary, different context.

## Key Architecture Decisions

- **Native CLI only**: All inference via `claude` CLI binary. No token extraction, no API proxying. ToS requirement.
- **`--dangerously-skip-permissions`**: Mandatory for headless operation. Safe because agents run inside Docker containers with scoped volume mounts.
- **No token budgets**: Agents run to completion. Sentinel monitors spending patterns, operator sets expectations.
- **Task state machine enforced by DB trigger**: Not application code. Invalid transitions are rejected at the Postgres level.
- **Handoff notes mandatory**: DB trigger rejects state transitions from `running`/`blocked`/`failed` without a `last_handoff_note`.
- **Structured data first, vectors second**: Tables are truth. Vector search (pgvector + RRF hybrid search) is a recall aid built on top.
- **Self-hosted Supabase**: Included in monorepo. Migrations create schema and seed foundational roles on first boot.

## Database Schema

Defined in `SCHEMA.md`. Key tables: `roles`, `agents`, `projects`, `tasks` (strict state machine), `task_runs`, `events` (append-only), `memories`, `memory_chunks` (derived vector index), `approvals`, `artifacts`, `handoffs`, `schedules`, `service_registry`, `messages`.

Required Postgres extensions: `pgcrypto`, `vector` (pgvector), `pg_trgm`.

The `build_context_pack()` function assembles everything an agent needs before launch (task, project, role policy, last handoff, memories scoped by chain: task > project > role > company).

## MCP Tools (10 total)

`task_claim`, `task_update`, `task_create`, `memory_search`, `memory_write`, `event_log`, `artifact_put`, `handoff_create`, `approval_request`, `context_refresh`

## Protected Infrastructure

Do NOT modify without explicit architect approval:
- `/apps/supervisor/`, `/apps/mcp/`, `/apps/admin/`, `/apps/browser/`
- `/supabase/` (migrations and config)
- `AGENTS.md`, `AGENTS_INSCTRUCTIONS.md`, `docker-compose*.yaml`, `Dockerfile*`,
  `.env` files, `scripts/`

## Git Conventions

- **Branch naming**: `agent/{role_id}/{task_id_short}`
- **Commit messages**: Prefix with task ID: `[a1b2c3] Add Stripe webhook handler`
- **Never commit to `main` directly**. Push to branch; deployment pipeline handles the rest.
- Commit frequently in small logical units.

## Environment Variables (set in Coolify)

Coolify domains are configured in the platform's Domains UI per service, not through env vars. `TELEGRAM_BOT_TOKEN` is optional. `ADMIN_USER` and `ADMIN_PASS` are also optional: if unset, they are generated on first boot by the `init` service (`scripts/init-secrets.mjs`) and stored in the `config` Docker volume at `/config/.env.generated`; if set in Coolify, they override the generated values at runtime. The remaining bootstrap secrets (`POSTGRES_PASSWORD`, `JWT_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`) are auto-generated on first boot and stored in the same volume. Services source generated config via `scripts/entrypoint.sh`. Agent auth is managed through admin panel (Claude Code's own session). External API keys stored encrypted in `service_registry` table.

**Docker Compose file**: `docker-compose.yaml` (not `.yml` - Coolify convention).

## Task State Machine

```
backlog -> ready -> claimed -> running -> {blocked_on_human, blocked_on_agent, in_review, completed, failed}
blocked_* -> {running, ready, failed}
in_review -> {completed, running, failed}
failed -> {ready, dead_letter}
dead_letter -> ready (human override only)
completed -> (terminal)
```

## Build Plan

**PLAN.md is the persistent execution tracker for this project.** Before starting any work:
1. Read `PLAN.md` to find the current phase and next unchecked task.
2. Execute that task (and any parallel-safe tasks in the same phase).
3. After completing a task, update `PLAN.md` by checking off the box (`- [ ]` -> `- [x]`).
4. Do not skip ahead to a later phase while the current phase has unchecked tasks, unless the dependency graph explicitly allows parallelism.
5. When resuming work in a new session, always re-read `PLAN.md` first to pick up where the last session left off.

## Detailed Documentation

- `AGENTS.md` - Runtime bootstrap file copied into each agent workspace
- `AGENTS_INSCTRUCTIONS.md` - Agent behavioral instructions, role-specific workflows, rules, and the non-negotiable checklist
- `ARCHITECTURE.md` - Full system architecture, execution model, component details, memory system, security model, deployment
- `DECISIONS.md` - All architectural decisions with rationale and rejected alternatives (D-001 through D-023)
- `SCHEMA.md` - Complete data model, table definitions, indexes, RLS policies, hybrid search function, async processing
