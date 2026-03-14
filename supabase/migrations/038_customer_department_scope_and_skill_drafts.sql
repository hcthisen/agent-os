ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS customer_id text,
  ADD COLUMN IF NOT EXISTS department_id text;

CREATE INDEX IF NOT EXISTS idx_tasks_customer_scope
  ON tasks(customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_department_scope
  ON tasks(department_id)
  WHERE department_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS skill_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  source_content text NOT NULL DEFAULT '',
  name text NOT NULL,
  display_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  trigger_when text NOT NULL DEFAULT '',
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  required_services text[] NOT NULL DEFAULT ARRAY[]::text[],
  scope_type scope_type NOT NULL DEFAULT 'company',
  scope_id text NOT NULL DEFAULT 'company',
  tags text[] NOT NULL DEFAULT ARRAY['skill']::text[],
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'rejected', 'expired')),
  confirmed_skill_id uuid REFERENCES memories(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  confirmed_by text,
  rejected_at timestamptz,
  rejected_by text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skill_drafts_status_created
  ON skill_drafts(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_skill_drafts_source_message
  ON skill_drafts(source_message_id);

GRANT ALL ON TABLE skill_drafts TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE skill_drafts TO authenticated;

ALTER TABLE skill_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS skill_drafts_select ON skill_drafts;
CREATE POLICY skill_drafts_select ON skill_drafts
  FOR SELECT USING (true);

DROP POLICY IF EXISTS skill_drafts_insert ON skill_drafts;
CREATE POLICY skill_drafts_insert ON skill_drafts
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS skill_drafts_update ON skill_drafts;
CREATE POLICY skill_drafts_update ON skill_drafts
  FOR UPDATE USING (true);

DROP POLICY IF EXISTS memories_select ON memories;
CREATE POLICY memories_select ON memories
  FOR SELECT USING (
    scope_type = 'company'
    OR (scope_type = 'role' AND scope_id = auth.agent_role_id())
    OR scope_type IN ('task', 'project', 'customer', 'department')
  );

DROP POLICY IF EXISTS events_select ON events;
CREATE POLICY events_select ON events
  FOR SELECT USING (
    scope_type = 'company'
    OR (scope_type = 'role' AND scope_id = auth.agent_role_id())
    OR scope_type IN ('task', 'project', 'customer', 'department')
  );

DROP POLICY IF EXISTS chunks_select ON memory_chunks;
CREATE POLICY chunks_select ON memory_chunks
  FOR SELECT USING (
    scope_type = 'company'
    OR (scope_type = 'role' AND scope_id = auth.agent_role_id())
    OR scope_type IN ('task', 'project', 'customer', 'department')
  );

CREATE OR REPLACE FUNCTION build_context_pack(p_task_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_project jsonb := 'null'::jsonb;
  v_role roles%ROWTYPE;
  v_agent agents%ROWTYPE;
  v_model text;
  v_effort text;
  v_last_handoff jsonb := 'null'::jsonb;
  v_recent_events jsonb;
  v_related_memories jsonb;
  v_relevant_skills jsonb;
  v_related_artifacts jsonb;
  v_available_roles jsonb;
  v_agent_identity jsonb := 'null'::jsonb;
  v_task_requirements jsonb;
  v_dependency_tasks jsonb;
  v_child_tasks jsonb;
BEGIN
  SELECT * INTO v_task FROM tasks WHERE id = p_task_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task % not found', p_task_id;
  END IF;

  IF v_task.project_id IS NOT NULL THEN
    SELECT to_jsonb(p) INTO v_project
    FROM projects p
    WHERE p.id = v_task.project_id;
  END IF;

  SELECT * INTO v_role FROM roles WHERE id = v_task.assigned_role;

  IF v_task.claimed_by IS NOT NULL THEN
    SELECT * INTO v_agent FROM agents WHERE id = v_task.claimed_by;
    v_model := COALESCE(v_agent.config->>'model', v_role.model);
    v_effort := COALESCE(v_agent.config->>'effort', v_role.effort);
    SELECT to_jsonb(v_agent) INTO v_agent_identity;
  ELSE
    v_model := v_role.model;
    v_effort := v_role.effort;
  END IF;

  SELECT to_jsonb(h) INTO v_last_handoff
  FROM handoffs h
  WHERE h.task_id = p_task_id
  ORDER BY h.created_at DESC
  LIMIT 1;

  SELECT COALESCE(jsonb_agg(to_jsonb(e)), '[]'::jsonb) INTO v_recent_events
  FROM (
    SELECT *
    FROM events
    WHERE scope_type = 'task'
      AND scope_id = p_task_id::text
    ORDER BY created_at DESC
    LIMIT 20
  ) e;

  SELECT COALESCE(jsonb_agg(to_jsonb(m)), '[]'::jsonb) INTO v_related_memories
  FROM (
    (
      SELECT *
      FROM memories
      WHERE scope_type = 'task'
        AND scope_id = p_task_id::text
        AND is_active = true
    )
    UNION ALL
    (
      SELECT *
      FROM memories
      WHERE v_task.project_id IS NOT NULL
        AND scope_type = 'project'
        AND scope_id = v_task.project_id::text
        AND is_active = true
      ORDER BY created_at DESC
      LIMIT 30
    )
    UNION ALL
    (
      SELECT *
      FROM memories
      WHERE v_task.customer_id IS NOT NULL
        AND scope_type = 'customer'
        AND scope_id = v_task.customer_id
        AND is_active = true
      ORDER BY created_at DESC
      LIMIT 20
    )
    UNION ALL
    (
      SELECT *
      FROM memories
      WHERE v_task.department_id IS NOT NULL
        AND scope_type = 'department'
        AND scope_id = v_task.department_id
        AND is_active = true
      ORDER BY created_at DESC
      LIMIT 20
    )
    UNION ALL
    (
      SELECT *
      FROM memories
      WHERE scope_type = 'role'
        AND scope_id = v_task.assigned_role
        AND is_active = true
      ORDER BY created_at DESC
      LIMIT 20
    )
    UNION ALL
    (
      SELECT *
      FROM memories
      WHERE scope_type = 'company'
        AND is_active = true
      ORDER BY created_at DESC
      LIMIT 10
    )
  ) m;

  SELECT COALESCE(
    jsonb_agg(
      skill_row.skill
      ORDER BY skill_row.scope_rank ASC, skill_row.use_count DESC, skill_row.updated_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_relevant_skills
  FROM (
    SELECT
      parsed.scope_rank,
      parsed.use_count,
      parsed.updated_at,
      jsonb_build_object(
        'id', parsed.id,
        'name', parsed.name,
        'display_name', COALESCE(NULLIF(parsed.payload->>'display_name', ''), parsed.name),
        'description', COALESCE(parsed.payload->>'description', ''),
        'trigger_when', COALESCE(parsed.payload->>'trigger_when', ''),
        'steps',
          CASE
            WHEN jsonb_typeof(parsed.payload->'steps') = 'array' THEN parsed.payload->'steps'
            ELSE '[]'::jsonb
          END,
        'input_schema',
          CASE
            WHEN jsonb_typeof(parsed.payload->'input_schema') = 'object' THEN parsed.payload->'input_schema'
            ELSE '{}'::jsonb
          END,
        'output_schema',
          CASE
            WHEN jsonb_typeof(parsed.payload->'output_schema') = 'object' THEN parsed.payload->'output_schema'
            ELSE '{}'::jsonb
          END,
        'required_services',
          CASE
            WHEN jsonb_typeof(parsed.payload->'required_services') = 'array' THEN parsed.payload->'required_services'
            ELSE '[]'::jsonb
          END,
        'scope_type', parsed.scope_type,
        'scope_id', parsed.scope_id,
        'tags', to_jsonb(COALESCE(parsed.tags, ARRAY[]::text[])),
        'version', parsed.version,
        'last_used_at', NULLIF(parsed.payload->>'last_used_at', ''),
        'use_count', parsed.use_count,
        'is_active', parsed.is_active,
        'created_at', parsed.created_at,
        'updated_at', parsed.updated_at
      ) AS skill
    FROM (
      SELECT
        base.id,
        base.name,
        base.scope_type,
        base.scope_id,
        base.tags,
        base.is_active,
        base.created_at,
        base.updated_at,
        base.payload,
        base.scope_rank,
        CASE
          WHEN COALESCE(base.payload->>'use_count', '') ~ '^[0-9]+$'
            THEN (base.payload->>'use_count')::int
          ELSE 0
        END AS use_count,
        CASE
          WHEN COALESCE(base.payload->>'version', '') ~ '^[0-9]+$'
            THEN GREATEST((base.payload->>'version')::int, 1)
          ELSE 1
        END AS version
      FROM (
        SELECT
          m.id,
          regexp_replace(m.subject, '^skill:', '', 'i') AS name,
          m.scope_type,
          m.scope_id,
          m.tags,
          m.is_active,
          m.created_at,
          m.updated_at,
          try_parse_jsonb(m.content) AS payload,
          CASE
            WHEN m.scope_type = 'project'
              AND v_task.project_id IS NOT NULL
              AND m.scope_id = v_task.project_id::text THEN 1
            WHEN m.scope_type = 'customer'
              AND v_task.customer_id IS NOT NULL
              AND m.scope_id = v_task.customer_id THEN 2
            WHEN m.scope_type = 'department'
              AND v_task.department_id IS NOT NULL
              AND m.scope_id = v_task.department_id THEN 3
            WHEN m.scope_type = 'role'
              AND m.scope_id = v_task.assigned_role THEN 4
            WHEN m.scope_type = 'company' THEN 5
            ELSE 10
          END AS scope_rank
        FROM memories m
        WHERE m.layer = 'procedural'
          AND m.is_active = true
          AND m.tags @> ARRAY['skill']::text[]
          AND (
            (
              v_task.project_id IS NOT NULL
              AND m.scope_type = 'project'
              AND m.scope_id = v_task.project_id::text
            )
            OR (
              v_task.customer_id IS NOT NULL
              AND m.scope_type = 'customer'
              AND m.scope_id = v_task.customer_id
            )
            OR (
              v_task.department_id IS NOT NULL
              AND m.scope_type = 'department'
              AND m.scope_id = v_task.department_id
            )
            OR (m.scope_type = 'role' AND m.scope_id = v_task.assigned_role)
            OR m.scope_type = 'company'
          )
      ) AS base
    ) AS parsed
    ORDER BY parsed.scope_rank ASC, parsed.use_count DESC, parsed.updated_at DESC
    LIMIT 10
  ) AS skill_row;

  SELECT COALESCE(jsonb_agg(to_jsonb(a)), '[]'::jsonb) INTO v_related_artifacts
  FROM artifacts a
  WHERE a.task_id = p_task_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at ASC), '[]'::jsonb)
  INTO v_task_requirements
  FROM task_requirements r
  WHERE r.task_id = p_task_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at ASC), '[]'::jsonb)
  INTO v_dependency_tasks
  FROM tasks t
  WHERE t.id = ANY(v_task.depends_on);

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at ASC), '[]'::jsonb)
  INTO v_child_tasks
  FROM tasks t
  WHERE t.parent_task_id = p_task_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', role_rows.id,
        'display_name', role_rows.display_name,
        'description', role_rows.description,
        'usage_summary', role_rows.usage_summary,
        'handoff_when', role_rows.handoff_when,
        'is_system_role', role_rows.is_system_role,
        'active_agent_count', role_rows.active_agent_count
      )
      ORDER BY role_rows.is_system_role DESC, role_rows.display_name ASC
    ),
    '[]'::jsonb
  )
  INTO v_available_roles
  FROM (
    SELECT
      r.id,
      r.display_name,
      r.description,
      r.usage_summary,
      r.handoff_when,
      r.is_system_role,
      COUNT(a.id) FILTER (WHERE a.status = 'active')::int AS active_agent_count
    FROM roles r
    LEFT JOIN agents a ON a.role_id = r.id
    GROUP BY
      r.id,
      r.display_name,
      r.description,
      r.usage_summary,
      r.handoff_when,
      r.is_system_role
  ) AS role_rows;

  RETURN jsonb_build_object(
    'task', to_jsonb(v_task),
    'project', v_project,
    'role', to_jsonb(v_role),
    'role_policy', v_role.policy_doc,
    'agent_identity', v_agent_identity,
    'available_roles', v_available_roles,
    'model', v_model,
    'effort', v_effort,
    'last_handoff', v_last_handoff,
    'recent_events', v_recent_events,
    'related_memories', v_related_memories,
    'relevant_skills', v_relevant_skills,
    'related_artifacts', v_related_artifacts,
    'dependency_tasks', v_dependency_tasks,
    'child_tasks', v_child_tasks,
    'task_requirements', v_task_requirements
  );
END;
$$;
