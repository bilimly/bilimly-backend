const jwt = require('jsonwebtoken');

// Middleware: require a valid payments-PIN session token.
// Client sends: X-Payments-Pin-Token: <jwt>
// Issued by POST /api/auth/pin/verify when user enters correct PIN.
// Short-lived (2h), scoped to userId. Separate from main auth JWT.
function requirePaymentsPin(req, res, next) {
  const pinToken = req.header('X-Payments-Pin-Token');
  if (!pinToken) {
    return res.status(403).json({ error: 'PIN_REQUIRED', message: 'Введите PIN для доступа' });
  }
  try {
    const payload = jwt.verify(pinToken, process.env.JWT_SECRET);
    if (payload.type !== 'payments_pin' || !payload.userId) {
      return res.status(403).json({ error: 'PIN_REQUIRED', message: 'Неверный PIN-токен' });
    }
    if (req.user && req.user.id && payload.userId !== req.user.id) {
      return res.status(403).json({ error: 'PIN_MISMATCH', message: 'PIN-токен не соответствует аккаунту' });
    }
    req.pinVerified = true;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'PIN_EXPIRED', message: 'Сессия PIN истекла. Введите PIN снова.' });
  }
}

module.exports = { requirePaymentsPin };