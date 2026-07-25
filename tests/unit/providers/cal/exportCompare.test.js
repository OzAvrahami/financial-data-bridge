import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareTransactionSets } from '../../../../packages/bridge-core/src/providers/cal/exportCompare.js';
import { normalizeTransaction } from '../../../../packages/bridge-core/src/providers/cal/normalizer.js';

// Build a normalized CAL transaction via the SHARED normalizer (same path both
// production paths use), so fingerprints are computed identically to production.
function tx({ date = '2026-07-24', merchant = 'WOLT', ils = '100.0', card = 'ויזה 2755', chargeDate = '2026-08-20', type = 'רגיל', notes = '' } = {}) {
  return normalizeTransaction({
    transactionDate: date, cardName: card, businessName: merchant, expenseType: '',
    amount: Number(ils), amountRaw: ils, transactionType: type,
    chargeDate, chargeAmount: Number(ils), chargeAmountRaw: ils, notes,
  });
}

describe('compareTransactionSets', () => {
  it('reports a perfect identity match for equivalent sets', () => {
    const exp = [tx({ merchant: 'WOLT' }), tx({ merchant: 'AMAZON', ils: '250.0' })];
    const mod = [tx({ merchant: 'WOLT' }), tx({ merchant: 'AMAZON', ils: '250.0' })];
    const r = compareTransactionSets(exp, mod);
    assert.equal(r.summary.identityMatch, true);
    assert.equal(r.summary.exportOnlyCount, 0);
    assert.equal(r.summary.modalOnlyCount, 0);
    assert.equal(r.summary.matched, 2);
    assert.equal(r.summary.fieldMismatchCount, 0);
  });

  it('preserves duplicates and matches occurrence keys (2 vs 2)', () => {
    const dup = () => tx({ merchant: 'MY FUNDED FUTURES', ils: '300.0' });
    const r = compareTransactionSets([dup(), dup()], [dup(), dup()]);
    assert.equal(r.summary.identityMatch, true, 'both #1 and #2 occurrence keys line up');
    const grp = r.duplicateGroups.find(g => g.exportCount === 2);
    assert.ok(grp);
    assert.equal(grp.modalCount, 2);
    assert.equal(grp.match, true);
  });

  it('flags an extra occurrence (export 3 vs modal 2)', () => {
    const dup = () => tx({ merchant: 'MY FUNDED FUTURES', ils: '300.0' });
    const r = compareTransactionSets([dup(), dup(), dup()], [dup(), dup()]);
    assert.equal(r.summary.identityMatch, false);
    assert.equal(r.summary.exportOnlyCount, 1, 'the 3rd occurrence (#3) is export-only');
    assert.ok(r.exportOnly[0].endsWith('|#3'));
    const grp = r.duplicateGroups.find(g => !g.match);
    assert.deepEqual([grp.exportCount, grp.modalCount], [3, 2]);
  });

  it('detects a cardName/accountId-only difference (the key export risk)', () => {
    const exp = [tx({ merchant: 'WOLT', card: 'ויזה 2755' })];
    const mod = [tx({ merchant: 'WOLT', card: 'CAL Visa 2755' })]; // same tx, different card string
    const r = compareTransactionSets(exp, mod);
    assert.equal(r.summary.identityMatch, false);
    assert.equal(r.summary.exportOnlyCount, 1);
    assert.equal(r.summary.modalOnlyCount, 1);
    assert.equal(r.summary.cardNameMismatchCount, 1);
    assert.equal(r.cardNameMismatches[0].exportCardName, 'ויזה 2755');
    assert.equal(r.cardNameMismatches[0].modalCardName, 'CAL Visa 2755');
  });

  it('reports content diffs (e.g. category) on matched pairs without breaking identity', () => {
    const exp = [tx({ merchant: 'WOLT' })]; // category '' (no export column)
    const modRaw = {
      transactionDate: '2026-07-24', cardName: 'ויזה 2755', businessName: 'WOLT', expenseType: 'מסעדות',
      amount: 100, amountRaw: '100.0', transactionType: 'רגיל',
      chargeDate: '2026-08-20', chargeAmount: 100, chargeAmountRaw: '100.0',
    };
    const mod = [normalizeTransaction(modRaw)]; // category 'מסעדות'
    const r = compareTransactionSets(exp, mod);
    assert.equal(r.summary.identityMatch, true, 'category is NOT an identity field — dedupKeys still match');
    assert.equal(r.summary.fieldMismatchCount, 1);
    assert.ok(r.fieldMismatches[0].diffs.category);
  });

  it('lists export-only and modal-only dedupKeys for disjoint sets', () => {
    const r = compareTransactionSets([tx({ merchant: 'A' })], [tx({ merchant: 'B' })]);
    assert.equal(r.exportOnly.length, 1);
    assert.equal(r.modalOnly.length, 1);
    assert.equal(r.summary.identityMatch, false);
  });

  it('handles empty inputs', () => {
    const r = compareTransactionSets([], []);
    assert.equal(r.summary.identityMatch, true);
    assert.equal(r.summary.exportCount, 0);
    assert.equal(r.summary.modalCount, 0);
  });

  it('does not mutate the caller transaction objects (no dedupKey leak)', () => {
    const a = tx({ merchant: 'WOLT' });
    compareTransactionSets([a], [a]);
    assert.equal(a.dedupKey, '', 'input objects are cloned before assignOccurrenceKeys');
  });
});
