const express = require('express');
const pool = require('../config/database');
const { auth, requireRole } = require('../middleware/auth');
const { generateMbankQR } = require('../services/mbankService');
const router = express.Router();

// ── PACKAGE DEFINITIONS ────────────────────────────────────
const PACKAGE_DISCOUNTS = {
  1:  { lessons: 1,  discount: 0,    label_ru: 'Разовый урок',    label_ky: 'Бир жолку сабак',   label_en: 'Single lesson' },
  5:  { lessons: 5,  discount: 0.10, label_ru: 'Пакет 5 уроков',  label_ky: '5 сабак пакети',    label_en: '5 lesson pack' },
  10: { lessons: 10, discount: 0.20, label_ru: 'Пакет 10 уроков', label_ky: '10 сабак пакети',   label_en: '10 lesson pack' },
  20: { lessons: 20, discount: 0.30, label_ru: 'Пакет 20 уроков', label_ky: '20 сабак пакети',   label_en: '20 lesson pack' },
};

// ── DB TABLE FOR PACKAGES ──────────────────────────────────
// Add to migrate.js:
const createPackagesTable = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS lesson_packages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID REFERENCES users(id) ON DELETE CASCADE,
      tutor_id UUID REFERENCES tutor_profiles(id) ON DELETE CASCADE,
      package_size INTEGER NOT NULL,
      lessons_total INTEGER NOT NULL,
      lessons_used INTEGER DEFAULT 0,
      lessons_remaining INTEGER NOT NULL,
      price_per_lesson DECIMAL(10,2) NOT NULL,
      discount_percent DECIMAL(5,2) DEFAULT 0,
      total_amount DECIMAL(10,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'KGS',
      status VARCHAR(20) DEFAULT 'active'
        CHECK (status IN ('pending_payment','active','completed','expired','refunded')),
      payment_id UUID,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
};

// ── GET PACKAGE OPTIONS FOR A TUTOR ───────────────────────
router.get('/options/:tutorId', async (req, res) => {
  try {
    const tutor = await pool.query(
      'SELECT hourly_rate, trial_rate FROM tutor_profiles WHERE id = $1',
      [req.params.tutorId]
    );
    if (!tutor.rows[0]) return res.status(404).json({ error: 'Tutor not found' });

    const rate = parseFloat(tutor.rows[0].hourly_rate);
    const options = Object.entries(PACKAGE_DISCOUNTS).map(([size, pkg]) => ({
      size: parseInt(size),
      lessons: pkg.lessons,
      discount_percent: pkg.discount * 100,
      price_per_lesson: Math.round(rate * (1 - pkg.discount)),
      total_amount: Math.round(rate * (1 - pkg.discount) * pkg.lessons),
      original_amount: Math.round(rate * pkg.lessons),
      savings: Math.round(rate * pkg.discount * pkg.lessons),
      label_ru: pkg.label_ru,
      label_ky: pkg.label_ky,
      label_en: pkg.label_en,
      popular: parseInt(size) === 10,
    }));

    res.json(options);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get package options' });
  }
});

// ── PURCHASE PACKAGE ───────────────────────────────────────
router.post('/purchase', auth, requireRole('student'), async (req, res) => {
  const { tutor_id, package_size } = req.body;
  const pkg = PACKAGE_DISCOUNTS[package_size];
  if (!pkg) return res.status(400).json({ error: 'Invalid package size' });

  try {
    const tutor = await pool.query(
      'SELECT id, hourly_rate FROM tutor_profiles WHERE id = $1 AND is_approved = true',
      [tutor_id]
    );
    if (!tutor.rows[0]) return res.status(404).json({ error: 'Tutor not found' });

    const rate = parseFloat(tutor.rows[0].hourly_rate);
    const price_per_lesson = Math.round(rate * (1 - pkg.discount));
    const total_amount = price_per_lesson * pkg.lessons;
    const expires_at = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year

    // Create package record
    const result = await pool.query(
      `INSERT INTO lesson_packages
         (student_id, tutor_id, package_size, lessons_total, lessons_remaining,
          price_per_lesson, discount_percent, total_amount, status, expires_at)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,'pending_payment',$8)
       RETURNING id`,
      [req.user.id, tutor_id, package_size, pkg.lessons,
       price_per_lesson, pkg.discount * 100, total_amount, expires_at]
    );

    const packageId = result.rows[0].id;

    // Create payment with QR
    const payment = await pool.query(
      `INSERT INTO payments (student_id, amount, payment_method, status)
       VALUES ($1,$2,'mbank_qr','pending') RETURNING id`,
      [req.user.id, total_amount]
    );

    const qrData = await generateMbankQR(payment.rows[0].id, total_amount);

    // Link payment to package
    await pool.query(
      'UPDATE lesson_packages SET payment_id=$1 WHERE id=$2',
      [payment.rows[0].id, packageId]
    );

    res.status(201).json({
      package_id: packageId,
      package_size,
      lessons: pkg.lessons,
      price_per_lesson,
      total_amount,
      discount_percent: pkg.discount * 100,
      savings: Math.round(rate * pkg.discount * pkg.lessons),
      payment: {
        id: payment.rows[0].id,
        qr_code: qrData.qr_code,
        qr_url: qrData.qr_url,
        amount: total_amount,
      }
    });
  } catch (err) {
    console.error('Package purchase error:', err);
    res.status(500).json({ error: 'Failed to create package' });
  }
});

// ── GET MY PACKAGES ────────────────────────────────────────
router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT lp.*,
              u.first_name as tutor_first_name,
              u.last_name as tutor_last_name,
              u.avatar_url as tutor_avatar
       FROM lesson_packages lp
       JOIN tutor_profiles tp ON lp.tutor_id = tp.id
       JOIN users u ON tp.user_id = u.id
       WHERE lp.student_id = $1
       ORDER BY lp.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch packages' });
  }
});

// ── USE A LESSON FROM PACKAGE ──────────────────────────────
router.post('/:id/use', auth, async (req, res) => {
  try {
    const pkg = await pool.query(
      `SELECT * FROM lesson_packages
       WHERE id=$1 AND student_id=$2 AND status='active' AND lessons_remaining > 0`,
      [req.params.id, req.user.id]
    );

    if (!pkg.rows[0]) {
      return res.status(400).json({ error: 'No lessons remaining in this package' });
    }

    await pool.query(
      `UPDATE lesson_packages SET
         lessons_used = lessons_used + 1,
         lessons_remaining = lessons_remaining - 1,
         status = CASE WHEN lessons_remaining - 1 = 0 THEN 'completed' ELSE 'active' END,
         updated_at = NOW()
       WHERE id = $1`,
      [req.params.id]
    );

    res.json({ message: 'Lesson deducted from package', remaining: pkg.rows[0].lessons_remaining - 1 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to use lesson' });
  }
});

// ── ACTIVATE PACKAGE AFTER PAYMENT ────────────────────────
const activatePackage = async (paymentId) => {
  await pool.query(
    `UPDATE lesson_packages SET status='active', updated_at=NOW()
     WHERE payment_id=$1`,
    [paymentId]
  );
};

module.exports = router;
module.exports.activatePackage = activatePackage;
