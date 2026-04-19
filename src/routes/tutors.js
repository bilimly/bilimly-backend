const express = require('express');
const pool = require('../config/database');
const { auth, requireRole } = require('../middleware/auth');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files allowed'));
    cb(null, true);
  },
});
const router = express.Router();

router.get('/', async (req, res) => {
  console.log('TUTORS HIT, NODE_ENV:', process.env.NODE_ENV);
  try {
    const result = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.avatar_url,
              tp.id as tutor_id, tp.bio_ru, tp.bio_en, tp.bio_ky,
              tp.hourly_rate, tp.trial_rate, tp.subjects,
              tp.rating, tp.review_count, tp.total_lessons,
              tp.is_featured, tp.video_intro_url, tp.city, tp.badge, tp.total_students, tp.response_rate, tp.repeat_student_rate
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
       WHERE (u.id = $1 OR tp.id = $1)`,
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

    // Admin Telegram notification — new tutor application
    try {
      const { notifyAdminNewTutorApplication } = require('../services/telegramService');
      notifyAdminNewTutorApplication({
        full_name, email, phone,
        subjects: subjects || [],
        experience_years: experience_years || 0,
        hourly_rate: hourly_rate || 500,
      }).catch((e) => console.error('[TUTORS/APPLY] Admin notify failed:', e));
    } catch (e) { /* swallow */ }

    res.status(201).json({ message: 'Application submitted!', id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// POST /api/tutors/avatar — upload profile photo
router.post('/avatar',
  (req, res, next) => {
    avatarUpload.single('avatar')(req, res, (err) => {
      if (err) {
        console.error('[AVATAR] multer error:', err);
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Фото слишком большое (макс 10 МБ)' });
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  auth,
  async (req, res) => {
    console.log('[AVATAR] handler start, user id:', req.user && req.user.id);
    if (!req.file) { console.log('[AVATAR] no file'); return res.status(400).json({ error: 'Файл не загружен' }); }

    let cloudinaryUrl;
    try {
      console.log('[AVATAR] uploading to cloudinary...');
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'image',
            folder: 'bilimly/avatars',
            public_id: `user_${req.user.id}`,
            overwrite: true,
            invalidate: true,
            transformation: [
              { width: 400, height: 400, crop: 'fill', gravity: 'face' },
              { quality: 'auto:good', fetch_format: 'auto' },
            ],
          },
          (err, result) => { if (err) return reject(err); resolve(result); }
        );
        stream.end(req.file.buffer);
      });
      cloudinaryUrl = uploadResult.secure_url;
      console.log('[AVATAR] cloudinary url:', cloudinaryUrl);
    } catch (err) {
      console.error('[AVATAR] cloudinary error:', err);
      return res.status(500).json({ error: 'Cloudinary upload failed: ' + err.message });
    }

    try {
      console.log('[AVATAR] running UPDATE for user:', req.user.id);
      const result = await pool.query(
        `UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2 RETURNING id, avatar_url`,
        [cloudinaryUrl, req.user.id]
      );
      console.log('[AVATAR] UPDATE result rows:', result.rows);
      if (!result.rows || result.rows.length === 0) {
        return res.status(500).json({ error: 'User not found in DB' });
      }
      return res.json({ success: true, avatar_url: result.rows[0].avatar_url });
    } catch (err) {
      console.error('[AVATAR] db error:', err);
      return res.status(500).json({ error: 'DB update failed: ' + err.message });
    }
  }
);

// Multer config for video uploads
const videoUploadTutor = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 }, // 60 MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('video/')) return cb(new Error('Только видео-файлы'));
    cb(null, true);
  },
});

// POST /api/tutors/video-upload — tutor uploads their own intro video to Cloudinary
router.post('/video-upload',
  (req, res, next) => {
    videoUploadTutor.single('video')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Видео слишком большое (макс 60 МБ)' });
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  auth,
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    try {
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'video',
            folder: 'bilimly/tutor-videos',
            public_id: `tutor_${req.user.id}`,
            overwrite: true,
            chunk_size: 6000000,
            eager: [{ width: 640, height: 360, crop: 'limit', format: 'mp4' }],
            eager_async: true,
          },
          (err, result) => { if (err) return reject(err); resolve(result); }
        );
        stream.end(req.file.buffer);
      });

      await pool.query(
        `UPDATE tutor_profiles SET video_intro_url = $1 WHERE user_id = $2`,
        [uploadResult.secure_url, req.user.id]
      );

      return res.json({ success: true, video_url: uploadResult.secure_url });
    } catch (err) {
      console.error('[TUTORS/VIDEO] error:', err);
      return res.status(500).json({ error: 'Ошибка загрузки видео: ' + err.message });
    }
  }
);

module.exports = router;

router.post('/submit-review', auth, requireRole('tutor'), async (req, res) => {
  try {
    await pool.query(
      `UPDATE tutor_profiles SET approval_status='pending', updated_at=NOW() WHERE user_id=$1`,
      [req.user.id]
    );
    const tutor = await pool.query(
      'SELECT u.email, u.first_name FROM users u WHERE u.id=$1',
      [req.user.id]
    );
    if (tutor.rows[0]) {
      const { sendWelcomeEmail } = require('../services/emailService');
      sendWelcomeEmail('admin@bilimly.kg', tutor.rows[0].first_name + ' submitted for review', 'tutor').catch(console.error);
    }
    res.json({ message: 'Submitted for review' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});
