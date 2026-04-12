const express = require('express');
const pool = require('../config/database');
const { auth, requireRole } = require('../middleware/auth');
const router = express.Router();

// ── GET ALL APPROVED TUTORS (public) ──────────────────────
router.get('/', async (req, res) => {
  const { subject, language, min_rate, max_rate, search, sort, page = 1, limit = 12 } = req.query;
  const offset = (page - 1) * limit;

  let conditions = ['tp.is_approved = true', 'u.is_active = true'];
  let params = [];
  let paramCount = 1;

  if (subject) {
    conditions.push(`$${paramCount} = ANY(tp.subjects)`);
    params.push(subject); paramCount++;
  }
  if (min_rate) {
    conditions.push(`tp.hourly_rate >= $${paramCount}`);
    params.push(min_rate); paramCount++;
  }
  if (max_rate) {
    conditions.push(`tp.hourly_rate <= $${paramCount}`);
    params.push(max_rate); paramCount++;
  }
  if (search) {
    conditions.push(`(u.first_name ILIKE $${paramCount} OR u.last_name ILIKE $${paramCount} OR tp.bio_ru ILIKE $${paramCount})`);
    params.push(`%${search}%`); paramCount++;
  }

  const orderMap = {
    rating: 'tp.rating DESC',
    price_asc: 'tp.hourly_rate ASC',
    price_desc: 'tp.hourly_rate DESC',
    lessons: 'tp.total_lessons DESC',
  };
  const orderBy = orderMap[sort] || 'tp.is_featured DESC, tp.rating DESC';

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const [tutors, countResult] = await Promise.all([
      pool.query(
        `SELECT u.id, u.first_name, u.last_name, u.avatar_url, u.country,
                tp.id as tutor_id, tp.bio_ru, tp.bio_ky, tp.bio_en,
                tp.hourly_rate, tp.trial_rate, tp.currency,
                tp.subjects, tp.languages, tp.city,
                tp.rating, tp.review_count, tp.total_lessons,
                tp.is_featured, tp.video_intro_url
         FROM users u
         JOIN tutor_profiles tp ON u.id = tp.user_id
         ${where}
         ORDER BY ${orderBy}
         LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM users u JOIN tutor_profiles tp ON u.id = tp.user_id ${where}`,
        params
      )
    ]);

    res.json({
      tutors: tutors.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      pages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tutors' });
  }
});

// ── GET SINGLE TUTOR (public) ─────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.avatar_url,
              tp.*, 
              COALESCE(
                json_agg(r ORDER BY r.created_at DESC) FILTER (WHERE r.id IS NOT NULL),
                '[]'
              ) as reviews
       FROM users u
       JOIN tutor_profiles tp ON u.id = tp.user_id
       LEFT JOIN reviews r ON tp.id = r.tutor_id AND r.is_published = true
       WHERE u.id = $1 AND tp.is_approved = true
       GROUP BY u.id, u.first_name, u.last_name, u.avatar_url, tp.id`,
      [req.params.id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Tutor not found' });

    // Get availability
    const availability = await pool.query(
      'SELECT * FROM tutor_availability WHERE tutor_id = $1 AND is_active = true ORDER BY day_of_week, start_time',
      [result.rows[0].id]
    );

    res.json({ ...result.rows[0], availability: availability.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tutor' });
  }
});

// ── UPDATE TUTOR PROFILE (tutor only) ─────────────────────
router.put('/profile/me', auth, requireRole('tutor'), async (req, res) => {
  const {
    bio_ru, bio_ky, bio_en, hourly_rate, trial_rate,
    subjects, languages, city, timezone, video_intro_url
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE tutor_profiles SET
        bio_ru=$1, bio_ky=$2, bio_en=$3,
        hourly_rate=$4, trial_rate=$5,
        subjects=$6, languages=$7,
        city=$8, timezone=$9,
        video_intro_url=$10, updated_at=NOW()
       WHERE user_id=$11
       RETURNING *`,
      [bio_ru, bio_ky, bio_en, hourly_rate, trial_rate,
       subjects, languages, city, timezone, video_intro_url, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update tutor profile' });
  }
});

// ── SET AVAILABILITY (tutor only) ─────────────────────────
router.post('/availability', auth, requireRole('tutor'), async (req, res) => {
  const { availability } = req.body; // Array of {day_of_week, start_time, end_time}
  try {
    const tutor = await pool.query(
      'SELECT id FROM tutor_profiles WHERE user_id = $1', [req.user.id]
    );
    const tutorId = tutor.rows[0].id;

    await pool.query('DELETE FROM tutor_availability WHERE tutor_id = $1', [tutorId]);

    for (const slot of availability) {
      await pool.query(
        'INSERT INTO tutor_availability (tutor_id, day_of_week, start_time, end_time) VALUES ($1,$2,$3,$4)',
        [tutorId, slot.day_of_week, slot.start_time, slot.end_time]
      );
    }
    res.json({ message: 'Availability updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

// ── SUBMIT TUTOR APPLICATION (public) ─────────────────────
router.post('/apply', async (req, res) => {
  const { full_name, email, phone, subjects, experience_years, education, hourly_rate, about } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO tutor_applications
        (full_name, email, phone, subjects, experience_years, education, hourly_rate, about)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [full_name, email, phone, subjects, experience_years, education, hourly_rate, about]
    );

    // Trigger AI review (async - don't wait)
    const { reviewTutorApplication } = require('../agents/tutorVettingAgent');
    reviewTutorApplication(result.rows[0].id).catch(console.error);

    res.status(201).json({
      message: 'Application submitted! We will review it within 24 hours.',
      id: result.rows[0].id
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

module.exports = router;
