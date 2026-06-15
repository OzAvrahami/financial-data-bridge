/**
 * Unit tests for the desktop credential store factory.
 *
 * Uses an injected reversible "cipher" + temp file, so it runs under plain Node
 * without launching Electron / safeStorage. Verifies that:
 *   - credentials round-trip (set → get)
 *   - the on-disk file contains ciphertext only (no plaintext password)
 *   - saving overwrites
 *   - delete removes, prune removes orphans
 *   - encryption-unavailable refuses to store
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createCredentialStore } = require('../../../apps/desktop/credentialStore.cjs');

// Reversible stand-in for safeStorage (base64). Not real crypto — just enough to
// prove the plaintext password never appears verbatim in the file.
const encrypt = (s) => Buffer.from(s, 'utf-8').toString('base64');
const decrypt = (b) => Buffer.from(b, 'base64').toString('utf-8');

let dir, lastFile;
function makeStore(isAvailable = () => true) {
  lastFile = join(dir, `cs-${Math.random().toString(16).slice(2)}.json`); // fresh per store
  return createCredentialStore({ encrypt, decrypt, filePath: lastFile, isAvailable });
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'cred-store-test-')); });
after(() => rmSync(dir, { recursive: true, force: true }));

describe('credentialStore', () => {
  it('round-trips credentials and reports status', () => {
    const store = makeStore();
    assert.equal(store.getStatus('k1').saved, false);
    store.setCredentials('k1', { username: 'alice', password: 'hunter2' });
    assert.equal(store.getStatus('k1').saved, true);
    assert.deepEqual(store.getCredentials('k1'), { username: 'alice', password: 'hunter2' });
  });

  it('writes ciphertext only — no plaintext password on disk', () => {
    const store = makeStore();
    store.setCredentials('k2', { username: 'bob', password: 'S3cr3t-PA55' });
    const raw = readFileSync(lastFile, 'utf-8');
    assert.doesNotMatch(raw, /S3cr3t-PA55/, 'plaintext password must not be in the file');
    assert.doesNotMatch(raw, /\bbob\b/, 'plaintext username must not be in the file');
    // The ciphertext (base64 of the JSON) is present.
    assert.match(raw, new RegExp(encrypt(JSON.stringify({ username: 'bob', password: 'S3cr3t-PA55' }))));
  });

  it('overwrites an existing value', () => {
    const store = makeStore();
    store.setCredentials('k3', { username: 'u', password: 'old' });
    store.setCredentials('k3', { username: 'u', password: 'new' });
    assert.equal(store.getCredentials('k3').password, 'new');
  });

  it('deletes credentials', () => {
    const store = makeStore();
    store.setCredentials('k4', { username: 'u', password: 'p' });
    assert.equal(store.deleteCredentials('k4'), true);
    assert.equal(store.getStatus('k4').saved, false);
    assert.equal(store.deleteCredentials('k4'), false);
  });

  it('prunes orphan keys (deleted accounts) but keeps referenced ones', () => {
    const store = makeStore();
    store.setCredentials('keep', { username: 'u', password: 'p' });
    store.setCredentials('drop', { username: 'u', password: 'p' });
    const removed = store.pruneExcept(['keep']);
    assert.equal(removed, 1);
    assert.equal(store.getStatus('keep').saved, true);
    assert.equal(store.getStatus('drop').saved, false);
  });

  it('refuses to store when OS encryption is unavailable', () => {
    const store = makeStore(() => false);
    assert.equal(store.available(), false);
    assert.throws(() => store.setCredentials('x', { username: 'u', password: 'p' }), /not available/);
  });

  it('getCredentials returns null for unknown keys', () => {
    const store = makeStore();
    assert.equal(store.getCredentials('does-not-exist'), null);
  });
});
