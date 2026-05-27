/**
 * EOD Inspector — Main Script v2
 *
 * Checks which tasks were started/worked on today and whether developers filled their EOD.
 *
 * Key API findings:
 *   - tasks.task.list with POST + nested filter{} works (GET query params ignored RESPONSIBLE_ID)
 *   - Comments are in chat system, NOT forum: use im.dialog.messages.get with task.chatId
 *   - "начал выполнять" is a system message with author_id=0
 *   - Tasks from form are created in status=2, so no "начал выполнять" event
 *   - "вернул в работу" also counts as working on the task
 *
 * Usage:
 *   node inspector.js                  — check today
 *   node inspector.js 2026-05-26       — check specific date (YYYY-MM-DD)
 *   node inspector.js --dry-run        — only print report, don't send
 */

const config = require('./config');
const https = require('https');

// ─── Date setup ───
const TARGET_DATE = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || getTodayMSC();
const DRY_RUN = process.argv.includes('--dry-run');

function getTodayMSC() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: config.TIMEZONE });
}

console.log(`[EOD Inspector v2] Target date: ${TARGET_DATE}`);
console.log(`[EOD Inspector] Report mode: ${config.REPORT_MODE}`);
console.log(`[EOD Inspector] Dry run: ${DRY_RUN}`);

// ─── Bitrix24 API helper (POST only — GET ignores filters) ───
function bxPost(method, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.BOT_WEBHOOK + method);
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

  // Step 1: Get all tasks with activity today for each developer
  console.log('\n[Step 1] Fetching tasks with activity on ' + dateStr + '...');

  for (const dev of config.DEVELOPERS) {
    try {
      const r = await bxPost('tasks.task.list', {
        filter: {
          RESPONSIBLE_ID: dev.id,
          '>=DATE_ACTIVITY': dateStr + 'T00:00:00',
          '<=DATE_ACTIVITY': dateStr + 'T23:59:59',
        },
        select: ['ID', 'TITLE', 'STATUS', 'STATUS_CHANGED_DATE', 'RESPONSIBLE_ID', 'CHAT_ID', 'CREATED_DATE'],
      });

      const tasks = r?.result?.tasks || [];
      console.log(`  ${dev.name}: ${tasks.length} tasks with activity`);

      for (const task of tasks) {
        const taskId = task.id;
        const chatId = task.chatId;
        const taskTitle = task.title || '(без названия)';
        const taskStatus = task.status;
        const createdDate = task.createdDate || '';
        const statusChangedDate = task.statusChangedDate || '';

        // Step 2: Get chat messages for this task
        let messages = [];
        if (chatId) {
          try {
            const chatR = await bxPost('im.dialog.messages.get', {
              CHAT_ID: chatId,
              LIMIT: config.MAX_MESSAGES_PER_CHAT,
            });
            messages = chatR?.result?.messages || [];
          } catch (e) {
            console.log(`    [!] Error fetching chat for task ${taskId}: ${e.message}`);
          }
        }

        // Step 3: Check if developer started/worked on task today
        const workedToday = checkWorkedToday(messages, dev.id, dateStr, {
          taskStatus,
          createdDate,
          statusChangedDate,
        });

        if (workedToday) {
          // Step 4: Check for EOD comment from developer today
          const hasEod = checkEodComment(messages, dev.id, dateStr);
          const stillRunning = String(taskStatus) === '2';

          devResults[dev.id].tasks.push({
            id: taskId,
            title: taskTitle,
            status: taskStatus,
            eodPresent: hasEod,
            stillRunning,
            startEvent: workedToday,
          });

          console.log(`    #${taskId} ${workedToday} → EOD: ${hasEod ? 'YES' : 'NO'}${stillRunning ? ' (still running)' : ''}`);
        }
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
 * Check if the developer started/worked on the task on the target date.
 *
 * Detection methods (in priority order):
 * 1. Chat: "начал выполнять задачу" today mentioning this developer
 * 2. Chat: "вернул выполненную задачу в работу" today
 * 3. Chat: "завершил задачу" / "изменил стадию" today from developer
 * 4. Task created today AND assigned to this developer (form creates in status=2)
 * 5. STATUS_CHANGED_DATE today + any active status (means developer worked on it)
 */
function checkWorkedToday(messages, devId, dateStr, taskInfo) {
  const { taskStatus, createdDate, statusChangedDate } = taskInfo;

  // Method 1-3: Check chat for work-related events today from our developer
  for (const msg of messages) {
    if (msg.author_id !== 0) continue; // System messages only
    const msgDate = (msg.date || '').substring(0, 10);
    if (msgDate !== dateStr) continue;

    const text = msg.text || '';
    const hasDevMention = text.includes(`[USER=${devId}]`);

    if (hasDevMention) {
      // Check start/work events
      for (const event of config.START_EVENTS) {
        if (text.toLowerCase().includes(event.toLowerCase())) {
          return event;
        }
      }
      // Check completion events (developer worked on it today)
      if (text.includes('завершил задачу')) return 'завершена сегодня';
      if (text.includes('изменил стадию на Готово')) return 'завершена сегодня';
      if (text.includes('изменил стадию на Тестируется')) return 'на тестировании';
    }
  }

  // Method 4: Task created today and assigned to this developer
  // (Form creates tasks in status=2 "Выполняется", no "начал выполнять" event)
  if (createdDate && createdDate.substring(0, 10) === dateStr) {
    return 'создана в работе';
  }

  // Method 5: Status changed today — developer actively worked on it
  if (statusChangedDate && statusChangedDate.substring(0, 10) === dateStr &&
      ['2', '3', '4', '5', '-3'].includes(String(taskStatus))) {
    return 'статус изменён сегодня';
  }

  // No work event found for today
  return null;
}

/**
 * Check if the developer posted an EOD comment today.
 * EOD = user comment (not bot, not system) containing at least 2 EOD keywords.
 */
function checkEodComment(messages, devId, dateStr) {
  for (const msg of messages) {
    // Skip system messages
    if (msg.author_id === 0) continue;
    // Skip bot messages
    if (Number(msg.author_id) === config.BOT_ID) continue;
    // Only messages from our developer
    if (String(msg.author_id) !== String(devId)) continue;

    const msgDate = (msg.date || '').substring(0, 10);
    if (msgDate !== dateStr) continue;

    const text = (msg.text || '').toLowerCase();
    // Count EOD keywords present in the message
    const matchCount = config.EOD_KEYWORDS.filter(kw => text.includes(kw)).length;
    if (matchCount >= 2) {
      return true;
    }
  }
  return false;
}

/**
 * Format the report for sending via Bitrix IM.
 */
function formatReport(dateStr, devResults) {
  const dateFormatted = dateStr.split('-').reverse().join('.');
  let lines = [];

  lines.push(`📋 EOD-сводка за ${dateFormatted}`);
  lines.push('');

  let totalStarted = 0;
  let totalWithEod = 0;
  let totalWithoutEod = 0;

  for (const dev of config.DEVELOPERS) {
    const result = devResults[dev.id];
    if (result.error) {
      lines.push(`${result.name}: [ошибка] ${result.error}`);
      lines.push('');
      continue;
    }

    if (result.tasks.length === 0) {
      lines.push(`${result.name}:`);
      lines.push(`  (не было запущенных задач)`);
      lines.push('');
      continue;
    }

    lines.push(`${result.name}:`);
    for (const task of result.tasks) {
      totalStarted++;
      if (task.eodPresent) {
        totalWithEod++;
        lines.push(`  ✅ ${task.title} — ЕОД добавлен`);
      } else {
        totalWithoutEod++;
        if (task.stillRunning) {
          lines.push(`  ❌ ${task.title} — задача ещё выполняется, ЕОД не предоставлен`);
        } else {
          lines.push(`  ❌ ${task.title} — ЕОД отсутствует`);
        }
      }
    }
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`Запущено задач: ${totalStarted} | ЕОД добавлен: ${totalWithEod} | ЕОД отсутствует: ${totalWithoutEod}`);

  return lines.join('\n');
}

/**
 * Send report via Bitrix24 IM.
 */
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

  const result = await bxPost('im.message.add', params);
  console.log('[Send] Response:', JSON.stringify(result).substring(0, 300));

  if (result?.error) {
    throw new Error(`Bitrix API error: ${result.error_description || result.error}`);
  }

  return result;
}

// Run
main();
