const express = require('express');
const pool = require('../config/database');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    let query = 'SELECT * FROM subjects WHERE is_active = true';
    let params = [];
    if (search) {
      query += ' AND (name_ru ILIKE $1 OR name_en ILIKE $1)';
      params.push('%' + search + '%');
    }
    query += ' ORDER BY category, name_ru';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
