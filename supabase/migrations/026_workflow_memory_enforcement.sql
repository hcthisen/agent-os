CREATE TABLE task_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requirement_type text NOT NULL,
  target text NOT NULL,
  expected jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  required_for_completion boolean NOT NULL DEFAULT true,
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES agents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_task_requirements_type CHECK (
    requirement_type IN ('service_active', 'public_route', 'url_status')
  ),
  CONSTRAINT chk_task_requirements_status CHECK (
    status IN ('pending', 'passed', 'failed', 'blocked')
  ),
  CONSTRAINT uq_task_requirement UNIQUE (task_id, requirement_type, target)
);

CREATE INDEX idx_task_requirements_task ON task_requirements(task_id);
CREATE INDEX idx_task_requirements_task_status ON task_requirements(task_id, status);

CREATE TABLE public_site_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname text NOT NULL UNIQUE,
  target_path text,
  desired_state text NOT NULL DEFAULT 'active',
  observed_state text NOT NULL DEFAULT 'pending',
  last_http_status integer,
  last_verified_url text,
  last_verified_at timestamptz,
  last_error text,
  last_task_id uuid REFERENCES tasks(id),
  created_by uuid REFERENCES agents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_public_site_routes_desired CHECK (
    desired_state IN ('active', 'removed')
  ),
  CONSTRAINT chk_public_site_routes_observed CHECK (
    observed_state IN ('pending', 'active', 'removed', 'error')
  )
);

CREATE INDEX idx_public_site_routes_task ON public_site_routes(last_task_id);
CREATE INDEX idx_public_site_routes_state ON public_site_routes(desired_state, observed_state);

CREATE OR REPLACE FUNCTION enforce_task_state_machine()
RETURNS TRIGGER AS $$
DECLARE
  valid boolean := false;
  requirement_record record;
  service_status_value text;
BEGIN
  NEW.updated_at := now();

  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;

  CASE OLD.state
    WHEN 'backlog' THEN
      valid := NEW.state IN ('ready', 'failed');
    WHEN 'ready' THEN
      valid := NEW.state IN ('claimed', 'backlog');
    WHEN 'claimed' THEN
      valid := NEW.state IN ('running', 'ready');
    WHEN 'running' THEN
      valid := NEW.state IN ('blocked_on_human', 'blocked_on_agent', 'in_review', 'completed', 'failed');
    WHEN 'blocked_on_human' THEN
      valid := NEW.state IN ('running', 'ready', 'failed');
    WHEN 'blocked_on_agent' THEN
      valid := NEW.state IN ('running', 'ready', 'failed');
    WHEN 'in_review' THEN
      valid := NEW.state IN ('completed', 'running', 'failed');
    WHEN 'completed' THEN
      valid := false;
    WHEN 'failed' THEN
      valid := NEW.state IN ('ready', 'dead_letter');
    WHEN 'dead_letter' THEN
      valid := NEW.state IN ('ready');
    ELSE
      valid := false;
  END CASE;

  IF NOT valid THEN
    RAISE EXCEPTION 'Invalid task state transition: % -> %', OLD.state, NEW.state;
  END IF;

  IF OLD.state IN ('running', 'blocked_on_human', 'blocked_on_agent', 'failed')
     AND NEW.last_handoff_note IS NULL THEN
    RAISE EXCEPTION 'Handoff note required when transitioning from % state', OLD.state;
  END IF;

  IF NEW.state IN ('blocked_on_human', 'blocked_on_agent')
     AND NEW.blocked_reason IS NULL THEN
    RAISE EXCEPTION 'blocked_reason required when entering % state', NEW.state;
  END IF;

  IF NEW.state IN ('in_review', 'completed') THEN
    FOR requirement_record IN
      SELECT *
      FROM task_requirements
      WHERE task_id = NEW.id
        AND required_for_completion = true
      ORDER BY created_at ASC
    LOOP
      IF requirement_record.requirement_type = 'service_active' THEN
        SELECT status
        INTO service_status_value
        FROM service_registry
        WHERE service_name = requirement_record.target
        LIMIT 1;

        IF service_status_value IS DISTINCT FROM 'active' THEN
          RAISE EXCEPTION
            'Task completion blocked: required service "%" is not active',
            requirement_record.target;
        END IF;
      ELSIF requirement_record.status IS DISTINCT FROM 'passed' THEN
        RAISE EXCEPTION
          'Task completion blocked: requirement "%" for "%" is %',
          requirement_record.requirement_type,
          requirement_record.target,
          requirement_record.status;
      END IF;
    END LOOP;
  END IF;

  IF NEW.state = 'claimed' AND OLD.state != 'claimed' THEN
    NEW.claimed_at := now();
  END IF;

  IF NEW.state = 'running' AND OLD.state = 'claimed' THEN
    NEW.started_at := now();
  END IF;

  IF NEW.state = 'completed' THEN
    NEW.completed_at := now();
  END IF;

  IF NEW.state = 'failed' THEN
    NEW.attempt_count := OLD.attempt_count + 1;
    IF NEW.attempt_count >= NEW.max_attempts THEN
      NEW.state := 'dead_letter';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hybrid_memory_search(
  query_text text,
  query_embedding vector(1536) DEFAULT NULL,
  filter_scope_type scope_type DEFAULT NULL,
  filter_scope_id text DEFAULT NULL,
  match_limit integer DEFAULT 20,
  rrf_k integer DEFAULT 60
)
RETURNS TABLE (
  chunk_id uuid,
  chunk_source_type text,
  chunk_source_id uuid,
  chunk_scope_type scope_type,
  chunk_scope_id text,
  chunk_content text,
  rrf_score double precision
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH eligible_chunks AS (
    SELECT mc.*
    FROM memory_chunks mc
    LEFT JOIN memories m
      ON mc.source_type = 'memory'
     AND m.id = mc.source_id
    WHERE (filter_scope_type IS NULL OR mc.scope_type = filter_scope_type)
      AND (filter_scope_id IS NULL OR mc.scope_id = filter_scope_id)
      AND (
        mc.source_type <> 'memory'
        OR (m.id IS NOT NULL AND m.is_active = true)
      )
  ),
  fts_results AS (
    SELECT
      mc.id,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(mc.fts, websearch_to_tsquery('english', query_text)) DESC
      ) AS rank_pos
    FROM eligible_chunks mc
    WHERE mc.fts @@ websearch_to_tsquery('english', query_text)
    LIMIT match_limit * 2
  ),
  vec_results AS (
    SELECT
      mc.id,
      ROW_NUMBER() OVER (ORDER BY mc.embedding <=> query_embedding) AS rank_pos
    FROM eligible_chunks mc
    WHERE query_embedding IS NOT NULL
      AND mc.embedding IS NOT NULL
    ORDER BY mc.embedding <=> query_embedding
    LIMIT match_limit * 2
  ),
  all_ids AS (
    SELECT id FROM fts_results
    UNION
    SELECT id FROM vec_results
  ),
  scored AS (
    SELECT
      a.id,
      (
        COALESCE(1.0 / (rrf_k + f.rank_pos), 0.0) +
        COALESCE(1.0 / (rrf_k + v.rank_pos), 0.0)
      )::double precision AS score
    FROM all_ids a
    LEFT JOIN fts_results f ON f.id = a.id
    LEFT JOIN vec_results v ON v.id = a.id
  )
  SELECT
    mc.id AS chunk_id,
    mc.source_type AS chunk_source_type,
    mc.source_id AS chunk_source_id,
    mc.scope_type AS chunk_scope_type,
    mc.scope_id AS chunk_scope_id,
    mc.content AS chunk_content,
    s.score AS rrf_score
  FROM scored s
  JOIN eligible_chunks mc ON mc.id = s.id
  ORDER BY s.score DESC
  LIMIT match_limit;
END;
$$;

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
    'task_requirements', v_task_requirements
  );
END;
$$ LANGUAGE plpgsql;
