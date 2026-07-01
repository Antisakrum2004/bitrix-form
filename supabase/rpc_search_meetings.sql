-- ============================================================
-- v7.28.7 — RPC search_meetings (семантический поиск по встречам)
-- Аналог search_similar_tasks для таблицы meetings.
-- ============================================================

CREATE OR REPLACE FUNCTION search_meetings(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.3,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id BIGINT,
  title TEXT,
  decision_text TEXT,
  excerpt TEXT,
  meeting_date TIMESTAMPTZ,
  participants TEXT[],
  duration_min INT,
  action_items TEXT[],
  related_task_ids BIGINT[],
  tags TEXT[],
  audio_url TEXT,
  source_url TEXT,
  external_id TEXT,
  similarity FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    m.id, m.title, m.decision_text, m.excerpt,
    m.meeting_date, m.participants, m.duration_min,
    m.action_items, m.related_task_ids, m.tags,
    m.audio_url, m.source_url, m.external_id,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM meetings m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION search_meetings TO anon, authenticated;

COMMENT ON FUNCTION search_meetings IS 'v7.28.7: семантический поиск по meetings (встречам из NotebookLM). Возвращает top-N по cosine similarity.';
