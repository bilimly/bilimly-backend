const cron = require('node-cron');
const pool = require('../config/database');
const { sendLessonReminder } = require('../services/whatsappService');

// ── SEND REMINDERS 30 MIN BEFORE LESSON ───────────────────
const startReminderJob = () => {
  // Run every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      const result = await pool.query(`
        SELECT b.id
        FROM bookings b
        WHERE b.status = 'confirmed'
          AND b.reminder_sent = false
          AND b.meeting_url IS NOT NULL
          AND (b.lesson_date + b.start_time::interval) 
              BETWEEN NOW() + INTERVAL '25 minutes' 
              AND NOW() + INTERVAL '35 minutes'
      `);

      for (const row of result.rows) {
        await sendLessonReminder(row.id);
        console.log(`📱 Reminder sent for booking ${row.id}`);
      }
    } catch (err) {
      console.error('Reminder job error:', err);
    }
  });

  console.log('⏰ Lesson reminder job started');
};

module.exports = { startReminderJob };
