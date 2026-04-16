const cron = require('node-cron');
const pool = require('../config/database');
const { sendLessonReminder } = require('../services/emailService');

const startReminderJob = () => {
  // Run every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      // Find lessons starting in 1 hour
      const result = await pool.query(`
        SELECT b.*, 
               s.email as student_email, s.first_name as student_name,
               t.email as tutor_email, t.first_name as tutor_name,
               tp.id as tutor_profile_id
        FROM bookings b
        JOIN users s ON b.student_id = s.id
        JOIN users t ON b.tutor_id = t.id  
        JOIN tutor_profiles tp ON t.id = tp.user_id
        WHERE b.status = 'confirmed'
          AND b.reminder_sent = false
          AND (b.lesson_date + b.start_time::interval) 
              BETWEEN NOW() + INTERVAL '45 minutes' 
              AND NOW() + INTERVAL '75 minutes'
      `);

      for (const booking of result.rows) {
        // Send reminder to student
        await sendLessonReminder(
          booking.student_email,
          booking.student_name,
          booking.tutor_name,
          booking.subject,
          booking.start_time,
          booking.meeting_url
        );

        // Send Telegram reminder to student
const { sendLessonReminder: sendTelegramReminder } = require('../services/telegramService');
const studentTg = await pool.query('SELECT telegram_chat_id FROM users WHERE id=$1',[booking.student_id]);
if(studentTg.rows[0]?.telegram_chat_id){
  sendTelegramReminder(studentTg.rows[0].telegram_chat_id,booking.student_name,booking.tutor_name,booking.subject,booking.start_time,true).catch(console.error);
}

        // Send reminder to tutor
        await sendLessonReminder(
          booking.tutor_email,
          booking.tutor_name,
          booking.student_name,
          booking.subject,
          booking.start_time,
          booking.meeting_url
        );

        // Send Telegram reminder to tutor
const tutorTg = await pool.query('SELECT telegram_chat_id FROM users WHERE id=$1',[booking.tutor_id]);
if(tutorTg.rows[0]?.telegram_chat_id){
  sendTelegramReminder(tutorTg.rows[0].telegram_chat_id,booking.tutor_name,booking.student_name,booking.subject,booking.start_time,false).catch(console.error);
}

        // Mark reminder as sent
        await pool.query(
          'UPDATE bookings SET reminder_sent=true WHERE id=$1',
          [booking.id]
        );

        console.log('Reminder sent for booking:', booking.id);
      }
    } catch(err) {
      console.error('Reminder job error:', err.message);
    }
  });

  console.log('⏰ Lesson reminder job started');
};

module.exports = { startReminderJob };
