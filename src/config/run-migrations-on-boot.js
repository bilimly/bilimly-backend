const pool = require('./database');

async function runBootMigrations() {
  try {
    // ── EXISTING MIGRATIONS ────────────────────────────────
    await pool.query(`
      ALTER TABLE tutor_profiles
        ADD COLUMN IF NOT EXISTS commission_locked_18pct BOOLEAN DEFAULT FALSE
    `);
    await pool.query(`
      ALTER TABLE tutor_profiles
        ADD COLUMN IF NOT EXISTS is_visible BOOLEAN DEFAULT TRUE
    `);

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

    // ── MANAGER SYSTEM ─────────────────────────────────────
    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(50)
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS manager_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        permissions JSONB DEFAULT '{}',
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS manager_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        status VARCHAR(20) DEFAULT 'todo'
          CHECK (status IN ('todo','in_progress','done','cancelled')),
        priority VARCHAR(10) DEFAULT 'medium'
          CHECK (priority IN ('low','medium','high','urgent')),
        due_date TIMESTAMP,
        entity_type VARCHAR(30),
        entity_id UUID,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS manager_activity_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
        action VARCHAR(100) NOT NULL,
        entity_type VARCHAR(30),
        entity_id UUID,
        details JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Add assigned_to column to leads table
    await pool.query(`
      ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id) ON DELETE SET NULL
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_manager_tasks_assigned ON manager_tasks(assigned_to)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_manager_tasks_status ON manager_tasks(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_log_manager ON manager_activity_log(manager_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to)`);

    console.log('[BOOT_MIGRATION] Manager system tables ready');

  } catch (err) {
    console.error('[BOOT_MIGRATION] Failed:', err.message);
  }
}

module.exports = { runBootMigrations };

// New tutor profile fields
async function addTutorProfileFields() {
  const fields = [
    `ALTER TABLE tutor_profiles ADD COLUMN IF NOT EXISTS headline VARCHAR(200)`,
    `ALTER TABLE tutor_profiles ADD COLUMN IF NOT EXISTS highlights JSONB DEFAULT '[]'`,
    `ALTER TABLE tutor_profiles ADD COLUMN IF NOT EXISTS languages JSONB DEFAULT '[]'`,
    `ALTER TABLE tutor_profiles ADD COLUMN IF NOT EXISTS education JSONB DEFAULT '[]'`,
    `ALTER TABLE tutor_profiles ADD COLUMN IF NOT EXISTS city VARCHAR(100)`,
  ];
  for (const sql of fields) {
    await pool.query(sql).catch(e => console.error('[MIGRATION]', e.message));
  }
  console.log('[BOOT_MIGRATION] Tutor profile fields ready');
}

addTutorProfileFields();

// Freedom Pay payment columns
async function addFreedomPayColumns() {
  const sqls = [
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS fp_payment_id VARCHAR(100)`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS fp_redirect_url TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`,
  ];
  for (const sql of sqls) {
    await pool.query(sql).catch(e => console.error('[MIGRATION FP]', e.message));
  }
  console.log('[BOOT_MIGRATION] Freedom Pay columns ready');
}
addFreedomPayColumns();

// Fix payment_method constraint to allow freedompay
async function fixPaymentMethodConstraint() {
  try {
    await pool.query(`ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_method_check`);
    await pool.query(`ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check 
      CHECK (payment_method IN ('mbank_qr','freedompay','card','cash','transfer','other'))`);
    console.log('[BOOT_MIGRATION] payment_method constraint updated');
  } catch(e) {
    console.error('[MIGRATION] payment_method constraint:', e.message);
  }
}
fixPaymentMethodConstraint();
