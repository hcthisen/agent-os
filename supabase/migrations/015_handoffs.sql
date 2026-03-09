CREATE TABLE handoffs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          uuid NOT NULL REFERENCES tasks(id),
  from_agent_id    uuid NOT NULL REFERENCES agents(id),
  to_agent_id      uuid REFERENCES agents(id),
  to_role_id       text REFERENCES roles(id),
  summary          text NOT NULL,
  changes_made     jsonb NOT NULL DEFAULT '[]'::jsonb,
  blockers         jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_steps       jsonb NOT NULL DEFAULT '[]'::jsonb,
  context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_handoffs_task ON handoffs(task_id);
CREATE INDEX idx_handoffs_to_agent ON handoffs(to_agent_id);
CREATE INDEX idx_handoffs_to_role ON handoffs(to_role_id);
