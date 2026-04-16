const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const sendMessage = async (chatId, message) => {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML'
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
};

const sendLessonReminder = async (chatId, name, tutorName, subject, time, isStudent) => {
  const message = isStudent ?
    `⏰ <b>Напоминание об уроке!</b>\n\nЗдравствуйте, ${name}!\n\nВаш урок по <b>${subject}</b> с репетитором <b>${tutorName}</b> начинается через 1 час.\n\n🕐 Время: ${time}\n\n👉 <a href="https://bilimly.kg/dashboard.html">Открыть кабинет</a>` :
    `⏰ <b>Напоминание об уроке!</b>\n\nЗдравствуйте, ${name}!\n\nВаш урок со студентом <b>${tutorName}</b> по <b>${subject}</b> начинается через 1 час.\n\n🕐 Время: ${time}\n\n👉 <a href="https://bilimly.kg/tutor-dashboard.html">Открыть кабинет</a>`;
  
  return sendMessage(chatId, message);
};

const sendBookingNotification = async (chatId, name, subject, studentName, date, time, isTutor) => {
  const message = isTutor ?
    `📅 <b>Новое бронирование!</b>\n\nСтудент <b>${studentName}</b> записался на урок по <b>${subject}</b>.\n\n📆 Дата: ${date}\n🕐 Время: ${time}\n\n👉 <a href="https://bilimly.kg/tutor-dashboard.html">Подтвердить урок</a>` :
    `✅ <b>Урок забронирован!</b>\n\nВы записались на урок по <b>${subject}</b>.\n\n📆 Дата: ${date}\n🕐 Время: ${time}\n\n👉 <a href="https://bilimly.kg/dashboard.html">Открыть кабинет</a>`;
  
  return sendMessage(chatId, message);
};

const sendApprovalNotification = async (chatId, firstName) => {
  const message = `🎉 <b>Поздравляем, ${firstName}!</b>\n\nВаш профиль репетитора одобрен на Bilimly.kg!\n\nТеперь студенты могут записываться к вам.\n\n👉 <a href="https://bilimly.kg/tutor-dashboard.html">Открыть кабинет репетитора</a>`;
  return sendMessage(chatId, message);
};

module.exports = { sendMessage, sendLessonReminder, sendBookingNotification, sendApprovalNotification };
