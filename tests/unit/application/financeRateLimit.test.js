import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { syncTransactionsToFinance } from '../../../packages/bridge-core/src/application/syncTransactionsToFinance.js';
import { sendTransactionToFinance, parseRetryAfterMs } from '../../../packages/bridge-core/src/application/exportToFinanceSystem.js';

// ── Sender-level 429 classification ───────────────────────────────────────────

const fakeResp = ({ status = 200, retryAfter = null, ok = status < 400 } = {}) => ({
  ok, status,
  headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? retryAfter : null) },
  text: async () => '', json: async () => ({ id: 'fin_1' }),
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => assert.equal(parseRetryAfterMs(fakeResp({ retryAfter: '5' })), 5000));
  it('parses an HTTP-date into a non-negative delay', () => {
    const future = new Date(Date.now() + 4000).toUTCString();
    const ms = parseRetryAfterMs(fakeResp({ retryAfter: future }));
    assert.ok(ms >= 3000 && ms <= 5000, `got ${ms}`);
  });
  it('returns null when absent/unparseable', () => {
    assert.equal(parseRetryAfterMs(fakeResp({})), null);
    assert.equal(parseRetryAfterMs(fakeResp({ retryAfter: 'soon' })), null);
  });
});

describe('sendTransactionToFinance — 429 classification', () => {
  const tx = { status: 'completed', amount: 10, chargeAmount: 10, currency: 'ILS', dedupKey: 'k', merchantName: 'M', raw: {} };
  const cfg = { apiUrl: 'https://fin/api', apiKey: 'tok' };

  it('classifies 429 as rate_limited with parsed retryAfterMs (not api_validation_failed)', async () => {
    const fetch = async () => fakeResp({ status: 429, retryAfter: '3' });
    const r = await sendTransactionToFinance(tx, cfg, { fetch });
    assert.equal(r.ok, false);
    assert.equal(r.classification, 'rate_limited');
    assert.equal(r.apiStatus, 429);
    assert.equal(r.retryAfterMs, 3000);
  });

  it('still classifies other 4xx as api_validation_failed', async () => {
    const fetch = async () => fakeResp({ status: 422 });
    const r = await sendTransactionToFinance(tx, cfg, { fetch });
    assert.equal(r.classification, 'api_validation_failed');
  });
});

// ── Engine-level retry / backoff / throttle ───────────────────────────────────

let dir, ledgerDir, reportsDir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fin-rl-')); ledgerDir = join(dir, 'l'); reportsDir = join(dir, 'r'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FIN = { enabled: true, apiUrl: 'https://fin/api', apiKey: 'tok' };
const tx = (o = {}) => ({
  provider: 'CAL', providerAccountId: 'oz', accountId: 'card', transactionDate: '2026-06-01',
  merchantName: 'M', amount: 10, currency: 'ILS', chargeAmount: 10, chargeCurrency: 'ILS',
  status: 'completed', dedupKey: 'k', localDedupStatus: 'unchanged', raw: {}, ...o,
});
const rl = (retryAfterMs) => ({ ok: false, classification: 'rate_limited', apiStatus: 429, retryAfterMs });
const ok = () => ({ ok: true, apiStatus: 201, financeTransactionId: 'fin' });

const run = (txs, opts = {}, deps = {}) => {
  const sleeps = [];
  const baseDeps = { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0, ...deps };
  return syncTransactionsToFinance(
    { consideredTransactions: txs, financeConfig: FIN, ledgerDir, reportsDir, sendDelayMs: 0, ...opts },
    baseDeps,
  ).then((r) => ({ r, sleeps }));
};

describe('finance rate-limit retry', () => {
  it('retries a 429 with backoff then succeeds, recording it as sent', async () => {
    let n = 0;
    const sender = async () => { n++; return n === 1 ? rl(null) : ok(); };
    const { r, sleeps } = await run([tx({ dedupKey: 'a' })], {}, { sendTransaction: sender });
    assert.equal(n, 2, 'one retry after the 429');
    assert.equal(r.counts.sent, 1);
    assert.equal(r.counts.failed, 0);
    assert.equal(r.counts.rateLimitedRetries, 1);
    assert.equal(r.counts.retryCount, 1);
    // backoff = min(max, base*2^0) + jitter(0) = 1000ms with default base
    assert.deepEqual(sleeps, [1000]);
  });

  it('respects Retry-After when the result provides retryAfterMs', async () => {
    let n = 0;
    const sender = async () => { n++; return n === 1 ? rl(2500) : ok(); };
    const { r, sleeps } = await run([tx({ dedupKey: 'b' })], {}, { sendTransaction: sender });
    assert.equal(r.counts.sent, 1);
    assert.deepEqual(sleeps, [2500], 'used Retry-After, not backoff');
  });

  it('leaves an exhausted 429 FAILED (not sent), and a later run retries it', async () => {
    const always429 = async () => rl(null);
    const { r } = await run([tx({ dedupKey: 'c' })], { rateLimitMaxRetries: 2 }, { sendTransaction: always429 });
    assert.equal(r.counts.sent, 0);
    assert.equal(r.counts.failed, 1);
    assert.equal(r.counts.rateLimitedFailed, 1);
    assert.equal(r.counts.rateLimitedRetries, 2, '1 initial + 2 retries = 3 attempts, 2 retries');
    assert.equal(r.rows[0].financeStatus, 'failed');
    assert.equal(r.rows[0].reason, 'rate_limited');

    // Rerun with a healthy API — the previously rate-limited tx is retried & sent.
    let n = 0;
    const okSender = async () => { n++; return ok(); };
    const { r: r2 } = await run([tx({ dedupKey: 'c' })], {}, { sendTransaction: okSender });
    assert.equal(r2.counts.sent, 1, 'a rate-limited failure is retryable on the next run');
    assert.equal(n, 1);
  });

  it('does not resend an already-sent transaction (no duplicate)', async () => {
    let n = 0;
    const sender = async () => { n++; return ok(); };
    await run([tx({ dedupKey: 'd' })], {}, { sendTransaction: sender });
    const { r: r2 } = await run([tx({ dedupKey: 'd' })], {}, { sendTransaction: sender });
    assert.equal(r2.counts.alreadySent, 1);
    assert.equal(r2.counts.sent, 0);
    assert.equal(n, 1, 'API not called again for an already-sent tx');
  });

  it('throttles between sends (sleep of sendDelayMs between, not before the first)', async () => {
    const sender = async () => ok();
    const { r, sleeps } = await run(
      [tx({ dedupKey: 'x' }), tx({ dedupKey: 'y' }), tx({ dedupKey: 'z' })],
      { sendDelayMs: 50 },
      { sendTransaction: sender },
    );
    assert.equal(r.counts.sent, 3);
    assert.deepEqual(sleeps, [50, 50], 'throttle applied between the 3 sends (2 gaps), not before the first');
  });
});
