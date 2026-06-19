/**
 * Unit tests for the desktop settings-path resolver + legacy migration.
 *
 * Uses temp dirs (no Electron). Verifies that:
 *   - the resolved path lives under userData
 *   - a legacy repo-root file is copied into userData on first run
 *   - an existing userData file is never overwritten by the legacy file
 *   - the legacy file is never deleted (non-destructive migration)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveSettingsPath } = require('../../../apps/desktop/settingsPath.cjs');

let root, userDataDir, legacyPath;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'settings-path-test-'));
  userDataDir = join(root, 'userData');
  legacyPath = join(root, 'repo', 'accounts.config.json');
  mkdirSync(join(root, 'repo'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('resolveSettingsPath', () => {
  it('resolves under userData', () => {
    const { path } = resolveSettingsPath({ userDataDir });
    assert.equal(path, join(userDataDir, 'settings.json'));
    assert.ok(existsSync(userDataDir), 'userData dir is created');
  });

  it('migrates a legacy file into userData on first run', () => {
    writeFileSync(legacyPath, JSON.stringify({ daysBack: 9, accounts: [] }), 'utf-8');

    const { path, migrated } = resolveSettingsPath({ userDataDir, legacyPath });
    assert.equal(migrated, true);
    assert.ok(existsSync(path), 'settings file now exists in userData');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), { daysBack: 9, accounts: [] });
    // Non-destructive: legacy file is preserved.
    assert.ok(existsSync(legacyPath), 'legacy file must NOT be deleted');
  });

  it('does NOT overwrite an existing userData file with the legacy file', () => {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ daysBack: 1 }), 'utf-8');
    writeFileSync(legacyPath, JSON.stringify({ daysBack: 99 }), 'utf-8');

    const { migrated, path } = resolveSettingsPath({ userDataDir, legacyPath });
    assert.equal(migrated, false);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), { daysBack: 1 }, 'existing file wins');
  });

  it('does not migrate when there is no legacy file', () => {
    const { migrated } = resolveSettingsPath({ userDataDir, legacyPath });
    assert.equal(migrated, false);
  });

  it('throws without userDataDir', () => {
    assert.throws(() => resolveSettingsPath({}), /userDataDir is required/);
  });
});
