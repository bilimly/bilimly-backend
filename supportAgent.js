const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../config/database');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Ты — Билим, умный помощник платформы Bilimly.kg — маркетплейса репетиторов в Кыргызстане.

ТВОЯ РОЛЬ:
- Помогать студентам найти репетиторов и забронировать уроки
- Отвечать на вопросы о репетиторах, ценах, расписании
- Помогать репетиторам с регистрацией и настройкой профиля
- Решать проблемы с бронированием и оплатой

ЯЗЫК:
- Отвечай на том языке, на котором пишет пользователь
- Поддерживаешь: русский, кыргызский, английский
- Если язык непонятен — отвечай по-русски

ИНФОРМАЦИЯ О BILIMLY:
- Платформа репетиторов №1 в Кыргызстане
- Пробный урок от 200 сом (≈ $2.5)
- Обычный урок от 500 сом/час
- Оплата через MBANK QR-код (быстро и безопасно)
- Все репетиторы проверены нашей командой
- Уроки проходят онлайн через видеозвонок
- Работаем 24/7

ПОПУЛЯРНЫЕ ПРЕДМЕТЫ:
Математика, Физика, Химия, Биология, Английский язык,
Русский язык, Кыргызский язык, Программирование, История,
Подготовка к ОРТ/ЕГЭ/SAT

ЧТО ДЕЛАТЬ ЕСЛИ:
- Проблема с оплатой → попроси написать на whatsapp: +996XXXXXXXX
- Жалоба на репетитора → эскалируй администратору
- Вопрос о возврате → возврат возможен если урок не состоялся
- Техническая проблема → попроси описать проблему подробнее

СТИЛЬ:
- Дружелюбный, теплый, профессиональный
- Краткие ответы — не более 3-4 предложений
- Всегда предлагай следующий шаг
- Никогда не говори "я не знаю" — предложи альтернативу

КЫРГЫЗЧА ПРИВЕТСТВИЕ: "Саламатсызбы! Мен Билим — Bilimly.kg жардамчысы"
РУССКОЕ ПРИВЕТСТВИЕ: "Здравствуйте! Я Билим — помощник Bilimly.kg"
ENGLISH GREETING: "Hello! I'm Bilim — your Bilimly.kg assistant"`;

// ── HANDLE CHAT MESSAGE ────────────────────────────────────
const handleChatMessage = async (message, userId, channel = 'website', conversationHistory = []) => {
  try {
    const messages = [
      ...conversationHistory.slice(-10), // Keep last 10 messages for context
      { role: 'user', content: message }
    ];

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages,
    });

    const reply = response.content[0].text;

    // Save to database
    if (userId) {
      await pool.query(
        `INSERT INTO support_messages (user_id, channel, direction, message, is_ai_response)
         VALUES ($1,$2,'inbound',$3,false)`,
        [userId, channel, message]
      );
      await pool.query(
        `INSERT INTO support_messages (user_id, channel, direction, message, is_ai_response)
         VALUES ($1,$2,'outbound',$3,true)`,
        [userId, channel, reply]
      );
    }

    return reply;
  } catch (err) {
    console.error('Support agent error:', err);
    return 'Извините, произошла ошибка. Пожалуйста, попробуйте еще раз или напишите нам в WhatsApp.';
  }
};

// ── GET CONVERSATION HISTORY ───────────────────────────────
const getConversationHistory = async (userId, limit = 10) => {
  const result = await pool.query(
    `SELECT direction, message FROM support_messages
     WHERE user_id = $1 AND channel = 'website'
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );

  return result.rows.reverse().map(row => ({
    role: row.direction === 'inbound' ? 'user' : 'assistant',
    content: row.message
  }));
};

module.exports = { handleChatMessage, getConversationHistory };
