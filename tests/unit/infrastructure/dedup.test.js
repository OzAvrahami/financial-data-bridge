import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { fingerprint, SeenStore } from '../../../src/infrastructure/dedup.js';
import { createTransaction } from '../../../src/schema/transaction.js';

// ── fingerprint ───────────────────────────────────────────────────────────────

const baseTx = createTransaction({
  provider: 'CAL',
  accountId: 'Visa 1234',
  transactionDate: '2026-04-15',
  merchantName: 'SuperMarket',
  amount: 50.5,
  currency: 'ILS',
  transactionType: 'רגיל',
});

describe('fingerprint', () => {
  it('returns a 16-char hex string', () => {
    const fp = fingerprint(baseTx);
    assert.match(fp, /^[0-9a-f]{16}$/);
  });

  it('is deterministic — same input produces same output', () => {
    assert.equal(fingerprint(baseTx), fingerprint({ ...baseTx }));
  });

  it('differs when merchantName changes', () => {
    const other = { ...baseTx, merchantName: 'OtherShop' };
    assert.notEqual(fingerprint(baseTx), fingerprint(other));
  });

  it('differs when amount changes', () => {
    const other = { ...baseTx, amount: 99.9 };
    assert.notEqual(fingerprint(baseTx), fingerprint(other));
  });

  it('differs when transactionDate changes', () => {
    const other = { ...baseTx, transactionDate: '2026-04-16' };
    assert.notEqual(fingerprint(baseTx), fingerprint(other));
  });

  it('differs when currency changes', () => {
    const other = { ...baseTx, currency: 'USD' };
    assert.notEqual(fingerprint(baseTx), fingerprint(other));
  });

  it('differs when provider changes', () => {
    const other = { ...baseTx, provider: 'MAX' };
    assert.notEqual(fingerprint(baseTx), fingerprint(other));
  });

  it('differs when accountId changes', () => {
    const other = { ...baseTx, accountId: 'Visa 5678' };
    assert.notEqual(fingerprint(baseTx), fingerprint(other));
  });

  it('is not affected by chargeAmount or chargeDate (not in fingerprint)', () => {
    const withExtra  = { ...baseTx, chargeAmount: 999, chargeDate: '2026-04-20' };
    assert.equal(fingerprint(baseTx), fingerprint(withExtra));
  });
});

// ── SeenStore (in-memory operations) ─────────────────────────────────────────

describe('SeenStore — in-memory', () => {
  it('starts empty', () => {
    const store = new SeenStore('/tmp');
    assert.equal(store.size, 0);
  });

  it('has() returns false for unknown fingerprint', () => {
    const store = new SeenStore('/tmp');
    assert.equal(store.has('abc123'), false);
  });

  it('has() returns true after add()', () => {
    const store = new SeenStore('/tmp');
    store.add('abc123');
    assert.equal(store.has('abc123'), true);
  });

  it('size reflects number of unique fingerprints', () => {
    const store = new SeenStore('/tmp');
    store.add('aaa');
    store.add('bbb');
    store.add('aaa'); // duplicate
    assert.equal(store.size, 2);
  });

  it('addMany() adds all fingerprints', () => {
    const store = new SeenStore('/tmp');
    store.addMany(['x', 'y', 'z']);
    assert.equal(store.size, 3);
    assert.equal(store.has('y'), true);
  });
});

// ── SeenStore (persistence) ───────────────────────────────────────────────────

let tmpDir;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'seenstore-test-'));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('SeenStore — persistence', () => {
  it('saves and loads fingerprints', async () => {
    const store = new SeenStore(tmpDir);
    store.add('fp1');
    store.add('fp2');
    await store.save('cal', 'default');

    const store2 = new SeenStore(tmpDir);
    await store2.load('cal', 'default');
    assert.equal(store2.has('fp1'), true);
    assert.equal(store2.has('fp2'), true);
    assert.equal(store2.size, 2);
  });

  it('load with no file starts empty (no error)', async () => {
    const store = new SeenStore(tmpDir);
    await store.load('cal', 'fresh-account');
    assert.equal(store.size, 0);
  });

  it('isolates by accountId', async () => {
    const storeA = new SeenStore(tmpDir);
    storeA.add('only-in-A');
    await storeA.save('cal', 'accountA');

    const storeB = new SeenStore(tmpDir);
    await storeB.load('cal', 'accountB'); // different account
    assert.equal(storeB.has('only-in-A'), false);
  });
});
