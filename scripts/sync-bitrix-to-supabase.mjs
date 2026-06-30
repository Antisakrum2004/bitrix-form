/**
 * Sync Bitrix24 tasks → Supabase with OpenAI embeddings
 * ============================================================
 * Usage:
 *   node scripts/sync-bitrix-to-supabase.mjs
 *
 * Required env (set in shell or .env.local):
 *   BITRIX24_WEBHOOK     - https://1c-cms.bitrix24.ru/rest/116/xxx/
 *   OPENAI_API_KEY       - sk-...
 *   SUPABASE_URL         - https://nopccnooivztriqdkbie.supabase.co
 *   SUPABASE_SERVICE_KEY - eyJ... (service_role key)
 *
 * Filters:
 *   - Tasks created since 2026-01-01
 *   - Pagination 50 per request to Bitrix24
 *   - Embedding batches of 100 (OpenAI limit: 2048)
 *   - Upsert (ON CONFLICT id) — safe to re-run
 *
 * Rollback:
 *   DELETE FROM tasks; — clears all synced data
 * ============================================================
 */

// ─── Config ──────────────────────────────────────────────────────────────
const BITRIX_WEBHOOK = process.env.BITRIX24_WEBHOOK;
const OPENAI_KEY     = process.env.OPENAI_API_KEY;
const SUPA_URL       = process.env.SUPABASE_URL || 'https://nopccnooivztriqdkbie.supabase.co';
const SUPA_KEY       = process.env.SUPABASE_SERVICE_KEY;

const SINCE_DATE  = '2026-01-01';
const PAGE_SIZE   = 50;
const EMBED_BATCH = 100;
const DELAY_MS    = 200;

// Bitrix24 status mapping (matches ai-search/route.ts)
const STATUS_MAP = {
  '-1': 'Просрочена', '-2': 'Отклонена', '-3': 'Ждёт контроля',
  '1': 'Новая', '2': 'В работе', '3': 'Ожидает',
  '4': 'Завершена', '5': 'Отложена', '6': 'Принята', '7': 'На проверке',
};

// Projects map (from index.html PROJS, including v7.24 id86)
const PROJS_MAP = {
  '78': 'Backlog', '6': 'Бигап', '32': 'Дакар', '66': 'Иванов',
  '36': 'Медицина КЗ', '4': 'Живое пиво', '20': 'ВДЛ', '50': 'Белолапотко',
  '42': 'ИТ Контроль', '62': 'Нейс Юг', '18': 'Самокаты', '70': 'МАРКЕТДЖЕТ',
  '72': 'Керамика', '52': 'ОПТИМАПЛАСТ', '86': 'id86',
};

// Devs map (from index.html DEVS — for responsible name lookup)
const DEVS_MAP = {
  '18': 'Константин', '38': 'Александр', '54': 'Саша', '82': 'Тимур',
  '92': 'Елена', '98': 'Ольга', '156': 'Марина', '116': 'АМ', '1': 'ВМ',
};

// ─── Helpers ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getResponsibleName(id, taskObj) {
  const idStr = String(id || '');
  if (DEVS_MAP[idStr]) return DEVS_MAP[idStr];
  if (taskObj?.responsible?.name) return taskObj.responsible.name;
  return `User #${idStr}`;
}

// ─── Bitrix24 fetch with pagination ──────────────────────────────────────
async function fetchAllTasks() {
  const all = [];
  let start = 0;
  let total = null;

  console.log(`Fetching tasks from Bitrix24 (created >= ${SINCE_DATE})...`);

  while (true) {
    const url = `${BITRIX_WEBHOOK}tasks.task.list`;
    const body = {
      order: { CREATED_DATE: 'desc' },
      filter: {
        '>CREATED_DATE': SINCE_DATE,
      },
      start,
      select: [
        'ID', 'TITLE', 'DESCRIPTION', 'STATUS',
        'RESPONSIBLE_ID', 'GROUP_ID',
        'CREATED_DATE', 'CHANGED_DATE',
      ],
      params: { NAV_PARAMS: { nPageSize: PAGE_SIZE } },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Bitrix24 ${res.status}: ${txt.slice(0, 300)}`);
    }

    const data = await res.json();
    const tasks = data?.result?.tasks || [];

    if (total === null) total = data?.total || tasks.length;
    all.push(...tasks);
    console.log(`  +${tasks.length} (total fetched: ${all.length} / ${total})`);

    if (tasks.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
    await sleep(150); // Bitrix24 rate limit safety
  }

  return all;
}

// ─── OpenAI embeddings (batched) ─────────────────────────────────────────
async function getEmbeddings(texts) {
  // texts: array of strings, up to 100 items
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: texts,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 300)}`);
  }

  const data = await res.json();
  // Sort by index (OpenAI returns in order, but be safe)
  return data.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding);
}

// ─── Supabase REST upsert (no SDK needed) ────────────────────────────────
async function supaUpsert(rows) {
  // POST to /rest/v1/tasks with Prefer header for upsert
  const url = `${SUPA_URL}/rest/v1/tasks?on_conflict=id`;
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
    throw new Error(`Supabase upsert ${res.status}: ${txt.slice(0, 500)}`);
  }
}

async function supaCount() {
  const url = `${SUPA_URL}/rest/v1/tasks?select=*`;
  const res = await fetch(url, {
    method: 'HEAD',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Prefer': 'count=exact',
    },
  });

  if (!res.ok) return null;
  const count = res.headers.get('content-range');
  // Format: "0-9/1234"
  if (count && count.includes('/')) {
    return Number(count.split('/')[1]);
  }
  return null;
}

// ─── Main sync ───────────────────────────────────────────────────────────
async function main() {
  // Validate env
  const missing = [];
  if (!BITRIX_WEBHOOK) missing.push('BITRIX24_WEBHOOK');
  if (!OPENAI_KEY)     missing.push('OPENAI_API_KEY');
  if (!SUPA_URL)       missing.push('SUPABASE_URL');
  if (!SUPA_KEY)       missing.push('SUPABASE_SERVICE_KEY');
  if (missing.length) {
    console.error('Missing env vars:', missing.join(', '));
    console.error('Set them in shell: export BITRIX24_WEBHOOK=... && ...');
    process.exit(1);
  }

  console.log('=== Bitrix24 → Supabase sync ===');
  console.log(`Supabase URL: ${SUPA_URL}`);
  console.log(`Since: ${SINCE_DATE}`);
  console.log('');

  // 1. Fetch all tasks
  const tasks = await fetchAllTasks();
  console.log(`\nTotal tasks to index: ${tasks.length}\n`);

  if (tasks.length === 0) {
    console.log('Nothing to index. Done.');
    return;
  }

  // 2. Prepare rows (strip HTML, build text for embedding)
  const rows = tasks.map(t => {
    const id = Number(t.id || t.ID);
    const title = t.title || t.TITLE || '';
    const descRaw = t.description || t.DESCRIPTION || '';
    const desc = stripHtml(descRaw);
    const status = String(t.status || t.STATUS || '');
    const respId = Number(t.responsibleId || t.RESPONSIBLE_ID || 0);
    const groupId = Number(t.groupId || t.GROUP_ID || 0);

    // Text for embedding: title + description (limit to ~8000 chars for OpenAI)
    const embedText = (title + '\n' + desc).slice(0, 8000);

    return {
      id,
      title,
      description: desc,
      project_id: groupId || null,
      project_name: PROJS_MAP[String(groupId)] || null,
      responsible_id: respId || null,
      responsible_name: getResponsibleName(respId, t),
      status,
      status_label: STATUS_MAP[status] || `Статус ${status}`,
      created_at: t.createdDate || t.CREATED_DATE || null,
      updated_at: t.changedDate || t.CHANGED_DATE || null,
      embed_text: embedText,
    };
  });

  // 3. Get embeddings in batches
  console.log('Generating embeddings...');
  const allEmbeddings = [];

  for (let i = 0; i < rows.length; i += EMBED_BATCH) {
    const batch = rows.slice(i, i + EMBED_BATCH);
    const texts = batch.map(r => r.embed_text || r.title);
    const batchNum = Math.floor(i / EMBED_BATCH) + 1;
    const totalBatches = Math.ceil(rows.length / EMBED_BATCH);
    console.log(`  batch ${batchNum}/${totalBatches} (${batch.length} texts)`);

    try {
      const embs = await getEmbeddings(texts);
      allEmbeddings.push(...embs);
    } catch (err) {
      console.error(`Embedding batch failed at offset ${i}:`, err.message);
      // Fill with nulls so we still insert rows but mark them as needing re-index
      for (let j = 0; j < batch.length; j++) allEmbeddings.push(null);
    }

    await sleep(DELAY_MS);
  }

  const successCount = allEmbeddings.filter(Boolean).length;
  console.log(`\nGot ${successCount} embeddings (out of ${rows.length})\n`);

  // 4. Upsert to Supabase
  console.log('Upserting to Supabase...');

  // Build rows for insert (skip embed_text, add embedding as array for pgvector)
  const insertRows = rows.map((r, i) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    project_id: r.project_id,
    project_name: r.project_name,
    responsible_id: r.responsible_id,
    responsible_name: r.responsible_name,
    status: r.status,
    status_label: r.status_label,
    created_at: r.created_at,
    updated_at: r.updated_at,
    embedding: allEmbeddings[i],  // pgvector accepts array via REST
    indexed_at: new Date().toISOString(),
  }));

  // Upsert in batches of 200
  const UPSERT_BATCH = 200;
  let inserted = 0;

  for (let i = 0; i < insertRows.length; i += UPSERT_BATCH) {
    const batch = insertRows.slice(i, i + UPSERT_BATCH);
    try {
      await supaUpsert(batch);
      inserted += batch.length;
      console.log(`  upserted ${inserted} / ${insertRows.length}`);
    } catch (err) {
      console.error(`Upsert batch ${i} failed:`, err.message);
    }
    await sleep(100);
  }

  console.log(`\n✓ Done. ${inserted} tasks indexed in Supabase.`);

  // 5. Verify
  const count = await supaCount();
  if (count !== null) {
    console.log(`Supabase tasks table now has ${count} rows.`);
  } else {
    console.log('Could not verify count (Supabase HEAD request failed).');
  }
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
