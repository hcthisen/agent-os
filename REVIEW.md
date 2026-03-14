# Agent-OS System Review

## Purpose of This Review

This document is a comprehensive analysis of Agent-OS with one goal: **turn this system
into a deployable autonomous digital employee with persistent memory and the capabilities
to act.** Every section evaluates what exists, what is missing, and what must change to
reach that goal.

The benchmark is a system where an operator deploys a digital employee, trains it on what
it should do and how, and then the employee operates autonomously with human oversight
only when needed.

---

## Executive Summary

Agent-OS is a strong foundation. The core loop works: messages arrive, the relay
classifies them, the sage plans, the builder executes, the reviewer validates, the
architect governs, and the sentinel monitors. The task state machine is
database-enforced. Memory persists across sessions. Handoffs are mandatory. The system
can self-evolve by creating new roles and agents as data.

**What works well:**
- Task state machine with DB-enforced transitions
- Context pack assembly gives agents everything they need at launch
- Multi-provider support (Claude Code + OpenAI Codex) with per-role model mapping
- Hybrid memory search (FTS + vector with RRF fusion)
- Structured MCP tool surface with scoped reads/writes and managed execution policy
- Dependency-aware task graphs (DAG execution)
- Operator notification pipeline (admin chat + Telegram)
- Atomic public site deployments with Caddy routing
- Live VPS observation: 225+ memories, 2500+ events, 6 active agents, real work being executed

**What is missing or broken (critical gaps):**

1. **No first-class shared skill system** - procedural memory exists, but there is no typed shared skill abstraction, versioning, discovery flow, or admin UX
2. **Agent instructions not visible/editable in admin** - role policies live in Supabase but the admin panel has no UI to read or edit them
3. **No way to add/remove services from admin** - the current UI only supports credential entry for `key_needed` services
4. **No explicit training mechanism** - there is no structured "teach the employee" workflow that reliably turns operator guidance into reusable knowledge or procedure
5. **No artifact browser** - artifacts are stored but invisible in the admin UI
6. **No task creation from admin** - operators can only chat, not directly create tasks
7. **No cost/usage dashboard** - backend usage aggregates exist, but there is no operator UI and no true run-level cost attribution
8. **No project management UI** - projects table exists but admin has no project page
9. **No workspace cleanup** - 221 workspace directories accumulating on the VPS (900KB listing)
10. **Runtime trust boundary is softer than it appears** - agent subprocesses inherit the supervisor environment and run with provider-side sandbox bypass flags
11. **Most active admin surfaces use polling rather than live subscriptions** - chat and tasks refresh frequently, other views are mostly on-demand

---

## Part 1: The Digital Employee Vision Gap Analysis

### What "Digital Employee" Means

A digital employee must:

1. **Understand instructions** - receive natural language directives and convert them to action
2. **Remember everything** - facts, preferences, procedures, history across all sessions
3. **Learn skills** - be taught how to do something once, then do it autonomously forever
4. **Act on the world** - send emails, call APIs, deploy code, manage services
5. **Work autonomously** - pick up tasks, execute them, hand off when blocked
6. **Report back** - notify the operator of completions, problems, and decisions needed
7. **Self-improve** - get better at tasks over time by refining its own procedures
8. **Be controllable** - the operator can see what it is doing, stop it, redirect it, train it

### Current State vs Target

| Capability | Current State | Target State | Gap |
|---|---|---|---|
| Understand instructions | Relay classifies and routes. Works. | Same | Minimal |
| Remember everything | Episodic + semantic memory with hybrid search. 225 active memories. A procedural layer also exists, but it is not productized as a reusable skill system. | Same + first-class procedural skills | Need skill system |
| Learn skills | `procedural` memory can already be written and searched, but there is no first-class skill model, shared discovery, versioning, or admin UI | Agents create, find, edit, and reuse shared skills | **Critical gap** |
| Act on the world | MCP tools for tasks, memory, events, messages, public site, service control | Need: email, calendar, file management, webhook triggers | Medium gap |
| Work autonomously | Task poller + dependency DAG + scheduler. Works. | Same + scheduled learning/improvement | Minimal |
| Report back | Admin chat + Telegram. Works. Completion notifications work. | Same + richer status updates | Small gap |
| Self-improve | Architect can create roles/agents as data | Need skill refinement loop | Medium gap |
| Be controllable | Admin panel with 6 tabs. Basic. | Need full CRUD for everything | **Large gap** |

---

## Part 2: Service-by-Service Analysis

### 2.1 Supervisor Daemon (`apps/supervisor/`)

**What it does:** Process manager for the coding CLI. Claims tasks, builds context packs,
launches agents, monitors heartbeats, handles exits, manages schedules.

**Files (16 source files):**

| File | Purpose | Status |
|---|---|---|
| `index.ts` | Main entry, HTTP server, polling loops | Working |
| `config.ts` | Environment variable parsing | Working |
| `task-poller.ts` | Claims tasks, checks deps, launches agents | Working |
| `process-manager.ts` | Spawns CLI, monitors output, handles exits (1102 lines, largest) | Working |
| `runtime-provider.ts` | Resolves Claude/Codex model+effort per role | Working |
| `async-workers.ts` | Embeddings, memory distillation, artifact chunking (735 lines) | Working |
| `task-attention.ts` | Stale task detection, operator notifications (531 lines) | Working |
| `task-outcomes.ts` | Completion notifications to operator | Working |
| `task-dependencies.ts` | DAG dependency checking | Working |
| `message-router.ts` | Routes unprocessed inbound messages to relay | Working |
| `recovery.ts` | Orphan task recovery after restart | Working |
| `control-plane.ts` | Public route + service management via Docker (527 lines) | Working |
| `provider-auth.ts` | OpenAI device auth flow | Working |
| `scheduler.ts` | Cron-based task creation | Working |
| `operator-delivery.ts` | Message delivery to admin chat + Telegram | Working |
| `db.ts` | Database client singleton | Working |

**Strengths:**
- Robust process lifecycle management with inactivity detection (30 min timeout)
- Context pack includes everything: task, project, role policy, memories, events, artifacts, dependencies, child tasks, requirements
- Recovery on restart (orphaned tasks returned to ready)
- Provider-agnostic: same role definitions work across Claude and Codex
- Async embedding generation with OpenAI API (batches of 10)
- Memory distillation: episodic memories with operator_preference/decision tags auto-elevate to semantic

**Issues found:**

| Issue | Severity | Detail |
|---|---|---|
| No workspace cleanup | Medium | 221 workspace dirs on live VPS. No cleanup after task completion. Will fill disk. |
| No task dependency cycle detection | Low | Circular depends_on would cause infinite waiting |
| Scheduler has no lock or catch-up semantics | Medium | Multiple supervisor instances could double-fire schedules, and missed intervals are not backfilled. |
| Runtime isolation is soft | High | Provider CLIs inherit the supervisor environment and run with sandbox bypass flags. MCP is a workflow surface, not a hard security boundary. |
| Embedding retry strategy is simplistic | Low | Transient failures retry on the 30s worker cadence; 401/403 moves the embedding service to `error` and notifies the operator, but there is no true backoff/jitter strategy. |
| No per-run cost attribution | Medium | `observability_snapshot` already aggregates `provider.usage`, but those events are not linked to `task_runs`, so accurate per-task cost is missing. |
| Inactivity timeout only, no max-duration timeout | Low | A chatty agent that produces output can run forever |
| Template workspace copy is expensive | Low | Copies entire monorepo minus node_modules for each task run |

**Recommendations:**

1. **Add workspace cleanup**: Delete workspace dirs for completed tasks after N hours (configurable). Keep last N for debugging.
2. **Scrub the child process environment and tighten runtime permissions**: Do not pass the full supervisor env into provider subprocesses. Remove sandbox bypass where possible.
3. **Add max-duration timeout**: Configurable per-role. Default 60 minutes. Kills process after that regardless of activity.
4. **Use the existing usage aggregates in the admin UI, then add task/run attribution**: The aggregate data already exists; accurate per-task cost needs explicit linkage to `task_runs`.
5. **Lazy workspace seeding**: Instead of copying the full monorepo, use symlinks or a read-only shared mount for static files, only copy writable dirs.
6. **Add schedule locking and catch-up semantics**: Prevent duplicate fires across replicas and decide how missed intervals should be handled.

---

### 2.2 MCP Server (`apps/mcp/`)

**What it does:** The agent's primary structured control plane. 20 tools for tasks,
memory, events, artifacts, handoffs, public site, service management,
schedules, and role/agent CRUD.

**Tools (21 total):**

| Tool | Purpose | Quality |
|---|---|---|
| `task_claim` | Claim next ready task for role | Solid. Respects dependencies and concurrency limits. |
| `task_update` | Transition task state | Solid. DB trigger validates. |
| `task_create` | Create task with dependencies | Solid. Deduplication, scope enforcement. |
| `memory_search` | Hybrid FTS + vector search | Solid. Scoped retrieval with RRF fusion. |
| `memory_write` | Write episodic/semantic/procedural memory | Solid. Supersession support. |
| `event_log` | Append-only audit trail | Solid. |
| `artifact_put` | Register work products | Partial. No auto-chunking for search. |
| `handoff_create` | Transfer work between agents | Partial. Does not auto-update task state. |
| `public_site_publish` | Atomic site deployment | Solid. Release management with symlink swap. |
| `public_site_route` | Caddy subdomain management | Solid. Supervisor delegation + verification. |
| `public_site_verify` | HTTP endpoint verification | Solid. Records task requirements. |
| `observability_snapshot` | System health check | Solid. Comprehensive data for sentinel. |
| `service_control` | Docker service restart/reload | Solid. Allowlisted services only. |
| `service_require` | Declare external service dependency | Solid. Creates key_needed entry. |
| `context_refresh` | Re-fetch context pack mid-run | Solid. |
| `message_send` | Send to admin chat or Telegram | Solid. Cross-channel delivery. |
| `schedule_create` | Create cron schedule | Solid. |
| `schedule_update` | Modify schedule | Solid. |
| `role_upsert` | Create/update role | Solid. System role protection. |
| `agent_upsert` | Create/update agent | Solid. |

**Scope enforcement:**
- Agent identity context is loaded once from `AGENT_ID`, `ROLE_ID`, and `RUN_ID` when the MCP session starts
- Task scope: agent must have claimed the task
- Project scope: agent must have active task in project
- Role scope: must match agent's role
- Company scope: always allowed
- Some tools intentionally operate outside claimed-task scope (`task_claim`, `observability_snapshot`, read-only status actions)

**Policy enforcement:**
- `system.modify` actions are routed through role/task scope and system task ownership
- Pattern matching: `*`, `system.*`, exact match
- Execution proceeds autonomously once the work is in scope

**Issues found:**

| Issue | Severity | Detail |
|---|---|---|
| No first-class `skill_*` tools | **Critical** | Agents can already write/search generic procedural memories, but there is no typed skill abstraction, shared discovery flow, usage tracking, or admin UX. |
| `artifact_put` does not auto-index for search | Medium | Artifacts are registered but not chunked unless async worker picks them up. Memory search may miss them. |
| `department` and `customer` scope types not implemented | Low | `enforceScope` throws "not yet implemented" for these. |
| No `service_create` tool | Medium | Agents can only call `service_require` which creates with `key_needed`. No way for agents to register a service they already have credentials for. |
| No `project_create` / `project_update` tools | Medium | Projects exist in schema but can only be created via direct DB or task_create's project_id field. |
| No file read/write tools beyond public site | Low | Agents rely on the provider CLI's native file tools. No MCP tool to read/write arbitrary files in the workspace. |
| Memory search has no "list all" mode | Low | Must provide a query. Cannot browse all memories in a scope. |

**Recommendations:**

1. **Add skill system tools**: `skill_create`, `skill_search`, `skill_get`, `skill_log_use` - see Part 4 for the corrected design.
2. **Add project management tools**: `project_create`, `project_update` so agents can organize work.
3. **Add `service_upsert` tool**: Let agents register services with credentials they've obtained (encrypted through MCP, not raw).
4. **Auto-chunk artifacts**: When `artifact_put` receives text content, immediately create memory_chunks (don't wait for async worker).
5. **Implement customer/department scopes**: These are needed for multi-tenant or team-organized work.

---

### 2.3 Admin Panel (`apps/admin/`)

**What it does:** React SPA with 6 tabs. The operator's only interface to the system.

**Technology:** React 19, Vite, TypeScript. All inline CSS. No component library. No
router (conditional rendering in Dashboard). Polling-based updates.

**Tab-by-tab analysis:**

#### Chat Tab
- **Works:** Real-time-ish (2s polling) bidirectional messaging. Scroll history with lazy loading. Message merging prevents duplicates.
- **Missing:**
  - No markdown rendering - agent responses with code blocks or lists show as plain text
  - No message status indicators (sent, processing, completed)
  - No typing indicator or "agent is working" status
  - No file/image attachment support
  - No message threading - flat list only
  - No way to see which task a message triggered
  - Cannot reference a specific task or memory in a message

#### Tasks Tab
- **Works:** State filter buttons. Expandable task detail. Dead letter retry. Pagination.
- **Missing:**
  - **No task creation UI** - operators must chat and hope the relay creates the right task
  - No task editing (can't change title, priority, assigned_role after creation)
  - No task graph visualization - can't see parent/child/dependency relationships
  - No task detail page - just an expandable inline section
  - No task search or text filter
  - No bulk actions (bulk retry, bulk cancel)
  - No "cancel task" action - can only retry dead letters
  - No way to reassign a task to a different role
  - No due date visualization
  - Cannot see task_runs (execution history) for a task
  - Cannot see which agent ran a task or how long it took

#### Agents Tab
- **Works:** Runtime provider selection (Anthropic/OpenAI). Per-role model+effort configuration. OpenAI device auth flow. Provider status (CLI installed, auth detected). Agent cards with status.
- **Missing:**
  - **No way to edit role policies** - the `policy_doc` field is the agent's "soul" but it's invisible in the UI
  - **No way to edit agent instructions** - `AGENTS_INSCTRUCTIONS.md` content is not visible or editable
  - No way to create new roles from the admin panel
  - No way to create new agents from the admin panel
  - No way to pause/disable/enable individual agents
  - No agent activity timeline (what has this agent done recently?)
  - No role policy preview - can't see what instructions a role gives its agents
  - Cannot see `usage_summary`, `handoff_when`, `description` for roles
  - Cannot edit `max_concurrent_tasks` per role

#### Memory Tab
- **Works:** Subject search. Expandable detail. Memory expiration. Layer color coding. Pagination.
- **Missing:**
  - No scope filtering (can't filter by task/project/role/company)
  - No layer filtering (can't show only semantic or only episodic)
  - No memory creation from admin - operator cannot manually teach the system a fact
  - No memory editing - can only expire, not correct
  - **No procedural memory / skills view** - even if skills existed, there's no UI to browse them
  - No memory graph showing supersession chains
  - No memory verification status
  - No tag filtering
  - No confidence filtering

#### Events Tab
- **Works:** Event stream with severity color coding. Client-side text filter. Pagination.
- **Missing:**
  - No server-side filtering by event_type or severity
  - No date range filtering
  - No event detail expansion (the `detail` JSON is not shown)
  - No agent-specific event filtering
  - No task-specific event filtering
  - No event aggregation / summary view
  - No real-time streaming (polling only)

#### Settings Tab
- **Works:** Service connections list with status indicators. Key input for `key_needed` services. Schedule list with cron editor and enable/disable toggle.
- **Missing:**
  - **No "Add Service" button** - cannot create new service entries from admin
  - **No "Remove Service" button** - cannot delete obsolete services
  - **No service editing** - cannot change display_name, description, or base_url after creation
  - **No credential rotation** - cannot update an active service's key (only paste for key_needed)
  - No credential testing/validation before saving
  - No schedule creation from admin - can only modify existing schedules
  - No schedule deletion
  - No system settings editor (runtime_provider is configurable via Agents tab, but other settings are not accessible)
  - No system health dashboard (exists as API endpoint `/api/system/health` but no UI)

**Overall Admin Panel Assessment:**

The admin panel is functional for basic monitoring but is **read-heavy and write-poor**.
An operator can observe the system but cannot effectively control or configure it without
chatting with the relay agent and hoping it creates the right configuration.

For a "digital employee" product, the admin panel needs to feel like an **employee
management dashboard**, not a developer debugging tool.

---

### 2.4 Shared Package (`packages/shared/`)

**What it does:** TypeScript types, enums, and Postgrest client factory shared across all
services.

**Files:**
- `types.ts` - 14 interfaces (Role, Agent, Task, Memory, etc.) + ContextPack
- `enums.ts` - 11 enum types
- `postgrest.ts` - Client factory
- `index.ts` - Barrel export

**Assessment:** Clean and complete. Types match the database schema. The ContextPack
interface is well-designed.

**One gap:** No `Skill` type exists. This will need to be added.

---

### 2.5 Browser Service (`apps/browser/`)

**What it does:** Headless Chromium via Puppeteer. HTTP API for session management,
navigation, screenshots, content extraction.

**Endpoints:**
- `POST /session/create` - Launch browser session
- `POST /session/navigate` - Navigate to URL
- `GET /session/content` - Get page content as text
- `GET /session/screenshot` - Take screenshot
- `POST /session/close` - Close session
- `GET /health` - Health check

**Assessment:** Minimal but functional. Used for provider login flows and QA.

**Missing:**
- No form filling / interaction API (click, type, select)
- No cookie/session persistence across restarts
- No proxy support
- No JavaScript execution API
- No PDF generation

---

### 2.6 Database (`supabase/`)

**What it does:** 28 migration files creating 20 tables, enums, triggers, functions, RLS
policies, and seed data.

**Key tables:** roles, agents, projects, tasks, task_runs, events, memories,
memory_chunks, artifacts, handoffs, schedules, service_registry, messages,
system_settings, task_requirements, public_site_routes.

**Critical functions:**
- `enforce_task_state_machine()` - BEFORE UPDATE trigger preventing invalid transitions
- `build_context_pack()` - Assembles everything an agent needs to start work
- `hybrid_memory_search()` - RRF fusion of FTS + vector similarity
- `latest_task_activity()` - For observability queries

**Assessment:** The schema is well-designed. The task state machine trigger is the right
pattern - enforcing invariants at the database level rather than trusting application
code.

**Live state observed on VPS:**
- 6 roles (all system roles)
- 6 agents (one per role, all active)
- 225 memories (98 episodic, 127 semantic, 0 procedural)
- 2,527 events (1,446 provider.usage, 705 task.heartbeat, 76 message.sent)
- 243 memory_chunks (227 with embeddings, 16 artifact chunks currently without embeddings)
- 2 services (openai: active, shortpixel: active)
- 2 schedules (sentinel-health-check: enabled, hourly-cat-joke: disabled)
- 1 public site route (ferslev.dploy.cc: removed)
- Active provider: OpenAI with gpt-5.4

**Issues:**
- 0 procedural memories observed on the VPS - the capability exists, but there is no product/UI flow that causes skills to be created and reused
- Artifact indexing is asynchronous - artifact chunks can remain unembedded until the next embedding pass or until the embedding service is unhealthy
- No first-class skill abstraction (`Skill` type, `skill_*` tools, admin surface) - this is the real missing layer, not raw procedural storage
- `encrypt_credential()` / `decrypt_credential()` use PGP functions but credentials on the live VPS appear stored as plaintext (the admin server patches `credential` directly)

---

### 2.7 Deployment Infrastructure

**Docker Compose:** 11 services (init, db, auth, rest, realtime, storage, public,
supervisor, mcp, admin, browser) + caddy + autoheal in VPS overlay.

**Live VPS state:**
- 4 CPU cores, 7.6 GB RAM, 75 GB disk (40% used)
- All services healthy
- Caddy handling TLS for `admin.dploy.cc` and `dploy.cc`
- Autoheal monitoring container health

**Issues:**
- 221 workspace directories consuming disk (no cleanup)
- MCP has `profiles: ["manual"]` - it runs as a stdio child of the agent process, not as a standalone service. This is correct by design but means MCP logs are mixed into agent output.

---

## Part 3: Feature-by-Feature Gap Analysis

### 3.1 Shared Skill System (CRITICAL - No First-Class Skill System Yet)

**What is needed:**

A skill is a reusable, named procedure that any agent or operator can create, find,
review, and reuse. Skills are the training mechanism for the digital employee. When the
operator says "here's how to handle invoice reminders," the system should store that as a
shared procedure and surface it whenever relevant.

**Why it matters:**

Without skills, every agent starts from scratch. The relay might learn how to classify a
certain kind of request, but that knowledge dies when the session ends. Semantic memories
capture facts ("Stripe webhook endpoint is X") but not procedures ("When a customer asks
for an invoice, do steps A, B, C, D").

Important correction: Agent-OS already has a `procedural` memory layer, and the MCP
server can already write and search it. What is missing is a first-class product on top of
that capability:
- typed `Skill` objects in shared code
- consistent structure for steps, inputs, outputs, and required services
- shared discovery APIs (`skill_*`)
- versioning and usage tracking
- admin UI for browse/edit/create
- context-pack integration so relevant procedures appear at launch

**Recommended direction:**

1. **MVP:** Implement skills as a structured abstraction backed by procedural memory.
2. **Shared API:** Add `skill_create`, `skill_search`, `skill_get`, and `skill_log_use`.
3. **Admin surface:** Add a Skills area (new tab or a Memory sub-view) for operators.
4. **Context pack:** Include `relevant_skills` alongside memories and artifacts.
5. **Only add a dedicated `skills` table if needed:** If procedural-memory-backed skills are
   too awkward for versioning and analytics, then introduce a dedicated table. Do not
   ship two parallel procedural stores unless one is clearly authoritative.

---

### 3.2 Agent Instructions in Admin Panel (CRITICAL - Not Visible)

**Current state:**

Each role has a `policy_doc` field in the `roles` table. This is the agent's "soul" - it
defines what the agent does, how it behaves, what rules it follows. These policies are
loaded into `ROLE_POLICY.md` at launch.

The live VPS has detailed policy documents for all 6 roles (seeded in migration 024 and
updated in 027/028). These contain hundreds of lines of instructions per role.

**The problem:**

The admin API already returns full role rows via `GET /api/roles`, but the Agents tab
narrows the displayed data to model/effort/max_tasks and provider settings. The missing
piece is primarily frontend surface area, plus write/detail/activity endpoints.

The UI still **never displays or allows editing of:**
- `policy_doc` (the agent's operating instructions)
- `description` (what the role does)
- `usage_summary` (when to use this role)
- `handoff_when` (when to delegate to this role)

This means the operator cannot:
- See what instructions their agents are following
- Modify agent behavior without direct database access
- Fine-tune how the relay classifies messages
- Adjust the builder's coding standards
- Change the reviewer's acceptance criteria
- Customize the sentinel's monitoring thresholds

**What is needed:**

1. **Role detail page** in admin with:
   - Read/edit `policy_doc` with markdown preview
   - Edit `description`, `usage_summary`, `handoff_when`
   - Edit `model`, `effort`, `max_concurrent_tasks`
   - View all agents assigned to this role
   - View recent tasks executed by this role
   - "Test" button that creates a sample task for the role

2. **Agent detail page** with:
   - Status toggle (active/paused/disabled)
   - Config overrides editor (JSON)
   - Activity timeline (recent task_runs)
   - Memory written by this agent
   - Events logged by this agent

3. **Backend work (use existing reads first, then add writes/activity):**
- Reuse the existing `GET /api/roles` and `GET /api/agents` payloads in the UI before adding new read APIs
- Add `PATCH /api/roles/:id` - Update role fields including `policy_doc`
- Add `POST /api/roles` - Create new role
- Add `PATCH /api/agents/:id` - Update agent status/config
- Add `GET /api/agents/:id/activity` - Get agent's recent task_runs and events

4. **AGENTS_INSCTRUCTIONS.md editor:**
   The foundational instructions file (`AGENTS_INSCTRUCTIONS.md`) is baked into the
   supervisor Docker image. For the MVP, store an override in `system_settings` that the
   supervisor checks before falling back to the file. This lets the operator customize
   foundational rules without rebuilding the image.

---

### 3.3 Service Connections CRUD (HIGH - Partially Working)

**Current state:**

The Settings tab shows services registered by agents via `service_require`. The current UI
only exposes credential entry for services in `key_needed` status. There is already a
backend credential endpoint, but the page does not surface key rotation for active
services or metadata editing.

**What is missing:**

| Action | Current | Needed |
|---|---|---|
| View services | Yes | Yes |
| Paste key for key_needed | Yes | Yes |
| **Add new service** | No | Yes - operator should be able to pre-register services before agents need them |
| **Update existing key** | Partial - backend yes, UI no | Yes - for credential rotation |
| **Update service metadata** | No | Yes - edit display_name, description, base_url |
| **Delete service** | No | Yes - remove obsolete entries |
| **Test credential** | No | Yes - validate key works before saving |
| **View usage** | No | Nice-to-have - see which agents used this service |

**What is needed:**

1. **"Add Service" form** in Settings with fields: service_name (slug), display_name, description, base_url, auth_type (api_key/bearer/oauth), credential (password input)
2. **Edit button** on each service card that opens an edit form for all fields
3. **"Update Key" button** for active services (not just key_needed) using the existing credential endpoint
4. **"Delete Service" button** with confirmation
5. **"Test Connection" button** that makes a lightweight API call to verify the credential works (e.g., list models for OpenAI, verify key for Stripe)

**New backend API endpoints:**
- `POST /api/services` - Create new service
- `PATCH /api/services/:id` - Update service metadata
- `DELETE /api/services/:id` - Delete service
- `POST /api/services/:id/test` - Test credential validity

---

### 3.4 Operator Training Flow (HIGH - Does Not Exist)

**What is needed:**

A structured way for the operator to "train" the digital employee. Today, training
happens implicitly through chat messages that the relay may or may not store as memories.
There is no guarantee that "I told you last week to always CC john@company.com on
invoices" will be remembered.

**Proposed approach:**

1. **Explicit "Teach" mode in chat.** When the operator prefixes a message with a trigger
   (e.g., "Remember:" or "Always:" or "When X, do Y:"), the relay should:
   - Create a semantic memory with high confidence
   - Scope it appropriately (company-wide, project-specific, role-specific)
   - If it describes a procedure, create a skill
   - Confirm back to the operator what was stored

2. **"Knowledge Base" tab in admin.** A dedicated section (could be a sub-tab of Memory)
   where the operator can:
   - Browse all semantic memories tagged as operator-taught
   - Create new knowledge entries manually (subject, content, scope, tags)
   - Edit existing entries
   - Delete entries
   - See which skills reference this knowledge
   - Import knowledge from a document (paste text, system extracts facts)

3. **Skill builder in admin.** A form-based skill creator:
   - Name and description
   - When to trigger (natural language pattern)
   - Steps (ordered list of instructions)
   - Required services (link to service_registry)
   - Expected inputs and outputs
   - Test run button

**Why the relay routing guidance matters:**

Migration 027 already contains relay routing guidance:
> "If the message states a stable operator preference or constraint, record it as durable
> memory."

But this is a soft instruction, not a hard guarantee. The relay may forget to store the
preference. The skill/knowledge system makes it explicit and verifiable.

---

### 3.5 Cost and Usage Dashboard (MEDIUM - Data Exists, No UI)

**Current state:**

The VPS has 1,446 `provider.usage` events. The `observability_snapshot` MCP tool
aggregates usage data. But there is no UI for the operator to see costs.

**What is needed:**

1. **Cost summary card** on a new Dashboard home page (or within Settings):
   - Total runs today / this week / this month
   - Estimated cost (if token data available)
   - Runs per role breakdown
   - Average run duration per role

2. **Usage timeline chart** (optional but valuable):
   - Runs over time (hourly/daily)
   - Cost over time
   - Queue depth over time

3. **Per-task cost** (future enhancement):
   - Show in task detail: model used, effort, duration, and estimated tokens/cost once usage events are linked to task runs

**Data source:** The `task_runs` table has `model_used`, `effort_used`, `started_at`,
`finished_at` for every run. The events table has `provider.usage` entries and
`observability_snapshot` already aggregates them. That is enough for a high-level
dashboard today, but accurate per-task cost still requires explicit trace/run linkage.

---

### 3.6 Project Management (MEDIUM - Schema Exists, No UI)

**Current state:**

The `projects` table exists with slug, display_name, description, repo_url, metadata.
Tasks can reference `project_id`. But the admin panel has no project UI.

**What is needed:**

1. **Projects tab** in admin sidebar (or as a filter in Tasks):
   - List all projects
   - Create new project
   - Edit project metadata
   - Archive/unarchive
   - View tasks for a project
   - View memories scoped to a project
   - View artifacts for a project

2. **Project filter** in Tasks tab - filter tasks by project.

3. **MCP tools:** `project_create`, `project_update` so agents can organize work.

---

### 3.7 Artifact Browser (MEDIUM - Data Exists, No UI)

**Current state:**

Artifacts are registered via `artifact_put` and stored in the database. The live VPS has
artifacts (16 artifact chunks exist). But the admin panel has no way to view them.

**What is needed:**

1. **Artifacts section** (either its own tab or within Tasks):
   - List artifacts with type, name, task, created_at
   - Filter by type (file, pr, doc, report, screenshot)
   - Filter by project
   - View artifact detail: metadata, storage_path, external_url
   - Link to external URL if present
   - Download from Supabase Storage if stored locally
   - Preview for text/image artifacts

---

### 3.8 Real-Time Updates (LOW-MEDIUM - High-Traffic Views Use Polling)

**Current state:**

The high-traffic parts of the admin panel use polling:
- Chat: 2-second interval
- Tasks: 5-second interval
- OpenAI device-auth flow: 2-second interval while active
- Other tabs: mostly on-demand/manual refresh

Supabase Realtime is configured (`messages` table has Realtime publication) but the admin
panel doesn't use it.

**What is needed:**

1. Use Supabase Realtime subscriptions for:
   - Messages (new messages appear instantly)
   - Tasks (state changes reflect immediately)

2. Or use Server-Sent Events from the admin server for simpler implementation.

3. Add a "live activity" indicator showing:
   - Which agents are currently running
   - What task each active agent is working on
   - Last heartbeat timestamp

---

## Part 4: Detailed Skill System Design

This remains the most important missing feature, but the implementation path needs one
important correction: Agent-OS already has procedural memory storage and retrieval. The
goal is to turn that capability into a first-class shared skill product, not blindly create
a second procedural knowledge store on day one.

### 4.1 Data Model

**Preferred MVP:** implement skills as a typed abstraction backed by `memories` rows with
`layer = 'procedural'`.

- `subject`: stable skill name / slug
- `content`: canonical markdown or JSON representation of the procedure
- `tags`: include `skill` plus domain/trigger tags
- `scope_type` / `scope_id`: reuse the existing scope model
- `superseded_by`: use the existing memory supersession chain for version history

Add a `Skill` type in `packages/shared` so the rest of the system stops treating these as
generic memories.

**Only introduce a dedicated `skills` table later if needed.** A separate table may become
worth it for richer analytics, stricter validation, or cleaner versioning, but it should be
the authoritative store if introduced. Do not split procedural knowledge across two equal
stores.

### 4.2 Skill Structure

Whether backed by procedural memories or a future `skills` table, each skill should expose
the same structured shape:

```json
{
  "name": "send-invoice-reminder",
  "display_name": "Send Invoice Reminder",
  "description": "When to use this skill and what outcome it produces",
  "trigger_when": "Customer asks for an overdue invoice reminder",
  "required_services": ["stripe", "mailgun"],
  "input_schema": {},
  "output_schema": {},
  "steps": [
    {
      "order": 1,
      "instruction": "Check the required service slots and block if credentials are missing.",
      "tool_hint": "service_require",
      "required": true
    },
    {
      "order": 2,
      "instruction": "Retrieve the billing contact and invoice status from memory and artifacts.",
      "tool_hint": "memory_search",
      "required": true
    },
    {
      "order": 3,
      "instruction": "Generate and send the reminder, then record the outcome.",
      "tool_hint": "message_send",
      "required": true
    }
  ]
}
```

### 4.3 MCP Tools

**`skill_create`:**
- Create or update a skill abstraction
- MVP can persist the canonical representation into procedural memory
- Should create/update searchable chunks and enforce scope rules

**`skill_search`:**
- Search skills by name, description, trigger_when, tags, and scope chain
- MVP can reuse procedural-memory-backed search plus tag conventions

**`skill_get`:**
- Return the full structured skill definition by ID or name

**`skill_log_use`:**
- Record usage, outcome, and last-used metadata
- MVP can start as event logging if a dedicated usage table does not yet exist

### 4.4 Context Pack Integration

Add `relevant_skills` to the context pack and write it into `TASK_BRIEFING.md`.

Retrieval order should mirror the existing scope chain:
1. Task-specific
2. Project-specific
3. Role-specific
4. Company-wide

The relay should also query skills when a message looks like:
- a procedural question ("How do we usually do X?")
- an operator training instruction ("When X happens, do Y")
- a repeatable business workflow request

### 4.5 Admin UI

Add a Skills surface as either:
- a new **Skills** tab, or
- a dedicated **Skills** sub-view under Memory

Minimum operator capabilities:
1. Browse skills by scope, tag, and active/inactive status
2. View the full structured procedure
3. Create and edit skills manually
4. See version history / supersession chain
5. See recent usage and outcomes
6. Import a skill draft from chat or pasted text

---

## Part 5: Admin Panel Redesign Priorities

### Priority 1 (Must-Have for Digital Employee)

| Feature | Section | Effort |
|---|---|---|
| Role policy editor (view + edit policy_doc) | Agents tab | Medium |
| Service CRUD (add, update, delete, rotate keys) | Settings tab | Medium |
| Skill browser and editor | New Skills tab | Large |
| Memory creation from admin | Memory tab | Small |
| Task creation from admin | Tasks tab | Small |
| Agent status toggle (active/paused/disabled) | Agents tab | Small |

### Priority 2 (Important for Usability)

| Feature | Section | Effort |
|---|---|---|
| Markdown rendering in chat | Chat tab | Small |
| Task detail page with full history | Tasks tab | Medium |
| Artifact browser | New section or Tasks sub-view | Medium |
| Cost/usage summary | New Dashboard or Settings | Medium |
| Project management | New Projects tab or Tasks filter | Medium |
| Role creation from admin | Agents tab | Small |
| Schedule creation from admin | Settings tab | Small |

### Priority 3 (Nice-to-Have)

| Feature | Section | Effort |
|---|---|---|
| Real-time updates via Supabase Realtime | All tabs | Medium |
| Task graph visualization | Tasks tab | Large |
| Skill import from chat | Skills tab | Medium |
| Memory graph (supersession chains) | Memory tab | Medium |
| Agent activity timeline | Agents tab | Medium |
| Workspace management (cleanup, view) | Settings tab | Small |
| System health dashboard | New Dashboard | Medium |
| Export/download for memories, events, tasks | All tabs | Small |

---

## Part 6: Backend API Gaps

The admin server (`server.mjs`) needs these new endpoints:

### Role Management
```
GET    /api/roles/:id                -> Full role detail including policy_doc
PATCH  /api/roles/:id                -> Update role fields (policy_doc, model, effort, etc.)
POST   /api/roles                    -> Create new role
DELETE /api/roles/:id                -> Soft-delete non-system role
```

### Agent Management
```
PATCH  /api/agents/:id               -> Update status, config
GET    /api/agents/:id/activity      -> Recent task_runs and events
POST   /api/agents                   -> Create new agent
```

### Service CRUD
```
POST   /api/services                 -> Create new service entry
PATCH  /api/services/:id             -> Update metadata + credential
DELETE /api/services/:id             -> Remove service
POST   /api/services/:id/test        -> Validate credential
```

### Task Management
```
POST   /api/tasks                    -> Create task from admin
PATCH  /api/tasks/:id                -> Edit task metadata
POST   /api/tasks/:id/cancel         -> Cancel running task
GET    /api/tasks/:id/runs           -> Get task_runs for task
GET    /api/tasks/:id/full           -> Full detail with events, memories, artifacts
```

### Skills
```
GET    /api/skills                   -> List skills (with filters)
GET    /api/skills/:id               -> Full skill detail
POST   /api/skills                   -> Create skill
PATCH  /api/skills/:id               -> Update skill
DELETE /api/skills/:id               -> Soft-delete skill
```

### Memory
```
POST   /api/memories                 -> Create memory from admin
PATCH  /api/memories/:id             -> Edit memory content
```

### Projects
```
GET    /api/projects                 -> List projects
POST   /api/projects                 -> Create project
PATCH  /api/projects/:id             -> Update project
```

### Artifacts
```
GET    /api/artifacts                -> List artifacts (with filters)
GET    /api/artifacts/:id            -> Artifact detail
```

---

## Part 7: Operational Issues Found on Live VPS

### 7.1 Workspace Accumulation
**221 workspace directories** under `/app/workspaces/`. Each is a near-complete copy of
the monorepo. At ~10-50 MB each, this could be 2-10 GB of dead workspace data.

**Fix:** Add a cleanup routine to the supervisor that deletes workspaces for completed
tasks older than N hours (default 24). Keep the last 5 for debugging. Run on a 1-hour
schedule.

### 7.2 Artifact Chunks Missing Embeddings
The async worker creates artifact chunks and they can remain `embedding = NULL` until the
next embedding pass or while the embedding service is unhealthy. Important correction: the
current embedding worker scans all `memory_chunks` with null embeddings, so artifact
chunks are already eligible for processing.

**Fix:** Investigate worker cadence, backlog, and embedding-service health on the VPS
instead of changing source-type filtering.

### 7.3 Interrupted Task Runs
Two task_runs show `status = interrupted` from supervisor recovery. The tasks were
returned to `ready` and re-launched. This is correct behavior but the operator has no
visibility into why.

**Fix:** Show interrupted runs in the task detail view.

### 7.4 Active Provider: OpenAI
The system is running on OpenAI (gpt-5.4) for all roles. The sentinel uses
gpt-5.3-codex. This means the `model` column values (haiku/sonnet/opus) are being
mapped to OpenAI models correctly.

### 7.5 Credential Storage
The `service_registry.credential` column appears to store credentials in plaintext on the
live VPS, despite `encrypt_credential()` and `decrypt_credential()` PGP functions existing
in the migration. The admin server writes credentials directly via PostgREST without
calling the encryption function.

**Fix:** Either:
1. Use a DB trigger to auto-encrypt on INSERT/UPDATE, or
2. Have the admin server call the encryption function before writing, or
3. Use application-level encryption in the admin server

### 7.6 Notification Spam Potential
The task-attention system sends operator notifications for stale tasks. Multiple relay
tasks are completing just to process these attention notifications. This creates a
feedback loop where attention notifications about stuck tasks generate more relay tasks.

**Fix:** Add a cooldown per task for attention notifications (e.g., max 1 notification
per task per hour). The deduplication using `notification_key` helps but the key changes
on each `updated_at` change.

---

## Part 8: Security Observations

| Item | Status | Notes |
|---|---|---|
| Provider auth handling | Mixed | Auth originates in `~/.claude` / `~/.codex`, but Codex auth is copied into per-run homes. Workspace cleanup and file permissions matter. |
| Direct DB boundary | Weak in current runtime | Intended system actions go through MCP/admin APIs, but agent subprocesses inherit supervisor env and can inspect local secrets unless the env is scrubbed. |
| Scope enforcement on MCP tools | Partial / soft | Task/project/role scope checks exist, but company scope is open and some tools intentionally operate outside claimed-task scope. |
| Policy enforcement for system.modify | Correct | Architect-owned task routing exists, with runtime execution driven by task scope rather than operator sign-off |
| Container isolation | Partial | Agents run as subprocesses inside the supervisor container, not isolated per-task containers, and provider CLIs are launched with sandbox bypass flags. |
| Docker socket exposure on VPS | High-risk gap | The VPS overlay mounts `/var/run/docker.sock` into supervisor and MCP for service control. |
| Service credentials never given to agents | Mostly correct | MCP uses service credentials on the agent's behalf, but unrelated supervisor env secrets may still leak to child processes. |
| Admin auth | Basic but functional | HMAC-signed session cookies, 12-hour TTL |
| Credential storage | Needs work | Plaintext in DB despite encryption functions existing |
| No rate limiting on admin API | Gap | Could be brute-forced |
| No CSRF protection | Gap | SameSite=Strict cookie helps but no CSRF token |
| VPS SSH password in .env | Acknowledged | Test VPS, will be deleted |

---

## Part 9: Comparison to "OpenClaw" / Digital Employee Platforms

### What OpenClaw-style platforms offer that Agent-OS needs:

| Feature | OpenClaw/Similar | Agent-OS Current | Gap |
|---|---|---|---|
| Deploy in minutes | One-click deploy | VPS install script | Close |
| Train with natural language | Structured training UI | Chat-only, no guarantee of retention | Large |
| Shared skills/procedures | Skill library | Nothing | Critical |
| Visual workflow builder | Drag-and-drop | None | Large (but may not be needed) |
| Integration marketplace | Pre-built connectors | service_registry with key_needed pattern | Medium |
| Usage analytics | Dashboard with charts | 1446 events, no UI | Medium |
| Multi-tenant | Per-customer isolation | Single operator | Not needed yet |
| Agent personality editor | Tone/style controls | policy_doc exists but not editable in UI | Medium |
| Knowledge base | Upload docs, FAQ | Memories exist but no bulk import | Medium |
| Conversation templates | Pre-built responses | None | Low priority |

### What Agent-OS has that most platforms don't:

| Feature | Agent-OS | Typical Platform |
|---|---|---|
| Self-hosted, single VPS | Yes | Usually cloud-only SaaS |
| Database-enforced state machine | Yes | Usually application-level |
| Multi-agent collaboration (6 specialized roles) | Yes | Usually single agent |
| Self-evolution (create new roles as data) | Yes | Usually fixed capabilities |
| Full audit trail (append-only events) | Yes | Usually basic logging |
| Dependency-aware task graphs | Yes | Usually flat task lists |
| Dual-provider support (Claude + Codex) | Yes | Usually single LLM vendor |
| Handoff system between agents | Yes | No equivalent |
| Hybrid search (FTS + vector) | Yes | Usually vector-only |

---

## Part 10: Implementation Roadmap

### Phase 0: Tighten the Runtime Boundary (2-3 days)

1. Stop passing the full supervisor environment into agent subprocesses
2. Revisit sandbox bypass flags for provider CLIs
3. Review Docker socket exposure and narrow it if possible
4. Fix credential encryption on `service_registry`

### Phase 1: Make the Admin Panel a Real Control Plane (1-2 weeks)

1. Use the existing full role/agent payloads in the UI, then add role policy viewer/editor in Agents tab
2. Service CRUD in Settings (add, edit, delete, update key)
3. Task creation from admin
4. Memory creation from admin
5. Agent status toggle and activity view
6. Markdown rendering in chat messages

### Phase 2: Build the Skill System (1-2 weeks)

1. Add a `Skill` type and a procedural-memory-backed skill abstraction
2. Implement `skill_create`, `skill_search`, `skill_get`, `skill_log_use` MCP tools
3. Integrate skills into `build_context_pack()`
4. Update supervisor to write skills into `TASK_BRIEFING.md`
5. Build Skills tab or Memory sub-view in admin (browse, create, edit)
6. Only add a dedicated `skills` table if the MVP needs stronger versioning/analytics

### Phase 3: Training and Knowledge Management (1 week)

1. "Teach" mode in chat (operator prefix triggers memory/skill creation)
2. Knowledge base view in Memory tab (operator-created entries)
3. Bulk knowledge import (paste text, extract facts)
4. Skill builder form in admin

### Phase 4: Observability and Polish (1 week)

1. Cost/usage dashboard
2. Task detail page with full run history
3. Artifact browser
4. Project management
5. Real-time updates for chat and tasks
6. Workspace cleanup automation

### Phase 5: Operational Hardening (ongoing)

1. Add admin API rate limiting
2. Implement max-duration timeout for agent runs
3. Investigate artifact embedding backlog / health on VPS
4. Add notification cooldown per task
5. Implement workspace cleanup cron
6. Add schedule locking / catch-up behavior

---

## Appendix A: File Inventory

### Services

| Service | Files | Lines (est.) | Status |
|---|---|---|---|
| Supervisor | 16 .ts files | ~5,500 | Working |
| MCP Server | 21 tool files + 9 infrastructure files | ~4,000 | Working |
| Admin Panel | 10 .tsx/.ts files + server.mjs | ~3,500 | Working but incomplete |
| Browser | 1 .ts file | ~200 | Working |
| Shared | 4 .ts files | ~300 | Working |
| Public Site | Nginx + init script | ~100 | Working |
| DB Migrations | 28 .sql files | ~2,000 | Working |
| Scripts | 7 .sh/.mjs files | ~500 | Working |
| Docker | 5 Dockerfiles + Caddyfile | ~300 | Working |

### Admin API Endpoints (current)

| Method | Path | Purpose |
|---|---|---|
| GET | /api/auth/session | Check session |
| POST | /api/auth/login | Login |
| POST | /api/auth/logout | Logout |
| GET | /api/messages | List messages |
| POST | /api/messages | Send message |
| GET | /api/tasks | List tasks |
| POST | /api/tasks/:id/retry | Retry dead letter |
| GET | /api/agents | List agents (full rows) |
| GET | /api/roles | List roles (full rows, including policy fields) |
| GET | /api/memories | List/search memories |
| POST | /api/memories/:id/expire | Expire memory |
| GET | /api/events | List events |
| GET | /api/services | List services |
| POST | /api/services/:id/credential | Save key |
| GET | /api/runtime/provider | Get provider config |
| POST | /api/runtime/provider | Save provider config |
| GET | /api/runtime/provider/openai/device-auth | Get OpenAI auth state |
| POST | /api/runtime/provider/openai/device-auth/start | Start auth |
| POST | /api/runtime/provider/openai/device-auth/cancel | Cancel auth |
| GET | /api/schedules | List schedules |
| POST | /api/schedules/:id/toggle | Enable/disable |
| POST | /api/schedules/:id | Update schedule |
| GET | /api/system/health | System health |
| POST | /api/integrations/telegram/webhook | Telegram webhook |

### MCP Tools (current)

| Tool | Category |
|---|---|
| task_claim | Task Management |
| task_update | Task Management |
| task_create | Task Management |
| memory_search | Memory |
| memory_write | Memory |
| event_log | Audit |
| artifact_put | Artifacts |
| handoff_create | Collaboration |
| public_site_publish | Deployment |
| public_site_route | Deployment |
| public_site_verify | Deployment |
| observability_snapshot | Monitoring |
| service_control | Infrastructure |
| service_require | Integration |
| context_refresh | Runtime |
| message_send | Communication |
| schedule_create | Automation |
| schedule_update | Automation |
| role_upsert | System Evolution |
| agent_upsert | System Evolution |

---

## Appendix B: Live VPS Snapshot (March 13, 2026)

```
Hostname:       agent-os
CPU:            4 cores
RAM:            7.6 GB (1.4 GB used)
Disk:           75 GB (40% used)
Uptime:         1 day, 10 hours

Services:       11 containers running, all healthy
Provider:       OpenAI (gpt-5.4, gpt-5.3-codex)
Roles:          6 (all system roles)
Agents:         6 (all active, all seen within last hour)
Tasks:          Multiple completed, 2 currently running
Memories:       225 (98 episodic, 127 semantic, 0 procedural)
Memory Chunks:  243 (227 with embeddings)
Events:         2,527 total
Services:       2 (openai: active, shortpixel: active)
Schedules:      2 (sentinel health check: every 30 min)
Workspaces:     221 directories (needs cleanup)
```

---

## Conclusion

Agent-OS has the bones of an excellent digital employee system. The task state machine,
memory system, multi-agent collaboration, and provider abstraction are genuinely well
designed. The architecture decisions document shows thoughtful engineering.

The three highest-impact changes to reach "digital employee" status are:

1. **First-class shared skill system** - without it, the employee cannot be trained in repeatable procedures
2. **Admin panel as a real control plane** - without it, the operator cannot manage or shape the employee
3. **Service connections CRUD** - without it, the employee cannot gain new capabilities
4. **Runtime boundary hardening** - without it, the control-plane and security model are weaker than they appear

Everything else is polish that makes the system more usable, more observable, and more
reliable. But those four changes are the difference between "an interesting agent
framework" and "a deployable digital employee."



