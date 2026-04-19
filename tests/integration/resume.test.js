/**
 * Integration tests for Phase 4 — checkpointing, resume, deduplication,
 * and incremental fetch behavior.
 *
 * All tests use injected fakes; no browser or filesystem access.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTransactions } from '../../src/application/fetchTransactions.js';
import { fingerprint } from '../../src/infrastructure/dedup.js';
import { createFakeProvider } from '../helpers/fakeProvider.js';
import { FakeBrowserManager } from '../helpers/fakeBrowserManager.js';
import { FakeSessionStore } from '../helpers/fakeSessionStore.js';
import { FakeCheckpointStore } from '../helpers/fakeCheckpointStore.js';
import { FakeSeenStore } from '../helpers/fakeSeenStore.js';
import { sampleTransactions } from '../fixtures/transactions.js';
import { createTransaction } from '../../src/schema/transaction.js';

const TEST_CREDS = { username: 'u', password: 'p', accountId: 'test-account' };

function makeDeps({
  providerOpts    = {},
  sessionState    = null,
  checkpoint      = null,
  seenFingerprints = [],
} = {}) {
  return {
    provider:        createFakeProvider(providerOpts),
    browser:         new FakeBrowserManager(),
    sessionStore:    new FakeSessionStore(sessionState),
    checkpointStore: new FakeCheckpointStore(checkpoint),
    seenStore:       new FakeSeenStore(seenFingerprints),
    retryDelay:      0,
  };
}

// ── Checkpoint lifecycle ──────────────────────────────────────────────────────

describe('checkpoint lifecycle', () => {
  it('checkpoint is cleared on successful completion', async () => {
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
    });

    await fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps);

    assert.equal(deps.checkpointStore.cleared, true, 'checkpoint should be cleared on success');
  });

  it('checkpoint is saved during fetch (onProgress called per transaction)', async () => {
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
    });

    await fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps);

    // onProgress fires once per transaction, so saved.length == sampleTransactions.length
    assert.equal(deps.checkpointStore.saved.length, sampleTransactions.length);
  });

  it('checkpoint nextIndex advances with each transaction', async () => {
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
    });

    await fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps);

    const saves = deps.checkpointStore.saved;
    assert.equal(saves[0].checkpoint.nextIndex, 1);
    assert.equal(saves[1].checkpoint.nextIndex, 2);
  });

  it('checkpoint is NOT cleared on failure', async () => {
    const deps = makeDeps({
      providerOpts: { fetchError: new Error('network failure') },
    });

    await assert.rejects(
      () => fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps)
    );

    assert.equal(deps.checkpointStore.cleared, false, 'checkpoint must be preserved on failure');
  });
});

// ── Resume ────────────────────────────────────────────────────────────────────

describe('resume from checkpoint', () => {
  it('ignores checkpoint when resume: false (default)', async () => {
    const checkpoint = {
      provider: 'cal', accountId: 'test-account',
      nextIndex: 5, transactions: [sampleTransactions[0]], warnings: [],
    };
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
      checkpoint,
    });

    const { report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true, resume: false },
      deps
    );

    assert.equal(report.resumed, false);
    assert.equal(report.checkpointUsed, false);
    // Provider called with startIndex=0 (ignored checkpoint)
    assert.equal(deps.provider.fetchCallCount, 1);
  });

  it('uses checkpoint when resume: true and checkpoint exists', async () => {
    const priorTx = createTransaction({
      provider: 'CAL', accountId: 'Visa 1234',
      transactionDate: '2026-04-10', merchantName: 'OldShop',
      amount: 10, currency: 'ILS', transactionType: 'רגיל',
    });
    const checkpoint = {
      provider: 'cal', accountId: 'test-account',
      nextIndex: 1,
      transactions: [priorTx],
      warnings: ['prior warning'],
    };
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
      checkpoint,
    });

    const { report, transactions } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true, resume: true },
      deps
    );

    assert.equal(report.resumed, true);
    assert.equal(report.checkpointUsed, true);
    assert.ok(report.checkpointPath, 'checkpointPath should be set');
    // Prior transaction merged into results
    assert.ok(transactions.some(t => t.merchantName === 'OldShop'), 'prior transaction should be in result');
    // Prior warning carried forward
    assert.ok(report.warnings.includes('prior warning'));
  });

  it('starts fresh when resume: true but no checkpoint exists', async () => {
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
      checkpoint: null, // no checkpoint
    });

    const { report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true, resume: true },
      deps
    );

    assert.equal(report.resumed, false);
    assert.equal(report.checkpointUsed, false);
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe('deduplication — already-seen transactions', () => {
  it('excludes already-seen transactions from export', async () => {
    // Mark the first sample transaction as already seen
    const fp = fingerprint(sampleTransactions[0]);
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
      seenFingerprints: [fp],
    });

    const { transactions, report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(report.alreadySeenCount, 1, 'one transaction should be marked already-seen');
    assert.equal(transactions.length, sampleTransactions.length - 1, 'already-seen excluded from result');
    assert.equal(report.newTransactionsExported, sampleTransactions.length - 1);
  });

  it('exports all transactions when none are in seen store', async () => {
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
    });

    const { transactions, report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(report.alreadySeenCount, 0);
    assert.equal(transactions.length, sampleTransactions.length);
  });

  it('adds new transaction fingerprints to seen store after run', async () => {
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
    });

    await fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps);

    assert.equal(deps.seenStore.saved, true, 'seen store should be saved');
    // All new transactions should now be in the seen store
    for (const tx of sampleTransactions) {
      assert.equal(deps.seenStore.has(fingerprint(tx)), true, `${tx.merchantName} should be in seen store`);
    }
  });

  it('fullFetch: true exports all transactions ignoring seen store', async () => {
    const fp = fingerprint(sampleTransactions[0]);
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
      seenFingerprints: [fp],
    });

    const { transactions, report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true, fullFetch: true },
      deps
    );

    assert.equal(report.alreadySeenCount, 0, 'fullFetch should ignore seen store');
    assert.equal(transactions.length, sampleTransactions.length, 'all transactions exported');
  });

  it('within-run duplicates are counted in duplicatesSkipped', async () => {
    // Provider returns the same transaction twice (unusual but possible edge case)
    const dupTx = sampleTransactions[0];
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: [dupTx, dupTx], warnings: [] } },
    });

    const { transactions, report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(report.duplicatesSkipped, 1, 'one duplicate should be skipped');
    assert.equal(transactions.length, 1, 'deduplicated to one transaction');
  });
});

// ── Incremental early stop ────────────────────────────────────────────────────

describe('incremental early stop', () => {
  // Build 5 transactions: first 2 are new, last 3 are already-seen
  const tx = (n) => createTransaction({
    provider: 'CAL', accountId: 'Visa 1234',
    transactionDate: `2026-04-${String(n).padStart(2, '0')}`,
    merchantName: `Shop ${n}`,
    amount: n * 10,
    currency: 'ILS',
    transactionType: 'רגיל',
  });

  const txList = [tx(5), tx(4), tx(3), tx(2), tx(1)]; // newest-first

  it('stops early when earlyStopThreshold consecutive already-seen transactions reached', async () => {
    // Mark tx(3), tx(2), tx(1) as already seen (the last 3 in the list)
    const seenFps = [tx(3), tx(2), tx(1)].map(fingerprint);
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: txList, warnings: [] } },
      seenFingerprints: seenFps,
    });

    const { report } = await fetchTransactions(
      {
        credentials: TEST_CREDS,
        skipExport: true,
        incremental: true,
        earlyStopThreshold: 3,
      },
      deps
    );

    assert.equal(report.earlyStopTriggered, true, 'early stop should be triggered');
    assert.ok(report.earlyStopReason, 'earlyStopReason should be set');
  });

  it('does not stop early when incremental: false', async () => {
    const seenFps = [tx(3), tx(2), tx(1)].map(fingerprint);
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: txList, warnings: [] } },
      seenFingerprints: seenFps,
    });

    const { report } = await fetchTransactions(
      {
        credentials: TEST_CREDS,
        skipExport: true,
        incremental: false,
      },
      deps
    );

    assert.equal(report.earlyStopTriggered, false, 'early stop should NOT trigger');
    // All 5 transactions considered (even if 3 are already-seen)
    assert.equal(report.totalTransactionsConsidered, txList.length);
  });

  it('consecutive counter resets when a new transaction is encountered', async () => {
    // Interleaved: new, seen, seen, new, seen — threshold=3 should NOT trigger
    const seenFps = [fingerprint(tx(4)), fingerprint(tx(3)), fingerprint(tx(1))];
    const mixedList = [tx(5), tx(4), tx(3), tx(2), tx(1)];
    //                 new    seen   seen   new    seen   ← consecutive max is 2 (after tx(2) resets)
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: mixedList, warnings: [] } },
      seenFingerprints: seenFps,
    });

    const { report } = await fetchTransactions(
      {
        credentials: TEST_CREDS,
        skipExport: true,
        incremental: true,
        earlyStopThreshold: 3,
      },
      deps
    );

    assert.equal(report.earlyStopTriggered, false, 'should not stop — consecutive never hit 3');
  });
});

// ── Report fields ─────────────────────────────────────────────────────────────

describe('run report — Phase 4 fields', () => {
  it('report includes all Phase 4 fields on a fresh successful run', async () => {
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
    });

    const { report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(typeof report.resumed, 'boolean');
    assert.equal(typeof report.checkpointUsed, 'boolean');
    assert.equal(typeof report.alreadySeenCount, 'number');
    assert.equal(typeof report.duplicatesSkipped, 'number');
    assert.equal(typeof report.newTransactionsExported, 'number');
    assert.equal(typeof report.totalTransactionsConsidered, 'number');
    assert.equal(typeof report.earlyStopTriggered, 'boolean');

    assert.equal(report.resumed, false);
    assert.equal(report.checkpointUsed, false);
    assert.equal(report.checkpointPath, null);
    assert.equal(report.earlyStopTriggered, false);
    assert.equal(report.earlyStopReason, null);
    assert.equal(report.newTransactionsExported, sampleTransactions.length);
    assert.equal(report.totalTransactionsConsidered, sampleTransactions.length);
  });
});
