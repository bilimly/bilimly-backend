// ── FREEDOM PAY INTEGRATION ────────────────────────────────
// Merchant API / Payment Page method
// Base URL: https://api.freedompay.kg
// Docs: https://docs.freedompay.kz/api-11620859

const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');

const FP_BASE_URL = 'https://api.freedompay.kg';
const MERCHANT_ID = process.env.FREEDOMPAY_MERCHANT_ID;
const SECRET_KEY  = process.env.FREEDOMPAY_SECRET_KEY;

// ── SIGNATURE ─────────────────────────────────────────────
// Freedom Pay signature: MD5 of "script_name;val1;val2;...;secret_key"
// where values are sorted alphabetically by key name (pg_ keys only)
function makeSignature(scriptName, params) {
  // Collect pg_ params, sort by key
  const pgKeys = Object.keys(params)
    .filter(k => k.startsWith('pg_') && k !== 'pg_sig')
    .sort();

  const values = pgKeys.map(k => params[k]);
  const str = [scriptName, ...values, SECRET_KEY].join(';');
  return crypto.createHash('md5').update(str).digest('hex');
}

// ── VERIFY INCOMING SIGNATURE ─────────────────────────────
function verifySignature(scriptName, params) {
  const expected = makeSignature(scriptName, params);
  return expected === params.pg_sig;
}

// ── CREATE PAYMENT ─────────────────────────────────────────
// Returns { redirect_url, payment_id } or throws
async function createPayment({ orderId, amount, description, successUrl, failUrl, resultUrl, customerPhone, customerEmail }) {
  const salt = crypto.randomBytes(8).toString('hex');

  const params = {
    pg_merchant_id:   MERCHANT_ID,
    pg_order_id:      String(orderId),
    pg_amount:        String(Math.round(amount)),
    pg_currency:      'KGS',
    pg_description:   description || 'Оплата урока на Bilimpark.kg',
    pg_salt:          salt,
    pg_success_url:   successUrl,
    pg_failure_url:   failUrl,
    pg_result_url:    resultUrl,
    pg_site_url:      'https://bilimpark.kg',
    pg_language:      'ru',
    pg_lifetime:      '86400', // 24 hours
    ...(customerPhone ? { pg_user_phone: customerPhone } : {}),
    ...(customerEmail ? { pg_user_contact_email: customerEmail } : {}),
  };

  params.pg_sig = makeSignature('init_payment', params);

  const body = querystring.stringify(params);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.freedompay.kg',
      path: '/init_payment',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Freedom Pay returns XML
          const redirectUrl = data.match(/<pg_redirect_url>(.*?)<\/pg_redirect_url>/)?.[1];
          const paymentId   = data.match(/<pg_payment_id>(.*?)<\/pg_payment_id>/)?.[1];
          const status      = data.match(/<pg_status>(.*?)<\/pg_status>/)?.[1];
          const errorDesc   = data.match(/<pg_error_description>(.*?)<\/pg_error_description>/)?.[1];

          if (status === 'ok' && redirectUrl) {
            resolve({ redirect_url: redirectUrl, payment_id: paymentId });
          } else {
            reject(new Error(errorDesc || 'Freedom Pay returned non-ok status: ' + status));
          }
        } catch (e) {
          reject(new Error('Failed to parse Freedom Pay response: ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── CHECK PAYMENT STATUS ───────────────────────────────────
async function getPaymentStatus(fpPaymentId) {
  const salt = crypto.randomBytes(8).toString('hex');
  const params = {
    pg_merchant_id: MERCHANT_ID,
    pg_payment_id:  String(fpPaymentId),
    pg_salt:        salt,
  };
  params.pg_sig = makeSignature('get_status', params);

  const body = querystring.stringify(params);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.freedompay.kg',
      path: '/get_status',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const status = data.match(/<pg_transaction_status>(.*?)<\/pg_transaction_status>/)?.[1];
        resolve({ status, raw: data });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { createPayment, verifySignature, makeSignature, getPaymentStatus };
