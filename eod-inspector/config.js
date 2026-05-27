/**
 * EOD Inspector — Configuration
 */

module.exports = {
  // Bitrix24 domain
  B24_DOMAIN: '1c-cms.bitrix24.ru',

  // Bot webhook (user 154) — used for API calls AND sending reports
  BOT_WEBHOOK: 'https://1c-cms.bitrix24.ru/rest/154/f896em13hhazm006/',

  // Report mode: "private" → send to REPORT_USER_ID, "group" → send to REPORT_CHAT_ID
  REPORT_MODE: process.env.REPORT_MODE || 'private',

  // АМ (Андрей) — receives private reports
  REPORT_USER_ID: '116',

  // Group chat ID — fill later for team-wide reports
  REPORT_CHAT_ID: process.env.REPORT_CHAT_ID || '',

  // Developers to check
  DEVELOPERS: [
    { id: '18', name: 'Константин' },
    { id: '38', name: 'Александр' },
    { id: '54', name: 'Саша' },
    { id: '82', name: 'Тимур' },
    { id: '92', name: 'Елена' },
    { id: '98', name: 'Ольга' },
  ],

  // Bot ID (excluded from EOD checks — bot posts template, not real EOD)
  BOT_ID: 154,

  // EOD keywords — must have at least 2 to count as EOD
  EOD_KEYWORDS: ['done', 'test', 'next', 'block',
                  'готово', 'сделано', 'далее', 'блок',
                  'тест'],

  // Events that indicate developer worked on the task today
  START_EVENTS: [
    'начал выполнять задачу',
    'вернул выполненную задачу в работу',
    'возобновил выполнение задачи',
    'продолжил работу над задачей',
  ],

  // Timezone for date calculations
  TIMEZONE: 'Europe/Moscow',

  // Run hour (MSC) — for reference, cron handles actual scheduling
  RUN_HOUR_MSC: 20,

  // Max messages to fetch per task chat
  MAX_MESSAGES_PER_CHAT: 50,
};
