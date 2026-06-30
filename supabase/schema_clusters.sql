-- ============================================================
-- v7.28 — таблица кластеров повторяющихся задач (для 2.2).
-- Заполняется скриптом scripts/cluster-analytics.mjs раз в неделю.
-- ============================================================

CREATE TABLE IF NOT EXISTS task_clusters (
  id              BIGSERIAL PRIMARY KEY,
  cluster_key     TEXT NOT NULL UNIQUE,         -- 'min-id-1234' (min task id in cluster)
  task_ids        BIGINT[] NOT NULL,            -- [1234, 5678, 9012...]
  task_count      INT NOT NULL,
  representative_title TEXT,                     -- title of the smallest-id task
  avg_similarity  FLOAT,                         -- average pairwise sim
  period_start    TIMESTAMPTZ,                   -- earliest created_at in cluster
  period_end      TIMESTAMPTZ,                   -- latest created_at
  detected_at     TIMESTAMPTZ DEFAULT NOW(),
  alert_sent      BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_task_clusters_count ON task_clusters (task_count DESC);
CREATE INDEX IF NOT EXISTS idx_task_clusters_detected ON task_clusters (detected_at DESC);

ALTER TABLE task_clusters DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE task_clusters IS 'v7.28: кластеры повторяющихся задач. Обновляется scripts/cluster-analytics.mjs (cron weekly).';
