/**
 * Kyrgyzstan phone number normalizer.
 *
 * Accepts any of these formats (with or without spaces, dashes, parentheses):
 *   +996555555555
 *    996555555555
 *   0555555555
 *   555555555
 *   8 555 555 555   (Russian-style 8 prefix, treated as local)
 *
 * Returns the number in two forms:
 *   - e164:    "+996555555555"  (for display / storage)
 *   - waDigits: "996555555555"  (digits only, for WhatsApp APIs)
 *
 * Returns null if the input can't be turned into a valid 9-digit KG mobile.
 */
function normalizeKgPhone(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // Strip everything that isn't a digit
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  // 12 digits starting with 996  → already international (996 + 9-digit local)
  if (digits.length === 12 && digits.startsWith('996')) {
    return buildResult(digits.slice(3));
  }

  // 11 digits starting with 8 (Russian-style: 8 + 10?) — rare, but handle 8 + 996...
  if (digits.length === 11 && digits.startsWith('8')) {
    const rest = digits.slice(1); // drop the 8
    if (rest.length === 10 && rest.startsWith('0')) return buildResult(rest.slice(1));
    if (rest.length === 9) return buildResult(rest);
  }

  // 10 digits starting with 0  → local with trunk zero (0XXXXXXXXX)
  if (digits.length === 10 && digits.startsWith('0')) {
    return buildResult(digits.slice(1));
  }

  // 9 digits  → bare local mobile (XXXXXXXXX)
  if (digits.length === 9) {
    return buildResult(digits);
  }

  return null;
}

// Validate the 9-digit local part and build both output forms.
// KG mobile numbers are 9 digits; the first digit is 2–7 for mobile operators.
function buildResult(local9) {
  if (local9.length !== 9) return null;
  // Basic sanity: first digit shouldn't be 0 or 1 for a mobile
  if (/^[01]/.test(local9)) return null;
  const waDigits = '996' + local9;
  return {
    e164: '+' + waDigits,
    waDigits,
    local: local9,
  };
}

// Convenience: just the +E164 string (or null). Backwards-compatible with
// the old normalizeKgPhone that returned a string.
function toE164(raw) {
  const r = normalizeKgPhone(raw);
  return r ? r.e164 : null;
}

// Convenience: just the WhatsApp digits string (or null).
function toWhatsApp(raw) {
  const r = normalizeKgPhone(raw);
  return r ? r.waDigits : null;
}

module.exports = { normalizeKgPhone, toE164, toWhatsApp };
