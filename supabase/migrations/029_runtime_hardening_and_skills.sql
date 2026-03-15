ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS max_run_duration_ms integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'roles_max_run_duration_ms_check'
  ) THEN
    ALTER TABLE roles
      ADD CONSTRAINT roles_max_run_duration_ms_check
      CHECK (max_run_duration_ms IS NULL OR max_run_duration_ms > 0);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_memories_procedural_skill_scope
  ON memories(scope_type, scope_id, updated_at DESC)
  WHERE layer = 'procedural'
    AND is_active = true
    AND tags @> ARRAY['skill']::text[];

CREATE OR REPLACE FUNCTION try_parse_jsonb(value text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF value IS NULL OR btrim(value) = '' THEN
    RETURN '{}'::jsonb;
  END IF;

  RETURN value::jsonb;
EXCEPTION
  WHEN others THEN
    RETURN '{}'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION service_registry_encryption_key()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_key text;
BEGIN
  v_key := COALESCE(
    NULLIF(current_setting('app.settings.service_registry_encryption_key', true), ''),
    NULLIF(current_setting('app.settings.jwt_secret', true), '')
  );

  RETURN COALESCE(v_key, '');
END;
$$;

CREATE OR REPLACE FUNCTION looks_encrypted_credential(value text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT value IS NOT NULL
    AND length(trim(value)) >= 40
    AND mod(length(trim(value)), 4) = 0
    AND trim(value) ~ '^[A-Za-z0-9+/=]+$';
$$;

CREATE OR REPLACE FUNCTION encrypt_service_registry_credential()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_key text;
BEGIN
  IF NEW.credential IS NULL OR NEW.credential = '' THEN
    IF TG_OP = 'UPDATE' AND COALESCE(NEW.credential, '') IS DISTINCT FROM COALESCE(OLD.credential, '') THEN
      NEW.updated_at := now();
    END IF;
    RETURN NEW;
  END IF;

  IF looks_encrypted_credential(NEW.credential) THEN
    IF TG_OP = 'UPDATE' AND COALESCE(NEW.credential, '') IS DISTINCT FROM COALESCE(OLD.credential, '') THEN
      NEW.updated_at := now();
    END IF;
    RETURN NEW;
  END IF;

  v_key := service_registry_encryption_key();
  IF v_key = '' THEN
    RETURN NEW;
  END IF;

  NEW.credential := encrypt_credential(NEW.credential, v_key);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_encrypt_service_registry_credential ON service_registry;
CREATE TRIGGER trg_encrypt_service_registry_credential
BEFORE INSERT OR UPDATE OF credential ON service_registry
FOR EACH ROW
EXECUTE FUNCTION encrypt_service_registry_credential();

DO $$
DECLARE
  v_key text;
BEGIN
  v_key := service_registry_encryption_key();
  IF v_key <> '' THEN
    UPDATE service_registry
    SET
      credential = encrypt_credential(credential, v_key),
      updated_at = now()
    WHERE credential IS NOT NULL
      AND credential <> ''
      AND NOT looks_encrypted_credential(credential);
  END IF;
END;
$$;

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
  v_pending_approvals jsonb;
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

  SELECT COALESCE(jsonb_agg(to_jsonb(a)), '[]'::jsonb) INTO v_pending_approvals
  FROM approvals a
  WHERE a.task_id = p_task_id
    AND a.status = 'pending';

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
            WHEN m.scope_type = 'role'
              AND m.scope_id = v_task.assigned_role THEN 2
            WHEN m.scope_type = 'company' THEN 3
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
    'pending_approvals', v_pending_approvals,
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

UPDATE roles
SET policy_doc = policy_doc || E'\n\nTraining guidance:\n- If the operator begins a message with "Remember:", "Always:", "Rule:", or gives a "When...do..." procedure, treat it as explicit training.\n- Also treat recurring scheduled work, repeated operator requests, and proven multi-step workflows as candidates for shared skills.\n- Store durable factual instructions as semantic memory.\n- Store repeatable procedures as shared skills at company scope.\n- Confirm back to the operator exactly what was stored.'
WHERE id = 'relay'
  AND policy_doc NOT LIKE '%Training guidance:%';
