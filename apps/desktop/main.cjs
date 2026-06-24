/**
 * Electron main process — the trusted Node side of the Desktop app.
 *
 * Security model:
 *   - The renderer runs sandboxed with contextIsolation ON and nodeIntegration OFF.
 *   - The renderer NEVER receives secrets. Settings carry only references
 *     (credentialKey) — never resolved usernames/passwords/API keys.
 *   - All secrets (CAL credentials, finance API key) live in the OS-encrypted
 *     store (safeStorage); non-secret settings live under userData/settings.json.
 *     Both are read/written only here, in Node. The app does not require .env.
 *
 * Fetch actions run the REAL bridge-core pipeline (Playwright login + fetch +
 * dedup + export). The renderer triggers a run over IPC; the main process
 * decrypts credentials, drives the engine, and streams secret-free progress
 * events back to the renderer. Only one run may execute at a time.
 */

const { app, BrowserWindow, ipcMain, Menu, safeStorage, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { getDefaultStore } = require('./credentialStore.cjs');
const { createFetchLock, runDesktopFetch, ConcurrentFetchError } = require('./fetchService.cjs');
const { resolveSettingsPath } = require('./settingsPath.cjs');
const { applyRuntimeEnv, applyBundledBrowsersPath } = require('./runtimePaths.cjs');

// Only one fetch at a time — the authoritative concurrency guard.
const fetchLock = createFetchLock();

// Brand the userData folder so the encrypted credential store has a stable,
// documented path: <userData>/credentials.enc.json under "Financial Data Bridge".
app.setName('Financial Data Bridge');

// ── Lazy, memoized import of the ESM bridge-core config modules ────────────────
const CORE_SRC = path.join(__dirname, '..', '..', 'packages', 'bridge-core', 'src');
let _corePromise = null;
function core() {
  if (!_corePromise) {
    const imp = (rel) => import(pathToFileURL(path.join(CORE_SRC, rel)).href);
    _corePromise = Promise.all([
      imp('config.js'),
      imp('config/sourceAccounts.js'),
      imp('config/appSettings.js'),
    ]).then(([cfg, src, settings]) => ({ config: cfg.config, ...src, ...settings }));
  }
  return _corePromise;
}

// The fetch engine pulls in Playwright; import it lazily (only when a fetch is
// actually requested) so the lighter settings/credentials paths stay fast.
let _enginePromise = null;
function engine() {
  if (!_enginePromise) {
    _enginePromise = import(pathToFileURL(path.join(CORE_SRC, 'application/index.js')).href);
  }
  return _enginePromise;
}

// Finance sync/test helpers — lighter modules than the full engine (no Playwright),
// imported lazily only when finance actions are used. Merges the connectivity-test
// helper (runFinanceExport.js) with the ledger-aware sync engine.
let _financePromise = null;
function financeApi() {
  if (!_financePromise) {
    const imp = (rel) => import(pathToFileURL(path.join(CORE_SRC, rel)).href);
    _financePromise = Promise.all([
      imp('application/runFinanceExport.js'),
      imp('application/syncTransactionsToFinance.js'),
    ]).then(([rfe, sync]) => ({ ...rfe, ...sync }));
  }
  return _financePromise;
}

// Legacy (repo-root) settings file, anchored at the repo root regardless of CWD.
function legacyAccountsConfigPath(config) {
  const p = config.accounts.configPath;
  return path.isAbsolute(p) ? p : path.join(__dirname, '..', '..', p);
}

// Resolve the live settings file under Electron userData (outside the repo),
// migrating the legacy repo-root file on first run. Memoized; never deletes the
// legacy file. Requires app to be ready (userData path available).
let _settingsPath = null;
function settingsPath(config) {
  if (_settingsPath) return _settingsPath;
  const { path: p, migrated } = resolveSettingsPath({
    userDataDir: app.getPath('userData'),
    legacyPath:  legacyAccountsConfigPath(config),
    fileName:    'settings.json',
  });
  if (migrated) {
    // eslint-disable-next-line no-console
    console.log('settings: migrated legacy accounts.config.json into userData/settings.json');
  }
  _settingsPath = p;
  return p;
}

/** Defensive scrub: ensure a known secret can never appear in an outgoing string. */
function scrubSecretFrom(value, secret) {
  if (!secret) return value;
  try { return JSON.parse(JSON.stringify(value).split(secret).join('[REDACTED]')); }
  catch { return value; }
}

// Smoke mode: create the window hidden, confirm it loads, then quit. Used for
// headless "does it start?" verification without leaving a GUI window open.
const isSmoke = process.env.DESKTOP_SMOKE === '1';

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 740,
    show: !isSmoke,
    title: 'Financial Data Bridge',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null); // minimal chrome
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (isSmoke) {
    win.webContents.once('did-finish-load', () => {
      // eslint-disable-next-line no-console
      console.log('desktop:ready');
      setTimeout(() => app.quit(), 200);
    });
  }

  return win;
}

// ── Safe, read-only IPC ───────────────────────────────────────────────────────

ipcMain.handle('app:getEnvInfo', () => ({
  appName:  'Financial Data Bridge',
  status:   'Ready',
  mode:     'live — real CAL automation (Playwright)',
  node:     process.versions.node,
  electron: process.versions.electron,
  secureStorage: safeStorage.isEncryptionAvailable() ? 'available' : 'unavailable',
}));

// ── Secure credentials (never returns saved passwords to the renderer) ─────────

ipcMain.handle('credentials:status', (_event, credentialKey) => {
  try { return getDefaultStore().getStatus(credentialKey); }
  catch (err) { return { saved: false, available: false, error: err.message }; }
});

ipcMain.handle('credentials:set', (_event, credentialKey, creds) => {
  try {
    getDefaultStore().setCredentials(credentialKey, {
      username: creds?.username ?? '',
      password: creds?.password ?? '',
    });
    return { ok: true }; // intentionally returns NO secret
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('credentials:delete', (_event, credentialKey) => {
  try { return { ok: true, removed: getDefaultStore().deleteCredentials(credentialKey) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Editable settings (daysBack + accounts + finance), WITHOUT resolved secrets.
ipcMain.handle('settings:get', async () => {
  try {
    const c = await core();
    return c.loadAppSettings({ configPath: settingsPath(c.config), config: c.config });
  } catch (err) {
    return { error: err.message };
  }
});

// Persist settings. Validates daysBack and strips secrets before writing.
ipcMain.handle('settings:save', async (_event, settings) => {
  try {
    const c = await core();
    const saved = c.saveAppSettings(settings, { configPath: settingsPath(c.config) });
    // Deleting an account (removing its row) must delete its stored credentials:
    // prune any secure-store keys no longer referenced by a saved account — but
    // keep the finance secret's key referenced so it survives account edits.
    try {
      const referenced = saved.accounts.map(a => a.credentialKey).filter(Boolean);
      if (saved.finance?.credentialKey) referenced.push(saved.finance.credentialKey);
      getDefaultStore().pruneExcept(referenced);
    } catch { /* pruning is best-effort; never block a settings save */ }
    return { ok: true, saved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Finance-system integration secret + connectivity test ──────────────────────

ipcMain.handle('finance:status', (_event, credentialKey) => {
  try { return getDefaultStore().getStatus(credentialKey); }
  catch (err) { return { saved: false, available: false, error: err.message }; }
});

ipcMain.handle('finance:setSecret', (_event, credentialKey, secret) => {
  try {
    getDefaultStore().setSecret(credentialKey, String(secret ?? ''));
    return { ok: true }; // intentionally returns NO secret
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('finance:deleteSecret', (_event, credentialKey) => {
  try { return { ok: true, removed: getDefaultStore().deleteCredentials(credentialKey) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Test the connection using the saved (decrypted-in-main) secret + the provided
// non-secret URL. The secret never leaves the main process.
ipcMain.handle('finance:test', async (_event, payload = {}) => {
  try {
    const { testFinanceConnection } = await financeApi();
    const apiKey = getDefaultStore().getSecret(payload.credentialKey);
    if (!apiKey) return { ok: false, message: 'No API key saved. Save the key first, then test.' };
    const result = await testFinanceConnection({ apiUrl: payload.apiUrl, apiKey });
    return scrubSecretFrom(result, apiKey); // defense-in-depth
  } catch (err) {
    const apiKey = (() => { try { return getDefaultStore().getSecret(payload.credentialKey); } catch { return null; } })();
    return { ok: false, message: scrubSecretFrom(err.message, apiKey) };
  }
});

// Reveal a finance sync audit report in the OS file manager. Read-only: it only
// opens the folder containing the (non-secret) report file the app just wrote.
ipcMain.handle('finance:revealReport', (_event, filePath) => {
  try {
    if (!filePath) return { ok: false, error: 'No report file to open.' };
    shell.showItemInFolder(path.resolve(filePath));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Real fetch. Decrypts credentials in-process, drives the bridge-core engine,
// and streams secret-free progress events to the renderer. Single-flight.
ipcMain.handle('fetch:run', async (event, payload = {}) => {
  if (fetchLock.isRunning()) {
    return { ok: false, error: 'A fetch is already running. Wait for it to finish.' };
  }
  try {
    return await fetchLock.run(async () => {
      const c = await core();
      const { fetchAllAccounts } = await engine();
      const settings = c.loadAppSettings({ configPath: settingsPath(c.config), config: c.config });

      // Run mode: 'sync' fetches AND syncs to finance; anything else is Fetch Only
      // (fetch + local save, finance never called). The renderer's Fetch buttons
      // send fetch-only; the Sync buttons send 'sync'.
      const financeMode = payload.financeMode === 'sync' ? 'sync' : 'fetch-only';

      // Assemble in-memory finance config: non-secret URL/flag from settings, the
      // API key decrypted from the OS-secure store. The key is only resolved when
      // finance is enabled; the sync engine self-gates (and still writes an audit
      // report) when disabled or when the URL/key is missing.
      const fin = settings.finance || {};
      const financeConfig = { enabled: fin.enabled === true, apiUrl: fin.apiUrl || '', apiKey: '' };
      let syncTransactionsToFinance;
      if (financeMode === 'sync') {
        if (financeConfig.enabled) {
          try { financeConfig.apiKey = getDefaultStore().getSecret(fin.credentialKey) || ''; }
          catch { financeConfig.apiKey = ''; }
        }
        ({ syncTransactionsToFinance } = await financeApi());
      }

      const apiKeyForScrub = financeConfig.apiKey;
      // Relay each secret-free progress event to the renderer that started the run.
      const onEvent = (evt) => {
        try {
          if (!event.sender.isDestroyed()) {
            event.sender.send('fetch:progress', scrubSecretFrom(evt, apiKeyForScrub));
          }
        } catch { /* renderer went away mid-run */ }
      };

      const out = await runDesktopFetch({
        mode:               payload.mode === 'default' ? 'default' : 'all',
        financeMode,
        daysBack:           payload.daysBack,
        settings,
        credentialStore:    getDefaultStore(),
        fetchAllAccounts,
        getDefaultAccount:  c.getDefaultAccount,
        getEnabledAccounts: c.getEnabledAccounts,
        validateDaysBack:   c.validateDaysBack,
        onEvent,
        financeConfig,
        syncTransactionsToFinance,
      });

      // Resolve the audit report paths to absolute so the renderer's "open report"
      // action can reveal them regardless of the process working directory.
      if (out?.finance?.reportPath)    out.finance.reportPath    = path.resolve(out.finance.reportPath);
      if (out?.finance?.reportCsvPath) out.finance.reportCsvPath = path.resolve(out.finance.reportCsvPath);

      return scrubSecretFrom(out, apiKeyForScrub); // defense-in-depth on the final payload
    });
  } catch (err) {
    if (err instanceof ConcurrentFetchError) return { ok: false, error: err.message };
    return { ok: false, error: err.message };
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

// In a PACKAGED build the installed app folder is read-only and the working
// directory is unpredictable, so bridge-core's relative `runtime/*` defaults and
// the global Playwright browser cache are both unusable. Before anything imports
// bridge-core (which reads these env vars once, at import time) redirect runtime
// state under userData and point Playwright at the Chromium bundled in resources.
// In a dev checkout we leave the defaults alone (runtime/ in the repo, global
// Playwright cache) so the developer workflow is unchanged.
function configurePackagedRuntime() {
  if (!app.isPackaged) return;
  applyRuntimeEnv(app.getPath('userData'));
  applyBundledBrowsersPath(process.resourcesPath);
}

app.whenReady().then(() => {
  configurePackagedRuntime();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
