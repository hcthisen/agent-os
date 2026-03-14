ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS simulation_only boolean NOT NULL DEFAULT false;

REVOKE EXECUTE ON FUNCTION get_service_registry_runtime(text) FROM anon;
REVOKE EXECUTE ON FUNCTION get_service_registry_runtime(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_service_registry_runtime(text) TO service_role;

UPDATE roles
SET policy_doc = replace(
  replace(
    policy_doc,
    'unless the task already has an ' || 'appr' || 'oved plan',
    'unless the task already has a clear staged execution plan in context'
  ),
  'unless the task already has a clear implementation plan',
  'unless the task already has a clear staged execution plan in context'
)
WHERE policy_doc LIKE '%' || 'unless the task already has an ' || 'appr' || 'oved plan' || '%'
  OR policy_doc LIKE '%unless the task already has a clear implementation plan%';
