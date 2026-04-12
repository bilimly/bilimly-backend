const axios = require('axios');
const pool = require('../config/database');

// ── VERIFY INSTAGRAM WEBHOOK ───────────────────────────────
const verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('✅ Instagram webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
};

// ── HANDLE INSTAGRAM WEBHOOK EVENT ────────────────────────
const handleWebhookEvent = async (req, res) => {
  res.status(200).send('OK'); // Always respond quickly to Meta

  const body = req.body;
  if (body.object !== 'instagram') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      if (event.message && !event.message.is_echo) {
        await handleIncomingDM(
          event.sender.id,
          event.message.text || '[non-text message]',
          event.message.mid
        );
      }
    }

    // Handle comment mentions
    for (const change of entry.changes || []) {
      if (change.field === 'comments' && change.value) {
        await handleComment(change.value);
      }
    }
  }
};

// ── HANDLE INCOMING DM ─────────────────────────────────────
const handleIncomingDM = async (senderId, message, messageId) => {
  try {
    // Save incoming message
    await pool.query(
      `INSERT INTO support_messages (channel, direction, message, instagram_message_id)
       VALUES ('instagram','inbound',$1,$2)`,
      [message, messageId]
    );

    // Get AI response
    const { handleChatMessage } = require('../agents/supportAgent');
    const reply = await handleChatMessage(message, null, 'instagram', []);

    // Send reply via Instagram Graph API
    await sendInstagramDM(senderId, reply);

    // Save outbound
    await pool.query(
      `INSERT INTO support_messages (channel, direction, message, is_ai_response)
       VALUES ('instagram','outbound',$1,true)`,
      [reply]
    );

  } catch (err) {
    console.error('Instagram DM error:', err);
  }
};

// ── HANDLE COMMENT ON POST ─────────────────────────────────
const handleComment = async (commentData) => {
  try {
    const { text, from, id: commentId, media } = commentData;
    if (!text || commentData.from?.id === process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID) return;

    // Generate a relevant reply to comment
    const { handleChatMessage } = require('../agents/supportAgent');
    const context = `Пользователь оставил комментарий под постом Bilimly в Instagram: "${text}". Дай краткий дружелюбный ответ на комментарий (1-2 предложения), побуди написать в директ для подробностей.`;
    const reply = await handleChatMessage(context, null, 'instagram', []);

    // Reply to comment
    await axios.post(
      `https://graph.facebook.com/v18.0/${commentId}/replies`,
      { message: reply },
      {
        params: { access_token: process.env.INSTAGRAM_ACCESS_TOKEN }
      }
    );
  } catch (err) {
    console.error('Comment reply error:', err);
  }
};

// ── SEND INSTAGRAM DM ──────────────────────────────────────
const sendInstagramDM = async (recipientId, message) => {
  if (!process.env.INSTAGRAM_ACCESS_TOKEN) {
    console.log(`[Instagram DEMO] To: ${recipientId}\nMessage: ${message}`);
    return;
  }
  try {
    await axios.post(
      'https://graph.facebook.com/v18.0/me/messages',
      {
        recipient: { id: recipientId },
        message: { text: message }
      },
      { params: { access_token: process.env.INSTAGRAM_ACCESS_TOKEN } }
    );
  } catch (err) {
    console.error('Instagram send error:', err.message);
  }
};

module.exports = { verifyWebhook, handleWebhookEvent };
