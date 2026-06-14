/**
 * Electron main process — the trusted Node side of the Desktop app.
 *
 * Security model:
 *   - The renderer runs sandboxed with contextIsolation ON and nodeIntegration OFF.
 *   - The renderer NEVER receives secrets. Only safe, read-only display data is
 *     passed across IPC (see the credential-stripping in 'accounts:list').
 *   - .env / accounts.config.json are only ever read here, in the Node process.
 *
 * This is a shell: the fetch actions are mocked in the renderer for now. No real
 * Playwright automation is wired up in this step.
 */

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

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
  mode:     'mock — real fetch not wired yet',
  node:     process.versions.node,
  electron: process.versions.electron,
}));

ipcMain.handle('accounts:list', async () => {
  try {
    // Dynamic import of the ESM app module from this CommonJS file.
    const url = pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'bridge-core', 'src', 'config', 'sourceAccounts.js')).href;
    const { loadSourceAccounts } = await import(url);
    // CRITICAL: strip credentials. The renderer must never receive secrets.
    return loadSourceAccounts().map(a => ({
      provider:          a.provider,
      providerAccountId: a.providerAccountId,
      displayName:       a.displayName,
    }));
  } catch (err) {
    return { error: err.message };
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
