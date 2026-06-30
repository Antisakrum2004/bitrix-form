-- ============================================================
-- v7.28 — колонка tags (для 2.6).
-- tags TEXT[] — 5-6 авто-тегов на задачу (через LLM-классификацию).
-- ============================================================

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks USING gin (tags);

ALTER TABLE tasks ALTER COLUMN tags SET DEFAULT '{}';

COMMENT ON COLUMN tasks.tags IS 'v7.28: авто-теги задач (LLM-классификация). 5-6 тегов на задачу. Примеры: бухгалтерия, интеграции, отчёты, остатки, права, обмен.';
