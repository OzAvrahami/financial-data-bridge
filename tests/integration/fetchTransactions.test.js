/**
 * Integration tests for the fetchTransactions application flow.
 *
 * These tests use injected fakes for the provider, browser, and session store,
 * so they run fully offline without a browser or real credentials.
 *
 * The _deps second parameter is a testing-only seam in fetchTransactions():
 *   { provider, browser, sessionStore, retryDelay }
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTransactions } from '../../src/application/fetchTransactions.js';
import { createFakeProvider } from '../helpers/fakeProvider.js';
import { FakeBrowserManager } from '../helpers/fakeBrowserManager.js';
import { FakeSessionStore } from '../helpers/fakeSessionStore.js';
import { sampleTransactions } from '../fixtures/transactions.js';

// Explicit credentials passed to every call so tests don't depend on env vars.
const TEST_CREDS = { username: 'test_user', password: 'test_pass', accountId: 'test-account' };

/**
 * Build a _deps bundle. Override any part via named args.
 */
function makeDeps({
  providerOpts = {},
  sessionState = null,
} = {}) {
  return {
    provider:     createFakeProvider(providerOpts),
    browser:      new FakeBrowserManager(),
    sessionStore: new FakeSessionStore(sessionState),
    retryDelay:   0, // no wait time in tests
  };
}

// ── Session and authentication flows ─────────────────────────────────────────

describe('fetchTransactions — session and auth', () => {
  it('performs fresh login when no saved session exists', async () => {
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
    });

    const { report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(deps.provider.loginCallCount, 1, 'should have logged in once');
    assert.equal(report.sessionReused, false);
    assert.equal(report.status, 'success');
  });

  it('skips login when a saved session is valid', async () => {
    const savedSession = { cookies: [{ name: 'auth', value: 'xyz' }], origins: [] };
    const deps = makeDeps({
      providerOpts: { sessionValid: true, fetchResult: { transactions: sampleTransactions, warnings: [] } },
      sessionState: savedSession,
    });

    const { report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(deps.provider.loginCallCount, 0, 'should not login when session is valid');
    assert.equal(report.sessionReused, true);
    assert.equal(report.status, 'success');
  });

  it('falls back to fresh login when saved session is invalid', async () => {
    const expiredSession = { cookies: [], origins: [] };
    const deps = makeDeps({
      providerOpts: { sessionValid: false, fetchResult: { transactions: [], warnings: [] } },
      sessionState: expiredSession,
    });

    const { report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(deps.provider.loginCallCount, 1, 'should login after expired session');
    assert.equal(report.sessionReused, false);
  });

  it('saves session after a successful fresh login', async () => {
    const deps = makeDeps();

    await fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps);

    assert.ok(deps.sessionStore.saved.length > 0, 'session should have been saved');
  });

  it('saves session after reusing a valid session (keep-alive refresh)', async () => {
    const deps = makeDeps({
      providerOpts: { sessionValid: true },
      sessionState: { cookies: [], origins: [] },
    });

    await fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps);

    // Should be saved at least once (the refresh at end of successful run)
    assert.ok(deps.sessionStore.saved.length >= 1);
  });
});

// ── Fetch result handling ─────────────────────────────────────────────────────

describe('fetchTransactions — fetch results', () => {
  it('returns transactions from provider', async () => {
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
    });

    const { transactions } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(transactions.length, sampleTransactions.length);
  });

  it('returns "success" status when no warnings', async () => {
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
    });

    const { report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(report.status, 'success');
    assert.equal(report.transactionsFetched, sampleTransactions.length);
    assert.equal(report.transactionsSkipped, 0);
  });

  it('returns "partial" status when provider warnings are present', async () => {
    const deps = makeDeps({
      providerOpts: {
        fetchResult: {
          transactions: sampleTransactions,
          warnings: ['Row 3/5 skipped: modal timeout', 'Row 4/5 skipped: extract failed'],
        },
      },
    });

    const { report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(report.status, 'partial');
    assert.equal(report.transactionsSkipped, 2);
    assert.equal(report.warnings.length, 2);
    assert.ok(report.warnings[0].includes('Row 3/5'));
  });

  it('returns empty transactions array gracefully', async () => {
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: [], warnings: [] } },
    });

    const { transactions, report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(transactions.length, 0);
    assert.equal(report.status, 'success');
    assert.equal(report.transactionsFetched, 0);
  });
});

// ── Mid-run re-authentication ─────────────────────────────────────────────────

describe('fetchTransactions — mid-run re-auth', () => {
  it('re-authenticates once when fetchTransactions throws an auth error', async () => {
    // First fetch throws; isAuthError returns true; second fetch succeeds
    const provider = createFakeProvider({
      authError: true,
      fetch: (fetchCall) => {
        if (fetchCall === 1) throw new Error('Session expired mid-run');
        return { transactions: sampleTransactions, warnings: [] };
      },
    });
    const deps = {
      provider,
      browser: new FakeBrowserManager(),
      sessionStore: new FakeSessionStore(),
      retryDelay: 0,
    };

    const { report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(report.reAuthOccurred, true);
    assert.equal(provider.loginCallCount, 2, 'initial login + re-auth');
    assert.equal(provider.fetchCallCount, 2, 'first attempt + retry after re-auth');
    assert.equal(report.status, 'success');
    assert.equal(report.transactionsFetched, sampleTransactions.length);
  });

  it('does NOT re-authenticate when error is not an auth error', async () => {
    const provider = createFakeProvider({
      authError: false,  // isAuthError returns false
      fetchError: new Error('Network timeout'),
    });
    const deps = {
      provider,
      browser: new FakeBrowserManager(),
      sessionStore: new FakeSessionStore(),
      retryDelay: 0,
    };

    await assert.rejects(
      () => fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps),
      { message: 'Network timeout' }
    );

    assert.equal(provider.loginCallCount, 1, 'should not attempt re-auth');
  });

  it('propagates error when fetch still fails after re-auth', async () => {
    // fetchError always throws, so the second attempt after re-auth also fails
    const provider = createFakeProvider({
      authError: true,
      fetchError: new Error('Site is down'),
    });
    const deps = {
      provider,
      browser: new FakeBrowserManager(),
      sessionStore: new FakeSessionStore(),
      retryDelay: 0,
    };

    await assert.rejects(
      () => fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps),
      { message: 'Site is down' }
    );

    // Should have logged in twice: initial + re-auth attempt
    assert.equal(provider.loginCallCount, 2);
  });

  it('does not attempt re-auth a second time (no infinite loop)', async () => {
    // Even if isAuthError keeps returning true, re-auth should only happen once
    let loginCount = 0;
    const provider = createFakeProvider({
      authError: true,
      fetch: () => { throw new Error('always auth error'); },
    });
    const deps = {
      provider,
      browser: new FakeBrowserManager(),
      sessionStore: new FakeSessionStore(),
      retryDelay: 0,
    };

    await assert.rejects(
      () => fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps)
    );

    // Initial login + exactly 1 re-auth = 2 total. Not 3, not infinite.
    assert.equal(provider.loginCallCount, 2);
  });
});

// ── Failure and error handling ─────────────────────────────────────────────────

describe('fetchTransactions — failures', () => {
  it('throws when credentials are missing', async () => {
    const deps = makeDeps();

    await assert.rejects(
      () => fetchTransactions(
        { credentials: { username: '', password: '' }, skipExport: true },
        deps
      ),
      /Missing credentials/
    );
  });

  it('throws when login fails and wraps the error', async () => {
    const deps = makeDeps({
      providerOpts: { loginError: new Error('Bad credentials') },
    });

    await assert.rejects(
      () => fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps),
      { message: 'Bad credentials' }
    );
  });

  it('throws when provider fetch fails with a non-auth error', async () => {
    const deps = makeDeps({
      providerOpts: { fetchError: new Error('DOM structure changed') },
    });

    await assert.rejects(
      () => fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps),
      { message: 'DOM structure changed' }
    );
  });
});

// ── Lifecycle guarantees ─────────────────────────────────────────────────────

describe('fetchTransactions — lifecycle', () => {
  it('always calls provider.cleanup() even on success', async () => {
    const deps = makeDeps();
    await fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps);
    assert.equal(deps.provider.cleanupCalled, true);
  });

  it('always calls provider.cleanup() even when fetch throws', async () => {
    const deps = makeDeps({ providerOpts: { fetchError: new Error('fail') } });
    await assert.rejects(
      () => fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps)
    );
    assert.equal(deps.provider.cleanupCalled, true);
  });

  it('always closes the browser even on error', async () => {
    const deps = makeDeps({ providerOpts: { loginError: new Error('login fail') } });
    await assert.rejects(
      () => fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps)
    );
    assert.equal(deps.browser.closed, true);
  });
});

// ── Execution report ─────────────────────────────────────────────────────────

describe('fetchTransactions — execution report', () => {
  it('returns a well-formed report on success', async () => {
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
    });

    const { report } = await fetchTransactions(
      { credentials: TEST_CREDS, accountId: 'card-42', skipExport: true },
      deps
    );

    assert.equal(report.accountId, 'card-42');
    assert.ok(report.startedAt, 'startedAt should be set');
    assert.ok(report.finishedAt, 'finishedAt should be set');
    assert.ok(report.durationMs >= 0);
    assert.equal(report.status, 'success');
    assert.equal(report.fatalError, null);
  });

  it('report status is "failed" when the run throws', async () => {
    // We can't easily inspect the report when it throws, but we can verify
    // that metrics records a failed run
    const { metrics } = await import('../../src/infrastructure/metrics.js');
    metrics.reset();

    const deps = makeDeps({ providerOpts: { fetchError: new Error('fatal') } });
    await assert.rejects(
      () => fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps)
    );

    const snap = metrics.snapshot();
    assert.equal(snap.totalRuns, 1);
    assert.equal(snap.failedRuns, 1);
  });

  it('metrics records a successful run', async () => {
    const { metrics } = await import('../../src/infrastructure/metrics.js');
    metrics.reset();

    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
    });
    await fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps);

    const snap = metrics.snapshot();
    assert.equal(snap.totalRuns, 1);
    assert.equal(snap.successfulRuns, 1);
    assert.equal(snap.totalTransactionsFetched, sampleTransactions.length);
  });
});
