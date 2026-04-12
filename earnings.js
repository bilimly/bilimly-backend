const express = require('express');
const pool = require('../config/database');
const { auth, requireRole } = require('../middleware/auth');
const router = express.Router();

// ── TUTOR EARNINGS OVERVIEW ────────────────────────────────
router.get('/overview', auth, requireRole('tutor'), async (req, res) => {
  try {
    const tutor = await pool.query(
      'SELECT id FROM tutor_profiles WHERE user_id=$1', [req.user.id]
    );
    if (!tutor.rows[0]) return res.status(404).json({ error: 'Tutor profile not found' });
    const tutorId = tutor.rows[0].id;

    const [total, thisMonth, pending, upcoming, stats] = await Promise.all([
      // Total earned all time
      pool.query(`
        SELECT COALESCE(SUM(p.amount),0) as total
        FROM payments p
        JOIN bookings b ON p.booking_id = b.id
        WHERE b.tutor_id=$1 AND p.status='completed'
      `, [tutorId]),

      // This month
      pool.query(`
        SELECT COALESCE(SUM(p.amount),0) as total
        FROM payments p
        JOIN bookings b ON p.booking_id = b.id
        WHERE b.tutor_id=$1 AND p.status='completed'
          AND DATE_TRUNC('month',p.paid_at) = DATE_TRUNC('month',NOW())
      `, [tutorId]),

      // Pending (confirmed but not paid out)
      pool.query(`
        SELECT COALESCE(SUM(p.amount),0) as total
        FROM payments p
        JOIN bookings b ON p.booking_id = b.id
        WHERE b.tutor_id=$1 AND p.status='completed'
          AND b.status='confirmed'
      `, [tutorId]),

      // Upcoming lessons
      pool.query(`
        SELECT COUNT(*) as count FROM bookings
        WHERE tutor_id=$1 AND status='confirmed'
          AND lesson_date >= CURRENT_DATE
      `, [tutorId]),

      // Monthly breakdown last 6 months
      pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month',p.paid_at),'Mon YYYY') as month,
          COUNT(b.id) as lessons,
          SUM(p.amount) as earnings
        FROM payments p
        JOIN bookings b ON p.booking_id = b.id
        WHERE b.tutor_id=$1 AND p.status='completed'
          AND p.paid_at >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month',p.paid_at)
        ORDER BY DATE_TRUNC('month',p.paid_at)
      `, [tutorId]),
    ]);

    // Platform commission (Bilimly takes 15%)
    const COMMISSION = 0.15;
    const totalGross = parseFloat(total.rows[0].total);
    const monthGross = parseFloat(thisMonth.rows[0].total);

    res.json({
      earnings: {
        total_gross: totalGross,
        total_net: Math.round(totalGross * (1 - COMMISSION)),
        this_month_gross: monthGross,
        this_month_net: Math.round(monthGross * (1 - COMMISSION)),
        pending: parseFloat(pending.rows[0].total),
        commission_rate: COMMISSION * 100,
      },
      upcoming_lessons: parseInt(upcoming.rows[0].count),
      monthly_breakdown: stats.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

// ── TUTOR TRANSACTION HISTORY ──────────────────────────────
router.get('/transactions', auth, requireRole('tutor'), async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  try {
    const tutor = await pool.query(
      'SELECT id FROM tutor_profiles WHERE user_id=$1', [req.user.id]
    );
    const tutorId = tutor.rows[0].id;

    const result = await pool.query(
      `SELECT
         p.id, p.amount, p.status, p.paid_at, p.payment_method,
         b.lesson_date, b.start_time, b.subject, b.lesson_type,
         u.first_name as student_first_name,
         u.last_name as student_last_name,
         ROUND(p.amount * 0.85, 2) as net_amount
       FROM payments p
       JOIN bookings b ON p.booking_id = b.id
       JOIN users u ON b.student_id = u.id
       WHERE b.tutor_id=$1
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [tutorId, limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// ── TUTOR PAYOUT REQUEST ───────────────────────────────────
router.post('/payout', auth, requireRole('tutor'), async (req, res) => {
  const { amount, mbank_account } = req.body;
  try {
    // In production: integrate with Mbank payout API
    // For now: create payout request for admin to process manually
    await pool.query(
      `INSERT INTO notifications
         (user_id, type, title_ru, message_ru)
       VALUES
         ((SELECT id FROM users WHERE email='admin@bilimly.kg'),
          'payout_request',
          'Запрос на выплату',
          $1)`,
      [`Репетитор ${req.user.first_name} запрашивает выплату ${amount} сом на счёт ${mbank_account}`]
    );
    res.json({ message: 'Запрос на выплату отправлен. Обработка в течение 24 часов.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit payout request' });
  }
});

// ── TUTOR SCHEDULE (upcoming lessons) ─────────────────────
router.get('/schedule', auth, requireRole('tutor'), async (req, res) => {
  try {
    const tutor = await pool.query(
      'SELECT id FROM tutor_profiles WHERE user_id=$1', [req.user.id]
    );
    const result = await pool.query(
      `SELECT b.*,
              u.first_name as student_first_name,
              u.last_name as student_last_name,
              u.avatar_url as student_avatar,
              u.phone as student_phone,
              p.status as payment_status
       FROM bookings b
       JOIN users u ON b.student_id = u.id
       LEFT JOIN payments p ON b.id = p.booking_id
       WHERE b.tutor_id=$1
         AND b.lesson_date >= CURRENT_DATE
         AND b.status IN ('confirmed','pending')
       ORDER BY b.lesson_date ASC, b.start_time ASC
       LIMIT 30`,
      [tutor.rows[0].id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
});

module.exports = router;
