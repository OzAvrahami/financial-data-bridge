/**
 * Install the Playwright Chromium browser into a project-local folder so it can
 * be bundled INTO the packaged desktop app (via electron-builder extraResources).
 *
 * Why this exists
 * ---------------
 * In development, Playwright launches a Chromium it downloaded into the global
 * per-user cache (`%LOCALAPPDATA%/ms-playwright` on Windows). That cache does NOT
 * exist on a fresh machine that only installed our app. A distributable Electron
 * build must therefore ship its own copy of Chromium.
 *
 * This script downloads Chromium (the full browser AND the headless-shell, which
 * `playwright install chromium` provides together) into `./pw-browsers`, pinned
 * to the exact revision required by the installed Playwright version. The
 * electron-builder config copies that folder into the app's resources, and the
 * Electron main process points Playwright at it at runtime via
 * `PLAYWRIGHT_BROWSERS_PATH` (see apps/desktop/runtimePaths.cjs).
 *
 * Run automatically by the `dist:desktop*` / `pack:desktop` npm scripts. Safe to
 * re-run: Playwright skips browsers already present at the target revision.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browsersDir = path.join(root, 'pw-browsers');
const cli = path.join(root, 'node_modules', 'playwright', 'cli.js');

const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir };

console.log(`[bundle-browsers] Installing Playwright Chromium into:\n  ${browsersDir}\n`);

const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
  stdio: 'inherit',
  env,
});

if (result.error) {
  console.error('[bundle-browsers] Failed to launch Playwright CLI:', result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`[bundle-browsers] Playwright install exited with code ${result.status}`);
  process.exit(result.status ?? 1);
}

console.log('\n[bundle-browsers] Chromium is ready to be bundled.');
