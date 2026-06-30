-- ============================================================
-- v7.28 — RPC cluster_repeated_tasks()
-- Возвращает top кластеров повторяющихся задач (pairwise sim ≥ 0.75).
-- Жадная кластеризация на стороне БД (быстрее, чем 1200 RPC из Node.js).
--
-- Использование:
--   SELECT * FROM cluster_repeated_tasks(0.75, 5);
--   -- threshold=0.75, min_size=5
-- ============================================================

CREATE OR REPLACE FUNCTION cluster_repeated_tasks(
  sim_threshold FLOAT DEFAULT 0.75,
  min_cluster_size INT DEFAULT 2,
  max_clusters INT DEFAULT 50
)
RETURNS TABLE (
  cluster_key TEXT,
  task_ids BIGINT[],
  task_count INT,
  representative_title TEXT,
  avg_similarity FLOAT,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  WITH pairs AS (
    SELECT
      LEAST(a.id, b.id) AS id_low,
      GREATEST(a.id, b.id) AS id_high,
      1 - (a.embedding <=> b.embedding) AS sim,
      a.id AS a_id, b.id AS b_id,
      a.title AS a_title, b.title AS b_title,
      a.created_at AS a_created, b.created_at AS b_created
    FROM tasks a
    JOIN tasks b ON a.id < b.id
    WHERE a.embedding IS NOT NULL
      AND b.embedding IS NOT NULL
      AND 1 - (a.embedding <=> b.embedding) >= sim_threshold
  ),
  -- Кластер = все задачи, связанные через любую пару (transitive closure через UNION-FIND в виде recursive CTE)
  edges AS (
    SELECT id_low AS x, id_high AS y, sim FROM pairs
    UNION ALL
    SELECT id_high AS x, id_low AS y, sim FROM pairs
  ),
  -- Простой жадный подход: для каждой задачи берём её «соседей» и считаем кластер как
  -- (задача + все её соседи). Это не транзитивное замыкание, но для детектора повторов
  -- этого достаточно — мы ищем «звёзды» вокруг задачи, а не компоненты связности.
  star_clusters AS (
    SELECT
      e.x AS anchor_id,
      ARRAY_AGG(DISTINCT e.y) AS neighbor_ids,
      COUNT(DISTINCT e.y) AS neighbor_count,
      AVG(e.sim) AS avg_sim
    FROM edges e
    GROUP BY e.x
  ),
  clusters AS (
    SELECT
      sc.anchor_id,
      -- Полный список = anchor + соседи
      ARRAY_APPEND(sc.neighbor_ids, sc.anchor_id) AS all_ids,
      sc.neighbor_count + 1 AS cluster_size,
      sc.avg_sim,
      t.title AS rep_title,
      MIN(c2.created_at) AS p_start,
      MAX(c2.created_at) AS p_end
    FROM star_clusters sc
    JOIN tasks t ON t.id = sc.anchor_id
    JOIN tasks c2 ON c2.id = ANY(ARRAY_APPEND(sc.neighbor_ids, sc.anchor_id))
    WHERE sc.neighbor_count + 1 >= min_cluster_size
    GROUP BY sc.anchor_id, sc.neighbor_ids, sc.neighbor_count, sc.avg_sim, t.title
  )
  SELECT
    'min-' || (ARRAY_AGG(id ORDER BY id ASC))[1]::TEXT AS cluster_key,
    ARRAY_AGG(DISTINCT id ORDER BY id) AS task_ids,
    COUNT(DISTINCT id) AS task_count,
    MAX(rep_title) AS representative_title,
    AVG(avg_sim) AS avg_similarity,
    MIN(p_start) AS period_start,
    MAX(p_end) AS period_end
  FROM (
    SELECT
      UNNEST(all_ids) AS id,
      all_ids,
      rep_title,
      avg_sim,
      p_start,
      p_end,
      -- dedup key: минимальный id в кластере
      (SELECT MIN(x) FROM UNNEST(all_ids) AS x) AS dedup_key
    FROM clusters
  ) z
  GROUP BY dedup_key
  ORDER BY task_count DESC
  LIMIT max_clusters;
$$;

GRANT EXECUTE ON FUNCTION cluster_repeated_tasks TO anon, authenticated;

COMMENT ON FUNCTION cluster_repeated_tasks IS 'v7.28: жадная кластеризация задач по смысловой близости (sim ≥ threshold). Возвращает top-50 кластеров для алертинга о повторяющихся проблемах.';
