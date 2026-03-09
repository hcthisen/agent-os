-- Task state machine enforced by BEFORE UPDATE trigger.
-- This is the authoritative enforcement — application code is secondary.

CREATE OR REPLACE FUNCTION enforce_task_state_machine()
RETURNS TRIGGER AS $$
DECLARE
  valid boolean := false;
BEGIN
  -- Always update timestamp
  NEW.updated_at := now();

  -- If state hasn't changed, allow the update (other field edits)
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;

  -- Validate transition
  CASE OLD.state
    WHEN 'backlog' THEN
      valid := NEW.state IN ('ready', 'failed');
    WHEN 'ready' THEN
      valid := NEW.state IN ('claimed', 'backlog');
    WHEN 'claimed' THEN
      valid := NEW.state IN ('running', 'ready');
    WHEN 'running' THEN
      valid := NEW.state IN ('blocked_on_human', 'blocked_on_agent', 'in_review', 'completed', 'failed');
    WHEN 'blocked_on_human' THEN
      valid := NEW.state IN ('running', 'ready', 'failed');
    WHEN 'blocked_on_agent' THEN
      valid := NEW.state IN ('running', 'ready', 'failed');
    WHEN 'in_review' THEN
      valid := NEW.state IN ('completed', 'running', 'failed');
    WHEN 'completed' THEN
      valid := false; -- terminal state
    WHEN 'failed' THEN
      valid := NEW.state IN ('ready', 'dead_letter');
    WHEN 'dead_letter' THEN
      valid := NEW.state IN ('ready'); -- human override only
    ELSE
      valid := false;
  END CASE;

  IF NOT valid THEN
    RAISE EXCEPTION 'Invalid task state transition: % -> %', OLD.state, NEW.state;
  END IF;

  -- Require handoff note when leaving running, blocked, or failed states
  IF OLD.state IN ('running', 'blocked_on_human', 'blocked_on_agent', 'failed')
     AND NEW.last_handoff_note IS NULL THEN
    RAISE EXCEPTION 'Handoff note required when transitioning from % state', OLD.state;
  END IF;

  -- Require blocked_reason when entering blocked states
  IF NEW.state IN ('blocked_on_human', 'blocked_on_agent')
     AND NEW.blocked_reason IS NULL THEN
    RAISE EXCEPTION 'blocked_reason required when entering % state', NEW.state;
  END IF;

  -- Set claimed_at when entering claimed
  IF NEW.state = 'claimed' AND OLD.state != 'claimed' THEN
    NEW.claimed_at := now();
  END IF;

  -- Set started_at when entering running (from claimed only)
  IF NEW.state = 'running' AND OLD.state = 'claimed' THEN
    NEW.started_at := now();
  END IF;

  -- Set completed_at when entering completed
  IF NEW.state = 'completed' THEN
    NEW.completed_at := now();
  END IF;

  -- Increment attempt_count when entering failed
  IF NEW.state = 'failed' THEN
    NEW.attempt_count := OLD.attempt_count + 1;
    -- Auto-route to dead_letter if max_attempts reached
    IF NEW.attempt_count >= NEW.max_attempts THEN
      NEW.state := 'dead_letter';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_task_state_machine
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION enforce_task_state_machine();
