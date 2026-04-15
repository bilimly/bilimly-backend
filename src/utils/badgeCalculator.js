const pool = require('../config/database');

const calculateBadge = (totalLessons, rating) => {
  if (totalLessons >= 1000 && rating >= 4.9) return { badge: 'Elite', icon: '💎' };
  if (totalLessons >= 500 && rating >= 4.8) return { badge: 'Top Tutor', icon: '🥇' };
  if (totalLessons >= 200 && rating >= 4.5) return { badge: 'Experienced', icon: '🥈' };
  if (totalLessons >= 50) return { badge: 'Rising Star', icon: '🥉' };
  return null;
};

const updateTutorBadges = async () => {
  try {
    const tutors = await pool.query(
      `SELECT id, user_id, total_lessons, rating FROM tutor_profiles WHERE is_approved = true`
    );
    for (const tutor of tutors.rows) {
      const badge = calculateBadge(tutor.total_lessons || 0, parseFloat(tutor.rating) || 0);
      await pool.query(
        'UPDATE tutor_profiles SET badge=$1 WHERE id=$2',
        [badge?.badge || null, tutor.id]
      );
    }
    console.log('Badges updated for', tutors.rows.length, 'tutors');
  } catch(err) {
    console.error('Badge error:', err.message);
  }
};

module.exports = { calculateBadge, updateTutorBadges };
