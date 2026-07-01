-- ============================================================
-- v7.28.7 — таблица meetings (для аудио/видео созвонов из NotebookLM)
--
-- Хранит извлечённые через NotebookLM Pro «решения» из аудио/видео.
-- Каждая запись = один созвон/встреча с извлечённым «мясом».
-- Embedding строится по title + decision_text + excerpt.
-- ============================================================

CREATE TABLE IF NOT EXISTS meetings (
  id              BIGSERIAL PRIMARY KEY,
  external_id     TEXT UNIQUE,                 -- ID из NotebookLM или имя файла
  title           TEXT NOT NULL,                -- тема встречи
  meeting_date    TIMESTAMPTZ,                  -- дата проведения
  participants    TEXT[],                       -- ['Константин', 'Александр']
  duration_min    INT,                          -- длительность в минутах (опц.)
  -- Извлечённое «мясо»:
  decision_text   TEXT NOT NULL,                -- главное решение (1-3 абзаца)
  action_items    TEXT[],                       -- ['добавить RLS', 'проверить резервы']
  related_task_ids BIGINT[],                    -- [6956, 7626] — ссылки на задачи Bitrix24
  -- Доп. контекст:
  excerpt         TEXT,                         -- короткий отрывок транскрипции (500-2000 символов)
  tags            TEXT[] DEFAULT '{}',          -- авто-теги (как у задач)
  -- Медиа:
  audio_url       TEXT,                         -- ссылка на аудио в Supabase Storage / Drive
  source_url      TEXT,                         -- ссылка на источник в NotebookLM
  -- Embedding:
  embedding       VECTOR(1536),                 -- OpenAI text-embedding-3-small
  -- Мета:
  imported_at     TIMESTAMPTZ DEFAULT NOW(),
  indexed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_meetings_embedding
  ON meetings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_meetings_title_trgm
  ON meetings USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_meetings_decision_trgm
  ON meetings USING gin (decision_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_meetings_tags ON meetings USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings (meeting_date DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_related ON meetings USING gin (related_task_ids);

ALTER TABLE meetings DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE meetings IS 'v7.28.7: извлечённые из аудио/видео созвонов решения. Источник — NotebookLM Pro (промпт + экспорт в JSON). Embedding по title + decision_text + excerpt.';
