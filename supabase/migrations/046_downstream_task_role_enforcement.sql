CREATE OR REPLACE FUNCTION satisfy_parent_downstream_task_requirement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_role text;
  matched_expected_role boolean;
BEGIN
  IF NEW.parent_task_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT NULLIF(expected->>'recommended_role', '')
  INTO expected_role
  FROM task_requirements
  WHERE task_id = NEW.parent_task_id
    AND requirement_type = 'downstream_task'
    AND required_for_completion = true
    AND status IN ('pending', 'failed', 'blocked')
  ORDER BY created_at ASC
  LIMIT 1;

  matched_expected_role :=
    expected_role IS NULL OR NEW.assigned_role = expected_role;

  UPDATE task_requirements
  SET
    status = CASE
      WHEN matched_expected_role THEN 'passed'
      ELSE 'failed'
    END,
    updated_at = now(),
    last_result = jsonb_strip_nulls(
      jsonb_build_object(
        'assigned_role', NEW.assigned_role,
        'child_task_id', NEW.id,
        'child_task_title', NEW.title,
        'expected_role', expected_role,
        'matched_expected_role', matched_expected_role,
        'recorded_at', now(),
        'passed_at', CASE WHEN matched_expected_role THEN now() ELSE NULL END
      )
    )
  WHERE task_id = NEW.parent_task_id
    AND requirement_type = 'downstream_task'
    AND required_for_completion = true
    AND status IN ('pending', 'failed', 'blocked');

  RETURN NEW;
END;
$$;

UPDATE roles
SET policy_doc = policy_doc || E'\n\n## Relay execution-role contract\n\n- When the routing objective names a recommended downstream role, the first required child task must use that exact role.\n- Do not open another planning-only child task when the operator has already supplied the missing execution inputs and the recommended role is an implementation role such as builder or architect.'
WHERE id = 'relay'
  AND policy_doc NOT LIKE '%## Relay execution-role contract%';
