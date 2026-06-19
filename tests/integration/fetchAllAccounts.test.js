/**
 * Integration tests for the sequential multi-account fetch flow.
 *
 * Uses injected fakes (per account) so the tests run fully offline. Covers:
 *   - combined multi-account result shape
 *   - per-account isolation of seen/sync state
 *   - source-account-scoped dedup identity (same identity, different accounts → no collision)
 *   - exported transactions carry provider / providerAccountId metadata
 *   - one account failing does not abort the others
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllAccounts } from '../../packages/bridge-core/src/application/fetchAllAccounts.js';
import { fetchTransactions } from '../../packages/bridge-core/src/application/fetchTransactions.js';
import { createFakeProvider } from '../helpers/fakeProvider.js';
import { FakeBrowserManager } from '../helpers/fakeBrowserManager.js';
import { FakeSessionStore } from '../helpers/fakeSessionStore.js';
import { FakeCheckpointStore } from '../helpers/fakeCheckpointStore.js';
import { FakeSeenStore } from '../helpers/fakeSeenStore.js';
import { SeenStore, fingerprint } from '../../packages/bridge-core/src/infrastructure/dedup.js';
import { sampleTransactions } from '../fixtures/transactions.js';

// Fresh deep copies per account so in-place metadata stamping never leaks between accounts.
const cloneTxns = arr => arr.map(t => ({ ...t, raw: { ...t.raw } }));

const TWO_CAL_ACCOUNTS = [
  { provider: 'cal', providerAccountId: 'oz_cal',   displayName: 'Oz CAL',   credentials: { username: 'oz', password: 'p1' } },
  { provider: 'cal', providerAccountId: 'wife_cal', displayName: 'Wife CAL', credentials: { username: 'wife', password: 'p2' } },
];

// Build a per-account deps factory; each account gets its own fakes + seen store.
function depsFactory({ seenStores = {}, fail = {} } = {}) {
  return (account) => {
    const seenStore = seenStores[account.providerAccountId] ?? new FakeSeenStore();
    seenStores[account.providerAccountId] = seenStore;
    return {
      provider: createFakeProvider({
        loginError: fail[account.providerAccountId] ? new Error('Bad credentials') : undefined,
        fetchResult: { transactions: cloneTxns(sampleTransactions), warnings: [] },
      }),
      browser:         new FakeBrowserManager(),
      sessionStore:    new FakeSessionStore(),
      checkpointStore: new FakeCheckpointStore(),
      seenStore,
      retryDelay:      0,
    };
  };
}

describe('fetchAllAccounts — combined result shape', () => {
  it('runs every account and aggregates results', async () => {
    const combined = await fetchAllAccounts(
      { accounts: TWO_CAL_ACCOUNTS, skipExport: true },
      depsFactory()
    );

    assert.equal(combined.accounts.length, 2);
    assert.equal(combined.summary.totalAccounts, 2);
    assert.equal(combined.summary.succeeded, 2);
    assert.equal(combined.summary.failed, 0);
    // Each account exports both sample transactions → 4 combined.
    assert.equal(combined.transactions.length, 4);
    assert.equal(combined.summary.totalTransactionsExported, 4);

    const ids = combined.accounts.map(a => a.providerAccountId);
    assert.deepEqual(ids, ['oz_cal', 'wife_cal']); // sequential, in order
    for (const acc of combined.accounts) {
      assert.equal(acc.status, 'success');
      assert.equal(acc.report.providerAccountId, acc.providerAccountId);
    }
  });
});

describe('fetchAllAccounts — exported transactions carry source metadata', () => {
  it('stamps provider / providerAccountId / displayName on every transaction', async () => {
    const combined = await fetchAllAccounts(
      { accounts: TWO_CAL_ACCOUNTS, skipExport: true },
      depsFactory()
    );

    const oz   = combined.accounts.find(a => a.providerAccountId === 'oz_cal');
    const wife = combined.accounts.find(a => a.providerAccountId === 'wife_cal');

    for (const tx of oz.transactions) {
      assert.equal(tx.providerAccountId, 'oz_cal');
      assert.equal(tx.providerDisplayName, 'Oz CAL');
      assert.equal(tx.provider, 'CAL'); // provider-set value preserved
    }
    for (const tx of wife.transactions) {
      assert.equal(tx.providerAccountId, 'wife_cal');
      assert.equal(tx.providerDisplayName, 'Wife CAL');
    }
  });
});

describe('fetchAllAccounts — source-account-scoped dedup identity', () => {
  it('does not let identical identities from two accounts collide', async () => {
    const seenStores = {};
    const combined = await fetchAllAccounts(
      { accounts: TWO_CAL_ACCOUNTS, skipExport: true },
      depsFactory({ seenStores })
    );

    // Same business fields → identical fingerprint in both accounts...
    const baseFp = fingerprint(sampleTransactions[0]);

    // ...yet each account classified it as NEW independently (separate namespaces).
    for (const acc of combined.accounts) {
      assert.equal(acc.report.createdCount, sampleTransactions.length,
        `${acc.providerAccountId} should treat its transactions as created`);
    }

    // Each account has its OWN seen store, and each stored that fingerprint.
    assert.notEqual(seenStores.oz_cal, seenStores.wife_cal, 'separate seen stores per account');
    assert.ok(seenStores.oz_cal.has(baseFp),   'oz_cal seen store holds the key');
    assert.ok(seenStores.wife_cal.has(baseFp), 'wife_cal seen store holds the key');
  });
});

describe('SeenStore — separate state path per provider/account', () => {
  it('produces a distinct file path per provider + providerAccountId', () => {
    const store = new SeenStore('runtime/seen');
    const ozCal   = store.filePath('cal', 'oz_cal');
    const wifeCal = store.filePath('cal', 'wife_cal');
    const ozMax   = store.filePath('max', 'oz_max');

    assert.notEqual(ozCal, wifeCal);
    assert.notEqual(ozCal, ozMax);
    assert.notEqual(wifeCal, ozMax);
  });

  it('keeps the default-account path unsuffixed (backward compatibility)', () => {
    const store = new SeenStore('runtime/seen');
    assert.match(store.filePath('cal', 'default'), /cal\.json$/);   // no suffix for default
    assert.match(store.filePath('cal'),            /cal\.json$/);
  });
});

describe('fetchAllAccounts — failure isolation & backward compatibility', () => {
  it('records a failed account without aborting the rest', async () => {
    const combined = await fetchAllAccounts(
      { accounts: TWO_CAL_ACCOUNTS, skipExport: true },
      depsFactory({ fail: { oz_cal: true } })
    );

    const oz   = combined.accounts.find(a => a.providerAccountId === 'oz_cal');
    const wife = combined.accounts.find(a => a.providerAccountId === 'wife_cal');

    assert.equal(oz.status, 'failed');
    assert.match(oz.error, /Bad credentials/);
    assert.equal(wife.status, 'success'); // the other account still ran
    assert.equal(combined.summary.failed, 1);
    assert.equal(combined.summary.succeeded, 1);
  });

  it('single default account flow still returns the legacy single-run shape', async () => {
    // The default account from loadSourceAccounts behaves exactly like one fetch.
    const oneAccount = [{ provider: 'cal', providerAccountId: 'default', displayName: 'CAL (default)', credentials: { username: 'u', password: 'p' } }];
    const combined = await fetchAllAccounts(
      { accounts: oneAccount, skipExport: true },
      depsFactory()
    );
    assert.equal(combined.accounts.length, 1);
    assert.equal(combined.accounts[0].providerAccountId, 'default');
    assert.equal(combined.accounts[0].report.accountId, 'default'); // legacy alias preserved
  });
});

// Sanity: the single-account fetchTransactions still stamps providerAccountId.
describe('fetchTransactions — single-account metadata stamping', () => {
  it('stamps providerAccountId from the accountId alias', async () => {
    const deps = {
      provider: createFakeProvider({ fetchResult: { transactions: cloneTxns(sampleTransactions), warnings: [] } }),
      browser: new FakeBrowserManager(),
      sessionStore: new FakeSessionStore(),
      checkpointStore: new FakeCheckpointStore(),
      seenStore: new FakeSeenStore(),
      retryDelay: 0,
    };
    const { transactions, report } = await fetchTransactions(
      { credentials: { username: 'u', password: 'p' }, accountId: 'card-42', skipExport: true },
      deps
    );
    assert.equal(report.providerAccountId, 'card-42');
    for (const tx of transactions) assert.equal(tx.providerAccountId, 'card-42');
  });
});
