DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM agents
    GROUP BY role_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one-agent-per-profile while duplicate role_id values exist in agents.';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_role_id_unique
ON agents(role_id);
