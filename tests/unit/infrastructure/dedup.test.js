import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { fingerprint, contentHash, classifyTransaction, assignOccurrenceKeys, SeenStore } from '../../../packages/bridge-core/src/infrastructure/dedup.js';
import { createTransaction } from '../../../packages/bridge-core/src/schema/transaction.js';

// ── Shared fixture ────────────────────────────────────────────────────────────

const baseTx = createTransaction({
  provider: 'CAL',
  accountId: 'Visa 1234',
  transactionDate: '2026-04-15',
  merchantName: 'SuperMarket',
  amount: 50.5,
  currency: 'ILS',
  transactionType: 'רגיל',
  status: 'pending',
  chargeDate: '',
  chargeAmount: 50.5,
  chargeCurrency: 'ILS',
  category: 'Food',
});

// ── fingerprint ───────────────────────────────────────────────────────────────

describe('fingerprint', () => {
  it('returns a 16-char hex string', () => {
    assert.match(fingerprint(baseTx), /^[0-9a-f]{16}$/);
  });

  it('is deterministic — same input produces same output', () => {
    assert.equal(fingerprint(baseTx), fingerprint({ ...baseTx }));
  });

  it('differs when merchantName changes', () => {
    assert.notEqual(fingerprint(baseTx), fingerprint({ ...baseTx, merchantName: 'OtherShop' }));
  });

  it('differs when amount changes', () => {
    assert.notEqual(fingerprint(baseTx), fingerprint({ ...baseTx, amount: 99.9 }));
  });

  it('differs when transactionDate changes', () => {
    assert.notEqual(fingerprint(baseTx), fingerprint({ ...baseTx, transactionDate: '2026-04-16' }));
  });

  it('differs when currency changes', () => {
    assert.notEqual(fingerprint(baseTx), fingerprint({ ...baseTx, currency: 'USD' }));
  });

  it('differs when provider changes', () => {
    assert.notEqual(fingerprint(baseTx), fingerprint({ ...baseTx, provider: 'MAX' }));
  });

  it('differs when accountId changes', () => {
    assert.notEqual(fingerprint(baseTx), fingerprint({ ...baseTx, accountId: 'Visa 5678' }));
  });

  it('is not affected by chargeDate or chargeAmount (content fields, not identity)', () => {
    const withExtra = { ...baseTx, chargeAmount: 999, chargeDate: '2026-04-20' };
    assert.equal(fingerprint(baseTx), fingerprint(withExtra));
  });
});

// ── assignOccurrenceKeys ──────────────────────────────────────────────────────

describe('assignOccurrenceKeys', () => {
  it('assigns dedupKey equal to fingerprint when transaction is unique in the batch', () => {
    const tx = { ...baseTx };
    assignOccurrenceKeys([tx]);
    assert.equal(tx.dedupKey, fingerprint(baseTx));
  });

  it('assigns no suffix to occurrenceIndex 1, and "|#2" suffix to occurrenceIndex 2', () => {
    const tx1 = { ...baseTx };
    const tx2 = { ...baseTx }; // identical business fields
    assignOccurrenceKeys([tx1, tx2]);

    const baseFp = fingerprint(baseTx);
    assert.equal(tx1.dedupKey, baseFp,           'first occurrence: no suffix');
    assert.equal(tx2.dedupKey, `${baseFp}|#2`,   'second occurrence: |#2 suffix');
  });

  it('assigns "|#3" to a third identical transaction', () => {
    const tx1 = { ...baseTx };
    const tx2 = { ...baseTx };
    const tx3 = { ...baseTx };
    assignOccurrenceKeys([tx1, tx2, tx3]);

    const baseFp = fingerprint(baseTx);
    assert.equal(tx1.dedupKey, baseFp);
    assert.equal(tx2.dedupKey, `${baseFp}|#2`);
    assert.equal(tx3.dedupKey, `${baseFp}|#3`);
  });

  it('gives distinct dedupKeys to two genuinely different transactions', () => {
    const txA = { ...baseTx };
    const txB = { ...baseTx, merchantName: 'OtherShop' };
    assignOccurrenceKeys([txA, txB]);

    assert.notEqual(txA.dedupKey, txB.dedupKey);
    assert.equal(txA.dedupKey, fingerprint(txA)); // unique → no suffix
    assert.equal(txB.dedupKey, fingerprint(txB)); // unique → no suffix
  });

  it('handles a mixed batch: unique + duplicates', () => {
    const dup1 = { ...baseTx };
    const dup2 = { ...baseTx };
    const other = { ...baseTx, merchantName: 'Unique Shop' };
    assignOccurrenceKeys([dup1, other, dup2]);

    const baseFp = fingerprint(baseTx);
    assert.equal(dup1.dedupKey,  baseFp,           'first dup: no suffix');
    assert.equal(other.dedupKey, fingerprint(other), 'unique: no suffix');
    assert.equal(dup2.dedupKey,  `${baseFp}|#2`,   'second dup: |#2 suffix');
  });

  it('occurrenceIndex 1 always equals bare fingerprint for backward SeenStore compat', () => {
    // Simulates: tx was unique in a prior run (stored as baseFp). In this run,
    // a second copy appears. The first copy must still resolve to baseFp so that
    // the SeenStore lookup finds the previously stored entry.
    const tx1 = { ...baseTx };
    const tx2 = { ...baseTx };
    assignOccurrenceKeys([tx1, tx2]);

    const baseFp = fingerprint(baseTx);
    const store = new SeenStore('/tmp');
    store.upsert(baseFp, contentHash(baseTx)); // simulate prior run storing just baseFp

    // tx1 (occurrenceIndex 1) must be classified as unchanged, not created
    assert.equal(classifyTransaction(store, tx1.dedupKey, contentHash(tx1)), 'unchanged',
      'first occurrence matches prior SeenStore entry');
    // tx2 (occurrenceIndex 2) has a new key → classified as created
    assert.equal(classifyTransaction(store, tx2.dedupKey, contentHash(tx2)), 'created',
      'second occurrence is new → created');
  });

  it('is a no-op on an empty array', () => {
    assert.doesNotThrow(() => assignOccurrenceKeys([]));
  });

  it('mutates the input array in place', () => {
    const tx = { ...baseTx };
    const arr = [tx];
    assignOccurrenceKeys(arr);
    assert.ok('dedupKey' in tx, 'tx should have dedupKey after mutation');
  });
});

// ── contentHash ───────────────────────────────────────────────────────────────

describe('contentHash', () => {
  it('returns a 16-char hex string', () => {
    assert.match(contentHash(baseTx), /^[0-9a-f]{16}$/);
  });

  it('is deterministic — same input produces same output', () => {
    assert.equal(contentHash(baseTx), contentHash({ ...baseTx }));
  });

  it('differs when status changes', () => {
    assert.notEqual(contentHash(baseTx), contentHash({ ...baseTx, status: 'completed' }));
  });

  it('differs when chargeDate changes', () => {
    assert.notEqual(contentHash(baseTx), contentHash({ ...baseTx, chargeDate: '2026-04-20' }));
  });

  it('differs when chargeAmount changes', () => {
    assert.notEqual(contentHash(baseTx), contentHash({ ...baseTx, chargeAmount: 51.5 }));
  });

  it('differs when chargeCurrency changes', () => {
    assert.notEqual(contentHash(baseTx), contentHash({ ...baseTx, chargeCurrency: 'USD' }));
  });

  it('differs when category changes', () => {
    assert.notEqual(contentHash(baseTx), contentHash({ ...baseTx, category: 'Travel' }));
  });

  it('is not affected by identity fields (provider, merchantName, amount, etc.)', () => {
    const sameContent = { ...baseTx, merchantName: 'DifferentShop', amount: 999, provider: 'MAX' };
    assert.equal(contentHash(baseTx), contentHash(sameContent));
  });

  it('is not affected by the raw field', () => {
    const withRaw = { ...baseTx, raw: { surprise: 'different data' } };
    assert.equal(contentHash(baseTx), contentHash(withRaw));
  });
});

// ── classifyTransaction ───────────────────────────────────────────────────────

describe('classifyTransaction', () => {
  it('returns created when entry not in store', () => {
    const store = new SeenStore('/tmp');
    assert.equal(classifyTransaction(store, 'fp1', 'hash1'), 'created');
  });

  it('returns unchanged when contentHash matches', () => {
    const store = new SeenStore('/tmp');
    store.upsert('fp1', 'hash1');
    assert.equal(classifyTransaction(store, 'fp1', 'hash1'), 'unchanged');
  });

  it('returns updated when contentHash differs', () => {
    const store = new SeenStore('/tmp');
    store.upsert('fp1', 'old-hash');
    assert.equal(classifyTransaction(store, 'fp1', 'new-hash'), 'updated');
  });

  it('returns unchanged for legacy entry with null contentHash (migration path)', () => {
    const store = new SeenStore('/tmp');
    // Simulate a v1-migrated entry
    store._entries.set('fp1', { contentHash: null, lastSeenAt: null, updatedAt: null });
    assert.equal(classifyTransaction(store, 'fp1', 'any-hash'), 'unchanged');
  });

  it('always returns created when fullFetch is true', () => {
    const store = new SeenStore('/tmp');
    store.upsert('fp1', 'hash1');
    assert.equal(classifyTransaction(store, 'fp1', 'hash1', true), 'created');
  });
});

// ── SeenStore — in-memory ─────────────────────────────────────────────────────

describe('SeenStore — in-memory', () => {
  it('starts empty', () => {
    const store = new SeenStore('/tmp');
    assert.equal(store.size, 0);
  });

  it('has() returns false for unknown fingerprint', () => {
    const store = new SeenStore('/tmp');
    assert.equal(store.has('abc'), false);
  });

  it('lookup() returns null for unknown fingerprint', () => {
    const store = new SeenStore('/tmp');
    assert.equal(store.lookup('abc'), null);
  });

  it('has() returns true after upsert()', () => {
    const store = new SeenStore('/tmp');
    store.upsert('abc', 'hash1');
    assert.equal(store.has('abc'), true);
  });

  it('lookup() returns entry with contentHash after upsert()', () => {
    const store = new SeenStore('/tmp');
    store.upsert('abc', 'hash1');
    const entry = store.lookup('abc');
    assert.ok(entry, 'entry should exist');
    assert.equal(entry.contentHash, 'hash1');
    assert.ok(entry.lastSeenAt, 'lastSeenAt should be set');
    assert.equal(entry.updatedAt, null, 'updatedAt null for new entry');
  });

  it('upsert() updates contentHash and sets updatedAt on content change', () => {
    const store = new SeenStore('/tmp');
    store.upsert('abc', 'hash1');
    store.upsert('abc', 'hash2');
    const entry = store.lookup('abc');
    assert.equal(entry.contentHash, 'hash2');
    assert.ok(entry.updatedAt, 'updatedAt should be set after content change');
  });

  it('upsert() does not set updatedAt when contentHash is the same', () => {
    const store = new SeenStore('/tmp');
    store.upsert('abc', 'hash1');
    store.upsert('abc', 'hash1');
    const entry = store.lookup('abc');
    assert.equal(entry.updatedAt, null, 'updatedAt should remain null when content unchanged');
  });

  it('size reflects number of unique fingerprints', () => {
    const store = new SeenStore('/tmp');
    store.upsert('aaa', 'h1');
    store.upsert('bbb', 'h2');
    store.upsert('aaa', 'h3'); // same key, update
    assert.equal(store.size, 2);
  });
});

// ── SeenStore — persistence ───────────────────────────────────────────────────

let tmpDir;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'seenstore-test-'));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('SeenStore — persistence', () => {
  it('saves and loads v2 entries', async () => {
    const store = new SeenStore(tmpDir);
    store.upsert('fp1', 'hash1');
    store.upsert('fp2', 'hash2');
    await store.save('cal', 'default');

    const store2 = new SeenStore(tmpDir);
    await store2.load('cal', 'default');
    assert.equal(store2.has('fp1'), true);
    assert.equal(store2.has('fp2'), true);
    assert.equal(store2.lookup('fp1').contentHash, 'hash1');
    assert.equal(store2.size, 2);
  });

  it('load with no file starts empty (no error)', async () => {
    const store = new SeenStore(tmpDir);
    await store.load('cal', 'fresh-account');
    assert.equal(store.size, 0);
  });

  it('isolates by accountId', async () => {
    const storeA = new SeenStore(tmpDir);
    storeA.upsert('only-in-A', 'hashA');
    await storeA.save('cal', 'accountA');

    const storeB = new SeenStore(tmpDir);
    await storeB.load('cal', 'accountB');
    assert.equal(storeB.has('only-in-A'), false);
  });

  it('migrates v1 fingerprints-array format on load', async () => {
    // Write a v1-format file directly
    const { writeFile } = await import('fs/promises');
    const path = join(tmpDir, 'cal_v1test.json');
    await writeFile(
      path,
      JSON.stringify({ fingerprints: ['legacy-fp-1', 'legacy-fp-2'], savedAt: '2025-01-01T00:00:00.000Z' }),
      'utf-8'
    );

    const store = new SeenStore(tmpDir);
    await store.load('cal', 'v1test');
    assert.equal(store.has('legacy-fp-1'), true);
    assert.equal(store.has('legacy-fp-2'), true);
    // contentHash is null — treated as unchanged (no re-export on migration)
    assert.equal(store.lookup('legacy-fp-1').contentHash, null);
    assert.equal(store.size, 2);
  });
});
