import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTransaction } from '../../../../src/providers/cal/normalizer.js';

const baseRaw = {
  businessName: 'SuperMarket',
  cardName: 'Visa 1234',
  transactionDate: '2026-04-15',
  chargeDate: '2026-04-20',
  amount: 50.5,
  chargeAmount: 50.5,
  expenseType: 'Food',
  transactionType: 'רגיל',
};

describe('normalizeTransaction', () => {
  it('sets provider to "CAL"', () => {
    assert.equal(normalizeTransaction(baseRaw).provider, 'CAL');
  });

  it('maps businessName to merchantName', () => {
    assert.equal(normalizeTransaction(baseRaw).merchantName, 'SuperMarket');
  });

  it('maps cardName to accountId', () => {
    assert.equal(normalizeTransaction(baseRaw).accountId, 'Visa 1234');
  });

  it('preserves transactionDate and chargeDate', () => {
    const t = normalizeTransaction(baseRaw);
    assert.equal(t.transactionDate, '2026-04-15');
    assert.equal(t.chargeDate, '2026-04-20');
  });

  it('maps amount and chargeAmount', () => {
    const t = normalizeTransaction(baseRaw);
    assert.equal(t.amount, 50.5);
    assert.equal(t.chargeAmount, 50.5);
  });

  it('maps expenseType to category', () => {
    assert.equal(normalizeTransaction(baseRaw).category, 'Food');
  });

  it('maps transactionType', () => {
    assert.equal(normalizeTransaction(baseRaw).transactionType, 'רגיל');
  });

  it('sets currency and chargeCurrency to ILS', () => {
    const t = normalizeTransaction(baseRaw);
    assert.equal(t.currency, 'ILS');
    assert.equal(t.chargeCurrency, 'ILS');
  });

  it('sets status to "completed" when chargeDate is present', () => {
    assert.equal(normalizeTransaction(baseRaw).status, 'completed');
  });

  it('sets status to "pending" when chargeDate is empty', () => {
    const t = normalizeTransaction({ ...baseRaw, chargeDate: '' });
    assert.equal(t.status, 'pending');
  });

  it('falls back chargeAmount to amount when chargeAmount is 0', () => {
    const t = normalizeTransaction({ ...baseRaw, chargeAmount: 0 });
    assert.equal(t.chargeAmount, baseRaw.amount);
  });

  it('preserves the raw object on the transaction', () => {
    const raw = { ...baseRaw };
    const t = normalizeTransaction(raw);
    assert.deepEqual(t.raw, raw);
  });

  it('handles missing optional fields with empty strings / defaults', () => {
    const minimal = { amount: 10 };
    const t = normalizeTransaction(minimal);
    assert.equal(t.merchantName, '');
    assert.equal(t.accountId, '');
    assert.equal(t.category, '');
    assert.equal(t.transactionType, '');
    assert.equal(t.status, 'pending'); // no chargeDate
  });
});
