const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const migrate = async () => {
  const client = await pool.connect();
  try {
    console.log('🚀 Running Bilimly database migrations...');
    await client.query('BEGIN');

    // ── USERS ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL CHECK (role IN ('student', 'tutor', 'admin')),
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        phone VARCHAR(20),
        avatar_url TEXT,
        language_preference VARCHAR(5) DEFAULT 'ru' CHECK (language_preference IN ('ru', 'ky', 'en')),
        is_verified BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── TUTOR PROFILES ─────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tutor_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        bio_ru TEXT,
        bio_ky TEXT,
        bio_en TEXT,
        hourly_rate DECIMAL(10,2) NOT NULL DEFAULT 500,
        trial_rate DECIMAL(10,2) NOT NULL DEFAULT 200,
        currency VARCHAR(3) DEFAULT 'KGS',
        subjects TEXT[] DEFAULT '{}',
        languages TEXT[] DEFAULT '{}',
        country VARCHAR(100) DEFAULT 'Kyrgyzstan',
        city VARCHAR(100) DEFAULT 'Bishkek',
        timezone VARCHAR(50) DEFAULT 'Asia/Bishkek',
        video_intro_url TEXT,
        is_approved BOOLEAN DEFAULT FALSE,
        approval_status VARCHAR(20) DEFAULT 'pending'
          CHECK (approval_status IN ('pending', 'approved', 'rejected')),
        approval_notes TEXT,
        total_lessons INTEGER DEFAULT 0,
        total_students INTEGER DEFAULT 0,
        rating DECIMAL(3,2) DEFAULT 0,
        review_count INTEGER DEFAULT 0,
        is_featured BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── TUTOR AVAILABILITY ─────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tutor_availability (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tutor_id UUID REFERENCES tutor_profiles(id) ON DELETE CASCADE,
        day_of_week INTEGER CHECK (day_of_week BETWEEN 0 AND 6),
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        is_active BOOLEAN DEFAULT TRUE
      );
    `);

    // ── BOOKINGS ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID REFERENCES users(id) ON DELETE SET NULL,
        tutor_id UUID REFERENCES tutor_profiles(id) ON DELETE SET NULL,
        lesson_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        duration_minutes INTEGER DEFAULT 60,
        lesson_type VARCHAR(20) DEFAULT 'trial'
          CHECK (lesson_type IN ('trial', 'regular', 'package')),
        subject VARCHAR(100),
        status VARCHAR(20) DEFAULT 'pending'
          CHECK (status IN ('pending','confirmed','completed','cancelled','no_show')),
        amount DECIMAL(10,2) NOT NULL,
        currency VARCHAR(3) DEFAULT 'KGS',
        student_notes TEXT,
        tutor_notes TEXT,
        meeting_url TEXT,
        reminder_sent BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── PAYMENTS ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
        student_id UUID REFERENCES users(id) ON DELETE SET NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency VARCHAR(3) DEFAULT 'KGS',
        payment_method VARCHAR(30) DEFAULT 'mbank_qr'
          CHECK (payment_method IN ('mbank_qr','card','cash','transfer')),
        status VARCHAR(20) DEFAULT 'pending'
          CHECK (status IN ('pending','completed','failed','refunded')),
        mbank_transaction_id VARCHAR(255),
        mbank_qr_code TEXT,
        mbank_qr_url TEXT,
        paid_at TIMESTAMP,
        refunded_at TIMESTAMP,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── REVIEWS ────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_id UUID UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
        student_id UUID REFERENCES users(id) ON DELETE SET NULL,
        tutor_id UUID REFERENCES tutor_profiles(id) ON DELETE CASCADE,
        rating INTEGER CHECK (rating BETWEEN 1 AND 5),
        comment TEXT,
        is_published BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── MESSAGES (Support Chat) ────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        channel VARCHAR(20) DEFAULT 'website'
          CHECK (channel IN ('website','whatsapp','instagram')),
        direction VARCHAR(10) CHECK (direction IN ('inbound','outbound')),
        message TEXT NOT NULL,
        is_ai_response BOOLEAN DEFAULT FALSE,
        whatsapp_message_id VARCHAR(255),
        instagram_message_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── TUTOR APPLICATIONS ─────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tutor_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        full_name VARCHAR(200) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(20),
        subjects TEXT[],
        experience_years INTEGER,
        education TEXT,
        hourly_rate DECIMAL(10,2),
        about TEXT,
        document_url TEXT,
        ai_review_score INTEGER,
        ai_review_notes TEXT,
        status VARCHAR(20) DEFAULT 'pending'
          CHECK (status IN ('pending','ai_reviewed','approved','rejected')),
        admin_notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        reviewed_at TIMESTAMP
      );
    `);

    // ── NOTIFICATIONS ──────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        title_ru TEXT,
        title_ky TEXT,
        title_en TEXT,
        message_ru TEXT,
        message_ky TEXT,
        message_en TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── SUBJECTS (Master List) ─────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS subjects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name_ru VARCHAR(100) NOT NULL,
        name_ky VARCHAR(100),
        name_en VARCHAR(100),
        category VARCHAR(50),
        icon VARCHAR(10),
        is_active BOOLEAN DEFAULT TRUE
      );
    `);

    // ── LESSON PACKAGES ────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lesson_packages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID REFERENCES users(id) ON DELETE CASCADE,
        tutor_id UUID REFERENCES tutor_profiles(id) ON DELETE CASCADE,
        package_size INTEGER NOT NULL,
        lessons_total INTEGER NOT NULL,
        lessons_used INTEGER DEFAULT 0,
        lessons_remaining INTEGER NOT NULL,
        price_per_lesson DECIMAL(10,2) NOT NULL,
        discount_percent DECIMAL(5,2) DEFAULT 0,
        total_amount DECIMAL(10,2) NOT NULL,
        currency VARCHAR(3) DEFAULT 'KGS',
        status VARCHAR(20) DEFAULT 'active'
          CHECK (status IN ('pending_payment','active','completed','expired','refunded')),
        payment_id UUID,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── CONVERSATIONS ──────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID REFERENCES users(id) ON DELETE CASCADE,
        tutor_id UUID REFERENCES users(id) ON DELETE CASCADE,
        last_message TEXT,
        last_message_at TIMESTAMP,
        student_unread INTEGER DEFAULT 0,
        tutor_unread INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(student_id, tutor_id)
      );
    `);

    // ── MESSAGES ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
        content TEXT,
        message_type VARCHAR(20) DEFAULT 'text'
          CHECK (message_type IN ('text','file','image','system')),
        file_url TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Add video meeting columns to bookings
    await client.query(`
      ALTER TABLE bookings
        ADD COLUMN IF NOT EXISTS meeting_tutor_url TEXT;
    `);

    // ── LEADS (Ad Capture) ─────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(20) NOT NULL,
        grade_band VARCHAR(30) NOT NULL
          CHECK (grade_band IN ('primary','middle','high','ort_university')),
        subject VARCHAR(50) NOT NULL,
        urgency VARCHAR(20) NOT NULL
          CHECK (urgency IN ('this_week','this_month','exploring')),
        status VARCHAR(20) DEFAULT 'new'
          CHECK (status IN ('new','contacted','converted','dead')),
        source VARCHAR(50) DEFAULT 'lead_capture_page',
        matched_tutor_ids UUID[] DEFAULT '{}',
        notes TEXT,
        contacted_at TIMESTAMP,
        converted_at TIMESTAMP,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
// ── CHILDREN (sub-accounts for parent) ─────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS children (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        parent_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        grade_band VARCHAR(30)
          CHECK (grade_band IN ('primary','middle','high','ort_university')),
        grade_number INTEGER,
        school VARCHAR(200),
        notes TEXT,
        avatar_url TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── PARENT PAYMENT PIN ─────────────────────────────────
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS payments_pin_hash VARCHAR(255),
        ADD COLUMN IF NOT EXISTS pin_failed_attempts INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMP,
        ADD COLUMN IF NOT EXISTS pin_reset_token VARCHAR(255),
        ADD COLUMN IF NOT EXISTS pin_reset_expires TIMESTAMP;
    `);

    // ── BOOKINGS: link to child (nullable — old bookings stay intact) ──
    await client.query(`
      ALTER TABLE bookings
        ADD COLUMN IF NOT EXISTS child_id UUID REFERENCES children(id) ON DELETE SET NULL;
    `);

    // ── TUTOR COMMISSION TIER TRACKING ─────────────────────
    await client.query(`
      ALTER TABLE tutor_profiles
        ADD COLUMN IF NOT EXISTS total_paid_hours DECIMAL(10,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS lifetime_earnings_gross DECIMAL(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS lifetime_earnings_net DECIMAL(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS wallet_balance DECIMAL(12,2) DEFAULT 0;
    `);

    // ── TUTOR EARNINGS LEDGER ──────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tutor_earnings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tutor_id UUID REFERENCES tutor_profiles(id) ON DELETE CASCADE,
        booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
        gross_amount DECIMAL(10,2) NOT NULL,
        commission_percent DECIMAL(5,2) NOT NULL,
        commission_amount DECIMAL(10,2) NOT NULL,
        net_amount DECIMAL(10,2) NOT NULL,
        tier_hours_at_time DECIMAL(10,2),
        status VARCHAR(20) DEFAULT 'pending'
          CHECK (status IN ('pending','released','paid_out','refunded','cancelled')),
        released_at TIMESTAMP,
        paid_out_at TIMESTAMP,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── TUTOR PAYOUTS (when you transfer money to their MBank) ─────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tutor_payouts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tutor_id UUID REFERENCES tutor_profiles(id) ON DELETE CASCADE,
        amount DECIMAL(10,2) NOT NULL,
        method VARCHAR(30) DEFAULT 'mbank'
          CHECK (method IN ('mbank','bank_transfer','cash','other')),
        reference VARCHAR(255),
        status VARCHAR(20) DEFAULT 'pending'
          CHECK (status IN ('pending','completed','failed','cancelled')),
        initiated_by UUID REFERENCES users(id) ON DELETE SET NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      );
    `);
    // ── INDEXES FOR PERFORMANCE ────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_tutor_profiles_approved ON tutor_profiles(is_approved);
      CREATE INDEX IF NOT EXISTS idx_bookings_student ON bookings(student_id);
      CREATE INDEX IF NOT EXISTS idx_bookings_tutor ON bookings(tutor_id);
      CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(lesson_date);
      CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_tutor ON reviews(tutor_id);
      CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
      CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_leads_urgency ON leads(urgency);
      CREATE INDEX IF NOT EXISTS idx_children_parent ON children(parent_user_id);
      CREATE INDEX IF NOT EXISTS idx_bookings_child ON bookings(child_id);
      CREATE INDEX IF NOT EXISTS idx_tutor_earnings_tutor ON tutor_earnings(tutor_id, status);
      CREATE INDEX IF NOT EXISTS idx_tutor_earnings_booking ON tutor_earnings(booking_id);
      CREATE INDEX IF NOT EXISTS idx_tutor_payouts_tutor ON tutor_payouts(tutor_id, status);
    `);

    await client.query('COMMIT');
    console.log('✅ All tables created successfully!');
    console.log('📊 Tables: users, tutor_profiles, tutor_availability,');
    console.log('           bookings, payments, reviews, support_messages,');
    console.log('           tutor_applications, notifications, subjects');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

migrate();
