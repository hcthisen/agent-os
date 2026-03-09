-- Hybrid memory search using Reciprocal Rank Fusion (RRF)
-- Combines full-text search and vector similarity search.
-- Falls back to FTS-only when no embedding is provided.

CREATE OR REPLACE FUNCTION hybrid_memory_search(
  query_text text,
  query_embedding vector(1536) DEFAULT NULL,
  filter_scope_type scope_type DEFAULT NULL,
  filter_scope_id text DEFAULT NULL,
  match_limit integer DEFAULT 20,
  rrf_k integer DEFAULT 60
)
RETURNS TABLE (
  chunk_id uuid,
  chunk_source_type text,
  chunk_source_id uuid,
  chunk_scope_type scope_type,
  chunk_scope_id text,
  chunk_content text,
  rrf_score double precision
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH fts_results AS (
    SELECT
      mc.id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(mc.fts, websearch_to_tsquery('english', query_text)) DESC) AS rank_pos
    FROM memory_chunks mc
    WHERE mc.fts @@ websearch_to_tsquery('english', query_text)
      AND (filter_scope_type IS NULL OR mc.scope_type = filter_scope_type)
      AND (filter_scope_id IS NULL OR mc.scope_id = filter_scope_id)
    LIMIT match_limit * 2
  ),
  vec_results AS (
    SELECT
      mc.id,
      ROW_NUMBER() OVER (ORDER BY mc.embedding <=> query_embedding) AS rank_pos
    FROM memory_chunks mc
    WHERE query_embedding IS NOT NULL
      AND mc.embedding IS NOT NULL
      AND (filter_scope_type IS NULL OR mc.scope_type = filter_scope_type)
      AND (filter_scope_id IS NULL OR mc.scope_id = filter_scope_id)
    ORDER BY mc.embedding <=> query_embedding
    LIMIT match_limit * 2
  ),
  all_ids AS (
    SELECT id FROM fts_results
    UNION
    SELECT id FROM vec_results
  ),
  scored AS (
    SELECT
      a.id,
      COALESCE(1.0 / (rrf_k + f.rank_pos), 0.0) +
      COALESCE(1.0 / (rrf_k + v.rank_pos), 0.0) AS score
    FROM all_ids a
    LEFT JOIN fts_results f ON f.id = a.id
    LEFT JOIN vec_results v ON v.id = a.id
  )
  SELECT
    mc.id AS chunk_id,
    mc.source_type AS chunk_source_type,
    mc.source_id AS chunk_source_id,
    mc.scope_type AS chunk_scope_type,
    mc.scope_id AS chunk_scope_id,
    mc.content AS chunk_content,
    s.score AS rrf_score
  FROM scored s
  JOIN memory_chunks mc ON mc.id = s.id
  ORDER BY s.score DESC
  LIMIT match_limit;
END;
$$;
