-- ============================================================
-- v7.28.5 — RPC search_similar_tasks (exclude project_id=48)
--
-- ИЗМЕНЕНИЕ vs v7.28: WHERE t.project_id != 48
-- Причина: проект «Просроченные задачи» (157 шт) — шум, не несёт пользы
-- ============================================================

DROP FUNCTION IF EXISTS search_similar_tasks(VECTOR(1536), FLOAT, INT);
DROP FUNCTION IF EXISTS search_similar_tasks(VECTOR(1536), FLOAT, INT, TEXT);

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
  created_at TIMESTAMPTZ,
  vector_score FLOAT,
  trgm_score FLOAT,
  similarity FLOAT
)
LANGUAGE sql
STABLE
AS $$
  WITH vector_scores AS (
    SELECT
      t.id, t.title, t.description,
      t.project_id, t.project_name,
      t.responsible_id, t.responsible_name,
      t.status, t.status_label, t.created_at,
      1 - (t.embedding <=> query_embedding) AS vec_sim
    FROM tasks t
    WHERE t.embedding IS NOT NULL
      AND 1 - (t.embedding <=> query_embedding) > 0.25
      AND (t.project_id IS NULL OR t.project_id != 48)  -- v7.28.5: exclude "Просроченные задачи"
    ORDER BY t.embedding <=> query_embedding
    LIMIT GREATEST(match_count * 4, 50)
  ),
  trgm_scores AS (
    SELECT
      v.id, v.vec_sim, v.created_at,
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
    v.id, v.title, v.description,
    v.project_id, v.project_name,
    v.responsible_id, v.responsible_name,
    v.status, v.status_label, v.created_at,
    v.vec_sim AS vector_score,
    t.trgm_sim AS trgm_score,
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

GRANT EXECUTE ON FUNCTION search_similar_tasks TO anon, authenticated;

COMMENT ON FUNCTION search_similar_tasks IS 'v7.28.5: same as v7.28 but excludes project_id=48 (Просроченные задачи — noise).';
