const express = require('express');
const pool = require('../config/database');
const { auth, requireRole } = require('../middleware/auth');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.avatar_url,
              tp.id as tutor_id, tp.bio_ru, tp.bio_en, tp.bio_ky,
              tp.hourly_rate, tp.trial_rate, tp.subjects,
              tp.rating, tp.review_count, tp.total_lessons,
              tp.is_featured, tp.video_intro_url, tp.city
       FROM users u
       JOIN tutor_profiles tp ON u.id = tp.user_id
       WHERE tp.is_approved = true AND u.is_active = true
       ORDER BY tp.is_featured DESC NULLS LAST, tp.rating DESC NULLS LAST
       LIMIT 50`
    );
    res.json({ tutors: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('Tutors error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
       WHERE r.tutor_id = $1
       ORDER BY r.created_at DESC LIMIT 20`,
      [result.rows[0].tutor_id || result.rows[0].id]
    );
    res.json({ ...result.rows[0], reviews: reviews.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/profile/me', auth, requireRole('tutor'), async (req, res) => {
  const { bio_ru, bio_ky, bio_en, hourly_rate, trial_rate, subjects, city, video_intro_url } = req.body;
  try {
    const result = await pool.query(
      `UPDATE tutor_profiles SET bio_ru=$1, bio_ky=$2, bio_en=$3,
       hourly_rate=$4, trial_rate=$5, subjects=$6, city=$7,
       video_intro_url=$8, updated_at=NOW()
       WHERE user_id=$9 RETURNING *`,
      [bio_ru, bio_ky, bio_en, hourly_rate||500, trial_rate||200,
       subjects||[], city||'Бишкек', video_intro_url, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/availability', auth, requireRole('tutor'), async (req, res) => {
  const { availability } = req.body;
  try {
    const tutor = await pool.query('SELECT id FROM tutor_profiles WHERE user_id=$1', [req.user.id]);
    if (!tutor.rows[0]) return res.status(404).json({ error: 'Not found' });
    const tutorId = tutor.rows[0].id;
    await pool.query('DELETE FROM tutor_availability WHERE tutor_id=$1', [tutorId]);
    for (const slot of (availability||[])) {
      await pool.query(
        'INSERT INTO tutor_availability (tutor_id, day_of_week, start_time, end_time) VALUES ($1,$2,$3,$4)',
        [tutorId, slot.day_of_week, slot.start_time, slot.end_time]
      );
    }
    res.json({ message: 'Availability updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/apply', async (req, res) => {
  const { full_name, email, phone, subjects, experience_years, hourly_rate, about } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO tutor_applications (full_name, email, phone, subjects, experience_years, hourly_rate, about)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [full_name, email, phone, subjects||[], experience_years||0, hourly_rate||500, about||'']
    );
    res.status(201).json({ message: 'Application submitted!', id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
