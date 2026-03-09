CREATE TABLE projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL,
  display_name text NOT NULL,
  description  text NOT NULL DEFAULT '',
  repo_url     text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
