const express = require('express');
const pool = require('../config/database');
const { auth, requireRole } = require('../middleware/auth');
const router = express.Router();

// ── GET ALL APPROVED TUTORS (public) ──────────────────────
router.get('/', async (req, res) => {
  try {
    const { subject, search, sort, page = 1, limit = 20 } = req.query;
    let conditions = ['tp.is_approved = true', 'u.is_active = true'];
    let params = [];
    let i = 1;

    if (subject) {
      conditions.push(`$${i} = ANY(tp.subjects)`);
      params.push(subject); i++;
    }
    if (search) {
      conditions.push(`(u.first_name ILIKE $${i} OR u.last_name ILIKE $${i} OR tp.bio_ru ILIKE $${i})`);
      params.push(`%${search}%`); i++;
    }

    const orderMap = {
      rating: 'tp.rating DESC',
      price_asc: 'tp.hourly_rate ASC',
      price_desc: 'tp.hourly_rate DESC',
      lessons: 'tp.total_lessons DESC',
    };
    const orderBy = orderMap[sort] || 'tp.is_featured DESC, tp.rating DESC NULLS LAST';
    const where = 'WHERE ' + conditions.join(' AND ');
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.avatar_url,
              tp.id as tutor_id, tp.bio_ru, tp.bio_ky, tp.bio_en,
              tp.hourly_rate, tp.trial_rate, tp.currency,
              tp.subjects, tp.languages, tp.city,
              tp.rating, tp.review_count, tp.total_lessons,
              tp.is_featured, tp.video_intro_url
       FROM users u
       JOIN tutor_profiles tp ON u.id = tp.user_id
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${i} OFFSET $${i+1}`,
      [...params, limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM users u JOIN tutor_profiles tp ON u.id = tp.user_id ${where}`,
      params
    );

    res.json({
      tutors: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      pages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (err) {
    cconsole.error('Tutors error FULL:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to fetch tutors' });
  }
});

// ── GET SINGLE TUTOR (public) ─────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.avatar_url,
              tp.*
       FROM users u
       JOIN tutor_profiles tp ON u.id = tp.user_id
       WHERE u.id = $1 AND tp.is_approved = true`,
      [req.params.id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Tutor not found' });

    const reviews = await pool.query(
      `SELECT r.*, u.first_name, u.last_name 
       FROM reviews r 
       JOIN users u ON r.student_id = u.id
       WHERE r.tutor_id = $1 AND r.is_published = true 
       ORDER BY r.created_at DESC LIMIT 20`,
      [result.rows[0].tutor_id || result.rows[0].id]
    );

    const availability = await pool.query(
      'SELECT * FROM tutor_availability WHERE tutor_id = $1 AND is_active = true ORDER BY day_of_week, start_time',
      [result.rows[0].tutor_id || result.rows[0].id]
    );

    res.json({ 
      ...result.rows[0], 
      reviews: reviews.rows,
      availability: availability.rows 
    });
  } catch (err) {
    console.error('Single tutor error:', err.message);
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
      [bio_ru, bio_ky, bio_en, hourly_rate || 500, trial_rate || 200,
       subjects || [], languages || [], city || 'Бишкек', 
       timezone || 'Asia/Bishkek', video_intro_url, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update tutor error:', err.message);
    res.status(500).json({ error: 'Failed to update tutor profile' });
  }
});

// ── SET AVAILABILITY (tutor only) ─────────────────────────
router.post('/availability', auth, requireRole('tutor'), async (req, res) => {
  const { availability } = req.body;
  try {
    const tutor = await pool.query(
      'SELECT id FROM tutor_profiles WHERE user_id = $1', [req.user.id]
    );
    if (!tutor.rows[0]) return res.status(404).json({ error: 'Tutor profile not found' });
    
    const tutorId = tutor.rows[0].id;
    await pool.query('DELETE FROM tutor_availability WHERE tutor_id = $1', [tutorId]);

    for (const slot of (availability || [])) {
      await pool.query(
        'INSERT INTO tutor_availability (tutor_id, day_of_week, start_time, end_time) VALUES ($1,$2,$3,$4)',
        [tutorId, slot.day_of_week, slot.start_time, slot.end_time]
      );
    }
    res.json({ message: 'Availability updated' });
  } catch (err) {
    console.error('Availability error:', err.message);
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
      [full_name, email, phone, subjects || [], experience_years || 0, education || '', hourly_rate || 500, about || '']
    );

    try {
      const { reviewTutorApplication } = require('../agents/tutorVettingAgent');
      reviewTutorApplication(result.rows[0].id).catch(console.error);
    } catch(e) {}

    res.status(201).json({
      message: 'Application submitted! We will review it within 24 hours.',
      id: result.rows[0].id
    });
  } catch (err) {
    console.error('Apply error:', err.message);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

module.exports = router;
