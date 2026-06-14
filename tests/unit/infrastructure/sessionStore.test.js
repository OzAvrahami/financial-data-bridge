import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionStore } from '../../../packages/bridge-core/src/infrastructure/sessionStore.js';

let tmpDir;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'fdb-session-test-'));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('load returns null when no file exists', async () => {
    const store = new SessionStore(join(tmpDir, 'empty'));
    const result = await store.load('cal', '');
    assert.equal(result, null);
  });

  it('save then load round-trips the storage state', async () => {
    const store = new SessionStore(tmpDir);
    const state = { cookies: [{ name: 'auth', value: 'abc123' }], origins: [] };
    await store.save('cal', '', state);
    const loaded = await store.load('cal', '');
    assert.deepEqual(loaded, state);
  });

  it('load returns null after clear', async () => {
    const store = new SessionStore(tmpDir);
    const state = { cookies: [], origins: [] };
    await store.save('cal', 'cardA', state);
    await store.clear('cal', 'cardA');
    const result = await store.load('cal', 'cardA');
    assert.equal(result, null);
  });

  it('isolates sessions by accountId (different files)', async () => {
    const store = new SessionStore(tmpDir);
    const stateA = { cookies: [{ name: 'a' }], origins: [] };
    const stateB = { cookies: [{ name: 'b' }], origins: [] };
    await store.save('cal', 'account-a', stateA);
    await store.save('cal', 'account-b', stateB);

    const loadedA = await store.load('cal', 'account-a');
    const loadedB = await store.load('cal', 'account-b');
    assert.deepEqual(loadedA, stateA);
    assert.deepEqual(loadedB, stateB);
  });

  it('isolates sessions by providerName', async () => {
    const store = new SessionStore(tmpDir);
    const calState = { cookies: [{ name: 'cal' }], origins: [] };
    const maxState = { cookies: [{ name: 'max' }], origins: [] };
    await store.save('cal', '', calState);
    await store.save('max', '', maxState);

    assert.deepEqual(await store.load('cal', ''), calState);
    assert.deepEqual(await store.load('max', ''), maxState);
  });

  it('creates the storage directory if it does not exist', async () => {
    const newDir = join(tmpDir, 'nested', 'dir');
    const store = new SessionStore(newDir);
    await store.save('cal', '', { cookies: [], origins: [] });
    // If we reach here without throwing, the directory was created
    const loaded = await store.load('cal', '');
    assert.ok(loaded !== null);
  });

  it('load returns null for corrupt JSON gracefully', async () => {
    // Write corrupt data manually then attempt to load
    const { writeFile, mkdir } = await import('fs/promises');
    const corruptDir = join(tmpDir, 'corrupt');
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(corruptDir, 'cal.json'), 'not-valid-json', 'utf-8');

    const store = new SessionStore(corruptDir);
    const result = await store.load('cal', '');
    assert.equal(result, null);
  });
});
