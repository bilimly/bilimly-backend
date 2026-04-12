const express = require('express');
const pool = require('../config/database');
const { auth, requireRole } = require('../middleware/auth');
const { handleMbankWebhook, checkPaymentStatus } = require('../services/mbankService');
const router = express.Router();

// ── MBANK WEBHOOK (called by Mbank after payment) ─────────
router.post('/mbank/webhook', handleMbankWebhook);

// ── CHECK PAYMENT STATUS ───────────────────────────────────
router.get('/:id/status', auth, async (req, res) => {
  try {
    const payment = await checkPaymentStatus(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    res.json({
      id: payment.id,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      paid_at: payment.paid_at,
      qr_url: payment.mbank_qr_url,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// ── GET PAYMENT HISTORY (student) ─────────────────────────
router.get('/history', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, b.lesson_date, b.subject, b.lesson_type,
              u.first_name as tutor_first_name, u.last_name as tutor_last_name
       FROM payments p
       JOIN bookings b ON p.booking_id = b.id
       JOIN tutor_profiles tp ON b.tutor_id = tp.id
       JOIN users u ON tp.user_id = u.id
       WHERE p.student_id = $1
       ORDER BY p.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

// ── MANUAL PAYMENT CONFIRM (admin only) ───────────────────
// Use this while waiting for Mbank API approval
router.post('/:id/manual-confirm', auth, requireRole('admin'), async (req, res) => {
  try {
    await pool.query(
      `UPDATE payments SET status='completed', paid_at=NOW(),
       mbank_transaction_id=$1 WHERE id=$2`,
      [`MANUAL_${Date.now()}`, req.params.id]
    );

    const payment = await pool.query('SELECT booking_id FROM payments WHERE id=$1', [req.params.id]);
    await pool.query(
      'UPDATE bookings SET status=$1, updated_at=NOW() WHERE id=$2',
      ['confirmed', payment.rows[0].booking_id]
    );

    res.json({ message: 'Payment manually confirmed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

module.exports = router;
