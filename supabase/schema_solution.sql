-- ============================================================
-- v7.28 — таблица решений задач (для 2.3).
-- solution_text — извлечённое «что сделали» из последнего комментария исполнителя.
-- Обновляется sync-скриптом, индексируется отдельно.
-- ============================================================

-- Добавляем колонки к существующей таблице tasks
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS solution_text TEXT,
  ADD COLUMN IF NOT EXISTS solution_indexed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS solution_embedding VECTOR(1536);

-- Отдельный HNSW индекс для embedding-ов решений
CREATE INDEX IF NOT EXISTS idx_tasks_solution_embedding
  ON tasks USING hnsw (solution_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- pg_trgm для гибридного поиска по решениям
CREATE INDEX IF NOT EXISTS idx_tasks_solution_trgm
  ON tasks USING gin (solution_text gin_trgm_ops);

COMMENT ON COLUMN tasks.solution_text IS 'v7.28: извлечённый текст решения (обычно последний комментарий исполнителя). NULL если комментариев нет.';
COMMENT ON COLUMN tasks.solution_embedding IS 'v7.28: embedding решения для семантического поиска «как мы чинили X».';
