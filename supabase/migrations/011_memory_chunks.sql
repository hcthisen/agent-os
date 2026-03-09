CREATE TABLE memory_chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL,       -- 'memory', 'artifact', 'event'
  source_id   uuid NOT NULL,
  scope_type  scope_type NOT NULL,  -- denormalized for fast filtering
  scope_id    text NOT NULL,
  content     text NOT NULL,
  fts         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  embedding   vector(1536),         -- generated asynchronously
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_chunks_fts ON memory_chunks USING gin(fts);
-- Use HNSW instead of IVFFlat: HNSW works on empty tables and doesn't require training data.
CREATE INDEX idx_chunks_embedding ON memory_chunks USING hnsw(embedding vector_cosine_ops);
CREATE INDEX idx_chunks_scope ON memory_chunks(scope_type, scope_id);
