/**
 * Preload bridge — the only channel between the sandboxed renderer and the main
 * process. Exposes a tiny, explicit, read-only API. No Node, no secrets, no
 * arbitrary IPC reach the renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  /** Safe environment/status info for the dashboard header. */
  getEnvInfo:   () => ipcRenderer.invoke('app:getEnvInfo'),
  /** Configured source accounts WITHOUT credentials (display data only). */
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
});
