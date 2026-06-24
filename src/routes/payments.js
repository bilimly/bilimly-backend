// ── PAYMENTS ROUTES ────────────────────────────────────────
const express = require('express');
const pool    = require('../config/database');
const { auth } = require('../middleware/auth');
const router  = express.Router();

// ── FREEDOM PAY WEBHOOK ────────────────────────────────────
// Freedom Pay POSTs to this URL after payment (pg_result_url)
// Must respond with XML: <pg_status>ok</pg_status>
router.post('/freedompay/webhook', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const params = req.body;
    console.log('[FP WEBHOOK]', JSON.stringify(params));

    // Verify signature
    const { verifySignature } = require('../services/freedomPayService');
    if (!verifySignature('check_url', params)) {
      console.error('[FP WEBHOOK] Invalid signature');
      return res.send(`<?xml version="1.0" encoding="utf-8"?><response><pg_status>rejected</pg_status><pg_description>Invalid signature</pg_description></response>`);
    }

    const orderId        = params.pg_order_id;   // our payment.id
    const fpPaymentId    = params.pg_payment_id;
    const fpStatus       = params.pg_result;      // 1 = success, 0 = fail
    const amount         = parseFloat(params.pg_amount || 0);

    if (fpStatus === '1') {
      // Payment successful
      await pool.query(
        `UPDATE payments SET status='completed', fp_payment_id=$1, paid_at=NOW(), updated_at=NOW() WHERE id=$2`,
        [fpPaymentId, orderId]
      );

      // Get booking_id from payment
      const paymentRow = await pool.query('SELECT booking_id, student_id FROM payments WHERE id=$1', [orderId]);
      if (paymentRow.rows[0]) {
        const { booking_id } = paymentRow.rows[0];

        // Update booking to confirmed
        await pool.query(
          `UPDATE bookings SET status='confirmed', updated_at=NOW() WHERE id=$1`,
          [booking_id]
        );

        // Auto-create Google Meet link
        try {
          const bookingData = await pool.query(
            `SELECT b.*,
              u_s.email as student_email, u_s.first_name as student_first, u_s.last_name as student_last,
              u_t.email as tutor_email, u_t.first_name as tutor_first, u_t.last_name as tutor_last
             FROM bookings b
             JOIN users u_s ON b.student_id = u_s.id
             JOIN tutor_profiles tp ON b.tutor_id = tp.id
             JOIN users u_t ON tp.user_id = u_t.id
             WHERE b.id=$1`, [booking_id]
          );
          const b = bookingData.rows[0];
          if (b) {
            const { createMeetingLink } = require('../services/googleMeetService');
            const meetUrl = await createMeetingLink(
              b,
              `${b.tutor_first} ${b.tutor_last}`,
              b.tutor_email,
              `${b.student_first} ${b.student_last}`,
              b.student_email,
              b.subject || 'Урок'
            );
            if (meetUrl) {
              await pool.query('UPDATE bookings SET meeting_url=$1 WHERE id=$2', [meetUrl, booking_id]);
            }

            // Send confirmation email to student
            const { sendBookingConfirmation } = require('../services/emailService');
            sendBookingConfirmation(
              b.student_email,
              b.student_first,
              `${b.tutor_first} ${b.tutor_last}`,
              b.subject,
              new Date(b.lesson_date).toLocaleDateString('ru-RU'),
              b.start_time,
              b.amount,
              meetUrl
            ).catch(e => console.error('[FP WEBHOOK] Email failed:', e));

            // Notify admin
            const { notifyAdminNewBooking } = require('../services/telegramService');
            notifyAdminNewBooking({
              subject: b.subject, amount: b.amount,
              lessonDate: b.lesson_date, startTime: b.start_time,
              studentName: `${b.student_first} ${b.student_last}`,
              tutorName: `${b.tutor_first} ${b.tutor_last}`,
            }).catch(() => {});
          }
        } catch (meetErr) {
          console.error('[FP WEBHOOK] Meet/email failed:', meetErr.message);
        }
      }
    } else {
      // Payment failed
      await pool.query(
        `UPDATE payments SET status='failed', fp_payment_id=$1, updated_at=NOW() WHERE id=$2`,
        [fpPaymentId, orderId]
      );
    }

    // Must respond OK to Freedom Pay
    res.send(`<?xml version="1.0" encoding="utf-8"?><response><pg_status>ok</pg_status></response>`);
  } catch (err) {
    console.error('[FP WEBHOOK] Error:', err);
    res.send(`<?xml version="1.0" encoding="utf-8"?><response><pg_status>ok</pg_status></response>`);
  }
});

// ── GET PAYMENT STATUS ─────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM payments WHERE id=$1',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Payment not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

// ── RETRY PAYMENT ──────────────────────────────────────────
// Student can retry payment if first attempt failed
router.post('/:id/retry', auth, async (req, res) => {
  try {
    const payment = await pool.query(
      `SELECT p.*, b.subject, u.email
       FROM payments p
       JOIN bookings b ON p.booking_id = b.id
       JOIN users u ON p.student_id = u.id
       WHERE p.id=$1 AND p.student_id=$2`,
      [req.params.id, req.user.id]
    );
    if (!payment.rows[0]) return res.status(404).json({ error: 'Payment not found' });

    const p = payment.rows[0];
    const { createPayment } = require('../services/freedomPayService');
    const fp = await createPayment({
      orderId:      p.id,
      amount:       p.amount,
      description:  `Урок по предмету "${p.subject || 'Урок'}" на Bilimpark.kg`,
      successUrl:   `${process.env.FRONTEND_URL}/payment-success.html?booking_id=${p.booking_id}`,
      failUrl:      `${process.env.FRONTEND_URL}/payment-fail.html?booking_id=${p.booking_id}`,
      resultUrl:    `${process.env.BACKEND_URL || 'https://bilimly-backend-0zbt.onrender.com'}/api/payments/freedompay/webhook`,
      customerEmail: p.email,
    });

    await pool.query(
      'UPDATE payments SET fp_payment_id=$1, fp_redirect_url=$2, status=$3 WHERE id=$4',
      [fp.payment_id, fp.redirect_url, 'pending', p.id]
    );

    res.json({ redirect_url: fp.redirect_url });
  } catch (err) {
    console.error('[PAYMENT RETRY]', err);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

// ── GET /api/payments/history — student's payment history ──────
router.get('/history', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.amount, p.currency, p.status, p.payment_method,
              p.created_at, p.paid_at,
              b.lesson_date, b.subject,
              u_tutor.first_name as tutor_first_name,
              u_tutor.last_name as tutor_last_name
       FROM payments p
       JOIN bookings b ON p.booking_id = b.id
       LEFT JOIN tutor_profiles tp ON b.tutor_id = tp.id
       LEFT JOIN users u_tutor ON tp.user_id = u_tutor.id
       WHERE b.student_id = $1
       ORDER BY p.created_at DESC
       LIMIT 100`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[PAYMENT HISTORY]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
