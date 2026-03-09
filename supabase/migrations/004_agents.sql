CREATE TABLE agents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text UNIQUE NOT NULL,
  role_id      text NOT NULL REFERENCES roles(id),
  status       agent_status NOT NULL DEFAULT 'active',
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Seed one agent per foundational role
INSERT INTO agents (name, role_id) VALUES
  ('relay-1',     'relay'),
  ('sage-1',      'sage'),
  ('builder-1',   'builder'),
  ('reviewer-1',  'reviewer'),
  ('architect-1', 'architect'),
  ('sentinel-1',  'sentinel');
