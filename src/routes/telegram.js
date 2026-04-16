const express = require('express');
const pool = require('../config/database');
const { sendMessage } = require('../services/telegramService');
const router = express.Router();

// Webhook - receives messages from users
router.post('/webhook', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.json({ ok: true });

    const chatId = message.chat.id;
    const text = message.text || '';
    const firstName = message.from.first_name || '';

    // User sends their email to link account
    if (text.includes('@')) {
      const email = text.trim().toLowerCase();
      const user = await pool.query(
        'SELECT id, first_name, role FROM users WHERE email=$1',
        [email]
      );
      if (user.rows[0]) {
        await pool.query(
          'UPDATE users SET telegram_chat_id=$1 WHERE email=$2',
          [chatId.toString(), email]
        );
        await sendMessage(chatId,
          `✅ <b>Аккаунт подключён!</b>\n\nЗдравствуйте, ${user.rows[0].first_name}!\n\nТеперь вы будете получать уведомления об уроках в Telegram.\n\n🎓 <a href="https://bilimly.kg">Bilimly.kg</a>`
        );
      } else {
        await sendMessage(chatId,
          `❌ Email не найден. Убедитесь что вы зарегистрированы на <a href="https://bilimly.kg">bilimly.kg</a>`
        );
      }
    } else if (text === '/start') {
      await sendMessage(chatId,
        `👋 <b>Добро пожаловать в Bilimly.kg!</b>\n\nЯ буду отправлять вам уведомления об уроках.\n\n📧 Чтобы подключить аккаунт, отправьте ваш email с Bilimly.kg\n\nНапример: <code>your@email.com</code>`
      );
    } else {
      await sendMessage(chatId,
        `📧 Отправьте ваш email с Bilimly.kg чтобы подключить аккаунт.\n\nНапример: <code>your@email.com</code>`
      );
    }
    res.json({ ok: true });
  } catch(err) {
    console.error('Telegram webhook error:', err.message);
    res.json({ ok: true });
  }
});

// Get connection link for user
router.get('/connect-link', (req, res) => {
  res.json({ 
    url: `https://t.me/BilimlyKGBot`,
    instructions: 'Откройте бот и отправьте ваш email'
  });
});

module.exports = router;
