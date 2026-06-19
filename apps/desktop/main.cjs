/**
 * Electron main process — the trusted Node side of the Desktop app.
 *
 * Security model:
 *   - The renderer runs sandboxed with contextIsolation ON and nodeIntegration OFF.
 *   - The renderer NEVER receives secrets. Settings carry credential ENV-VAR
 *     NAMES only (usernameEnv/passwordEnv) — never resolved usernames/passwords.
 *   - .env / accounts.config.json are only ever read/written here, in Node.
 *
 * Fetch actions are still MOCKED, but now settings-driven: they resolve the real
 * configured default/enabled accounts and validated daysBack, then simulate the
 * run. No Playwright automation is triggered from the desktop yet.
 */

const { app, BrowserWindow, ipcMain, Menu, safeStorage } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { getDefaultStore } = require('./credentialStore.cjs');

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

// Resolve the accounts config file to an absolute path anchored at the repo root,
// so it is stable regardless of the Electron process CWD.
function accountsConfigPath(config) {
  const p = config.accounts.configPath;
  return path.isAbsolute(p) ? p : path.join(__dirname, '..', '..', p);
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
  mode:     'mock (settings-driven) — fetch is simulated',
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

// Editable settings (daysBack + accounts), WITHOUT resolved secrets.
ipcMain.handle('settings:get', async () => {
  try {
    const c = await core();
    return c.loadAppSettings({ configPath: accountsConfigPath(c.config), config: c.config });
  } catch (err) {
    return { error: err.message };
  }
});

// Persist settings. Validates daysBack and strips secrets before writing.
ipcMain.handle('settings:save', async (_event, settings) => {
  try {
    const c = await core();
    const saved = c.saveAppSettings(settings, { configPath: accountsConfigPath(c.config) });
    // Deleting an account (removing its row) must delete its stored credentials:
    // prune any secure-store keys no longer referenced by a saved account.
    try {
      const referenced = saved.accounts.map(a => a.credentialKey).filter(Boolean);
      getDefaultStore().pruneExcept(referenced);
    } catch { /* pruning is best-effort; never block a settings save */ }
    return { ok: true, saved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Settings-driven MOCK fetch. Resolves the target accounts + validated daysBack
// and reports what WOULD run. No real automation is performed.
ipcMain.handle('fetch:run', async (_event, payload = {}) => {
  try {
    const c = await core();
    const settings = c.loadAppSettings({ configPath: accountsConfigPath(c.config), config: c.config });

    const dv = c.validateDaysBack(payload.daysBack ?? settings.daysBack);
    if (!dv.valid) return { ok: false, error: `Invalid days back: ${dv.error}` };

    let targets;
    if (payload.mode === 'default') {
      const def = c.getDefaultAccount(settings.accounts);
      if (!def) return { ok: false, error: 'No accounts configured. Add one in Account Settings.' };
      targets = [def];
    } else {
      targets = c.getEnabledAccounts(settings.accounts);
      if (targets.length === 0) return { ok: false, error: 'No enabled accounts to fetch. Enable at least one account.' };
    }

    return {
      ok: true,
      mock: true,
      mode: payload.mode === 'default' ? 'default' : 'all',
      daysBack: dv.value,
      accounts: targets.map(a => ({
        provider:          a.provider,
        providerAccountId: a.providerAccountId,
        displayName:       a.displayName,
        daysBack:          Number.isInteger(a.daysBack) ? a.daysBack : dv.value,
      })),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
