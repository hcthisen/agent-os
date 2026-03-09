# Schema

This document describes the data model for the Supabase control plane. It is not SQL —
the coding agent generates the actual migrations. This document captures the tables,
their purposes, key columns, relationships, and critical behaviors that the schema must
implement.

## Required Extensions

- `pgcrypto` — UUID generation (`gen_random_uuid()`).
- `vector` — pgvector for semantic embeddings.
- `pg_trgm` — Trigram fuzzy matching for memory subject search.

## Tables

### roles

The job description table. Defines what an agent can do, which model it uses, and what
actions require human approval.

| Column                  | Type     | Notes                                          |
|-------------------------|----------|-------------------------------------------------|
| id                      | text PK  | Slug. e.g. `relay`, `sage`, `builder`, `cfo`.  |
| display_name            | text     | Human-readable name.                            |
| description             | text     | What this role does.                            |
| policy_doc              | text     | Markdown. Responsibilities, boundaries, rules.  |
| model                   | text     | Claude Code model: `opus`, `sonnet`, `haiku`.   |
| effort                  | text     | Claude Code effort: `low`, `medium`, `high`.    |
| max_concurrent_tasks    | int      | Default 3. How many tasks this role can have in |
|                         |          | `claimed` or `running` simultaneously.          |
| requires_approval_for   | jsonb    | Array of action types needing human sign-off.   |
|                         |          | e.g. `["payment", "deploy_prod", "data_delete"]`|
| is_system_role          | bool     | True for the 6 foundational roles. System roles |
|                         |          | cannot be deleted, only modified by architect.  |
| created_at              | timestamptz | Auto.                                        |
| updated_at              | timestamptz | Auto.                                        |

**Seed data:** Six foundational roles must be created by the initial migration:

| id         | model  | effort | is_system_role |
|------------|--------|--------|----------------|
| relay      | haiku  | medium | true           |
| sage       | opus   | high   | true           |
| builder    | opus   | high   | true           |
| reviewer   | opus   | high   | true           |
| architect  | opus   | high   | true           |
| sentinel   | sonnet | high   | true           |

### agents

One row per persistent identity. Sessions are disposable; the agent is not.

| Column       | Type      | Notes                                             |
|--------------|-----------|---------------------------------------------------|
| id           | uuid PK   | Generated.                                        |
| name         | text UQ   | Human-readable. e.g. `builder-1`, `sentinel-1`.  |
| role_id      | text FK→roles | Which role this agent plays.                  |
| status       | enum      | `active`, `paused`, `disabled`.                   |
| config       | jsonb     | Role overrides if any (e.g. operator changed      |
|              |           | model via admin panel). Empty by default.         |
| last_seen_at | timestamptz | Updated on every task_run start.               |
| created_at   | timestamptz | Auto.                                           |
| updated_at   | timestamptz | Auto.                                           |

**Seed data:** One agent per foundational role: `relay-1`, `sage-1`, `builder-1`,
`reviewer-1`, `architect-1`, `sentinel-1`.

**Config overrides:** If `config` contains `{ "model": "sonnet" }`, the supervisor uses
that instead of the role's default model. This lets the operator override per-agent via
the admin panel without changing the role definition.

### projects

Organizational container for related tasks.

| Column       | Type      | Notes                                             |
|--------------|-----------|---------------------------------------------------|
| id           | uuid PK   | Generated.                                        |
| slug         | text UQ   | e.g. `marketing-site`, `morning-briefing`.       |
| display_name | text      |                                                   |
| description  | text      |                                                   |
| repo_url     | text      | Git repo URL if applicable.                       |
| metadata     | jsonb     | Flexible. Tech stack, domain, etc.                |
| archived     | bool      | Default false. Archived projects are hidden.      |
| created_at   | timestamptz |                                                 |
| updated_at   | timestamptz |                                                 |

### tasks

The atomic unit of work. **Strict state machine enforced by database trigger.**

| Column              | Type         | Notes                                       |
|---------------------|--------------|---------------------------------------------|
| id                  | uuid PK      | Generated.                                  |
| project_id          | uuid FK→projects | Optional.                               |
| parent_task_id      | uuid FK→tasks | Self-referential. Sub-task support.        |
| title               | text         | Short description.                          |
| objective           | text         | What "done" looks like.                     |
| acceptance_criteria | jsonb        | Array of strings.                           |
| state               | enum         | See state machine below.                    |
| priority            | enum         | `critical`, `high`, `normal`, `low`.        |
| assigned_role       | text FK→roles |                                            |
| claimed_by          | uuid FK→agents | Null until claimed.                       |
| claimed_at          | timestamptz  | Set by trigger on claim.                    |
| attempt_count       | int          | Default 0. Incremented on failure.          |
| max_attempts        | int          | Default 3. Dead letter threshold.           |
| blocked_reason      | text         | Required when moving to blocked state.      |
| depends_on          | uuid[]       | Task IDs that must complete first.          |
| requires_approval   | bool         | Default false.                              |
| is_system_modification | bool      | True if this task modifies roles/agents/    |
|                     |              | policies. Requires architect approval.      |
| last_handoff_note   | text         | Updated on every handoff.                   |
| due_at              | timestamptz  | Optional deadline.                          |
| started_at          | timestamptz  | Set by trigger when entering running.       |
| completed_at        | timestamptz  | Set by trigger when entering completed.     |
| created_at          | timestamptz  |                                             |
| updated_at          | timestamptz  |                                             |

**Indexes:** state, project_id, claimed_by, parent_task_id, (priority + state).

#### Task State Machine

Enforced by a `BEFORE UPDATE` trigger. The trigger must:

1. Validate the transition against the allowed transitions map.
2. Require `last_handoff_note` when leaving `running`, `blocked_on_human`,
   `blocked_on_agent`, or `failed`.
3. Require `blocked_reason` when entering `blocked_on_human` or `blocked_on_agent`.
4. Increment `attempt_count` when entering `failed`.
5. Auto-route to `dead_letter` if `attempt_count >= max_attempts`.
6. Set `claimed_at` when entering `claimed`.
7. Set `started_at` when entering `running` (from `claimed` only).
8. Set `completed_at` when entering `completed`.
9. Update `updated_at` on every transition.

```
Allowed transitions:

backlog          → ready, failed
ready            → claimed, backlog
claimed          → running, ready
running          → blocked_on_human, blocked_on_agent, in_review, completed, failed
blocked_on_human → running, ready, failed
blocked_on_agent → running, ready, failed
in_review        → completed, running, failed
completed        → (terminal)
failed           → ready, dead_letter
dead_letter      → ready (human override only)
```

### task_runs

One row per Claude Code execution attempt. The audit trail.

| Column        | Type      | Notes                                            |
|---------------|-----------|--------------------------------------------------|
| id            | uuid PK   |                                                  |
| task_id       | uuid FK→tasks |                                              |
| agent_id      | uuid FK→agents |                                             |
| trace_id      | text UQ   | For end-to-end observability.                    |
| status        | text      | `started`, `completed`, `failed`, `timeout`.     |
| context_pack  | jsonb     | Snapshot of what was sent to Claude Code.         |
| outcome       | jsonb     | Structured result.                               |
| handoff_note  | text      |                                                  |
| model_used    | text      | Actual model (opus/sonnet/haiku).                |
| effort_used   | text      | Actual effort (low/medium/high).                 |
| error_message | text      |                                                  |
| started_at    | timestamptz |                                                |
| finished_at   | timestamptz |                                                |
| created_at    | timestamptz |                                                |

**Indexes:** task_id, agent_id, trace_id.

**Note:** We deliberately do not store token counts or cost per run in this table. Claude
Code via subscription does not expose per-request token usage the way the API does. If
the operator adds an API key and uses API billing for some operations, those costs can be
tracked. But the primary execution model (subscription CLI) has no per-run cost metric.
The sentinel monitors overall spending patterns at the subscription level, not per-task.

### events

Append-only log. Every side effect creates an event. This is the backbone of
observability.

| Column     | Type      | Notes                                               |
|------------|-----------|-----------------------------------------------------|
| id         | uuid PK   |                                                     |
| trace_id   | text      | Links to task_run.                                  |
| agent_id   | uuid FK→agents |                                                |
| event_type | text      | Namespaced. e.g. `task.claimed`, `email.sent`,      |
|            |           | `deploy.triggered`, `memory.written`,               |
|            |           | `sentinel.report`, `auth.expired`.                  |
| severity   | enum      | `info`, `warning`, `error`, `critical`.             |
| scope_type | enum      | `task`, `project`, `customer`, `role`, `department`,|
|            |           | `company`.                                          |
| scope_id   | text      | The ID of the scoped entity.                        |
| summary    | text      | Human-readable one-liner.                           |
| detail     | jsonb     | Structured metadata.                                |
| created_at | timestamptz |                                                   |

**Indexes:** (scope_type, scope_id), event_type, agent_id, created_at DESC, trace_id.

**This table is append-only.** No updates, no deletes (except by retention policy).

### memories

Structured, auditable facts. The semantic and episodic memory layer. This is NOT the
search index — that is `memory_chunks`.

| Column            | Type        | Notes                                        |
|-------------------|-------------|----------------------------------------------|
| id                | uuid PK     |                                              |
| layer             | enum        | `episodic`, `semantic`, `procedural`.        |
| scope_type        | enum        | Same as events.                              |
| scope_id          | text        |                                              |
| subject           | text        | Short label for retrieval. e.g. "ACME billing|
|                   |             | terms", "website tech stack".                |
| content           | text        | The fact or event description.               |
| tags              | text[]      |                                              |
| source_event_id   | uuid FK→events | What event produced this memory.          |
| source_agent_id   | uuid FK→agents | Who wrote it.                             |
| confidence        | real        | 0.0–1.0. Default 1.0.                       |
| superseded_by     | uuid FK→memories | If this fact was replaced.              |
| last_verified_at  | timestamptz | Default now(). Sentinel checks staleness.    |
| expires_at        | timestamptz | Optional TTL.                                |
| is_active         | bool        | Default true. Superseded = false.            |
| created_at        | timestamptz |                                              |
| updated_at        | timestamptz |                                              |

**Indexes:**
- (scope_type, scope_id) WHERE is_active = true
- layer WHERE is_active = true
- subject using GIN trigram (fuzzy match)
- tags using GIN

### memory_chunks

Derived search index. Generated from memories and artifacts. Used for retrieval, never
as source of truth. Can be fully regenerated from source tables.

| Column      | Type      | Notes                                              |
|-------------|-----------|----------------------------------------------------|
| id          | uuid PK   |                                                    |
| source_type | text      | `memory`, `artifact`, `event`.                     |
| source_id   | uuid      | FK to the source table.                            |
| scope_type  | enum      | Denormalized for fast filtering.                   |
| scope_id    | text      |                                                    |
| content     | text      | The text to search over.                           |
| fts         | tsvector  | Generated column: `to_tsvector('english', content)`|
| embedding   | vector(1536) | Semantic embedding. Generated asynchronously.   |
| created_at  | timestamptz |                                                  |

**Indexes:**
- fts using GIN
- embedding using ivfflat (vector_cosine_ops, lists=100)
- (scope_type, scope_id)

#### Hybrid Search Function: `hybrid_memory_search`

This function combines full-text search and vector similarity using Reciprocal Rank
Fusion (RRF). It is the primary retrieval mechanism for agents.

**Parameters:**
- `query_text` (text) — the search query for FTS.
- `query_embedding` (vector) — the embedding of the query for vector search.
- `filter_scope_type` (optional) — restrict to a scope type.
- `filter_scope_id` (optional) — restrict to a specific scope.
- `match_limit` (int, default 20) — max results.
- `rrf_k` (int, default 60) — RRF smoothing constant.

**How it works:**
1. Run FTS: `fts @@ websearch_to_tsquery('english', query_text)`, rank by `ts_rank_cd`.
2. Run vector search: order by `embedding <=> query_embedding`, rank by cosine distance.
3. Union the result IDs.
4. Score each result using RRF: `1/(k + fts_rank_position) + 1/(k + vec_rank_position)`.
5. Return results ordered by RRF score descending.

**Why RRF:** It fuses two differently-scaled ranking signals without requiring score
normalization or tuning. FTS catches exact terms ("Stripe", "invoice #4521"). Vector
search catches semantic similarity ("payment processing issues" matches "Stripe webhook
failures"). RRF gives you both without a weighted formula that would need calibration.

**Why the MCP server generates the embedding, not the database function:** The embedding
for `query_embedding` must be generated before calling this function. The MCP server
handles this: it takes the agent's text query, generates an embedding (via the API key
in the service registry, e.g. OpenAI `text-embedding-ada-002` or a Supabase-hosted
model), and passes both the text and embedding to this function. If no embedding service
is configured, the function falls back to FTS-only mode.

### approvals

Human-in-the-loop gate for high-stakes actions.

| Column      | Type        | Notes                                            |
|-------------|-------------|--------------------------------------------------|
| id          | uuid PK     |                                                  |
| task_id     | uuid FK→tasks |                                                |
| agent_id    | uuid FK→agents | Who requested.                                |
| action_type | text        | e.g. `payment`, `deploy_prod`, `system_modify`. |
| description | text        | What the agent wants to do and why.              |
| context     | jsonb       | Relevant data: amounts, affected items, risk.    |
| status      | enum        | `pending`, `approved`, `rejected`, `expired`.    |
| decided_by  | text        | Human identifier (from admin panel).             |
| decided_at  | timestamptz |                                                  |
| reason      | text        | Human's explanation (optional).                  |
| expires_at  | timestamptz | Default now() + 24 hours.                        |
| created_at  | timestamptz |                                                  |

**Indexes:** task_id, status WHERE status = 'pending'.

### artifacts

Index of files, PRs, docs, reports, and other work products. The actual files live in
Supabase Storage or as git objects. This table is the searchable metadata layer.

| Column        | Type      | Notes                                            |
|---------------|-----------|--------------------------------------------------|
| id            | uuid PK   |                                                  |
| project_id    | uuid FK→projects |                                             |
| task_id       | uuid FK→tasks |                                               |
| artifact_type | text      | `file`, `pr`, `doc`, `report`, `invoice`,        |
|               |           | `screenshot`, `contract`, `ticket`, `audio`.     |
| name          | text      |                                                  |
| storage_path  | text      | Supabase Storage path.                           |
| external_url  | text      | GitHub PR, Google Doc, etc.                      |
| mime_type     | text      |                                                  |
| size_bytes    | bigint    |                                                  |
| metadata      | jsonb     |                                                  |
| created_by    | uuid FK→agents |                                              |
| created_at    | timestamptz |                                                |

**Indexes:** project_id, task_id, artifact_type.

### handoffs

Explicit record of work transfer between agents or sessions.

| Column           | Type      | Notes                                          |
|------------------|-----------|-------------------------------------------------|
| id               | uuid PK   |                                                |
| task_id          | uuid FK→tasks |                                             |
| from_agent_id    | uuid FK→agents |                                            |
| to_agent_id      | uuid FK→agents | Specific agent, if known.                 |
| to_role_id       | text FK→roles | Or hand off to a role (system picks agent).|
| summary          | text      | What was done.                                 |
| changes_made     | jsonb     | Array of concrete changes.                     |
| blockers         | jsonb     | Array of open issues.                          |
| next_steps       | jsonb     | Array of recommended actions.                  |
| context_snapshot | jsonb     | Key facts for the next agent.                  |
| created_at       | timestamptz |                                              |

**Indexes:** task_id, to_agent_id, to_role_id.

### schedules

Cron-style recurring work.

| Column        | Type      | Notes                                            |
|---------------|-----------|--------------------------------------------------|
| id            | uuid PK   |                                                  |
| name          | text UQ   | e.g. `morning-briefing`, `sentinel-health-check`.|
| cron_expr     | text      | Standard cron. e.g. `0 9 * * 1-5` (weekday 9am).|
| assigned_role | text FK→roles |                                               |
| task_template | jsonb     | Used to create a task when the schedule fires.   |
|               |           | Contains: title, objective, acceptance_criteria, |
|               |           | priority, project_id.                            |
| enabled       | bool      | Default true.                                    |
| last_run_at   | timestamptz |                                                |
| next_run_at   | timestamptz |                                                |
| created_at    | timestamptz |                                                |

**Seed data:** One schedule for the sentinel: `sentinel-health-check`, cron `*/5 * * * *`
(every 5 minutes), assigned to `sentinel` role.

### service_registry

Tracks external services, their required credentials, and status. API keys are stored
encrypted.

| Column        | Type      | Notes                                            |
|---------------|-----------|--------------------------------------------------|
| id            | uuid PK   |                                                  |
| service_name  | text UQ   | e.g. `elevenlabs`, `stripe`, `openai`, `sendgrid`|
| display_name  | text      | Human-readable.                                  |
| description   | text      | What this service is used for.                   |
| base_url      | text      | API base URL if relevant.                        |
| auth_type     | text      | `api_key`, `oauth`, `bearer`.                    |
| credential    | text      | Encrypted API key or token. Null if not yet      |
|               |           | provided. Encrypted at rest using pgcrypto.      |
| status        | enum      | `active`, `key_needed`, `error`, `disabled`.     |
| last_verified | timestamptz | Last time the credential was tested.           |
| error_message | text      | Last error if status = error.                    |
| registered_by | uuid FK→agents | Which agent registered this service.         |
| created_at    | timestamptz |                                                |
| updated_at    | timestamptz |                                                |

**Indexes:** service_name, status.

**The admin panel reads and writes this table directly** (via PostgREST with the admin
JWT). When an agent needs a key, it creates a row with `status: key_needed`. The admin
panel shows this as a pending request. The operator pastes the key, the admin panel
encrypts and stores it. The MCP server reads the decrypted key when the agent calls a
tool that needs it.

### messages

Communication queue for human-to-system and system-to-human messages.

| Column     | Type      | Notes                                               |
|------------|-----------|-----------------------------------------------------|
| id         | uuid PK   |                                                     |
| channel    | text      | `admin_chat`, `telegram`.                           |
| direction  | text      | `inbound` (human→system), `outbound` (system→human).|
| sender     | text      | `operator`, agent name, or `system`.                |
| content    | text      | Message text.                                       |
| metadata   | jsonb     | Channel-specific data (telegram chat_id, etc.).     |
| task_id    | uuid FK→tasks | If this message resulted in a task.              |
| processed  | bool      | Default false. Set true after relay handles it.     |
| created_at | timestamptz |                                                   |

**Indexes:** (channel, processed) WHERE processed = false, created_at DESC.

**Realtime:** This table should have Supabase Realtime enabled so the admin panel can
show messages in real time. The supervisor also subscribes to inserts on this table to
trigger relay invocations.

## Context Pack Assembly: `build_context_pack()`

A Postgres function that assembles everything an agent needs to start work. Called by the
supervisor before launching a Claude Code process.

**Input:** `task_id` (uuid)

**Output:** JSON object containing:

```json
{
  "task": { /* full task row */ },
  "project": { /* project row, if task has project_id */ },
  "role_policy": "markdown string from roles.policy_doc",
  "model": "opus",
  "effort": "high",
  "last_handoff": { /* most recent handoff for this task */ },
  "pending_approvals": [ /* approvals with status=pending for this task */ ],
  "recent_events": [ /* last 20 events scoped to this task */ ],
  "related_memories": [
    /* memories scoped to this task (all) */
    /* + memories scoped to this project (limit 30) */
    /* + memories scoped to this role (limit 20) */
    /* + memories scoped to company (limit 10) */
    /* ordered: task scope first, then project, then role, then company */
  ],
  "related_artifacts": [ /* artifacts linked to this task */ ]
}
```

The function retrieves model and effort from the agent's `config` override if it exists,
otherwise from the role's defaults.

**The supervisor takes this JSON and writes it into `TASK_BRIEFING.md`.** The runtime
`AGENTS.md` bootstrap file then points the Claude Code process to `TASK_BRIEFING.md`
and `AGENTS_INSCTRUCTIONS.md` on launch.

## Row Level Security

All tables that agents access through the MCP server must have RLS enabled. The MCP
server connects with the service key (bypasses RLS) but validates scope in application
code. RLS is the fallback safety net.

**JWT claims available in RLS policies:**
- `agent_id` (uuid)
- `role_id` (text)
- `run_id` (uuid)

**Key policies:**

- **tasks**: Agents can only read/claim tasks assigned to their `role_id`.
- **memories**: Agents can read memories where `scope_type = 'company'` OR
  `scope_type = 'role' AND scope_id = their role_id` OR scoped to their current
  task/project (validated by the MCP server via join).
- **events**: Agents can insert events (with their agent_id). Read access follows
  same scope rules as memories.
- **service_registry**: Agents cannot read the `credential` column. Only the MCP
  server (service key) reads credentials.

## Async Processing

Three operations happen asynchronously after the agent's session:

1. **Embedding generation**: When a memory or artifact is written, a trigger (or pgmq
   queue message) fires. An Edge Function or background worker generates the embedding
   and inserts/updates the `memory_chunks` row.

2. **Memory distillation**: A scheduled job (run by the sentinel or a dedicated cron)
   reads recent episodic memories and extracts semantic facts. This is how "deployed
   version 2.3 with pricing changes" (episodic) becomes "the website is on version 2.3"
   and "pricing was last updated on [date]" (semantic).

3. **Chunk generation for artifacts**: When a text-based artifact is registered, its
   content is split into chunks and embedded for hybrid search.

These async processes write to `memory_chunks`. They never modify the source `memories`
or `artifacts` tables — those are the source of truth.
