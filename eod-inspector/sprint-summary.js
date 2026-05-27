/**
 * 📋 Сводка по спринту
 * 
 * Показывает статус задач: сколько открыто / в работе / закрыто,
 * сколько времени затрекано, кто на чём стоит.
 * Отправляет в личку Андрею (116).
 * 
 * Использование:
 *   node sprint-summary.js            — текущий спринт
 *   node sprint-summary.js 2026-05-19 — спринт вокруг указанной даты
 */

const config = require('./config');
const https = require('https');

// ─── Date helpers ───
function getTodayMSC() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: config.TIMEZONE });
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

// Task status mapping
const STATUS_MAP = {
  '1':  { label: 'Новая',         icon: '🔵', group: 'new' },
  '2':  { label: 'Ожидание',      icon: '🟡', group: 'pending' },
  '3':  { label: 'В работе',      icon: '🟠', group: 'progress' },
  '4':  { label: 'Согласование',  icon: '🟣', group: 'progress' },
  '5':  { label: 'Тестируется',   icon: '🔬', group: 'progress' },
  '6':  { label: 'Готово',        icon: '✅', group: 'done' },
  '7':  { label: 'Отклонена',     icon: '❌', group: 'closed' },
  '-1': { label: 'Отложена',      icon: '⏸️', group: 'pending' },
  '-2':  { label: 'Делегирована', icon: '🔄', group: 'pending' },
  '-3': { label: 'Принята',       icon: '📥', group: 'progress' },
};

function getStatusInfo(status) {
  return STATUS_MAP[String(status)] || { label: `Статус ${status}`, icon: '⚪', group: 'other' };
}

// ─── Main ───
async function main() {
  const today = getTodayMSC();
  console.log(`[Сводка] Дата: ${today}`);

  // ─── STEP 1: Fetch ALL tasks for the team ───
  console.log('[Step 1] Загружаем задачи команды...');
  
  const allTasks = [];
  let start = 0;

  // Fetch tasks for all developers (responsible)
  for (const dev of config.DEVELOPERS) {
    let devStart = 0;
    while (true) {
      const r = await bxData('tasks.task.list', {
        filter: {
          RESPONSIBLE_ID: dev.id,
        },
        select: ['ID', 'TITLE', 'STATUS', 'RESPONSIBLE_ID', 'CREATED_DATE', 'DEADLINE', 'TIME_SPENT_IN_LOGS'],
        order: { ID: 'DESC' },
        ...(devStart > 0 ? { start: devStart } : {}),
      });

      if (r?.error) {
        console.log(`  [!] Ошибка для ${dev.name}: ${r.error}`);
        break;
      }

      const tasks = r?.result?.tasks || [];
      for (const t of tasks) {
        allTasks.push({
          id: String(t.id),
          title: t.title || '(без названия)',
          status: String(t.status),
          responsibleId: String(t.responsibleId),
          createdDate: t.createdDate || '',
          deadline: t.deadline || '',
          timeSpent: Number(t.timeSpentInLogs || 0),
        });
      }

      if (!r?.next) break;
      devStart = r.next;
      if (devStart > 200) break; // safety limit per dev
    }
    await delay(200);
  }

  console.log(`[Step 1] Загружено задач: ${allTasks.length}`);

  // Deduplicate (same task might appear for multiple responsibles)
  const taskMap = new Map();
  for (const t of allTasks) {
    if (!taskMap.has(t.id)) {
      taskMap.set(t.id, t);
    }
  }
  const uniqueTasks = [...taskMap.values()];
  console.log(`[Step 1] Уникальных: ${uniqueTasks.length}`);

  // ─── STEP 2: Count by status ───
  const statusGroups = { new: 0, pending: 0, progress: 0, done: 0, closed: 0, other: 0 };
  const statusDetails = {};

  for (const t of uniqueTasks) {
    const info = getStatusInfo(t.status);
    statusGroups[info.group] = (statusGroups[info.group] || 0) + 1;
    if (!statusDetails[t.status]) {
      statusDetails[t.status] = { ...info, count: 0 };
    }
    statusDetails[t.status].count++;
  }

  // ─── STEP 3: Per-developer breakdown ───
  const devStats = {};
  for (const dev of config.DEVELOPERS) {
    devStats[dev.id] = {
      name: dev.name,
      total: 0,
      inProgress: 0,
      done: 0,
      new: 0,
      tasks: [],
    };
  }

  for (const t of uniqueTasks) {
    if (devStats[t.responsibleId]) {
      devStats[t.responsibleId].total++;
      const info = getStatusInfo(t.status);
      if (info.group === 'progress') devStats[t.responsibleId].inProgress++;
      if (info.group === 'done') devStats[t.responsibleId].done++;
      if (info.group === 'new') devStats[t.responsibleId].new++;
      devStats[t.responsibleId].tasks.push(t);
    }
  }

  // ─── STEP 4: Build message ───
  const lines = [];
  lines.push(`📋 Сводка по задачам команды`);
  lines.push(`на ${formatRuDate(today)}`);
  lines.push('');

  // Status overview
  const totalTasks = uniqueTasks.length;
  lines.push(`Общий статус (${totalTasks} задач):`);
  
  const activeCount = statusGroups.progress + statusGroups.new + statusGroups.pending;
  const doneCount = statusGroups.done + statusGroups.closed;
  
  // Visual bar
  const barTotal = 30;
  const activeLen = Math.round((activeCount / Math.max(totalTasks, 1)) * barTotal);
  const doneLen = Math.round((doneCount / Math.max(totalTasks, 1)) * barTotal);
  const otherLen = barTotal - activeLen - doneLen;
  const statusBar = '🟠'.repeat(activeLen) + '✅'.repeat(doneLen) + '⚪'.repeat(Math.max(0, otherLen));
  
  lines.push(`  ${statusBar}`);
  lines.push('');

  // Status details
  const sortedStatuses = Object.values(statusDetails).sort((a, b) => b.count - a.count);
  for (const s of sortedStatuses) {
    lines.push(`  ${s.icon} ${s.label}: ${s.count}`);
  }
  lines.push('');

  // Developer breakdown
  lines.push(`👥 По разработчикам:`);
  lines.push('');

  const TASK_URL = `https://${config.B24_DOMAIN}/company/personal/user/${config.REPORT_USER_ID}/tasks/task/view/`;

  for (const dev of config.DEVELOPERS) {
    const stat = devStats[dev.id];
    if (stat.total === 0) {
      lines.push(`${stat.name}: нет задач`);
      lines.push('');
      continue;
    }

    lines.push(`${stat.name}:`);
    
    // Mini status bar
    const total = stat.total;
    const prPct = Math.round((stat.inProgress / total) * 100);
    const dnPct = Math.round((stat.done / total) * 100);
    const nwPct = 100 - prPct - dnPct;
    
    lines.push(`  В работе: ${stat.inProgress} | Выполнено: ${stat.done} | Новых: ${stat.new} | Всего: ${stat.total}`);
    
    // Show in-progress tasks (limit 5)
    const inProgressTasks = stat.tasks.filter(t => {
      const info = getStatusInfo(t.status);
      return info.group === 'progress';
    });
    
    if (inProgressTasks.length > 0) {
      const shown = inProgressTasks.slice(0, 5);
      for (const t of shown) {
        const info = getStatusInfo(t.status);
        const link = `[URL=${TASK_URL}${t.id}/]${t.title}[/URL]`;
        const deadlineStr = t.deadline ? ` | Дедлайн: ${t.deadline.substring(0, 10)}` : '';
        lines.push(`  ${info.icon} ${link}${deadlineStr}`);
      }
      if (inProgressTasks.length > 5) {
        lines.push(`  ... и ещё ${inProgressTasks.length - 5} в работе`);
      }
    }
    
    lines.push('');
  }

  // Overdue section
  const overdueTasks = uniqueTasks.filter(t => {
    if (!t.deadline) return false;
    const info = getStatusInfo(t.status);
    if (info.group === 'done' || info.group === 'closed') return false;
    return t.deadline.substring(0, 10) < today;
  });

  if (overdueTasks.length > 0) {
    lines.push(`🔴 Просрочено: ${overdueTasks.length}`);
    for (const t of overdueTasks.slice(0, 5)) {
      const dev = config.DEVELOPERS.find(d => d.id === t.responsibleId);
      const devName = dev ? dev.name : `#${t.responsibleId}`;
      const link = `[URL=${TASK_URL}${t.id}/]${t.title}[/URL]`;
      lines.push(`  ⚠️ ${link} → ${devName} (было до ${t.deadline.substring(0, 10)})`);
    }
    if (overdueTasks.length > 5) {
      lines.push(`  ... и ещё ${overdueTasks.length - 5} просроченных`);
    }
    lines.push('');
  }

  const text = lines.join('\n');
  console.log('\n' + text);

  // Send to Andrey (116)
  try {
    const result = await bxSend('im.message.add', {
      USER_ID: config.REPORT_USER_ID,
      MESSAGE: text,
      URL_PREVIEW: 'N',
    });
    console.log('\n[✓] Сводка отправлена в ЛК');
    console.log('[Send] Response:', JSON.stringify(result).substring(0, 200));
  } catch (err) {
    console.error('[!] Ошибка отправки:', err.message);
  }
}

main().catch(err => console.error('[FATAL]', err));
