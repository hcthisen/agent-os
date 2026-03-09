-- Assembles everything an agent needs to start work on a task.
-- Called by the supervisor before launching a Claude Code process.

CREATE OR REPLACE FUNCTION build_context_pack(p_task_id uuid)
RETURNS jsonb
LANGUAGE plpgsql AS $$
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
  v_related_artifacts jsonb;
BEGIN
  -- Get the task
  SELECT * INTO v_task FROM tasks WHERE id = p_task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task not found: %', p_task_id;
  END IF;

  -- Get the project (if any)
  IF v_task.project_id IS NOT NULL THEN
    SELECT to_jsonb(p) INTO v_project FROM projects p WHERE p.id = v_task.project_id;
  END IF;

  -- Get the role
  SELECT * INTO v_role FROM roles WHERE id = v_task.assigned_role;

  -- Get the agent (if claimed)
  IF v_task.claimed_by IS NOT NULL THEN
    SELECT * INTO v_agent FROM agents WHERE id = v_task.claimed_by;
    -- Check for config overrides
    v_model := COALESCE(v_agent.config->>'model', v_role.model);
    v_effort := COALESCE(v_agent.config->>'effort', v_role.effort);
  ELSE
    v_model := v_role.model;
    v_effort := v_role.effort;
  END IF;

  -- Last handoff for this task
  SELECT to_jsonb(h) INTO v_last_handoff
  FROM handoffs h
  WHERE h.task_id = p_task_id
  ORDER BY h.created_at DESC
  LIMIT 1;

  -- Pending approvals
  SELECT COALESCE(jsonb_agg(to_jsonb(a)), '[]'::jsonb) INTO v_pending_approvals
  FROM approvals a
  WHERE a.task_id = p_task_id AND a.status = 'pending';

  -- Recent events (last 20 scoped to this task)
  SELECT COALESCE(jsonb_agg(to_jsonb(e)), '[]'::jsonb) INTO v_recent_events
  FROM (
    SELECT * FROM events
    WHERE scope_type = 'task' AND scope_id = p_task_id::text
    ORDER BY created_at DESC
    LIMIT 20
  ) e;

  -- Related memories by scope chain: task (all), project (30), role (20), company (10)
  SELECT COALESCE(jsonb_agg(to_jsonb(m)), '[]'::jsonb) INTO v_related_memories
  FROM (
    (
      SELECT * FROM memories
      WHERE scope_type = 'task' AND scope_id = p_task_id::text AND is_active = true
    )
    UNION ALL
    (
      SELECT * FROM memories
      WHERE v_task.project_id IS NOT NULL
        AND scope_type = 'project' AND scope_id = v_task.project_id::text
        AND is_active = true
      ORDER BY created_at DESC
      LIMIT 30
    )
    UNION ALL
    (
      SELECT * FROM memories
      WHERE scope_type = 'role' AND scope_id = v_task.assigned_role
        AND is_active = true
      ORDER BY created_at DESC
      LIMIT 20
    )
    UNION ALL
    (
      SELECT * FROM memories
      WHERE scope_type = 'company' AND is_active = true
      ORDER BY created_at DESC
      LIMIT 10
    )
  ) m;

  -- Related artifacts
  SELECT COALESCE(jsonb_agg(to_jsonb(a)), '[]'::jsonb) INTO v_related_artifacts
  FROM artifacts a
  WHERE a.task_id = p_task_id;

  RETURN jsonb_build_object(
    'task', to_jsonb(v_task),
    'project', v_project,
    'role_policy', v_role.policy_doc,
    'model', v_model,
    'effort', v_effort,
    'last_handoff', v_last_handoff,
    'pending_approvals', v_pending_approvals,
    'recent_events', v_recent_events,
    'related_memories', v_related_memories,
    'related_artifacts', v_related_artifacts
  );
END;
$$;
