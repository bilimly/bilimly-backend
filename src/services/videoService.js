const axios = require('axios');
const pool = require('../config/database');

const DAILY_API = 'https://api.daily.co/v1';
const DAILY_HEADERS = {
  'Authorization': `Bearer ${process.env.DAILY_API_KEY}`,
  'Content-Type': 'application/json',
};

// ── CREATE VIDEO ROOM FOR LESSON ───────────────────────────
const createLessonRoom = async (bookingId, durationMinutes = 60) => {
  try {
    // If Daily.co API key configured — use real rooms
    if (process.env.DAILY_API_KEY) {
      const exp = Math.floor(Date.now() / 1000) + (durationMinutes + 30) * 60;
      const response = await axios.post(`${DAILY_API}/rooms`, {
        name: `bilimly-lesson-${bookingId}`,
        privacy: 'private',
        properties: {
          exp,
          max_participants: 2,
          enable_recording: 'cloud',
          enable_chat: true,
          enable_screenshare: true,
          start_video_off: false,
          start_audio_off: false,
          lang: 'ru',
          recordings_bucket: process.env.DAILY_S3_BUCKET || null,
        }
      }, { headers: DAILY_HEADERS });

      const roomUrl = response.data.url;

      // Generate tokens for student and tutor
      const [studentToken, tutorToken] = await Promise.all([
        createRoomToken(response.data.name, exp, false),
        createRoomToken(response.data.name, exp, true),
      ]);

      await pool.query(
        `UPDATE bookings SET
           meeting_url = $1,
           meeting_tutor_url = $2,
           updated_at = NOW()
         WHERE id = $3`,
        [
          `${roomUrl}?t=${studentToken}`,
          `${roomUrl}?t=${tutorToken}`,
          bookingId
        ]
      );

      return {
        room_url: roomUrl,
        student_url: `${roomUrl}?t=${studentToken}`,
        tutor_url: `${roomUrl}?t=${tutorToken}`,
        provider: 'daily.co',
      };
    }

    // DEMO MODE — use free Jitsi Meet (no account needed)
    const roomName = `bilimly-${bookingId}-${Date.now()}`;
    const meetingUrl = `https://meet.jit.si/${roomName}`;

    await pool.query(
      'UPDATE bookings SET meeting_url = $1, updated_at = NOW() WHERE id = $2',
      [meetingUrl, bookingId]
    );

    return {
      room_url: meetingUrl,
      student_url: meetingUrl,
      tutor_url: meetingUrl,
      provider: 'jitsi',
    };

  } catch (err) {
    console.error('Video room error:', err.message);
    // Fallback to Jitsi
    const meetingUrl = `https://meet.jit.si/bilimly-${bookingId}`;
    await pool.query(
      'UPDATE bookings SET meeting_url = $1 WHERE id = $2',
      [meetingUrl, bookingId]
    );
    return { room_url: meetingUrl, student_url: meetingUrl, tutor_url: meetingUrl, provider: 'jitsi' };
  }
};

// ── CREATE PARTICIPANT TOKEN ───────────────────────────────
const createRoomToken = async (roomName, exp, isTutor) => {
  try {
    const response = await axios.post(`${DAILY_API}/meeting-tokens`, {
      properties: {
        room_name: roomName,
        exp,
        is_owner: isTutor,
        start_video_off: false,
        start_audio_off: false,
      }
    }, { headers: DAILY_HEADERS });
    return response.data.token;
  } catch (err) {
    return null;
  }
};

// ── GET LESSON RECORDING ───────────────────────────────────
const getLessonRecording = async (bookingId) => {
  try {
    const booking = await pool.query(
      'SELECT meeting_url FROM bookings WHERE id = $1', [bookingId]
    );
    if (!booking.rows[0]?.meeting_url || !process.env.DAILY_API_KEY) return null;

    const roomName = `bilimly-lesson-${bookingId}`;
    const response = await axios.get(
      `${DAILY_API}/recordings?room_name=${roomName}`,
      { headers: DAILY_HEADERS }
    );
    return response.data.data || [];
  } catch (err) {
    return null;
  }
};

// ── AUTO-CREATE ROOM 1 HOUR BEFORE LESSON ─────────────────
const scheduleRoomCreation = async () => {
  const { Pool } = require('pg');
  const cron = require('node-cron');

  cron.schedule('*/15 * * * *', async () => {
    try {
      const result = await pool.query(`
        SELECT id, duration_minutes FROM bookings
        WHERE status = 'confirmed'
          AND meeting_url IS NULL
          AND (lesson_date + start_time::interval)
              BETWEEN NOW() + INTERVAL '45 minutes'
              AND NOW() + INTERVAL '75 minutes'
      `);

      for (const booking of result.rows) {
        await createLessonRoom(booking.id, booking.duration_minutes || 60);
        console.log(`🎥 Video room created for booking ${booking.id}`);
      }
    } catch (err) {
      console.error('Room scheduling error:', err);
    }
  });
};

module.exports = { createLessonRoom, getLessonRecording, scheduleRoomCreation };
