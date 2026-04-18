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
// ═══════════════════════════════════════════════════════════
// LEDGER-BASED EARNINGS (source of truth going forward)
// Uses tutor_earnings table populated by commissionService on lesson complete.
// Legacy /overview and /transactions remain for backward compat with tutor dashboard.
// ═══════════════════════════════════════════════════════════

// GET /api/earnings/my-summary — tutor's tier + lifetime + pending/released totals
router.get('/my-summary', auth, requireRole('tutor'), async (req, res) => {
  try {
    const tutor = await pool.query(
      `SELECT id, total_paid_hours, lifetime_earnings_gross, lifetime_earnings_net,
              wallet_balance
         FROM tutor_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    if (!tutor.rows[0]) return res.status(404).json({ error: 'Tutor profile not found' });
    const tp = tutor.rows[0];

    const { tierForHours, COMMISSION_TIERS } = require('../services/commissionService');
    const tier = tierForHours(tp.total_paid_hours || 0);

    // Ledger aggregates
    const ledger = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status='pending' THEN net_amount ELSE 0 END), 0) AS pending_net,
         COALESCE(SUM(CASE WHEN status='released' THEN net_amount ELSE 0 END), 0) AS released_net,
         COALESCE(SUM(CASE WHEN status='paid_out' THEN net_amount ELSE 0 END), 0) AS paid_out_net,
         COUNT(*) FILTER (WHERE status='pending') AS pending_count,
         COUNT(*) FILTER (WHERE status='released') AS released_count,
         COUNT(*) FILTER (WHERE status='paid_out') AS paid_out_count
       FROM tutor_earnings WHERE tutor_id = $1`,
      [tp.id]
    );

    res.json({
      tier: {
        commission_percent: tier.commission_percent,
        current_hours: parseFloat(tp.total_paid_hours) || 0,
        next_tier_hours: tier.next_tier_hours,
        next_tier_commission: tier.next_tier_commission,
        hours_to_next: tier.hours_to_next,
        all_tiers: COMMISSION_TIERS,
      },
      lifetime: {
        gross: parseFloat(tp.lifetime_earnings_gross) || 0,
        net: parseFloat(tp.lifetime_earnings_net) || 0,
      },
      wallet: {
        balance: parseFloat(tp.wallet_balance) || 0,
      },
      ledger: {
        pending_net: parseFloat(ledger.rows[0].pending_net) || 0,
        released_net: parseFloat(ledger.rows[0].released_net) || 0,
        paid_out_net: parseFloat(ledger.rows[0].paid_out_net) || 0,
        pending_count: parseInt(ledger.rows[0].pending_count) || 0,
        released_count: parseInt(ledger.rows[0].released_count) || 0,
        paid_out_count: parseInt(ledger.rows[0].paid_out_count) || 0,
      },
    });
  } catch (err) {
    console.error('[EARNINGS] my-summary error:', err);
    res.status(500).json({ error: 'Failed to fetch earnings summary' });
  }
});

// GET /api/earnings/ledger — paginated list of earnings entries
router.get('/ledger', auth, requireRole('tutor'), async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    const tutor = await pool.query(
      `SELECT id FROM tutor_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    if (!tutor.rows[0]) return res.status(404).json({ error: 'Tutor profile not found' });

    const params = [tutor.rows[0].id];
    let where = `WHERE te.tutor_id = $1`;
    if (status) {
      params.push(status);
      where += ` AND te.status = $${params.length}`;
    }
    params.push(parseInt(limit), offset);

    const result = await pool.query(
      `SELECT te.id, te.booking_id, te.gross_amount, te.commission_percent,
              te.commission_amount, te.net_amount, te.tier_hours_at_time,
              te.status, te.released_at, te.paid_out_at, te.created_at,
              b.lesson_date, b.start_time, b.subject,
              us.first_name AS student_first_name,
              us.last_name AS student_last_name
         FROM tutor_earnings te
         LEFT JOIN bookings b ON te.booking_id = b.id
         LEFT JOIN users us ON b.student_id = us.id
         ${where}
         ORDER BY te.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ entries: result.rows });
  } catch (err) {
    console.error('[EARNINGS] ledger error:', err);
    res.status(500).json({ error: 'Failed to fetch ledger' });
  }
});

// POST /api/earnings/admin/release/:earningsId — admin releases pending earnings to tutor wallet
// Used once admin verifies lesson happened + payment cleared.
router.post('/admin/release/:earningsId', auth, requireRole('admin'), async (req, res) => {
  try {
    const { releaseEarnings } = require('../services/commissionService');
    const result = await releaseEarnings(pool, req.params.earningsId);
    if (!result) return res.status(404).json({ error: 'Earnings entry not found or already released' });
    res.json({ success: true, earnings: result });
  } catch (err) {
    console.error('[EARNINGS] admin release error:', err);
    res.status(500).json({ error: 'Failed to release earnings' });
  }
});
module.exports = router;
