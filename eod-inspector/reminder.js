/**
 * EOD Reminder — sends reminders to developers who haven't filled EOD
 *
 * Usage:
 *   node reminder.js              # today, round 1 (18:00)
 *   node reminder.js --round 2    # round 2 (19:00, stricter tone)
 *   node reminder.js 2025-05-26   # specific date
 *   node reminder.js --dry-run    # don't send, just print
 *
 * Logic:
 *   1. Find tasks each developer worked on today (same as inspector)
 *   2. Check EOD status for each task
 *   3. If developer has ANY tasks without EOD → send reminder
 *   4. If ALL tasks have EOD → skip (no reminder)
 *   5. In TEST_MODE: send all reminders to Andrey (116) instead of developers
 */

const config = require('./config');
const https = require('https');

// ─── Args ───
const TARGET_DATE = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || getTodayMSC();
const DRY_RUN = process.argv.includes('--dry-run');
const ROUND = parseInt(process.argv.find(a => a.startsWith('--round'))?.split('=')[1] || '1', 10);
const TEST_MODE = false; // Send reminders directly to developers

function getTodayMSC() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: config.TIMEZONE });
}

const DATA_WEBHOOK = config.DATA_WEBHOOK;
const SEND_WEBHOOK = config.BOT_WEBHOOK;

console.log(`[EOD Reminder] Date: ${TARGET_DATE}, Round: ${ROUND}, Test: ${TEST_MODE}`);
console.log(`[EOD Reminder] Dry run: ${DRY_RUN}`);

// ─── Bitrix24 API helpers (same as inspector) ───
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

function bxData(method, params = {}) { return bxRequest(DATA_WEBHOOK, method, params); }
function bxSend(method, params = {}) { return bxRequest(SEND_WEBHOOK, method, params); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const TASK_URL = `https://${config.B24_DOMAIN}/company/personal/user/${config.REPORT_USER_ID}/tasks/task/view/`;

// ─── Core detection logic (shared with inspector) ───

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

    if (r?.error) break;

    const items = r?.result || [];
    for (const item of items) {
      const taskId = String(item.TASK_ID || '');
      if (taskId && !workedTasks.has(taskId)) {
        workedTasks.set(taskId, { seconds: Number(item.SECONDS || 0) });
      }
    }

    if (!r?.next) break;
    start = r.next;
  }

  return workedTasks;
}

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
      if (matchCount >= 2) return { present: true, unknown: false };
    }
    return { present: false, unknown: false };
  } catch (e) {
    return { present: false, unknown: true };
  }
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}:${String(m).padStart(2, '0')}`;
  if (h > 0) return `${h}ч`;
  return `${m}м`;
}

// ─── Main ───

async function main() {
  try {
    const reminders = await buildReminders(TARGET_DATE);
    console.log('\n[Reminders to send]:');
    for (const r of reminders) {
      console.log(`  → ${r.name} (tasks: ${r.tasks.length}, missing EOD: ${r.missingTasks.length})`);
    }

    if (reminders.length === 0) {
      console.log('\n[✓] All developers have EOD — no reminders needed!');
      // Still send a brief "all good" message to Andrey in test mode
      if (TEST_MODE && !DRY_RUN) {
        await sendToUser(config.REPORT_USER_ID, '✅ Все разработчики заполнили ЕОД! Напоминания не нужны.');
      }
      return;
    }

    if (!DRY_RUN) {
      for (const reminder of reminders) {
        const targetUserId = TEST_MODE ? config.REPORT_USER_ID : reminder.devId;
        await sendToUser(targetUserId, reminder.message);
        console.log(`  [✓] Sent to user ${targetUserId} (${TEST_MODE ? 'TEST→Андрей' : reminder.name})`);
        await delay(500);
      }

      // Send summary to Andrey
      const summaryLines = [
        `⏰ Напоминания (раунд ${ROUND}) за ${TARGET_DATE.split('-').reverse().join('.')}`,
        '',
      ];
      for (const r of reminders) {
        summaryLines.push(`${r.name}: ${r.missingTasks.length} из ${r.tasks.length} задач без ЕОД`);
      }
      summaryLines.push('');
      summaryLines.push(`Отправлено: ${reminders.length} напоминаний`);

      if (!TEST_MODE) {
        // In production, also send summary to Andrey
        await sendToUser(config.REPORT_USER_ID, summaryLines.join('\n'));
      }
      console.log('\n[✓] All reminders sent.');
    } else {
      console.log('\n[DRY RUN] Messages that would be sent:');
      for (const r of reminders) {
        console.log(`\n--- To: ${r.name} (id=${r.devId}) ---`);
        console.log(r.message);
      }
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
    if (!DRY_RUN) process.exit(1);
  }
}

async function buildReminders(dateStr) {
  const reminders = [];

  for (const dev of config.DEVELOPERS) {
    console.log(`\n[Checking] ${dev.name} (id=${dev.id})...`);

    try {
      // Step 1: Get time entries
      const workedTasks = await fetchTimeEntries(dev.id, dateStr);
      console.log(`  Found ${workedTasks.size} tasks with time entries`);

      if (workedTasks.size === 0) {
        console.log(`  No tasks — skipping`);
        continue;
      }

      // Step 2: Get task details
      const taskIds = [...workedTasks.keys()];
      const taskDetails = new Map();

      try {
        const r = await bxData('tasks.task.list', {
          filter: { ID: taskIds },
          select: ['ID', 'TITLE', 'CHAT_ID'],
        });
        const tasks = r?.result?.tasks || [];
        for (const t of tasks) {
          taskDetails.set(String(t.id), {
            title: t.title || '(без названия)',
            chatId: t.chatId,
          });
        }
      } catch (e) {
        console.log(`  [!] Error fetching task details: ${e.message}`);
      }

      // Step 3: Check EOD for each task
      const allTasks = [];
      const missingTasks = [];

      for (const [taskId, info] of workedTasks) {
        const detail = taskDetails.get(taskId);
        const title = detail?.title || `Задача #${taskId}`;
        const chatId = detail?.chatId || null;
        const timeStr = info.seconds > 0 ? ` (${formatTime(info.seconds)})` : '';

        const eodResult = await checkEOD(chatId, dev.id, dateStr);
        await delay(300);

        const taskInfo = { id: taskId, title, timeStr, eodPresent: eodResult.present, eodUnknown: eodResult.unknown };
        allTasks.push(taskInfo);

        if (!eodResult.present) {
          missingTasks.push(taskInfo);
        }

        const eodStr = eodResult.unknown ? '???' : eodResult.present ? '✅' : '❌';
        console.log(`  #${taskId} ${eodStr} ${title}${timeStr}`);
      }

      // Step 4: If all EODs present → no reminder
      if (missingTasks.length === 0) {
        console.log(`  All EODs present — no reminder needed`);
        continue;
      }

      // Step 5: Build reminder message
      const dateFormatted = dateStr.split('-').reverse().join('.');
      const lines = [];

      if (ROUND === 1) {
        lines.push(`⏰ Напоминание: ЕОД за ${dateFormatted}`);
        lines.push('');
        lines.push(`${dev.name}, у вас есть задачи без ЕОД:`);
      } else {
        lines.push(`🔔 Повторное напоминание: ЕОД за ${dateFormatted}`);
        lines.push('');
        lines.push(`${dev.name}, до конца рабочего дня осталось меньше часа!`);
        lines.push('Пожалуйста, заполните ЕОД по задачам:');
      }

      lines.push('');
      for (const task of missingTasks) {
        const link = `[URL=${TASK_URL}${task.id}/]${task.title}[/URL]`;
        lines.push(`  ❌ ${link}${task.timeStr}`);
      }

      lines.push('');
      lines.push('Формат ЕОД: Done / Test / Next / Block');

      reminders.push({
        devId: dev.id,
        name: dev.name,
        tasks: allTasks,
        missingTasks,
        message: lines.join('\n'),
      });
    } catch (err) {
      console.error(`  [!] Error for ${dev.name}: ${err.message}`);
    }
  }

  return reminders;
}

async function sendToUser(userId, text) {
  const params = {
    USER_ID: String(userId),
    MESSAGE: text,
    URL_PREVIEW: 'N',
    SKIP_CONNECTOR_CHECK: 'Y',
  };

  const result = await bxSend('im.message.add', params);
  if (result?.error) {
    throw new Error(`Bitrix API error: ${result.error_description || result.error}`);
  }
  return result;
}

main();
