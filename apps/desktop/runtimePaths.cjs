/**
 * Resolve where the PACKAGED desktop app keeps its writable runtime state and
 * its bundled browser (Electron MAIN process).
 *
 * Two problems this solves for an installed build:
 *
 *  1. Writable state must NOT live inside the installed app folder. The installed
 *     app is read-only (its code is inside an `app.asar` archive, and on Windows it
 *     sits under Program Files). bridge-core defaults its runtime directories to
 *     RELATIVE paths (`runtime/exports`, `runtime/sessions`, …) resolved against the
 *     current working directory — fine for a dev checkout, broken once installed.
 *     We redirect every runtime directory under Electron's per-user `userData`
 *     folder by pre-seeding the env vars that bridge-core/src/config.js reads.
 *     Because config.js uses `process.env[KEY] ?? fallback` (and dotenv does not
 *     override already-set vars), these MUST be applied before bridge-core is first
 *     imported — the main process does that in app.whenReady, before any IPC.
 *
 *  2. Playwright's Chromium does not exist on a fresh machine. We ship it inside the
 *     app's resources (electron-builder `extraResources` → `pw-browsers`) and point
 *     Playwright at it with `PLAYWRIGHT_BROWSERS_PATH`.
 *
 * Pure and dependency-free (no Electron import) so it is unit-testable with a fake
 * env object and temp dirs.
 */

const { join } = require('path');

// Maps each bridge-core runtime env var (read in packages/bridge-core/src/config.js)
// to its subdirectory under <userData>/runtime.
const RUNTIME_ENV_DIRS = {
  EXPORT_PATH:        'exports',
  SESSION_DIR:        'sessions',
  CHECKPOINT_DIR:     'checkpoints',
  SEEN_DIR:           'seen',
  FINANCE_LEDGER_DIR: 'finance-ledger',
  REPORTS_DIR:        'reports',
  // Failure diagnostics (e.g. CAL login-form screenshots) written by providers.
  DEBUG_DIR:          'debug',
};

/**
 * Compute the absolute runtime directory paths for a given userData dir.
 * @param {string} userDataDir - Electron app.getPath('userData')
 * @returns {Record<string, string>} env var name → absolute directory path
 */
function resolveRuntimeEnv(userDataDir) {
  if (!userDataDir) throw new Error('userDataDir is required');
  const root = join(userDataDir, 'runtime');
  const env = {};
  for (const [key, sub] of Object.entries(RUNTIME_ENV_DIRS)) {
    env[key] = join(root, sub);
  }
  return env;
}

/**
 * Seed the runtime directory env vars onto a target env object (default
 * process.env). Existing values are preserved so a developer can still override an
 * individual directory via a real env var. Returns the values that were resolved.
 *
 * @param {string} userDataDir
 * @param {Record<string,string>} [target=process.env]
 * @returns {Record<string,string>}
 */
function applyRuntimeEnv(userDataDir, target = process.env) {
  const env = resolveRuntimeEnv(userDataDir);
  for (const [key, value] of Object.entries(env)) {
    if (!target[key]) target[key] = value;
  }
  return env;
}

/**
 * Absolute path to the Chromium browsers bundled into the packaged app's
 * resources directory.
 * @param {string} resourcesPath - Electron process.resourcesPath
 * @returns {string}
 */
function resolveBundledBrowsersPath(resourcesPath) {
  if (!resourcesPath) throw new Error('resourcesPath is required');
  return join(resourcesPath, 'pw-browsers');
}

/**
 * Point Playwright at the bundled Chromium (preserving an explicit override).
 * @param {string} resourcesPath
 * @param {Record<string,string>} [target=process.env]
 * @returns {string} the browsers path that is now in effect
 */
function applyBundledBrowsersPath(resourcesPath, target = process.env) {
  const browsersPath = resolveBundledBrowsersPath(resourcesPath);
  if (!target.PLAYWRIGHT_BROWSERS_PATH) target.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  return target.PLAYWRIGHT_BROWSERS_PATH;
}

module.exports = {
  RUNTIME_ENV_DIRS,
  resolveRuntimeEnv,
  applyRuntimeEnv,
  resolveBundledBrowsersPath,
  applyBundledBrowsersPath,
};
