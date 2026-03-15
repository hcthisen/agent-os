GRANT USAGE ON SCHEMA auth TO authenticated;

CREATE OR REPLACE FUNCTION auth.jwt_role()
RETURNS text
LANGUAGE sql STABLE
AS $$ SELECT coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '')::text $$;

CREATE OR REPLACE FUNCTION auth.run_id()
RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb->>'run_id', '')::uuid $$;

CREATE OR REPLACE FUNCTION auth.task_id()
RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb->>'task_id', '')::uuid $$;

CREATE OR REPLACE FUNCTION auth.system_task()
RETURNS boolean
LANGUAGE sql STABLE
AS $$ SELECT coalesce((current_setting('request.jwt.claims', true)::jsonb->>'system_task')::boolean, false) $$;

CREATE OR REPLACE FUNCTION auth.is_system_observer()
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT auth.system_task()
    OR auth.agent_role_id() IN ('architect', 'sentinel')
$$;

CREATE OR REPLACE FUNCTION auth.current_task_project_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT t.project_id
  FROM tasks t
  WHERE t.id = auth.task_id()
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION auth.current_task_customer_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT t.customer_id
  FROM tasks t
  WHERE t.id = auth.task_id()
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION auth.current_task_department_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT t.department_id
  FROM tasks t
  WHERE t.id = auth.task_id()
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION auth.current_task_parent_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT t.parent_task_id
  FROM tasks t
  WHERE t.id = auth.task_id()
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION auth.current_task_depends_on()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT coalesce(t.depends_on, ARRAY[]::uuid[])
  FROM tasks t
  WHERE t.id = auth.task_id()
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION auth.can_access_related_task(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    p_task_id IS NOT NULL
    AND (
      p_task_id = auth.task_id()
      OR p_task_id = auth.current_task_parent_id()
      OR p_task_id = ANY(coalesce(auth.current_task_depends_on(), ARRAY[]::uuid[]))
      OR EXISTS (
        SELECT 1
        FROM tasks child
        WHERE child.parent_task_id = auth.task_id()
          AND child.id = p_task_id
      )
    )
$$;

CREATE OR REPLACE FUNCTION auth.scope_visible(p_scope_type scope_type, p_scope_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT CASE
    WHEN auth.is_system_observer() THEN true
    WHEN p_scope_type = 'company' THEN true
    WHEN p_scope_type = 'role' THEN p_scope_id = auth.agent_role_id()
    WHEN p_scope_type = 'task' THEN auth.task_id() IS NOT NULL AND p_scope_id = auth.task_id()::text
    WHEN p_scope_type = 'project' THEN auth.current_task_project_id() IS NOT NULL AND p_scope_id = auth.current_task_project_id()::text
    WHEN p_scope_type = 'customer' THEN auth.current_task_customer_id() IS NOT NULL AND p_scope_id = auth.current_task_customer_id()
    WHEN p_scope_type = 'department' THEN auth.current_task_department_id() IS NOT NULL AND p_scope_id = auth.current_task_department_id()
    ELSE false
  END
$$;

REVOKE ALL ON FUNCTION decrypt_credential(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION decrypt_credential(text, text) FROM anon;
REVOKE ALL ON FUNCTION decrypt_credential(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION decrypt_credential(text, text) TO service_role;

REVOKE ALL ON FUNCTION encrypt_credential(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION encrypt_credential(text, text) FROM anon;
REVOKE ALL ON FUNCTION encrypt_credential(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION encrypt_credential(text, text) TO service_role;

REVOKE ALL ON FUNCTION get_service_registry_runtime(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_service_registry_runtime(text) FROM anon;
REVOKE ALL ON FUNCTION get_service_registry_runtime(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_service_registry_runtime(text) TO service_role;

CREATE OR REPLACE FUNCTION build_context_pack_runtime(p_task_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF auth.task_id() IS NULL OR p_task_id IS DISTINCT FROM auth.task_id() THEN
    RAISE EXCEPTION 'build_context_pack_runtime is only available for the current task';
  END IF;

  RETURN build_context_pack(p_task_id);
END;
$$;

REVOKE ALL ON FUNCTION build_context_pack(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION build_context_pack(uuid) FROM anon;
REVOKE ALL ON FUNCTION build_context_pack(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION build_context_pack(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION build_context_pack_runtime(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION build_context_pack_runtime(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION latest_task_activity(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION latest_task_activity(text[]) TO service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE memories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE memory_chunks TO authenticated;
GRANT SELECT, INSERT ON TABLE events TO authenticated;
GRANT SELECT, INSERT ON TABLE task_runs TO authenticated;
GRANT SELECT, INSERT ON TABLE artifacts TO authenticated;
GRANT SELECT, INSERT ON TABLE handoffs TO authenticated;
GRANT SELECT, INSERT ON TABLE service_registry TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE schedules TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE roles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE agents TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE projects TO authenticated;
GRANT SELECT ON TABLE system_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public_site_routes TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE task_requirements TO authenticated;

ALTER TABLE public_site_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_requirements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tasks_select_by_role ON tasks;
CREATE POLICY tasks_select_by_role ON tasks
  FOR SELECT USING (
    auth.is_system_observer()
    OR assigned_role = auth.agent_role_id()
    OR auth.can_access_related_task(id)
  );

DROP POLICY IF EXISTS tasks_update_claimed ON tasks;
CREATE POLICY tasks_update_claimed ON tasks
  FOR UPDATE USING (
    auth.is_system_observer()
    OR (claimed_by = auth.agent_id() AND id = auth.task_id())
    OR (state = 'ready' AND assigned_role = auth.agent_role_id())
  )
  WITH CHECK (
    auth.is_system_observer()
    OR (
      claimed_by = auth.agent_id()
      AND (
        id = auth.task_id()
        OR assigned_role = auth.agent_role_id()
      )
    )
  );

DROP POLICY IF EXISTS tasks_insert ON tasks;
CREATE POLICY tasks_insert ON tasks
  FOR INSERT WITH CHECK (
    auth.is_system_observer()
    OR (
      (parent_task_id IS NULL OR auth.can_access_related_task(parent_task_id))
      AND (project_id IS NULL OR project_id = auth.current_task_project_id())
      AND (customer_id IS NULL OR customer_id = auth.current_task_customer_id())
      AND (department_id IS NULL OR department_id = auth.current_task_department_id())
    )
  );

DROP POLICY IF EXISTS memories_select ON memories;
CREATE POLICY memories_select ON memories
  FOR SELECT USING (auth.scope_visible(scope_type, scope_id));

DROP POLICY IF EXISTS memories_insert ON memories;
CREATE POLICY memories_insert ON memories
  FOR INSERT WITH CHECK (
    source_agent_id = auth.agent_id()
    AND auth.scope_visible(scope_type, scope_id)
  );

DROP POLICY IF EXISTS memories_update ON memories;
CREATE POLICY memories_update ON memories
  FOR UPDATE USING (
    source_agent_id = auth.agent_id()
    AND auth.scope_visible(scope_type, scope_id)
  )
  WITH CHECK (
    source_agent_id = auth.agent_id()
    AND auth.scope_visible(scope_type, scope_id)
  );

DROP POLICY IF EXISTS events_insert ON events;
CREATE POLICY events_insert ON events
  FOR INSERT WITH CHECK (
    agent_id = auth.agent_id()
    AND auth.scope_visible(scope_type, scope_id)
  );

DROP POLICY IF EXISTS events_select ON events;
CREATE POLICY events_select ON events
  FOR SELECT USING (auth.scope_visible(scope_type, scope_id));

DROP POLICY IF EXISTS chunks_select ON memory_chunks;
CREATE POLICY chunks_select ON memory_chunks
  FOR SELECT USING (auth.scope_visible(scope_type, scope_id));

DROP POLICY IF EXISTS chunks_insert ON memory_chunks;
CREATE POLICY chunks_insert ON memory_chunks
  FOR INSERT WITH CHECK (auth.scope_visible(scope_type, scope_id));

DROP POLICY IF EXISTS chunks_delete ON memory_chunks;
CREATE POLICY chunks_delete ON memory_chunks
  FOR DELETE USING (auth.scope_visible(scope_type, scope_id));

DROP POLICY IF EXISTS task_runs_select ON task_runs;
CREATE POLICY task_runs_select ON task_runs
  FOR SELECT USING (agent_id = auth.agent_id() OR auth.is_system_observer());

DROP POLICY IF EXISTS task_runs_insert ON task_runs;
CREATE POLICY task_runs_insert ON task_runs
  FOR INSERT WITH CHECK (agent_id = auth.agent_id() OR auth.is_system_observer());

DROP POLICY IF EXISTS artifacts_select ON artifacts;
CREATE POLICY artifacts_select ON artifacts
  FOR SELECT USING (
    auth.is_system_observer()
    OR (task_id IS NOT NULL AND auth.can_access_related_task(task_id))
    OR (project_id IS NOT NULL AND project_id = auth.current_task_project_id())
  );

DROP POLICY IF EXISTS artifacts_insert ON artifacts;
CREATE POLICY artifacts_insert ON artifacts
  FOR INSERT WITH CHECK (
    created_by = auth.agent_id()
    AND (
      auth.is_system_observer()
      OR (task_id IS NOT NULL AND auth.can_access_related_task(task_id))
      OR (project_id IS NOT NULL AND project_id = auth.current_task_project_id())
    )
  );

DROP POLICY IF EXISTS handoffs_select ON handoffs;
CREATE POLICY handoffs_select ON handoffs
  FOR SELECT USING (
    auth.is_system_observer()
    OR auth.can_access_related_task(task_id)
  );

DROP POLICY IF EXISTS handoffs_insert ON handoffs;
CREATE POLICY handoffs_insert ON handoffs
  FOR INSERT WITH CHECK (
    from_agent_id = auth.agent_id()
    AND (
      auth.is_system_observer()
      OR auth.can_access_related_task(task_id)
    )
  );

DROP POLICY IF EXISTS service_registry_select ON service_registry;
CREATE POLICY service_registry_select ON service_registry
  FOR SELECT USING (true);

DROP POLICY IF EXISTS service_registry_insert ON service_registry;
CREATE POLICY service_registry_insert ON service_registry
  FOR INSERT WITH CHECK (
    registered_by = auth.agent_id()
    AND credential IS NULL
  );

DROP POLICY IF EXISTS service_registry_update ON service_registry;
CREATE POLICY service_registry_update ON service_registry
  FOR UPDATE USING (auth.system_task() OR auth.agent_role_id() = 'architect')
  WITH CHECK (auth.system_task() OR auth.agent_role_id() = 'architect');

DROP POLICY IF EXISTS schedules_select ON schedules;
CREATE POLICY schedules_select ON schedules
  FOR SELECT USING (true);

DROP POLICY IF EXISTS schedules_insert ON schedules;
CREATE POLICY schedules_insert ON schedules
  FOR INSERT WITH CHECK (auth.system_task() OR auth.agent_role_id() = 'architect');

DROP POLICY IF EXISTS schedules_update ON schedules;
CREATE POLICY schedules_update ON schedules
  FOR UPDATE USING (auth.system_task() OR auth.agent_role_id() = 'architect')
  WITH CHECK (auth.system_task() OR auth.agent_role_id() = 'architect');

DROP POLICY IF EXISTS roles_select ON roles;
CREATE POLICY roles_select ON roles
  FOR SELECT USING (true);

DROP POLICY IF EXISTS roles_insert ON roles;
CREATE POLICY roles_insert ON roles
  FOR INSERT WITH CHECK (auth.system_task() OR auth.agent_role_id() = 'architect');

DROP POLICY IF EXISTS roles_update ON roles;
CREATE POLICY roles_update ON roles
  FOR UPDATE USING (auth.system_task() OR auth.agent_role_id() = 'architect')
  WITH CHECK (auth.system_task() OR auth.agent_role_id() = 'architect');

DROP POLICY IF EXISTS agents_select ON agents;
CREATE POLICY agents_select ON agents
  FOR SELECT USING (true);

DROP POLICY IF EXISTS agents_insert ON agents;
CREATE POLICY agents_insert ON agents
  FOR INSERT WITH CHECK (auth.system_task() OR auth.agent_role_id() = 'architect');

DROP POLICY IF EXISTS agents_update ON agents;
CREATE POLICY agents_update ON agents
  FOR UPDATE USING (auth.system_task() OR auth.agent_role_id() = 'architect')
  WITH CHECK (auth.system_task() OR auth.agent_role_id() = 'architect');

DROP POLICY IF EXISTS projects_select ON projects;
CREATE POLICY projects_select ON projects
  FOR SELECT USING (true);

DROP POLICY IF EXISTS projects_insert ON projects;
CREATE POLICY projects_insert ON projects
  FOR INSERT WITH CHECK (auth.system_task() OR auth.agent_role_id() = 'architect');

DROP POLICY IF EXISTS projects_update ON projects;
CREATE POLICY projects_update ON projects
  FOR UPDATE USING (auth.system_task() OR auth.agent_role_id() = 'architect')
  WITH CHECK (auth.system_task() OR auth.agent_role_id() = 'architect');

DROP POLICY IF EXISTS system_settings_select ON system_settings;
CREATE POLICY system_settings_select ON system_settings
  FOR SELECT USING (true);

DROP POLICY IF EXISTS public_site_routes_select ON public_site_routes;
CREATE POLICY public_site_routes_select ON public_site_routes
  FOR SELECT USING (true);

DROP POLICY IF EXISTS public_site_routes_insert ON public_site_routes;
CREATE POLICY public_site_routes_insert ON public_site_routes
  FOR INSERT WITH CHECK (
    created_by = auth.agent_id()
    AND (
      auth.is_system_observer()
      OR last_task_id IS NULL
      OR auth.can_access_related_task(last_task_id)
    )
  );

DROP POLICY IF EXISTS public_site_routes_update ON public_site_routes;
CREATE POLICY public_site_routes_update ON public_site_routes
  FOR UPDATE USING (
    auth.is_system_observer()
    OR last_task_id IS NULL
    OR auth.can_access_related_task(last_task_id)
  )
  WITH CHECK (
    auth.is_system_observer()
    OR last_task_id IS NULL
    OR auth.can_access_related_task(last_task_id)
  );

DROP POLICY IF EXISTS task_requirements_select ON task_requirements;
CREATE POLICY task_requirements_select ON task_requirements
  FOR SELECT USING (
    auth.is_system_observer()
    OR auth.can_access_related_task(task_id)
  );

DROP POLICY IF EXISTS task_requirements_insert ON task_requirements;
CREATE POLICY task_requirements_insert ON task_requirements
  FOR INSERT WITH CHECK (
    created_by = auth.agent_id()
    AND (
      auth.is_system_observer()
      OR auth.can_access_related_task(task_id)
    )
  );

DROP POLICY IF EXISTS task_requirements_update ON task_requirements;
CREATE POLICY task_requirements_update ON task_requirements
  FOR UPDATE USING (
    auth.is_system_observer()
    OR auth.can_access_related_task(task_id)
  )
  WITH CHECK (
    auth.is_system_observer()
    OR auth.can_access_related_task(task_id)
  );
