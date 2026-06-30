/**
 * scripts/cluster-analytics.mjs — детектор повторяющихся проблем (2.2).
 *
 * Алгоритм (v7.28 — на стороне БД через RPC cluster_repeated_tasks):
 *   1. Вызываем Supabase RPC cluster_repeated_tasks(0.75, 2, 100)
 *   2. Сохраняем топ-100 кластеров в таблицу task_clusters (UPSERT по cluster_key)
 *   3. Если кластер за последний месяц вырос до ≥5 задач и alert_sent=FALSE — алерт в stdout
 *
 * Запуск:
 *   node scripts/cluster-analytics.mjs
 *
 * Cron: еженедельно (воскресенье 06:00 МСК = суббота 22:00 UTC).
 */
import fs from 'node:fs';

// Load env
const envPath = '/home/z/my-project/scripts/.env.local';
if (fs.existsSync(envPath)) {
  const envText = fs.readFileSync(envPath, 'utf8');
  const env = {};
  envText.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx < 0) return;
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    process.env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
}

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPA_URL || !SUPA_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

// ─── Config ─────────────────────────────────────────────────────────────
const SIM_THRESHOLD = parseFloat(process.env.CLUSTER_THRESHOLD || '0.75');
const MIN_SIZE = 2;
const MAX_CLUSTERS = 100;
const ALERT_THRESHOLD = 5;
const ALERT_PERIOD_DAYS = 30;

// ─── Helpers ────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function supaRpc(fn, body) {
  const url = `${SUPA_URL}/rest/v1/rpc/${fn}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase RPC ${fn} ${res.status}: ${txt.slice(0, 500)}`);
  }
  return res.json();
}

async function supaUpsert(table, rows, onConflict) {
  const url = `${SUPA_URL}/rest/v1/${table}?on_conflict=${onConflict}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Upsert ${table} ${res.status}: ${txt.slice(0, 500)}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(60));
  console.log('cluster-analytics v7.28 — детектор повторяющихся проблем');
  console.log('═'.repeat(60));
  console.log(`Supabase: ${SUPA_URL}`);
  console.log(`Threshold: ${SIM_THRESHOLD}, min_size: ${MIN_SIZE}, alert: ≥${ALERT_THRESHOLD} за ${ALERT_PERIOD_DAYS} дней`);

  const t0 = Date.now();

  // 1. Вызвать RPC
  console.log('\n→ Кластеризация через RPC cluster_repeated_tasks...');
  const clusters = await supaRpc('cluster_repeated_tasks', {
    sim_threshold: SIM_THRESHOLD,
    min_cluster_size: MIN_SIZE,
    max_clusters: MAX_CLUSTERS,
  });
  console.log(`  получено ${clusters.length} кластеров`);
  if (!clusters.length) {
    console.log('Кластеров нет — выходим.');
    return;
  }

  // 2. Сохранить в task_clusters
  console.log('\n→ Upsert в task_clusters...');
  const rows = clusters.map(c => ({
    cluster_key: c.cluster_key,
    task_ids: c.task_ids,
    task_count: c.task_count,
    representative_title: c.representative_title,
    avg_similarity: c.avg_similarity,
    period_start: c.period_start,
    period_end: c.period_end,
    detected_at: new Date().toISOString(),
  }));

  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    try {
      await supaUpsert('task_clusters', batch, 'cluster_key');
      console.log(`  upserted ${Math.min(i + BATCH, rows.length)} / ${rows.length}`);
    } catch (e) {
      console.error(`  upsert batch ${i} failed:`, e.message);
    }
    await sleep(100);
  }

  // 3. Алерты
  const since = new Date(Date.now() - ALERT_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const alerts = clusters.filter(c =>
    c.task_count >= ALERT_THRESHOLD &&
    c.period_end && new Date(c.period_end) >= since
  );

  console.log('');
  console.log('═'.repeat(60));
  console.log(`ТОП-10 кластеров (по размеру):`);
  console.log('═'.repeat(60));
  clusters.sort((a, b) => b.task_count - a.task_count);
  clusters.slice(0, 10).forEach(c => {
    const sim = Math.round((c.avg_similarity || 0) * 100);
    const start = (c.period_start || '').slice(0, 10);
    const end = (c.period_end || '').slice(0, 10);
    console.log(`  [${c.cluster_key}] ${String(c.task_count).padStart(3)} задач · ${sim}% · ${start}→${end} · ${(c.representative_title || '').slice(0, 60)}`);
  });

  if (alerts.length) {
    console.log('');
    console.log('═'.repeat(60));
    console.log(`⚠ АЛЕРТЫ: ${alerts.length} кластеров с ≥${ALERT_THRESHOLD} задач за последние ${ALERT_PERIOD_DAYS} дней`);
    console.log('═'.repeat(60));
    alerts.sort((a, b) => b.task_count - a.task_count);
    alerts.forEach(c => {
      console.log(`\n[${c.cluster_key}] ${c.task_count} задач, avg sim=${Math.round((c.avg_similarity || 0) * 100)}%`);
      console.log(`  заголовок: ${c.representative_title}`);
      console.log(`  период: ${(c.period_start || '').slice(0, 10)} → ${(c.period_end || '').slice(0, 10)}`);
      console.log(`  IDs: ${c.task_ids.slice(0, 15).join(', ')}${c.task_ids.length > 15 ? '…' : ''}`);
    });
    console.log('\n→ Рекомендация: рассмотреть root cause, возможно стоит завести отдельную задачу на системное исправление.');
  } else {
    console.log(`\n✓ Кластеров с ≥${ALERT_THRESHOLD} задач за последние ${ALERT_PERIOD_DAYS} дней — нет.`);
  }

  console.log(`\nГотово за ${((Date.now() - t0) / 1000).toFixed(1)}с`);
}

main().catch(err => {
  console.error('Cluster analytics failed:', err);
  process.exit(1);
});
