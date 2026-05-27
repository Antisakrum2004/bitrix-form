/**
 * EOD Inspector — Configuration
 *
 * IMPORTANT: The bot webhook (154) only sees tasks where it's an observer.
 * For full coverage, we need an admin webhook (user 1) that can see ALL tasks.
 * Set ADMIN_WEBHOOK below or as env variable.
 */

module.exports = {
  // Bitrix24 domain
  B24_DOMAIN: '1c-cms.bitrix24.ru',

  // Bot webhook (user 154) — used for sending reports
  BOT_WEBHOOK: 'https://1c-cms.bitrix24.ru/rest/154/f896em13hhazm006/',

  // Admin webhook (user 1 — Владимир) — used for task listing and chat reading
  // Has full access to ALL tasks and chats regardless of membership.
  // Create: Битрикс24 → Разработчикам → Другое → Входящий вебхук (user 1)
  // Required permissions: tasks, im, user
  ADMIN_WEBHOOK: process.env.ADMIN_WEBHOOK || '',

  // Which webhook to use for data access (task listing, chat reading)
  // Falls back to BOT_WEBHOOK if ADMIN_WEBHOOK is not set
  get DATA_WEBHOOK() {
    return this.ADMIN_WEBHOOK || this.BOT_WEBHOOK;
  },

  // Report mode: "private" → send to REPORT_USER_ID, "group" → send to REPORT_CHAT_ID
  REPORT_MODE: process.env.REPORT_MODE || 'group',

  // АМ (Андрей) — receives private reports
  REPORT_USER_ID: '116',

  // Group chat ID — Общий чат
  REPORT_CHAT_ID: process.env.REPORT_CHAT_ID || '2',

  // Developers to check
  DEVELOPERS: [
    { id: '18', name: 'Константин' },
    { id: '38', name: 'Александр' },
    { id: '54', name: 'Саша' },
    { id: '82', name: 'Тимур' },
    { id: '92', name: 'Елена' },
    { id: '98', name: 'Ольга' },
    { id: '156', name: 'Марина' },
  ],

  // Bot ID (excluded from EOD checks — bot posts template, not real EOD)
  BOT_ID: 154,

  // EOD keywords — must have at least 2 to count as EOD
  EOD_KEYWORDS: ['done', 'test', 'next', 'block',
                  'готово', 'сделано', 'далее', 'блок',
                  'тест'],

  // Timezone for date calculations
  TIMEZONE: 'Europe/Moscow',

  // Run hour (MSC) — for reference, cron handles actual scheduling
  RUN_HOUR_MSC: 20,

  // Max messages to fetch per task chat
  MAX_MESSAGES_PER_CHAT: 50,
};
