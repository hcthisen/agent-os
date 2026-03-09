CREATE TABLE approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks(id),
  agent_id    uuid NOT NULL REFERENCES agents(id),
  action_type text NOT NULL,
  description text NOT NULL,
  context     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      approval_status NOT NULL DEFAULT 'pending',
  decided_by  text,
  decided_at  timestamptz,
  reason      text,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_approvals_task ON approvals(task_id);
CREATE INDEX idx_approvals_pending ON approvals(status) WHERE status = 'pending';
