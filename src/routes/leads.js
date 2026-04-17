const express = require('express');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Tighter rate limit specifically for lead submissions to prevent form spam.
// 5 submissions per IP per hour is generous for real users, brutal for bots.
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Слишком много попыток. Попробуйте позже.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Normalize a phone number to Kyrgyz format: +996XXXXXXXXX (13 chars total).
// Accepts: "+996555123456", "996555123456", "0555123456", "555123456",
// "+996 555 12-34-56", etc.
function normalizeKgPhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('996')) return '+' + digits;
  if (digits.length === 10 && digits.startsWith('0')) return '+996' + digits.slice(1);
  if (digits.length === 9) return '+996' + digits;
  return null;
}

// Find 3 best-matching tutors for a given subject.
// Strategy: approved + active tutors who teach the subject, sorted by rating,
// then review_count, then total_lessons. If fewer than 3 match, fill with
// top-rated tutors overall (flagged as 'recommended' not 'matched').
async function findMatchedTutors(subject) {
  const matchedResult = await pool.query(
    `
    SELECT
      tp.id,
      tp.user_id,
      tp.bio_ru,
      tp.hourly_rate,
      tp.trial_rate,
      tp.currency,
      tp.subjects,
      tp.rating,
      tp.review_count,
      tp.total_lessons,
      u.first_name,
      u.last_name,
      u.avatar_url
    FROM tutor_profiles tp
    JOIN users u ON u.id = tp.user_id
    WHERE tp.is_approved = TRUE
      AND tp.approval_status = 'approved'
      AND u.is_active = TRUE
      AND $1 = ANY(tp.subjects)
    ORDER BY tp.rating DESC, tp.review_count DESC, tp.total_lessons DESC
    LIMIT 3
    `,
    [subject]
  );

  const matched = matchedResult.rows.map(r => ({ ...r, match_type: 'matched' }));
  if (matched.length >= 3) return matched;

  // Fill remainder with top-rated tutors overall, excluding those already matched.
  const excludeIds = matched.map(t => t.id);
  const needed = 3 - matched.length;

  const fallbackResult = await pool.query(
    `
    SELECT
      tp.id,
      tp.user_id,
      tp.bio_ru,
      tp.hourly_rate,
      tp.trial_rate,
      tp.currency,
      tp.subjects,
      tp.rating,
      tp.review_count,
      tp.total_lessons,
      u.first_name,
      u.last_name,
      u.avatar_url
    FROM tutor_profiles tp
    JOIN users u ON u.id = tp.user_id
    WHERE tp.is_approved = TRUE
      AND tp.approval_status = 'approved'
      AND u.is_active = TRUE
      AND tp.id <> ALL($1::uuid[])
    ORDER BY tp.rating DESC, tp.review_count DESC, tp.total_lessons DESC
    LIMIT $2
    `,
    [excludeIds, needed]
  );

  const fallback = fallbackResult.rows.map(r => ({ ...r, match_type: 'recommended' }));
  return [...matched, ...fallback];
}

// POST /api/leads — Public endpoint. Capture a lead and return 3 matched tutors.
router.post(
  '/',
  submitLimiter,
  [
    body('phone').isString().isLength({ min: 9, max: 25 }),
    body('grade_band').isIn(['primary', 'middle', 'high', 'ort_university']),
    body('subject').isString().isLength({ min: 1, max: 50 }),
    body('urgency').isIn(['this_week', 'this_month', 'exploring']),
    body('source').optional().isString().isLength({ max: 50 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Проверьте заполнение формы.', details: errors.array() });
    }

    const phone = normalizeKgPhone(req.body.phone);
    if (!phone) {
      return res.status(400).json({ error: 'Укажите корректный номер телефона (+996XXXXXXXXX).' });
    }

    const { grade_band, subject, urgency } = req.body;
    const source = req.body.source || 'lead_capture_page';
    const ipAddress = req.ip;
    const userAgent = req.get('user-agent') || null;

    try {
      const matchedTutors = await findMatchedTutors(subject);
      const matchedIds = matchedTutors.map(t => t.id);

      const insertResult = await pool.query(
        `
        INSERT INTO leads
          (phone, grade_band, subject, urgency, source, matched_tutor_ids, ip_address, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, created_at
        `,
        [phone, grade_band, subject, urgency, source, matchedIds, ipAddress, userAgent]
      );

      return res.status(201).json({
        success: true,
        lead_id: insertResult.rows[0].id,
        matched_tutors: matchedTutors,
      });
    } catch (err) {
      console.error('[LEADS] Error creating lead:', err);
      return res.status(500).json({ error: 'Не удалось сохранить заявку. Попробуйте ещё раз.' });
    }
  }
);

// GET /api/leads/match?subject=... — Preview matches without creating a lead.
// Useful for the homepage or for showing matches before phone capture.
router.get('/match', async (req, res) => {
  const subject = req.query.subject;
  if (!subject || typeof subject !== 'string') {
    return res.status(400).json({ error: 'subject is required' });
  }
  try {
    const matched = await findMatchedTutors(subject);
    return res.json({ matched_tutors: matched });
  } catch (err) {
    console.error('[LEADS] Error in match preview:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;