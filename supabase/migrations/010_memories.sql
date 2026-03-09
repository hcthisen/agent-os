CREATE TABLE memories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  layer            memory_layer NOT NULL,
  scope_type       scope_type NOT NULL,
  scope_id         text NOT NULL,
  subject          text NOT NULL,
  content          text NOT NULL,
  tags             text[] NOT NULL DEFAULT '{}',
  source_event_id  uuid REFERENCES events(id),
  source_agent_id  uuid REFERENCES agents(id),
  confidence       real NOT NULL DEFAULT 1.0,
  superseded_by    uuid REFERENCES memories(id),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_memories_scope_active ON memories(scope_type, scope_id) WHERE is_active = true;
CREATE INDEX idx_memories_layer_active ON memories(layer) WHERE is_active = true;
CREATE INDEX idx_memories_subject_trgm ON memories USING gin(subject gin_trgm_ops);
CREATE INDEX idx_memories_tags ON memories USING gin(tags);
