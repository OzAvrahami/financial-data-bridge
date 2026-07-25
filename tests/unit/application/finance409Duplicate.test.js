import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { syncTransactionsToFinance } from '../../../packages/bridge-core/src/application/syncTransactionsToFinance.js';
import { sendTransactionToFinance, classify409 } from '../../../packages/bridge-core/src/application/exportToFinanceSystem.js';

// ── Sender-level 409 classification ───────────────────────────────────────────

const resp409 = (body = '') => ({
  ok: false, status: 409,
  headers: { get: () => null },
  text: async () => body, json: async () => ({}),
});

describe('classify409 (auto by default)', () => {
  afterEach(() => { delete process.env.FINANCE_409_AS_DUPLICATE; });

  it('flags a body that mentions duplicate/exists/external_id as a duplicate', () => {
    assert.equal(classify409('{"error":"duplicate external_id"}').duplicate, true);
    assert.equal(classify409('Transaction already exists').duplicate, true);
    assert.equal(classify409('unique constraint violation').duplicate, true);
  });
  it('extracts an existing remote id and treats it as a duplicate', () => {
    const r = classify409('{"existing_id":"tx_123"}');
    assert.equal(r.duplicate, true);
    assert.equal(r.remoteId, 'tx_123');
  });
  it('treats an ambiguous body as NOT a duplicate', () => {
    assert.equal(classify409('{"message":"validation failed: amount required"}').duplicate, false);
    assert.equal(classify409('').duplicate, false);
  });
  it('honors FINANCE_409_AS_DUPLICATE=true / false overrides', () => {
    process.env.FINANCE_409_AS_DUPLICATE = 'true';
    assert.equal(classify409('anything').duplicate, true);
    process.env.FINANCE_409_AS_DUPLICATE = 'false';
    assert.equal(classify409('duplicate external_id').duplicate, false);
  });
});

describe('sendTransactionToFinance — 409 classification', () => {
  const tx = { status: 'completed', amount: 10, chargeAmount: 10, currency: 'ILS', dedupKey: 'k', merchantName: 'M', raw: {} };
  const cfg = { apiUrl: 'https://fin/api', apiKey: 'tok' };

  it('classifies a confirmed-duplicate 409 as remote_already_exists (not api_validation_failed)', async () => {
    const fetch = async () => resp409('{"error":"duplicate external_id","existing_id":"tx_9"}');
    const r = await sendTransactionToFinance(tx, cfg, { fetch });
    assert.equal(r.classification, 'remote_already_exists');
    assert.equal(r.apiStatus, 409);
    assert.equal(r.duplicate, true);
    assert.equal(r.remoteId, 'tx_9');
  });

  it('classifies an ambiguous 409 as api_conflict (stays a failure)', async () => {
    const fetch = async () => resp409('{"message":"bad state"}');
    const r = await sendTransactionToFinance(tx, cfg, { fetch });
    assert.equal(r.classification, 'api_conflict');
    assert.equal(r.duplicate, false);
  });

  it('non-409 validation errors remain api_validation_failed', async () => {
    const fetch = async () => ({ ok: false, status: 422, headers: { get: () => null }, text: async () => 'nope', json: async () => ({}) });
    const r = await sendTransactionToFinance(tx, cfg, { fetch });
    assert.equal(r.classification, 'api_validation_failed');
  });
});

// ── Engine-level idempotent-duplicate handling ────────────────────────────────

let dir, ledgerDir, reportsDir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fin-409-')); ledgerDir = join(dir, 'l'); reportsDir = join(dir, 'r'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FIN = { enabled: true, apiUrl: 'https://fin/api', apiKey: 'tok' };
const tx = (o = {}) => ({
  provider: 'CAL', providerAccountId: 'oz', accountId: 'ויזה 2755', transactionDate: '2026-06-01',
  merchantName: 'M', amount: 10, currency: 'ILS', chargeAmount: 10, chargeCurrency: 'ILS',
  status: 'completed', dedupKey: 'k', localDedupStatus: 'unchanged', raw: {}, ...o,
});
const dup = () => ({ ok: false, classification: 'remote_already_exists', apiStatus: 409, duplicate: true, remoteId: 'r1', message: 'HTTP 409 — duplicate' });
const conflict = () => ({ ok: false, classification: 'api_conflict', apiStatus: 409, duplicate: false, message: 'HTTP 409 — bad state' });
const run = (txs, deps) => syncTransactionsToFinance(
  { consideredTransactions: txs, financeConfig: FIN, ledgerDir, reportsDir, sendDelayMs: 0 }, deps,
);

describe('finance 409 idempotent duplicate', () => {
  it('records a confirmed 409 duplicate as accepted (duplicateAccepted, not failed)', async () => {
    const r = await run([tx({ dedupKey: 'a' })], { sendTransaction: dup });
    assert.equal(r.counts.duplicateAccepted, 1);
    assert.equal(r.counts.failed, 0);
    assert.equal(r.counts.sent, 0);
    assert.equal(r.rows[0].financeStatus, 'already_sent');
    assert.equal(r.rows[0].reason, 'remote_already_exists');
    assert.equal(r.rows[0].financeTransactionId, 'r1');
  });

  it('a rerun after a confirmed duplicate does NOT call the API (already_sent)', async () => {
    await run([tx({ dedupKey: 'a' })], { sendTransaction: dup });
    let called = 0;
    const r2 = await run([tx({ dedupKey: 'a' })], { sendTransaction: async () => { called++; return dup(); } });
    assert.equal(called, 0, 'ledger recorded the duplicate as accepted → no API call on rerun');
    assert.equal(r2.counts.alreadySent, 1);
    assert.equal(r2.counts.duplicateAccepted, 0);
    assert.equal(r2.counts.failed, 0);
  });

  it('an ambiguous 409 stays failed and is retried on the next run', async () => {
    const r1 = await run([tx({ dedupKey: 'b' })], { sendTransaction: conflict });
    assert.equal(r1.counts.failed, 1);
    assert.equal(r1.counts.duplicateAccepted, 0);
    assert.equal(r1.rows[0].financeStatus, 'failed');
    assert.equal(r1.rows[0].reason, 'api_conflict');

    let called = 0;
    const r2 = await run([tx({ dedupKey: 'b' })], { sendTransaction: async () => { called++; return { ok: true, apiStatus: 201, financeTransactionId: 'x' }; } });
    assert.equal(called, 1, 'ambiguous conflict was NOT recorded as sent → retried');
    assert.equal(r2.counts.sent, 1);
  });

  it('a batch of confirmed duplicates yields failed=0 (the packaged/dev ledger-mismatch case)', async () => {
    const txs = ['a', 'b', 'c'].map((k) => tx({ dedupKey: k }));
    const r = await run(txs, { sendTransaction: dup });
    assert.equal(r.counts.duplicateAccepted, 3);
    assert.equal(r.counts.failed, 0);
    assert.equal(r.executed, true);
  });
});
