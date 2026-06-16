// ═══════════════════════════════════════════════════════════
// Bilimpark commission engine
// Sliding tier based on tutor's cumulative completed lessons
// ═══════════════════════════════════════════════════════════

const COMMISSION_TIERS = [
  { min_lessons: 1001, commission_percent: 20 },
  { min_lessons: 501,  commission_percent: 25 },
  { min_lessons: 251,  commission_percent: 30 },
  { min_lessons: 101,  commission_percent: 35 },
  { min_lessons: 0,    commission_percent: 40 },
];

function tierForLessons(totalLessons) {
  const l = parseInt(totalLessons) || 0;
  for (let i = 0; i < COMMISSION_TIERS.length; i++) {
    const tier = COMMISSION_TIERS[i];
    if (l >= tier.min_lessons) {
      const nextUp = COMMISSION_TIERS[i - 1] || null;
      return {
        commission_percent: tier.commission_percent,
        min_lessons: tier.min_lessons,
        next_tier_lessons: nextUp ? nextUp.min_lessons : null,
        next_tier_commission: nextUp ? nextUp.commission_percent : null,
        lessons_to_next: nextUp ? (nextUp.min_lessons - l) : null,
      };
    }
  }
  return {
    commission_percent: 40,
    min_lessons: 0,
    next_tier_lessons: 101,
    next_tier_commission: 35,
    lessons_to_next: 101,
  };
}

function computeSplit(grossAmount, totalLessons, locked18pct = false) {
  const gross = parseFloat(grossAmount) || 0;
  const lessons = parseInt(totalLessons) || 0;
  let commissionPercent;
  if (locked18pct) {
    commissionPercent = 18;
  } else {
    commissionPercent = tierForLessons(lessons).commission_percent;
  }
  const commissionAmount = Math.round(gross * commissionPercent) / 100;
  const netAmount = Math.round((gross - commissionAmount) * 100) / 100;
  return {
    gross_amount: gross,
    commission_percent: commissionPercent,
    commission_amount: commissionAmount,
    net_amount: netAmount,
    tier_lessons_at_time: lessons,
  };
}

async function recordLessonEarnings(pool, booking) {
  if (!booking || !booking.id || !booking.tutor_id) {
    throw new Error('recordLessonEarnings: booking.id and booking.tutor_id required');
  }

  const existing = await pool.query(
    `SELECT * FROM tutor_earnings WHERE booking_id = $1 LIMIT 1`,
    [booking.id]
  );
  if (existing.rows[0]) return existing.rows[0];

  const tutor = await pool.query(
    `SELECT total_lessons, COALESCE(commission_locked_18pct, FALSE) AS locked18pct
       FROM tutor_profiles WHERE id = $1`,
    [booking.tutor_id]
  );
  const currentLessons = tutor.rows[0]?.total_lessons || 0;
  const locked18pct = tutor.rows[0]?.locked18pct === true;

  const split = computeSplit(booking.amount, currentLessons, locked18pct);

  const insert = await pool.query(
    `INSERT INTO tutor_earnings
       (tutor_id, booking_id, gross_amount, commission_percent, commission_amount,
        net_amount, tier_hours_at_time, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
     RETURNING *`,
    [
      booking.tutor_id,
      booking.id,
      split.gross_amount,
      split.commission_percent,
      split.commission_amount,
      split.net_amount,
      currentLessons,
      `Auto-recorded on lesson completion`,
    ]
  );

  const durationHours = (booking.duration_minutes || 60) / 60;
  await pool.query(
    `UPDATE tutor_profiles
       SET total_paid_hours = COALESCE(total_paid_hours, 0) + $1,
           lifetime_earnings_gross = COALESCE(lifetime_earnings_gross, 0) + $2,
           lifetime_earnings_net = COALESCE(lifetime_earnings_net, 0) + $3,
           updated_at = NOW()
     WHERE id = $4`,
    [durationHours, split.gross_amount, split.net_amount, booking.tutor_id]
  );

  return insert.rows[0];
}

async function releaseEarnings(pool, earningsId) {
  const result = await pool.query(
    `UPDATE tutor_earnings
       SET status = 'released', released_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [earningsId]
  );
  const earnings = result.rows[0];
  if (!earnings) return null;

  await pool.query(
    `UPDATE tutor_profiles
       SET wallet_balance = COALESCE(wallet_balance, 0) + $1,
           updated_at = NOW()
     WHERE id = $2`,
    [earnings.net_amount, earnings.tutor_id]
  );
  return earnings;
}

module.exports = {
  COMMISSION_TIERS,
  tierForLessons,
  computeSplit,
  recordLessonEarnings,
  releaseEarnings,
};
