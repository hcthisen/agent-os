ALTER TABLE task_requirements
  DROP CONSTRAINT IF EXISTS chk_task_requirements_type;

ALTER TABLE task_requirements
  ADD CONSTRAINT chk_task_requirements_type CHECK (
    requirement_type IN ('service_active', 'public_route', 'url_status', 'downstream_task')
  );

CREATE OR REPLACE FUNCTION satisfy_parent_downstream_task_requirement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.parent_task_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE task_requirements
  SET
    status = 'passed',
    updated_at = now(),
    last_result = jsonb_build_object(
      'assigned_role', NEW.assigned_role,
      'child_task_id', NEW.id,
      'child_task_title', NEW.title,
      'passed_at', now()
    )
  WHERE task_id = NEW.parent_task_id
    AND requirement_type = 'downstream_task'
    AND required_for_completion = true
    AND status IN ('pending', 'failed', 'blocked');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_satisfy_parent_downstream_task_requirement ON tasks;
CREATE TRIGGER trg_satisfy_parent_downstream_task_requirement
AFTER INSERT ON tasks
FOR EACH ROW
EXECUTE FUNCTION satisfy_parent_downstream_task_requirement();

UPDATE roles
SET policy_doc = policy_doc || E'\n\n## Execution-routing rules\n\n- If an inbound message is asking the system to perform work, and especially if it matches a shared skill, direct response alone is not sufficient.\n- Create at least one downstream child task for the appropriate execution role before you complete the relay task.\n- Reference the matched skill by name in the downstream task objective so the execution role can reuse the stored procedure.\n- When downstream work is required, any operator reply should be a brief acknowledgement of work in progress, not a false claim that the work is already done.'
WHERE id = 'relay'
  AND policy_doc NOT LIKE '%## Execution-routing rules%';
