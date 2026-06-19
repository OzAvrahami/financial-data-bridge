/**
 * Unit tests for desktop/app settings persistence + helpers.
 *
 * Uses a temp config file; never touches the real accounts.config.json.
 * Verifies daysBack validation, save/load round-trip, secret sanitization,
 * enabled filtering, and default-account resolution.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  validateDaysBack,
  loadAppSettings,
  saveAppSettings,
  DAYS_BACK_MIN,
  DAYS_BACK_MAX,
} from '../../../packages/bridge-core/src/config/appSettings.js';
import {
  getEnabledAccounts,
  getDefaultAccount,
} from '../../../packages/bridge-core/src/config/sourceAccounts.js';

let dir, cfgPath;
const TEST_CONFIG = { fetch: { daysBack: 4 }, provider: 'cal', credentials: { cal: { username: 'u', password: 'p', accountId: 'default' } }, accounts: { configPath: '' } };

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'app-settings-test-'));
  cfgPath = join(dir, 'accounts.config.json');
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe('validateDaysBack', () => {
  it('requires a value', () => {
    assert.equal(validateDaysBack('').valid, false);
    assert.equal(validateDaysBack(undefined).valid, false);
    assert.equal(validateDaysBack(null).valid, false);
  });
  it('rejects non-integers', () => {
    assert.equal(validateDaysBack('3.5').valid, false);
    assert.equal(validateDaysBack('abc').valid, false);
    assert.equal(validateDaysBack(2.7).valid, false);
  });
  it(`enforces the [${DAYS_BACK_MIN}, ${DAYS_BACK_MAX}] range`, () => {
    assert.equal(validateDaysBack(0).valid, false);
    assert.equal(validateDaysBack(-1).valid, false);
    assert.equal(validateDaysBack(DAYS_BACK_MAX + 1).valid, false);
    assert.equal(validateDaysBack(DAYS_BACK_MIN).valid, true);
    assert.equal(validateDaysBack(DAYS_BACK_MAX).valid, true);
  });
  it('coerces numeric strings and returns the integer', () => {
    assert.deepEqual(validateDaysBack('7'), { valid: true, value: 7 });
  });
});

describe('saveAppSettings / loadAppSettings round-trip', () => {
  it('saves and loads daysBack + accounts', () => {
    saveAppSettings({
      daysBack: 10,
      accounts: [
        { provider: 'cal', providerAccountId: 'cal_5304', displayName: 'CAL 5304', enabled: true, default: true, daysBack: 5,
          credentials: { usernameEnv: 'CAL_USERNAME', passwordEnv: 'CAL_PASSWORD' } },
        { provider: 'cal', providerAccountId: 'wife_cal', displayName: 'Wife CAL', enabled: false, default: false },
      ],
    }, { configPath: cfgPath });

    const loaded = loadAppSettings({ configPath: cfgPath, config: TEST_CONFIG });
    assert.equal(loaded.daysBack, 10);
    assert.equal(loaded.accounts.length, 2);
    assert.equal(loaded.accounts[0].providerAccountId, 'cal_5304');
    assert.equal(loaded.accounts[0].daysBack, 5);
    assert.equal(loaded.accounts[0].default, true);
    assert.equal(loaded.accounts[1].enabled, false);
  });

  it('throws on invalid daysBack', () => {
    assert.throws(() => saveAppSettings({ daysBack: 0, accounts: [] }, { configPath: cfgPath }));
  });

  it('persists credentialKey but never the secret values', () => {
    saveAppSettings({
      daysBack: 4,
      accounts: [{
        provider: 'cal', providerAccountId: 'cal_5304', displayName: 'CAL 5304',
        credentialKey: 'cred-uuid-123',
        username: 'LEAK_USER', password: 'LEAK_PASS', // must be dropped
      }],
    }, { configPath: cfgPath });

    const rawText = readFileSync(cfgPath, 'utf-8');
    assert.match(rawText, /cred-uuid-123/, 'credentialKey (a reference, not a secret) is stored');
    assert.doesNotMatch(rawText, /LEAK_USER|LEAK_PASS/, 'raw credentials must never be written');

    const loaded = loadAppSettings({ configPath: cfgPath, config: TEST_CONFIG });
    assert.equal(loaded.accounts[0].credentialKey, 'cred-uuid-123');
    assert.equal('username' in loaded.accounts[0], false);
    assert.equal('password' in loaded.accounts[0], false);
  });

  it('NEVER persists raw credentials — only env-var names', () => {
    saveAppSettings({
      daysBack: 4,
      accounts: [
        { provider: 'cal', providerAccountId: 'x', displayName: 'X',
          // Attempt to sneak in raw secrets — these must be dropped.
          username: 'SECRET_USER', password: 'SECRET_PASS',
          credentials: { usernameEnv: 'CAL_USERNAME', passwordEnv: 'CAL_PASSWORD', username: 'ALSO_SECRET', password: 'NOPE' } },
      ],
    }, { configPath: cfgPath });

    const rawText = readFileSync(cfgPath, 'utf-8');
    assert.doesNotMatch(rawText, /SECRET_USER|SECRET_PASS|ALSO_SECRET|NOPE/);
    assert.match(rawText, /CAL_USERNAME/);
    assert.match(rawText, /CAL_PASSWORD/);

    // Loaded shape carries env names only, no resolved secrets.
    const loaded = loadAppSettings({ configPath: cfgPath, config: TEST_CONFIG });
    const acc = loaded.accounts[0];
    assert.equal(acc.credentials.usernameEnv, 'CAL_USERNAME');
    assert.equal('username' in acc, false);
    assert.equal('password' in acc, false);
  });

  it('forces exactly one default account', () => {
    const saved = saveAppSettings({
      daysBack: 4,
      accounts: [
        { provider: 'cal', providerAccountId: 'a', displayName: 'A', default: true },
        { provider: 'cal', providerAccountId: 'b', displayName: 'B', default: true },
      ],
    }, { configPath: cfgPath });
    const defaults = saved.accounts.filter(a => a.default);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].providerAccountId, 'a');
  });

  it('derives a single default account when no config file exists', () => {
    const missing = join(dir, 'nope.json');
    assert.equal(existsSync(missing), false);
    const loaded = loadAppSettings({ configPath: missing, config: TEST_CONFIG });
    assert.equal(loaded.accounts.length, 1);
    assert.equal(loaded.accounts[0].default, true);
    assert.equal(loaded.daysBack, 4);
  });
});

describe('finance integration settings', () => {
  it('round-trips the finance block (enabled, apiUrl, credentialKey)', () => {
    saveAppSettings({
      daysBack: 4,
      accounts: [{ provider: 'cal', providerAccountId: 'a', displayName: 'A', default: true }],
      finance: { enabled: true, apiUrl: 'https://fin.example/api', credentialKey: 'finance-default' },
    }, { configPath: cfgPath });

    const loaded = loadAppSettings({ configPath: cfgPath, config: TEST_CONFIG });
    assert.equal(loaded.finance.enabled, true);
    assert.equal(loaded.finance.apiUrl, 'https://fin.example/api');
    assert.equal(loaded.finance.credentialKey, 'finance-default');
  });

  it('never persists an API key/secret — only the credentialKey reference', () => {
    saveAppSettings({
      daysBack: 4,
      accounts: [{ provider: 'cal', providerAccountId: 'a', displayName: 'A', default: true }],
      finance: {
        enabled: true,
        apiUrl: 'https://fin.example/api',
        credentialKey: 'finance-default',
        // Attempts to sneak a secret in — must be dropped.
        apiKey: 'LEAK_FINANCE_KEY',
        secret: 'ALSO_LEAK',
      },
    }, { configPath: cfgPath });

    const rawText = readFileSync(cfgPath, 'utf-8');
    assert.doesNotMatch(rawText, /LEAK_FINANCE_KEY|ALSO_LEAK/, 'finance secret must never be written');
    assert.match(rawText, /finance-default/);

    const loaded = loadAppSettings({ configPath: cfgPath, config: TEST_CONFIG });
    assert.equal('apiKey' in loaded.finance, false);
    assert.equal('secret' in loaded.finance, false);
  });

  it('defaults to a disabled, unconfigured finance block when absent', () => {
    saveAppSettings({
      daysBack: 4,
      accounts: [{ provider: 'cal', providerAccountId: 'a', displayName: 'A', default: true }],
    }, { configPath: cfgPath });

    const loaded = loadAppSettings({ configPath: cfgPath, config: TEST_CONFIG });
    assert.equal(loaded.finance.enabled, false);
    assert.equal(loaded.finance.apiUrl, '');
    assert.equal(loaded.finance.credentialKey, 'finance-default');
  });
});

describe('getEnabledAccounts / getDefaultAccount', () => {
  const accounts = [
    { providerAccountId: 'a', enabled: false, default: false },
    { providerAccountId: 'b', enabled: true,  default: true  },
    { providerAccountId: 'c' /* enabled omitted → enabled */ },
  ];

  it('skips disabled accounts (missing enabled counts as enabled)', () => {
    const ids = getEnabledAccounts(accounts).map(a => a.providerAccountId);
    assert.deepEqual(ids, ['b', 'c']);
  });

  it('resolves the marked default account', () => {
    assert.equal(getDefaultAccount(accounts).providerAccountId, 'b');
  });

  it('falls back to the first account when none is marked default', () => {
    const none = [{ providerAccountId: 'x' }, { providerAccountId: 'y' }];
    assert.equal(getDefaultAccount(none).providerAccountId, 'x');
  });

  it('returns null for an empty list', () => {
    assert.equal(getDefaultAccount([]), null);
  });
});
