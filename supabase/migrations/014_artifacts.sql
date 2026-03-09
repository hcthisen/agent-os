CREATE TABLE artifacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid REFERENCES projects(id),
  task_id       uuid REFERENCES tasks(id),
  artifact_type text NOT NULL,
  name          text NOT NULL,
  storage_path  text,
  external_url  text,
  mime_type     text,
  size_bytes    bigint,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid REFERENCES agents(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_artifacts_project ON artifacts(project_id);
CREATE INDEX idx_artifacts_task ON artifacts(task_id);
CREATE INDEX idx_artifacts_type ON artifacts(artifact_type);
