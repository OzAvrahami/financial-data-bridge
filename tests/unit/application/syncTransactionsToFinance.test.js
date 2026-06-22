/**
 * Unit tests for the finance sync engine.
 *
 * These exercise the engine with a temp ledger/report dir and a fake sender, so
 * no real HTTP happens. The focus is the two correctness fixes:
 *   - a transaction that is "unchanged" locally but never sent to finance is still
 *     eligible (it is NOT skipped just because local dedup says unchanged), and
 *   - a transaction that failed a previous finance send is retried, while one with
 *     a prior successful send is treated as already_sent.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { syncTransactionsToFinance } from '../../../packages/bridge-core/src/application/syncTransactionsToFinance.js';

let dir, ledgerDir, reportsDir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-test-'));
  ledgerDir = join(dir, 'ledger');
  reportsDir = join(dir, 'reports');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FIN = { enabled: true, apiUrl: 'https://fin/api', apiKey: 'tok' };
const tx = (o = {}) => ({
  provider: 'CAL', providerAccountId: 'oz', providerDisplayName: 'Oz', accountId: 'card',
  transactionDate: '2026-06-01', merchantName: 'M', amount: 10, currency: 'ILS',
  chargeAmount: 10, chargeCurrency: 'ILS', status: 'completed',
  dedupKey: 'k', localDedupStatus: 'unchanged', raw: {}, ...o,
});
const okSender = (calls = { n: 0 }) => async () => { calls.n++; return { ok: true, apiStatus: 201, financeTransactionId: 'fin_' + calls.n }; };
const run = (txs, opts = {}, deps = {}) =>
  syncTransactionsToFinance({ consideredTransactions: txs, financeConfig: FIN, ledgerDir, reportsDir, ...opts }, deps);

describe('syncTransactionsToFinance — core fix: unchanged-locally still eligible', () => {
  it('SENDS an unchanged-locally transaction that was never sent to finance', async () => {
    const calls = { n: 0 };
    const r = await run([tx({ dedupKey: 'a', localDedupStatus: 'unchanged' })], {}, { sendTransaction: okSender(calls) });
    assert.equal(r.counts.sent, 1);
    assert.equal(calls.n, 1);
    assert.equal(r.rows[0].financeStatus, 'sent');
  });

  it('treats a prior successful send as already_sent (no resend)', async () => {
    const calls = { n: 0 };
    await run([tx({ dedupKey: 'a' })], {}, { sendTransaction: okSender(calls) });
    const r2 = await run([tx({ dedupKey: 'a' })], {}, { sendTransaction: okSender(calls) });
    assert.equal(r2.counts.alreadySent, 1);
    assert.equal(r2.counts.sent, 0);
    assert.equal(calls.n, 1, 'must not call the API again for an already-sent tx');
    assert.equal(r2.rows[0].reason, 'already_sent_successfully');
  });
});

describe('syncTransactionsToFinance — core fix: retry prior failures', () => {
  it('retries a transaction that failed a previous finance send', async () => {
    const fail = async () => ({ ok: false, classification: 'api_error', apiStatus: 500, message: 'boom' });
    const r1 = await run([tx({ dedupKey: 'f' })], {}, { sendTransaction: fail });
    assert.equal(r1.counts.failed, 1);
    assert.equal(r1.rows[0].financeStatus, 'failed');

    const calls = { n: 0 };
    const r2 = await run([tx({ dedupKey: 'f' })], {}, { sendTransaction: okSender(calls) });
    assert.equal(r2.counts.sent, 1, 'a prior failure is retried, not skipped');
    assert.equal(calls.n, 1);
  });
});

describe('syncTransactionsToFinance — content-changed flag-for-review', () => {
  it('flags an already-sent tx whose content changed instead of resending', async () => {
    const calls = { n: 0 };
    await run([tx({ dedupKey: 'a', category: 'orig' })], {}, { sendTransaction: okSender(calls) });
    const r2 = await run([tx({ dedupKey: 'a', category: 'CHANGED' })], {}, { sendTransaction: okSender(calls) });
    assert.equal(calls.n, 1, 'no resend on content change');
    assert.equal(r2.counts.skipped, 1);
    assert.equal(r2.rows[0].financeStatus, 'skipped');
    assert.equal(r2.rows[0].reason, 'already_sent_content_changed');
  });
});

describe('syncTransactionsToFinance — skip reasons', () => {
  it('assigns the correct skip reason per transaction and never sends them', async () => {
    const calls = { n: 0 };
    const r = await run([
      tx({ dedupKey: 'p', status: 'pending' }),
      tx({ dedupKey: 'z', chargeAmount: 0 }),
      tx({ dedupKey: 'd', localDedupStatus: 'duplicate' }),
    ], {}, { sendTransaction: okSender(calls) });
    assert.equal(calls.n, 0);
    assert.equal(r.counts.skipped, 3);
    assert.deepEqual(r.rows.map((x) => x.reason), [
      'transaction_not_completed',
      'charge_amount_zero_or_negative',
      'duplicate_in_current_batch',
    ]);
  });
});

describe('syncTransactionsToFinance — run-level not_attempted', () => {
  it('does not send anything and writes a report when finance is disabled', async () => {
    const calls = { n: 0 };
    const r = await run([tx()], { financeConfig: { enabled: false } }, { sendTransaction: okSender(calls) });
    assert.equal(r.executed, false);
    assert.equal(r.notAttemptedReason, 'finance_disabled');
    assert.equal(r.counts.notAttempted, 1);
    assert.equal(calls.n, 0);
    // A report is still written for the audit trail.
    const json = JSON.parse(readFileSync(r.reportPaths.jsonPath, 'utf-8'));
    assert.equal(json.transactions[0].financeStatus, 'not_attempted');
  });

  it('reports fetch_failed when the fetch did not succeed', async () => {
    const r = await run([tx()], { fetchSucceeded: false });
    assert.equal(r.notAttemptedReason, 'fetch_failed');
  });

  it('reports missing_api_url / missing_api_key', async () => {
    const a = await run([tx()], { financeConfig: { enabled: true, apiUrl: '', apiKey: 'k' } });
    assert.equal(a.notAttemptedReason, 'missing_api_url');
    const b = await run([tx()], { financeConfig: { enabled: true, apiUrl: 'https://x', apiKey: '' } });
    assert.equal(b.notAttemptedReason, 'missing_api_key');
  });
});

describe('syncTransactionsToFinance — failures are isolated', () => {
  it('one failing transaction does not abort the batch', async () => {
    let i = 0;
    const sender = async () => {
      i++;
      if (i === 2) return { ok: false, classification: 'api_validation_failed', apiStatus: 422, message: 'bad' };
      return { ok: true, apiStatus: 201, financeTransactionId: 'fin' };
    };
    const r = await run([tx({ dedupKey: 'a' }), tx({ dedupKey: 'b' }), tx({ dedupKey: 'c' })], {}, { sendTransaction: sender });
    assert.equal(r.counts.sent, 2);
    assert.equal(r.counts.failed, 1);
  });
});
