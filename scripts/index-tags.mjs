/**
 * scripts/index-tags.mjs — авто-тегирование задач через LLM (2.6).
 *
 * Логика:
 *   1. Получить из Supabase задачи где tags IS NULL или array_length(tags,1) IS NULL
 *      (или по флагу --force — все)
 *   2. Для каждой задачи — LLM-запрос через OpenRouter:
 *      system: "Ты — ассистент по тегированию задач 1С. Верни JSON array тегов из списка..."
 *      user: title + description (обрезано до 1000 символов)
 *   3. LLM возвращает ["тег1", "тег2"] — максимум 3 тега на задачу
 *   4. Записать в tasks.tags
 *
 * Список тегов (8 категорий):
 *   - бухгалтерия      — проводки, отчёты, закрытие месяца, рег. задание
 *   - интеграции       — обмен, API, Озон, Авито, Маркет, внешние системы
 *   - остатки          — склад, резерв, минус резерв, инвентаризация
 *   - права            — доступы, RLS, пользователи, роли
 *   - отчёты           — ВПФ, печатные формы, отчёты, СКД
 *   - эдо              — электронный документ, ФТТ, ЧЗ, накладные
 *   - обучение         — лекции, занятия, материалы, ТЗ, документация
 *   - инфраструктура   — сервер, база, тормозит, доступ, FTP, VPN
 *
 * Запуск:
 *   node scripts/index-tags.mjs              # только без тегов
 *   node scripts/index-tags.mjs --force      # все задачи
 *   node scripts/index-tags.mjs --limit 50   # ограничить
 *
 * Cron: раз в неделю (после cluster-analytics, перед sync-solutions).
 */
import fs from 'node:fs';

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

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
const SUPA_URL = process.env.SUPABASE_URL || 'https://nopccnooivztriqdkbie.supabase.co';
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const FORCE = process.argv.includes('--force');
const LIMIT_ARG = process.argv.includes('--limit') ? parseInt(process.argv[process.argv.indexOf('--limit') + 1]) : null;

// ─── Tags definition ────────────────────────────────────────────────────
const TAGS = [
  'бухгалтерия',
  'интеграции',
  'остатки',
  'права',
  'отчёты',
  'эдо',
  'обучение',
  'инфраструктура',
];

const TAGS_DESC = `Доступные теги (выбери 0-3 наиболее подходящих):
- "бухгалтерия" — проводки, отчёты, закрытие месяца, рег. задание, себестоимость
- "интеграции" — обмен, API, Озон, Авито, Маркет, внешние системы, синхронизация
- "остатки" — склад, резерв, минус резерв, инвентаризация, остатки
- "права" — доступы, RLS, пользователи, роли, видимость
- "отчёты" — ВПФ, печатные формы, отчёты, СКД, валовая прибыль
- "эдо" — электронный документ, ФТТ, ЧЗ, накладные, реализация
- "обучение" — лекции, занятия, материалы, ТЗ, документация, обучение
- "инфраструктура" — сервер, база, тормозит, доступ, FTP, VPN, обновление`;

// ─── Helpers ────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function stripBb(s) {
  return (s || '')
    .replace(/\[b\]|\[\/b\]|\[i\]|\[\/i\]|\[list\]|\[\/list\]|\[\*\]|\[url=[^\]]*\]|\[\/url\]|\[code\]|\[\/code\]/gi, '')
    .replace(/\n{2,}/g, '\n').trim();
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Supabase: fetch tasks without tags ─────────────────────────────────
async function fetchTasksNeedingTags() {
  // Фильтр: tags IS NULL или пустой массив
  // Supabase REST: tags=is.null OR tags=eq.{}
  // Используем or-фильтр
  let url = `${SUPA_URL}/rest/v1/tasks?select=id,title,description&or=(tags.is.null,tags.eq.{})&order=id.asc`;
  if (FORCE) {
    url = `${SUPA_URL}/rest/v1/tasks?select=id,title,description&order=id.asc`;
  }
  if (LIMIT_ARG) url += `&limit=${LIMIT_ARG}`;
  else url += '&limit=5000';

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

async function updateTags(id, tags) {
  const url = `${SUPA_URL}/rest/v1/tasks?id=eq.${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ tags }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Update task ${id} ${res.status}: ${txt.slice(0, 300)}`);
  }
}

// ─── LLM tag classification ─────────────────────────────────────────────
const SYSTEM_PROMPT = `Ты — ассистент по тегированию задач в 1С + Bitrix24. Верни СТРОГО JSON: массив из 0-3 тегов.

${TAGS_DESC}

Правила:
- Максимум 3 тега (выбирай самые релевантные)
- Если задача не подходит ни под один тег — верни пустой массив []
- Верни ТОЛЬКО JSON массив, без markdown, без пояснений
- Пример: ["остатки", "права"]
- Пример: []
- Пример: ["интеграции"]`;

async function classifyTask(title, description) {
  const text = stripBb(`${title}\n${stripHtml(description || '')}`).slice(0, 1000);
  if (!text) return [];

  // Fallback chain — DeepSeek, Gemini, GPT-4o-mini
  const models = [
    'deepseek/deepseek-chat',
    'google/gemini-2.5-flash',
    'openai/gpt-4o-mini',
  ];

  for (const model of models) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
          temperature: 0,
          max_tokens: 100,
        }),
      });
      if (!res.ok) {
        console.warn(`  LLM ${model} HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      let content = data.choices?.[0]?.message?.content || '';
      content = content.trim();
      // Strip markdown code blocks
      if (content.startsWith('```')) {
        content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        console.warn(`  LLM ${model} returned non-array:`, content.slice(0, 100));
        continue;
      }
      // Validate tags against allowed list
      const valid = parsed
        .map(t => String(t).toLowerCase().trim())
        .filter(t => TAGS.includes(t))
        .slice(0, 3);
      // dedupe
      return [...new Set(valid)];
    } catch (e) {
      console.warn(`  LLM ${model} failed: ${e.message}`);
      continue;
    }
  }
  return [];
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(60));
  console.log('index-tags v7.28 — LLM авто-тегирование задач (2.6)');
  console.log('═'.repeat(60));
  console.log(`Supabase: ${SUPA_URL}`);
  console.log(`Force: ${FORCE}, Limit: ${LIMIT_ARG || 'none'}`);
  console.log(`Тегов в списке: ${TAGS.length} (${TAGS.join(', ')})`);
  console.log('');

  if (!OPENROUTER_KEY || !SUPA_KEY) {
    console.error('Missing env vars'); process.exit(1);
  }

  const t0 = Date.now();

  // 1. Получить задачи без тегов
  console.log('→ Загрузка задач без тегов...');
  const tasks = await fetchTasksNeedingTags();
  console.log(`  получено: ${tasks.length} задач`);

  if (!tasks.length) {
    console.log('Все задачи уже имеют теги — выходим.');
    return;
  }

  // 2. Классификация + обновление
  console.log(`\n→ LLM классификация...`);
  let processed = 0;
  let tagged = 0;
  let emptyTags = 0;
  const tagStats = {};
  TAGS.forEach(t => tagStats[t] = 0);

  for (const t of tasks) {
    processed++;
    if (processed % 25 === 0) {
      console.log(`  обработано ${processed}/${tasks.length} (с тегами: ${tagged}, без: ${emptyTags})`);
    }

    try {
      const tags = await classifyTask(t.title, t.description);
      await updateTags(t.id, tags.length ? tags : []);

      if (tags.length) {
        tagged++;
        tags.forEach(tg => tagStats[tg] = (tagStats[tg] || 0) + 1);
      } else {
        emptyTags++;
      }
    } catch (e) {
      console.error(`  task #${t.id} failed: ${e.message}`);
    }
    await sleep(100); // rate limit
  }

  // 3. Статистика
  console.log('\n' + '═'.repeat(60));
  console.log('ИТОГ:');
  console.log('═'.repeat(60));
  console.log(`Обработано: ${processed}`);
  console.log(`С тегами: ${tagged}`);
  console.log(`Без тегов: ${emptyTags}`);
  console.log('\nРаспределение по тегам:');
  Object.entries(tagStats)
    .sort((a, b) => b[1] - a[1])
    .forEach(([tg, count]) => {
      const bar = '█'.repeat(Math.round(count / Math.max(tagged, 1) * 30));
      console.log(`  ${tg.padEnd(20)} ${String(count).padStart(4)} ${bar}`);
    });

  console.log(`\nГотово за ${((Date.now() - t0) / 1000).toFixed(1)}с`);
}

main().catch(err => {
  console.error('index-tags failed:', err);
  process.exit(1);
});
