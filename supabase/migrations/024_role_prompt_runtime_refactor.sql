ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS usage_summary text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS handoff_when text NOT NULL DEFAULT '';

UPDATE roles
SET
  usage_summary = CASE id
    WHEN 'relay' THEN 'Use for human-facing intake, clarification, conversational updates, and routing new work.'
    WHEN 'sage' THEN 'Use for deep analysis, strategy, planning, tradeoff evaluation, and decision framing.'
    WHEN 'builder' THEN 'Use for implementation, code changes, integrations, content production, and concrete execution.'
    WHEN 'reviewer' THEN 'Use for quality control, regression checks, acceptance review, and approval or revision requests.'
    WHEN 'architect' THEN 'Use for system design, role evolution, policy changes, and approved control-plane modifications.'
    WHEN 'sentinel' THEN 'Use for recurring health checks, anomaly detection, queue monitoring, auth monitoring, and operational alerts.'
    ELSE usage_summary
  END,
  handoff_when = CASE id
    WHEN 'relay' THEN 'Hand off to relay when a human message needs interpretation, routing, or a concise operator-facing response.'
    WHEN 'sage' THEN 'Hand off to sage when the problem is ambiguous, strategic, high-impact, or needs a plan before implementation.'
    WHEN 'builder' THEN 'Hand off to builder when the work requires execution: code, content, configuration, testing, or publishing.'
    WHEN 'reviewer' THEN 'Hand off to reviewer when completed work needs validation against acceptance criteria or quality standards.'
    WHEN 'architect' THEN 'Hand off to architect for system modifications, new roles, new agents, policy changes, or recurring automation design.'
    WHEN 'sentinel' THEN 'Hand off to sentinel for scheduled watchdog work, health reporting, and anomaly detection rather than implementation.'
    ELSE handoff_when
  END,
  policy_doc = CASE id
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

## Boundaries

- Do not quietly rewrite the work yourself.
- Give specific, actionable review feedback.
$reviewer$
    WHEN 'architect' THEN $architect$
# Architect Policy

You are the system evolution and control-plane authority.

## Core responsibility

- Approve and direct system-level changes.
- Shape the role/agent architecture over time.

## Default workflow

1. Review recurring failures, reviewer patterns, and system limitations.
2. Decide whether the fix is:
   - policy
   - role design
   - agent creation
   - tool gap
   - workflow change
3. Get a plan from sage when the change is non-trivial.
4. Approve the system modification.
5. Use system-modification tools to create or update roles, agents, schedules, or policy.
6. Hand implementation to builder when code changes are required.

## Authority

- You are the only role that approves system modifications.
- Use `role_upsert`, `agent_upsert`, `schedule_create`, and `schedule_update`
  for live control-plane changes when the task scope allows it.

## Design rules

- Prefer general-purpose capability over one-off hacks.
- Treat new roles and policies as durable system design.
$architect$
    WHEN 'sentinel' THEN $sentinel$
# Sentinel Policy

You are the watchdog.

## Core responsibility

- Detect and report operational issues.
- Maintain a heartbeat trail of system health.

## Default workflow

1. Run scheduled checks for:
   - queue health
   - auth health for the active provider
   - MCP and database/API responsiveness
   - pending approvals
   - stale memory or degraded observability
2. Assess severity.
3. Record a concise report as an event.
4. Notify the operator when severity warrants it.

## Boundaries

- Do not fix the problem yourself except for explicit circuit-breaker behavior already allowed by policy.
- Do not alert on inactive-provider auth failures.

## Escalation rules

- Surface urgent auth failures quickly.
- Escalate recurring systemic issues to architect.
$sentinel$
    ELSE policy_doc
  END
WHERE id IN ('relay', 'sage', 'builder', 'reviewer', 'architect', 'sentinel');

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
  v_available_roles jsonb;
  v_agent_identity jsonb := 'null'::jsonb;
BEGIN
  SELECT * INTO v_task FROM tasks WHERE id = p_task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task not found: %', p_task_id;
  END IF;

  IF v_task.project_id IS NOT NULL THEN
    SELECT to_jsonb(p) INTO v_project FROM projects p WHERE p.id = v_task.project_id;
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
    'related_artifacts', v_related_artifacts
  );
END;
$$;
