import { createTransaction } from '../../src/schema/transaction.js';

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
