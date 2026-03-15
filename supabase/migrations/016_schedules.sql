CREATE TABLE schedules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text UNIQUE NOT NULL,
  cron_expr     text NOT NULL,
  assigned_role text NOT NULL REFERENCES roles(id),
  task_template jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled       boolean NOT NULL DEFAULT true,
  last_run_at   timestamptz,
  next_run_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Seed sentinel health check schedule (every 30 minutes)
INSERT INTO schedules (name, cron_expr, assigned_role, task_template) VALUES
  ('sentinel-health-check', '*/30 * * * *', 'sentinel', '{
    "title": "Sentinel health check",
    "objective": "Run system health checks: queue depth, cost trends, auth status, service lifecycle context, and memory staleness.",
    "acceptance_criteria": ["Health report event logged"],
    "priority": "normal"
  }'::jsonb);
