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
  /** Run the real fetch. payload: { mode:'all'|'default', daysBack }. Resolves to the final summary. */
  runFetch:     (payload) => ipcRenderer.invoke('fetch:run', payload),
  /**
   * Subscribe to secret-free fetch progress events (account-start/login/fetched/
   * dedup/export/account-done/account-error). Returns an unsubscribe function.
   */
  onFetchProgress: (callback) => {
    const listener = (_event, evt) => callback(evt);
    ipcRenderer.on('fetch:progress', listener);
    return () => ipcRenderer.removeListener('fetch:progress', listener);
  },

  // ── Secure credentials (OS keychain via safeStorage; main-process only) ──────
  /** Credential status for a key: { saved, available } — never the secret. */
  getCredentialStatus: (credentialKey) => ipcRenderer.invoke('credentials:status', credentialKey),
  /** Encrypt + store credentials. Returns { ok } only — never echoes the password. */
  saveCredentials:     (credentialKey, creds) => ipcRenderer.invoke('credentials:set', credentialKey, creds),
  /** Delete stored credentials for a key. */
  deleteCredentials:   (credentialKey) => ipcRenderer.invoke('credentials:delete', credentialKey),

  // ── Finance-system integration (secret in safeStorage; main-process only) ────
  /** Finance secret status for a key: { saved, available } — never the secret. */
  getFinanceStatus:    (credentialKey) => ipcRenderer.invoke('finance:status', credentialKey),
  /** Encrypt + store the finance API key. Returns { ok } only — never echoes it. */
  saveFinanceSecret:   (credentialKey, secret) => ipcRenderer.invoke('finance:setSecret', credentialKey, secret),
  /** Delete the stored finance API key. */
  deleteFinanceSecret: (credentialKey) => ipcRenderer.invoke('finance:deleteSecret', credentialKey),
  /** Test the finance connection. payload: { apiUrl, credentialKey }. Returns { ok, message }. */
  testFinanceConnection: (payload) => ipcRenderer.invoke('finance:test', payload),
});
