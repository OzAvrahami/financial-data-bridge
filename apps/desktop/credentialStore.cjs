/**
 * Secure credential store for the desktop app (Electron MAIN process only).
 *
 * Credentials (username + password) are encrypted with Electron's `safeStorage`
 * — which uses OS-level encryption:
 *   - Windows : DPAPI (tied to the current Windows user account)
 *   - macOS   : Keychain
 *   - Linux   : libsecret/kwallet, or a basic fallback if no keyring is present
 *
 * The encrypted blobs are written to:
 *     <app.getPath('userData')>/credentials.enc.json
 * e.g. on Windows: %APPDATA%/Financial Data Bridge/credentials.enc.json
 *
 * This file lives OUTSIDE the repository, so it is never tracked by git. It
 * contains only ciphertext (base64), never plaintext usernames/passwords.
 *
 * Limitations:
 *   - Decryptable only by the same OS user on the same machine. Copying the file
 *     to another computer or user account makes it undecryptable (DPAPI/Keychain
 *     are per-user). Credentials must be re-entered there.
 *   - On Linux without a keyring, safeStorage may use a weaker fallback; we still
 *     refuse to persist plaintext (we require isEncryptionAvailable()).
 *
 * The core logic is exposed as a pure factory (createCredentialStore) so it can
 * be unit-tested with an injected cipher, without launching Electron.
 */

const { readFileSync, writeFileSync, mkdirSync, renameSync } = require('fs');
const { dirname } = require('path');

/**
 * @param {object} deps
 * @param {(plaintext: string) => string} deps.encrypt  - returns base64 ciphertext
 * @param {(b64: string) => string}       deps.decrypt  - returns plaintext
 * @param {string}   deps.filePath                       - where to persist the map
 * @param {() => boolean} [deps.isAvailable]             - encryption available?
 */
function createCredentialStore({ encrypt, decrypt, filePath, isAvailable }) {
  function load() {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (data && typeof data.entries === 'object') return data;
    } catch { /* missing/corrupt → fresh */ }
    return { version: 1, entries: {} };
  }

  function persist(data) {
    mkdirSync(dirname(filePath) || '.', { recursive: true });
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data), 'utf-8');
    renameSync(tmp, filePath);
  }

  return {
    available() {
      return isAvailable ? !!isAvailable() : true;
    },

    /** Encrypt + store credentials under `key`. Overwrites any existing value. */
    setCredentials(key, { username = '', password = '' } = {}) {
      if (!key) throw new Error('credentialKey is required');
      if (isAvailable && !isAvailable()) {
        throw new Error('OS secure storage is not available; refusing to store credentials in plaintext');
      }
      const data = load();
      data.entries[key] = encrypt(JSON.stringify({ username, password }));
      persist(data);
      return true;
    },

    /** Whether credentials are stored for `key`. Returns no secret. */
    getStatus(key) {
      const data = load();
      return { saved: Boolean(key && data.entries[key]), available: this.available() };
    },

    /** Decrypt + return { username, password } | null. MAIN-process use only. */
    getCredentials(key) {
      const data = load();
      const blob = key && data.entries[key];
      if (!blob) return null;
      try { return JSON.parse(decrypt(blob)); } catch { return null; }
    },

    /** Delete credentials for `key`. Returns true if something was removed. */
    deleteCredentials(key) {
      const data = load();
      if (key && data.entries[key]) {
        delete data.entries[key];
        persist(data);
        return true;
      }
      return false;
    },

    /** Delete every stored key that is NOT in `keepKeys`. Returns count removed. */
    pruneExcept(keepKeys = []) {
      const keep = new Set(keepKeys.filter(Boolean));
      const data = load();
      let removed = 0;
      for (const k of Object.keys(data.entries)) {
        if (!keep.has(k)) { delete data.entries[k]; removed++; }
      }
      if (removed > 0) persist(data);
      return removed;
    },

    listKeys() {
      return Object.keys(load().entries);
    },
  };
}

// ── Default instance backed by Electron safeStorage (lazy; no Electron at import) ──
let _default = null;
function getDefaultStore() {
  if (_default) return _default;
  const { app, safeStorage } = require('electron');
  const path = require('path');
  const filePath = path.join(app.getPath('userData'), 'credentials.enc.json');
  _default = createCredentialStore({
    filePath,
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  });
  _default.filePath = filePath; // for diagnostics
  return _default;
}

module.exports = { createCredentialStore, getDefaultStore };
