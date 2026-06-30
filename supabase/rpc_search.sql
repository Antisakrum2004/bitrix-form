-- ============================================================
-- RPC function for semantic search
-- Called via Supabase REST: POST /rest/v1/rpc/search_similar_tasks
-- ============================================================

CREATE OR REPLACE FUNCTION search_similar_tasks(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.5,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id BIGINT,
  title TEXT,
  project_id BIGINT,
  project_name TEXT,
  responsible_id BIGINT,
  responsible_name TEXT,
  status TEXT,
  status_label TEXT,
  similarity FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    t.id,
    t.title,
    t.project_id,
    t.project_name,
    t.responsible_id,
    t.responsible_name,
    t.status,
    t.status_label,
    1 - (t.embedding <=> query_embedding) AS similarity
  FROM tasks t
  WHERE t.embedding IS NOT NULL
    AND 1 - (t.embedding <=> query_embedding) > match_threshold
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Grant execute to anon + authenticated (we use service_role anyway, but for safety)
GRANT EXECUTE ON FUNCTION search_similar_tasks TO anon, authenticated;

COMMENT ON FUNCTION search_similar_tasks IS 'Semantic search over Bitrix24 tasks via pgvector. Returns top-N matches above threshold.';
