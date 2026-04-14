const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = process.env.FROM_EMAIL || 'admin@bilimly.kg';

// ── BOOKING CONFIRMATION ───────────────────────────────────
const sendBookingConfirmation = async (studentEmail, studentName, tutorName, subject, date, time, amount) => {
  try {
    await resend.emails.send({
      from: `Bilimly.kg <${FROM}>`,
      to: studentEmail,
      subject: `✅ Урок забронирован — ${subject} с ${tutorName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#1a5c3a;padding:24px;text-align:center;">
            <h1 style="color:white;font-size:1.5rem;margin:0">Bilimly.kg</h1>
          </div>
          <div style="padding:24px;background:#f9fafb;">
            <h2 style="color:#111827">Урок забронирован! 🎉</h2>
            <p>Здравствуйте, <strong>${studentName}</strong>!</p>
            <p>Ваш урок успешно забронирован.</p>
            <div style="background:white;border-radius:12px;padding:20px;margin:20px 0;border:1px solid #e5e7eb;">
              <p><strong>📚 Предмет:</strong> ${subject}</p>
              <p><strong>👨‍🏫 Репетитор:</strong> ${tutorName}</p>
              <p><strong>📅 Дата:</strong> ${date}</p>
              <p><strong>🕐 Время:</strong> ${time}</p>
              <p><strong>💰 Сумма:</strong> ${amount} сом</p>
            </div>
            <p>Ссылка на урок придёт за 30 минут до начала.</p>
            <a href="https://bilimly.kg" style="background:#1a5c3a;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:16px;">Открыть Bilimly</a>
          </div>
          <div style="padding:16px;text-align:center;color:#6b7280;font-size:0.8rem;">
            © 2026 Bilimly.kg · Бишкек, Кыргызстан
          </div>
        </div>
      `
    });
    console.log('Booking confirmation email sent to:', studentEmail);
  } catch(err) {
    console.error('Email error:', err.message);
  }
};

// ── LESSON REMINDER ────────────────────────────────────────
const sendLessonReminder = async (email, name, tutorName, subject, time, meetingUrl) => {
  try {
    await resend.emails.send({
      from: `Bilimly.kg <${FROM}>`,
      to: email,
      subject: `⏰ Напоминание: урок через 1 час — ${subject}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#1a5c3a;padding:24px;text-align:center;">
            <h1 style="color:white;font-size:1.5rem;margin:0">Bilimly.kg</h1>
          </div>
          <div style="padding:24px;background:#f9fafb;">
            <h2 style="color:#111827">Урок начинается через 1 час! ⏰</h2>
            <p>Здравствуйте, <strong>${name}</strong>!</p>
            <div style="background:white;border-radius:12px;padding:20px;margin:20px 0;border:1px solid #e5e7eb;">
              <p><strong>📚 Предмет:</strong> ${subject}</p>
              <p><strong>👨‍🏫 Репетитор:</strong> ${tutorName}</p>
              <p><strong>🕐 Время:</strong> ${time}</p>
            </div>
            ${meetingUrl ? `<a href="${meetingUrl}" style="background:#e8533a;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-size:1rem;font-weight:bold;">🎥 Войти в урок</a>` : ''}
          </div>
          <div style="padding:16px;text-align:center;color:#6b7280;font-size:0.8rem;">
            © 2026 Bilimly.kg · Бишкек, Кыргызстан
          </div>
        </div>
      `
    });
  } catch(err) {
    console.error('Reminder email error:', err.message);
  }
};

// ── LESSON SUMMARY TO PARENT ───────────────────────────────
const sendLessonSummary = async (parentEmail, parentName, studentName, tutorName, subject, summary, homework, date) => {
  try {
    await resend.emails.send({
      from: `Bilimly.kg <${FROM}>`,
      to: parentEmail,
      subject: `📝 Итоги урока — ${subject} (${date})`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#1a5c3a;padding:24px;text-align:center;">
            <h1 style="color:white;font-size:1.5rem;margin:0">Bilimly.kg</h1>
          </div>
          <div style="padding:24px;background:#f9fafb;">
            <h2 style="color:#111827">Итоги урока 📝</h2>
            <p>Здравствуйте, <strong>${parentName}</strong>!</p>
            <p>Репетитор <strong>${tutorName}</strong> заполнил итоги урока для <strong>${studentName}</strong>.</p>
            <div style="background:white;border-radius:12px;padding:20px;margin:20px 0;border:1px solid #e5e7eb;">
              <p><strong>📚 Предмет:</strong> ${subject}</p>
              <p><strong>📅 Дата:</strong> ${date}</p>
              <p><strong>📋 Что изучали:</strong></p>
              <p style="color:#374151">${summary}</p>
              ${homework ? `
              <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
              <p><strong>📎 Домашнее задание:</strong></p>
              <p style="color:#374151">${homework}</p>
              ` : ''}
            </div>
            <a href="https://bilimly.kg" style="background:#1a5c3a;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Открыть Bilimly</a>
          </div>
          <div style="padding:16px;text-align:center;color:#6b7280;font-size:0.8rem;">
            © 2026 Bilimly.kg · Бишкек, Кыргызстан
          </div>
        </div>
      `
    });
  } catch(err) {
    console.error('Summary email error:', err.message);
  }
};

// ── WELCOME EMAIL ──────────────────────────────────────────
const sendWelcomeEmail = async (email, name, role) => {
  try {
    await resend.emails.send({
      from: `Bilimly.kg <${FROM}>`,
      to: email,
      subject: `Добро пожаловать на Bilimly.kg! 🎉`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#1a5c3a;padding:24px;text-align:center;">
            <h1 style="color:white;font-size:1.5rem;margin:0">Bilimly.kg</h1>
          </div>
          <div style="padding:24px;background:#f9fafb;">
            <h2 style="color:#111827">Добро пожаловать, ${name}! 🎉</h2>
            <p>Спасибо за регистрацию на Bilimly.kg — репетиторской платформе №1 в Кыргызстане.</p>
            ${role === 'tutor' ? `
            <p>Ваш профиль репетитора создан. Заполните его чтобы студенты могли вас найти:</p>
            <a href="https://bilimly.kg/tutor-dashboard.html" style="background:#1a5c3a;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:16px;">Заполнить профиль</a>
            ` : `
            <p>Найдите своего репетитора и запишитесь на пробный урок от 200 сом:</p>
            <a href="https://bilimly.kg" style="background:#1a5c3a;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:16px;">Найти репетитора</a>
            `}
          </div>
          <div style="padding:16px;text-align:center;color:#6b7280;font-size:0.8rem;">
            © 2026 Bilimly.kg · Бишкек, Кыргызстан
          </div>
        </div>
      `
    });
  } catch(err) {
    console.error('Welcome email error:', err.message);
  }
};

module.exports = { 
  sendBookingConfirmation, 
  sendLessonReminder, 
  sendLessonSummary,
  sendWelcomeEmail 
};
