import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTransaction, detectCurrency, parseAmount } from '../../../../packages/bridge-core/src/providers/cal/normalizer.js';

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

describe('detectCurrency', () => {
  it('detects USD from $ symbol', () => {
    assert.equal(detectCurrency('$125.60'), 'USD');
  });

  it('detects EUR from € symbol', () => {
    assert.equal(detectCurrency('€99.00'), 'EUR');
  });

  it('detects GBP from £ symbol', () => {
    assert.equal(detectCurrency('£42.50'), 'GBP');
  });

  it('detects ILS from ₪ symbol', () => {
    assert.equal(detectCurrency('387.45 ₪'), 'ILS');
  });

  it('falls back to ILS when no symbol present', () => {
    assert.equal(detectCurrency('125.60'), 'ILS');
  });

  it('falls back to ILS for empty string', () => {
    assert.equal(detectCurrency(''), 'ILS');
  });

  it('falls back to ILS for undefined', () => {
    assert.equal(detectCurrency(), 'ILS');
  });

  it('normalizes USD+ILS transaction correctly', () => {
    const raw = {
      ...{ businessName: 'MyFunded Futures', transactionDate: '2026-04-15', chargeDate: '2026-04-20' },
      amount: 125.6,
      amountRaw: '$125.60',
      chargeAmount: 387.45,
      chargeAmountRaw: '387.45 ₪',
    };
    const t = normalizeTransaction(raw);
    assert.equal(t.amount, 125.6);
    assert.equal(t.currency, 'USD');
    assert.equal(t.chargeAmount, 387.45);
    assert.equal(t.chargeCurrency, 'ILS');
  });
});

describe('parseAmount', () => {
  const cases = [
    ['$97.30', 97.3],
    ['€97.30', 97.3],
    ['£12.34', 12.34],
    ['₪46.79', 46.79],
    ['RON72.50', 72.5],
    ['USD 97.30', 97.3],
    ['97.30 USD', 97.3],
    ['GBP12.34', 12.34],
    ['1,234.56', 1234.56],
  ];

  for (const [input, expected] of cases) {
    it(`parses "${input}" => ${expected}`, () => {
      assert.equal(parseAmount(input), expected);
    });
  }

  it('returns 0 for garbage input', () => {
    assert.equal(parseAmount('abc'), 0);
    assert.equal(parseAmount('—'), 0);
  });

  it('returns 0 for empty / null / undefined', () => {
    assert.equal(parseAmount(''), 0);
    assert.equal(parseAmount(null), 0);
    assert.equal(parseAmount(undefined), 0);
  });
});

describe('detectCurrency — 3-letter currency codes', () => {
  const cases = [
    ['$97.30', 'USD'],
    ['€97.30', 'EUR'],
    ['£12.34', 'GBP'],
    ['₪46.79', 'ILS'],
    ['RON72.50', 'RON'],
    ['USD 97.30', 'USD'],
    ['97.30 USD', 'USD'],
    ['GBP12.34', 'GBP'],
  ];

  for (const [input, expected] of cases) {
    it(`detects "${input}" => ${expected}`, () => {
      assert.equal(detectCurrency(input), expected);
    });
  }

  it('falls back to ILS for an unknown currency code', () => {
    assert.equal(detectCurrency('JPY1200'), 'ILS');
  });

  it('falls back to ILS when no currency is present', () => {
    assert.equal(detectCurrency('72.50'), 'ILS');
  });
});

describe('normalizeTransaction — currency parsing pipeline (regression)', () => {
  // Mirrors what extractModalData() produces: raw.amount/chargeAmount are
  // computed from the raw strings via parseAmount before normalization.
  function fromRawStrings(fields) {
    const raw = { ...fields };
    raw.amount = parseAmount(raw.amountRaw);
    raw.chargeAmount = parseAmount(raw.chargeAmountRaw);
    return normalizeTransaction(raw);
  }

  it('HESBURGER 3 (RON original, ILS charge) is parsed correctly', () => {
    const t = fromRawStrings({
      businessName: 'HESBURGER 3',
      transactionDate: '2026-05-30',
      chargeDate: '2026-06-02',
      amountRaw: 'RON72.50',
      chargeAmountRaw: '₪46.79',
    });
    assert.equal(t.amount, 72.5);
    assert.equal(t.currency, 'RON');
    assert.equal(t.chargeAmount, 46.79);
    assert.equal(t.chargeCurrency, 'ILS');
  });

  it('MyFunded Futures (USD original, ILS charge) still works', () => {
    const t = fromRawStrings({
      businessName: 'MyFunded Futures',
      transactionDate: '2026-05-30',
      chargeDate: '2026-06-02',
      amountRaw: '$97.30',
      chargeAmountRaw: '₪284.62',
    });
    assert.equal(t.amount, 97.3);
    assert.equal(t.currency, 'USD');
    assert.equal(t.chargeAmount, 284.62);
    assert.equal(t.chargeCurrency, 'ILS');
  });
});
