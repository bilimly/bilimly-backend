// Runs critical schema additions on every server boot.
// Safe because all statements use IF NOT EXISTS.
// Called from server.js after the pool is ready.
const pool = require('./database');

async function runBootMigrations() {
  try {
    // Add commission_locked_18pct column to tutor_profiles
    await pool.query(`
      ALTER TABLE tutor_profiles
        ADD COLUMN IF NOT EXISTS commission_locked_18pct BOOLEAN DEFAULT FALSE
    `);

    // Backfill: everyone whose user was created before 2026-05-20 gets founding rate
    // Only updates rows where the flag is still at its default FALSE
    const result = await pool.query(`
      UPDATE tutor_profiles tp
         SET commission_locked_18pct = TRUE
        FROM users u
       WHERE tp.user_id = u.id
         AND tp.commission_locked_18pct = FALSE
         AND u.created_at < '2026-05-20 23:59:59'
    `);

    if (result.rowCount > 0) {
      console.log(`[BOOT_MIGRATION] Backfilled ${result.rowCount} tutor(s) to 18% founding rate`);
    } else {
      console.log('[BOOT_MIGRATION] commission_locked_18pct column ready');
    }
  } catch (err) {
    console.error('[BOOT_MIGRATION] Failed:', err.message);
    // Don't crash server — log and continue
  }
}

module.exports = { runBootMigrations };
