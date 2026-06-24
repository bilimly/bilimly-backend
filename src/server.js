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
    'https://bilimpark.kg',
    'https://www.bilimpark.kg'
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
app.use('/api/auth', require('./routes/auth'));
app.use('/api/tutors', require('./routes/tutors'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/packages', require('./routes/packages'));
app.use('/api/earnings', require('./routes/earnings'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/support', require('./routes/support'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/manager', require('./routes/manager'));
app.use('/api/children', require('./routes/children'));
app.use('/api/subjects', require('./routes/subjects'));
app.use('/api/telegram', require('./routes/telegram'));

// ── HEALTH CHECK ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    name: 'Bilimpark API',
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
  ║   🎓 BILIMPARK API RUNNING         ║
  ║   Port: ${PORT}                     ║
  ║   Env:  ${process.env.NODE_ENV || 'development'}               ║
  ╚══════════════════════════════════╝
  `);

  // Start background jobs
  const { startReminderJob } = require('./utils/reminderJob');
  const { scheduleRoomCreation } = require('./services/videoService');
  startReminderJob();
  scheduleRoomCreation();
});

module.exports = app;
