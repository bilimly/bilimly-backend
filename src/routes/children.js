const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { auth } = require('../middleware/auth');

const router = express.Router();

const GRADE_BANDS = ['primary', 'middle', 'high', 'ort_university'];

// GET /api/children — list all children for the authenticated parent
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, grade_band, grade_number, school, notes, avatar_url, is_active,
              created_at, updated_at
       FROM children
       WHERE parent_user_id = $1 AND is_active = TRUE
       ORDER BY created_at ASC`,
      [req.user.id]
    );
    res.json({ children: result.rows });
  } catch (err) {
    console.error('Children list error:', err);
    res.status(500).json({ error: 'Не удалось загрузить детей' });
  }
});

// POST /api/children — add a new child
router.post('/', auth, [
  body('name').trim().isLength({ min: 1, max: 100 }),
  body('grade_band').optional({ nullable: true }).isIn(GRADE_BANDS),
  body('grade_number').optional({ nullable: true }).isInt({ min: 1, max: 12 }),
  body('school').optional({ nullable: true }).isString().isLength({ max: 200 }),
  body('notes').optional({ nullable: true }).isString(),
  body('avatar_url').optional({ nullable: true }).isString(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name, grade_band, grade_number, school, notes, avatar_url } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO children (parent_user_id, name, grade_band, grade_number, school, notes, avatar_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, grade_band, grade_number, school, notes, avatar_url, is_active, created_at`,
      [req.user.id, name, grade_band || null, grade_number || null, school || null, notes || null, avatar_url || null]
    );
    res.status(201).json({ child: result.rows[0] });
  } catch (err) {
    console.error('Children create error:', err);
    res.status(500).json({ error: 'Не удалось добавить ребёнка' });
  }
});

// PUT /api/children/:id — update a child (only if they belong to this parent)
router.put('/:id', auth, [
  body('name').optional().trim().isLength({ min: 1, max: 100 }),
  body('grade_band').optional({ nullable: true }).isIn([...GRADE_BANDS, null]),
  body('grade_number').optional({ nullable: true }).isInt({ min: 1, max: 12 }),
  body('school').optional({ nullable: true }).isString().isLength({ max: 200 }),
  body('notes').optional({ nullable: true }).isString(),
  body('avatar_url').optional({ nullable: true }).isString(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const owned = await pool.query(
    `SELECT id FROM children WHERE id = $1 AND parent_user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!owned.rows[0]) return res.status(404).json({ error: 'Ребёнок не найден' });

  const allowed = ['name', 'grade_band', 'grade_number', 'school', 'notes', 'avatar_url'];
  const fields = [];
  const values = [];
  let idx = 1;
  for (const key of allowed) {
    if (key in req.body) {
      fields.push(`${key} = $${idx++}`);
      values.push(req.body[key] === '' ? null : req.body[key]);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'Нет данных для обновления' });
  fields.push('updated_at = NOW()');
  values.push(req.params.id, req.user.id);

  try {
    const result = await pool.query(
      `UPDATE children SET ${fields.join(', ')}
       WHERE id = $${idx++} AND parent_user_id = $${idx}
       RETURNING id, name, grade_band, grade_number, school, notes, avatar_url, is_active, created_at, updated_at`,
      values
    );
    res.json({ child: result.rows[0] });
  } catch (err) {
    console.error('Children update error:', err);
    res.status(500).json({ error: 'Не удалось обновить данные ребёнка' });
  }
});

// DELETE /api/children/:id — soft delete
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE children SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND parent_user_id = $2
       RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ребёнок не найден' });
    res.json({ success: true });
  } catch (err) {
    console.error('Children delete error:', err);
    res.status(500).json({ error: 'Не удалось удалить ребёнка' });
  }
});

module.exports = router;