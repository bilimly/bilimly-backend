require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// ── SECURITY ───────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:3000',
    'https://bilimly.kg',
    'https://www.bilimly.kg'
  ],
  credentials: true,
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', limiter);

// ── BODY PARSING ───────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── ROUTES ─────────────────────────────────────────────────
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/tutors', require('./src/routes/tutors'));
app.use('/api/bookings', require('./src/routes/bookings'));
app.use('/api/payments', require('./src/routes/payments'));
app.use('/api/packages', require('./src/routes/packages'));
app.use('/api/earnings', require('./src/routes/earnings'));
app.use('/api/messages', require('./src/routes/messages'));
app.use('/api/support', require('./src/routes/support'));
app.use('/api/admin', require('./src/routes/admin'));

// ── HEALTH CHECK ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    name: 'Bilimly API',
    version: '1.0.0',
    time: new Date().toISOString()
  });
});

// ── 404 ────────────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── ERROR HANDLER ──────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ── START ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║   🎓 BILIMLY API RUNNING         ║
  ║   Port: ${PORT}                     ║
  ║   Env:  ${process.env.NODE_ENV || 'development'}               ║
  ╚══════════════════════════════════╝
  `);

  // Start background jobs
  const { startReminderJob } = require('./src/utils/reminderJob');
  const { scheduleRoomCreation } = require('./src/services/videoService');
  startReminderJob();
  scheduleRoomCreation();
});

module.exports = app;
