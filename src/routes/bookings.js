const express = require('express');
const pool = require('../config/database');
const { sendBookingConfirmation } = require('../services/emailService');
const { auth, requireRole } = require('../middleware/auth');
const router = express.Router();

// ── CREATE BOOKING ─────────────────────────────────────────
router.post('/', auth, requireRole('student'), async (req, res) => {
  const { tutor_id, lesson_date, start_time, end_time: rawEndTime, lesson_type, subject, student_notes, duration_minutes } = req.body;

  // Calculate end_time from duration_minutes if not provided
  let end_time = rawEndTime;
  if (!end_time && start_time && duration_minutes) {
    const [h, m] = start_time.split(':').map(Number);
    const totalMins = h * 60 + m + parseInt(duration_minutes || 60);
    end_time = `${String(Math.floor(totalMins / 60) % 24).padStart(2,'0')}:${String(totalMins % 60).padStart(2,'0')}:00`;
  }
  if (!end_time) {
    // Default: 1 hour after start
    if (start_time) {
      const [h, m] = start_time.split(':').map(Number);
      const totalMins = h * 60 + m + 60;
      end_time = `${String(Math.floor(totalMins / 60) % 24).padStart(2,'0')}:${String(totalMins % 60).padStart(2,'0')}:00`;
    }
  }

  console.log('[BOOKING] tutor_id received:', tutor_id, 'type:', typeof tutor_id);
  try {
    // Get tutor profile and rate
    const tutorResult = await pool.query(
      'SELECT id, hourly_rate, trial_rate, user_id FROM tutor_profiles WHERE id = $1 OR user_id = $1',
      [tutor_id]
    );
    if (!tutorResult.rows[0]) {
      console.log('[BOOKING] Tutor not found for id:', tutor_id);
      return res.status(404).json({ error: 'Tutor not found', tutor_id });
    }

    const tutorRow = tutorResult.rows[0];
    const amount = lesson_type === 'trial'
      ? (tutorRow.trial_rate || tutorRow.hourly_rate || 500)
      : (tutorRow.hourly_rate || 500);

    // Check for conflicts
    const conflict = await pool.query(
      `SELECT id FROM bookings
       WHERE tutor_id = $1 AND lesson_date = $2
       AND status NOT IN ('cancelled')
       AND (start_time, end_time) OVERLAPS ($3::time, $4::time)`,
      [tutor_id, lesson_date, start_time, end_time]
    );
    if (conflict.rows.length > 0) {
      return res.status(409).json({ error: 'This time slot is already booked' });
    }

    // Insert booking
    const booking = await pool.query(
      `INSERT INTO bookings
        (student_id, tutor_id, lesson_date, start_time, end_time,
         lesson_type, subject, student_notes, amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
       RETURNING *`,
      [req.user.id, tutor_id, lesson_date, start_time, end_time,
       lesson_type || 'trial', subject, student_notes, amount]
    );

    // Create pending payment record
    const payment = await pool.query(
      `INSERT INTO payments (booking_id, student_id, amount, payment_method, status)
       VALUES ($1,$2,$3,'freedompay','pending') RETURNING id`,
      [booking.rows[0].id, req.user.id, amount]
    );

    // Create Freedom Pay payment page
    let fpRedirectUrl = null;
    let fpPaymentId = null;
    try {
      const { createPayment } = require('../services/freedomPayService');
      const fp = await createPayment({
        orderId:      payment.rows[0].id,
        amount,
        description:  `Урок по предмету "${subject || 'Урок'}" на Bilimpark.kg`,
        successUrl:   `${process.env.FRONTEND_URL}/payment-success.html?booking_id=${booking.rows[0].id}`,
        failUrl:      `${process.env.FRONTEND_URL}/payment-fail.html?booking_id=${booking.rows[0].id}`,
        resultUrl:    `${process.env.BACKEND_URL || 'https://bilimly-backend-0zbt.onrender.com'}/api/payments/freedompay/webhook`,
        customerEmail: req.user.email,
      });
      fpRedirectUrl = fp.redirect_url;
      fpPaymentId   = fp.payment_id;

      await pool.query(
        `UPDATE payments SET fp_payment_id=$1, fp_redirect_url=$2 WHERE id=$3`,
        [fpPaymentId, fpRedirectUrl, payment.rows[0].id]
      );
    } catch (fpErr) {
      console.error('[BOOKINGS] Freedom Pay init failed:', fpErr.message);
      // Don't fail booking creation - student can retry payment from dashboard
    }

    // Fetch student + tutor user records once for all notifications
    const [studentRow, tutorUserRow] = await Promise.all([
      pool.query('SELECT email, first_name, last_name FROM users WHERE id=$1', [req.user.id]),
      pool.query(
        'SELECT u.email, u.first_name, u.last_name, u.phone, u.telegram_chat_id FROM users u JOIN tutor_profiles tp ON u.id=tp.user_id WHERE tp.id=$1',
        [tutor_id]
      ),
    ]);
    const student = studentRow.rows[0];
    const tutorUser = tutorUserRow.rows[0];

    // Notify student by email (booking confirmation)
    if (student && tutorUser) {
      sendBookingConfirmation(
        student.email,
        student.first_name,
        `${tutorUser.first_name} ${tutorUser.last_name}`,
        subject || 'Урок',
        lesson_date,
        start_time,
        amount
      ).catch(console.error);
    }

    // Notify tutor by email (single email, not duplicated)
    if (tutorUser) {
      try {
        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        resend.emails.send({
          from: `Bilimpark.kg <${process.env.FROM_EMAIL}>`,
          to: tutorUser.email,
          subject: '📅 Новое бронирование на Bilimpark.kg!',
          html: `<div style="font-family:Arial,sans-serif"><div style="background:#0ABAB5;padding:24px;text-align:center"><h1 style="color:white;margin:0">Bilimpark.kg</h1></div><div style="padding:32px"><h2>Новое бронирование! 🎉</h2><p>Студент записался к вам на урок.</p><a href="https://bilimpark.kg/tutor-dashboard.html" style="background:#0ABAB5;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;display:inline-block;font-weight:bold;">Открыть кабинет →</a></div></div>`,
        }).catch((e) => console.error('[BOOKINGS] tutor email failed:', e));
      } catch (e) { /* swallow */ }
    }

    // Notify tutor by Telegram (if linked)
    if (tutorUser && tutorUser.telegram_chat_id) {
      try {
        const { sendBookingNotification } = require('../services/telegramService');
        sendBookingNotification(
          tutorUser.telegram_chat_id,
          tutorUser.first_name,
          subject || 'Урок',
          student ? `${student.first_name} ${student.last_name || ''}`.trim() : 'Студент',
          lesson_date,
          start_time,
          true
        ).catch((e) => console.error('[BOOKINGS] tutor telegram failed:', e));
      } catch (e) { /* swallow */ }
    }

    // Notify admin by Telegram
    try {
      const { notifyAdminNewBooking } = require('../services/telegramService');
      const studentName = student ? `${student.first_name} ${student.last_name || ''}`.trim() : 'Неизвестно';
      const tutorName = tutorUser ? `${tutorUser.first_name} ${tutorUser.last_name || ''}`.trim() : 'Неизвестно';
      notifyAdminNewBooking({
        subject, amount, lessonDate: lesson_date, startTime: start_time, studentName, tutorName,
      }).catch((e) => console.error('[BOOKINGS] admin notify failed:', e));
    } catch (e) { /* swallow */ }

    res.status(201).json({
      booking: booking.rows[0],
      payment: {
        id:           payment.rows[0].id,
        amount,
        redirect_url: fpRedirectUrl,
        fp_payment_id: fpPaymentId,
      }
    });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// ── GET MY BOOKINGS ────────────────────────────────────────
router.get('/my', auth, async (req, res) => {
  const { status, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  const isStudent = req.user.role === 'student';
  const idField = isStudent ? 'b.student_id' : 'tp.user_id';

  let conditions = [`${idField} = $1`];
  let params = [req.user.id];

  if (status) {
    conditions.push(`b.status = $${params.length + 1}`);
    params.push(status);
  }

  try {
    const result = await pool.query(
      `SELECT b.*,
              u_student.first_name as student_first_name,
              u_student.last_name as student_last_name,
              u_student.avatar_url as student_avatar,
              u_tutor.id as tutor_user_id,
              u_tutor.first_name as tutor_first_name,
              u_tutor.last_name as tutor_last_name,
              u_tutor.avatar_url as tutor_avatar,
              tp.id as tutor_profile_id,
              tp.rating as tutor_rating,
              p.id as payment_id,
              p.status as payment_status,
              p.amount as payment_amount,
              p.fp_redirect_url
       FROM bookings b
       JOIN users u_student ON b.student_id = u_student.id
       JOIN tutor_profiles tp ON b.tutor_id = tp.id
       JOIN users u_tutor ON tp.user_id = u_tutor.id
       LEFT JOIN payments p ON b.id = p.booking_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY b.lesson_date DESC, b.start_time DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// ── GET SINGLE BOOKING ─────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, p.status as payment_status, p.mbank_qr_code, p.mbank_qr_url, p.paid_at
       FROM bookings b
       LEFT JOIN payments p ON b.id = p.booking_id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Booking not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// ── CANCEL BOOKING ─────────────────────────────────────────
router.put('/:id/cancel', auth, async (req, res) => {
  try {
    const booking = await pool.query('SELECT * FROM bookings WHERE id=$1', [req.params.id]);
    if (!booking.rows[0]) return res.status(404).json({ error: 'Booking not found' });

    if (booking.rows[0].status === 'completed') {
      return res.status(400).json({ error: 'Cannot cancel completed booking' });
    }

    await pool.query(
      'UPDATE bookings SET status=$1, updated_at=NOW() WHERE id=$2',
      ['cancelled', req.params.id]
    );
    res.json({ message: 'Booking cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

// ── CONFIRM BOOKING (tutor) ────────────────────────────────
router.put('/:id/confirm', auth, requireRole('tutor'), async (req, res) => {
  try {
    // Get booking details
    const bookingResult = await pool.query(
      `SELECT b.*, 
              u_student.email as student_email, u_student.first_name as student_first_name, u_student.last_name as student_last_name,
              u_tutor.email as tutor_email, u_tutor.first_name as tutor_first_name, u_tutor.last_name as tutor_last_name
       FROM bookings b
       JOIN users u_student ON b.student_id = u_student.id
       JOIN tutor_profiles tp ON b.tutor_id = tp.id
       JOIN users u_tutor ON tp.user_id = u_tutor.id
       WHERE b.id = $1`,
      [req.params.id]
    );

    if (!bookingResult.rows[0]) return res.status(404).json({ error: 'Booking not found' });
    const booking = bookingResult.rows[0];

    // Auto-create Google Meet link
    let meetUrl = req.body.meeting_url || null;
    try {
      const { createMeetingLink } = require('../services/googleMeetService');
      meetUrl = await createMeetingLink(
        booking,
        `${booking.tutor_first_name} ${booking.tutor_last_name}`,
        booking.tutor_email,
        `${booking.student_first_name} ${booking.student_last_name}`,
        booking.student_email,
        booking.subject || 'Урок'
      );
    } catch (meetErr) {
      console.error('[CONFIRM] Meet link creation failed:', meetErr.message);
      // Don't fail the confirmation if Meet link fails
    }

    await pool.query(
      'UPDATE bookings SET status=$1, meeting_url=$2, updated_at=NOW() WHERE id=$3',
      ['confirmed', meetUrl, req.params.id]
    );

    // Send confirmation email to student with Meet link
    try {
      const { sendBookingConfirmation } = require('../services/emailService');
      await sendBookingConfirmation(
        booking.student_email,
        booking.student_first_name,
        booking.tutor_first_name + ' ' + booking.tutor_last_name,
        booking.subject,
        new Date(booking.lesson_date).toLocaleDateString('ru-RU'),
        booking.start_time,
        booking.amount,
        meetUrl
      );
    } catch (emailErr) {
      console.error('[CONFIRM] Email failed:', emailErr.message);
    }

    res.json({ message: 'Booking confirmed', meeting_url: meetUrl });
  } catch (err) {
    console.error('[CONFIRM] Error:', err);
    res.status(500).json({ error: 'Failed to confirm booking' });
  }
});

// ── COMPLETE BOOKING + LEAVE REVIEW ───────────────────────
router.post('/:id/complete', auth, async (req, res) => {
  const { rating, comment } = req.body;
  try {
    // Guard: only allow completion after the scheduled lesson start
    const check = await pool.query(
      `SELECT id, status, lesson_date, start_time
         FROM bookings WHERE id=$1`,
      [req.params.id]
    );
    if (!check.rows[0]) return res.status(404).json({ error: 'Booking not found' });
    const cb = check.rows[0];
    if (cb.status === 'completed') {
      return res.json({ message: 'Already completed' });  // idempotent
    }
    if (cb.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot complete a cancelled booking' });
    }
    const scheduledStart = new Date(
      cb.lesson_date.toISOString().substring(0,10) + 'T' + cb.start_time
    );
    if (scheduledStart > new Date()) {
      return res.status(400).json({ error: 'Нельзя завершить урок до его начала' });
    }

    await pool.query(
      'UPDATE bookings SET status=$1, updated_at=NOW() WHERE id=$2',
      ['completed', req.params.id]
    );

    if (rating && req.user.role === 'student') {
      const booking = await pool.query('SELECT * FROM bookings WHERE id=$1', [req.params.id]);
      await pool.query(
        'INSERT INTO reviews (booking_id, student_id, tutor_id, rating, comment) VALUES ($1,$2,$3,$4,$5)',
        [req.params.id, req.user.id, booking.rows[0].tutor_id, rating, comment]
      );

      // Update tutor rating
      await pool.query(
        `UPDATE tutor_profiles SET
           rating = (SELECT AVG(rating) FROM reviews WHERE tutor_id = $1),
           review_count = (SELECT COUNT(*) FROM reviews WHERE tutor_id = $1),
           total_lessons = total_lessons + 1
         WHERE id = $1`,
        [booking.rows[0].tutor_id]
      );
    }
    // Record commission earnings for this lesson
    try {
      const { recordLessonEarnings } = require('../services/commissionService');
      const fullBooking = await pool.query(
        `SELECT id, tutor_id, amount, duration_minutes FROM bookings WHERE id = $1`,
        [req.params.id]
      );
      if (fullBooking.rows[0]) {
        await recordLessonEarnings(pool, fullBooking.rows[0]);
      }
    } catch (earnErr) {
      console.error('[BOOKINGS] Failed to record earnings:', earnErr);
      // Don't fail the complete-request if earnings recording fails
    }
    res.json({ message: 'Lesson completed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to complete booking' });
  }
});



// ── LESSON SUMMARY ─────────────────────────────────────────
router.post('/:id/summary', auth, requireRole('tutor'), async (req, res) => {
  const { summary, homework, progress_rating } = req.body;
  try {
    await pool.query(
      `UPDATE bookings SET 
        lesson_summary=$1, homework=$2, progress_rating=$3, 
        summary_sent_at=NOW(), updated_at=NOW()
       WHERE id=$4`,
      [summary, homework, progress_rating, req.params.id]
    );

    const booking = await pool.query(
      `SELECT b.*, 
              s.email as student_email, s.first_name as student_first,
              t.first_name as tutor_first, t.last_name as tutor_last
       FROM bookings b
       JOIN users s ON b.student_id = s.id
       JOIN users t ON b.tutor_id = t.id
       WHERE b.id=$1`,
      [req.params.id]
    );

    if (booking.rows[0]) {
      const b = booking.rows[0];
      const { sendLessonSummary } = require('../services/emailService');
      sendLessonSummary(
        b.student_email,
        b.student_first,
        b.student_first,
        b.tutor_first + ' ' + b.tutor_last,
        b.subject,
        summary,
        homework,
        new Date(b.lesson_date).toLocaleDateString('ru-RU')
      ).catch(console.error);
    }

    res.json({ message: 'Summary saved and sent!' });
  } catch(err) {
    console.error('Summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── REVIEW AFTER LESSON ────────────────────────────────────
router.post('/:id/review', auth, async (req, res) => {
  const { tutor_id, rating, comment } = req.body;
  try {
    await pool.query(
      `INSERT INTO reviews (tutor_id, student_id, booking_id, rating, comment, is_published)
       VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT (booking_id) DO UPDATE SET rating=$4, comment=$5`,
      [tutor_id, req.user.id, req.params.id, rating, comment]
    );
    await pool.query(
      `UPDATE tutor_profiles SET
        rating = (SELECT AVG(rating) FROM reviews WHERE tutor_id=$1 AND is_published=true),
        review_count = (SELECT COUNT(*) FROM reviews WHERE tutor_id=$1 AND is_published=true)
       WHERE user_id=$1`,
      [tutor_id]
    );
    await pool.query('UPDATE bookings SET reviewed=true WHERE id=$1',[req.params.id]);
    res.json({ message: 'Review submitted!' });
  } catch(err) {
    console.error('Review error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── RECURRING BOOKING ──────────────────────────────────────
router.post('/recurring', auth, async (req, res) => {
  const { tutor_id, days, start_time, end_time, subject, weeks, student_notes } = req.body;
  try {
    const bookings = [];
    const today = new Date();
    
    for (let week = 0; week < (weeks || 4); week++) {
      for (const day of days) {
        const date = new Date(today);
        const daysUntil = (day - today.getDay() + 7) % 7 + (week * 7);
        date.setDate(today.getDate() + daysUntil);
        
        if (date <= today) continue;
        
        const result = await pool.query(
          `INSERT INTO bookings 
            (student_id, tutor_id, lesson_date, start_time, end_time, 
             subject, student_notes, status, lesson_type, amount,
             is_recurring, recurring_days, recurring_time)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','regular',
             (SELECT hourly_rate FROM tutor_profiles WHERE user_id=$2),
             true,$8,$4)
           RETURNING id`,
          [req.user.id, tutor_id, date.toISOString().split('T')[0],
           start_time, end_time, subject, student_notes, days]
        );
        bookings.push(result.rows[0].id);
      }
    }
    // Admin Telegram notification — recurring bookings batch
    try {
      const { sendMessage } = require('../services/telegramService');
      const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
      if (adminChatId) {
        const msg =
          `💰 <b>Новые повторяющиеся бронирования</b>\n\n` +
          `📚 Уроков: <b>${bookings.length}</b>\n` +
          `<a href="https://bilimpark.kg/admin.html">Открыть админку →</a>`;
        sendMessage(adminChatId, msg).catch((e) => console.error('[BOOKINGS/RECURRING] Admin notify failed:', e));
      }
    } catch (e) { /* swallow */ }
    res.status(201).json({ 
      message: `${bookings.length} уроков забронировано!`,
      booking_ids: bookings,
      total: bookings.length
    });
  } catch(err) {
    console.error('Recurring booking error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── LESSON PACKAGES V2 ─────────────────────────────────────
router.post('/packages/buy', auth, async (req, res) => {
  const { tutor_id, subject, lessons } = req.body;
  try {
    const tutorRate = await pool.query(
      'SELECT hourly_rate FROM tutor_profiles WHERE user_id=$1',
      [tutor_id]
    );
    const rate = parseFloat(tutorRate.rows[0]?.hourly_rate || 500);
    
    const discounts = { 5: 5, 10: 8, 20: 11 };
    const discount = discounts[lessons] || 0;
    const pricePerLesson = rate * (1 - discount/100);
    const totalAmount = pricePerLesson * lessons;
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + Math.ceil(lessons/8));

    const result = await pool.query(
      `INSERT INTO lesson_packages 
        (student_id, tutor_id, subject, total_lessons, price_per_lesson, 
         total_amount, discount_percent, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, tutor_id, subject, lessons, 
       pricePerLesson, totalAmount, discount, expiresAt]
    );
// Admin Telegram notification — lesson package purchased
    try {
      const { sendMessage } = require('../services/telegramService');
      const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
      if (adminChatId) {
        const msg =
          `📦 <b>Куплен пакет уроков</b>\n\n` +
          `📚 Уроков: <b>${lessons}</b>\n` +
          `💵 Сумма: <b>${Math.round(totalAmount)} сом</b>\n` +
          `💰 Цена за урок: ${Math.round(pricePerLesson)} сом (скидка ${discount}%)\n` +
          `<a href="https://bilimpark.kg/admin.html">Открыть админку →</a>`;
        sendMessage(adminChatId, msg).catch((e) => console.error('[PACKAGES] Admin notify failed:', e));
      }
    } catch (e) { /* swallow */ }
    res.status(201).json({
      package: result.rows[0],
      summary: {
        lessons,
        discount: discount+'%',
        price_per_lesson: Math.round(pricePerLesson),
        total: Math.round(totalAmount),
        savings: Math.round(rate * lessons - totalAmount)
      }
    });
  } catch(err) {
    console.error('Package error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── PARENT-INITIATED PAYMENT NOTIFICATION ─────────────────
// Parent clicks "Я оплатил" after sending WhatsApp screenshot.
// Updates payment to pending_verification, pings admin via Telegram.
// Idempotent — calling twice doesn't double-notify.
router.post('/:id/mark-paid', auth, async (req, res) => {
  const bookingId = req.params.id;
  try {
    // Verify booking belongs to this user
    const bookingCheck = await pool.query(
      `SELECT b.*, p.id AS payment_id, p.status AS payment_status,
              u.first_name AS student_first, u.last_name AS student_last,
              u_t.first_name AS tutor_first, u_t.last_name AS tutor_last
         FROM bookings b
         LEFT JOIN payments p ON p.booking_id = b.id
         JOIN users u ON b.student_id = u.id
         JOIN tutor_profiles tp ON b.tutor_id = tp.id
         JOIN users u_t ON tp.user_id = u_t.id
        WHERE b.id = $1 AND b.student_id = $2`,
      [bookingId, req.user.id]
    );
    const b = bookingCheck.rows[0];
    if (!b) return res.status(404).json({ error: 'Бронирование не найдено' });

    // Idempotency: if already pending_verification or completed, just return success
    if (b.payment_status === 'completed') {
      return res.json({
        message: 'already_marked',
        payment_status: b.payment_status,
      });
    }

    // Update payment to pending_verification
    if (b.payment_id) {
      await pool.query(
        `UPDATE payments SET notes=COALESCE(notes,'') || $1 WHERE id=$2`,
        [`\n[${new Date().toISOString()}] Parent marked as paid`, b.payment_id]
      );
    }

    // Telegram ping admin immediately
    try {
      const { sendMessage } = require('../services/telegramService');
      const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
      if (adminChatId) {
        const dateStr = new Date(b.lesson_date).toLocaleDateString('ru-RU');
        const studentName = `${b.student_first} ${b.student_last || ''}`.trim();
        const tutorName = `${b.tutor_first} ${b.tutor_last || ''}`.trim();
        const shortId = bookingId.substring(0, 8);
        const msg =
          `🔔 <b>Родитель сообщил об оплате</b>\n\n` +
          `Бронь: <code>#${shortId}</code>\n` +
          `👤 ${studentName}\n` +
          `👨‍🏫 ${tutorName}\n` +
          `📚 ${b.subject || 'Урок'}\n` +
          `📅 ${dateStr} в ${b.start_time}\n` +
          `💰 ${b.amount} сом\n\n` +
          `Проверьте чек в WhatsApp и подтвердите:\n` +
          `<a href="https://bilimpark.kg/admin.html">Открыть админку →</a>`;
        sendMessage(adminChatId, msg).catch((e) => console.error('[BOOKINGS/MARK-PAID] Telegram failed:', e));
      }
    } catch (e) { /* swallow */ }

    res.json({
      message: 'marked',
      payment_status: 'pending_verification',
      next_step: 'Мы получили уведомление и подтвердим в течение 30 минут в рабочее время.',
    });
  } catch (err) {
    console.error('[BOOKINGS/MARK-PAID] error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
