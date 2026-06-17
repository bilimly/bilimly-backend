const express = require('express');
const pool = require('../config/database');
const { auth, requireRole } = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const router = express.Router();

// ── PERMISSION CHECK MIDDLEWARE ────────────────────────────
const checkPermission = (permission) => async (req, res, next) => {
  if (req.user.role === 'admin') return next(); // admin bypasses all
  try {
    const result = await pool.query(
      `SELECT permissions FROM manager_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    const perms = result.rows[0]?.permissions || {};
    if (!perms[permission]) {
      return res.status(403).json({ error: `Access denied: missing permission '${permission}'` });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Permission check failed' });
  }
};

// All manager routes require auth + manager or admin role
router.use(auth, requireRole('manager', 'admin'));

// ── DASHBOARD STATS ────────────────────────────────────────
router.get('/stats', checkPermission('view_dashboard'), async (req, res) => {
  try {
    const [students, tutors, bookings, leads, pendingApps, tasks] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users WHERE role = $1', ['student']),
      pool.query('SELECT COUNT(*) FROM tutor_profiles WHERE is_approved = true'),
      pool.query("SELECT COUNT(*) FROM bookings WHERE status IN ('confirmed','completed')"),
      pool.query("SELECT COUNT(*) FROM leads WHERE status = 'new'"),
      pool.query("SELECT COUNT(*) FROM tutor_profiles WHERE approval_status = 'pending'"),
      req.user.role === 'manager'
        ? pool.query("SELECT COUNT(*) FROM manager_tasks WHERE assigned_to = $1 AND status != 'done'", [req.user.id])
        : pool.query("SELECT COUNT(*) FROM manager_tasks WHERE status != 'done'"),
    ]);

    res.json({
      students: parseInt(students.rows[0].count),
      approved_tutors: parseInt(tutors.rows[0].count),
      active_bookings: parseInt(bookings.rows[0].count),
      new_leads: parseInt(leads.rows[0].count),
      pending_applications: parseInt(pendingApps.rows[0].count),
      open_tasks: parseInt(tasks.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── LEADS ──────────────────────────────────────────────────
router.get('/leads', checkPermission('view_leads'), async (req, res) => {
  const { status, assigned_to, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  let conditions = [];
  let params = [];
  let i = 1;

  // Managers only see their assigned leads unless they have view_all_leads
  if (req.user.role === 'manager') {
    const perms = await pool.query('SELECT permissions FROM manager_profiles WHERE user_id = $1', [req.user.id]);
    const p = perms.rows[0]?.permissions || {};
    if (!p.view_all_leads) {
      conditions.push(`l.assigned_to = $${i++}`);
      params.push(req.user.id);
    }
  }

  if (status) { conditions.push(`l.status = $${i++}`); params.push(status); }
  if (assigned_to) { conditions.push(`l.assigned_to = $${i++}`); params.push(assigned_to); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const result = await pool.query(
      `SELECT l.*, 
              u.first_name as manager_first_name, 
              u.last_name as manager_last_name
       FROM leads l
       LEFT JOIN users u ON l.assigned_to = u.id
       ${where}
       ORDER BY l.created_at DESC
       LIMIT $${i} OFFSET $${i+1}`,
      [...params, limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

router.patch('/leads/:id', checkPermission('edit_leads'), async (req, res) => {
  const { status, notes, assigned_to } = req.body;
  try {
    const updates = [];
    const params = [];
    let i = 1;

    if (status) { updates.push(`status = $${i++}`); params.push(status); }
    if (notes !== undefined) { updates.push(`notes = $${i++}`); params.push(notes); }
    if (assigned_to !== undefined) { updates.push(`assigned_to = $${i++}`); params.push(assigned_to); }
    if (status === 'contacted') { updates.push(`contacted_at = NOW()`); }
    updates.push(`updated_at = NOW()`);

    params.push(req.params.id);
    await pool.query(
      `UPDATE leads SET ${updates.join(', ')} WHERE id = $${i}`,
      params
    );

    // Log activity
    await pool.query(
      `INSERT INTO manager_activity_log (manager_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, 'lead', $3, $4)`,
      [req.user.id, `updated_lead_${status || 'notes'}`, req.params.id, JSON.stringify({ status, notes })]
    );

    res.json({ message: 'Lead updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

// ── TUTORS ─────────────────────────────────────────────────
router.get('/tutors', checkPermission('view_tutors'), async (req, res) => {
  const { status, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  try {
    let condition = '';
    let params = [limit, offset];
    if (status === 'pending') condition = `AND tp.approval_status = 'pending'`;
    else if (status === 'approved') condition = `AND tp.is_approved = true`;
    else if (status === 'rejected') condition = `AND tp.approval_status = 'rejected'`;

    const result = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.created_at,
              tp.id as tutor_profile_id, tp.is_approved, tp.approval_status,
              tp.subjects, tp.hourly_rate, tp.rating, tp.total_lessons,
              tp.bio_ru, tp.city, tp.is_visible, tp.video_intro_url
       FROM users u
       JOIN tutor_profiles tp ON u.id = tp.user_id
       WHERE u.role = 'tutor' ${condition}
       ORDER BY u.created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tutors' });
  }
});

router.put('/tutors/:userId/approve', checkPermission('approve_tutors'), async (req, res) => {
  try {
    await pool.query(
      `UPDATE tutor_profiles SET is_approved=true, approval_status='approved' WHERE user_id=$1`,
      [req.params.userId]
    );

    // Send approval email
    const tutor = await pool.query('SELECT email, first_name FROM users WHERE id=$1', [req.params.userId]);
    if (tutor.rows[0]) {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      resend.emails.send({
        from: `Bilimpark.kg <${process.env.FROM_EMAIL}>`,
        to: tutor.rows[0].email,
        subject: '🎉 Ваш профиль одобрен на Bilimpark.kg!',
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><div style="background:#0ABAB5;padding:24px;text-align:center"><h1 style="color:white;margin:0">Bilimpark.kg</h1></div><div style="padding:32px"><h2>Поздравляем, ${tutor.rows[0].first_name}! 🎉</h2><p>Ваш профиль одобрен. Теперь студенты могут записываться к вам.</p><a href="https://bilimpark.kg/tutor-dashboard.html" style="background:#0ABAB5;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;display:inline-block;font-weight:bold;">Открыть кабинет →</a></div></div>`,
      }).catch(console.error);
    }

    await pool.query(
      `INSERT INTO manager_activity_log (manager_id, action, entity_type, entity_id, details)
       VALUES ($1, 'approved_tutor', 'tutor', $2, '{}')`,
      [req.user.id, req.params.userId]
    );

    res.json({ message: 'Tutor approved' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve tutor' });
  }
});

router.put('/tutors/:userId/reject', checkPermission('approve_tutors'), async (req, res) => {
  const { reason } = req.body;
  try {
    await pool.query(
      `UPDATE tutor_profiles SET is_approved=false, approval_status='rejected', approval_notes=$1 WHERE user_id=$2`,
      [reason || 'Не соответствует требованиям', req.params.userId]
    );
    await pool.query(
      `INSERT INTO manager_activity_log (manager_id, action, entity_type, entity_id, details)
       VALUES ($1, 'rejected_tutor', 'tutor', $2, $3)`,
      [req.user.id, req.params.userId, JSON.stringify({ reason })]
    );
    res.json({ message: 'Tutor rejected' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject tutor' });
  }
});

router.put('/tutors/:userId/toggle-visibility', checkPermission('edit_tutors'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE tutor_profiles SET is_visible = NOT COALESCE(is_visible, true) WHERE user_id=$1 RETURNING is_visible`,
      [req.params.userId]
    );
    res.json({ is_visible: result.rows[0].is_visible });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle visibility' });
  }
});

// ── STUDENTS ───────────────────────────────────────────────
router.get('/students', checkPermission('view_students'), async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, phone, is_active, created_at,
              (SELECT COUNT(*) FROM bookings WHERE student_id = users.id) as total_bookings
       FROM users WHERE role = 'student'
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// ── BOOKINGS ───────────────────────────────────────────────
router.get('/bookings', checkPermission('view_bookings'), async (req, res) => {
  const { status, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  try {
    let condition = status ? `WHERE b.status = '${status}'` : '';
    const result = await pool.query(
      `SELECT b.*, 
              us.first_name as student_first_name, us.last_name as student_last_name,
              ut.first_name as tutor_first_name, ut.last_name as tutor_last_name
       FROM bookings b
       JOIN users us ON b.student_id = us.id
       JOIN tutor_profiles tp ON b.tutor_id = tp.id
       JOIN users ut ON tp.user_id = ut.id
       ${condition}
       ORDER BY b.lesson_date DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// ── TASKS ──────────────────────────────────────────────────
router.get('/tasks', async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const result = await pool.query(
      `SELECT t.*, 
              u_assigned.first_name as assignee_first_name,
              u_assigned.last_name as assignee_last_name,
              u_created.first_name as creator_first_name,
              u_created.last_name as creator_last_name
       FROM manager_tasks t
       LEFT JOIN users u_assigned ON t.assigned_to = u_assigned.id
       LEFT JOIN users u_created ON t.created_by = u_created.id
       WHERE ${isAdmin ? '1=1' : 't.assigned_to = $1'}
       ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC`,
      isAdmin ? [] : [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

router.post('/tasks', async (req, res) => {
  const { title, description, assigned_to, due_date, priority, entity_type, entity_id } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  try {
    const result = await pool.query(
      `INSERT INTO manager_tasks 
         (title, description, assigned_to, created_by, due_date, priority, entity_type, entity_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [title, description, assigned_to, req.user.id, due_date, priority || 'medium', entity_type, entity_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create task' });
  }
});

router.patch('/tasks/:id', async (req, res) => {
  const { status, title, description, due_date, priority } = req.body;
  try {
    const updates = [];
    const params = [];
    let i = 1;
    if (status) { updates.push(`status = $${i++}`); params.push(status); }
    if (title) { updates.push(`title = $${i++}`); params.push(title); }
    if (description !== undefined) { updates.push(`description = $${i++}`); params.push(description); }
    if (due_date !== undefined) { updates.push(`due_date = $${i++}`); params.push(due_date); }
    if (priority) { updates.push(`priority = $${i++}`); params.push(priority); }
    if (status === 'done') { updates.push(`completed_at = NOW()`); }
    updates.push(`updated_at = NOW()`);
    params.push(req.params.id);
    await pool.query(`UPDATE manager_tasks SET ${updates.join(', ')} WHERE id = $${i}`, params);
    res.json({ message: 'Task updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update task' });
  }
});

router.delete('/tasks/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM manager_tasks WHERE id=$1', [req.params.id]);
    res.json({ message: 'Task deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// ── ACTIVITY LOG ───────────────────────────────────────────
router.get('/activity', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const result = await pool.query(
      `SELECT l.*, u.first_name, u.last_name, u.email
       FROM manager_activity_log l
       JOIN users u ON l.manager_id = u.id
       ORDER BY l.created_at DESC
       LIMIT 100`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch activity log' });
  }
});

// ── MY PROFILE ─────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.phone,
              mp.permissions, mp.notes as manager_notes
       FROM users u
       LEFT JOIN manager_profiles mp ON u.id = mp.user_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

module.exports = router;
