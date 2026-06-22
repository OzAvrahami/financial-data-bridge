/**
 * Integration tests for Phase 4 — checkpointing, resume, deduplication,
 * and full-range scanning (the entire requested window is always inspected).
 *
 * All tests use injected fakes; no browser or filesystem access.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTransactions } from '../../packages/bridge-core/src/application/fetchTransactions.js';
import { fingerprint, contentHash } from '../../packages/bridge-core/src/infrastructure/dedup.js';
import { createFakeProvider } from '../helpers/fakeProvider.js';
import { FakeBrowserManager } from '../helpers/fakeBrowserManager.js';
import { FakeSessionStore } from '../helpers/fakeSessionStore.js';
import { FakeCheckpointStore } from '../helpers/fakeCheckpointStore.js';
import { FakeSeenStore } from '../helpers/fakeSeenStore.js';
import { sampleTransactions } from '../fixtures/transactions.js';
import { createTransaction } from '../../packages/bridge-core/src/schema/transaction.js';

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

describe('deduplication — unchanged transactions', () => {
  it('excludes unchanged transactions from export', async () => {
    // Seed the first sample transaction as seen with matching contentHash → unchanged
    const fp = fingerprint(sampleTransactions[0]);
    const ch = contentHash(sampleTransactions[0]);
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
      seenFingerprints: [fp], // legacy null-hash entry → classified as unchanged
    });

    const { transactions, report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(report.unchangedCount, 1, 'one transaction should be unchanged');
    assert.equal(report.createdCount, sampleTransactions.length - 1);
    assert.equal(transactions.length, sampleTransactions.length - 1, 'unchanged excluded from result');
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

    assert.equal(report.unchangedCount, 0);
    assert.equal(report.createdCount, sampleTransactions.length);
    assert.equal(transactions.length, sampleTransactions.length);
  });

  it('upserts exported transactions into seen store after run', async () => {
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: sampleTransactions, warnings: [] } },
    });

    await fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps);

    assert.equal(deps.seenStore.saved, true, 'seen store should be saved');
    for (const tx of sampleTransactions) {
      assert.equal(deps.seenStore.has(fingerprint(tx)), true, `${tx.merchantName} should be in seen store`);
      const entry = deps.seenStore.lookup(fingerprint(tx));
      assert.ok(entry?.contentHash, 'entry should have a non-null contentHash after run');
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

    assert.equal(report.unchangedCount, 0, 'fullFetch should ignore seen store');
    assert.equal(transactions.length, sampleTransactions.length, 'all transactions exported');
  });

  it('within-run duplicates are counted in duplicatesSkipped', async () => {
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

// ── Full-range scan (no early stop) ─────────────────────────────────────────────
//
// The seen/dedup state decides only whether a transaction is exported — never
// whether scanning continues. The entire requested range is always inspected.

describe('full-range scan — no early stop', () => {
  const tx = (n) => createTransaction({
    provider: 'CAL', accountId: 'Visa 1234',
    transactionDate: `2026-04-${String(n).padStart(2, '0')}`,
    merchantName: `Shop ${n}`,
    amount: n * 10,
    currency: 'ILS',
    transactionType: 'רגיל',
  });

  it('inspects every row even when all rows are already seen (unchanged)', async () => {
    const txList = [tx(5), tx(4), tx(3), tx(2), tx(1)];
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: txList, warnings: [] } },
      seenFingerprints: txList.map(fingerprint), // all already seen
    });

    const { report } = await fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps);

    // Provider returned/processed every row; nothing stopped the scan.
    assert.equal(report.transactionsFetched, txList.length);
    assert.equal(report.totalTransactionsConsidered, txList.length);
    assert.equal(report.unchangedCount, txList.length);
    assert.equal(report.createdCount, 0);
  });

  it('discovers a new transaction at the END of a long already-seen streak', async () => {
    // 10 rows; seed the first 9 as already-seen, leave the 10th (oldest) new.
    // With the old threshold=3 early-stop this would have stopped after 3 unchanged
    // and never reached the new row. Now it must be discovered and exported.
    const txList = [tx(10), tx(9), tx(8), tx(7), tx(6), tx(5), tx(4), tx(3), tx(2), tx(1)];
    const seenFps = txList.slice(0, 9).map(fingerprint); // first 9 unchanged
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: txList, warnings: [] } },
      seenFingerprints: seenFps,
    });

    const { transactions, report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(report.totalTransactionsConsidered, txList.length, 'whole window scanned');
    assert.equal(report.unchangedCount, 9);
    assert.equal(report.createdCount, 1, 'the trailing new row was discovered');
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].merchantName, 'Shop 1');
  });

  it('ignores any value returned by the provider onProgress callback (cannot stop the scan)', async () => {
    // Even if a provider's onProgress were to return false, the application no
    // longer breaks: it processes the full set. The fake mirrors this contract.
    const txList = [tx(3), tx(2), tx(1)];
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: txList, warnings: [] } },
    });

    const { report } = await fetchTransactions({ credentials: TEST_CREDS, skipExport: true }, deps);
    assert.equal(report.transactionsFetched, txList.length);
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
    assert.equal(typeof report.createdCount, 'number');
    assert.equal(typeof report.updatedCount, 'number');
    assert.equal(typeof report.unchangedCount, 'number');
    assert.equal(typeof report.duplicatesSkipped, 'number');
    assert.equal(typeof report.newTransactionsExported, 'number');
    assert.equal(typeof report.totalTransactionsConsidered, 'number');

    assert.equal(report.resumed, false);
    assert.equal(report.checkpointUsed, false);
    assert.equal(report.checkpointPath, null);
    // Fresh run: everything is new
    assert.equal(report.createdCount, sampleTransactions.length);
    assert.equal(report.updatedCount, 0);
    assert.equal(report.unchangedCount, 0);
    assert.equal(report.newTransactionsExported, sampleTransactions.length);
    assert.equal(report.totalTransactionsConsidered, sampleTransactions.length);
  });
});

// ── Update-aware deduplication ────────────────────────────────────────────────

describe('update-aware deduplication', () => {
  // A transaction that starts as pending and later settles (content changes)
  const pendingTx = createTransaction({
    provider: 'CAL', accountId: 'Visa 1234',
    transactionDate: '2026-05-01', merchantName: 'Café Central',
    amount: 42, currency: 'ILS', transactionType: 'רגיל',
    status: 'pending', chargeDate: '', chargeAmount: 42, chargeCurrency: 'ILS', category: '',
  });

  const settledTx = {
    ...pendingTx,
    status: 'completed',
    chargeDate: '2026-05-05',
    chargeAmount: 42,
  };

  it('new transaction is exported and classified as created', async () => {
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: [pendingTx], warnings: [] } },
    });

    const { transactions, report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(report.createdCount, 1);
    assert.equal(report.updatedCount, 0);
    assert.equal(report.unchangedCount, 0);
    assert.equal(transactions.length, 1);
  });

  it('transaction with identical content is classified as unchanged and excluded', async () => {
    const fp = fingerprint(pendingTx);
    const ch = contentHash(pendingTx);
    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: [pendingTx], warnings: [] } },
    });
    deps.seenStore.upsert(fp, ch); // same contentHash → unchanged

    const { transactions, report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(report.createdCount, 0);
    assert.equal(report.updatedCount, 0);
    assert.equal(report.unchangedCount, 1);
    assert.equal(transactions.length, 0, 'unchanged transactions must not be emitted');
  });

  it('transaction with changed content is classified as updated and included', async () => {
    const fp = fingerprint(pendingTx); // same identity key
    const oldHash = contentHash(pendingTx);
    const newHash = contentHash(settledTx); // different (status + chargeDate changed)
    assert.notEqual(oldHash, newHash, 'test setup: hashes must differ');

    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: [settledTx], warnings: [] } },
    });
    deps.seenStore.upsert(fp, oldHash); // stale hash from previous run

    const { transactions, report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(report.createdCount, 0);
    assert.equal(report.updatedCount, 1);
    assert.equal(report.unchangedCount, 0);
    assert.equal(transactions.length, 1, 'updated transaction must be emitted');
  });

  it('classifies a mixed window correctly across the full scan (8 unchanged, 1 updated, 1 new)', async () => {
    // The whole 10-row window is scanned; an updated row in the middle and a new
    // row at the end are both discovered (no early-stop ever skips them).
    const txs = Array.from({ length: 10 }, (_, i) => createTransaction({
      provider: 'CAL', accountId: 'Visa 1234',
      transactionDate: `2026-05-${String(i + 1).padStart(2, '0')}`,
      merchantName: `Shop ${i}`, amount: i + 1, currency: 'ILS', transactionType: 'רגיל',
      status: 'completed', chargeDate: '2026-05-31', chargeAmount: i + 1, chargeCurrency: 'ILS', category: '',
    }));

    const deps = makeDeps({
      providerOpts: { fetchResult: { transactions: txs, warnings: [] } },
    });

    // txs[0..7]: seed with matching contentHash → unchanged
    for (const tx of txs.slice(0, 8)) {
      deps.seenStore.upsert(fingerprint(tx), contentHash(tx));
    }
    // txs[8]: seed with stale hash → updated
    deps.seenStore.upsert(fingerprint(txs[8]), 'stale-hash-00000000');
    // txs[9]: not seen → created

    const { report } = await fetchTransactions(
      { credentials: TEST_CREDS, skipExport: true },
      deps
    );

    assert.equal(report.totalTransactionsConsidered, 10, 'entire window scanned');
    assert.equal(report.unchangedCount, 8);
    assert.equal(report.updatedCount, 1);
    assert.equal(report.createdCount, 1);
  });
});
