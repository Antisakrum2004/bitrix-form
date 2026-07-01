/**
 * scripts/convert-md-to-json.mjs — конвертер .md файлов из NotebookLM в один JSON.
 *
 * ВХОД: папка с .md файлами (YAML front matter + Markdown body)
 * ВЫХОД: один JSON-файл с массивом meetings
 *
 * Запуск:
 *   node scripts/convert-md-to-json.mjs /home/z/my-project/scripts/nblm-export/
 *   node scripts/convert-md-to-json.mjs /path/to/folder --output /path/to/all-meetings.json
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const inputDir = args[0];
const outputFile = args[args.indexOf('--output') + 1] || path.join(inputDir, 'all-meetings.json');

if (!inputDir || !fs.existsSync(inputDir)) {
  console.error('Usage: node convert-md-to-json.mjs <input-dir> [--output <file.json>]');
  process.exit(1);
}

// Простой YAML front matter парсер (без зависимостей)
function parseFrontMatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const yamlBlock = match[1];
  const body = match[2].trim();
  const meta = {};

  // Парсим простые key: value и key: [item1, item2]
  yamlBlock.split('\n').forEach(line => {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) return;
    const key = m[1];
    let value = m[2].trim();

    // Массив: ["a", "b"] или [1, 2]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      if (!inner) {
        meta[key] = [];
      } else {
        meta[key] = inner.split(',').map(s => {
          s = s.trim();
          // Убираем кавычки
          if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
            s = s.slice(1, -1);
          }
          // Число?
          if (/^\d+$/.test(s)) return parseInt(s, 10);
          return s;
        });
      }
    }
    // Строка с кавычками
    else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      meta[key] = value.slice(1, -1);
    }
    // null
    else if (value === 'null' || value === '~') {
      meta[key] = null;
    }
    // Число
    else if (/^\d+$/.test(value)) {
      meta[key] = parseInt(value, 10);
    }
    // Дата строкой
    else {
      meta[key] = value;
    }
  });

  return { meta, body };
}

// Парсим Markdown body — извлекаем Решение / Шаги / Цитату
function parseBody(body) {
  const decisions = [];
  const sections = body.split(/^## /m).filter(s => s.trim());

  for (const section of sections) {
    if (!section.toLowerCase().startsWith('решение')) continue;

    const lines = section.split('\n');
    // Первая строка — "Решение 1" или "Решение"
    const titleLine = lines[0].replace(/^решение\s*\d*\s*/i, '').trim();

    let decisionText = '';
    let actionItems = [];
    let excerpt = '';

    let currentSection = 'decision';  // decision | actions | quote
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      if (line.match(/^###\s+шаги/i)) {
        currentSection = 'actions';
        continue;
      }
      if (line.match(/^###\s+цитата/i)) {
        currentSection = 'quote';
        continue;
      }
      if (line.match(/^##\s+/)) {
        // Новая секция решения
        break;
      }

      if (currentSection === 'decision') {
        decisionText += (decisionText ? '\n' : '') + line;
      } else if (currentSection === 'actions') {
        const m = line.match(/^\s*[-•]\s*(.+)$/);
        if (m) actionItems.push(m[1].trim());
      } else if (currentSection === 'quote') {
        excerpt += (excerpt ? '\n' : '') + line;
      }
    }

    decisions.push({
      decision_text: decisionText.trim(),
      action_items: actionItems,
      excerpt: excerpt.trim().slice(0, 5000),
    });
  }

  return decisions;
}

// ─── Main ─────────────────────────────────────────────────────────
const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.md'));
console.log(`Found ${files.length} .md files in ${inputDir}`);

const allMeetings = [];

for (const file of files) {
  const filePath = path.join(inputDir, file);
  const content = fs.readFileSync(filePath, 'utf8');

  const { meta, body } = parseFrontMatter(content);
  const decisions = parseBody(body);

  if (!decisions.length) {
    console.warn(`  ⚠ ${file}: no decisions found, skipping`);
    continue;
  }

  // Если решений несколько — каждое становится отдельной записью
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    const external_id = decisions.length > 1
      ? `${meta.external_id || file.replace('.md', '')}-part${i + 1}`
      : (meta.external_id || file.replace('.md', ''));

    allMeetings.push({
      external_id,
      title: meta.title || `Встреча ${file}`,
      meeting_date: meta.meeting_date || null,
      participants: meta.participants || [],
      duration_min: meta.duration_min || null,
      decision_text: d.decision_text,
      action_items: d.action_items,
      related_task_ids: meta.related_task_ids || [],
      excerpt: d.excerpt,
      tags: meta.tags || [],
      audio_url: meta.audio_url || null,
      source_url: meta.source_url || null,
    });
  }

  console.log(`  ✓ ${file}: ${decisions.length} decision(s)`);
}

fs.writeFileSync(outputFile, JSON.stringify(allMeetings, null, 2));
console.log(`\n✓ Written ${allMeetings.length} meetings to ${outputFile}`);
