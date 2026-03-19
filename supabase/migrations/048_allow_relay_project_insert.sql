DROP POLICY IF EXISTS projects_insert ON projects;

CREATE POLICY projects_insert ON projects
  FOR INSERT WITH CHECK (
    auth.system_task()
    OR auth.agent_role_id() IN ('architect', 'relay')
  );
