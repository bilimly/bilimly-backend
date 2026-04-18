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
      `SELECT u.id, u.email, u.role, u.first_name, u.last_name, u.phone, u.is_active, u.created_at, tp.is_approved as tutor_approved, tp.approval_status, tp.subjects, tp.hourly_rate, tp.rating, tp.total_lessons, tp.badge, tp.id as tutor_profile_id
       FROM users u LEFT JOIN tutor_profiles tp ON u.id = tp.user_id ${where.replace('WHERE', 'WHERE u.')}
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
    
    // Send approval email to tutor
    const tutor = await pool.query(
      'SELECT u.email, u.first_name, u.last_name FROM users u WHERE u.id=$1',
      [req.params.userId]
    );
    if(tutor.rows[0]) {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      resend.emails.send({
        from: `Bilimly.kg <${process.env.FROM_EMAIL}>`,
        to: tutor.rows[0].email,
        subject: '🎉 Ваш профиль одобрен на Bilimly.kg!',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <div style="background:#0ABAB5;padding:24px;text-align:center;">
              <h1 style="color:white;font-size:1.5rem;margin:0">Bilimly.kg</h1>
            </div>
            <div style="padding:32px;background:#f9fafb;">
              <h2 style="color:#0a0a0a">Поздравляем, ${tutor.rows[0].first_name}! 🎉</h2>
              <p style="font-size:1rem;color:#374151">Ваш профиль репетитора был одобрен. Теперь вы видны на bilimly.kg и студенты могут записываться к вам.</p>
              <div style="background:white;border-radius:12px;padding:20px;margin:20px 0;border:1px solid #e5e7eb;">
                <p><strong>Что делать дальше:</strong></p>
                <p>✅ Войдите в кабинет репетитора</p>
                <p>✅ Убедитесь что профиль заполнен полностью</p>
                <p>✅ Добавьте видео-презентацию если ещё не добавили</p>
                <p>✅ Установите своё расписание</p>
              </div>
              <a href="https://bilimly.kg/tutor-dashboard.html" style="background:#0ABAB5;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;display:inline-block;font-weight:bold;font-size:1rem;">Открыть кабинет репетитора →</a>
            </div>
            <div style="padding:16px;text-align:center;color:#6b7280;font-size:0.8rem;">
              © 2026 Bilimly.kg · Бишкек, Кыргызстан
            </div>
          </div>
        `
      }).catch(console.error);
    }
    
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
      WHERE u.role = 'tutor'
        AND COALESCE(tp.approval_status, 'pending') = 'pending'
      ORDER BY tp.updated_at DESC NULLS LAST, u.created_at DESC
      
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
// ═══════════════════════════════════════════════════════════
// LEADS — ad-captured parent leads
// ═══════════════════════════════════════════════════════════

// GET /api/admin/leads — list leads with filters + stats
router.get('/leads', async (req, res) => {
  const { status, urgency, limit = 100, page = 1 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const params = [];
  const where = [];
  if (status) { params.push(status); where.push(`l.status = $${params.length}`); }
  if (urgency) { params.push(urgency); where.push(`l.urgency = $${params.length}`); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  try {
    // Main list — include matched tutor names for quick display
    params.push(parseInt(limit), offset);
    const list = await pool.query(
      `SELECT l.id, l.phone, l.grade_band, l.subject, l.urgency, l.status,
              l.source, l.notes, l.matched_tutor_ids,
              l.contacted_at, l.converted_at, l.created_at,
              (
                SELECT json_agg(json_build_object(
                  'id', tp.id,
                  'name', u.first_name || ' ' || u.last_name,
                  'hourly_rate', tp.hourly_rate
                ))
                FROM tutor_profiles tp
                JOIN users u ON u.id = tp.user_id
                WHERE tp.id = ANY(l.matched_tutor_ids)
              ) AS matched_tutors
         FROM leads l
         ${whereClause}
         ORDER BY
           CASE l.status WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 ELSE 2 END,
           CASE l.urgency WHEN 'this_week' THEN 0 WHEN 'this_month' THEN 1 ELSE 2 END,
           l.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Counts for the UI status badges
    const counts = await pool.query(
      `SELECT status, COUNT(*)::int AS c FROM leads GROUP BY status`
    );
    const byStatus = { new: 0, contacted: 0, converted: 0, dead: 0 };
    counts.rows.forEach(r => { byStatus[r.status] = r.c; });

    const urgencyCounts = await pool.query(
      `SELECT urgency, COUNT(*)::int AS c FROM leads
       WHERE status IN ('new','contacted') GROUP BY urgency`
    );
    const byUrgency = { this_week: 0, this_month: 0, exploring: 0 };
    urgencyCounts.rows.forEach(r => { byUrgency[r.urgency] = r.c; });

    res.json({
      leads: list.rows,
      total: list.rows.length,
      counts: { by_status: byStatus, by_urgency: byUrgency },
    });
  } catch (err) {
    console.error('[ADMIN/LEADS] list error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// PATCH /api/admin/leads/:id — update status and/or notes
router.patch('/leads/:id', async (req, res) => {
  const { status, notes } = req.body;
  const allowedStatuses = ['new', 'contacted', 'converted', 'dead'];

  if (status && !allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const updates = [];
  const values = [];
  let idx = 1;

  if (status) {
    updates.push(`status = $${idx++}`);
    values.push(status);
    if (status === 'contacted') {
      updates.push(`contacted_at = COALESCE(contacted_at, NOW())`);
    }
    if (status === 'converted') {
      updates.push(`converted_at = NOW()`);
      updates.push(`contacted_at = COALESCE(contacted_at, NOW())`);
    }
  }
  if (notes !== undefined) {
    updates.push(`notes = $${idx++}`);
    values.push(notes);
  }
  if (!updates.length) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.push(`updated_at = NOW()`);
  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE leads SET ${updates.join(', ')}
         WHERE id = $${idx}
         RETURNING *`,
      values
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Lead not found' });
    res.json({ lead: result.rows[0] });
  } catch (err) {
    console.error('[ADMIN/LEADS] update error:', err);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});
