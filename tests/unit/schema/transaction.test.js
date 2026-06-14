import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTransaction } from '../../../packages/bridge-core/src/schema/transaction.js';

describe('createTransaction', () => {
  it('returns all required fields with safe defaults', () => {
    const t = createTransaction();
    assert.equal(t.provider, '');
    assert.equal(t.accountId, '');
    assert.equal(t.transactionDate, '');
    assert.equal(t.chargeDate, '');
    assert.equal(t.merchantName, '');
    assert.equal(t.category, '');
    assert.equal(t.amount, 0);
    assert.equal(t.currency, 'ILS');
    assert.equal(t.chargeAmount, 0);
    assert.equal(t.chargeCurrency, 'ILS');
    assert.equal(t.transactionType, '');
    assert.equal(t.status, 'pending');
    assert.deepEqual(t.raw, {});
  });

  it('merges provided fields over defaults', () => {
    const t = createTransaction({
      provider: 'CAL',
      merchantName: 'Coffee Shop',
      amount: 18.5,
      status: 'completed',
    });
    assert.equal(t.provider, 'CAL');
    assert.equal(t.merchantName, 'Coffee Shop');
    assert.equal(t.amount, 18.5);
    assert.equal(t.status, 'completed');
  });

  it('preserves ILS default currency when not overridden', () => {
    const t = createTransaction({ amount: 100 });
    assert.equal(t.currency, 'ILS');
    assert.equal(t.chargeCurrency, 'ILS');
  });

  it('accepts non-ILS currency override', () => {
    const t = createTransaction({ currency: 'USD', amount: 10 });
    assert.equal(t.currency, 'USD');
  });

  it('returns a new object on each call (no shared reference)', () => {
    const a = createTransaction();
    const b = createTransaction();
    a.raw.x = 1;
    assert.equal(b.raw.x, undefined);
  });
});
