/**
 * EOD Inspector v5 — Main Script
 *
 * Detects which tasks developers ACTUALLY worked on today and checks EOD.
 *
 * Detection logic:
 *   1. task.elapseditem.getlist — PRIMARY: finds tasks with time entries today
 *      - Auto time: developer started → timer → time entry on stop
 *      - Manual time: "вручную добавил время" → time entry created
 *      - Uses ORDER + FILTER as top-level params (not nested)
 *      - Returns entries for ALL tasks (even ones bot can't otherwise see)
 *
 *   2. System messages — SECONDARY: "начал выполнять", "продолжил",
 *      "вручную добавил время" in task chat (only for visible tasks)
 *
 *   3. For invisible tasks (bot not observer): show task ID + time,
 *      mark EOD as unknown, note admin webhook needed
 *
 * Key API findings:
 *   - task.elapseditem.getlist(ORDER, FILTER) — returns ALL time entries
 *     for a user, even for tasks bot can't see via tasks.task.list
 *   - tasks.task.list(ID filter) — only returns tasks where bot is observer
 *   - im.dialog.messages.get(CHAT_ID) — only works for chats bot is member of
 *   - Task details (title, chatId) unavailable for tasks bot can't see
 */

const config = require('./config');
const https = require('https');

// ─── Date setup ───
const TARGET_DATE = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || getTodayMSC();
const DRY_RUN = process.argv.includes('--dry-run');

function getTodayMSC() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: config.TIMEZONE });
}

const DATA_WEBHOOK = config.DATA_WEBHOOK;
const SEND_WEBHOOK = config.BOT_WEBHOOK;

console.log(`[EOD Inspector v5] Target date: ${TARGET_DATE}`);
console.log(`[EOD Inspector] Data webhook: ${DATA_WEBHOOK === config.BOT_WEBHOOK ? 'BOT (154)' : 'ADMIN'}`);
console.log(`[EOD Inspector] Report mode: ${config.REPORT_MODE}`);
console.log(`[EOD Inspector] Dry run: ${DRY_RUN}`);

// ─── Bitrix24 API helpers ───
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

function bxData(method, params = {}) {
  return bxRequest(DATA_WEBHOOK, method, params);
}

function bxSend(method, params = {}) {
  return bxRequest(SEND_WEBHOOK, method, params);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main logic ───
async function main() {
  try {
    const report = await buildReport(TARGET_DATE);
    console.log('\n' + report.text);

    if (!DRY_RUN) {
      await sendReport(report.text);
      console.log('\n[✓] Report sent successfully.');
    } else {
      console.log('\n[DRY RUN] Report not sent.');
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
    if (!DRY_RUN) process.exit(1);
  }
}

async function buildReport(dateStr) {
  const devResults = {};

  for (const dev of config.DEVELOPERS) {
    devResults[dev.id] = { name: dev.name, tasks: [], error: null };
  }

  for (const dev of config.DEVELOPERS) {
    console.log(`\n[Processing] ${dev.name} (id=${dev.id})...`);

    try {
      // ═══ STEP 1: Get ALL time entries for this developer today ═══
      console.log(`  [Step 1] Fetching time entries...`);
      const workedTasks = await fetchTimeEntries(dev.id, dateStr);
      console.log(`  [Step 1] Found ${workedTasks.size} tasks with time entries`);

      // ═══ STEP 2: Find tasks with work-start events but no time entry ═══
      // (timer still running, or completed/returned without logging time)
      console.log(`  [Step 2] Checking for started-but-not-timed tasks...`);
      const additionalTasks = await findStartedButNotTimed(dev.id, dateStr, workedTasks);
      for (const [taskId, info] of additionalTasks) {
        workedTasks.set(taskId, info);
      }
      if (additionalTasks.size > 0) {
        console.log(`  [Step 2] Found ${additionalTasks.size} additional tasks with work events`);
      }

      // ═══ STEP 3: Get task details for ALL worked tasks ═══
      console.log(`  [Step 3] Fetching task details...`);
      const taskIds = [...workedTasks.keys()];
      const visibleDetails = new Map();

      if (taskIds.length > 0) {
        // Batch fetch via tasks.task.list (only returns visible tasks)
        try {
          const r = await bxData('tasks.task.list', {
            filter: { ID: taskIds },
            select: ['ID', 'TITLE', 'STATUS', 'RESPONSIBLE_ID', 'CHAT_ID', 'TIME_ESTIMATE', 'TIME_SPENT_IN_LOGS'],
          });
          const tasks = r?.result?.tasks || [];
          for (const t of tasks) {
            visibleDetails.set(String(t.id), {
              title: t.title || '(без названия)',
              status: t.status,
              chatId: t.chatId,
              responsibleId: t.responsibleId,
              visible: true,
              timeEstimate: Number(t.timeEstimate || 0),
              timeSpentTotal: Number(t.timeSpentInLogs || 0),
            });
          }
        } catch (e) {
          console.log(`  [!] Error fetching task details: ${e.message}`);
        }
      }

      console.log(`  [Step 3] Visible: ${visibleDetails.size}/${taskIds.length} tasks`);

      // ═══ STEP 4: Check EOD for each task ═══
      console.log(`  [Step 4] Checking EOD...`);
      for (const [taskId, info] of workedTasks) {
        const detail = visibleDetails.get(taskId);
        const chatId = detail?.chatId || null;
        const title = detail?.title || `Задача #${taskId}`;
        const status = detail?.status || '?';
        const isVisible = detail?.visible || false;

        let eodResult = { present: false, unknown: true };
        if (isVisible && chatId) {
          eodResult = await checkEOD(chatId, dev.id, dateStr);
          await delay(300);
        }

        devResults[dev.id].tasks.push({
          id: taskId,
          title,
          status,
          eodPresent: eodResult.present,
          eodUnknown: eodResult.unknown,
          timeSpent: info.seconds, // today's time (Факт)
          timeEstimate: detail?.timeEstimate || 0, // planned time (План)
          timeSpentTotal: detail?.timeSpentTotal || 0, // total time ever (Всего)
          workType: info.workType,
          visible: isVisible,
        });

        const visStr = !isVisible ? ' [НЕТ ДОСТУПА]' : '';
        console.log(`    #${taskId}${visStr} [${info.workType}] Факт:${formatTime(info.seconds)} План:${formatTime(detail?.timeEstimate||0)} Всего:${formatTime(detail?.timeSpentTotal||0)} → EOD: ${eodResult.unknown ? '???' : eodResult.present ? 'YES' : 'NO'}`);
      }

      if (workedTasks.size === 0) {
        console.log(`  (no worked tasks found for ${dateStr})`);
      }
    } catch (err) {
      console.error(`  [!] Error for ${dev.name}: ${err.message}`);
      devResults[dev.id].error = err.message;
    }
  }

  const text = formatReport(dateStr, devResults);
  return { text, devResults };
}

/**
 * Fetch ALL time entries for a developer on a specific date.
 * Uses task.elapseditem.getlist with ORDER + FILTER as top-level params.
 */
async function fetchTimeEntries(devId, dateStr) {
  const workedTasks = new Map();
  let start = 0;

  while (true) {
    const r = await bxData('task.elapseditem.getlist', {
      ORDER: { ID: 'DESC' },
      FILTER: {
        USER_ID: devId,
        '>=CREATED_DATE': dateStr + 'T00:00:00',
        '<=CREATED_DATE': dateStr + 'T23:59:59',
      },
      ...(start > 0 ? { start } : {}),
    });

    if (r?.error) {
      console.log(`  [!] task.elapseditem.getlist error: ${r.error}`);
      break;
    }

    const items = r?.result || [];
    for (const item of items) {
      const taskId = String(item.TASK_ID || '');
      const seconds = Number(item.SECONDS || 0);
      if (taskId) {
        if (!workedTasks.has(taskId)) {
          workedTasks.set(taskId, { seconds: 0, workType: 'учёт времени' });
        }
        workedTasks.get(taskId).seconds += seconds;
      }
    }

    if (!r?.next) break;
    start = r.next;
  }

  return workedTasks;
}

/**
 * Find tasks where developer started work today but hasn't logged time yet.
 * Uses DATE_ACTIVITY as pre-filter, then checks system messages.
 */
async function findStartedButNotTimed(devId, dateStr, existingTasks) {
  const additional = new Map();

  try {
    const r = await bxData('tasks.task.list', {
      filter: {
        RESPONSIBLE_ID: devId,
        '>=DATE_ACTIVITY': dateStr + 'T00:00:00',
        '<=DATE_ACTIVITY': dateStr + 'T23:59:59',
      },
      select: ['ID', 'CHAT_ID'],
    });
    const candidates = r?.result?.tasks || [];

    for (const task of candidates) {
      const taskId = String(task.id);
      if (existingTasks.has(taskId)) continue;

      const chatId = task.chatId;
      if (!chatId) continue;

      try {
        const chatR = await bxData('im.dialog.messages.get', {
          CHAT_ID: chatId,
          LIMIT: config.MAX_MESSAGES_PER_CHAT,
        });
        const messages = chatR?.result?.messages || [];
        const workEvent = findWorkSystemMessage(messages, devId, dateStr);

        if (workEvent) {
          additional.set(taskId, { seconds: 0, workType: workEvent });
        }
      } catch (e) {
        // Can't access chat — skip
      }

      await delay(300);
    }
  } catch (e) {
    // Error getting candidates — skip
  }

  return additional;
}

/**
 * Find a work-start system message from today.
 */
function findWorkSystemMessage(messages, devId, dateStr) {
  for (const msg of messages) {
    if (msg.author_id !== 0) continue;
    const msgDate = (msg.date || '').substring(0, 10);
    if (msgDate !== dateStr) continue;

    const text = msg.text || '';
    const hasDevMention = text.includes(`[USER=${devId}]`);
    if (!hasDevMention) continue;

    if (text.includes('начал выполнять задачу') || text.includes('начала выполнять задачу')) return 'начал выполнять';
    if (text.includes('продолжил выполнение') || text.includes('продолжила выполнение')) return 'продолжил';
    if (text.includes('возобновил') || text.includes('возобновила')) return 'возобновил';
    if (text.includes('вручную добавил время') || text.includes('вручную добавила время')) return 'добавил время';
    if (text.includes('вернул выполненную задачу в работу') || text.includes('вернула выполненную задачу в работу')) return 'вернул в работу';
    if (text.includes('завершил задачу') || text.includes('завершила задачу')) return 'завершена';
    if (text.includes('изменил стадию на Готово') || text.includes('изменила стадию на Готово')) return 'завершена';
  }
  return null;
}

/**
 * Check if the developer posted an EOD comment today.
 */
async function checkEOD(chatId, devId, dateStr) {
  if (!chatId) return { present: false, unknown: true };

  try {
    const chatR = await bxData('im.dialog.messages.get', {
      CHAT_ID: chatId,
      LIMIT: config.MAX_MESSAGES_PER_CHAT,
    });
    const messages = chatR?.result?.messages || [];

    for (const msg of messages) {
      if (msg.author_id === 0) continue;
      if (Number(msg.author_id) === config.BOT_ID) continue;
      if (String(msg.author_id) !== String(devId)) continue;

      const msgDate = (msg.date || '').substring(0, 10);
      if (msgDate !== dateStr) continue;

      const text = (msg.text || '').toLowerCase();
      const matchCount = config.EOD_KEYWORDS.filter(kw => text.includes(kw)).length;
      if (matchCount >= 2) {
        return { present: true, unknown: false };
      }
    }
    return { present: false, unknown: false };
  } catch (e) {
    return { present: false, unknown: true };
  }
}

function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '0';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}:${String(m).padStart(2, '0')}`;
  if (h > 0) return `${h}ч`;
  return `${m}м`;
}

const TASK_URL = `https://${config.B24_DOMAIN}/company/personal/user/${config.REPORT_USER_ID}/tasks/task/view/`;

function formatReport(dateStr, devResults) {
  const dateFormatted = dateStr.split('-').reverse().join('.');
  let lines = [];

  lines.push(`📋 EOD-сводка за ${dateFormatted}`);
  lines.push('');

  let totalWorked = 0;
  let totalWithEod = 0;
  let totalWithoutEod = 0;
  let totalUnknown = 0;
  let totalInvisible = 0;

  for (const dev of config.DEVELOPERS) {
    const result = devResults[dev.id];
    if (result.error) {
      lines.push(`${result.name}: ⚠️ ошибка — ${result.error}`);
      lines.push('');
      continue;
    }

    if (result.tasks.length === 0) {
      lines.push(`${result.name}:`);
      lines.push(`  (не было задач в работе)`);
      lines.push('');
      continue;
    }

    lines.push(`${result.name}:`);

    // Separate visible and invisible tasks
    const visibleTasks = result.tasks.filter(t => t.visible);
    const invisibleTasks = result.tasks.filter(t => !t.visible);

    // Show visible tasks first
    for (const task of visibleTasks) {
      totalWorked++;
      // План = timeEstimate (TIME_ESTIMATE = запланированное), Факт = today elapsed (списано за сегодня), Всего = timeSpentTotal (TIME_SPENT_IN_LOGS = общее затраченное)
      const planStr = formatTime(task.timeEstimate);
      const factStr = formatTime(task.timeSpent);
      const totalStr = formatTime(task.timeSpentTotal);
      const timeInfo = ` План (${planStr}) Факт (${factStr}) Всего (${totalStr})`;
      const link = `[URL=${TASK_URL}${task.id}/]${task.title}[/URL]`;

      if (task.eodUnknown) {
        totalUnknown++;
        lines.push(`  ⚠️ ${link}${timeInfo} — нет доступа к чату`);
      } else if (task.eodPresent) {
        totalWithEod++;
        lines.push(`  ✅ ${link}${timeInfo} — ЕОД добавлен`);
      } else {
        totalWithoutEod++;
        lines.push(`  ❌ ${link}${timeInfo} — ЕОД отсутствует`);
      }
    }

    // Show invisible tasks (just task IDs + time)
    for (const task of invisibleTasks) {
      totalWorked++;
      totalUnknown++;
      totalInvisible++;
      const factStr = formatTime(task.timeSpent);
      const link = `[URL=${TASK_URL}${task.id}/]#${task.id}[/URL]`;
      lines.push(`  ⚠️ ${link} Факт (${factStr}) — нет доступа к задаче`);
    }

    lines.push('');
  }

  lines.push(`---`);
  let summary = `В работе сегодня: ${totalWorked} | ЕОД ✅: ${totalWithEod} | ЕОД ❌: ${totalWithoutEod}`;
  if (totalUnknown > 0) summary += ` | Не проверено: ${totalUnknown}`;
  lines.push(summary);

  if (totalInvisible > 0) {
    lines.push('');
    lines.push(`⚠️ ${totalInvisible} задач без доступа — нужен админ-вебхук от user 1 (Владимир)`);
    lines.push(`Бот видит учёт времени, но не может читать чаты этих задач`);
  }

  return lines.join('\n');
}

async function sendReport(text) {
  const params = { MESSAGE: text };

  if (config.REPORT_MODE === 'private') {
    params.USER_ID = config.REPORT_USER_ID;
    console.log(`[Send] Private message to user ${config.REPORT_USER_ID}`);
  } else if (config.REPORT_CHAT_ID) {
    params.CHAT_ID = config.REPORT_CHAT_ID;
    console.log(`[Send] Group message to chat ${config.REPORT_CHAT_ID}`);
  } else {
    throw new Error('No report target. Set REPORT_MODE=private or REPORT_CHAT_ID.');
  }

  // Disable URL preview (prevents Bitrix from expanding first link as rich card)
  params.URL_PREVIEW = 'N';

  const result = await bxSend('im.message.add', params);
  console.log('[Send] Response:', JSON.stringify(result).substring(0, 300));

  if (result?.error) {
    throw new Error(`Bitrix API error: ${result.error_description || result.error}`);
  }

  return result;
}

// Run
main();
