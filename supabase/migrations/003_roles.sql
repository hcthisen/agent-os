CREATE TABLE roles (
  id            text PRIMARY KEY,
  display_name  text NOT NULL,
  description   text NOT NULL DEFAULT '',
  policy_doc    text NOT NULL DEFAULT '',
  model         text NOT NULL DEFAULT 'opus',
  effort        text NOT NULL DEFAULT 'high',
  max_concurrent_tasks integer NOT NULL DEFAULT 3,
  requires_approval_for jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_system_role boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Seed six foundational roles
INSERT INTO roles (id, display_name, description, model, effort, is_system_role) VALUES
  ('relay',     'Relay',     'Communication interface. Classifies intent and routes to the right agent.', 'haiku',  'medium', true),
  ('sage',      'Sage',      'Strategic advisor. Thinks deeply, plans carefully, never executes.',        'opus',   'high',   true),
  ('builder',   'Builder',   'General-purpose executor. Writes code, content, and integrations.',         'opus',   'high',   true),
  ('reviewer',  'Reviewer',  'Quality gate. Reviews completed work against acceptance criteria.',         'opus',   'high',   true),
  ('architect', 'Architect', 'System self-improvement. Approves system modifications.',                   'opus',   'high',   true),
  ('sentinel',  'Sentinel',  'Watchdog. Monitors queue health, cost, auth, and services.',                'sonnet', 'high',   true);
