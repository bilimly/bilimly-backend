const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../config/database');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WA_API_URL = 'https://waba.360dialog.io/v1/messages';
const WA_HEADERS = {
  'D360-API-KEY': process.env.WHATSAPP_API_KEY,
  'Content-Type': 'application/json',
};

// ── SEND WHATSAPP MESSAGE ──────────────────────────────────
const sendMessage = async (phone, message) => {
  if (!process.env.WHATSAPP_API_KEY) {
    console.log(`[WhatsApp DEMO] To: ${phone}\nMessage: ${message}`);
    return { demo: true };
  }
  try {
    const response = await axios.post(WA_API_URL, {
      messaging_product: 'whatsapp',
      to: phone.replace(/[^0-9]/g, ''),
      type: 'text',
      text: { body: message }
    }, { headers: WA_HEADERS });
    return response.data;
  } catch (err) {
    console.error('WhatsApp send error:', err.message);
  }
};

// ── BOOKING CONFIRMATION ───────────────────────────────────
const sendBookingConfirmation = async (bookingId) => {
  try {
    const result = await pool.query(
      `SELECT b.*, u.phone, u.first_name, u.language_preference,
              ut.first_name as tutor_first_name, ut.last_name as tutor_last_name
       FROM bookings b
       JOIN users u ON b.student_id = u.id
       JOIN tutor_profiles tp ON b.tutor_id = tp.id
       JOIN users ut ON tp.user_id = ut.id
       WHERE b.id = $1`,
      [bookingId]
    );
    const b = result.rows[0];
    if (!b?.phone) return;

    const messages = {
      ru: `✅ *Bilimpark.kg* — Урок подтверждён!\n\n👤 Репетитор: ${b.tutor_first_name} ${b.tutor_last_name}\n📅 Дата: ${new Date(b.lesson_date).toLocaleDateString('ru-RU')}\n⏰ Время: ${b.start_time}\n📚 Предмет: ${b.subject}\n\nСсылка на урок будет отправлена за 30 минут до начала.\n\nЕсть вопросы? Пишите сюда 💬`,
      ky: `✅ *Bilimpark.kg* — Сабак тастыкталды!\n\n👤 Мугалим: ${b.tutor_first_name} ${b.tutor_last_name}\n📅 Күнү: ${new Date(b.lesson_date).toLocaleDateString('ru-RU')}\n⏰ Убактысы: ${b.start_time}\n📚 Сабак: ${b.subject}\n\nУрокка шилтеме 30 мүнөт мурун жиберилет.\n\nСуроолоруңуз барбы? Бул жерге жазыңыз 💬`,
      en: `✅ *Bilimpark.kg* — Lesson Confirmed!\n\n👤 Tutor: ${b.tutor_first_name} ${b.tutor_last_name}\n📅 Date: ${new Date(b.lesson_date).toLocaleDateString()}\n⏰ Time: ${b.start_time}\n📚 Subject: ${b.subject}\n\nLesson link will be sent 30 minutes before start.\n\nAny questions? Write here 💬`
    };

    const lang = b.language_preference || 'ru';
    await sendMessage(b.phone, messages[lang] || messages.ru);
  } catch (err) {
    console.error('Booking confirmation error:', err);
  }
};

// ── LESSON REMINDER (30 min before) ───────────────────────
const sendLessonReminder = async (bookingId) => {
  try {
    const result = await pool.query(
      `SELECT b.*, u.phone, u.first_name, u.language_preference,
              ut.first_name as tutor_first_name
       FROM bookings b
       JOIN users u ON b.student_id = u.id
       JOIN tutor_profiles tp ON b.tutor_id = tp.id
       JOIN users ut ON tp.user_id = ut.id
       WHERE b.id = $1`,
      [bookingId]
    );
    const b = result.rows[0];
    if (!b?.phone || !b.meeting_url) return;

    const messages = {
      ru: `⏰ *Bilimpark.kg* — Ваш урок через 30 минут!\n\n👤 Репетитор: ${b.tutor_first_name}\n🔗 Войти в урок: ${b.meeting_url}\n\nУдачи! 🌟`,
      ky: `⏰ *Bilimpark.kg* — Сабагыңыз 30 мүнөттөн кийин!\n\n👤 Мугалим: ${b.tutor_first_name}\n🔗 Сабакка кирүү: ${b.meeting_url}\n\nЖакшы окуу! 🌟`,
      en: `⏰ *Bilimpark.kg* — Your lesson in 30 minutes!\n\n👤 Tutor: ${b.tutor_first_name}\n🔗 Join lesson: ${b.meeting_url}\n\nGood luck! 🌟`
    };

    await sendMessage(b.phone, messages[b.language_preference || 'ru']);
    await pool.query('UPDATE bookings SET reminder_sent=true WHERE id=$1', [bookingId]);
  } catch (err) {
    console.error('Reminder error:', err);
  }
};

// ── HANDLE INCOMING WHATSAPP MESSAGE (AI Response) ────────
const handleIncomingMessage = async (from, message, whatsappMessageId) => {
  try {
    // Find user by phone
    const userResult = await pool.query(
      'SELECT * FROM users WHERE phone LIKE $1',
      [`%${from.slice(-9)}`]
    );
    const user = userResult.rows[0];

    // Save incoming message
    await pool.query(
      `INSERT INTO support_messages
         (user_id, channel, direction, message, whatsapp_message_id)
       VALUES ($1,'whatsapp','inbound',$2,$3)`,
      [user?.id || null, message, whatsappMessageId]
    );

    // Get conversation history
    const historyResult = await pool.query(
      `SELECT direction, message FROM support_messages
       WHERE (user_id=$1 OR (user_id IS NULL AND whatsapp_message_id IS NOT NULL))
       AND channel='whatsapp'
       ORDER BY created_at DESC LIMIT 10`,
      [user?.id || null]
    );

    const history = historyResult.rows.reverse().map(r => ({
      role: r.direction === 'inbound' ? 'user' : 'assistant',
      content: r.message
    }));

    // Get AI response
    const { handleChatMessage } = require('../agents/supportAgent');
    const reply = await handleChatMessage(message, user?.id, 'whatsapp', history);

    // Send reply
    await sendMessage(from, reply);

    // Save outbound
    await pool.query(
      `INSERT INTO support_messages (user_id, channel, direction, message, is_ai_response)
       VALUES ($1,'whatsapp','outbound',$2,true)`,
      [user?.id || null, reply]
    );

  } catch (err) {
    console.error('WhatsApp incoming error:', err);
    await sendMessage(from, 'Извините, произошла ошибка. Попробуйте позже.');
  }
};

// ── INSTANT LEAD AUTO-RESPONSE (sent the moment a lead is captured) ──
// Goal: respond to every new student lead within seconds, not 5 minutes.
const SUBJECT_LABELS = {
  primary: 'начальные классы',
  middle: 'средние классы',
  high: 'старшие классы',
  ort_university: 'подготовка к ОРТ / поступление',
};

const sendLeadAutoResponse = async (lead, matchedTutors = []) => {
  try {
    if (!lead?.phone) return;

    // Build a warm, human first-touch message. If we matched tutors, mention them.
    let tutorLine = '';
    if (matchedTutors.length) {
      const names = matchedTutors.slice(0, 3).map(t => {
        const fn = t.first_name || t.name || 'репетитор';
        const price = t.hourly_rate ? ` — ${t.hourly_rate} сом/час` : '';
        return `• ${fn}${price}`;
      }).join('\n');
      tutorLine = `\n\nВот несколько репетиторов по предмету «${lead.subject}», которые вам подойдут:\n${names}\n`;
    }

    const message =
`Здравствуйте! 👋 Это Билим — помощник Bilimpark.kg.

Спасибо за заявку на репетитора по предмету «${lead.subject}»! Мы уже подбираем для вас лучшего преподавателя.${tutorLine}
📚 Пробный урок стоит всего 500 сом — это знакомство с репетитором, чтобы понять, подходит ли он вам.

🛡 Гарантия: если урок не понравится — дадим 2 бесплатных пробных урока с другими репетиторами или вернём деньги.

Напишите мне прямо здесь, какой предмет и для какого класса нужен — я помогу записаться за пару минут! 😊`;

    await sendMessage(lead.phone, message);

    // Log the outbound auto-response so the AI has context if the student replies
    await pool.query(
      `INSERT INTO support_messages (user_id, channel, direction, message, is_ai_response)
       VALUES (NULL,'whatsapp','outbound',$1,true)`,
      [message]
    ).catch(() => {});

    console.log(`[LEAD AUTO-RESPONSE] Sent to ${lead.phone}`);
  } catch (err) {
    console.error('[LEAD AUTO-RESPONSE] Failed:', err.message);
  }
};

// ── INSTANT TUTOR WELCOME (sent the moment a tutor signs up) ──
// Triggered from tutor registration. Greets the applicant from the
// business WhatsApp so they feel a human picked up immediately.
const sendTutorWelcome = async (rawPhone, firstName = '') => {
  try {
    const { toWhatsApp } = require('../utils/phone');
    const waDigits = toWhatsApp(rawPhone);
    if (!waDigits) {
      console.warn('[TUTOR WELCOME] Could not normalize phone:', rawPhone);
      return;
    }

    const name = firstName ? ` ${firstName}` : '';
    const message =
`Саламатсызбы${name}! 👋 Это команда Bilimpark.kg.

Спасибо, что подали заявку стать репетитором! 🎓 Мы уже получили вашу анкету.

Что дальше:
1️⃣ Наш менеджер проверит профиль (обычно в течение дня)
2️⃣ Мы поможем настроить профиль и добавить расписание
3️⃣ Вы начнёте получать учеников 🚀

Если есть вопросы — просто ответьте на это сообщение, мы на связи! 😊`;

    await sendMessage(waDigits, message);
    console.log(`[TUTOR WELCOME] Sent to ${waDigits}`);
  } catch (err) {
    console.error('[TUTOR WELCOME] Failed:', err.message);
  }
};

module.exports = { sendMessage, sendBookingConfirmation, sendLessonReminder, handleIncomingMessage, sendLeadAutoResponse, sendTutorWelcome };
