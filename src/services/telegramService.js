const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_TELEGRAM_CHAT_ID;

const sendMessage = async (chatId, message) => {
  return new Promise((resolve, reject) => {
    if (!TELEGRAM_TOKEN) return resolve({ ok: false, skipped: 'no_token' });
    if (!chatId) return resolve({ ok: false, skipped: 'no_chat_id' });
    const body = JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ ok: false, raw: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
};

// ── EXISTING USER-FACING NOTIFICATIONS (unchanged) ──────────────

const sendLessonReminder = async (chatId, name, tutorName, subject, time, isStudent) => {
  const message = isStudent
    ? `⏰ <b>Напоминание об уроке!</b>\n\nЗдравствуйте, ${name}!\n\nВаш урок по <b>${subject}</b> с репетитором <b>${tutorName}</b> начинается через 1 час.\n\n🕐 Время: ${time}\n\n👉 <a href="https://bilimly.kg/dashboard.html">Открыть кабинет</a>`
    : `⏰ <b>Напоминание об уроке!</b>\n\nЗдравствуйте, ${name}!\n\nВаш урок со студентом <b>${tutorName}</b> по <b>${subject}</b> начинается через 1 час.\n\n🕐 Время: ${time}\n\n👉 <a href="https://bilimly.kg/tutor-dashboard.html">Открыть кабинет</a>`;
  return sendMessage(chatId, message);
};

const sendBookingNotification = async (chatId, name, subject, studentName, date, time, isTutor) => {
  const message = isTutor
    ? `📅 <b>Новое бронирование!</b>\n\nСтудент <b>${studentName}</b> записался на урок по <b>${subject}</b>.\n\n📆 Дата: ${date}\n🕐 Время: ${time}\n\n👉 <a href="https://bilimly.kg/tutor-dashboard.html">Подтвердить урок</a>`
    : `✅ <b>Урок забронирован!</b>\n\nВы записались на урок по <b>${subject}</b>.\n\n📆 Дата: ${date}\n🕐 Время: ${time}\n\n👉 <a href="https://bilimly.kg/dashboard.html">Открыть кабинет</a>`;
  return sendMessage(chatId, message);
};

const sendApprovalNotification = async (chatId, firstName) => {
  const message = `🎉 <b>Поздравляем, ${firstName}!</b>\n\nВаш профиль репетитора одобрен на Bilimly.kg!\n\nТеперь студенты могут записываться к вам.\n\n👉 <a href="https://bilimly.kg/tutor-dashboard.html">Открыть кабинет репетитора</a>`;
  return sendMessage(chatId, message);
};

// ── ADMIN NOTIFICATIONS ─────────────────────────────────────────
// All admin functions silently no-op if ADMIN_TELEGRAM_CHAT_ID is unset.
// All are fire-and-forget (call with .catch) to never block HTTP handlers.

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const GRADE_LABEL = {
  primary: 'Начальная школа (1–4)',
  middle: 'Средняя школа (5–9)',
  high: 'Старшая школа (10–11)',
  ort_university: 'ОРТ / Университет',
};
const URGENCY_LABEL = {
  this_week: '⚡ На этой неделе',
  this_month: '📅 В течение месяца',
  exploring: '👀 Просто изучает',
};

const notifyAdminNewLead = async (lead, matchedTutors = []) => {
  if (!ADMIN_CHAT_ID) return { ok: false, skipped: 'no_admin_chat_id' };
  const grade = GRADE_LABEL[lead.grade_band] || lead.grade_band;
  const urgency = URGENCY_LABEL[lead.urgency] || lead.urgency;
  const tutorsLine = matchedTutors.length
    ? matchedTutors.map((t) => `• ${escapeHtml((t.first_name || '') + ' ' + (t.last_name || '').slice(0, 1))}. — ${t.hourly_rate} сом/ч`).join('\n')
    : '— нет подходящих';
  const msg =
    `🔔 <b>Новый лид</b>\n\n` +
    `📱 <code>${escapeHtml(lead.phone)}</code>\n` +
    `📚 ${escapeHtml(lead.subject)}\n` +
    `🎓 ${escapeHtml(grade)}\n` +
    `${urgency}\n\n` +
    `<b>Подобраны:</b>\n${tutorsLine}\n\n` +
    `<a href="https://bilimly.kg/admin.html">Открыть админку →</a>`;
  return sendMessage(ADMIN_CHAT_ID, msg);
};

const notifyAdminNewBooking = async ({ subject, amount, lessonDate, startTime, studentName, tutorName }) => {
  if (!ADMIN_CHAT_ID) return { ok: false, skipped: 'no_admin_chat_id' };
  const msg =
    `💰 <b>Новое бронирование</b>\n\n` +
    `👤 Студент: ${escapeHtml(studentName || 'Неизвестно')}\n` +
    `👨‍🏫 Репетитор: ${escapeHtml(tutorName || 'Неизвестно')}\n` +
    `📚 Предмет: ${escapeHtml(subject || '—')}\n` +
    `📆 ${escapeHtml(lessonDate)} в ${escapeHtml(startTime)}\n` +
    `💵 ${amount} сом`;
  return sendMessage(ADMIN_CHAT_ID, msg);
};

const notifyAdminNewTutorApplication = async (app) => {
  if (!ADMIN_CHAT_ID) return { ok: false, skipped: 'no_admin_chat_id' };
  const subjectsStr = Array.isArray(app.subjects) ? app.subjects.join(', ') : (app.subjects || '—');
  const msg =
    `👨‍🏫 <b>Новая заявка репетитора</b>\n\n` +
    `Имя: ${escapeHtml(app.full_name)}\n` +
    `Email: ${escapeHtml(app.email)}\n` +
    `Телефон: ${escapeHtml(app.phone || '—')}\n` +
    `Предметы: ${escapeHtml(subjectsStr)}\n` +
    `Опыт: ${app.experience_years || 0} лет\n` +
    `Ставка: ${app.hourly_rate || '—'} сом/ч\n\n` +
    `<a href="https://bilimly.kg/admin.html">Проверить →</a>`;
  return sendMessage(ADMIN_CHAT_ID, msg);
};

// Error notification with in-memory dedup: same error signature -> 1 ping per 15 min.
const recentErrorPings = new Map();
const ERROR_DEDUP_MS = 15 * 60 * 1000;

const notifyAdminError = async (route, error) => {
  if (!ADMIN_CHAT_ID) return { ok: false, skipped: 'no_admin_chat_id' };
  const errMsg = (error && error.message) ? String(error.message) : String(error);
  const signature = `${route}::${errMsg}`.slice(0, 200);
  const now = Date.now();
  const last = recentErrorPings.get(signature);
  if (last && (now - last) < ERROR_DEDUP_MS) return { ok: false, skipped: 'deduped' };
  recentErrorPings.set(signature, now);
  // Clean up old entries to prevent unbounded growth
  if (recentErrorPings.size > 100) {
    for (const [k, t] of recentErrorPings) {
      if ((now - t) > ERROR_DEDUP_MS) recentErrorPings.delete(k);
    }
  }
  const stack = (error && error.stack) ? String(error.stack).split('\n').slice(0, 4).join('\n') : '';
  const msg =
    `🚨 <b>Ошибка сервера</b>\n\n` +
    `Роут: <code>${escapeHtml(route)}</code>\n` +
    `Ошибка: <code>${escapeHtml(errMsg.slice(0, 300))}</code>\n\n` +
    (stack ? `<pre>${escapeHtml(stack)}</pre>` : '');
  return sendMessage(ADMIN_CHAT_ID, msg);
};

const sendAdminDailySummary = async (stats) => {
  if (!ADMIN_CHAT_ID) return { ok: false, skipped: 'no_admin_chat_id' };
  const msg =
    `📊 <b>Bilimly — итоги дня</b>\n` +
    `${stats.date}\n\n` +
    `<b>Лиды:</b> ${stats.leads_today}\n` +
    `  ⚡ На этой неделе: ${stats.leads_this_week}\n` +
    `  📅 В течение месяца: ${stats.leads_this_month}\n` +
    `  👀 Изучают: ${stats.leads_exploring}\n\n` +
    `<b>Бронирования:</b> ${stats.bookings_today} (${stats.revenue_today} сом)\n` +
    `<b>Новые заявки репетиторов:</b> ${stats.new_tutor_apps}\n` +
    `<b>Активных репетиторов:</b> ${stats.active_tutors}\n\n` +
    `<b>Требует внимания:</b>\n` +
    `  ⏳ Не связались с лидами: ${stats.uncontacted_leads}\n` +
    `  📝 Ждут проверки (репетиторы): ${stats.pending_tutor_apps}\n\n` +
    `<a href="https://bilimly.kg/admin.html">Открыть админку →</a>`;
  return sendMessage(ADMIN_CHAT_ID, msg);
};

module.exports = {
  sendMessage,
  sendLessonReminder,
  sendBookingNotification,
  sendApprovalNotification,
  notifyAdminNewLead,
  notifyAdminNewBooking,
  notifyAdminNewTutorApplication,
  notifyAdminError,
  sendAdminDailySummary,
};