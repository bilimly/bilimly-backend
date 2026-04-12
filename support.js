const express = require('express');
const { auth } = require('../middleware/auth');
const { handleChatMessage, getConversationHistory } = require('../agents/supportAgent');
const { verifyWebhook, handleWebhookEvent } = require('../services/instagramService');
const { handleIncomingMessage } = require('../services/whatsappService');
const router = express.Router();

// ── WEBSITE CHAT ───────────────────────────────────────────
router.post('/chat', async (req, res) => {
  const { message, session_id } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  try {
    const userId = req.user?.id || null;
    const history = userId ? await getConversationHistory(userId) : [];
    const reply = await handleChatMessage(message, userId, 'website', history);
    res.json({ reply, session_id });
  } catch (err) {
    res.status(500).json({ error: 'Chat failed' });
  }
});

// ── WHATSAPP WEBHOOK ───────────────────────────────────────
router.get('/whatsapp/webhook', (req, res) => {
  const token = req.query['hub.verify_token'];
  if (token === process.env.META_VERIFY_TOKEN) {
    return res.send(req.query['hub.challenge']);
  }
  res.status(403).send('Forbidden');
});

router.post('/whatsapp/webhook', async (req, res) => {
  res.status(200).send('OK');
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const msg = changes?.messages?.[0];
    if (msg?.type === 'text') {
      await handleIncomingMessage(msg.from, msg.text.body, msg.id);
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err);
  }
});

// ── INSTAGRAM WEBHOOK ──────────────────────────────────────
router.get('/instagram/webhook', verifyWebhook);
router.post('/instagram/webhook', handleWebhookEvent);

// ── GET CHAT HISTORY ───────────────────────────────────────
router.get('/history', auth, async (req, res) => {
  try {
    const history = await getConversationHistory(req.user.id, 20);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get history' });
  }
});

module.exports = router;
