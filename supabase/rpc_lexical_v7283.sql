-- ============================================================
-- v7.28.3 — RPC search_tasks_lexical (оптимизированная)
--
-- ПРОБЛЕМА v7.28.2: CROSS JOIN с CTE q замедлял запрос до timeout на 1200 строк.
-- РЕШЕНИЕ: убираем CTE, используем напрямую LOWER(...) LIKE.
-- GIN-индексы gin_trgm_ops на title и description ускоряют ILIKE.
-- ============================================================

DROP FUNCTION IF EXISTS search_tasks_lexical(TEXT, INT, FLOAT);

CREATE OR REPLACE FUNCTION search_tasks_lexical(
  query_text TEXT,
  match_count INT DEFAULT 20,
  min_score FLOAT DEFAULT 0.3
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
  match_kind TEXT,
  similarity FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    t.id, t.title, t.description,
    t.project_id, t.project_name,
    t.responsible_id, t.responsible_name,
    t.status, t.status_label, t.created_at,
    CASE
      WHEN t.title ILIKE '%' || query_text || '%' THEN 'phrase_title'
      WHEN COALESCE(t.description, '') ILIKE '%' || query_text || '%' THEN 'phrase_desc'
      ELSE 'trgm'
    END AS match_kind,
    CASE
      WHEN t.title ILIKE '%' || query_text || '%' THEN 1.0
      WHEN COALESCE(t.description, '') ILIKE '%' || query_text || '%' THEN 0.85
      ELSE GREATEST(
        similarity(t.title, query_text),
        similarity(COALESCE(t.description, ''), query_text)
      ) * 0.4
    END AS similarity
  FROM tasks t
  WHERE
    -- Phrase match (быстро через GIN gin_trgm_ops индекс)
    t.title ILIKE '%' || query_text || '%'
    OR COALESCE(t.description, '') ILIKE '%' || query_text || '%'
    -- Trgm fallback (только если phrase не сработал, и порог высокий)
    OR GREATEST(
      similarity(t.title, query_text),
      similarity(COALESCE(t.description, ''), query_text)
    ) > min_score
  ORDER BY similarity DESC
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION search_tasks_lexical TO anon, authenticated;

COMMENT ON FUNCTION search_tasks_lexical IS 'v7.28.3: упрощённая версия — без CTE, phrase match через ILIKE + GIN gin_trgm_ops индекс. Убрано multi-word scoring (упрощение для скорости). Trgm fallback только для запросов > min_score (0.3).';
