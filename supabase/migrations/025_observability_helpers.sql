CREATE OR REPLACE FUNCTION latest_task_activity(p_task_ids text[])
RETURNS TABLE (
  scope_id text,
  summary text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (e.scope_id)
    e.scope_id,
    e.summary,
    e.created_at
  FROM events e
  WHERE e.scope_type = 'task'
    AND e.event_type IN ('task.heartbeat', 'task.started')
    AND e.scope_id = ANY(COALESCE(p_task_ids, ARRAY[]::text[]))
  ORDER BY e.scope_id, e.created_at DESC;
$$;
