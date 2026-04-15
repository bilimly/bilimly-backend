const express = require('express');
const pool = require('../config/database');
const { auth, requireRole } = require('../middleware/auth');
const router = express.Router();

// All admin routes require auth + admin role
router.use(auth, requireRole('admin'));

// ── DASHBOARD STATS ────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [users, tutors, bookings, revenue, pending] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users WHERE role = $1', ['student']),
      pool.query('SELECT COUNT(*) FROM tutor_profiles WHERE is_approved = true'),
      pool.query("SELECT COUNT(*) FROM bookings WHERE status = 'completed'"),
      pool.query("SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE status='completed'"),
      pool.query("SELECT COUNT(*) FROM tutor_applications WHERE status IN ('pending','ai_reviewed')"),
    ]);

    // Recent bookings trend (last 7 days)
    const trend = await pool.query(`
      SELECT DATE(created_at) as date, COUNT(*) as bookings, SUM(amount) as revenue
      FROM bookings
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY date
    `);

    res.json({
      stats: {
        total_students: parseInt(users.rows[0].count),
        total_tutors: parseInt(tutors.rows[0].count),
        completed_lessons: parseInt(bookings.rows[0].count),
        total_revenue_kgs: parseFloat(revenue.rows[0].total),
        pending_applications: parseInt(pending.rows[0].count),
      },
      trend: trend.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── MANAGE USERS ───────────────────────────────────────────
router.get('/users', async (req, res) => {
  const { role, search, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  let conditions = [];
  let params = [];
  let i = 1;

  if (role) { conditions.push(`role=$${i++}`); params.push(role); }
  if (search) {
    conditions.push(`(email ILIKE $${i} OR first_name ILIKE $${i} OR last_name ILIKE $${i})`);
    params.push(`%${search}%`); i++;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const result = await pool.query(
      `SELECT id, email, role, first_name, last_name, phone, is_active, created_at
       FROM users ${where}
       ORDER BY created_at DESC
       LIMIT $${i} OFFSET $${i+1}`,
      [...params, limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ── BAN/UNBAN USER ─────────────────────────────────────────
router.put('/users/:id/toggle-active', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE users SET is_active = NOT is_active WHERE id=$1 RETURNING id, is_active',
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle user' });
  }
});

// ── TUTOR APPLICATIONS ─────────────────────────────────────
router.get('/applications', async (req, res) => {
  const { status } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM tutor_applications
       ${status ? 'WHERE status=$1' : ''}
       ORDER BY created_at DESC`,
      status ? [status] : []
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// ── APPROVE/REJECT TUTOR APPLICATION ──────────────────────
router.put('/applications/:id/review', async (req, res) => {
  const { action, notes } = req.body; // action: 'approve' | 'reject'
  try {
    await pool.query(
      'UPDATE tutor_applications SET status=$1, admin_notes=$2, reviewed_at=NOW() WHERE id=$3',
      [action === 'approve' ? 'approved' : 'rejected', notes, req.params.id]
    );

    // If approved, create user account and tutor profile
    if (action === 'approve') {
      const app = await pool.query('SELECT * FROM tutor_applications WHERE id=$1', [req.params.id]);
      const { full_name, email, phone, subjects, hourly_rate, about } = app.rows[0];
      const [first_name, ...rest] = full_name.split(' ');
      const last_name = rest.join(' ') || '';

      // Create user with temp password
      const bcrypt = require('bcryptjs');
      const tempPassword = Math.random().toString(36).slice(-8);
      const hash = await bcrypt.hash(tempPassword, 12);

      const user = await pool.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
         VALUES ($1,$2,'tutor',$3,$4,$5)
         ON CONFLICT (email) DO UPDATE SET role='tutor'
         RETURNING id`,
        [email, hash, first_name, last_name, phone]
      );

      await pool.query(
        `INSERT INTO tutor_profiles (user_id, bio_ru, hourly_rate, subjects, is_approved, approval_status)
         VALUES ($1,$2,$3,$4,true,'approved')
         ON CONFLICT (user_id) DO UPDATE SET is_approved=true, approval_status='approved'`,
        [user.rows[0].id, about, hourly_rate || 500, subjects || []]
      );

      res.json({ message: 'Tutor approved', temp_password: tempPassword });
    } else {
      res.json({ message: 'Application rejected' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to review application' });
  }
});

// ── ALL BOOKINGS ───────────────────────────────────────────
router.get('/bookings', async (req, res) => {
  const { status, date_from, date_to, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  let conditions = [];
  let params = [];
  let i = 1;

  if (status) { conditions.push(`b.status=$${i++}`); params.push(status); }
  if (date_from) { conditions.push(`b.lesson_date >= $${i++}`); params.push(date_from); }
  if (date_to) { conditions.push(`b.lesson_date <= $${i++}`); params.push(date_to); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const result = await pool.query(
      `SELECT b.*,
              us.first_name as student_name, us.email as student_email,
              ut.first_name as tutor_name,
              p.status as payment_status, p.amount as paid_amount
       FROM bookings b
       JOIN users us ON b.student_id = us.id
       JOIN tutor_profiles tp ON b.tutor_id = tp.id
       JOIN users ut ON tp.user_id = ut.id
       LEFT JOIN payments p ON b.id = p.booking_id
       ${where}
       ORDER BY b.created_at DESC
       LIMIT $${i} OFFSET $${i+1}`,
      [...params, limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// ── REVENUE REPORT ─────────────────────────────────────────
router.get('/revenue', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        DATE_TRUNC('month', p.paid_at) as month,
        COUNT(*) as transactions,
        SUM(p.amount) as total_kgs,
        AVG(p.amount) as avg_amount
      FROM payments p
      WHERE p.status = 'completed'
      GROUP BY DATE_TRUNC('month', p.paid_at)
      ORDER BY month DESC
      LIMIT 12
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch revenue' });
  }
});

// ── SUPPORT MESSAGES ───────────────────────────────────────
router.get('/messages', async (req, res) => {
  const { channel } = req.query;
  try {
    const result = await pool.query(
      `SELECT sm.*, u.email, u.first_name
       FROM support_messages sm
       LEFT JOIN users u ON sm.user_id = u.id
       ${channel ? 'WHERE sm.channel=$1' : ''}
       ORDER BY sm.created_at DESC LIMIT 100`,
      channel ? [channel] : []
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

module.exports = router;

router.put('/tutors/:userId/approve', async (req, res) => {
  try {
    await pool.query(`UPDATE tutor_profiles SET is_approved=true, approval_status='approved' WHERE user_id=$1`, [req.params.userId]);
    res.json({ message: 'Tutor approved' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/users/:userId/toggle-active', async (req, res) => {
  try {
    await pool.query(`UPDATE users SET is_active = NOT is_active WHERE id=$1`, [req.params.userId]);
    res.json({ message: 'Done' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/applications/:id/approve', async (req, res) => {
  try {
    await pool.query(`UPDATE tutor_applications SET status='approved' WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Approved' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/applications/:id/reject', async (req, res) => {
  try {
    await pool.query(`UPDATE tutor_applications SET status='rejected' WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Rejected' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/bookings/:id/confirm', async (req, res) => {
  try {
    await pool.query(`UPDATE bookings SET status='confirmed' WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Confirmed' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/bookings/:id/cancel', async (req, res) => {
  try {
    await pool.query(`UPDATE bookings SET status='cancelled' WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Cancelled' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.get('/applications/full', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id as user_id, u.first_name, u.last_name, u.email, u.created_at,
        tp.id as profile_id, tp.bio_ru, tp.bio_en, tp.subjects, 
        tp.hourly_rate, tp.trial_rate, tp.video_intro_url,
        tp.is_approved, tp.approval_status, tp.city,
        (SELECT COUNT(*) FROM bookings WHERE tutor_id = u.id) as total_lessons
      FROM users u
      JOIN tutor_profiles tp ON u.id = tp.user_id
      WHERE u.role = 'tutor' AND tp.approval_status != 'approved'
      ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/tutors/:userId/reject', async (req, res) => {
  try {
    await pool.query(
      `UPDATE tutor_profiles SET is_approved=false, approval_status='rejected', approval_notes=$1 WHERE user_id=$2`,
      [req.body.reason || 'Не соответствует требованиям', req.params.userId]
    );
    res.json({ message: 'Tutor rejected' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
