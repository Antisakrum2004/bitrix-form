-- ============================================================
-- v7.28.1 — RPC search_tasks_lexical
-- Чистый лексический поиск через pg_trgm (без векторов).
-- Используется как fallback в search.html когда семантика
-- не находит задачи с точным совпадением слов (FTP, номенклатура).
--
-- Запуск через Supabase SQL Editor или Management API.
-- ============================================================

CREATE OR REPLACE FUNCTION search_tasks_lexical(
  query_text TEXT,
  match_count INT DEFAULT 20,
  min_trgm_score FLOAT DEFAULT 0.1
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
  trgm_title FLOAT,
  trgm_desc FLOAT,
  similarity FLOAT
)
LANGUAGE sql
STABLE
AS $$
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
    t.created_at,
    similarity(t.title, query_text) AS trgm_title,
    similarity(COALESCE(t.description, ''), query_text) AS trgm_desc,
    -- Финальный score: max(title, desc) — если слово есть в одном из мест, задача релевантна
    GREATEST(
      similarity(t.title, query_text),
      similarity(COALESCE(t.description, ''), query_text)
    ) AS similarity
  FROM tasks t
  WHERE
    -- Фильтр: хотя бы в одном месте trgm-схожесть > min_trgm_score
    GREATEST(
      similarity(t.title, query_text),
      similarity(COALESCE(t.description, ''), query_text)
    ) > min_trgm_score
  ORDER BY
    GREATEST(
      similarity(t.title, query_text),
      similarity(COALESCE(t.description, ''), query_text)
    ) DESC
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION search_tasks_lexical TO anon, authenticated;

COMMENT ON FUNCTION search_tasks_lexical IS 'v7.28.1: чистый лексический поиск через pg_trgm. Возвращает задачи где query_text совпадает по триграммам с title или description. Используется как fallback когда семантический поиск не находит точных совпадений (короткие аббревиатуры FTP, точные термины номенклатура и т.п.).';
