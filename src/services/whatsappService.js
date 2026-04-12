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
      ru: `✅ *Bilimly.kg* — Урок подтверждён!\n\n👤 Репетитор: ${b.tutor_first_name} ${b.tutor_last_name}\n📅 Дата: ${new Date(b.lesson_date).toLocaleDateString('ru-RU')}\n⏰ Время: ${b.start_time}\n📚 Предмет: ${b.subject}\n\nСсылка на урок будет отправлена за 30 минут до начала.\n\nЕсть вопросы? Пишите сюда 💬`,
      ky: `✅ *Bilimly.kg* — Сабак тастыкталды!\n\n👤 Мугалим: ${b.tutor_first_name} ${b.tutor_last_name}\n📅 Күнү: ${new Date(b.lesson_date).toLocaleDateString('ru-RU')}\n⏰ Убактысы: ${b.start_time}\n📚 Сабак: ${b.subject}\n\nУрокка шилтеме 30 мүнөт мурун жиберилет.\n\nСуроолоруңуз барбы? Бул жерге жазыңыз 💬`,
      en: `✅ *Bilimly.kg* — Lesson Confirmed!\n\n👤 Tutor: ${b.tutor_first_name} ${b.tutor_last_name}\n📅 Date: ${new Date(b.lesson_date).toLocaleDateString()}\n⏰ Time: ${b.start_time}\n📚 Subject: ${b.subject}\n\nLesson link will be sent 30 minutes before start.\n\nAny questions? Write here 💬`
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
      ru: `⏰ *Bilimly.kg* — Ваш урок через 30 минут!\n\n👤 Репетитор: ${b.tutor_first_name}\n🔗 Войти в урок: ${b.meeting_url}\n\nУдачи! 🌟`,
      ky: `⏰ *Bilimly.kg* — Сабагыңыз 30 мүнөттөн кийин!\n\n👤 Мугалим: ${b.tutor_first_name}\n🔗 Сабакка кирүү: ${b.meeting_url}\n\nЖакшы окуу! 🌟`,
      en: `⏰ *Bilimly.kg* — Your lesson in 30 minutes!\n\n👤 Tutor: ${b.tutor_first_name}\n🔗 Join lesson: ${b.meeting_url}\n\nGood luck! 🌟`
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
    const { handleChatMessage } = require('./supportAgent');
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

module.exports = { sendMessage, sendBookingConfirmation, sendLessonReminder, handleIncomingMessage };
