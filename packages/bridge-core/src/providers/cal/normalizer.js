import { createTransaction } from '../../schema/transaction.js';

const CURRENCY_SYMBOLS = { '$': 'USD', '€': 'EUR', '£': 'GBP', '₪': 'ILS' };

// Known 3-letter ISO codes CAL may render as text (e.g. "RON72.50"). Currencies
// without a common symbol (like RON) can only be detected this way.
const KNOWN_CURRENCY_CODES = new Set(['ILS', 'USD', 'EUR', 'GBP', 'RON']);

/**
 * Parse the numeric value from a CAL amount string.
 *
 * Robust to a currency symbol or 3-letter code appearing before OR after the
 * number, and to thousands separators. The earlier inline logic stripped only a
 * fixed symbol set (`₪$€£`) then `parseFloat`'d, which returned 0 whenever a code
 * like `RON` led the string (e.g. "RON72.50" → 0).
 *
 * Examples:
 *   "$97.30"   → 97.3      "RON72.50" → 72.5
 *   "₪46.79"   → 46.79     "USD 97.30" → 97.3
 *   "GBP12.34" → 12.34     "97.30 USD" → 97.3
 *   "1,234.56" → 1234.56
 * Empty / null / undefined / non-numeric input → 0.
 *
 * Exported so it can be unit-tested without a browser, reused by the extractor,
 * and reused by the finance-export guard.
 *
 * @param {string} raw
 * @returns {number}
 */
export function parseAmount(raw) {
  if (raw == null) return 0;
  // First numeric token: optional sign, digits (with optional thousands commas),
  // optional decimal fraction. Ignores any surrounding symbol/code text.
  const match = String(raw).match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!match) return 0;
  const num = parseFloat(match[0].replace(/,/g, ''));
  return Number.isFinite(num) ? num : 0;
}

export function detectCurrency(amountRaw = '') {
  const str = String(amountRaw ?? '');

  // 1. Symbol detection first (backward compatible).
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (str.includes(symbol)) return code;
  }

  // 2. 3-letter currency code, appearing before or after the number, possibly
  //    adjacent to digits ("RON72.50") or space-separated ("97.30 USD").
  //    Lookarounds ensure we match an isolated 3-letter run, not part of a word.
  const codes = str.toUpperCase().match(/(?<![A-Z])[A-Z]{3}(?![A-Z])/g) || [];
  for (const code of codes) {
    if (KNOWN_CURRENCY_CODES.has(code)) return code;
  }

  // 3. Fallback.
  return 'ILS';
}

export function normalizeTransaction(raw) {
  return createTransaction({
    provider: 'CAL',
    accountId: raw.cardName || '',
    transactionDate: raw.transactionDate,
    chargeDate: raw.chargeDate || '',
    merchantName: raw.businessName || '',
    category: raw.expenseType || '',
    amount: raw.amount,
    currency: detectCurrency(raw.amountRaw),
    chargeAmount: raw.chargeAmount || raw.amount,
    chargeCurrency: detectCurrency(raw.chargeAmountRaw),
    transactionType: raw.transactionType || '',
    status: raw.chargeDate ? 'completed' : 'pending',
    raw,
  });
}
