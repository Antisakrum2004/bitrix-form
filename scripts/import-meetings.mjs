/**
 * scripts/import-meetings.mjs — импорт JSON из NotebookLM в Supabase meetings.
 *
 * ВХОД: JSON-файл (или массив файлов) в формате meetings-example.json
 *
 * Запуск:
 *   node scripts/import-meetings.mjs /path/to/meetings.json
 *   node scripts/import-meetings.mjs /path/to/folder/*.json
 *
 * Для каждого meeting:
 *   1. Upsert в таблицу meetings (по external_id)
 *   2. Получить embedding через OpenRouter (text-embedding-3-small)
 *      по тексту: title + decision_text + excerpt + action_items + tags
 *   3. Сохранить embedding
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

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const SUPA_URL = process.env.SUPABASE_URL || 'https://nopccnooivztriqdkbie.supabase.co';
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!OPENROUTER_KEY || !SUPA_KEY) {
  console.error('Missing env vars (OPENROUTER_API_KEY, SUPABASE_SERVICE_KEY)');
  process.exit(1);
}

const EMBED_URL = 'https://openrouter.ai/api/v1/embeddings';
const EMBED_MODEL = 'text-embedding-3-small';
const DELAY_MS = 200;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadMeetings(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [data];
}

async function getEmbedding(text) {
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, 8000) }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenRouter embeddings ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.data?.[0]?.embedding;
}

async function upsertMeeting(meeting, embedding) {
  const url = `${SUPA_URL}/rest/v1/meetings?on_conflict=external_id`;
  const body = {
    external_id: meeting.external_id || `nb-${(meeting.title || 'untitled').slice(0, 100)}-${meeting.meeting_date || 'unknown'}`.slice(0, 200),
    title: meeting.title,
    meeting_date: meeting.meeting_date || null,
    participants: meeting.participants || [],
    duration_min: meeting.duration_min || null,
    decision_text: meeting.decision_text || '',
    action_items: meeting.action_items || [],
    related_task_ids: meeting.related_task_ids || [],
    excerpt: (meeting.excerpt || '').slice(0, 5000),
    tags: meeting.tags || [],
    audio_url: meeting.audio_url || null,
    source_url: meeting.source_url || null,
    embedding: embedding,
    indexed_at: new Date().toISOString(),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Upsert ${res.status}: ${txt.slice(0, 300)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node scripts/import-meetings.mjs <file.json> [file2.json ...]');
    process.exit(1);
  }

  const allMeetings = [];
  for (const arg of args) {
    if (!fs.existsSync(arg)) {
      console.warn(`File not found: ${arg}`);
      continue;
    }
    try {
      const meetings = loadMeetings(arg);
      console.log(`  ${arg}: ${meetings.length} meetings`);
      allMeetings.push(...meetings);
    } catch (e) {
      console.error(`  ${arg}: parse error — ${e.message}`);
    }
  }

  console.log(`\n=== Total: ${allMeetings.length} meetings ===\n`);

  let imported = 0;
  let failed = 0;

  for (let i = 0; i < allMeetings.length; i++) {
    const m = allMeetings[i];
    console.log(`[${i + 1}/${allMeetings.length}] "${(m.title || 'untitled').slice(0, 60)}"`);

    try {
      const embText = [
        m.title || '',
        m.decision_text || '',
        m.excerpt || '',
        (m.action_items || []).join(' '),
        (m.tags || []).join(' '),
      ].join('\n\n').trim();

      if (!embText) {
        console.warn('  ⚠ empty text, skipping');
        failed++;
        continue;
      }

      const emb = await getEmbedding(embText);
      if (!emb || emb.length !== 1536) {
        console.warn(`  ⚠ bad embedding (len=${emb?.length})`);
        failed++;
        continue;
      }

      await upsertMeeting(m, emb);
      imported++;
      console.log(`  ✓ imported (external_id: ${m.external_id || 'auto'})`);
    } catch (e) {
      console.error(`  ✗ failed: ${e.message}`);
      failed++;
    }
    await sleep(DELAY_MS);
  }

  console.log(`\n=== Done ===`);
  console.log(`Imported: ${imported}/${allMeetings.length}`);
  console.log(`Failed: ${failed}`);
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
