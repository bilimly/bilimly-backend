const { Pool } = require('pg');
const cron = require('node-cron');
const { sendAdminDailySummary } = require('./telegramService');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function collectStatsAndSend() {
  try {
    const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startISO = startOfToday.toISOString();
    const dateLabel = today.toLocaleDateString('ru-RU', { timeZone: 'Asia/Bishkek' });

    const leadsRows = await q(
      `SELECT urgency, COUNT(*)::int AS c FROM leads WHERE created_at >= $1 GROUP BY urgency`,
      [startISO]
    );
    const leadsByUrgency = { this_week: 0, this_month: 0, exploring: 0 };
    let leadsToday = 0;
    for (const r of leadsRows) {
      leadsByUrgency[r.urgency] = r.c;
      leadsToday += r.c;
    }

    const uncontactedRows = await q(
      `SELECT COUNT(*)::int AS c FROM leads WHERE status = 'new'`
    );

    const bookingRows = await q(
      `SELECT COUNT(*)::int AS c, COALESCE(SUM(amount), 0)::int AS revenue
         FROM bookings WHERE created_at >= $1`,
      [startISO]
    );

    const newTutorAppRows = await q(
      `SELECT COUNT(*)::int AS c FROM tutor_applications WHERE created_at >= $1`,
      [startISO]
    );
    const pendingTutorAppRows = await q(
      `SELECT COUNT(*)::int AS c FROM tutor_applications WHERE status = 'pending'`
    );

    const activeTutorRows = await q(
      `SELECT COUNT(*)::int AS c FROM tutor_profiles WHERE is_approved = TRUE AND approval_status = 'approved'`
    );

    await sendAdminDailySummary({
      date: dateLabel,
      leads_today: leadsToday,
      leads_this_week: leadsByUrgency.this_week,
      leads_this_month: leadsByUrgency.this_month,
      leads_exploring: leadsByUrgency.exploring,
      bookings_today: bookingRows[0]?.c ?? 0,
      revenue_today: bookingRows[0]?.revenue ?? 0,
      new_tutor_apps: newTutorAppRows[0]?.c ?? 0,
      active_tutors: activeTutorRows[0]?.c ?? 0,
      uncontacted_leads: uncontactedRows[0]?.c ?? 0,
      pending_tutor_apps: pendingTutorAppRows[0]?.c ?? 0,
    });
  } catch (err) {
    console.error('[ADMIN_SUMMARY] Failed:', err);
  }
}

function startDailySummaryCron() {
  // 20:00 Bishkek time every day
  cron.schedule('0 20 * * *', collectStatsAndSend, { timezone: 'Asia/Bishkek' });
  console.log('[ADMIN_SUMMARY] Cron scheduled for 20:00 Asia/Bishkek');
}

module.exports = { startDailySummaryCron, collectStatsAndSend };