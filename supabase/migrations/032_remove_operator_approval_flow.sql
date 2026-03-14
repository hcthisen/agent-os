UPDATE roles
SET requires_approval_for = '[]'::jsonb
WHERE requires_approval_for IS DISTINCT FROM '[]'::jsonb;

UPDATE approvals
SET
  status = 'approved',
  decided_at = now(),
  decided_by = COALESCE(decided_by, 'system'),
  reason = COALESCE(NULLIF(reason, ''), 'Autonomous execution policy enabled.')
WHERE status = 'pending';

UPDATE tasks
SET
  state = 'ready',
  blocked_reason = NULL,
  last_handoff_note = COALESCE(
    NULLIF(last_handoff_note, ''),
    'Returned to execution queue after manual execution gates were removed.'
  ),
  updated_at = now()
WHERE state = 'blocked_on_human';

UPDATE roles
SET
  usage_summary = CASE id
    WHEN 'reviewer' THEN 'Use for quality control, regression checks, acceptance review, and revision requests.'
    WHEN 'architect' THEN 'Use for system design, role evolution, policy changes, and control-plane modifications.'
    ELSE usage_summary
  END,
  policy_doc = replace(
    replace(
      replace(
        replace(
          policy_doc,
          'Use approvals for high-impact human decisions.',
          'Route high-impact decisions to the appropriate role and ask the operator only when required facts, intent, or credentials are missing.'
        ),
        'Do not modify control-plane/system files without approved system-modification scope.',
        'Do not modify control-plane/system files unless that work is explicitly in scope.'
      ),
      'unless the task already has an approved plan',
      'unless the task already has a clear implementation plan'
    ),
    '   - pending approvals',
    '   - blocked tasks, queue pressure, and stale observability'
  )
WHERE
  id IN ('reviewer', 'architect')
  OR policy_doc LIKE '%Use approvals for high-impact human decisions.%'
  OR policy_doc LIKE '%approved system-modification scope.%'
  OR policy_doc LIKE '%unless the task already has an approved plan%'
  OR policy_doc LIKE '%   - pending approvals%';

UPDATE system_settings
SET
  value = jsonb_build_object(
    'content',
    replace(
      replace(
        replace(
          COALESCE(value->>'content', ''),
          'approval_request',
          'task_create'
        ),
        'pending_approvals',
        'recent_events'
      ),
      'Pending Approvals',
      'Task Queue'
    )
  ),
  updated_at = now()
WHERE key = 'agent_instructions_override'
  AND COALESCE(value->>'content', '') <> '';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'schedules'
      AND column_name = 'objective'
  ) THEN
    EXECUTE $sql$
      UPDATE schedules
      SET objective = regexp_replace(
        objective,
        'approval expiry,?\s*',
        '',
        'gi'
      )
      WHERE objective ILIKE '%approval expiry%'
    $sql$;
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
