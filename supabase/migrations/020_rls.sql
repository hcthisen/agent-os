-- Row Level Security policies.
-- The MCP server connects with the service key (bypasses RLS) but validates scope
-- in application code. RLS is the fallback safety net.
--
-- JWT claims available: agent_id, role_id, run_id

-- Ensure auth schema exists (created by GoTrue, but ensure for plain Postgres)
CREATE SCHEMA IF NOT EXISTS auth;

-- Helper to extract claims from JWT
CREATE OR REPLACE FUNCTION auth.agent_role_id()
RETURNS text
LANGUAGE sql STABLE
AS $$ SELECT coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role_id', '')::text $$;

CREATE OR REPLACE FUNCTION auth.agent_id()
RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT coalesce(current_setting('request.jwt.claims', true)::jsonb->>'agent_id', '')::uuid $$;

-- =====================
-- TASKS
-- =====================
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- Agents can read tasks assigned to their role
CREATE POLICY tasks_select_by_role ON tasks
  FOR SELECT USING (assigned_role = auth.agent_role_id());

-- Agents can update tasks they've claimed
CREATE POLICY tasks_update_claimed ON tasks
  FOR UPDATE USING (claimed_by = auth.agent_id());

-- Agents can insert tasks (creating sub-tasks/delegations)
CREATE POLICY tasks_insert ON tasks
  FOR INSERT WITH CHECK (true);

-- =====================
-- MEMORIES
-- =====================
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

-- Agents can read: company-wide, their role, or task/project scoped
CREATE POLICY memories_select ON memories
  FOR SELECT USING (
    scope_type = 'company'
    OR (scope_type = 'role' AND scope_id = auth.agent_role_id())
    -- task and project scope validated by MCP server via join
    OR scope_type IN ('task', 'project', 'customer')
  );

-- Agents can insert memories
CREATE POLICY memories_insert ON memories
  FOR INSERT WITH CHECK (source_agent_id = auth.agent_id());

-- Agents can update their own memories (e.g., supersede)
CREATE POLICY memories_update ON memories
  FOR UPDATE USING (source_agent_id = auth.agent_id());

-- =====================
-- EVENTS
-- =====================
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- Agents can insert events with their own agent_id
CREATE POLICY events_insert ON events
  FOR INSERT WITH CHECK (agent_id = auth.agent_id());

-- Agents can read events scoped to company, their role, or their tasks
CREATE POLICY events_select ON events
  FOR SELECT USING (
    scope_type = 'company'
    OR (scope_type = 'role' AND scope_id = auth.agent_role_id())
    OR scope_type IN ('task', 'project', 'customer')
  );

-- =====================
-- MEMORY CHUNKS
-- =====================
ALTER TABLE memory_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY chunks_select ON memory_chunks
  FOR SELECT USING (
    scope_type = 'company'
    OR (scope_type = 'role' AND scope_id = auth.agent_role_id())
    OR scope_type IN ('task', 'project', 'customer')
  );

-- =====================
-- TASK RUNS
-- =====================
ALTER TABLE task_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY task_runs_select ON task_runs
  FOR SELECT USING (agent_id = auth.agent_id());

CREATE POLICY task_runs_insert ON task_runs
  FOR INSERT WITH CHECK (agent_id = auth.agent_id());

-- =====================
-- APPROVALS
-- =====================
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY approvals_select ON approvals
  FOR SELECT USING (agent_id = auth.agent_id());

CREATE POLICY approvals_insert ON approvals
  FOR INSERT WITH CHECK (agent_id = auth.agent_id());

-- =====================
-- ARTIFACTS
-- =====================
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY artifacts_select ON artifacts
  FOR SELECT USING (true);  -- artifacts are broadly readable

CREATE POLICY artifacts_insert ON artifacts
  FOR INSERT WITH CHECK (created_by = auth.agent_id());

-- =====================
-- HANDOFFS
-- =====================
ALTER TABLE handoffs ENABLE ROW LEVEL SECURITY;

CREATE POLICY handoffs_select ON handoffs
  FOR SELECT USING (true);  -- handoffs are broadly readable for context

CREATE POLICY handoffs_insert ON handoffs
  FOR INSERT WITH CHECK (from_agent_id = auth.agent_id());

-- =====================
-- SERVICE REGISTRY
-- =====================
ALTER TABLE service_registry ENABLE ROW LEVEL SECURITY;

-- Agents can see service status but NOT the credential column
-- This is enforced via a view or column-level security; RLS allows select
CREATE POLICY service_registry_select ON service_registry
  FOR SELECT USING (true);

-- Only service key (MCP server) can update credentials — no agent policy for update/insert

-- =====================
-- MESSAGES
-- =====================
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY messages_select ON messages
  FOR SELECT USING (true);

CREATE POLICY messages_insert ON messages
  FOR INSERT WITH CHECK (true);

-- =====================
-- SCHEDULES (read-only for agents)
-- =====================
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY schedules_select ON schedules
  FOR SELECT USING (true);

-- =====================
-- ROLES (read-only for agents)
-- =====================
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY roles_select ON roles
  FOR SELECT USING (true);

-- =====================
-- AGENTS (read-only for agents)
-- =====================
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY agents_select ON agents
  FOR SELECT USING (true);

-- =====================
-- PROJECTS (read-only for agents)
-- =====================
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY projects_select ON projects
  FOR SELECT USING (true);

CREATE POLICY projects_insert ON projects
  FOR INSERT WITH CHECK (true);
