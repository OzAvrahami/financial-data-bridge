import { createTransaction } from '../../packages/bridge-core/src/schema/transaction.js';

/** Reusable sample normalized transactions for use in multiple test files. */
export const sampleTransactions = [
  createTransaction({
    provider: 'CAL',
    accountId: 'Visa 1234',
    transactionDate: '2026-04-15',
    chargeDate: '2026-04-20',
    merchantName: 'SuperMarket',
    category: 'Food',
    amount: 50.5,
    currency: 'ILS',
    chargeAmount: 50.5,
    chargeCurrency: 'ILS',
    transactionType: 'רגיל',
    status: 'completed',
    raw: { businessName: 'SuperMarket' },
  }),
  createTransaction({
    provider: 'CAL',
    accountId: 'Visa 1234',
    transactionDate: '2026-04-16',
    chargeDate: '',
    merchantName: 'Gas Station',
    category: 'Fuel',
    amount: 200,
    currency: 'ILS',
    chargeAmount: 200,
    chargeCurrency: 'ILS',
    transactionType: 'רגיל',
    status: 'pending',
    raw: { businessName: 'Gas Station' },
  }),
];

/**
 * Two real transactions that are indistinguishable by business fields alone.
 * Mirrors the TOPSTEP recurring-charge scenario: same merchant, date, amount,
 * currency, chargeDate, chargeAmount, and transactionType.
 */
export const duplicateBusinessFieldTransactions = [
  createTransaction({
    provider: 'CAL',
    accountId: 'ויזה5304',
    transactionDate: '2026-05-10',
    chargeDate: '2026-06-10',
    merchantName: 'TOPSTEP',
    category: '',
    amount: 85,
    currency: 'USD',
    chargeAmount: 254.68,
    chargeCurrency: 'ILS',
    transactionType: 'הוראת קבע',
    status: 'completed',
    raw: {},
  }),
  createTransaction({
    provider: 'CAL',
    accountId: 'ויזה5304',
    transactionDate: '2026-05-10',
    chargeDate: '2026-06-10',
    merchantName: 'TOPSTEP',
    category: '',
    amount: 85,
    currency: 'USD',
    chargeAmount: 254.68,
    chargeCurrency: 'ILS',
    transactionType: 'הוראת קבע',
    status: 'completed',
    raw: {},
  }),
];

/** Sample raw CAL modal data before normalization. */
export const sampleRawTransaction = {
  businessName: 'SuperMarket',
  cardName: 'Visa 1234',
  transactionDate: '2026-04-15',
  chargeDate: '2026-04-20',
  amount: 50.5,
  chargeAmount: 50.5,
  expenseType: 'Food',
  transactionType: 'רגיל',
};
