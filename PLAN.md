# Build Plan Audit

Original completion checkboxes are preserved from the first implementation pass.
Audit markers were added on 2026-03-06 after code review, local builds, and Docker stack checks.
They were updated on 2026-03-07 after repair work, live task runs, direct RPC checks, and browser-driven admin verification.

Legend:
- `CHECKED: ok` = implemented and consistent with the repo.
- `CHECKED: partial` = implemented in part, but incomplete or inconsistent.
- `CHECKED: broken` = code exists, but the behavior is wrong enough to block the intended outcome.
- `CHECKED: missing` = not found or not actually completed.
- `TESTED: static` = reviewed in code only.
- `TESTED: build` = verified by local build commands.
- `TESTED: stack` = verified with `docker compose up -d --build` plus runtime/log inspection.
- `TESTED: none` = not directly executed or verifiable from the current repo state.

Commands used for this audit:
- `npm run build`
- `cd apps/browser && npm run build`
- `docker compose up -d --build`
- `docker compose ps -a`
- `docker compose logs`
- `agent-browser open|fill|click|snapshot|screenshot`
- direct PostgREST/RPC checks from inside the running containers

Phased build plan for agent-os. Check off tasks as completed. Do not reorder phases - each depends on the previous.

---

## Phase 1: Project Scaffolding & Infrastructure

Phase audit: partial. The scaffold exists and now builds/runs locally, but deployment-oriented env assumptions are still incomplete.

- [x] **1.1** Create directory structure: `/apps/supervisor/`, `/apps/mcp/`, `/apps/admin/`, `/apps/browser/`, `/supabase/`, `/sites/public/` `[CHECKED: ok] [TESTED: static]`
- [x] **1.2** Initialize root `package.json` (or workspace config) - decided on Node.js + npm workspaces `[CHECKED: partial] [TESTED: build]`
- [x] **1.3** Create root `docker-compose.yaml` defining all services (supabase, supervisor, mcp, admin, browser) with internal Docker network `[CHECKED: partial] [TESTED: stack]`
- [x] **1.4** Create `Dockerfile` for supervisor (includes Claude Code CLI binary, `skipDangerousModePermissionPrompt` in `~/.claude/settings.json`) `[CHECKED: ok] [TESTED: stack]`
- [x] **1.5** Create `Dockerfile` for MCP server `[CHECKED: ok] [TESTED: stack]`
- [x] **1.6** Create `Dockerfile` for admin app (React SPA build + static serve) `[CHECKED: ok] [TESTED: stack]`
- [x] **1.7** Create `Dockerfile` for browser service (headless Chromium via agent-browser) `[CHECKED: partial] [TESTED: stack]`
- [x] **1.8** Create `.env.example` with all required Coolify env vars (`POSTGRES_PASSWORD`, `JWT_SECRET`, `ADMIN_USER`, `ADMIN_PASS`, `ADMIN_DOMAIN`, `PUBLIC_DOMAIN`, `TELEGRAM_BOT_TOKEN`) `[CHECKED: partial] [TESTED: static]`
- [x] **1.9** Create `.gitignore` (node_modules, .env, dist, supabase data volumes) `[CHECKED: ok] [TESTED: static]`
- [x] **1.10** Add shared TypeScript config and common types (enums for task states, priorities, scopes, severities, memory layers) used across supervisor, MCP, and admin `[CHECKED: ok] [TESTED: build]`

---

## Phase 2: Database - Supabase & Schema

Phase audit: partial. The schema is mostly present, but service credential handling, RLS behavior, and final validation are incomplete.

### 2A: Supabase Docker Setup
- [x] **2A.1** Supabase services defined in root `docker-compose.yaml` (Postgres, GoTrue, Storage, Realtime, PostgREST - no Studio) `[CHECKED: ok] [TESTED: stack]`
- [x] **2A.2** Created `supabase/generate-keys.sh` for JWT-based anon/service key generation `[CHECKED: ok] [TESTED: static]`
- [x] **2A.3** Verify Supabase starts clean and Postgres is reachable on the Docker network `[CHECKED: partial] [TESTED: stack]`

### 2B: Schema Migrations
Create as ordered SQL migration files in `/supabase/migrations/`.

- [x] **2B.1** Migration 001 - Enable extensions: `pgcrypto`, `vector`, `pg_trgm` `[CHECKED: ok] [TESTED: static]`
- [x] **2B.2** Migration 002 - Create enum types `[CHECKED: ok] [TESTED: static]`
- [x] **2B.3** Migration 003 - Create `roles` table + seed 6 foundational roles `[CHECKED: ok] [TESTED: static]`
- [x] **2B.4** Migration 004 - Create `agents` table + seed 6 foundational agents `[CHECKED: ok] [TESTED: static]`
- [x] **2B.5** Migration 005 - Create `projects` table `[CHECKED: ok] [TESTED: static]`
- [x] **2B.6** Migration 006 - Create `tasks` table with all columns, indexes, and the `depends_on` uuid array `[CHECKED: ok] [TESTED: static]`
- [x] **2B.7** Migration 007 - Create `BEFORE UPDATE` trigger enforcing task state machine `[CHECKED: ok] [TESTED: static]`
- [x] **2B.8** Migration 008 - Create `task_runs` table `[CHECKED: ok] [TESTED: static]`
- [x] **2B.9** Migration 009 - Create `events` table (append-only) `[CHECKED: ok] [TESTED: static]`
- [x] **2B.10** Migration 010 - Create `memories` table `[CHECKED: ok] [TESTED: static]`
- [x] **2B.11** Migration 011 - Create `memory_chunks` table with FTS + vector `[CHECKED: ok] [TESTED: static]`
- [x] **2B.12** Migration 012 - Create `hybrid_memory_search()` function (RRF) `[CHECKED: ok] [TESTED: static]`
- [x] **2B.13** Migration 013 - Create `approvals` table `[CHECKED: ok] [TESTED: static]`
- [x] **2B.14** Migration 014 - Create `artifacts` table `[CHECKED: ok] [TESTED: static]`
- [x] **2B.15** Migration 015 - Create `handoffs` table `[CHECKED: ok] [TESTED: static]`
- [x] **2B.16** Migration 016 - Create `schedules` table + seed sentinel schedule `[CHECKED: ok] [TESTED: static]`
- [x] **2B.17** Migration 017 - Create `service_registry` table with pgcrypto encryption `[CHECKED: partial] [TESTED: static]`
- [x] **2B.18** Migration 018 - Create `messages` table with Realtime `[CHECKED: ok] [TESTED: static]`
- [x] **2B.19** Migration 019 - Create `build_context_pack()` function `[CHECKED: ok] [TESTED: static]`
- [x] **2B.20** Migration 020 - Row Level Security on all tables `[CHECKED: partial] [TESTED: static]`
- [x] **2B.21** Run all migrations against local Supabase, verify schema is correct with test queries `[CHECKED: partial] [TESTED: stack]`

---

## Phase 3: MCP Server

Phase audit: partial. Core task/memory/message tooling now works in the live stack, and scope/policy hardening is materially improved, but full coverage across every future action type is still incomplete.

- [x] **3.1** Initialize `/apps/mcp/` project (Node.js/TypeScript) `[CHECKED: ok] [TESTED: build]`
- [x] **3.2** Set up Supabase client using service key (bypasses RLS) - `src/db.ts` `[CHECKED: ok] [TESTED: stack]`
- [x] **3.3** Implement MCP server protocol (stdio transport) - `src/index.ts` `[CHECKED: ok] [TESTED: stack]`
- [x] **3.4** Implement identity validation via env vars (agent_id, role_id, run_id) - `src/context.ts` `[CHECKED: ok] [TESTED: static]`
- [x] **3.5** Implement scope enforcement layer: check scope chain (task -> project -> role -> company) for every data access `[CHECKED: partial] [TESTED: stack]`
- [x] **3.6** Implement tool: `task_claim` `[CHECKED: ok] [TESTED: static]`
- [x] **3.7** Implement tool: `task_update` `[CHECKED: ok] [TESTED: static]`
- [x] **3.8** Implement tool: `task_create` `[CHECKED: partial] [TESTED: static]`
- [x] **3.9** Implement tool: `memory_search` (FTS-only fallback, vector when embedding service available) `[CHECKED: partial] [TESTED: stack]`
- [x] **3.10** Implement tool: `memory_write` (with supersede + auto memory_chunk creation) `[CHECKED: partial] [TESTED: stack]`
- [x] **3.11** Implement tool: `event_log` `[CHECKED: partial] [TESTED: stack]`
- [x] **3.12** Implement tool: `artifact_put` `[CHECKED: partial] [TESTED: static]`
- [x] **3.13** Implement tool: `handoff_create` `[CHECKED: partial] [TESTED: static]`
- [x] **3.14** Implement tool: `approval_request` (blocks task on human) `[CHECKED: partial] [TESTED: static]`
- [x] **3.15** Implement tool: `context_refresh` `[CHECKED: partial] [TESTED: static]`
- [x] **3.16** Implement policy enforcement: check `roles.requires_approval_for` before allowing certain action types, auto-create approval if needed `[CHECKED: partial] [TESTED: stack]`
- [x] **3.17** Implement service registry lookup: when a tool needs an external service, check `service_registry` for active credentials. If missing, create `key_needed` row and return informative error `[CHECKED: partial] [TESTED: static]`
- [x] **3.18** Implement trace_id propagation via agent context `[CHECKED: ok] [TESTED: static]`
- [x] **3.19** Write MCP config JSON file (`apps/mcp/mcp-config.json`) `[CHECKED: ok] [TESTED: static]`
- [x] **3.20** Implement tool: `message_send` (admin chat outbound, Telegram-capable outbound) `[CHECKED: ok] [TESTED: stack]`
- [ ] **3.21** Test all 11 tools against live Supabase with mock agent identity `[CHECKED: partial] [TESTED: stack]`

---

## Phase 4: Supervisor Daemon

Phase audit: partial. The supervisor now drives real task runs end-to-end, and orphan recovery is verified, but some outcome bookkeeping still needs tightening.

- [x] **4.1** Initialize `/apps/supervisor/` project (Node.js/TypeScript) `[CHECKED: ok] [TESTED: build]`
- [x] **4.2** Set up Supabase client (service key) - `src/db.ts` `[CHECKED: ok] [TESTED: stack]`
- [x] **4.3** Implement task polling loop - `src/task-poller.ts` `[CHECKED: ok] [TESTED: stack]`
- [x] **4.4** Implement concurrency manager - `src/process-manager.ts` (activeProcesses Map, hasCapacity()) `[CHECKED: partial] [TESTED: static]`
- [x] **4.5** Implement context pack builder - calls `build_context_pack()`, writes TASK_BRIEFING.md `[CHECKED: partial] [TESTED: static]`
- [x] **4.6** Implement agent launcher - spawns `claude -p` with all flags `[CHECKED: ok] [TESTED: stack]`
- [x] **4.7** Implement stdout stream parser - collects stream-json output `[CHECKED: partial] [TESTED: static]`
- [x] **4.8** Implement outcome recorder - on exit, updates task_run + task state `[CHECKED: partial] [TESTED: stack]`
- [x] **4.9** Implement failure handler - marks failed, handles timeout via SIGTERM `[CHECKED: partial] [TESTED: stack]`
- [x] **4.10** Implement working directory manager - per-task workspace dirs `[CHECKED: ok] [TESTED: static]`
- [x] **4.11** Implement message router - `src/message-router.ts` (polls unprocessed messages, creates relay tasks) `[CHECKED: ok] [TESTED: static]`
- [x] **4.12** Implement schedule runner - `src/scheduler.ts` (cron eval, task creation from template) `[CHECKED: partial] [TESTED: static]`
- [x] **4.13** Implement startup recovery - `src/recovery.ts` (orphaned task detection) `[CHECKED: ok] [TESTED: stack]`
- [x] **4.14** Implement graceful shutdown - SIGTERM/SIGINT handlers with 30s timeout `[CHECKED: ok] [TESTED: static]`
- [x] **4.15** Implement health endpoint - HTTP /health on port 3001 `[CHECKED: ok] [TESTED: stack]`
- [ ] **4.16** Test full cycle: create a mock task in DB -> supervisor claims -> launches Claude Code -> process completes -> outcome recorded `[CHECKED: ok] [TESTED: stack]`

---

## Phase 5: Admin Panel

Phase audit: partial. The admin UI now works in the live stack for auth, chat, task inspection, and core navigation, but several planned operator views and the dedicated Claude connect flow are still missing.

### 5A: Foundation
- [x] **5A.1** Initialize `/apps/admin/` React project (Vite + React + TypeScript) `[CHECKED: ok] [TESTED: build]`
- [x] **5A.2** Set up admin runtime backend + API client - `server.mjs`, `src/lib/api.ts` `[CHECKED: ok] [TESTED: stack]`
- [x] **5A.3** Implement auth gate - `src/lib/auth.ts` (session-based, ADMIN_USER/ADMIN_PASS) `[CHECKED: ok] [TESTED: stack]`
- [x] **5A.4** Set up app layout - `src/pages/Dashboard.tsx` (sidebar nav, page router) `[CHECKED: ok] [TESTED: build]`

### 5B: Chat Interface
- [x] **5B.1** Build real-time chat UI - `src/pages/ChatPage.tsx` (polling-based operator chat) `[CHECKED: partial] [TESTED: stack]`
- [x] **5B.2** Implement message send (admin_chat, inbound, operator) `[CHECKED: ok] [TESTED: stack]`
- [x] **5B.3** Display outbound messages from relay/agents `[CHECKED: ok] [TESTED: stack]`
- [ ] **5B.4** Show task creation confirmations inline when relay routes a message `[CHECKED: missing] [TESTED: none]`

### 5C: Task Dashboard
- [x] **5C.1** Build task list view - `src/pages/TasksPage.tsx` (filter by state, expandable details) `[CHECKED: partial] [TESTED: stack]`
- [x] **5C.2** Build task detail view (inline expand: ID, priority, attempts, handoff note) `[CHECKED: partial] [TESTED: stack]`
- [x] **5C.3** Implement approval UI (pending approvals banner, approve/reject buttons) `[CHECKED: partial] [TESTED: stack]`
- [x] **5C.4** Implement dead letter queue view (state filter + retry button) `[CHECKED: partial] [TESTED: stack]`
- [ ] **5C.5** Implement task reassignment: manually change assigned_role or move back to ready `[CHECKED: missing] [TESTED: none]`

### 5D: Agent & System Views
- [x] **5D.1** Build agent status page - `src/pages/AgentsPage.tsx` (agents + roles table) `[CHECKED: partial] [TESTED: stack]`
- [x] **5D.2** Build memory browser - `src/pages/MemoryPage.tsx` (search, expand, expire) `[CHECKED: partial] [TESTED: stack]`
- [x] **5D.3** Build event log view - `src/pages/EventsPage.tsx` (chronological, filterable) `[CHECKED: partial] [TESTED: stack]`
- [ ] **5D.4** Build system health view: live sentinel data - process count, queue depth, recent alerts, service status `[CHECKED: missing] [TESTED: none]`

### 5E: Service Connections & Settings
- [ ] **5E.1** Build Claude Code auth flow: "Connect Claude Code" button -> trigger `claude login` via browser service -> show auth status `[CHECKED: missing] [TESTED: none]`
- [x] **5E.2** Build API key manager - `src/pages/SettingsPage.tsx` (service_registry, key_needed, paste-key) `[CHECKED: partial] [TESTED: stack]`
- [x] **5E.3** Build settings page (schedule management: enable/disable) `[CHECKED: partial] [TESTED: stack]`
- [ ] **5E.4** Build cost dashboard: token usage trends (from sentinel reports), cost by agent/role/period (if API key used) `[CHECKED: missing] [TESTED: none]`

---

## Phase 6: Browser Service

Phase audit: partial. The basic browser API exists, but the Claude login flow and end-to-end integration do not.

- [x] **6.1** Set up `/apps/browser/` with puppeteer-core + headless Chromium Docker container `[CHECKED: ok] [TESTED: build]`
- [x] **6.2** Implement session management - HTTP API: create, navigate, content, screenshot, close `[CHECKED: partial] [TESTED: build]`
- [ ] **6.3** Implement Claude Code login flow integration: expose endpoint that supervisor/admin can call to run `claude login` through the browser `[CHECKED: missing] [TESTED: none]`
- [x] **6.4** Expose browser capability as HTTP API for agents (navigate, get content, screenshot) `[CHECKED: partial] [TESTED: static]`
- [ ] **6.5** Test: complete a Claude Code login flow end-to-end, verify session persists on VPS filesystem `[CHECKED: missing] [TESTED: none]`

---

## Phase 7: Telegram Bot

Phase audit: partial. The webhook function exists, but webhook registration and round-trip validation are not done.

- [x] **7.1** Create Supabase Edge Function - `supabase/functions/telegram-webhook/index.ts` `[CHECKED: ok] [TESTED: static]`
- [x] **7.2** Parse incoming messages, insert into `messages` table (channel=telegram, direction=inbound, metadata with chat_id) `[CHECKED: ok] [TESTED: static]`
- [x] **7.3** Implement outbound via `sendTelegramMessage()` helper (Telegram Bot API) `[CHECKED: partial] [TESTED: static]`
- [ ] **7.4** Register webhook URL with Telegram Bot API (via `TELEGRAM_BOT_TOKEN`) `[CHECKED: missing] [TESTED: none]`
- [ ] **7.5** Test: send Telegram message -> appears as relay task -> response sent back to Telegram `[CHECKED: missing] [TESTED: none]`

---

## Phase 8: Async Processing

Phase audit: partial. The background loops exist, but the actual embedding/distillation behavior is incomplete and unverified.

- [x] **8.1** Implement embedding generation worker - `apps/supervisor/src/async-workers.ts` (OpenAI ada-002 via service_registry) `[CHECKED: partial] [TESTED: static]`
- [x] **8.2** Implement artifact chunk generator (text-based artifacts -> memory_chunks) `[CHECKED: partial] [TESTED: static]`
- [x] **8.3** Implement memory distillation job (ensure all memories have chunks, sentinel handles LLM distillation) `[CHECKED: partial] [TESTED: static]`
- [x] **8.4** Implemented as background loop in the supervisor (30s interval) `[CHECKED: ok] [TESTED: static]`
- [ ] **8.5** Test: write a memory -> verify chunk appears -> verify hybrid search returns it via both FTS and vector `[CHECKED: missing] [TESTED: none]`

---

## Phase 9: Integration Testing & First Boot

Phase audit: partial. The local stack now runs a real end-to-end operator loop, but some planned validation scenarios remain untested or unimplemented.

- [x] **9.1** Run full `docker-compose up` - all services start, Supabase runs migrations, schema is seeded `[CHECKED: partial] [TESTED: stack]`
- [x] **9.2** Verify supervisor starts in idle state (no tasks, no errors) `[CHECKED: partial] [TESTED: stack]`
- [ ] **9.3** Complete Claude Code authentication via admin panel -> browser service `[CHECKED: missing] [TESTED: none]`
- [ ] **9.4** Send first message via admin chat -> relay task created -> relay agent launched -> response received `[CHECKED: ok] [TESTED: stack]`
- [ ] **9.5** Test task lifecycle: create a simple builder task -> claimed -> running -> completed -> reviewed `[CHECKED: partial] [TESTED: stack]`
- [ ] **9.6** Test failure path: create a task that will fail -> verify attempt_count increments -> verify dead_letter after max_attempts `[CHECKED: missing] [TESTED: none]`
- [ ] **9.7** Test sentinel: verify sentinel schedule fires every 5 min, produces health report events `[CHECKED: ok] [TESTED: stack]`
- [ ] **9.8** Test approval flow: create task requiring approval -> verify blocks -> approve in admin -> task resumes `[CHECKED: missing] [TESTED: none]`
- [ ] **9.9** Test memory persistence: agent writes memory -> new session retrieves it via memory_search `[CHECKED: ok] [TESTED: stack]`
- [ ] **9.10** Test handoff: agent writes handoff note -> next agent receives it in context pack `[CHECKED: missing] [TESTED: none]`
- [ ] **9.11** Test concurrency: queue 6+ tasks with concurrency limit of 5 -> verify queuing behavior `[CHECKED: missing] [TESTED: none]`

---

## Phase 10: Deployment to Production

Phase audit: missing. Production deployment work is not represented as completed in the current repo state.

- [ ] **10.1** Provision Hetzner VPS, install Coolify `[CHECKED: missing] [TESTED: none]`
- [ ] **10.2** Point DNS: `admin.domain.com` and optionally `domain.com` to VPS `[CHECKED: missing] [TESTED: none]`
- [ ] **10.3** Connect GitHub repo to Coolify `[CHECKED: missing] [TESTED: none]`
- [ ] **10.4** Configure Coolify services matching the service table in ARCHITECTURE.md (source dirs, domains, internal-only flags) `[CHECKED: missing] [TESTED: none]`
- [ ] **10.5** Set all environment variables in Coolify `[CHECKED: missing] [TESTED: none]`
- [ ] **10.6** Deploy - verify first boot sequence (migrations run, services healthy, admin panel accessible) `[CHECKED: missing] [TESTED: none]`
- [ ] **10.7** Complete Claude Code auth on production `[CHECKED: missing] [TESTED: none]`
- [ ] **10.8** Send first production message, verify full round-trip `[CHECKED: missing] [TESTED: none]`
- [ ] **10.9** Verify sentinel is running and producing heartbeat events `[CHECKED: missing] [TESTED: none]`
- [ ] **10.10** Set up Supabase backups (operator responsibility, but provide a script/docs) `[CHECKED: missing] [TESTED: none]`

---

## Dependencies Between Phases

```text
Phase 1 (Scaffolding)
  --> Phase 2 (Database)
        --> Phase 3 (MCP Server)
              --> Phase 4 (Supervisor)
              |     --> Phase 9 (Integration)
              |           --> Phase 10 (Deploy)
              --> Phase 5 (Admin Panel) -------------------+
        --> Phase 8 (Async Processing) --------------------+
  --> Phase 6 (Browser Service) ---------------------------+
  --> Phase 7 (Telegram Bot) ------------------------------+
```

Phases 5, 6, 7, and 8 can be built in parallel once their prerequisites are met. Phase 5 needs Phase 2 (Supabase client). Phases 6 and 7 are independent of each other. Phase 9 requires all previous phases.
