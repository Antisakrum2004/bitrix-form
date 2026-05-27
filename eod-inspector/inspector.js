/**
 * EOD Inspector — Main Script v3
 *
 * Checks which tasks were started/worked on today and whether developers filled their EOD.
 *
 * Key API findings:
 *   - tasks.task.list with POST + nested filter{} works (GET query params ignored RESPONSIBLE_ID)
 *   - Comments are in chat system, NOT forum: use im.dialog.messages.get with task.chatId
 *   - Bot (154) can only see tasks where it's an observer — misses older tasks
 *   - Need admin webhook (user 1) for full task visibility
 *   - "начал выполнять" is a system message with author_id=0
 *   - Tasks from form are created in status=2, so no "начал выполнять" event
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

const DATA_WEBHOOK = config.DATA_WEBHOOK;
const SEND_WEBHOOK = config.BOT_WEBHOOK;

console.log(`[EOD Inspector v3] Target date: ${TARGET_DATE}`);
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

// Read data (tasks, chats) — use admin webhook if available
function bxData(method, params = {}) {
  return bxRequest(DATA_WEBHOOK, method, params);
}

// Send messages — always use bot webhook (so messages come from bot)
function bxSend(method, params = {}) {
  return bxRequest(SEND_WEBHOOK, method, params);
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
      const r = await bxData('tasks.task.list', {
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
            const chatR = await bxData('im.dialog.messages.get', {
              CHAT_ID: chatId,
              LIMIT: config.MAX_MESSAGES_PER_CHAT,
            });
            messages = chatR?.result?.messages || [];
          } catch (e) {
            console.log(`    [!] Chat ${chatId} access denied for task ${taskId}: ${e.message}`);
            // If we can't read chat, still include the task but can't check EOD
            messages = [];
          }
        }

        // Step 3: Determine work type for this task today
        const workType = getWorkType(messages, dev.id, dateStr, {
          taskStatus,
          createdDate,
          statusChangedDate,
        });

        if (workType) {
          // Step 4: Check for EOD comment from developer today
          const hasEod = checkEodComment(messages, dev.id, dateStr);
          const chatAccessOk = messages.length > 0;
          const stillRunning = String(taskStatus) === '2';
          const noAccess = workType === 'NO_ACCESS';

          devResults[dev.id].tasks.push({
            id: taskId,
            title: taskTitle,
            status: taskStatus,
            eodPresent: hasEod,
            eodUnknown: !chatAccessOk || noAccess,
            stillRunning,
            workType: noAccess ? null : workType,
          });

          if (noAccess) {
            console.log(`    #${taskId} [NO ACCESS] → can't verify work or EOD`);
          } else {
            console.log(`    #${taskId} [${workType}] → EOD: ${!chatAccessOk ? '???' : hasEod ? 'YES' : 'NO'}${stillRunning ? ' (running)' : ''}`);
          }
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
 * Determine the type of work the developer did on the task on the target date.
 *
 * STRICT MODE: Only count tasks where the developer explicitly STARTED working.
 * "Изменил описание", "добавил файл" etc. do NOT count — developer must have
 * clicked "Начать выполнение" or equivalent.
 *
 * Valid work-start events (from chat system messages):
 * 1. "начал выполнять задачу" — clicked "Start" button
 * 2. "вернул выполненную задачу в работу" — returned completed task to work
 * 3. "продолжил/возобновил выполнение задачи" — resumed after pause
 *
 * Also valid (no chat message but clear work signal):
 * 4. Task created today via form in status=2 (form auto-starts task)
 *    BUT only if there's NO "Ждёт выполнения" status in between
 *
 * NOT valid (should NOT trigger EOD requirement):
 * - Changed description → didn't start working
 * - Added file → didn't start working  
 * - Added time manually → might be fixing time, not working
 * - Status changed by someone else → not developer's action
 */
function getWorkType(messages, devId, dateStr, taskInfo) {
  const { taskStatus, createdDate, statusChangedDate } = taskInfo;
  const chatAccessOk = messages.length > 0;

  // Priority 1: Check chat for EXPLICIT work-start events today
  if (chatAccessOk) {
    for (const msg of messages) {
      if (msg.author_id !== 0) continue; // System messages only
      const msgDate = (msg.date || '').substring(0, 10);
      if (msgDate !== dateStr) continue;

      const text = msg.text || '';
      const hasDevMention = text.includes(`[USER=${devId}]`);

      if (hasDevMention) {
        // Developer explicitly started working
        if (text.includes('начал выполнять задачу') || text.includes('начала выполнять задачу')) return 'начал выполнять';
        if (text.includes('вернул выполненную задачу в работу') || text.includes('вернула выполненную задачу в работу')) return 'вернул в работу';
        if (text.includes('возобновил') || text.includes('возобновила') || text.includes('продолжил') || text.includes('продолжила')) return 'продолжил работу';

        // Developer completed work (means they were working on it)
        if (text.includes('завершил задачу') || text.includes('завершила задачу')) return 'завершена';
        if (text.includes('изменил стадию на Готово') || text.includes('изменила стадию на Готово')) return 'завершена';
        if (text.includes('изменил стадию на Тестируется') || text.includes('изменила стадию на Тестируется')) return 'на тестировании';

        // Pause/stop = they WERE working but paused (still needs EOD for work done)
        if (text.includes('приостановил') || text.includes('приостановила')) return 'приостановлена';
        if (text.includes('остановил работу') || text.includes('остановила работу')) return 'работа остановлена';
      }
    }
  }

  // Priority 2: Task created today AND currently in "Выполняется" (status=2)
  // Form creates tasks in status=2 — developer is expected to start immediately.
  // But verify: if chat is accessible, check that developer didn't just ignore the task.
  if (createdDate && createdDate.substring(0, 10) === dateStr && String(taskStatus) === '2') {
    // If chat is accessible, verify developer actually started (or task is brand new)
    if (chatAccessOk) {
      // Check if there's a "начал выполнять" event after creation
      const startMsg = messages.find(m => {
        if (m.author_id !== 0) return false;
        const text = m.text || '';
        return text.includes(`[USER=${devId}]`) && text.includes('начал выполнять задачу');
      });
      if (startMsg) return 'начал выполнять';
      
      // No "начал выполнять" but task is in status 2 and created today
      // Form creates tasks directly in status 2, so this is normal
      return 'создана в работе';
    }
    // No chat access — assume created-in-work is valid
    return 'создана в работе';
  }

  // Priority 3: No chat access but task had activity today
  // Can't verify work-start event → mark as "unknown" so report shows warning
  if (!chatAccessOk && statusChangedDate && statusChangedDate.substring(0, 10) === dateStr) {
    return 'NO_ACCESS'; // Special marker — can't verify
  }

  // No work-start event found → developer did NOT work on this task today
  return null;
}

/**
 * Check if the developer posted an EOD comment today.
 * EOD = user comment (not bot, not system) containing at least 2 EOD keywords.
 */
function checkEodComment(messages, devId, dateStr) {
  for (const msg of messages) {
    if (msg.author_id === 0) continue;
    if (Number(msg.author_id) === config.BOT_ID) continue;
    if (String(msg.author_id) !== String(devId)) continue;

    const msgDate = (msg.date || '').substring(0, 10);
    if (msgDate !== dateStr) continue;

    const text = (msg.text || '').toLowerCase();
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
  let totalUnknown = 0;

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
      if (task.eodUnknown) {
        totalUnknown++;
        lines.push(`  ⚠️ ${task.title} — нет доступа к чату, ЕОД не проверен`);
      } else if (task.eodPresent) {
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
  let summary = `Запущено задач: ${totalStarted} | ЕОД добавлен: ${totalWithEod} | ЕОД отсутствует: ${totalWithoutEod}`;
  if (totalUnknown > 0) summary += ` | Не проверено: ${totalUnknown}`;

  if (totalUnknown > 0) {
    lines.push(summary);
    lines.push('');
    lines.push(`⚠️ ${totalUnknown} задач без доступа к чату — нужен админский вебхук`);
    lines.push(`Создайте входящий вебхук от имени администратора (user 1)`);
    lines.push(`и установите ADMIN_WEBHOOK в конфигурации`);
  } else {
    lines.push(summary);
  }

  return lines.join('\n');
}

/**
 * Send report via Bitrix24 IM.
 * Always uses bot webhook so message comes from bot.
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

  const result = await bxSend('im.message.add', params);
  console.log('[Send] Response:', JSON.stringify(result).substring(0, 300));

  if (result?.error) {
    throw new Error(`Bitrix API error: ${result.error_description || result.error}`);
  }

  return result;
}

// Run
main();
