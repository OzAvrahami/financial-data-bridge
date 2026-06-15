/**
 * Preload bridge — the only channel between the sandboxed renderer and the main
 * process. Exposes a tiny, explicit, read-only API. No Node, no secrets, no
 * arbitrary IPC reach the renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  /** Safe environment/status info for the dashboard header. */
  getEnvInfo:   () => ipcRenderer.invoke('app:getEnvInfo'),
  /** Editable settings: { daysBack, accounts[] } — credential env-names only, no secrets. */
  getSettings:  () => ipcRenderer.invoke('settings:get'),
  /** Persist settings (validated + sanitized in main). Returns { ok } or { ok:false, error }. */
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  /** Settings-driven mock fetch. payload: { mode:'all'|'default', daysBack }. */
  runFetch:     (payload) => ipcRenderer.invoke('fetch:run', payload),

  // ── Secure credentials (OS keychain via safeStorage; main-process only) ──────
  /** Credential status for a key: { saved, available } — never the secret. */
  getCredentialStatus: (credentialKey) => ipcRenderer.invoke('credentials:status', credentialKey),
  /** Encrypt + store credentials. Returns { ok } only — never echoes the password. */
  saveCredentials:     (credentialKey, creds) => ipcRenderer.invoke('credentials:set', credentialKey, creds),
  /** Delete stored credentials for a key. */
  deleteCredentials:   (credentialKey) => ipcRenderer.invoke('credentials:delete', credentialKey),
});
