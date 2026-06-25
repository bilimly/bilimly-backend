const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const router = express.Router();

const BACKEND_URL = process.env.BACKEND_URL || 'https://bilimly-backend-0zbt.onrender.com';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.bilimpark.kg';

// Configure the Google strategy once (lazy, on first request)
function ensureStrategy() {
  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientID || !clientSecret) return false;

  const passport = require('passport');
  if (passport._strategy && passport._strategy('google')) return true;

  const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
  passport.use('google', new GoogleStrategy({
    clientID,
    clientSecret,
    callbackURL: `${BACKEND_URL}/api/auth/google/callback`,
    passReqToCallback: true,
  }, async (req, accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails[0].value;
      const first_name = profile.name?.givenName || '';
      const last_name = profile.name?.familyName || '';
      const avatar_url = profile.photos?.[0]?.value || null;

      // Role comes from the `state` param we set when starting the flow.
      // Only 'tutor' or 'student' allowed; default student.
      let requestedRole = 'student';
      try {
        const state = JSON.parse(Buffer.from(req.query.state || '', 'base64').toString());
        if (state.role === 'tutor') requestedRole = 'tutor';
      } catch (_) {}

      let user = await pool.query('SELECT * FROM users WHERE email=$1', [email]);

      if (!user.rows[0]) {
        // New user — create with the requested role
        const result = await pool.query(
          `INSERT INTO users (email, first_name, last_name, avatar_url, role, password_hash, is_verified)
           VALUES ($1,$2,$3,$4,$5,'google_oauth',true) RETURNING *`,
          [email, first_name, last_name, avatar_url, requestedRole]
        );
        user = result;

        // If they signed up as a tutor, create their tutor profile
        if (requestedRole === 'tutor') {
          const isFoundingPeriod = new Date() < new Date('2026-05-20T23:59:59');
          await pool.query(
            'INSERT INTO tutor_profiles (user_id, commission_locked_18pct) VALUES ($1, $2)',
            [user.rows[0].id, isFoundingPeriod]
          ).catch(e => console.error('[GOOGLE] tutor profile create failed:', e.message));
        }
      } else {
        // Existing user — just refresh avatar, keep their existing role
        await pool.query('UPDATE users SET avatar_url=$1 WHERE email=$2', [avatar_url, email]);
        user = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
      }
      return done(null, user.rows[0]);
    } catch (err) {
      return done(err);
    }
  }));
  return true;
}

// START: /api/auth/google?role=tutor  (or role=student, default student)
router.get('/', (req, res) => {
  if (!ensureStrategy()) {
    return res.status(500).json({ error: 'Google auth not configured' });
  }
  const passport = require('passport');
  // Encode the chosen role into `state` so it survives the round-trip to Google
  const role = req.query.role === 'tutor' ? 'tutor' : 'student';
  const state = Buffer.from(JSON.stringify({ role })).toString('base64');
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
    state,
  })(req, res);
});

// CALLBACK: Google redirects here
router.get('/callback', (req, res, next) => {
  if (!ensureStrategy()) {
    return res.redirect(`${FRONTEND_URL}?error=auth_not_configured`);
  }
  const passport = require('passport');
  passport.authenticate('google', { session: false, failureRedirect: `${FRONTEND_URL}?error=auth` },
    (err, user) => {
      if (err || !user) return res.redirect(`${FRONTEND_URL}?error=auth`);
      const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
      const userData = encodeURIComponent(JSON.stringify({
        id: user.id, email: user.email,
        first_name: user.first_name, last_name: user.last_name,
        role: user.role, avatar_url: user.avatar_url
      }));
      let path = '/student-dashboard.html';
      if (user.role === 'tutor') path = '/tutor-dashboard.html';
      else if (user.role === 'admin') path = '/admin.html';
      else if (user.role === 'manager') path = '/manager.html';
      res.redirect(`${FRONTEND_URL}${path}?token=${token}&user=${userData}`);
    }
  )(req, res, next);
});

module.exports = router;
