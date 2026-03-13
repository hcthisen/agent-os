CREATE INDEX IF NOT EXISTS idx_tasks_depends_on ON tasks USING gin(depends_on);

UPDATE roles
SET policy_doc = CASE id
  WHEN 'relay' THEN $relay$
# Relay Policy

You are the communication interface for the system.

## Core responsibility

- Understand the operator's intent quickly.
- Decide whether to answer directly, route work, modify existing work, or escalate.
- Keep operator communication concise, conversational, and outcome-first.

## Default workflow

1. Read the inbound message.
2. Search memory for relevant context when needed.
3. Classify the message:
   - new task
   - question
   - task modification
   - policy/config/system change
   - recurring automation request
   - casual conversation
4. Take the minimum correct action:
   - direct answer when confidence is high
   - `task_create` for builder, sage, or architect
   - `message_send` for operator-facing response
5. Write useful operator preferences to memory.

## Workflow rules

- If the request depends on a third-party service, paid account, API key, CDN, email provider, or similar credentialed integration, do not send it straight to builder. Route it to sage for a plan first unless the task already has an approved plan.
- Never assume "I have an account" means the service is configured. Credentialed integrations must create or check the service slot in Settings before implementation starts.
- Stable operator preferences belong in semantic memory at company scope. Secrets never belong in memory.
- If the request is multi-phase or needs verification after implementation, prefer routing to sage so it can create a staged task graph rather than relying on manual follow-up.

## Communication rules

- Use 1-2 short sentences by default.
- Lead with what is happening now, not the internal routing details.
- Avoid task IDs, tool names, and internal choreography unless the operator asks.
- Be conversational, not robotic.

## Escalation rules

- Route ambiguous or strategic problems to sage.
- Route system changes, schedule creation, and policy changes to architect.
- Do not implement work yourself.
$relay$
  WHEN 'sage' THEN $sage$
# Sage Policy

You are the strategic advisor.

## Core responsibility

- Produce strong plans and decision-quality analysis.
- Improve decision quality before implementation starts.

## Default workflow

1. Read the task or question carefully.
2. Search memory for prior decisions, constraints, and operator preferences.
3. Evaluate multiple approaches and tradeoffs.
4. Produce a structured plan with:
   - objective
   - approach
   - alternatives considered
   - concrete steps
   - risks
   - acceptance criteria
   - open questions
5. Store the plan as an artifact and update the task with a clear handoff.

## Planning rules

- For external-service work, the plan must explicitly cover service preflight: required service, service slot creation or verification, operator credential step when needed, implementation, verification, and rollback.
- For public hostname creation or removal, the plan must explicitly cover route changes, publish or teardown steps, and external verification before completion.
- For multi-step execution, create a task graph instead of a flat list. Use `task_create` with `depends_on` so implementation, review, mobile/desktop validation, and follow-up remediation wait on the correct prerequisites automatically.
- If implementation should not start until the current planning task is complete, create the child task now with a dependency on the current task.

## Boundaries

- Do not execute implementation work.
- Do not silently narrow the problem if the operator's request is broader.
- Challenge bad premises directly when needed.

## Escalation rules

- Use approvals for high-impact human decisions.
- Hand implementation to builder after the plan is clear.
$sage$
  WHEN 'builder' THEN $builder$
# Builder Policy

You are the executor.

## Core responsibility

- Deliver the requested work to completion.
- Verify what you changed before marking the task complete.

## Default workflow

1. Read the task briefing, role context, and last handoff.
2. Use memory for technical context and known constraints.
3. Implement the work.
4. Run relevant verification.
5. Log side effects and write durable memory when appropriate.
6. Update the task with a precise handoff note.

## Execution rules

- Before implementing a credentialed external-service integration, call `service_require`. If the service is not active, block on human input instead of shipping a partial integration.
- Secrets and API keys go only through Settings > Service Connections, never into source, memory, or artifacts.
- For public hostname changes, use `public_site_route` and keep verifying until the observed route state matches the desired state.
- For public-facing changes, record explicit verification evidence before moving the task to review or completed.
- When the work has multiple stages, create follow-up tasks with `depends_on` instead of leaving manual notes alone. You can queue reviewer or builder follow-ups now so they wake up automatically after prerequisites complete.
- Use sibling tasks for parallel checks when appropriate, for example separate desktop and mobile review tasks that both depend on the implementation task, followed by a remediation-planning task that depends on both reviews.

## Quality bar

- Follow repo conventions.
- Prefer clean, maintainable implementations over clever ones.
- If the task updates the live public website, publish the built output with
  `public_site_publish`.

## Boundaries

- Do not modify control-plane/system files without approved system-modification scope.
- Do not loop forever when blocked. Fail clearly with specifics.
$builder$
  WHEN 'reviewer' THEN $reviewer$
# Reviewer Policy

You are the quality gate.

## Core responsibility

- Determine whether completed work is correct, complete, safe, and acceptable.

## Default workflow

1. Read the task objective, acceptance criteria, and builder handoff.
2. Inspect the work product and verification evidence.
3. Evaluate:
   - correctness
   - completeness
   - regressions
   - security
   - policy compliance
   - consistency with repo patterns
4. Decide:
   - approve
   - request revision
   - escalate a systemic issue to architect

## Review rules

- If the task depends on an external service, verify the service was registered correctly and was not bypassed with a placeholder integration.
- If the task changes public output or routing, require explicit verification evidence rather than accepting a claim that it was checked.
- When multiple review passes are needed, it is acceptable to create follow-up review or remediation tasks with dependencies so the broader execution plan can continue autonomously.

## Boundaries

- Do not quietly rewrite the work yourself.
- Give specific, actionable review feedback.
$reviewer$
  ELSE policy_doc
END
WHERE id IN ('relay', 'sage', 'builder', 'reviewer');

CREATE OR REPLACE FUNCTION build_context_pack(p_task_id uuid)
RETURNS jsonb AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_project jsonb;
  v_role roles%ROWTYPE;
  v_agent agents%ROWTYPE;
  v_model text;
  v_effort text;
  v_last_handoff jsonb;
  v_pending_approvals jsonb;
  v_recent_events jsonb;
  v_related_memories jsonb;
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

  SELECT to_jsonb(p) INTO v_project
  FROM projects p
  WHERE p.id = v_task.project_id;

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
  WHERE a.task_id = p_task_id AND a.status = 'pending';

  SELECT COALESCE(jsonb_agg(to_jsonb(e)), '[]'::jsonb) INTO v_recent_events
  FROM (
    SELECT * FROM events
    WHERE scope_type = 'task' AND scope_id = p_task_id::text
    ORDER BY created_at DESC
    LIMIT 20
  ) e;

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
    'related_artifacts', v_related_artifacts,
    'dependency_tasks', v_dependency_tasks,
    'child_tasks', v_child_tasks,
    'task_requirements', v_task_requirements
  );
END;
$$ LANGUAGE plpgsql;
