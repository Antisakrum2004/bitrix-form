/**
 * scripts/sync-solutions.mjs — извлечение и индексация текстов решений (2.3).
 *
 * Логика:
 *   1. Получить из Supabase все задачи, у которых solution_text IS NULL
 *      (или по флагу --force — все)
 *   2. Для каждой задачи:
 *      a. Вызвать Bitrix24 task.commentitem.getlist
 *      b. Найти последний осмысленный комментарий:
 *         - длина > 20 символов
 *         - не от бота (AUTHOR_ID != 154)
 *         - не содержит типовых EOD-фраз ("Отчёт за день", "EOD")
 *      c. Если есть — solution_text = текст комментария (HTML stripped)
 *      d. Иначе — solution_text = NULL (не мешает поиску)
 *   3. Для задач с solution_text:
 *      a. Получить embedding через OpenRouter
 *      b. Обновить solution_text + solution_embedding + solution_indexed_at в Supabase
 *
 * Запуск:
 *   node scripts/sync-solutions.mjs              # только новые (solution_text IS NULL)
 *   node scripts/sync-solutions.mjs --force      # все задачи
 *   node scripts/sync-solutions.mjs --limit 50   # ограничить количество
 *
 * Cron: раз в неделю (после cluster-analytics).
 */
import fs from 'node:fs';

// Load env
const envPath = '/home/z/my-project/scripts/.env.local';
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx < 0) return;
    process.env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
}

const BITRIX_WEBHOOK = process.env.BITRIX24_WEBHOOK_USER116 || process.env.BITRIX24_WEBHOOK;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
const SUPA_URL = process.env.SUPABASE_URL || 'https://nopccnooivztriqdkbie.supabase.co';
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const FORCE = process.argv.includes('--force');
const LIMIT_ARG = process.argv.includes('--limit') ? parseInt(process.argv[process.argv.indexOf('--limit') + 1]) : null;

// Config
const EMBED_URL = 'https://openrouter.ai/api/v1/embeddings';
const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_BATCH = 100;
const DELAY_MS = 200;

// Bitrix24 status mapping (для определения «закрытых» задач)
const CLOSED_STATUSES = ['4', '6', '7']; // Завершена, Принята, На проверке

// Bot user IDs to exclude from "solution" extraction
const BOT_AUTHOR_IDS = ['154', '0'];

// Common EOD phrases that shouldn't be treated as solution
const EOD_PATTERNS = [
  /^EOD/i,
  /отчёт за день/i,
  /отчет за день/i,
  /проделанн(?:ые|ая) работ/i,
  /сделал сегодня/i,
  /^\s*-\s* /m,  // bullet list only
];

// ─── Helpers ────────────────────────────────────────────────────────────
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

function stripBbcode(s) {
  return (s || '')
    .replace(/\[b\]|\[\/b\]|\[i\]|\[\/i\]|\[list\]|\[\/list\]|\[\*\]|\[url=[^\]]*\]|\[\/url\]|\[code\]|\[\/code\]/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function isMeaningfulComment(text, authorId) {
  if (!text) return false;
  if (BOT_AUTHOR_IDS.includes(String(authorId))) return false;
  if (text.length < 20) return false;
  // Skip EOD-style comments
  for (const p of EOD_PATTERNS) {
    if (p.test(text)) return false;
  }
  return true;
}

// ─── Bitrix24: get comments for a task ──────────────────────────────────
async function fetchTaskComments(taskId) {
  const url = `${BITRIX_WEBHOOK}task.commentitem.getlist`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ TASKID: taskId }),
    });
    if (!res.ok) {
      console.warn(`  comments for #${taskId} HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data?.result || [];
  } catch (e) {
    console.warn(`  comments for #${taskId} failed: ${e.message}`);
    return [];
  }
}

function extractSolution(comments) {
  if (!comments || !comments.length) return null;
  // Iterate from the end, find first meaningful comment
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    const text = stripBbcode(stripHtml(c.POST_MESSAGE || ''));
    const authorId = c.AUTHOR_ID || '';
    if (isMeaningfulComment(text, authorId)) {
      return text.slice(0, 2000); // cap at 2000 chars
    }
  }
  return null;
}

// ─── Supabase: fetch tasks needing solution ─────────────────────────────
async function fetchTasksNeedingSolution() {
  // Если --force — все, иначе только где solution_text IS NULL
  const filter = FORCE ? '' : 'solution_text=is.null';
  const url = `${SUPA_URL}/rest/v1/tasks?select=id,title,description,status,created_at${filter ? '&' + filter : ''}&order=id.asc${LIMIT_ARG ? `&limit=${LIMIT_ARG}` : '&limit=5000'}`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase SELECT tasks ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

async function updateSolution(id, solutionText, embedding) {
  const url = `${SUPA_URL}/rest/v1/tasks?id=eq.${id}`;
  const body = {
    solution_text: solutionText,
    solution_indexed_at: new Date().toISOString(),
  };
  if (embedding) body.solution_embedding = embedding;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Update task ${id} ${res.status}: ${txt.slice(0, 300)}`);
  }
}

// ─── OpenRouter embeddings (batched) ────────────────────────────────────
let totalTokens = 0;
let totalCost = 0;

async function getEmbeddings(texts) {
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenRouter embeddings ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  if (data.usage) {
    totalTokens += data.usage.total_tokens || 0;
    if (data.usage.cost !== undefined) totalCost += data.usage.cost;
    else totalCost += (data.usage.total_tokens || 0) * 0.02 / 1_000_000;
  }
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(60));
  console.log('sync-solutions v7.28 — извлечение текстов решений (2.3)');
  console.log('═'.repeat(60));
  console.log(`Supabase: ${SUPA_URL}`);
  console.log(`Force: ${FORCE}, Limit: ${LIMIT_ARG || 'none'}`);
  console.log('');

  if (!BITRIX_WEBHOOK || !OPENROUTER_KEY || !SUPA_KEY) {
    console.error('Missing env vars'); process.exit(1);
  }

  const t0 = Date.now();

  // 1. Получить задачи для обработки
  console.log('→ Загрузка задач из Supabase...');
  const tasks = await fetchTasksNeedingSolution();
  console.log(`  получено: ${tasks.length} задач`);

  if (!tasks.length) {
    console.log('Нет задач для обработки — выходим.');
    return;
  }

  // 2. Для каждой задачи — тянем комментарии
  console.log(`\n→ Получение комментариев из Bitrix24...`);
  let solutionsFound = 0;
  let noSolution = 0;
  let processed = 0;
  const toEmbed = []; // {id, solution_text}

  for (const t of tasks) {
    processed++;
    if (processed % 50 === 0) {
      console.log(`  обработано ${processed}/${tasks.length} (с решениями: ${solutionsFound}, без: ${noSolution})`);
    }

    const comments = await fetchTaskComments(t.id);
    const solution = extractSolution(comments);

    if (solution) {
      toEmbed.push({ id: t.id, solution_text: solution });
      solutionsFound++;
    } else {
      // Помечаем как NULL (чтобы не перевыбирать каждый раз)
      try {
        await updateSolution(t.id, null, null);
      } catch (e) {
        console.warn(`  update null for #${t.id}: ${e.message}`);
      }
      noSolution++;
    }
    await sleep(100); // Bitrix24 rate limit
  }

  console.log(`\n  ИТОГ: ${solutionsFound} с решением, ${noSolution} без решения`);

  // 3. Batch embeddings для всех решений
  if (toEmbed.length === 0) {
    console.log('\nНет текстов решений для индексации — выходим.');
    return;
  }

  console.log(`\n→ Получение embeddings для ${toEmbed.length} решений...`);
  const allEmbeddings = [];
  for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
    const batch = toEmbed.slice(i, i + EMBED_BATCH);
    const texts = batch.map(b => b.solution_text.slice(0, 8000));
    const batchNum = Math.floor(i / EMBED_BATCH) + 1;
    const totalBatches = Math.ceil(toEmbed.length / EMBED_BATCH);
    console.log(`  batch ${batchNum}/${totalBatches} (${batch.length} texts)`);
    try {
      const embs = await getEmbeddings(texts);
      allEmbeddings.push(...embs);
    } catch (e) {
      console.error(`  batch ${batchNum} failed: ${e.message}`);
      for (let j = 0; j < batch.length; j++) allEmbeddings.push(null);
    }
    await sleep(DELAY_MS);
  }

  // 4. Обновить Supabase
  console.log(`\n→ Обновление Supabase (solution_text + solution_embedding)...`);
  let updated = 0;
  for (let i = 0; i < toEmbed.length; i++) {
    const { id, solution_text } = toEmbed[i];
    const emb = allEmbeddings[i];
    try {
      await updateSolution(id, solution_text, emb);
      updated++;
    } catch (e) {
      console.error(`  update #${id} failed: ${e.message}`);
    }
    if (updated % 50 === 0 && updated) console.log(`  updated ${updated}/${toEmbed.length}`);
    await sleep(50);
  }

  console.log(`\n✓ Обновлено: ${updated}/${toEmbed.length}`);
  console.log(`\n=== Usage & Cost ===`);
  console.log(`Tokens: ${totalTokens.toLocaleString()}`);
  console.log(`Cost: $${totalCost.toFixed(6)}`);
  console.log(`\nГотово за ${((Date.now() - t0) / 1000).toFixed(1)}с`);
}

main().catch(err => {
  console.error('sync-solutions failed:', err);
  process.exit(1);
});
