/**
 * Unit tests for the desktop fetch orchestration service.
 *
 * Runs under plain Node (no Electron, no Playwright) by injecting fakes for the
 * credential store and the bridge-core fetchAllAccounts engine. Covers:
 *   - credential injection (decrypted creds reach the engine, in memory)
 *   - default / enabled account selection
 *   - global + per-account daysBack forwarding
 *   - missing credentials (empty strings passed; engine reports the error)
 *   - secret redaction (no plaintext secret in the returned result)
 *   - single-flight concurrency protection
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  createFetchLock,
  ConcurrentFetchError,
  selectAccounts,
  attachCredentials,
  runDesktopFetch,
} = require('../../../apps/desktop/fetchService.cjs');

// ── Stand-ins for the bridge-core selection helpers (same semantics) ──────────
const getDefaultAccount  = (a = []) => a.find(x => x && (x.isDefault || x.default)) ?? a[0] ?? null;
const getEnabledAccounts = (a = []) => a.filter(x => x && x.enabled !== false);
const validateDaysBack   = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 365
    ? { valid: true, value: n }
    : { valid: false, error: 'days back must be a whole number between 1 and 365' };
};

const fakeStore = (map = {}) => ({ getCredentials: (k) => map[k] ?? null });

const SETTINGS = {
  daysBack: 4,
  accounts: [
    { provider: 'cal', providerAccountId: 'oz',   displayName: 'Oz',   enabled: true,  default: true,  credentialKey: 'k-oz' },
    { provider: 'cal', providerAccountId: 'wife', displayName: 'Wife', enabled: true,  default: false, daysBack: 9, credentialKey: 'k-wife' },
    { provider: 'cal', providerAccountId: 'off',  displayName: 'Off',  enabled: false,                 credentialKey: 'k-off' },
  ],
};

// Fake engine that records the opts it received and echoes a success result.
function fakeFetchAll(captured = {}) {
  return async (opts) => {
    captured.opts = opts;
    return {
      accounts: opts.accounts.map(a => ({
        provider: a.provider,
        providerAccountId: a.providerAccountId,
        displayName: a.displayName,
        status: 'success',
        error: null,
        transactionsExported: 2,
        report: {
          status: 'success', sessionReused: false, transactionsFetched: 2,
          pendingSkippedCount: 0, transactionsSkipped: 0, createdCount: 2, updatedCount: 0,
          unchangedCount: 0, duplicatesSkipped: 0, newTransactionsExported: 2,
          exportPath: 'runtime/exports/cal_2026-06-19.json',
        },
      })),
      transactions: [],
      summary: {
        totalAccounts: opts.accounts.length,
        succeeded: opts.accounts.length,
        failed: 0,
        totalTransactionsExported: opts.accounts.length * 2,
      },
    };
  };
}

// ── selectAccounts ────────────────────────────────────────────────────────────

describe('fetchService — selectAccounts', () => {
  it('default mode picks the default account', () => {
    const sel = selectAccounts({ settings: SETTINGS, mode: 'default', getDefaultAccount, getEnabledAccounts });
    assert.deepEqual(sel.accounts.map(a => a.providerAccountId), ['oz']);
  });

  it('all mode picks only enabled accounts', () => {
    const sel = selectAccounts({ settings: SETTINGS, mode: 'all', getDefaultAccount, getEnabledAccounts });
    assert.deepEqual(sel.accounts.map(a => a.providerAccountId), ['oz', 'wife']); // 'off' excluded
  });

  it('returns an error when there is no default account', () => {
    const sel = selectAccounts({ settings: { accounts: [] }, mode: 'default', getDefaultAccount, getEnabledAccounts });
    assert.match(sel.error, /No accounts/);
  });

  it('returns an error when no accounts are enabled', () => {
    const sel = selectAccounts({
      settings: { accounts: [{ provider: 'cal', providerAccountId: 'x', enabled: false }] },
      mode: 'all', getDefaultAccount, getEnabledAccounts,
    });
    assert.match(sel.error, /enabled/i);
  });
});

// ── attachCredentials ─────────────────────────────────────────────────────────

describe('fetchService — attachCredentials', () => {
  it('injects decrypted credentials from the store', () => {
    const store = fakeStore({ 'k-oz': { username: 'ozuser', password: 'ozpass' } });
    const [acc] = attachCredentials({ accounts: [SETTINGS.accounts[0]], credentialStore: store });
    assert.deepEqual(acc.credentials, { username: 'ozuser', password: 'ozpass' });
  });

  it('uses empty credentials when none are stored', () => {
    const [acc] = attachCredentials({ accounts: [SETTINGS.accounts[0]], credentialStore: fakeStore() });
    assert.deepEqual(acc.credentials, { username: '', password: '' });
  });

  it('preserves per-account daysBack and normalizes missing override to null', () => {
    const [oz, wife] = attachCredentials({
      accounts: [SETTINGS.accounts[0], SETTINGS.accounts[1]],
      credentialStore: fakeStore(),
    });
    assert.equal(oz.daysBack, null);
    assert.equal(wife.daysBack, 9);
  });
});

// ── runDesktopFetch ────────────────────────────────────────────────────────────

describe('fetchService — runDesktopFetch', () => {
  it('injects decrypted credentials and the global daysBack into the engine call', async () => {
    const captured = {};
    const store = fakeStore({ 'k-oz': { username: 'ozuser', password: 'ozpass' } });
    const res = await runDesktopFetch({
      mode: 'default', daysBack: 5, settings: SETTINGS, credentialStore: store,
      fetchAllAccounts: fakeFetchAll(captured),
      getDefaultAccount, getEnabledAccounts, validateDaysBack,
    });

    assert.equal(res.ok, true);
    assert.equal(captured.opts.daysBack, 5);
    assert.equal(captured.opts.accounts[0].credentials.username, 'ozuser');
    assert.equal(captured.opts.accounts[0].credentials.password, 'ozpass');
  });

  it('forwards global daysBack from settings and preserves per-account override', async () => {
    const captured = {};
    await runDesktopFetch({
      mode: 'all', settings: SETTINGS, credentialStore: fakeStore(),
      fetchAllAccounts: fakeFetchAll(captured),
      getDefaultAccount, getEnabledAccounts, validateDaysBack,
    });

    assert.equal(captured.opts.daysBack, 4); // from settings.daysBack
    const oz   = captured.opts.accounts.find(a => a.providerAccountId === 'oz');
    const wife = captured.opts.accounts.find(a => a.providerAccountId === 'wife');
    assert.equal(oz.daysBack, null); // no override → engine applies the global value
    assert.equal(wife.daysBack, 9);  // per-account override preserved
  });

  it('passes empty credentials when none are stored (engine reports the error)', async () => {
    const captured = {};
    await runDesktopFetch({
      mode: 'default', settings: SETTINGS, credentialStore: fakeStore(),
      fetchAllAccounts: fakeFetchAll(captured),
      getDefaultAccount, getEnabledAccounts, validateDaysBack,
    });
    assert.deepEqual(captured.opts.accounts[0].credentials, { username: '', password: '' });
  });

  it('never returns decrypted secrets in the result', async () => {
    const store = fakeStore({ 'k-oz': { username: 'ozuser', password: 'TOPSECRET' } });
    const res = await runDesktopFetch({
      mode: 'default', daysBack: 5, settings: SETTINGS, credentialStore: store,
      fetchAllAccounts: fakeFetchAll({}),
      getDefaultAccount, getEnabledAccounts, validateDaysBack,
    });
    const blob = JSON.stringify(res);
    assert.doesNotMatch(blob, /TOPSECRET/);
    assert.doesNotMatch(blob, /ozuser/);
    // ...but the secret-free summary is present.
    assert.equal(res.accounts[0].exported, 2);
    assert.equal(res.accounts[0].exportPath, 'runtime/exports/cal_2026-06-19.json');
  });

  it('rejects an invalid daysBack before doing any work', async () => {
    const captured = {};
    const res = await runDesktopFetch({
      mode: 'all', daysBack: 0, settings: SETTINGS, credentialStore: fakeStore(),
      fetchAllAccounts: fakeFetchAll(captured),
      getDefaultAccount, getEnabledAccounts, validateDaysBack,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /days back/i);
    assert.equal(captured.opts, undefined); // engine never called
  });

  it('returns the selection error when no enabled accounts exist', async () => {
    const res = await runDesktopFetch({
      mode: 'all', daysBack: 5,
      settings: { daysBack: 5, accounts: [{ provider: 'cal', providerAccountId: 'x', enabled: false }] },
      credentialStore: fakeStore(), fetchAllAccounts: fakeFetchAll({}),
      getDefaultAccount, getEnabledAccounts, validateDaysBack,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /enabled/i);
  });
});

// ── Finance export integration ─────────────────────────────────────────────────

describe('fetchService — finance export', () => {
  // Fake bridge-core runFinanceExport that records the financeConfig it received.
  function fakeRunFinanceExport(captured = {}) {
    return async (opts) => {
      captured.opts = opts;
      return { sentCount: 2, qualifyingCount: 3, skipped: 1 };
    };
  }

  it('does NOT attempt finance export when disabled (CAL fetch still succeeds)', async () => {
    const captured = {};
    const res = await runDesktopFetch({
      mode: 'all', daysBack: 5, settings: SETTINGS, credentialStore: fakeStore(),
      fetchAllAccounts: fakeFetchAll({}),
      getDefaultAccount, getEnabledAccounts, validateDaysBack,
      financeConfig: { enabled: false, apiUrl: 'https://x', apiKey: 'tok' },
      runFinanceExport: fakeRunFinanceExport(captured),
    });
    assert.equal(res.ok, true);
    assert.equal(res.finance.enabled, false);
    assert.equal(res.finance.attempted, false);
    assert.equal(captured.opts, undefined, 'runFinanceExport must not be called when disabled');
  });

  it('injects decrypted finance credentials into runFinanceExport when enabled', async () => {
    const captured = {};
    const res = await runDesktopFetch({
      mode: 'all', daysBack: 5, settings: SETTINGS, credentialStore: fakeStore(),
      fetchAllAccounts: fakeFetchAll({}),
      getDefaultAccount, getEnabledAccounts, validateDaysBack,
      financeConfig: { enabled: true, apiUrl: 'https://fin.example/api', apiKey: 'sk_live_X' },
      runFinanceExport: fakeRunFinanceExport(captured),
    });
    assert.equal(res.finance.ok, true);
    assert.equal(res.finance.sent, 2);
    assert.deepEqual(captured.opts.financeConfig, { apiUrl: 'https://fin.example/api', apiKey: 'sk_live_X' });
    assert.equal(captured.opts.execute, true);
  });

  it('reports a clear error (no network) when enabled but the key is missing', async () => {
    const captured = {};
    const res = await runDesktopFetch({
      mode: 'all', daysBack: 5, settings: SETTINGS, credentialStore: fakeStore(),
      fetchAllAccounts: fakeFetchAll({}),
      getDefaultAccount, getEnabledAccounts, validateDaysBack,
      financeConfig: { enabled: true, apiUrl: 'https://fin.example/api', apiKey: '' },
      runFinanceExport: fakeRunFinanceExport(captured),
    });
    assert.equal(res.ok, true, 'the overall run still succeeds');
    assert.equal(res.finance.attempted, false);
    assert.equal(res.finance.ok, false);
    assert.match(res.finance.error, /no API key is saved/i);
    assert.equal(captured.opts, undefined, 'no send attempted without a key');
  });

  it('reports a finance failure without throwing, and never leaks the key', async () => {
    const failing = async () => { throw new Error('HTTP 500 — boom'); };
    const res = await runDesktopFetch({
      mode: 'all', daysBack: 5, settings: SETTINGS, credentialStore: fakeStore(),
      fetchAllAccounts: fakeFetchAll({}),
      getDefaultAccount, getEnabledAccounts, validateDaysBack,
      financeConfig: { enabled: true, apiUrl: 'https://fin.example/api', apiKey: 'sk_live_SECRET' },
      runFinanceExport: failing,
    });
    assert.equal(res.ok, true);
    assert.equal(res.finance.ok, false);
    assert.match(res.finance.error, /HTTP 500/);
    assert.doesNotMatch(JSON.stringify(res), /sk_live_SECRET/, 'finance key must not appear in the result');
  });

  it('emits finance-start/finance-done progress events (secret-free)', async () => {
    const events = [];
    await runDesktopFetch({
      mode: 'all', daysBack: 5, settings: SETTINGS, credentialStore: fakeStore(),
      fetchAllAccounts: fakeFetchAll({}),
      getDefaultAccount, getEnabledAccounts, validateDaysBack,
      onEvent: (e) => events.push(e),
      financeConfig: { enabled: true, apiUrl: 'https://fin.example/api', apiKey: 'sk_live_SECRET' },
      runFinanceExport: fakeRunFinanceExport({}),
    });
    assert.ok(events.some(e => e.type === 'finance-start'));
    assert.ok(events.some(e => e.type === 'finance-done' && e.sent === 2));
    assert.doesNotMatch(JSON.stringify(events), /sk_live_SECRET/);
  });
});

// ── createFetchLock (concurrency protection) ───────────────────────────────────

describe('fetchService — createFetchLock', () => {
  it('runs one task and rejects a concurrent task while in flight', async () => {
    const lock = createFetchLock();
    let release;
    const gate = new Promise(r => { release = r; });

    const p1 = lock.run(async () => { await gate; return 'first'; });
    assert.equal(lock.isRunning(), true);

    await assert.rejects(() => lock.run(async () => 'second'), ConcurrentFetchError);

    release();
    assert.equal(await p1, 'first');
    assert.equal(lock.isRunning(), false);

    // Reusable once the prior task settles.
    assert.equal(await lock.run(async () => 'third'), 'third');
  });

  it('releases the lock even when the task throws', async () => {
    const lock = createFetchLock();
    await assert.rejects(() => lock.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(lock.isRunning(), false);
  });
});
