/**
 * Resolve the desktop settings file location (Electron MAIN process).
 *
 * An installed desktop app must NOT write inside the repository. The repo root
 * `accounts.config.json` was only ever appropriate for a dev checkout. Normal
 * settings therefore live under Electron's per-user `userData` directory.
 *
 * Migration is one-way and non-destructive: on first run, if the userData file
 * does not yet exist but a legacy repo-root file does, the legacy file is COPIED
 * into userData. The legacy file is never deleted here — the caller decides, and
 * only after a successful, verified migration.
 *
 * Pure except for fs access; dependency-free so it is unit-testable with temp dirs.
 */

const { existsSync, mkdirSync, copyFileSync, readFileSync } = require('fs');
const { dirname, join } = require('path');

/**
 * @param {object} opts
 * @param {string} opts.userDataDir           - Electron app.getPath('userData')
 * @param {string} [opts.legacyPath]          - existing repo-root settings file, if any
 * @param {string} [opts.fileName='settings.json']
 * @returns {{ path: string, migrated: boolean, legacyPath: string|null }}
 */
function resolveSettingsPath({ userDataDir, legacyPath = null, fileName = 'settings.json' }) {
  if (!userDataDir) throw new Error('userDataDir is required');
  const target = join(userDataDir, fileName);

  let migrated = false;
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    if (legacyPath && existsSync(legacyPath)) {
      // Validate the legacy file is readable before copying; copy atomically via
      // a temp file so a partial copy can never become the live settings file.
      readFileSync(legacyPath, 'utf-8');
      const tmp = `${target}.migrating`;
      copyFileSync(legacyPath, tmp);
      // Only promote to the real path once the copy fully landed.
      copyFileSync(tmp, target);
      try { require('fs').unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      migrated = true;
    }
  }

  return { path: target, migrated, legacyPath: legacyPath ?? null };
}

module.exports = { resolveSettingsPath };
