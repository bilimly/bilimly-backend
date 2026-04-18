// ═══════════════════════════════════════════════════════════
// Bilimly commission engine
// Sliding tier based on tutor's cumulative paid hours on platform
// ═══════════════════════════════════════════════════════════

// Tiers (hours_at_or_above → commission_percent)
// New tutors start at 30%. Reduces as they accumulate paid hours.
// Final tier at 500+ hours matches Preply's floor (~18%).
const COMMISSION_TIERS = [
  { min_hours: 500, commission_percent: 18 },
  { min_hours: 100, commission_percent: 22 },
  { min_hours: 20,  commission_percent: 25 },
  { min_hours: 0,   commission_percent: 30 },
];

/**
 * Compute commission tier for a tutor at a given hours total.
 * @param {number} totalPaidHours
 * @returns {{ commission_percent: number, min_hours: number, next_tier_hours: number|null, hours_to_next: number|null }}
 */
function tierForHours(totalPaidHours) {
  const h = parseFloat(totalPaidHours) || 0;
  for (let i = 0; i < COMMISSION_TIERS.length; i++) {
    const tier = COMMISSION_TIERS[i];
    if (h >= tier.min_hours) {
      const nextUp = COMMISSION_TIERS[i - 1] || null; // tiers are sorted highest-to-lowest
      return {
        commission_percent: tier.commission_percent,
        min_hours: tier.min_hours,
        next_tier_hours: nextUp ? nextUp.min_hours : null,
        next_tier_commission: nextUp ? nextUp.commission_percent : null,
        hours_to_next: nextUp ? (nextUp.min_hours - h) : null,
      };
    }
  }
  // Fallback (shouldn't happen — 0-hour tier always matches)
  return {
    commission_percent: 30,
    min_hours: 0,
    next_tier_hours: 20,
    next_tier_commission: 25,
    hours_to_next: 20,
  };
}

/**
 * Given a gross lesson amount and tutor's current paid hours,
 * compute the commission split.
 * @param {number} grossAmount — what the student paid
 * @param {number} totalPaidHours — tutor's cumulative paid hours on Bilimly
 * @returns {{ gross_amount, commission_percent, commission_amount, net_amount, tier_hours_at_time }}
 */
function computeSplit(grossAmount, totalPaidHours) {
  const gross = parseFloat(grossAmount) || 0;
  const tier = tierForHours(totalPaidHours);
  const commissionAmount = Math.round(gross * tier.commission_percent) / 100;
  const netAmount = Math.round((gross - commissionAmount) * 100) / 100;
  return {
    gross_amount: gross,
    commission_percent: tier.commission_percent,
    commission_amount: commissionAmount,
    net_amount: netAmount,
    tier_hours_at_time: parseFloat(totalPaidHours) || 0,
  };
}

/**
 * Record an earnings ledger row for a completed booking.
 * Called from bookings route when a lesson is marked 'completed'.
 * Idempotent: if a row already exists for the booking_id, returns existing.
 *
 * @param {Pool} pool — pg pool instance
 * @param {object} booking — booking row with: id, tutor_id, amount, duration_minutes
 * @returns {Promise<object>} earnings row
 */
async function recordLessonEarnings(pool, booking) {
  if (!booking || !booking.id || !booking.tutor_id) {
    throw new Error('recordLessonEarnings: booking.id and booking.tutor_id required');
  }

  // Idempotency check — if we already have an earnings row for this booking, bail
  const existing = await pool.query(
    `SELECT * FROM tutor_earnings WHERE booking_id = $1 LIMIT 1`,
    [booking.id]
  );
  if (existing.rows[0]) return existing.rows[0];

  // Read tutor's current paid hours for tier calculation
  const tutor = await pool.query(
    `SELECT total_paid_hours FROM tutor_profiles WHERE id = $1`,
    [booking.tutor_id]
  );
  const currentHours = tutor.rows[0]?.total_paid_hours || 0;

  const split = computeSplit(booking.amount, currentHours);

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
      split.tier_hours_at_time,
      `Auto-recorded on lesson completion`,
    ]
  );

  // Also increment tutor's total_paid_hours by lesson duration (in hours).
  // Duration defaults to 60 min if not set.
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

/**
 * Mark an earnings row as 'released' — moves money to tutor wallet.
 * Typically called by admin after verifying the lesson happened and payment cleared.
 * @param {Pool} pool
 * @param {string} earningsId
 */
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

  // Credit tutor wallet
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
  tierForHours,
  computeSplit,
  recordLessonEarnings,
  releaseEarnings,
};