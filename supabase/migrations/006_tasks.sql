CREATE TABLE tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid REFERENCES projects(id),
  parent_task_id        uuid REFERENCES tasks(id),
  title                 text NOT NULL,
  objective             text NOT NULL DEFAULT '',
  acceptance_criteria   jsonb NOT NULL DEFAULT '[]'::jsonb,
  state                 task_state NOT NULL DEFAULT 'backlog',
  priority              task_priority NOT NULL DEFAULT 'normal',
  assigned_role         text NOT NULL REFERENCES roles(id),
  claimed_by            uuid REFERENCES agents(id),
  claimed_at            timestamptz,
  attempt_count         integer NOT NULL DEFAULT 0,
  max_attempts          integer NOT NULL DEFAULT 3,
  blocked_reason        text,
  depends_on            uuid[] NOT NULL DEFAULT '{}',
  requires_approval     boolean NOT NULL DEFAULT false,
  is_system_modification boolean NOT NULL DEFAULT false,
  last_handoff_note     text,
  due_at                timestamptz,
  started_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_state ON tasks(state);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_claimed_by ON tasks(claimed_by);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_priority_state ON tasks(priority, state);
