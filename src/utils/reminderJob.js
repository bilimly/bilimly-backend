const cron = require('node-cron');
const pool = require('../config/database');
const { sendLessonReminder } = require('../services/emailService');

const startReminderJob = () => {
  // Run every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      await send24hReminders();
      await send1hReminders();
    } catch(err) {
      console.error('Reminder job error:', err.message);
    }
  });

  console.log('⏰ Lesson reminder job started (24h + 1h reminders)');
};

// ── 24 HOUR REMINDER ───────────────────────────────────────
async function send24hReminders() {
  // Add reminder_sent_24h column if not exists (safe)
  await pool.query(`
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_sent_24h BOOLEAN DEFAULT FALSE
  `).catch(() => {});

  const result = await pool.query(`
    SELECT b.*, 
           s.email as student_email, s.first_name as student_name, s.last_name as student_last_name,
           t.email as tutor_email, t.first_name as tutor_name, t.last_name as tutor_last_name,
           tp.id as tutor_profile_id
    FROM bookings b
    JOIN users s ON b.student_id = s.id
    JOIN tutor_profiles tp ON b.tutor_id = tp.id
    JOIN users t ON tp.user_id = t.id
    WHERE b.status = 'confirmed'
      AND COALESCE(b.reminder_sent_24h, false) = false
      AND (b.lesson_date + b.start_time::interval) 
          BETWEEN NOW() + INTERVAL '23 hours 45 minutes' 
          AND NOW() + INTERVAL '24 hours 15 minutes'
  `);

  for (const booking of result.rows) {
    try {
      // Email to student
      await sendLessonReminder(
        booking.student_email,
        booking.student_name,
        `${booking.tutor_name} ${booking.tutor_last_name}`,
        booking.subject,
        booking.start_time,
        booking.meeting_url,
        24
      );

      // Email to tutor
      await sendLessonReminder(
        booking.tutor_email,
        booking.tutor_name,
        `${booking.student_name} ${booking.student_last_name}`,
        booking.subject,
        booking.start_time,
        booking.meeting_url,
        24
      );

      // Telegram to student
      const studentTg = await pool.query('SELECT telegram_chat_id FROM users WHERE id=$1', [booking.student_id]);
      if (studentTg.rows[0]?.telegram_chat_id) {
        const { sendTelegramMessage } = require('../services/telegramService');
        sendTelegramMessage(
          studentTg.rows[0].telegram_chat_id,
          `📅 Напоминание: завтра урок!\n\n👨‍🏫 Репетитор: ${booking.tutor_name} ${booking.tutor_last_name}\n📚 Предмет: ${booking.subject}\n🕐 Время: ${booking.start_time}\n${booking.meeting_url ? `\n🎥 Ссылка: ${booking.meeting_url}` : ''}`
        ).catch(console.error);
      }

      // Telegram to tutor
      const tutorTg = await pool.query('SELECT telegram_chat_id FROM users WHERE id=$1', [booking.tutor_id]);
      if (tutorTg.rows[0]?.telegram_chat_id) {
        const { sendTelegramMessage } = require('../services/telegramService');
        sendTelegramMessage(
          tutorTg.rows[0].telegram_chat_id,
          `📅 Напоминание: завтра урок!\n\n👩‍🎓 Студент: ${booking.student_name} ${booking.student_last_name}\n📚 Предмет: ${booking.subject}\n🕐 Время: ${booking.start_time}\n${booking.meeting_url ? `\n🎥 Ссылка: ${booking.meeting_url}` : ''}`
        ).catch(console.error);
      }

      await pool.query('UPDATE bookings SET reminder_sent_24h=true WHERE id=$1', [booking.id]);
      console.log('[REMINDER 24h] Sent for booking:', booking.id);
    } catch(err) {
      console.error('[REMINDER 24h] Error for booking', booking.id, ':', err.message);
    }
  }
}

// ── 1 HOUR REMINDER ────────────────────────────────────────
async function send1hReminders() {
  const result = await pool.query(`
    SELECT b.*, 
           s.email as student_email, s.first_name as student_name, s.last_name as student_last_name,
           t.email as tutor_email, t.first_name as tutor_name, t.last_name as tutor_last_name,
           tp.id as tutor_profile_id
    FROM bookings b
    JOIN users s ON b.student_id = s.id
    JOIN tutor_profiles tp ON b.tutor_id = tp.id
    JOIN users t ON tp.user_id = t.id
    WHERE b.status = 'confirmed'
      AND COALESCE(b.reminder_sent, false) = false
      AND (b.lesson_date + b.start_time::interval) 
          BETWEEN NOW() + INTERVAL '45 minutes' 
          AND NOW() + INTERVAL '75 minutes'
  `);

  for (const booking of result.rows) {
    try {
      // Email to student
      await sendLessonReminder(
        booking.student_email,
        booking.student_name,
        `${booking.tutor_name} ${booking.tutor_last_name}`,
        booking.subject,
        booking.start_time,
        booking.meeting_url,
        1
      );

      // Email to tutor
      await sendLessonReminder(
        booking.tutor_email,
        booking.tutor_name,
        `${booking.student_name} ${booking.student_last_name}`,
        booking.subject,
        booking.start_time,
        booking.meeting_url,
        1
      );

      // Telegram to student
      const studentTg = await pool.query('SELECT telegram_chat_id FROM users WHERE id=$1', [booking.student_id]);
      if (studentTg.rows[0]?.telegram_chat_id) {
        const { sendTelegramMessage } = require('../services/telegramService');
        sendTelegramMessage(
          studentTg.rows[0].telegram_chat_id,
          `⏰ Урок через 1 час!\n\n👨‍🏫 Репетитор: ${booking.tutor_name} ${booking.tutor_last_name}\n📚 Предмет: ${booking.subject}\n🕐 Время: ${booking.start_time}\n${booking.meeting_url ? `\n🎥 Войти в урок: ${booking.meeting_url}` : ''}`
        ).catch(console.error);
      }

      // Telegram to tutor  
      const tutorTg = await pool.query('SELECT telegram_chat_id FROM users WHERE id=$1', [booking.tutor_id]);
      if (tutorTg.rows[0]?.telegram_chat_id) {
        const { sendTelegramMessage } = require('../services/telegramService');
        sendTelegramMessage(
          tutorTg.rows[0].telegram_chat_id,
          `⏰ Урок через 1 час!\n\n👩‍🎓 Студент: ${booking.student_name} ${booking.student_last_name}\n📚 Предмет: ${booking.subject}\n🕐 Время: ${booking.start_time}\n${booking.meeting_url ? `\n🎥 Войти в урок: ${booking.meeting_url}` : ''}`
        ).catch(console.error);
      }

      await pool.query('UPDATE bookings SET reminder_sent=true WHERE id=$1', [booking.id]);
      console.log('[REMINDER 1h] Sent for booking:', booking.id);
    } catch(err) {
      console.error('[REMINDER 1h] Error for booking', booking.id, ':', err.message);
    }
  }
}

module.exports = { startReminderJob };
