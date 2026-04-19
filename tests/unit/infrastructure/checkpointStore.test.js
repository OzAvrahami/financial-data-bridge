import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { CheckpointStore } from '../../../src/infrastructure/checkpointStore.js';

let tmpDir;
let store;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'checkpoint-test-'));
  store  = new CheckpointStore(tmpDir);
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const SAMPLE = {
  provider: 'cal',
  accountId: 'default',
  startedAt: '2026-04-19T10:00:00.000Z',
  daysBack: 4,
  nextIndex: 3,
  transactions: [{ merchantName: 'Test', amount: 50 }],
  warnings: [],
};

describe('CheckpointStore', () => {
  it('returns null when no checkpoint file exists', async () => {
    const result = await store.load('cal', 'default');
    assert.equal(result, null);
  });

  it('saves and loads a checkpoint', async () => {
    await store.save('cal', 'default', SAMPLE);
    const loaded = await store.load('cal', 'default');
    assert.deepEqual(loaded, SAMPLE);
  });

  it('filePath uses provider name only for default account', () => {
    const path = store.filePath('cal', 'default');
    assert.ok(path.endsWith('cal.json'), `expected cal.json, got ${path}`);
  });

  it('filePath includes accountId suffix for non-default account', () => {
    const path = store.filePath('cal', 'card42');
    assert.ok(path.endsWith('cal_card42.json'), `expected cal_card42.json, got ${path}`);
  });

  it('overwrites existing checkpoint on save', async () => {
    const updated = { ...SAMPLE, nextIndex: 7 };
    await store.save('cal', 'default', updated);
    const loaded = await store.load('cal', 'default');
    assert.equal(loaded.nextIndex, 7);
  });

  it('clear removes the checkpoint file', async () => {
    await store.save('cal', 'default', SAMPLE);
    await store.clear('cal', 'default');
    const loaded = await store.load('cal', 'default');
    assert.equal(loaded, null);
  });

  it('clear does not throw when file does not exist', async () => {
    await assert.doesNotReject(() => store.clear('cal', 'nonexistent'));
  });

  it('returns null for a corrupt checkpoint file', async () => {
    const path = store.filePath('cal', 'corrupt');
    await writeFile(path, 'not { valid json', 'utf-8');
    const result = await store.load('cal', 'corrupt');
    assert.equal(result, null);
  });

  it('isolates checkpoints by accountId', async () => {
    await store.save('cal', 'accountA', { ...SAMPLE, nextIndex: 1 });
    await store.save('cal', 'accountB', { ...SAMPLE, nextIndex: 99 });

    const a = await store.load('cal', 'accountA');
    const b = await store.load('cal', 'accountB');
    assert.equal(a.nextIndex, 1);
    assert.equal(b.nextIndex, 99);
  });
});
