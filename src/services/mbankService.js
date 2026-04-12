const axios = require('axios');
const pool = require('../config/database');

// ── GENERATE MBANK QR CODE ─────────────────────────────────
const generateMbankQR = async (paymentId, amount) => {
  try {
    // If Mbank API credentials are configured, use real API
    if (process.env.MBANK_API_KEY && process.env.MBANK_MERCHANT_ID) {
      const response = await axios.post(
        `${process.env.MBANK_API_URL}/payments/qr`,
        {
          merchant_id: process.env.MBANK_MERCHANT_ID,
          amount: amount,
          currency: 'KGS',
          order_id: paymentId,
          description: `Bilimly - Оплата урока`,
          callback_url: `${process.env.BACKEND_URL}/api/payments/mbank/webhook`,
          success_url: `${process.env.FRONTEND_URL}/booking/success?payment_id=${paymentId}`,
          fail_url: `${process.env.FRONTEND_URL}/booking/failed?payment_id=${paymentId}`,
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.MBANK_API_KEY}`,
            'Content-Type': 'application/json',
          }
        }
      );
      return {
        qr_code: response.data.qr_code,
        qr_url: response.data.qr_url,
        transaction_id: response.data.transaction_id,
      };
    }

    // DEMO MODE - returns a placeholder QR for testing
    // Replace with real Mbank credentials when available
    return {
      qr_code: `BILIMLY_QR_${paymentId}_${amount}KGS`,
      qr_url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=BILIMLY_PAY_${paymentId}_${amount}`,
      transaction_id: `DEMO_${paymentId}`,
    };

  } catch (err) {
    console.error('Mbank QR generation error:', err.message);
    // Fallback to demo QR
    return {
      qr_code: `BILIMLY_QR_${paymentId}`,
      qr_url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=BILIMLY_${paymentId}_${amount}KGS`,
      transaction_id: null,
    };
  }
};

// ── HANDLE MBANK WEBHOOK ───────────────────────────────────
const handleMbankWebhook = async (req, res) => {
  const { order_id, status, transaction_id, amount } = req.body;

  try {
    if (status === 'SUCCESS' || status === 'PAID') {
      // Update payment status
      await pool.query(
        `UPDATE payments SET
           status='completed',
           mbank_transaction_id=$1,
           paid_at=NOW()
         WHERE id=$2`,
        [transaction_id, order_id]
      );

      // Confirm the booking
      const payment = await pool.query('SELECT booking_id FROM payments WHERE id=$1', [order_id]);
      if (payment.rows[0]) {
        await pool.query(
          'UPDATE bookings SET status=$1, updated_at=NOW() WHERE id=$2',
          ['confirmed', payment.rows[0].booking_id]
        );

        // Send WhatsApp confirmation
        const { sendBookingConfirmation } = require('./whatsappService');
        sendBookingConfirmation(payment.rows[0].booking_id).catch(console.error);
      }
    }

    if (status === 'FAILED' || status === 'CANCELLED') {
      await pool.query(
        'UPDATE payments SET status=$1 WHERE id=$2',
        ['failed', order_id]
      );
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Mbank webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};

// ── CHECK PAYMENT STATUS ───────────────────────────────────
const checkPaymentStatus = async (paymentId) => {
  const result = await pool.query(
    'SELECT * FROM payments WHERE id=$1', [paymentId]
  );
  return result.rows[0];
};

module.exports = { generateMbankQR, handleMbankWebhook, checkPaymentStatus };
