const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { auth } = require('../middleware/auth');
const router = express.Router();

router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('first_name').trim().notEmpty(),
  body('last_name').trim().notEmpty(),
  body('role').isIn(['student', 'tutor']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { email, password, first_name, last_name, role, phone, language_preference } = req.body;
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already registered' });
    const password_hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, phone, language_preference)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, email, role, first_name, last_name`,
      [email, password_hash, role, first_name, last_name, phone || null, language_preference || 'ru']
    );
    const user = result.rows[0];
    if (role === 'tutor') await pool.query('INSERT INTO tutor_profiles (user_id) VALUES ($1)', [user.id]);
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const { sendWelcomeEmail } = require('../services/emailService');
sendWelcomeEmail(email, first_name, role).catch(console.error);
    res.status(201).json({ token, user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1 AND is_active = true', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.role, u.first_name, u.last_name,
              u.phone, u.avatar_url, u.language_preference, u.created_at,
              tp.id as tutor_profile_id, tp.is_approved, tp.hourly_rate, tp.rating
       FROM users u
       LEFT JOIN tutor_profiles tp ON u.id = tp.user_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

router.put('/me', auth, async (req, res) => {
  const { first_name, last_name, phone, language_preference, avatar_url } = req.body;
  try {
    const result = await pool.query(
      `UPDATE users SET first_name=$1, last_name=$2, phone=$3,
       language_preference=$4, avatar_url=$5, updated_at=NOW()
       WHERE id=$6 RETURNING id, email, role, first_name, last_name, phone, language_preference`,
      [first_name, last_name, phone, language_preference, avatar_url, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});
// ══════════════════════════════════════════════════════════
// PAYMENTS PIN — Parent-facing PIN to gate financial views
// ══════════════════════════════════════════════════════════

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MINUTES = 15;
const PIN_TOKEN_TTL = '2h';

// POST /api/auth/pin/set — create or change PIN. Requires current password.
router.post('/pin/set', auth, [
  body('password').notEmpty(),
  body('pin').isLength({ min: 4, max: 4 }).isNumeric(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { password, pin } = req.body;
  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный пароль' });
    const pinHash = await bcrypt.hash(pin, 10);
    await pool.query(
      `UPDATE users SET payments_pin_hash=$1, pin_failed_attempts=0, pin_locked_until=NULL, updated_at=NOW()
       WHERE id=$2`,
      [pinHash, req.user.id]
    );
    res.json({ success: true, message: 'PIN установлен' });
  } catch (err) {
    console.error('PIN set error:', err);
    res.status(500).json({ error: 'Не удалось установить PIN' });
  }
});

// POST /api/auth/pin/verify — verify PIN, return short-lived pin-session token.
router.post('/pin/verify', auth, [
  body('pin').isLength({ min: 4, max: 4 }).isNumeric(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { pin } = req.body;
  try {
    const result = await pool.query(
      `SELECT payments_pin_hash, pin_failed_attempts, pin_locked_until FROM users WHERE id=$1`,
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.payments_pin_hash) {
      return res.status(400).json({ error: 'PIN_NOT_SET', message: 'PIN не установлен' });
    }
    if (user.pin_locked_until && new Date(user.pin_locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.pin_locked_until) - new Date()) / 60000);
      return res.status(429).json({
        error: 'PIN_LOCKED',
        message: `Слишком много неверных попыток. Попробуйте через ${minutesLeft} мин.`,
      });
    }
    const valid = await bcrypt.compare(pin, user.payments_pin_hash);
    if (!valid) {
      const attempts = (user.pin_failed_attempts || 0) + 1;
      if (attempts >= MAX_PIN_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60000);
        await pool.query(
          `UPDATE users SET pin_failed_attempts=$1, pin_locked_until=$2 WHERE id=$3`,
          [attempts, lockUntil, req.user.id]
        );
        return res.status(429).json({
          error: 'PIN_LOCKED',
          message: `Слишком много неверных попыток. Заблокировано на ${PIN_LOCKOUT_MINUTES} мин.`,
        });
      }
      await pool.query(`UPDATE users SET pin_failed_attempts=$1 WHERE id=$2`, [attempts, req.user.id]);
      return res.status(401).json({
        error: 'PIN_INVALID',
        message: `Неверный PIN. Осталось попыток: ${MAX_PIN_ATTEMPTS - attempts}`,
      });
    }
    // Success — reset counters and issue pin-session token
    await pool.query(
      `UPDATE users SET pin_failed_attempts=0, pin_locked_until=NULL WHERE id=$1`,
      [req.user.id]
    );
    const pinToken = jwt.sign(
      { userId: req.user.id, type: 'payments_pin' },
      process.env.JWT_SECRET,
      { expiresIn: PIN_TOKEN_TTL }
    );
    res.json({ success: true, pin_token: pinToken, expires_in_seconds: 2 * 60 * 60 });
  } catch (err) {
    console.error('PIN verify error:', err);
    res.status(500).json({ error: 'Ошибка проверки PIN' });
  }
});

// GET /api/auth/pin/status — does this user have a PIN set? (For UI to show "Setup" vs "Enter")
router.get('/pin/status', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         (payments_pin_hash IS NOT NULL) AS has_pin,
         pin_locked_until
       FROM users WHERE id=$1`,
      [req.user.id]
    );
    const row = result.rows[0] || {};
    const isLocked = row.pin_locked_until && new Date(row.pin_locked_until) > new Date();
    res.json({
      has_pin: !!row.has_pin,
      is_locked: !!isLocked,
      locked_until: isLocked ? row.pin_locked_until : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось получить статус PIN' });
  }
});

// POST /api/auth/pin/remove — remove PIN entirely. Requires current password.
router.post('/pin/remove', auth, [
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { password } = req.body;
  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный пароль' });
    await pool.query(
      `UPDATE users SET payments_pin_hash=NULL, pin_failed_attempts=0, pin_locked_until=NULL,
         pin_reset_token=NULL, pin_reset_expires=NULL, updated_at=NOW()
       WHERE id=$1`,
      [req.user.id]
    );
    res.json({ success: true, message: 'PIN удалён' });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось удалить PIN' });
  }
});
// ═══════════════════════════════════════════════════════════
// TUTOR CLAIM — activate account created by admin via magic link
// ═══════════════════════════════════════════════════════════

// GET /api/auth/claim/:token — preview profile before claiming
router.get('/claim/:token', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone,
              u.claim_expires_at, u.claim_used_at,
              tp.bio_ru, tp.subjects, tp.hourly_rate, tp.trial_rate,
              tp.city, tp.video_intro_url, tp.approval_status
         FROM users u
         LEFT JOIN tutor_profiles tp ON tp.user_id = u.id
         WHERE u.claim_token = $1`,
      [req.params.token]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'INVALID_TOKEN', message: 'Ссылка недействительна или уже использована' });
    if (user.claim_used_at) return res.status(400).json({ error: 'ALREADY_CLAIMED', message: 'Аккаунт уже активирован. Войдите через форму входа.' });
    if (user.claim_expires_at && new Date(user.claim_expires_at) < new Date()) {
      return res.status(400).json({ error: 'EXPIRED', message: 'Ссылка истекла. Обратитесь к администратору.' });
    }
    res.json({
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      phone: user.phone,
      bio_ru: user.bio_ru,
      subjects: user.subjects,
      hourly_rate: user.hourly_rate,
      trial_rate: user.trial_rate,
      city: user.city,
      video_intro_url: user.video_intro_url,
    });
  } catch (err) {
    console.error('[AUTH/CLAIM GET] error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /api/auth/claim/:token — activate account by setting password
router.post('/claim/:token', [
  body('password').isLength({ min: 6 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { password } = req.body;

  try {
    const userResult = await pool.query(
      `SELECT id, claim_used_at, claim_expires_at FROM users WHERE claim_token = $1`,
      [req.params.token]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'INVALID_TOKEN' });
    if (user.claim_used_at) return res.status(400).json({ error: 'ALREADY_CLAIMED' });
    if (user.claim_expires_at && new Date(user.claim_expires_at) < new Date()) {
      return res.status(400).json({ error: 'EXPIRED' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query(
      `UPDATE users SET
         password_hash = $1,
         claim_used_at = NOW(),
         is_verified = true,
         updated_at = NOW()
       WHERE id = $2`,
      [passwordHash, user.id]
    );

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const fullUser = await pool.query(
      `SELECT id, email, role, first_name, last_name FROM users WHERE id = $1`,
      [user.id]
    );
    res.json({ success: true, token, user: fullUser.rows[0] });
  } catch (err) {
    console.error('[AUTH/CLAIM POST] error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});
module.exports = router;
