const jwt = require('jsonwebtoken');
const pool = require('../config/database');

const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query(
      'SELECT id, email, role, first_name, last_name, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!result.rows[0] || !result.rows[0].is_active) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
};

module.exports = { auth, requireRole };
