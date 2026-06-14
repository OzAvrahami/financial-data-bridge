/**
 * Unit tests for the generic source-account configuration loader.
 *
 * Pure tests: config and env are injected, so nothing touches the real
 * filesystem or process.env (except the backward-compat path, which still uses
 * an injected config + empty env).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadSourceAccounts,
  normalizeAccount,
  resolveCredentials,
  isMultiAccountConfigured,
} from '../../../src/config/sourceAccounts.js';

// A config with no accounts file path that exists → forces env/default resolution.
const SINGLE_CONFIG = {
  provider: 'cal',
  credentials: { cal: { username: 'envuser', password: 'envpass', accountId: 'default' } },
  accounts: { configPath: 'does-not-exist-xyz.json' },
};

describe('resolveCredentials', () => {
  it('resolves env references to values', () => {
    const creds = resolveCredentials({ usernameEnv: 'U', passwordEnv: 'P' }, { U: 'alice', P: 'secret' });
    assert.deepEqual(creds, { username: 'alice', password: 'secret' });
  });

  it('accepts direct username/password', () => {
    const creds = resolveCredentials({ username: 'bob', password: 'pw' }, {});
    assert.deepEqual(creds, { username: 'bob', password: 'pw' });
  });

  it('returns empty strings when nothing resolves', () => {
    assert.deepEqual(resolveCredentials({ usernameEnv: 'MISSING' }, {}), { username: '', password: '' });
  });
});

describe('normalizeAccount', () => {
  it('lowercases provider and fills displayName default', () => {
    const acc = normalizeAccount({ provider: 'CAL', providerAccountId: 'oz_cal' }, {});
    assert.equal(acc.provider, 'cal');
    assert.equal(acc.providerAccountId, 'oz_cal');
    assert.equal(acc.displayName, 'CAL (oz_cal)');
  });

  it('falls back providerAccountId to accountId then "default"', () => {
    assert.equal(normalizeAccount({ provider: 'cal', accountId: 'legacy' }, {}).providerAccountId, 'legacy');
    assert.equal(normalizeAccount({ provider: 'cal' }, {}).providerAccountId, 'default');
  });
});

describe('loadSourceAccounts — explicit list', () => {
  it('normalizes an explicitly provided account list', () => {
    const accounts = loadSourceAccounts({
      accounts: [
        { provider: 'cal', providerAccountId: 'oz_cal', displayName: 'Oz CAL', credentials: { usernameEnv: 'A', passwordEnv: 'B' } },
        { provider: 'max', providerAccountId: 'oz_max', credentials: { username: 'm', password: 'n' } },
      ],
      env: { A: 'oz', B: 'pw' },
    });
    assert.equal(accounts.length, 2);
    assert.deepEqual(accounts[0].credentials, { username: 'oz', password: 'pw' });
    assert.equal(accounts[1].provider, 'max');
    assert.equal(accounts[1].displayName, 'MAX (oz_max)');
  });
});

describe('loadSourceAccounts — inline SOURCE_ACCOUNTS env', () => {
  it('parses a JSON array from SOURCE_ACCOUNTS', () => {
    const env = {
      SOURCE_ACCOUNTS: JSON.stringify([
        { provider: 'cal', providerAccountId: 'wife_cal', credentials: { usernameEnv: 'WU', passwordEnv: 'WP' } },
      ]),
      WU: 'wife', WP: 'wpw',
    };
    const accounts = loadSourceAccounts({ config: SINGLE_CONFIG, env });
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].providerAccountId, 'wife_cal');
    assert.deepEqual(accounts[0].credentials, { username: 'wife', password: 'wpw' });
  });

  it('falls back to default on malformed SOURCE_ACCOUNTS', () => {
    const accounts = loadSourceAccounts({ config: SINGLE_CONFIG, env: { SOURCE_ACCOUNTS: 'not json' } });
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].providerAccountId, 'default'); // backward-compat default
  });
});

describe('loadSourceAccounts — backward-compatible default', () => {
  it('returns a single default account when nothing is configured', () => {
    const accounts = loadSourceAccounts({ config: SINGLE_CONFIG, env: {} });
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].provider, 'cal');
    assert.equal(accounts[0].providerAccountId, 'default');
    assert.deepEqual(accounts[0].credentials, { username: 'envuser', password: 'envpass' });
  });

  it('uses CAL_ACCOUNT_ID-style accountId from config credentials', () => {
    const cfg = { ...SINGLE_CONFIG, credentials: { cal: { username: 'u', password: 'p', accountId: 'my_visa' } } };
    const accounts = loadSourceAccounts({ config: cfg, env: {} });
    assert.equal(accounts[0].providerAccountId, 'my_visa');
  });
});

describe('isMultiAccountConfigured', () => {
  it('is false with no env/file config', () => {
    assert.equal(isMultiAccountConfigured({ config: SINGLE_CONFIG, env: {} }), false);
  });
  it('is true when SOURCE_ACCOUNTS is set', () => {
    const env = { SOURCE_ACCOUNTS: JSON.stringify([{ provider: 'cal', providerAccountId: 'x' }]) };
    assert.equal(isMultiAccountConfigured({ config: SINGLE_CONFIG, env }), true);
  });
});
