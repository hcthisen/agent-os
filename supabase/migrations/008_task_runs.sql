CREATE TABLE task_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES tasks(id),
  agent_id      uuid NOT NULL REFERENCES agents(id),
  trace_id      text UNIQUE NOT NULL,
  status        text NOT NULL DEFAULT 'started',
  context_pack  jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome       jsonb,
  handoff_note  text,
  model_used    text NOT NULL,
  effort_used   text NOT NULL,
  error_message text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_task_runs_task ON task_runs(task_id);
CREATE INDEX idx_task_runs_agent ON task_runs(agent_id);
CREATE INDEX idx_task_runs_trace ON task_runs(trace_id);
