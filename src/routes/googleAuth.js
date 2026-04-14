const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const router = express.Router();

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.NODE_ENV === 'production' 
    ? 'https://bilimly-backend-0zbt.onrender.com/api/auth/google/callback'
    : 'http://localhost:3001/api/auth/google/callback'
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
      await pool.query(
        'UPDATE users SET avatar_url=$1, is_verified=true WHERE email=$2',
        [avatar_url, email]
      );
      user = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    }

    return done(null, user.rows[0]);
  } catch(err) {
    return done(err);
  }
}));

router.get('/google', passport.authenticate('google', { 
  scope: ['profile', 'email'],
  session: false 
}));

router.get('/google/callback', 
  passport.authenticate('google', { session: false, failureRedirect: 'https://bilimly.kg?error=auth' }),
  (req, res) => {
    const token = jwt.sign({ userId: req.user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const user = {
      id: req.user.id,
      email: req.user.email,
      first_name: req.user.first_name,
      last_name: req.user.last_name,
      role: req.user.role,
      avatar_url: req.user.avatar_url
    };
    const userData = encodeURIComponent(JSON.stringify(user));
    res.redirect(`https://bilimly.kg?token=${token}&user=${userData}`);
  }
);

module.exports = router;
