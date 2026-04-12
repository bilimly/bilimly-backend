const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../config/database');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── AUTO-REVIEW TUTOR APPLICATION ─────────────────────────
const reviewTutorApplication = async (applicationId) => {
  try {
    const result = await pool.query(
      'SELECT * FROM tutor_applications WHERE id = $1', [applicationId]
    );
    const app = result.rows[0];
    if (!app) return;

    const prompt = `Ты — менеджер по найму репетиторов на платформе Bilimly.kg (Кыргызстан).
    
Проанализируй заявку репетитора и дай оценку от 0 до 100.

ЗАЯВКА:
- Имя: ${app.full_name}
- Email: ${app.email}
- Предметы: ${app.subjects?.join(', ')}
- Опыт: ${app.experience_years} лет
- Образование: ${app.education}
- Желаемая ставка: ${app.hourly_rate} сом/час
- О себе: ${app.about}

КРИТЕРИИ ОЦЕНКИ:
- Опыт преподавания (0-30 баллов)
- Образование (0-25 баллов)
- Качество описания (0-20 баллов)
- Соответствие ставки рынку Кыргызстана (0-15 баллов)
- Полнота заявки (0-10 баллов)

Ответь ТОЛЬКО в формате JSON:
{
  "score": <число 0-100>,
  "recommendation": "approve" | "review" | "reject",
  "notes": "<краткое обоснование на русском, 2-3 предложения>",
  "strengths": ["<сильная сторона 1>", "<сильная сторона 2>"],
  "concerns": ["<замечание 1>"] 
}`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    const review = JSON.parse(clean);

    // Update application with AI review
    await pool.query(
      `UPDATE tutor_applications SET
         ai_review_score = $1,
         ai_review_notes = $2,
         status = 'ai_reviewed',
         reviewed_at = NOW()
       WHERE id = $3`,
      [review.score, JSON.stringify(review), applicationId]
    );

    // Auto-approve high scoring applications
    if (review.score >= 80 && review.recommendation === 'approve') {
      await pool.query(
        `UPDATE tutor_applications SET status='approved' WHERE id=$1`,
        [applicationId]
      );
      console.log(`✅ Auto-approved tutor application: ${app.full_name} (score: ${review.score})`);
    }

    console.log(`🤖 AI reviewed application ${applicationId}: score=${review.score}`);
    return review;

  } catch (err) {
    console.error('Tutor vetting agent error:', err);
  }
};

module.exports = { reviewTutorApplication };
