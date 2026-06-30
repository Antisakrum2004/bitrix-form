-- ============================================================
-- v7.28.2 — RPC search_tasks_lexical (переписанная версия)
--
-- ПРОБЛЕМА v7.28.1: чистый pg_trgm similarity давал ложные совпадения
-- для коротких запросов (FTP, НДС) — находил задачи где слова вообще нет,
-- но триграммы случайно пересекались. Порог 0.05 пропускал мусор.
--
-- РЕШЕНИЕ: многоуровневый scoring:
--   1. Exact phrase в title          → 1.00 (100%)
--   2. Exact phrase в description    → 0.85 (85%)
--   3. Все слова из query в title/desc (multi-word) → 0.70 (70%)
--   4. Хотя бы половина слов         → 0.50 (50%)
--   5. Trgm fallback (только если > 0.3) → 0.4 * trgm (макс ~16%)
--
-- ФИЛЬТР: показываем только задачи, где:
--   - точная фраза есть в title или description, ИЛИ
--   - все слова из query присутствуют (для multi-word), ИЛИ
--   - trgm similarity > 0.3 (высокий порог — отсекает мусор)
-- ============================================================

DROP FUNCTION IF EXISTS search_tasks_lexical(TEXT, INT, FLOAT);

CREATE OR REPLACE FUNCTION search_tasks_lexical(
  query_text TEXT,
  match_count INT DEFAULT 20,
  min_score FLOAT DEFAULT 0.3  -- повышен порог для trgm fallback
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
  WITH q AS (
    SELECT
      LOWER(TRIM(query_text)) AS ql,
      -- Разбиваем на слова (учитываем кириллицу и латиницу)
      array_remove(string_to_array(LOWER(TRIM(query_text)), ' '), '') AS words,
      array_length(string_to_array(LOWER(TRIM(query_text)), ' '), 1) AS word_count
  ),
  scored AS (
    SELECT
      t.id, t.title, t.description,
      t.project_id, t.project_name,
      t.responsible_id, t.responsible_name,
      t.status, t.status_label, t.created_at,
      q.ql, q.words, q.word_count,
      -- Phrase matching (case-insensitive)
      (LOWER(t.title) LIKE '%' || q.ql || '%') AS phrase_in_title,
      (LOWER(COALESCE(t.description, '')) LIKE '%' || q.ql || '%') AS phrase_in_desc,
      -- Word-level matching: сколько слов из query есть в title или description
      (
        SELECT COUNT(*) FROM unnest(q.words) AS w
        WHERE LOWER(t.title) LIKE '%' || w || '%'
           OR LOWER(COALESCE(t.description, '')) LIKE '%' || w || '%'
      ) AS word_hits,
      -- Trigram similarity (для fallback)
      GREATEST(
        similarity(t.title, q.ql),
        similarity(COALESCE(t.description, ''), q.ql)
      ) AS trgm_sim
    FROM tasks t, q
  )
  SELECT
    s.id, s.title, s.description,
    s.project_id, s.project_name,
    s.responsible_id, s.responsible_name,
    s.status, s.status_label, s.created_at,
    CASE
      WHEN s.phrase_in_title THEN 'phrase_title'
      WHEN s.phrase_in_desc THEN 'phrase_desc'
      WHEN s.word_count > 1 AND s.word_hits = s.word_count THEN 'all_words'
      WHEN s.word_count > 1 AND s.word_hits >= CEIL(s.word_count / 2.0) THEN 'half_words'
      ELSE 'trgm'
    END AS match_kind,
    CASE
      WHEN s.phrase_in_title THEN 1.0
      WHEN s.phrase_in_desc THEN 0.85
      WHEN s.word_count > 1 AND s.word_hits = s.word_count THEN 0.70
      WHEN s.word_count > 1 AND s.word_hits >= CEIL(s.word_count / 2.0) THEN 0.50
      ELSE s.trgm_sim * 0.4  -- fallback: максимум 0.4 * 1.0 = 40%
    END AS similarity
  FROM scored s
  WHERE
    -- ФИЛЬТР: показываем только реальные совпадения
    s.phrase_in_title
    OR s.phrase_in_desc
    OR (s.word_count > 1 AND s.word_hits >= CEIL(s.word_count / 2.0))
    OR s.trgm_sim > min_score
  ORDER BY similarity DESC
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION search_tasks_lexical TO anon, authenticated;

COMMENT ON FUNCTION search_tasks_lexical IS 'v7.28.2: лексический поиск с многоуровневым scoring. Phrase match (100%/85%) > all words (70%) > half words (50%) > trgm fallback (max 40%). Исправляет ложные срабатывания v7.28.1 на коротких запросах (FTP, НДС).';
