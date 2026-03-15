UPDATE public.roles
SET
  policy_doc = replace(
    replace(
      replace(
        replace(
          policy_doc,
          E'   - MCP and database/API responsiveness\n',
          E'   - service lifecycle context plus database/API responsiveness\n'
        ),
        E'   - pending approvals\n',
        E'   - blocked tasks, queue pressure, and stale memory\n'
      ),
      E'   - stale memory or degraded observability\n',
      E'   - degraded observability or missing usage signals\n'
    ),
    E'- Do not alert on inactive-provider auth failures.\n',
    E'- Do not alert on inactive-provider auth failures.\n- Treat manual-profile services such as MCP as expected idle unless an active task specifically requires them.\n'
  )
WHERE id = 'sentinel';

UPDATE public.schedules
SET task_template = jsonb_set(
  task_template,
  '{objective}',
  to_jsonb('Run system health checks: queue depth, cost trends, auth status, service lifecycle context, and memory staleness.'::text)
)
WHERE name = 'sentinel-health-check'
  AND task_template ->> 'objective' ILIKE '%approval expiry%';
