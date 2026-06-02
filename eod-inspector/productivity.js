/**
 * 📊 Рейтинг продуктивности
 * 
 * Собирает затреканное время за текущую неделю по каждому разработчику,
 * строит рейтинг и отправляет отчёт.
 * 
 * Поддерживает REPORT_MODE: 'private' → в ЛК Андрею, 'group' → в Общий чат
 * 
 * Использование:
 *   node productivity.js            — текущая неделя
 *   node productivity.js 2026-05-19 — неделя, содержащая указанную дату
 */

const config = require('./config');
const https = require('https');

// ─── Date helpers ───
function getWeekBounds(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4); // Mon-Fri
  const fmt = dt => dt.toISOString().substring(0, 10);
  return { from: fmt(monday), to: fmt(friday), monday, friday };
}

function formatRuDate(dateStr) {
  const months = ['января','февраля','марта','апреля','мая','июня',
                  'июля','августа','сентября','октября','ноября','декабря'];
  const [y, m, d] = dateStr.split('-');
  return `${Number(d)} ${months[Number(m)-1]}`;
}

function formatSeconds(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h === 0) return `${m}м`;
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
}

function getTodayMSC() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: config.TIMEZONE });
}

// ─── Bitrix API ───
function bxRequest(webhook, method, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhook + method);
    const body = JSON.stringify(params);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error for ${method}: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Timeout: ${method}`)); });
    req.write(body);
    req.end();
  });
}

const DATA_WEBHOOK = config.DATA_WEBHOOK;
const SEND_WEBHOOK = config.BOT_WEBHOOK;

function bxData(method, params = {}) { return bxRequest(DATA_WEBHOOK, method, params); }
function bxSend(method, params = {}) { return bxRequest(SEND_WEBHOOK, method, params); }

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ───
async function main() {
  const inputDate = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || getTodayMSC();
  const week = getWeekBounds(inputDate);

  console.log(`[Рейтинг] Неделя: ${week.from} — ${week.to}`);

  const results = [];

  for (const dev of config.DEVELOPERS) {
    console.log(`  [${dev.name}] Считаем время...`);
    let totalSeconds = 0;
    let taskCount = 0;
    let start = 0;

    while (true) {
      const r = await bxData('task.elapseditem.getlist', {
        ORDER: { ID: 'DESC' },
        FILTER: {
          USER_ID: dev.id,
          '>=CREATED_DATE': week.from + 'T00:00:00',
          '<=CREATED_DATE': week.to + 'T23:59:59',
        },
        ...(start > 0 ? { start } : {}),
      });

      if (r?.error) {
        console.log(`  [!] Ошибка: ${r.error}`);
        break;
      }

      const items = r?.result || [];
      const tasksThisPage = new Set();
      for (const item of items) {
        totalSeconds += Number(item.SECONDS || 0);
        tasksThisPage.add(String(item.TASK_ID));
      }
      taskCount += tasksThisPage.size;

      if (!r?.next) break;
      start = r.next;
    }

    results.push({
      name: dev.name,
      id: dev.id,
      totalSeconds,
      taskCount,
      hours: +(totalSeconds / 3600).toFixed(1),
    });

    await delay(200);
  }

  // Sort by total time desc
  results.sort((a, b) => b.totalSeconds - a.totalSeconds);

  // Build message
  const lines = [];
  lines.push(`📊 Рейтинг продуктивности`);
  lines.push(`${formatRuDate(week.from)} — ${formatRuDate(week.to)}`);
  lines.push('');

  // Medal emojis
  const medals = ['🥇', '🥈', '🥉'];

  let rank = 1;
  for (const dev of results) {
    const medal = rank <= 3 ? medals[rank - 1] + ' ' : '';
    const timeStr = formatSeconds(dev.totalSeconds);
    const barLen = Math.max(1, Math.round(dev.hours / 1)); // 1 char per hour
    const bar = '▓'.repeat(barLen) + '░'.repeat(Math.max(0, 40 - barLen));

    lines.push(`${medal}${rank}. ${dev.name}`);
    lines.push(`    ${bar}  ${timeStr}  (${dev.taskCount} задач)`);
    lines.push('');
    rank++;
  }

  // Summary
  const totalTeamHours = results.reduce((s, d) => s + d.hours, 0);
  const totalTeamTasks = results.reduce((s, d) => s + d.taskCount, 0);
  const avgHours = results.length > 0 ? (totalTeamHours / results.length).toFixed(1) : 0;

  lines.push(`────────────────────────`);
  lines.push(`Команда: ${totalTeamHours}ч всего | ${totalTeamTasks} задач | ${avgHours}ч в среднем`);

  const text = lines.join('\n');
  console.log('\n' + text);

  // Send report (same routing as EOD inspector)
  const DRY_RUN = process.argv.includes('--dry-run');

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Рейтинг не отправлен.');
    return;
  }

  try {
    const params = { MESSAGE: text, URL_PREVIEW: 'N' };

    if (config.REPORT_MODE === 'private') {
      params.USER_ID = config.REPORT_USER_ID;
      console.log(`[Send] ЛК → user ${config.REPORT_USER_ID}`);
    } else if (config.REPORT_CHAT_ID) {
      params.CHAT_ID = config.REPORT_CHAT_ID;
      console.log(`[Send] Чат → chat ${config.REPORT_CHAT_ID}`);
    } else {
      // Fallback: send to Andrey
      params.USER_ID = config.REPORT_USER_ID;
      console.log(`[Send] Fallback ЛК → user ${config.REPORT_USER_ID}`);
    }

    const result = await bxSend('im.message.add', params);
    console.log('\n[✓] Рейтинг отправлен');
    console.log('[Send] Response:', JSON.stringify(result).substring(0, 200));
  } catch (err) {
    console.error('[!] Ошибка отправки:', err.message);
  }
}

main().catch(err => console.error('[FATAL]', err));
