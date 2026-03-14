# Agent-OS Implementation Plan

**Goal:** Turn Agent-OS into a deployable autonomous digital employee with persistent
memory, shared skills, and full operator control.

**Source:** This plan implements the architect-reviewed `REVIEW.md` roadmap.

**Rules:**
1. Read this file before starting any work.
2. Execute tasks in order within each phase. Parallel-safe tasks are marked `[parallel]`.
3. Check the box `[x]` when a task is complete.
4. Do not skip to the next phase while the current phase has unfinished blocking tasks.
5. Every single implementation must be tested before it is marked complete. Use the live VPS for end-to-end validation whenever the change affects runtime behavior, deployment, credentials, agent execution, or the admin control plane.
6. Fresh-deployment testing can also be performed locally with Docker Desktop on this workstation. Use it for clean-install, first-boot, migration-order, and compose bring-up verification before or alongside VPS validation when that is faster or safer.
7. Record the verification method used for each completed implementation task before considering it done.
8. Update this file after completing each task.

**Execution Reset:**
- Some work has already landed out of order in the repository and on the live VPS.
- From this point forward, implementation must resume from the earliest unfinished
  blocking phase and proceed in order.
- For planning and close-out purposes, later-phase work may exist, but no later phase
  should be considered complete while an earlier blocking phase remains open.

---

## Phase 0: Runtime Boundary Hardening

**Why:** Agent subprocesses currently inherit the full supervisor environment (DB
passwords, service keys, JWT secrets). Provider CLIs run with sandbox/approval bypass
flags. The Docker socket is mounted into supervisor and MCP containers. These must be
addressed before adding more capabilities.

**Duration:** 2-3 days

### 0.1 Scrub child process environment
- [x] In `apps/supervisor/src/process-manager.ts`, build an explicit allowlist of env
  vars passed to provider CLI subprocesses. Remove `SUPABASE_SERVICE_KEY`,
  `POSTGRES_PASSWORD`, `JWT_SECRET`, and any other secrets not needed by the agent.
  The agent only needs: `AGENT_ID`, `ROLE_ID`, `RUN_ID`, `TRACE_ID`, `WORKSPACE_DIR`,
  `MCP_CONFIG_PATH`, `PUBLIC_LIVE_DIR`, `PUBLIC_SITE_URL`, `ROOT_DOMAIN`, and provider-
  specific auth paths.
- [x] Verify the MCP server still receives its required secrets through its own
  `mcp-config.json` env block (it does - this is already scoped per-task in
  `process-manager.ts`). Confirm no regression.
Verification used: local `processManagerTestHooks` checks in built supervisor output and
live VPS container checks confirmed `buildChildProcessEnv()` excludes
`SUPABASE_SERVICE_KEY`, `JWT_SECRET`, and `POSTGRES_PASSWORD`, while
`buildPerTaskMcpEnv()` still provides the scoped MCP credentials.

### 0.2 Review provider CLI bypass flags
- [x] Document the current bypass flags used for each provider:
  - Claude: `--dangerously-skip-permissions`
  - Codex: `--dangerously-bypass-approvals-and-sandbox`
- [x] Evaluate whether any narrower permission mode exists for each CLI. If not, document
  the rationale in `DECISIONS.md` as a formal decision (D-009 already covers this, but
  add a note about the env-scrub mitigation).
Verification used: `apps/supervisor/src/process-manager.ts` launch flags were rechecked
against `DECISIONS.md`, and D-009 now records the current flag set plus the March 14,
2026 decision that no narrower autonomous mode is available today.

### 0.3 Narrow Docker socket exposure
- [x] In `docker-compose.vps.yaml`, the Docker socket is mounted into both supervisor and
  MCP. Evaluate whether MCP actually needs it (MCP calls the supervisor's control-plane
  HTTP endpoint, not Docker directly). If MCP does not need the socket, remove its mount.
- [x] For the supervisor, evaluate restricting to read-only or using a Docker socket proxy
  like `tecnativa/docker-socket-proxy` that only exposes the `containers` API.
- [x] Document findings and decision in `DECISIONS.md`.
Verification used: repo compose review confirmed the VPS overlay mounts the Docker socket
only into `supervisor`, not `mcp`, and D-020 now records the decision to keep direct
Docker access limited to the supervisor for the current control-plane surface.

### 0.4 Fix credential encryption in service_registry
- [x] The admin server (`apps/admin/server.mjs`) patches `credential` as plaintext via
  PostgREST. The `encrypt_credential()` PGP function exists in migration 017 but is not
  called. Options:
  1. Add a DB trigger on `service_registry` that auto-encrypts `credential` on
     INSERT/UPDATE using `encrypt_credential()`.
  2. Or call the RPC from `server.mjs` before writing.
- [x] Choose option 1 (DB trigger) for defense-in-depth. Implement migration.
- [x] Update MCP `services.ts` to call `decrypt_credential()` when reading, or ensure
  the DB trigger approach handles decryption transparently.
- [x] Verify on VPS that existing plaintext credentials are re-encrypted.
Verification used: local Docker fresh-stack DB roundtrip stored a plaintext test
credential as normalized ciphertext and returned the decrypted runtime value through
`get_service_registry_runtime()`. On the live VPS, the DB was restarted with the runtime
key setting, migration `035_service_registry_encryption_runtime_fix.sql` was applied as
`supabase_admin`, `service_registry_encryption_key()` returned length `64`, and
`service_registry` moved from `2|2` credentials/plaintext rows to `2|0`.

### 0.5 Phase 0 verification
- [x] `npm run build` succeeds for all affected workspaces.
- [x] Fresh deployment / rebuild validation passes locally in Docker Desktop for the
  affected services or compose stack, including env wiring and startup health.
- [x] Deploy to VPS and confirm agents still launch, claim tasks, and use MCP tools.
- [x] Confirm agent subprocess env no longer contains DB passwords or JWT secrets.
Verification used: local Docker Desktop fresh bring-up (`init`, `db`, `rest`,
`supervisor`, `admin`) went healthy and passed the encryption roundtrip. On the live VPS,
`db`, `rest`, `supervisor`, and `admin` were rebuilt/recreated successfully; health checks
 returned `200`; supervisor logs showed async workers and workspace cleanup resuming; a
 disposable builder verification task completed and emitted `task.runtime_verification`
 via MCP, then its task, events, and task_runs were deleted from the live DB.

---

## Phase 1: Admin Panel as a Real Control Plane

**Why:** The admin panel is read-heavy and write-poor. Operators cannot edit role
policies, create tasks, manage services, or control agents without direct DB access. This
phase turns the admin panel into a real employee management dashboard.

**Duration:** 1-2 weeks

### 1.1 Agent profile editor `[Agents tab]`

**Context:** Runtime `roles` still exist internally for task routing, handoffs, RLS, and
context packs, but the operator-facing control plane should not treat Roles and Agents as
two separate things. Each agent owns one backing runtime profile/system prompt.

#### Backend:
- [x] Add `PATCH /api/roles/:id` endpoint in `server.mjs`. Accept: `policy_doc`,
  `description`, `usage_summary`, `handoff_when`, `model`, `effort`,
  `max_concurrent_tasks`. Reject attempts to delete system
  roles. Validate that `model` is one of haiku/sonnet/opus and `effort` is one of
  low/medium/high/xhigh.
- [x] Add `POST /api/roles` endpoint for creating new custom roles. Require: `id`
  (slug), `display_name`, `description`, `policy_doc`. Default `is_system_role = false`.
- [x] Add `GET /api/roles/:id` endpoint that returns a single role with full fields
  (existing list endpoint works but a detail endpoint is cleaner for deep views).

#### Frontend:
- [x] Surface the backing profile fields through the Agent detail form instead of a
  separate Roles panel.
- [x] Remove the operator-facing "Create Role" path from the active Agents tab.
- [x] Keep `api.updateRole(id, fields)` and `api.createRole(fields)` available for
  internal/runtime use and non-Agents surfaces that still depend on them.

### 1.2 Agent management `[Agents tab]`

#### Backend:
- [x] Add `PATCH /api/agents/:id` endpoint. Accept: `status` (active/paused/disabled),
  `config` (JSON), `role_id`, `name`. Validate status enum.
- [x] Extend `PATCH /api/agents/:id` so agent edits also update the backing runtime
  profile fields (`description`, `policy_doc`, `usage_summary`, `handoff_when`, `model`,
  `effort`, `max_concurrent_tasks`).
- [x] Extend `POST /api/agents` so `role_id` can be generated automatically from the
  agent name, a backing runtime profile is created automatically, and the response
  includes the embedded profile data.
- [x] Add `GET /api/agents/:id/activity` endpoint. Return the last 20 `task_runs` for
  this agent (join with tasks for title), plus the last 20 events where
  `agent_id = :id`.
- [x] Enforce one-agent-per-profile at the DB level with a unique constraint/index on
  `agents.role_id`.

#### Frontend:
- [x] Make agent cards in `AgentsPage.tsx` clickable. On click, show a detail panel with:
  - Status dropdown (active/paused/disabled) with save button
  - Embedded profile fields: `description`, `policy_doc`, `usage_summary`,
    `handoff_when`, `model`, `effort`, `max_concurrent_tasks`
  - Config JSON editor
  - Activity timeline: recent task_runs showing task title, model, effort, status,
    duration, started_at
  - Recent events for this agent
- [x] Add "Create Agent" button for creating the agent and its backing profile in one
  flow.
- [x] Add `api.updateAgent(id, fields)`, `api.createAgent(fields)`,
  `api.getAgentActivity(id)` to `api.ts`.

Verification used: local `npm run build -w apps/admin` and `node --check apps/admin/server.mjs`
passed. A fresh local Docker Desktop stack on port `3004` verified the clean-install
path, the Roles panel was absent in a real browser, task assignment showed agent names,
and `POST/PATCH /api/agents` successfully created and updated a disposable `Billing
Operations Agent`. On the live VPS, admin was rebuilt/redeployed, migration
`036_agent_profile_unification.sql` was applied, the live `/api/agents` payload includes
`role_profile`, and the live Agents page now shows only agent management with no separate
Roles pane.

### 1.3 Service connections CRUD `[Settings tab]`

**Context:** Current UI only shows services and allows pasting keys for `key_needed`
status. The backend credential endpoint exists but only handles `key_needed` → `active`.

#### Backend:
- [x] Add `POST /api/services` endpoint. Accept: `service_name` (slug, unique),
  `display_name`, `description`, `base_url`, `auth_type` (default `api_key`),
  `credential` (optional). If credential provided, set `status = active`; otherwise
  `key_needed`.
- [x] Add `PATCH /api/services/:id` endpoint. Accept any subset of: `display_name`,
  `description`, `base_url`, `auth_type`, `credential`, `status`. If credential is
  updated, set `last_verified = now()`.
- [x] Add `DELETE /api/services/:id` endpoint. Hard delete (these are config entries, not
  audit data).
- [x] Modify existing `POST /api/services/:id/credential` to also work when
  `status = active` (credential rotation), not just `key_needed`.

#### Frontend:
- [x] Add "Add Service" button above the service list in `SettingsPage.tsx`. Opens a
  form with: service_name, display_name, description, base_url, auth_type dropdown,
  credential (password field).
- [x] Add edit button on each service card. Opens an edit form pre-filled with current
  values. Credential field shows "Update credential" placeholder (never shows existing
  credential).
- [x] Add "Update Key" button for active services (not just key_needed). Uses existing
  credential endpoint.
- [x] Add delete button with confirmation dialog on each service card.
- [x] Add `api.createService(fields)`, `api.updateService(id, fields)`,
  `api.deleteService(id)` to `api.ts`.

### 1.4 Task creation from admin `[Tasks tab]`

#### Backend:
- [x] Add `POST /api/tasks` endpoint. Accept: `title`, `objective`,
  `acceptance_criteria` (array), `assigned_role`, `priority` (default `normal`),
  `project_id` (optional), `parent_task_id` (optional). Set `state = ready`. Validate
  assigned_role exists.

#### Frontend:
- [x] Add "Create Task" button at the top of `TasksPage.tsx`. Opens a modal/form with:
  title, objective (textarea), assigned_role (dropdown from roles), priority (dropdown),
  acceptance criteria (dynamic list of text inputs, add/remove).
- [x] Add `api.createTask(fields)` to `api.ts`.

### 1.5 Memory creation from admin `[Memory tab]`

#### Backend:
- [x] Add `POST /api/memories` endpoint. Accept: `layer` (episodic/semantic/procedural),
  `scope_type`, `scope_id`, `subject`, `content`, `tags` (array), `confidence` (default
  1.0). Set `is_active = true`, `source_agent_id = null` (operator-created).
- [x] Add `PATCH /api/memories/:id` endpoint. Accept: `subject`, `content`, `tags`,
  `confidence`. For content edits, auto-update the corresponding memory_chunk.

#### Frontend:
- [x] Add "Create Memory" button in `MemoryPage.tsx`. Opens a form with: layer dropdown,
  scope_type dropdown, scope_id (text), subject, content (textarea), tags (tag input),
  confidence slider (0.0-1.0).
- [x] Add scope and layer filter dropdowns above the memory list.
- [x] Add edit button on expanded memory detail. Opens inline edit for subject, content,
  tags.
- [x] Add `api.createMemory(fields)`, `api.updateMemory(id, fields)` to `api.ts`.

### 1.6 Chat markdown rendering `[Chat tab]`

- [x] Add a lightweight markdown renderer to chat messages. Options:
  - `marked` + `DOMPurify` (minimal deps)
  - Or a simple regex-based renderer for code blocks, bold, italic, lists, links
- [x] Apply the renderer to `msg.content` in `ChatPage.tsx` message list.
- [x] Add a "task link" indicator: if `msg.metadata?.relay_task_id` exists, show a small
  clickable badge that switches to the Tasks tab and highlights that task.

### 1.7 Phase 1 verification
- [x] `npm run build` succeeds for admin, supervisor, shared.
- [x] All new API endpoints return correct responses (test manually or via
  `scripts/test-mcp-tools.sh` pattern).
- [x] Local Docker Desktop validation passes for a fresh admin/control-plane bring-up,
  including login and the touched CRUD flows.
- [x] Deploy to VPS and verify:
  - Can edit a role policy and see it reflected in the next agent launch
  - Can create a new service, paste a key, and see it go active
  - Can create a task from admin and see it claimed by an agent
  - Can create a memory and find it via memory search
  - Chat messages render markdown correctly
Verification used: repo builds passed for `packages/shared`, `apps/supervisor`,
`apps/admin`, and the full workspace. A fresh local Docker Desktop stack
(`init`, `db`, `rest`, `supervisor`, `admin`) went healthy, local admin login
worked, and the admin API successfully created and updated a custom role, agent,
service, task, and memory. Local browser verification with `agent-browser`
confirmed chat markdown rendering and the task shortcut in the Chat tab; evidence:
`C:\Github\agent-os\.tmp\phase1-local-chat-markdown.png`. On the live VPS, a
temporary role/agent pair, service, memory, and admin-created task were created
through the admin API; the task completed under the temporary role, its
`task_runs.context_pack.role_policy` contained the unique policy marker, and the
task emitted `phase1.live.verification` after using `memory_search`. A temporary
processed markdown chat message was rendered and captured via `agent-browser`;
evidence: `C:\Github\agent-os\.tmp\phase1-live-chat-markdown.png`. All temporary
live roles, agents, tasks, task_runs, events, services, memories, message rows,
and workspace state created for verification were deleted afterward.

---

## Phase 2: Shared Skill System

**Why:** Without skills, the employee cannot be trained. The `procedural` memory layer
exists but has 0 entries on the live VPS because no product flow creates or uses them.
This phase builds the skill abstraction on top of existing infrastructure.

**Duration:** 1-2 weeks

### 2.1 Skill type definition `[packages/shared]`

- [x] Add `Skill` interface to `packages/shared/src/types.ts`:
  ```typescript
  export interface Skill {
    id: string;                    // memory ID or future skill ID
    name: string;                  // stable slug (stored as memory subject)
    display_name: string;
    description: string;
    trigger_when: string;          // natural language trigger pattern
    steps: SkillStep[];
    input_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
    required_services: string[];
    scope_type: ScopeType;
    scope_id: string;
    tags: string[];
    version: number;
    last_used_at: string | null;
    use_count: number;
    is_active: boolean;
    created_at: string;
    updated_at: string;
  }

  export interface SkillStep {
    order: number;
    instruction: string;
    tool_hint: string | null;
    required: boolean;
  }
  ```
- [x] Export from `packages/shared/src/index.ts`.
- [x] `npm run build -w packages/shared` succeeds.

### 2.2 Skill convention for procedural memories

**Decision (MVP):** Skills are stored as `memories` rows with `layer = 'procedural'` and
a consistent content structure. This avoids a new table while leveraging existing
search, scope, and supersession infrastructure.

- [x] Define the convention:
  - `subject` = skill name/slug (e.g., `skill:send-invoice-reminder`)
  - `content` = JSON string of the canonical skill representation (matching `Skill` type
    minus the metadata fields that come from the memory row itself)
  - `tags` = `['skill', ...domain_tags]`
  - `scope_type`/`scope_id` = normal scope rules
  - `superseded_by` = used for version history
- [x] Document this convention in `SCHEMA.md` under a new "Skills" subsection.

### 2.3 MCP skill tools `[apps/mcp]`

#### `skill_create` tool:
- [x] Create `apps/mcp/src/tools/skill_create.ts`.
- [x] Parameters: `name` (required), `display_name`, `description`, `trigger_when`,
  `steps` (array of SkillStep), `input_schema`, `output_schema`, `required_services`,
  `scope_type` (default `company`), `scope_id`, `tags`.
- [x] Logic:
  1. Require active task context.
  2. Enforce scope.
  3. Search for existing procedural memory with `subject = 'skill:{name}'` in same
     scope. If found, supersede it (write new, mark old as superseded).
  4. Build canonical JSON content from the structured fields.
  5. Write via `memory_write` logic (insert memory + create memory_chunk).
  6. Return `{ success, skill, superseded_id? }`.
- [x] Policy: `system.modify` (new skills should be reviewed).

#### `skill_search` tool:
- [x] Create `apps/mcp/src/tools/skill_search.ts`.
- [x] Parameters: `query` (text), `scope_type`, `scope_id`, `tags` (array), `limit`
  (default 10).
- [x] Logic:
  1. Search procedural memories with tag `skill`.
  2. Use hybrid search (FTS + vector) scoped to the agent's scope chain.
  3. Also search by `subject ilike 'skill:%query%'`.
  4. Parse content JSON and return structured `Skill` objects.
  5. Sort by relevance, then by use_count (stored in content JSON).
- [x] Return `{ success, skills: Skill[] }`.

#### `skill_get` tool:
- [x] Create `apps/mcp/src/tools/skill_get.ts`.
- [x] Parameters: `name` (skill slug) or `id` (memory UUID).
- [x] Logic:
  1. Query procedural memories with `subject = 'skill:{name}'` or `id = {id}`.
  2. Parse content JSON into structured Skill.
  3. Load supersession chain for version history.
- [x] Return `{ success, skill, versions: [{id, updated_at}] }`.

#### `skill_log_use` tool:
- [x] Create `apps/mcp/src/tools/skill_log_use.ts`.
- [x] Parameters: `name` or `id`, `task_id` (optional, defaults to current),
  `outcome` (success/partial/failed), `notes` (optional).
- [x] Logic:
  1. Find the skill memory.
  2. Update the content JSON: increment `use_count`, set `last_used_at`.
  3. Log event: `skill.used` with skill name, outcome, task_id.
- [x] Return `{ success }`.

#### Register all tools:
- [x] Add all four tools to `apps/mcp/src/index.ts` tool registry and handler map.
- [x] Add `skill_create` to the `extractPolicyAction` function as `system.modify`.
- [x] `npm run build -w apps/mcp` succeeds.

### 2.4 Context pack integration `[apps/supervisor]`

- [x] In `apps/supervisor/src/process-manager.ts`, after building the context pack, query
  procedural memories with tag `skill` scoped to the task's project, role, and company.
  Limit to 10 most relevant (by scope proximity, then use_count).
- [x] Add `relevant_skills` section to `TASK_BRIEFING.md` output. Format each skill as:
  ```
  ### Skill: {display_name}
  Trigger: {trigger_when}
  Steps:
  1. {step.instruction}
  2. ...
  ```
- [x] Also add skills to the context pack JSON so MCP `context_refresh` returns them.

### 2.5 Skill admin UI `[apps/admin]`

#### Backend:
- [x] Add `GET /api/skills` endpoint in `server.mjs`. Query procedural memories with tag
  `skill`, parse content JSON, return as structured Skill objects. Accept query params:
  `q` (text search on subject), `scope_type`, `tags`, `limit`.
- [x] Add `GET /api/skills/:id` endpoint. Return single skill with version history
  (follow superseded_by chain).
- [x] Add `POST /api/skills` endpoint. Create a procedural memory following the skill
  convention. Accept structured Skill fields.
- [x] Add `PATCH /api/skills/:id` endpoint. Supersede existing memory, write new version.
- [x] Add `DELETE /api/skills/:id` endpoint. Set `is_active = false` on the memory.

#### Frontend:
- [x] Add "Skills" as a new nav item in `Dashboard.tsx` between Memory and Events.
- [x] Create `apps/admin/src/pages/SkillsPage.tsx` with:
  - Skill list with cards showing: name, description, trigger_when (truncated),
    use_count, scope badge, tags
  - Search bar (by name/description)
  - Scope filter dropdown
  - Tag filter
  - Expandable detail showing full steps, input/output schema, required services
  - Edit button opening inline editor
  - "Create Skill" button opening a form with:
    - name (slug), display_name, description, trigger_when
    - Steps editor: ordered list with add/remove/reorder, each step has instruction
      (textarea) and tool_hint (text)
    - Required services (multi-select or tag input)
    - Scope selector
    - Tags input
  - Version history link showing supersession chain
  - Usage stats: use_count, last_used_at
- [x] Add `api.getSkills(params)`, `api.getSkill(id)`, `api.createSkill(fields)`,
  `api.updateSkill(id, fields)`, `api.deleteSkill(id)` to `api.ts`.

### 2.6 Phase 2 verification
- [x] `npm run build` succeeds for all workspaces.
- [x] Local Docker Desktop fresh-deployment validation confirms seeded skills,
  migrations, and the Skills UI load correctly on a clean stack.
- [x] Create a skill via MCP tool in a test task, verify it appears in admin Skills tab.
- [x] Search for the skill from another agent's context, verify it is found.
- [x] Verify skill appears in TASK_BRIEFING.md of a new task launch.
- [x] Deploy to VPS and run end-to-end:
  1. Operator creates skill via admin
  2. Operator sends chat message matching the skill's trigger
  3. Relay includes skill in task objective
  4. Builder executes skill steps
  5. Builder logs skill usage
  6. Admin shows updated use_count

---

## Phase 3: Operator Training and Knowledge Management

**Why:** The operator needs a structured way to teach the digital employee. Chat-based
implicit learning is unreliable. This phase adds explicit training flows.

**Duration:** 1 week

### 3.1 "Teach" mode detection in relay routing

- [x] Update the relay objective builder in `apps/admin/server.mjs`
  (`buildRelayObjective`). Add routing guidance:
  ```
  - If the message begins with "Remember:", "Always:", "Rule:", or "When...do...",
    treat it as an explicit training instruction. Create a semantic memory (for facts)
    or a skill (for procedures) with high confidence at company scope, and confirm
    back to the operator what was stored.
  ```
- [x] Update the relay role policy in the `roles` table (via migration or admin UI) to
  include this guidance in the "Routing and classification" section.

### 3.2 Knowledge base view in Memory tab

- [x] Add a "Knowledge Base" filter/mode in `MemoryPage.tsx` that shows only memories
  where `source_agent_id IS NULL` (operator-created) or tagged with
  `operator_preference` / `operator_taught`.
- [x] Add a toggle or tab within the Memory page: "All Memories" vs "Knowledge Base".
- [x] The knowledge base view emphasizes subject and content, de-emphasizes technical
  fields like scope_id.

### 3.3 Skill builder form in admin

- [x] Enhance the "Create Skill" form in `SkillsPage.tsx` with:
  - "Import from text" button: paste a natural-language procedure description, system
    structures it into steps (client-side parsing: split by numbered lines or bullet
    points).
  - Preview panel showing the skill as it would appear in TASK_BRIEFING.md.
  - "Test" button that creates a dry-run task using this skill's trigger_when as the
    objective context, assigned to a selected role so the test can be run safely on the
    live system.

### 3.4 Phase 3 verification
- [x] Local Docker Desktop validation confirms training-related UI and relay flows work
  on a fresh stack before live rollout.
- [x] Operator sends "Remember: Always CC finance@company.com on invoice emails" in
  chat. Verify a semantic memory is created with subject containing the instruction.
- [x] Operator creates a skill via admin form. Verify it is stored and searchable.
- [x] Knowledge base filter correctly shows operator-created entries only.

---

## Phase 4: Observability and Polish

**Why:** The system generates rich data (1446 usage events, task_runs with model/effort/
duration) but the operator cannot see any of it. This phase surfaces that data and fills
UX gaps.

**Duration:** 1 week

### 4.1 Cost and usage dashboard

#### Backend:
- [x] Add `GET /api/usage/summary` endpoint. Query `task_runs` for:
  - Total runs today / this week / this month
  - Runs per role (group by role from joined tasks)
  - Average duration per role
  - Model distribution (count per model_used)
- [x] Optionally aggregate `provider.usage` events for token/cost estimates if the event
  detail JSON contains token counts.

#### Frontend:
- [x] Add a "Dashboard" or "Usage" section. Options:
  - Replace the current chat-as-default with a dashboard home page, move chat to second
    position.
  - Or add usage cards to the Settings tab under a "Usage" heading.
- [x] Show: total runs (today/week/month), runs per role, average duration, model
  breakdown.
- [x] Use simple HTML/CSS bar charts or a lightweight chart library.

### 4.2 Task detail page with run history `[parallel]`

#### Backend:
- [x] Add `GET /api/tasks/:id/runs` endpoint. Return `task_runs` for the task with:
  agent name (join agents), model_used, effort_used, status, duration (calculated),
  started_at, finished_at, error_message.
- [x] Add `GET /api/tasks/:id/full` endpoint. Return task + task_runs + related events
  (scoped to task) + related memories + artifacts.

#### Frontend:
- [x] Make task items in `TasksPage.tsx` expand to a richer detail view (or open a detail
  panel) showing:
  - Full objective and acceptance criteria
  - Run history table: each run with agent, model, effort, status, duration
  - Related events timeline
  - Handoff notes (full text, not truncated)
  - Child tasks list with status
  - Parent task link
  - "Cancel" button for running tasks (calls new cancel endpoint)
- [x] Add task text search input above the task list.

### 4.3 Artifact browser `[parallel]`

#### Backend:
- [x] Add `GET /api/artifacts` endpoint. Accept: `task_id`, `project_id`,
  `artifact_type`, `limit`. Return artifacts with pagination.
- [x] Add `GET /api/artifacts/:id` endpoint for full detail.

#### Frontend:
- [x] Add "Artifacts" as a sub-section within the Tasks detail view, or as a new tab.
- [x] Show artifact list: name, type, task title, created_at.
- [x] Expandable detail: full metadata JSON, storage_path, external_url link.
- [x] Filter by type and project.

### 4.4 Project management `[parallel]`

#### Backend:
- [x] Add `GET /api/projects` endpoint. Return all projects.
- [x] Add `POST /api/projects` endpoint. Accept: `slug`, `display_name`, `description`,
  `repo_url`.
- [x] Add `PATCH /api/projects/:id` endpoint.

#### Frontend:
- [x] Add project filter dropdown to `TasksPage.tsx`.
- [x] Optionally add a "Projects" tab showing all projects with task counts.

### 4.5 Phase 4 verification
- [x] Local Docker Desktop validation confirms dashboard, task detail, artifact, and
  project views render correctly on a fresh stack.
- [x] Usage summary shows real data from VPS task_runs.
- [x] Task detail shows run history with correct durations.
- [x] Artifacts are browsable in admin.
- [x] Projects are listable and filterable.

---

## Phase 5: Operational Hardening

**Why:** The live VPS has 221 orphaned workspace directories, potential notification spam,
and no max-duration safety net for agent runs. This phase addresses runtime reliability.

**Duration:** Ongoing after Phases 0-4 blocking work is complete

### 5.1 Workspace cleanup
- [x] Add a `cleanupWorkspaces()` function in `apps/supervisor/src/process-manager.ts`
  (or a new `workspace-cleanup.ts`).
- [x] Logic: Query `task_runs` with `status IN ('completed', 'failed', 'timeout',
  'interrupted')` and `finished_at < NOW() - cleanup_threshold` (default 24 hours). For
  each, delete the workspace directory at `/app/workspaces/{task_id}`. Keep the last 5
  most recent workspaces regardless.
- [x] Run on a 1-hour interval from `index.ts`.
- [x] Add `WORKSPACE_CLEANUP_HOURS` env var (default 24).

### 5.2 Max-duration timeout for agent runs
- [x] Add `MAX_RUN_DURATION_MS` to `config.ts` (default 60 minutes). Allow per-role
  override via `roles.config` or a new column.
- [x] In `process-manager.ts`, alongside the inactivity check interval, add a separate
  max-duration check. If `Date.now() - startedAt > maxDuration`, kill the process with
  the same SIGTERM → SIGKILL flow as inactivity timeout.
- [x] Log event: `task.max_duration_timeout`.

### 5.3 Notification cooldown per task
- [x] In `apps/supervisor/src/task-attention.ts`, add a cooldown period per task for
  operator notifications. Default: 1 hour. Track via events:
  `operator.notification.sent` with scope_id = task_id.
- [x] Before sending a notification, check if an `operator.notification.sent` event
  exists for this task within the cooldown window. If yes, skip.
- [x] This replaces the current `notification_key` deduplication which changes on every
  `updated_at` change.

### 5.4 Schedule locking
- [x] In `apps/supervisor/src/scheduler.ts`, add a simple lock mechanism: before creating
  a scheduled task, check if a task with the same title and `created_at > last_run_at`
  already exists. If yes, skip (another instance already fired it).
- [x] Update `last_run_at` atomically with the schedule check using a conditional
  PostgREST PATCH (WHERE `last_run_at` matches expected value).

### 5.5 Admin API rate limiting
- [x] Add basic rate limiting to `server.mjs`. Options:
  - Simple in-memory counter per IP (10 failed login attempts per minute).
  - Per-session rate limit for API calls (100 requests per minute).
- [x] Return 429 Too Many Requests when exceeded.

### 5.6 Phase 5 verification
- [x] Local Docker Desktop validation confirms the affected supervisor/admin runtime
  changes behave correctly on a fresh stack before VPS rollout.
- [x] Workspace directory count stabilizes on VPS after cleanup runs.
- [x] A long-running agent is killed after max-duration timeout.
- [x] Notification spam for a stuck task is reduced to 1 per hour.
- [x] Concurrent scheduler instances do not double-fire.
Verification used: fresh local Docker Desktop bring-up validated admin and supervisor
health, then `scripts/verify-phase5-runtime.mjs` ran in a one-off supervisor container
to prove max-duration timeout (`task_runs.status = timeout` plus
`task.max_duration_timeout`), event-based notification cooldown (second pass produced no
replacement message after deleting the first relay row), and concurrent scheduler
locking (three simultaneous `checkSchedules()` calls created exactly one task). Admin
rate limiting was verified on the same fresh stack with failed login attempts returning
`429` on the 11th request and authenticated API requests returning `429` on the 101st
request. Evidence: `C:\Github\agent-os\.tmp\phase5-local-summary.json`,
`C:\Github\agent-os\.tmp\phase5-local-runtime.json`,
`C:\Github\agent-os\.tmp\phase5-local-admin-rate-limit.json`. Live VPS validation used
the idle supervisor (`active_processes = 0`, running tasks = `0`) and two manual
`cleanupWorkspaces()` executions with the supervisor runtime env loaded; workspace counts
held steady at `61 -> 61 -> 61` with `0` stale directories older than the cleanup
window before and after. Evidence:
`C:\Github\agent-os\.tmp\phase5-vps-summary.json`,
`C:\Github\agent-os\.tmp\phase5-vps-workspace-check.json`,
`C:\Github\agent-os\.tmp\phase5-vps-workspace-check-fixed.json`.

---

## Phase 6: Extended Capabilities (Future)

**Why:** These features are important for a mature digital employee but depend on the
foundation built in Phases 0-5.

**Duration:** As needed

### 6.1 MCP project management tools
- [x] Add `project_create` and `project_update` MCP tools so agents can organize work
  into projects.
- [x] Add policy enforcement (`system.modify` for project creation).

### 6.2 Real-time updates via Supabase Realtime or SSE
- [x] Replace polling in Chat tab with Supabase Realtime subscription on `messages`.
- [x] Replace polling in Tasks tab with Realtime subscription on `tasks`.
- [x] Add "live activity" indicator in sidebar: which agents are running, what task,
  last heartbeat.

### 6.3 AGENTS_INSCTRUCTIONS.md override from admin
- [x] Store an override in `system_settings` key `agent_instructions_override`.
- [x] Supervisor checks this setting before falling back to the baked-in file.
- [x] Admin Settings tab shows the current foundational instructions with an edit form.
- [x] This lets operators customize foundational rules without rebuilding the Docker image.

### 6.4 Implement customer and department scope types
- [x] In `apps/mcp/src/scope.ts`, implement `checkScope` for `customer` and
  `department` types. Define the enforcement rules (e.g., agent must have a task with
  matching customer_id or department_id).
- [x] Add `customer_id` / `department_id` columns to tasks, carry them through admin task
  create/edit flows, and include matching customer/department memories and skills in
  `build_context_pack()` plus default MCP retrieval scope resolution.
  mapping table.

### 6.5 Task graph visualization
- [x] Add a visual task graph to the Tasks detail view. Show parent/child/dependency
  relationships as a DAG. Use a lightweight library like `dagre` or simple CSS-based
  tree rendering.

### 6.6 Bulk knowledge import
- [x] Add a "Bulk Import" feature to the Memory/Knowledge tab. Operator pastes a
  document, system splits it into individual facts (by paragraph or sentence), creates
  semantic memories for each.

### 6.7 Skill import from chat
- [x] When admin chat receives a procedural instruction ("When X happens, do A then B then
  C"), auto-generate a skill draft, surface it in chat with save/discard controls, and
  require explicit operator confirmation before saving the shared skill.

### 6.8 Event detail expansion and filtering
- [x] Expand event rows in `EventsPage.tsx` to show the full `detail` JSON.
- [x] Add server-side filtering by `event_type`, `severity`, `agent_id`, date range.

---

## Phase 7: Final Readiness Blockers

**Why:** The plan implementation is functionally complete, but the final review found six
remaining gaps that still block the stated goal of a trustworthy autonomous digital
employee. These are not optional polish items. They affect secret isolation, credential
exposure, task correctness, scope correctness, safe test execution, and prompt
consistency.

**Duration:** 3-6 days

### 7.1 Remove control-plane secrets from agent-readable workspace files
- [ ] In `apps/supervisor/src/process-manager.ts`, stop writing
  `SUPABASE_SERVICE_KEY`, `TELEGRAM_BOT_TOKEN`, and other control-plane secrets into
  agent-readable files such as `mcp-config.json` and Codex `config.toml`.
- [ ] Redesign MCP bootstrap so the launched agent can still reach MCP tools without being
  handed raw control-plane credentials in its own workspace. Options:
  1. Run MCP behind a supervisor-owned local proxy and expose only the proxy endpoint to
     the agent.
  2. Or issue a least-privilege per-run token/JWT instead of the service-role key.
- [ ] Audit `prepareCodexHome()`, `buildCodexConfigToml()`, and any provider-home files to
  ensure no control-plane secrets are copied into the task workspace.

**Why this matters:** The current Phase 0 env scrub is undermined if the same secrets are
written to files the agent can read. A bypassed agent subprocess can still recover DB and
runtime secrets from the workspace and escape the intended trust boundary.

**Must test before complete:**
- [ ] Local Docker Desktop: launch a real task, inspect the task workspace, and verify no
  service-role key, Telegram token, JWT secret, or DB password appears in
  `mcp-config.json`, provider config, or copied auth files.
- [ ] Local Docker Desktop: verify the task can still use MCP tools successfully after the
  redesign.
- [ ] Live VPS: run one disposable verification task, confirm MCP still works, and then
  search the live workspace for leaked secrets before cleaning up the task and workspace.

### 7.2 Restrict decrypted service credential access to trusted runtime paths
- [ ] In `supabase/migrations/031_service_registry_runtime_rpc.sql`, remove
  `authenticated` execute access from `get_service_registry_runtime(text)`.
- [ ] Re-grant the RPC only to the narrowest role that actually needs plaintext
  credentials at runtime.
- [ ] Audit every caller in supervisor/MCP/admin to confirm no authenticated client path
  depends on the broader grant.

**Why this matters:** `get_service_registry_runtime()` is `SECURITY DEFINER` and returns
decrypted credentials. If ordinary authenticated callers can execute it, any authenticated
DB client can read plaintext third-party secrets.

**Must test before complete:**
- [ ] Local Docker Desktop: verify a normal authenticated caller can no longer execute the
  RPC.
- [ ] Local Docker Desktop: verify supervisor/MCP service flows that need credentials still
  succeed.
- [ ] Live VPS: re-run one credentialed service lookup path and confirm the service still
  works, then verify the RPC is no longer exposed to non-service callers.

### 7.3 Make task claiming single-winner and race-safe
- [ ] In `apps/supervisor/src/task-poller.ts`, replace the current optimistic
  `ready -> claimed -> running` sequence with a single-winner claim flow that verifies the
  current poller actually claimed the row before launching.
- [ ] Include `claimed_by = agent.id` in the `claimed -> running` transition so one poller
  cannot advance another poller's claim.
- [ ] Add a second line of defense at the DB/task-run level if needed, such as a
  uniqueness rule preventing multiple active launches for the same task.

**Why this matters:** Double-launching the same task is one of the fastest ways to produce
duplicate external actions, conflicting memory writes, and broken task state.

**Must test before complete:**
- [ ] Local Docker Desktop: run a concurrency harness that triggers multiple pollers
  against the same ready task and verify exactly one agent launch and one active run.
- [ ] Local Docker Desktop: verify the losing poller does not move the task to `running`.
- [ ] Live VPS: perform one selective concurrency verification with disposable tasks only
  if it can be done without operator noise, then delete the test rows.

### 7.4 Make MCP context run-scoped and enforce `max_concurrent_tasks`
- [ ] In `apps/supervisor/src/process-manager.ts`, pass `TASK_ID` into the per-run MCP
  environment.
- [ ] In `apps/mcp/src/context.ts` and `apps/mcp/src/scope.ts`, resolve the active task
  from the explicit run/task context instead of "latest task claimed by this agent".
- [ ] Update memory, skill, service, and task tools that depend on current task scope to
  use the explicit task id.
- [ ] In `apps/supervisor/src/task-poller.ts`, enforce `max_concurrent_tasks` before
  selecting/launching an agent.

**Why this matters:** Without a run-scoped task id, agents with more than one active task
can attach memory, skills, service requirements, or customer/department scope to the
wrong task. Exposing `max_concurrent_tasks` in the admin while not enforcing it also gives
operators a false sense of control.

**Must test before complete:**
- [ ] Local Docker Desktop: set `max_concurrent_tasks = 1` and verify a second ready task
  for the same agent does not launch.
- [ ] Local Docker Desktop: set `max_concurrent_tasks = 2`, create two scoped tasks for
  the same agent, and verify each run reads/writes against the correct task/project/
  customer/department context.
- [ ] Live VPS: run a minimal disposable verification of the enforced cap and explicit
  task context, then remove all test tasks and related rows.

### 7.5 Make skill "dry-run" tests truly non-destructive
- [ ] Add an explicit backend task flag such as `test_mode`, `simulation_only`, or
  equivalent rather than relying on objective text.
- [ ] Carry that flag into task briefing/context pack generation so execution roles know
  they are in simulation mode.
- [ ] Enforce the flag in the execution layer for any tool or workflow that can mutate
  external systems.
- [ ] Update the Skills admin UI copy so operators understand the exact safety guarantee.

**Why this matters:** A "dry-run" button that creates an ordinary ready task is not a dry
run. It is real work queued for real execution, which is unsafe for a system that can act
autonomously.

**Must test before complete:**
- [ ] Local Docker Desktop: create a dry-run skill test task and verify it is marked as
  simulation/test mode end to end.
- [ ] Local Docker Desktop: verify mutation-capable tools refuse or safely no-op in that
  mode.
- [ ] Live VPS: run one disposable dry-run verification and confirm no external state is
  changed, then remove the test task.

### 7.6 Remove the remaining approval-era prompt language
- [ ] Remove the remaining approval-era relay wording from
  `apps/supervisor/src/message-router.ts` and `apps/admin/server.mjs`.
- [ ] Audit the latest seed/update migrations and living docs so fresh installs and live
  upgrades do not reintroduce approval-era wording.
- [ ] Add one normalization migration if needed so the live database content matches the
  new autonomous model everywhere.

**Why this matters:** The operator approval flow has been removed. Leaving approval-era
prompt language behind can still bias relay routing, planning behavior, and future seed
state away from the intended autonomous execution model.

**Must test before complete:**
- [ ] Repo audit: grep for the banned approval-era phrases and confirm they are gone from
  active runtime code and current docs.
- [ ] Local Docker Desktop fresh deployment: verify seeded role/policy content and relay
  routing prompts no longer mention approval-era behavior.
- [ ] Live VPS: send one controlled relay message, inspect the generated routing objective,
  and confirm the outdated approval wording is gone.

---

## Reference: Files Modified Per Phase

| Phase | Files |
|---|---|
| 0 | `apps/supervisor/src/process-manager.ts`, `docker-compose.vps.yaml`, `supabase/migrations/029_*.sql`, `apps/admin/server.mjs`, `apps/mcp/src/services.ts`, `DECISIONS.md` |
| 1 | `apps/admin/server.mjs`, `apps/admin/src/pages/AgentsPage.tsx`, `apps/admin/src/pages/SettingsPage.tsx`, `apps/admin/src/pages/TasksPage.tsx`, `apps/admin/src/pages/MemoryPage.tsx`, `apps/admin/src/pages/ChatPage.tsx`, `apps/admin/src/lib/api.ts`, `apps/admin/src/pages/Dashboard.tsx` |
| 2 | `packages/shared/src/types.ts`, `apps/mcp/src/tools/skill_create.ts` (new), `apps/mcp/src/tools/skill_search.ts` (new), `apps/mcp/src/tools/skill_get.ts` (new), `apps/mcp/src/tools/skill_log_use.ts` (new), `apps/mcp/src/index.ts`, `apps/supervisor/src/process-manager.ts`, `apps/admin/server.mjs`, `apps/admin/src/pages/SkillsPage.tsx` (new), `apps/admin/src/pages/Dashboard.tsx`, `apps/admin/src/lib/api.ts`, `SCHEMA.md` |
| 3 | `apps/admin/server.mjs`, `apps/admin/src/pages/MemoryPage.tsx`, `apps/admin/src/pages/SkillsPage.tsx`, `supabase/migrations/` (relay policy update) |
| 4 | `apps/admin/server.mjs`, `apps/admin/src/pages/TasksPage.tsx`, `apps/admin/src/pages/Dashboard.tsx`, `apps/admin/src/lib/api.ts`, new page files for artifacts/projects if separate tabs |
| 5 | `apps/supervisor/src/process-manager.ts` or new `workspace-cleanup.ts`, `apps/supervisor/src/config.ts`, `apps/supervisor/src/index.ts`, `apps/supervisor/src/task-attention.ts`, `apps/supervisor/src/scheduler.ts`, `apps/admin/server.mjs` |
| 6 | Various - depends on selected features |
| 7 | `apps/supervisor/src/process-manager.ts`, `apps/supervisor/src/task-poller.ts`, `apps/mcp/src/context.ts`, `apps/mcp/src/scope.ts`, `apps/admin/server.mjs`, `apps/admin/src/pages/SkillsPage.tsx`, `supabase/migrations/031_*.sql`, follow-up migrations/docs as needed |

---

## Status

### Verification Notes

- 2026-03-14: Admin server syntax verified with `node --check apps/admin/server.mjs`.
- 2026-03-14: Admin workspace build verified with `npm run build -w apps/admin`.
- 2026-03-14: Phase 6.2 SSE verification passed locally on a fresh Docker Desktop stack. Chat updated live from an inserted relay message, the sidebar live-activity card updated from a seeded running task, and clicking that card opened the Tasks view. Evidence: `C:\Github\agent-os\.tmp\phase62-chat-local.png`, `C:\Github\agent-os\.tmp\phase62-sidebar-local.png`, `C:\Github\agent-os\.tmp\phase62-tasks-local.png`.
- 2026-03-14: Phase 6.2 SSE verification passed on the live VPS. Authenticated `/api/stream` returned `snapshot` events, the live admin Chat page rendered an inserted relay message without refresh, and the live sidebar reflected active task state. Temporary live message rows and leftover relay-verification test tasks discovered during this check were deleted afterward. Evidence: `C:\Github\agent-os\.tmp\phase62-chat-live.png`.
- 2026-03-14: Phase 6.6 bulk import verification passed locally on a fresh Docker Desktop stack and on the live VPS. A two-paragraph document imported as two semantic company memories tagged `operator_taught`, and the temporary live verification memories were deleted afterward.
- 2026-03-14: Phase 6.4 verification passed locally and on the live VPS. Local Docker Desktop validation created customer-scoped and department-scoped memories plus skills, then confirmed `build_context_pack()` included them for a scoped task (`.tmp/phase6-local-context-summary.json`). Live VPS validation repeated the same check with a backlog-only task via direct `build_context_pack()` SQL and the temporary live rows were deleted afterward.
- 2026-03-14: Phase 6.7 verification passed locally and on the live VPS. Admin chat now surfaces procedural training as a pending skill draft with save/discard controls, explicit confirmation saves the skill, and the saved skill becomes searchable immediately. Local UI evidence: `C:\Github\agent-os\.tmp\phase6-chat-draft-local.png`. The temporary live draft, messages, skills, memories, and scoped task were deleted afterward.
- 2026-03-14: Phase 5 verification passed. Local Docker Desktop evidence in `C:\Github\agent-os\.tmp\phase5-local-summary.json` showed max-duration timeout, notification cooldown, scheduler locking, and admin API rate limiting on a fresh stack; the disposable stack was torn down afterward. Live VPS evidence in `C:\Github\agent-os\.tmp\phase5-vps-summary.json` showed the supervisor idle, `cleanupWorkspaces()` safe to run manually, and workspace counts stable at `61` with `0` stale directories before and after two cleanup passes.

- [x] Phase 0 - Runtime Boundary Hardening
- [x] Phase 1 - Admin Panel Control Plane
- [x] Phase 2 - Shared Skill System
- [x] Phase 3 - Training and Knowledge Management
- [x] Phase 4 - Observability and Polish
- [x] Phase 5 - Operational Hardening
- [x] Phase 6 - Extended Capabilities (future, not blocking)
- [ ] Phase 7 - Final Readiness Blockers
