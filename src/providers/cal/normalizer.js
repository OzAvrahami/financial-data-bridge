import { createTransaction } from '../../schema/transaction.js';

const CURRENCY_SYMBOLS = { '$': 'USD', '€': 'EUR', '£': 'GBP', '₪': 'ILS' };

export function detectCurrency(amountRaw = '') {
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (amountRaw.includes(symbol)) return code;
  }
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
