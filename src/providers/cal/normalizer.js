import { createTransaction } from '../../schema/transaction.js';

/**
 * Maps CAL raw extracted data to the normalized Transaction schema.
 *
 * Currency limitation: CAL displays foreign-currency transactions with
 * amount in the original currency and chargeAmount in ILS, but the DOM
 * modal does not expose an explicit currency code. Currency is defaulted
 * to 'ILS'. When chargeAmount > 0 and differs from amount, the transaction
 * is likely in a foreign currency — a future improvement could extract the
 * currency symbol from the amount cell.
 */
export function normalizeTransaction(raw) {
  return createTransaction({
    provider: 'CAL',
    accountId: raw.cardName || '',
    transactionDate: raw.transactionDate,
    chargeDate: raw.chargeDate || '',
    merchantName: raw.businessName || '',
    category: raw.expenseType || '',
    amount: raw.amount,
    currency: 'ILS',
    chargeAmount: raw.chargeAmount || raw.amount,
    chargeCurrency: 'ILS',
    transactionType: raw.transactionType || '',
    status: raw.chargeDate ? 'completed' : 'pending',
    raw,
  });
}
