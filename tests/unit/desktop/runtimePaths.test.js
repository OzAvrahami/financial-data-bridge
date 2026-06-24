/**
 * Unit tests for the desktop packaged-runtime path resolver.
 *
 * Pure helper (no Electron): verifies that a packaged build redirects every
 * bridge-core runtime directory under userData and points Playwright at the
 * bundled Chromium, while preserving any explicit env override.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  RUNTIME_ENV_DIRS,
  resolveRuntimeEnv,
  applyRuntimeEnv,
  resolveBundledBrowsersPath,
  applyBundledBrowsersPath,
} = require('../../../apps/desktop/runtimePaths.cjs');

describe('resolveRuntimeEnv', () => {
  it('maps every bridge-core runtime env var under <userData>/runtime', () => {
    const env = resolveRuntimeEnv('/data');
    const root = join('/data', 'runtime');
    assert.equal(env.EXPORT_PATH, join(root, 'exports'));
    assert.equal(env.SESSION_DIR, join(root, 'sessions'));
    assert.equal(env.CHECKPOINT_DIR, join(root, 'checkpoints'));
    assert.equal(env.SEEN_DIR, join(root, 'seen'));
    assert.equal(env.FINANCE_LEDGER_DIR, join(root, 'finance-ledger'));
    assert.equal(env.REPORTS_DIR, join(root, 'reports'));
    // Covers exactly the documented set — no more, no less.
    assert.deepEqual(Object.keys(env).sort(), Object.keys(RUNTIME_ENV_DIRS).sort());
  });

  it('throws without a userData dir', () => {
    assert.throws(() => resolveRuntimeEnv(''), /userDataDir is required/);
  });
});

describe('applyRuntimeEnv', () => {
  it('seeds all runtime vars onto a fresh target', () => {
    const target = {};
    applyRuntimeEnv('/data', target);
    assert.equal(target.EXPORT_PATH, join('/data', 'runtime', 'exports'));
    assert.equal(target.REPORTS_DIR, join('/data', 'runtime', 'reports'));
  });

  it('never overrides an explicit existing value', () => {
    const target = { EXPORT_PATH: '/custom/exports' };
    applyRuntimeEnv('/data', target);
    assert.equal(target.EXPORT_PATH, '/custom/exports');
    // ...but still fills in the ones that were unset.
    assert.equal(target.SEEN_DIR, join('/data', 'runtime', 'seen'));
  });
});

describe('bundled browsers path', () => {
  it('resolves <resources>/pw-browsers', () => {
    assert.equal(resolveBundledBrowsersPath('/app/resources'), join('/app/resources', 'pw-browsers'));
  });

  it('applies the path unless one is already set', () => {
    const fresh = {};
    applyBundledBrowsersPath('/app/resources', fresh);
    assert.equal(fresh.PLAYWRIGHT_BROWSERS_PATH, join('/app/resources', 'pw-browsers'));

    const overridden = { PLAYWRIGHT_BROWSERS_PATH: '/my/browsers' };
    applyBundledBrowsersPath('/app/resources', overridden);
    assert.equal(overridden.PLAYWRIGHT_BROWSERS_PATH, '/my/browsers');
  });

  it('throws without a resources path', () => {
    assert.throws(() => resolveBundledBrowsersPath(''), /resourcesPath is required/);
  });
});
