CREATE TABLE events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id   text,
  agent_id   uuid REFERENCES agents(id),
  event_type text NOT NULL,
  severity   event_severity NOT NULL DEFAULT 'info',
  scope_type scope_type NOT NULL,
  scope_id   text NOT NULL,
  summary    text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only: no update/delete policies (enforced by RLS later)

CREATE INDEX idx_events_scope ON events(scope_type, scope_id);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_agent ON events(agent_id);
CREATE INDEX idx_events_created ON events(created_at DESC);
CREATE INDEX idx_events_trace ON events(trace_id);
