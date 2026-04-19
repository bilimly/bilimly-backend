const express = require('express');
const pool = require('../config/database');
const { auth, requireRole } = require('../middleware/auth');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
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

// PUT /api/admin/bookings/:id/confirm
// Admin marks payment received → does ALL the downstream work:
//   1. Update booking status -> confirmed
//   2. Mark payment completed (manual confirmation)
//   3. Create video room (Jitsi/Daily.co) with room URL
//   4. Email both parent and tutor with confirmation + video link
//   5. Telegram ping both (if linked)
router.put('/bookings/:id/confirm', async (req, res) => {
  const bookingId = req.params.id;
  try {
    // 1. Update booking status
    await pool.query(
      `UPDATE bookings SET status='confirmed', updated_at=NOW() WHERE id=$1`,
      [bookingId]
    );

    // 2. Mark payment completed (manual confirmation)
    await pool.query(
      `UPDATE payments
         SET status='completed',
             paid_at = COALESCE(paid_at, NOW()),
             mbank_transaction_id = COALESCE(mbank_transaction_id, $1)
       WHERE booking_id=$2 AND status != 'completed'`,
      [`MANUAL_${Date.now()}`, bookingId]
    );

    // Fetch full booking + user details for downstream actions
    const fullBooking = await pool.query(
      `SELECT b.*,
              s.email AS student_email, s.first_name AS student_first, s.last_name AS student_last,
              s.phone AS student_phone, s.telegram_chat_id AS student_telegram,
              u_t.email AS tutor_email, u_t.first_name AS tutor_first, u_t.last_name AS tutor_last,
              u_t.phone AS tutor_phone, u_t.telegram_chat_id AS tutor_telegram
         FROM bookings b
         JOIN users s ON b.student_id = s.id
         JOIN tutor_profiles tp ON b.tutor_id = tp.id
         JOIN users u_t ON tp.user_id = u_t.id
        WHERE b.id = $1`,
      [bookingId]
    );
    const b = fullBooking.rows[0];
    if (!b) return res.json({ message: 'Confirmed (booking details not found for downstream)' });

    // 3. Create video room
    let videoRoomUrl = b.meeting_url;
    if (!videoRoomUrl) {
      try {
        const { createLessonRoom } = require('../services/videoService');
        const room = await createLessonRoom(bookingId, b.duration_minutes || 60);
        videoRoomUrl = room.room_url;
      } catch (e) {
        console.error('[ADMIN/CONFIRM] video room creation failed:', e);
      }
    }

    // 4. Email both sides
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const tutorFullName = `${b.tutor_first} ${b.tutor_last || ''}`.trim();
      const studentFullName = `${b.student_first} ${b.student_last || ''}`.trim();
      const dateStr = new Date(b.lesson_date).toLocaleDateString('ru-RU');
      const videoBlock = videoRoomUrl
        ? `<a href="${videoRoomUrl}" style="background:#0ABAB5;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;display:inline-block;font-weight:bold;margin-top:12px">🎥 Войти в видео-комнату</a>`
        : '<p style="color:#666">Ссылка на видео-комнату придёт за 30 минут до урока.</p>';

      // Email to student
      if (b.student_email) {
        resend.emails.send({
          from: `Bilimly.kg <${process.env.FROM_EMAIL}>`,
          to: b.student_email,
          subject: '✅ Оплата подтверждена — урок забронирован',
          html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto"><div style="background:#0ABAB5;padding:24px;text-align:center"><h1 style="color:white;margin:0;font-size:1.4rem">Bilimly.kg</h1></div><div style="padding:28px;background:#f9fafb"><h2 style="color:#0a0a0a">Оплата подтверждена! 🎉</h2><p>Здравствуйте, <strong>${b.student_first}</strong>! Ваша оплата получена.</p><div style="background:white;border-radius:10px;padding:18px;margin:16px 0;border:1px solid #e5e7eb"><p><strong>👨‍🏫 Репетитор:</strong> ${tutorFullName}</p><p><strong>📚 Предмет:</strong> ${b.subject || 'Урок'}</p><p><strong>📅 Дата:</strong> ${dateStr}</p><p><strong>🕐 Время:</strong> ${b.start_time}</p><p><strong>💰 Сумма:</strong> ${b.amount} сом</p></div>${videoBlock}</div></div>`,
        }).catch((e) => console.error('[ADMIN/CONFIRM] student email failed:', e));
      }

      // Email to tutor
      if (b.tutor_email) {
        resend.emails.send({
          from: `Bilimly.kg <${process.env.FROM_EMAIL}>`,
          to: b.tutor_email,
          subject: '✅ Урок подтверждён — оплата получена',
          html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto"><div style="background:#0ABAB5;padding:24px;text-align:center"><h1 style="color:white;margin:0;font-size:1.4rem">Bilimly.kg</h1></div><div style="padding:28px;background:#f9fafb"><h2 style="color:#0a0a0a">Урок подтверждён! 🎉</h2><p>Здравствуйте, <strong>${b.tutor_first}</strong>! Студент оплатил урок.</p><div style="background:white;border-radius:10px;padding:18px;margin:16px 0;border:1px solid #e5e7eb"><p><strong>👤 Студент:</strong> ${studentFullName}</p><p><strong>📚 Предмет:</strong> ${b.subject || 'Урок'}</p><p><strong>📅 Дата:</strong> ${dateStr}</p><p><strong>🕐 Время:</strong> ${b.start_time}</p><p><strong>💰 Сумма:</strong> ${b.amount} сом</p></div>${videoBlock}<p style="font-size:0.85rem;color:#666;margin-top:16px">Не забудьте подключиться за 5 минут до начала.</p></div></div>`,
        }).catch((e) => console.error('[ADMIN/CONFIRM] tutor email failed:', e));
      }
    } catch (e) { console.error('[ADMIN/CONFIRM] email block failed:', e); }

    // 5. Telegram pings (if linked)
    try {
      const { sendMessage } = require('../services/telegramService');
      const dateStr = new Date(b.lesson_date).toLocaleDateString('ru-RU');
      const tgVideoLine = videoRoomUrl ? `\n🎥 <a href="${videoRoomUrl}">Войти в видео-комнату</a>` : '';

      if (b.student_telegram) {
        sendMessage(b.student_telegram,
          `✅ <b>Оплата подтверждена!</b>\n\nУрок с <b>${b.tutor_first} ${b.tutor_last || ''}</b>\n📅 ${dateStr} в ${b.start_time}${tgVideoLine}`
        ).catch(() => {});
      }
      if (b.tutor_telegram) {
        sendMessage(b.tutor_telegram,
          `✅ <b>Урок подтверждён!</b>\n\nСтудент <b>${b.student_first} ${b.student_last || ''}</b> оплатил.\n📅 ${dateStr} в ${b.start_time}${tgVideoLine}`
        ).catch(() => {});
      }
    } catch (e) { console.error('[ADMIN/CONFIRM] telegram block failed:', e); }

    res.json({
      message: 'Confirmed — payment marked, video room created, notifications sent',
      booking_id: bookingId,
      video_room_url: videoRoomUrl,
    });
  } catch(err) {
    console.error('[ADMIN/CONFIRM] error:', err);
    res.status(500).json({ error: err.message });
  }
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

// ═══════════════════════════════════════════════════════════
// ADMIN TUTOR ONBOARDING
// Admin creates tutor profile on their behalf, generates magic link.
// Tutor receives link via WhatsApp, clicks to set password and claim.
// ═══════════════════════════════════════════════════════════

// Multer config — 60MB max, memory storage (we stream to Cloudinary)
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 }, // 60 MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('video/')) {
      return cb(new Error('Only video files allowed'));
    }
    cb(null, true);
  },
});

// POST /api/admin/tutors/onboard
// Multipart: fields + optional 'video' file
// Fields: first_name, last_name, phone, email, subjects (JSON array), hourly_rate, trial_rate, bio_ru, city, video_url (optional)
router.post('/tutors/onboard',
  // We add multer ONLY for this one route to avoid interfering with JSON body parsing on other admin routes.
  (req, res, next) => {
    videoUpload.single('video')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Видео слишком большое (макс 60 МБ). Попросите репетитора переотправить в сжатом виде.' });
        }
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    const {
      first_name,
      last_name,
      phone,
      email,
      subjects, // may arrive as JSON string or array
      hourly_rate,
      trial_rate,
      bio_ru,
      city,
      video_url,
    } = req.body;

    // Basic validation
    if (!first_name || !last_name || !phone) {
      return res.status(400).json({ error: 'first_name, last_name, phone обязательны' });
    }

    // Parse subjects if arrived as string
    let subjectsArr = [];
    if (typeof subjects === 'string') {
      try { subjectsArr = JSON.parse(subjects); } catch (e) { subjectsArr = [subjects]; }
    } else if (Array.isArray(subjects)) {
      subjectsArr = subjects;
    }

    // Generate email if not provided — some WhatsApp tutors won't have one
    let finalEmail = (email || '').trim().toLowerCase();
    if (!finalEmail) {
      const cleanPhone = String(phone).replace(/[^0-9]/g, '');
      finalEmail = `tutor_${cleanPhone}@bilimly.kg`;
    }

    try {
      // Check for duplicate email
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [finalEmail]);
      if (existing.rows[0]) {
        return res.status(400).json({ error: 'Пользователь с таким email уже существует' });
      }

      // Generate claim token (7 day expiry)
      const claimToken = crypto.randomBytes(32).toString('hex');
      const claimExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      // Random strong password — tutor replaces on claim
      const tempPassword = crypto.randomBytes(24).toString('base64');
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      // Create user
      const userResult = await pool.query(
        `INSERT INTO users
           (email, password_hash, first_name, last_name, phone, role, is_verified,
            claim_token, claim_expires_at, created_by_admin_id)
         VALUES ($1, $2, $3, $4, $5, 'tutor', false, $6, $7, $8)
         RETURNING id, email, first_name, last_name`,
        [finalEmail, passwordHash, first_name, last_name, phone, claimToken, claimExpiresAt, req.user.id]
      );
      const user = userResult.rows[0];

      // Handle video: Cloudinary upload OR URL
      let videoIntroUrl = null;
      if (req.file) {
        try {
          const { uploadVideo } = require('../services/cloudinaryService');
          const result = await uploadVideo(
            req.file.buffer,
            'bilimly/tutor-videos',
            `tutor_${user.id}`
          );
          videoIntroUrl = result.url;
        } catch (uploadErr) {
          console.error('[ADMIN/ONBOARD] Cloudinary upload failed:', uploadErr);
          // Roll back user creation
          await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
          return res.status(500).json({ error: 'Ошибка загрузки видео: ' + (uploadErr.message || 'unknown') });
        }
      } else if (video_url) {
        videoIntroUrl = video_url.trim();
      }

      // Create tutor profile (pending approval so it shows in existing queue)
      await pool.query(
        `INSERT INTO tutor_profiles
           (user_id, bio_ru, subjects, hourly_rate, trial_rate, city,
            video_intro_url, is_approved, approval_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false, 'pending')`,
        [
          user.id,
          bio_ru || '',
          subjectsArr,
          parseFloat(hourly_rate) || 500,
          parseFloat(trial_rate) || 200,
          city || 'Бишкек',
          videoIntroUrl,
        ]
      );

      // Build the magic link (frontend will handle it)
      const claimLink = `https://www.bilimly.kg/tutor-claim.html?token=${claimToken}`;

      // Pre-filled WhatsApp message the admin copy-pastes
      const whatsappMessage = `Привет, ${first_name}! 👋\n\nТвой профиль создан на Bilimly.kg. Нажми эту ссылку чтобы установить пароль и активировать аккаунт:\n\n${claimLink}\n\nССылка действует 7 дней. После активации ты сможешь получать студентов.`;

      // Admin Telegram notification
      try {
        const { notifyAdminNewTutorApplication } = require('../services/telegramService');
        notifyAdminNewTutorApplication({
          full_name: `${first_name} ${last_name}`,
          email: finalEmail,
          phone,
          subjects: subjectsArr,
          hourly_rate: parseFloat(hourly_rate) || 500,
          experience_years: 0,
        }).catch((e) => console.error('[ADMIN/ONBOARD] Telegram notify failed:', e));
      } catch (e) { /* swallow */ }

      res.status(201).json({
        success: true,
        tutor: {
          user_id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          phone,
        },
        claim_link: claimLink,
        whatsapp_message: whatsappMessage,
        whatsapp_url: `https://wa.me/${phone.replace(/[^0-9]/g, '')}?text=${encodeURIComponent(whatsappMessage)}`,
      });
    } catch (err) {
      console.error('[ADMIN/ONBOARD] Error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE /api/admin/users/:id — hard delete a user (cascades to profile, packages, etc; SET NULL on bookings/payments/reviews)
// Use sparingly — for testing or actual account removal at user request.
router.delete('/users/:id', async (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Нельзя удалить собственный аккаунт' });
  }
  try {
    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING id, email',
      [targetId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('[ADMIN/DELETE-USER] error:', err);
    res.status(500).json({ error: err.message });
  }
});

