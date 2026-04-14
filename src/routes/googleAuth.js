const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const router = express.Router();

router.get('/', (req, res) => {
  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  
  if (!clientID) return res.status(500).json({ error: 'Google auth not configured' });
  
  const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
  const passport = require('passport');
  
  passport.use('google', new GoogleStrategy({
    clientID,
    clientSecret,
    callbackURL: 'https://bilimly-backend-0zbt.onrender.com/api/auth/google/callback'
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails[0].value;
      const first_name = profile.name.givenName;
      const last_name = profile.name.familyName;
      const avatar_url = profile.photos[0]?.value;
      let user = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
      if (!user.rows[0]) {
        const result = await pool.query(
          `INSERT INTO users (email, first_name, last_name, avatar_url, role, password_hash, is_verified)
           VALUES ($1,$2,$3,$4,'student','google_oauth',true) RETURNING *`,
          [email, first_name, last_name, avatar_url]
        );
        user = result;
      } else {
        await pool.query('UPDATE users SET avatar_url=$1 WHERE email=$2', [avatar_url, email]);
        user = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
      }
      return done(null, user.rows[0]);
    } catch(err) {
      return done(err);
    }
  }));

  passport.authenticate('google', { scope: ['profile', 'email'], session: false })(req, res);
});

router.get('/callback', (req, res, next) => {
  const passport = require('passport');
  passport.authenticate('google', { session: false, failureRedirect: 'https://bilimly.kg?error=auth' },
    (err, user) => {
      if (err || !user) return res.redirect('https://bilimly.kg?error=auth');
      const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
      const userData = encodeURIComponent(JSON.stringify({
        id: user.id, email: user.email,
        first_name: user.first_name, last_name: user.last_name,
        role: user.role, avatar_url: user.avatar_url
      }));
      res.redirect(`https://bilimly.kg?token=${token}&user=${userData}`);
    }
  )(req, res, next);
});

module.exports = router;