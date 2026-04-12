const express = require('express');
const pool = require('../config/database');
const { auth } = require('../middleware/auth');
const router = express.Router();

// ── CREATE MESSAGES TABLE (add to migrate.js) ──────────────
// CREATE TABLE IF NOT EXISTS messages (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   conversation_id UUID NOT NULL,
//   sender_id UUID REFERENCES users(id),
//   content TEXT NOT NULL,
//   message_type VARCHAR(20) DEFAULT 'text'
//     CHECK (message_type IN ('text','file','image','system')),
//   file_url TEXT,
//   is_read BOOLEAN DEFAULT FALSE,
//   created_at TIMESTAMP DEFAULT NOW()
// );
// CREATE TABLE IF NOT EXISTS conversations (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   student_id UUID REFERENCES users(id),
//   tutor_id UUID REFERENCES users(id),
//   last_message TEXT,
//   last_message_at TIMESTAMP,
//   student_unread INTEGER DEFAULT 0,
//   tutor_unread INTEGER DEFAULT 0,
//   created_at TIMESTAMP DEFAULT NOW()
// );

// ── GET MY CONVERSATIONS ───────────────────────────────────
router.get('/conversations', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*,
              us.first_name as student_first_name,
              us.last_name as student_last_name,
              us.avatar_url as student_avatar,
              ut.first_name as tutor_first_name,
              ut.last_name as tutor_last_name,
              ut.avatar_url as tutor_avatar,
              CASE
                WHEN $1 = c.student_id THEN c.student_unread
                ELSE c.tutor_unread
              END as my_unread
       FROM conversations c
       JOIN users us ON c.student_id = us.id
       JOIN users ut ON c.tutor_id = ut.id
       WHERE c.student_id=$1 OR c.tutor_id=$1
       ORDER BY c.last_message_at DESC NULLS LAST`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ── START OR GET CONVERSATION ──────────────────────────────
router.post('/conversations', auth, async (req, res) => {
  const { other_user_id } = req.body;

  try {
    // Determine who is student and who is tutor
    const otherUser = await pool.query('SELECT role FROM users WHERE id=$1', [other_user_id]);
    if (!otherUser.rows[0]) return res.status(404).json({ error: 'User not found' });

    const currentRole = req.user.role;
    const otherRole = otherUser.rows[0].role;

    let studentId, tutorId;
    if (currentRole === 'student') {
      studentId = req.user.id;
      tutorId = other_user_id;
    } else {
      studentId = other_user_id;
      tutorId = req.user.id;
    }

    // Check if conversation exists
    const existing = await pool.query(
      'SELECT * FROM conversations WHERE student_id=$1 AND tutor_id=$2',
      [studentId, tutorId]
    );

    if (existing.rows[0]) return res.json(existing.rows[0]);

    // Create new conversation
    const result = await pool.query(
      'INSERT INTO conversations (student_id, tutor_id) VALUES ($1,$2) RETURNING *',
      [studentId, tutorId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// ── GET MESSAGES IN CONVERSATION ──────────────────────────
router.get('/conversations/:id/messages', auth, async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  try {
    // Verify user is part of this conversation
    const conv = await pool.query(
      'SELECT * FROM conversations WHERE id=$1 AND (student_id=$2 OR tutor_id=$2)',
      [req.params.id, req.user.id]
    );
    if (!conv.rows[0]) return res.status(403).json({ error: 'Access denied' });

    const messages = await pool.query(
      `SELECT m.*,
              u.first_name as sender_first_name,
              u.last_name as sender_last_name,
              u.avatar_url as sender_avatar
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.conversation_id=$1
       ORDER BY m.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );

    // Mark as read
    const unreadField = req.user.id === conv.rows[0].student_id
      ? 'student_unread' : 'tutor_unread';
    await pool.query(
      `UPDATE conversations SET ${unreadField}=0 WHERE id=$1`,
      [req.params.id]
    );
    await pool.query(
      'UPDATE messages SET is_read=true WHERE conversation_id=$1 AND sender_id!=$2',
      [req.params.id, req.user.id]
    );

    res.json(messages.rows.reverse());
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ── SEND MESSAGE ───────────────────────────────────────────
router.post('/conversations/:id/messages', auth, async (req, res) => {
  const { content, message_type = 'text', file_url } = req.body;
  if (!content && !file_url) return res.status(400).json({ error: 'Content required' });

  try {
    // Verify access
    const conv = await pool.query(
      'SELECT * FROM conversations WHERE id=$1 AND (student_id=$2 OR tutor_id=$2)',
      [req.params.id, req.user.id]
    );
    if (!conv.rows[0]) return res.status(403).json({ error: 'Access denied' });

    // Insert message
    const msg = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, content, message_type, file_url)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, req.user.id, content, message_type, file_url || null]
    );

    // Update conversation
    const isStudent = req.user.id === conv.rows[0].student_id;
    await pool.query(
      `UPDATE conversations SET
         last_message=$1,
         last_message_at=NOW(),
         ${isStudent ? 'tutor_unread' : 'student_unread'} = 
         ${isStudent ? 'tutor_unread' : 'student_unread'} + 1
       WHERE id=$2`,
      [content?.substring(0, 100) || '📎 Файл', req.params.id]
    );

    // Send WhatsApp notification to recipient
    const recipientId = isStudent ? conv.rows[0].tutor_id : conv.rows[0].student_id;
    notifyRecipient(recipientId, req.user, content).catch(console.error);

    res.status(201).json(msg.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── NOTIFY RECIPIENT VIA WHATSAPP ──────────────────────────
const notifyRecipient = async (recipientId, sender, content) => {
  try {
    const result = await pool.query(
      'SELECT phone, first_name, language_preference FROM users WHERE id=$1',
      [recipientId]
    );
    const user = result.rows[0];
    if (!user?.phone) return;

    const messages = {
      ru: `💬 *Bilimly* — Новое сообщение!\n\nОт: ${sender.first_name}\n"${content?.substring(0,100)}"\n\nОткрой bilimly.kg чтобы ответить`,
      ky: `💬 *Bilimly* — Жаңы кат!\n\nКимден: ${sender.first_name}\n"${content?.substring(0,100)}"`,
      en: `💬 *Bilimly* — New message!\n\nFrom: ${sender.first_name}\n"${content?.substring(0,100)}"`,
    };

    const { sendMessage } = require('./whatsappService');
    await sendMessage(user.phone, messages[user.language_preference || 'ru']);
  } catch (err) {
    // Silent fail — notification not critical
  }
};

// ── GET UNREAD COUNT ───────────────────────────────────────
router.get('/unread', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT SUM(CASE WHEN student_id=$1 THEN student_unread ELSE tutor_unread END) as total
       FROM conversations
       WHERE student_id=$1 OR tutor_id=$1`,
      [req.user.id]
    );
    res.json({ unread: parseInt(result.rows[0]?.total || 0) });
  } catch (err) {
    res.status(500).json({ unread: 0 });
  }
});

module.exports = router;
