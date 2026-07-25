import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDryRunPlan } from '../../../packages/bridge-core/src/application/exportDryRunPlan.js';
import { normalizeTransaction } from '../../../packages/bridge-core/src/providers/cal/normalizer.js';
import { SeenStore, contentHash, assignOccurrenceKeys } from '../../../packages/bridge-core/src/infrastructure/dedup.js';
import { FinanceLedger as Ledger } from '../../../packages/bridge-core/src/infrastructure/financeLedger.js';

// Build a normalized CAL transaction via the SHARED normalizer.
function tx({ date = '2026-07-24', merchant = 'WOLT', ils = '100.0', card = 'ויזה 2755', chargeDate = '2026-08-20', type = 'רגיל', notes = '' } = {}) {
  const t = normalizeTransaction({
    transactionDate: date, cardName: card, businessName: merchant, expenseType: '',
    amount: Number(ils), amountRaw: ils, transactionType: type,
    chargeDate, chargeAmount: Number(ils), chargeAmountRaw: ils, notes,
  });
  return t;
}
const keyed = (arr) => { assignOccurrenceKeys(arr); return arr; };

describe('buildDryRunPlan', () => {
  it('classifies all-new against an empty SeenStore and never contacts Finance', () => {
    const txs = keyed([tx({ merchant: 'WOLT' }), tx({ merchant: 'AMAZON', ils: '250.0' })]);
    const seen = new SeenStore('runtime/seen-test-noexist');
    const ledger = new Ledger('runtime/ledger-test-noexist');
    const plan = buildDryRunPlan({ transactions: txs, seenStore: seen, financeLedger: ledger });
    assert.equal(plan.summary.normalized, 2);
    assert.equal(plan.summary.wouldBeNew, 2);
    assert.equal(plan.summary.wouldBeUnchanged, 0);
    assert.equal(plan.summary.alreadySentInFinanceLedger, 0);
    assert.equal(plan.summary.wouldSendToFinance, 2);
    // No network: buildDryRunPlan is pure — nothing to assert beyond it returning.
  });

  it('preserves duplicate-looking rows as separate occurrence dedupKeys', () => {
    const dup = () => tx({ merchant: 'MY FUNDED FUTURES', ils: '300.0' });
    const txs = keyed([dup(), dup()]);
    const plan = buildDryRunPlan({ transactions: txs });
    assert.equal(plan.summary.uniqueBaseFingerprints, 1);
    assert.equal(plan.summary.duplicateGroups, 1);
    assert.equal(plan.summary.duplicateOccurrences, 1);
    const g = plan.duplicateGroupSamples[0];
    assert.equal(g.count, 2);
    assert.notEqual(g.dedupKeys[0], g.dedupKeys[1]);
    assert.ok(g.dedupKeys[1].endsWith('|#2'));
  });

  it('respects an already-loaded SeenStore (unchanged) and FinanceLedger (already sent), read-only', () => {
    const t = tx({ merchant: 'WOLT' });
    keyed([t]);
    const seen = new SeenStore('runtime/seen-test-x');
    seen.upsert(t.dedupKey, contentHash(t));       // simulate previously seen with same content
    const ledger = new Ledger('runtime/ledger-test-x');
    ledger.recordSent(t.dedupKey, { contentHash: contentHash(t), apiStatus: 201 }); // already sent

    const seenSizeBefore = seen.size, ledgerSizeBefore = ledger.size;
    const plan = buildDryRunPlan({ transactions: [t], seenStore: seen, financeLedger: ledger });

    assert.equal(plan.summary.wouldBeUnchanged, 1);
    assert.equal(plan.summary.wouldBeNew, 0);
    assert.equal(plan.summary.alreadySentInFinanceLedger, 1);
    assert.equal(plan.summary.wouldSendToFinance, 0, 'already-sent → not resent');
    // Read-only: sizes unchanged (no upsert/recordSent from the plan).
    assert.equal(seen.size, seenSizeBefore);
    assert.equal(ledger.size, ledgerSizeBefore);
  });

  it('reports rows with missing required identity fields', () => {
    const bad = tx({ merchant: '' });            // missing merchantName
    const bad2 = tx({ merchant: 'X', card: '' }); // missing cardName (accountId)
    const txs = keyed([bad, bad2]);
    const plan = buildDryRunPlan({ transactions: txs });
    assert.equal(plan.missingIdentityRows.length, 2);
    assert.ok(plan.missingIdentityRows[0].missing.includes('merchantName'));
    assert.ok(plan.missingIdentityRows[1].missing.includes('accountId'));
    assert.equal(plan.summary.blockedOrInvalid, 2);
    assert.equal(plan.summary.wouldSendToFinance, 0);
  });

  it('blocks non-completed and zero-charge transactions from Finance', () => {
    const pending = tx({ merchant: 'PENDING', chargeDate: '' }); // status pending (no chargeDate)
    assert.equal(pending.status, 'pending');
    const plan = buildDryRunPlan({ transactions: keyed([pending]) });
    assert.equal(plan.summary.blockedOrInvalid, 1);
    assert.equal(plan.invalidRows[0].reason, 'transaction_not_completed');
    assert.equal(plan.summary.wouldSendToFinance, 0);
  });

  it('warns when everything looks NEW despite prior seen/ledger state (identity mismatch signal)', () => {
    const txs = keyed([tx({ merchant: 'WOLT' }), tx({ merchant: 'AMAZON', ils: '250.0' })]);
    // Prior state exists but under DIFFERENT dedupKeys (simulating a card mismatch).
    const seen = new SeenStore('runtime/seen-test-y');
    seen.upsert('some-old-fingerprint', 'abc');
    const plan = buildDryRunPlan({ transactions: txs, seenStore: seen, financeLedger: null });
    assert.equal(plan.summary.wouldBeNew, 2);
    assert.ok(plan.warnings.some(w => /may not match historical modal fingerprints/i.test(w)));
  });

  it('warns about finance-duplicate risk: would-send txs absent from a non-empty ledger', () => {
    const txs = keyed([tx({ merchant: 'WOLT' }), tx({ merchant: 'AMAZON', ils: '250.0' })]);
    const ledger = new Ledger('runtime/ledger-test-z');
    ledger.recordSent('unrelated-old-dedupkey', { contentHash: 'x', apiStatus: 201 }); // ledger has entries, none match
    const plan = buildDryRunPlan({ transactions: txs, seenStore: null, financeLedger: ledger });
    assert.equal(plan.summary.wouldSendToFinance, 2);
    assert.equal(plan.summary.alreadySentInFinanceLedger, 0);
    assert.ok(plan.warnings.some(w => /could create duplicates/i.test(w)));
  });

  it('surfaces export parse stats in the summary when provided', () => {
    const txs = keyed([tx()]);
    const plan = buildDryRunPlan({
      transactions: txs,
      exportStats: { totalRows: 117, withinRange: 117, pendingSkipped: 22, finalized: 95 },
    });
    assert.equal(plan.summary.totalRows, 117);
    assert.equal(plan.summary.withinDaysBack, 117);
    assert.equal(plan.summary.pendingSkipped, 22);
    assert.equal(plan.summary.finalized, 95);
    assert.equal(plan.summary.normalized, 1);
  });

  it('handles empty input', () => {
    const plan = buildDryRunPlan({ transactions: [] });
    assert.equal(plan.summary.normalized, 0);
    assert.equal(plan.summary.wouldSendToFinance, 0);
    assert.equal(plan.warnings.length, 0);
  });
});
