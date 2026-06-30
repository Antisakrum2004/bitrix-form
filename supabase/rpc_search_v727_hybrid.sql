-- ============================================================
-- v7.27 HYBRID search: 70% vector + 30% pg_trgm
-- Replaces v7.26 search_similar_tasks.
-- Run via Supabase SQL Editor or `supabase db query --linked`
-- ============================================================

-- Drop old version
DROP FUNCTION IF EXISTS search_similar_tasks(VECTOR(1536), FLOAT, INT);

-- New version: hybrid scoring
CREATE OR REPLACE FUNCTION search_similar_tasks(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.4,
  match_count INT DEFAULT 10,
  query_text TEXT DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT,
  title TEXT,
  description TEXT,
  project_id BIGINT,
  project_name TEXT,
  responsible_id BIGINT,
  responsible_name TEXT,
  status TEXT,
  status_label TEXT,
  vector_score FLOAT,
  trgm_score FLOAT,
  similarity FLOAT
)
LANGUAGE sql
STABLE
AS $$
  WITH vector_scores AS (
    SELECT
      t.id,
      t.title,
      t.description,
      t.project_id,
      t.project_name,
      t.responsible_id,
      t.responsible_name,
      t.status,
      t.status_label,
      1 - (t.embedding <=> query_embedding) AS vec_sim
    FROM tasks t
    WHERE t.embedding IS NOT NULL
      AND 1 - (t.embedding <=> query_embedding) > 0.25  -- pre-filter: vector must be at least 0.25 to be candidate
    ORDER BY t.embedding <=> query_embedding
    LIMIT GREATEST(match_count * 4, 50)  -- take 4x or 50 candidates for re-ranking
  ),
  trgm_scores AS (
    SELECT
      v.id,
      v.vec_sim,
      -- pg_trgm similarity on (title || ' ' || description) vs query_text
      -- If query_text is NULL, fall back to 0 (pure vector mode)
      CASE
        WHEN query_text IS NULL OR query_text = '' THEN 0.0
        ELSE GREATEST(
          similarity(v.title, query_text),
          similarity(COALESCE(v.description, ''), query_text)
        )
      END AS trgm_sim
    FROM vector_scores v
  )
  SELECT
    v.id,
    v.title,
    v.description,
    v.project_id,
    v.project_name,
    v.responsible_id,
    v.responsible_name,
    v.status,
    v.status_label,
    v.vec_sim AS vector_score,
    t.trgm_sim AS trgm_score,
    -- Hybrid: 70% vector + 30% trgm (only if query_text provided)
    CASE
      WHEN query_text IS NULL OR query_text = '' THEN v.vec_sim
      ELSE 0.7 * v.vec_sim + 0.3 * t.trgm_sim
    END AS similarity
  FROM vector_scores v
  JOIN trgm_scores t ON v.id = t.id
  WHERE
    CASE
      WHEN query_text IS NULL OR query_text = '' THEN v.vec_sim
      ELSE 0.7 * v.vec_sim + 0.3 * t.trgm_sim
    END > match_threshold
  ORDER BY
    CASE
      WHEN query_text IS NULL OR query_text = '' THEN v.vec_sim
      ELSE 0.7 * v.vec_sim + 0.3 * t.trgm_sim
    END DESC
  LIMIT match_count;
$$;

-- Grant execute to anon + authenticated
GRANT EXECUTE ON FUNCTION search_similar_tasks TO anon, authenticated;

COMMENT ON FUNCTION search_similar_tasks IS 'v7.27 HYBRID search: 70% vector (cosine) + 30% pg_trgm. Backward-compatible: if query_text is NULL/empty, falls back to pure vector mode (same as v7.26).';
