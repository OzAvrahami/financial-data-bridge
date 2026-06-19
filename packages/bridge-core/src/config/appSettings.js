/**
 * Desktop app settings persistence.
 *
 * Reads and writes the private accounts config file
 * (`config.accounts.configPath`, default `accounts.config.json`, gitignored),
 * in object form:
 *
 *   {
 *     "daysBack": 4,
 *     "accounts": [
 *       { "provider": "cal", "providerAccountId": "default", "displayName": "CAL (default)",
 *         "enabled": true, "default": true, "daysBack": null,
 *         "credentialKey": "cal-default" }
 *     ]
 *   }
 *
 * Credentials themselves live in the OS-encrypted store (Electron safeStorage),
 * keyed by `credentialKey`; only that key reference is persisted here.
 *
 * SECURITY: this module never persists or returns resolved usernames/passwords —
 * only the `credentialKey` reference. The settings UI therefore never sees
 * secrets. (An `{ usernameEnv, passwordEnv }` reference form is still tolerated
 * on read for engine-internal credential resolution, but is not written by the UI.)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { config as defaultConfig } from '../config.js';
import { loadSourceAccounts } from './sourceAccounts.js';

export const DAYS_BACK_MIN = 1;
export const DAYS_BACK_MAX = 365;

/**
 * Validate a daysBack value. Required, integer, within [MIN, MAX].
 * @returns {{ valid: true, value: number } | { valid: false, error: string }}
 */
export function validateDaysBack(value) {
  if (value === '' || value === null || value === undefined) {
    return { valid: false, error: 'days back is required' };
  }
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { valid: false, error: 'days back must be a whole number' };
  }
  if (n < DAYS_BACK_MIN) return { valid: false, error: `days back must be at least ${DAYS_BACK_MIN}` };
  if (n > DAYS_BACK_MAX) return { valid: false, error: `days back must be at most ${DAYS_BACK_MAX}` };
  return { valid: true, value: n };
}

/** Strip an account down to safe, persistable fields (NO raw secrets). */
function sanitizeAccountForStorage(a = {}) {
  const out = {
    provider:          String(a.provider ?? 'cal').toLowerCase(),
    providerAccountId: String(a.providerAccountId ?? a.accountId ?? 'default').trim() || 'default',
    displayName:       String(a.displayName ?? '').trim(),
    enabled:           a.enabled !== false,
    default:           a.default === true || a.isDefault === true,
  };
  if (Number.isInteger(a.daysBack)) out.daysBack = a.daysBack;

  // Reference to OS-secure-stored credentials (desktop). NOT a secret — just a key.
  if (a.credentialKey) out.credentialKey = String(a.credentialKey).trim();

  // Tolerate an engine-internal credential reference ({ usernameEnv, passwordEnv })
  // if already present. Raw username/password are intentionally dropped and NEVER
  // written to this file; the UI persists only credentialKey.
  const usernameEnv = a.credentials?.usernameEnv ?? a.usernameEnv;
  const passwordEnv = a.credentials?.passwordEnv ?? a.passwordEnv;
  if (usernameEnv || passwordEnv) {
    out.credentials = {};
    if (usernameEnv) out.credentials.usernameEnv = String(usernameEnv).trim();
    if (passwordEnv) out.credentials.passwordEnv = String(passwordEnv).trim();
  }
  return out;
}

/** Default credentialKey for the finance-system secret in the OS-secure store. */
export const FINANCE_CREDENTIAL_KEY = 'finance-default';

/**
 * Strip the finance-integration block to safe, persistable fields.
 * The API key is a SECRET and is never stored here — only the credentialKey
 * reference (the key itself lives in the OS-encrypted store). The base URL is
 * non-secret configuration and is stored in plaintext.
 */
function sanitizeFinanceForStorage(raw = {}) {
  return {
    enabled:       raw.enabled === true,
    apiUrl:        String(raw.apiUrl ?? '').trim(),
    credentialKey: String(raw.credentialKey || FINANCE_CREDENTIAL_KEY).trim() || FINANCE_CREDENTIAL_KEY,
  };
}

/** Force exactly one default among the accounts (first wins; fallback to first). */
function ensureSingleDefault(accounts) {
  let seen = false;
  for (const a of accounts) {
    if (a.default && !seen) seen = true;
    else a.default = false;
  }
  if (!seen && accounts.length > 0) accounts[0].default = true;
  return accounts;
}

function resolveConfigPath(opts = {}) {
  if (opts.configPath) return opts.configPath;
  return (opts.config ?? defaultConfig).accounts.configPath;
}

/**
 * Load editable app settings (daysBack + accounts) WITHOUT resolved secrets.
 * If no config file exists, derives a single default account row from the
 * existing single-account env config so the UI always has something to show.
 *
 * @returns {{ daysBack: number, accounts: object[] }}
 */
export function loadAppSettings(opts = {}) {
  const config     = opts.config ?? defaultConfig;
  const configPath = resolveConfigPath(opts);

  let raw = null;
  if (configPath && existsSync(configPath)) {
    try { raw = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { raw = null; }
  }

  const rawAccounts = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.accounts) ? raw.accounts : null);
  const daysBack    = Number.isInteger(raw?.daysBack) ? raw.daysBack : config.fetch.daysBack;

  let accounts;
  if (rawAccounts && rawAccounts.length > 0) {
    accounts = rawAccounts.map(sanitizeAccountForStorage);
  } else {
    // Derive an editable default row from the env-based single-account config.
    accounts = loadSourceAccounts({ config }).map(a => sanitizeAccountForStorage({
      provider: a.provider,
      providerAccountId: a.providerAccountId,
      displayName: a.displayName,
      enabled: true,
      default: true,
    }));
  }

  ensureSingleDefault(accounts);
  const finance = sanitizeFinanceForStorage(raw?.finance ?? {});
  return { daysBack, accounts, finance };
}

/**
 * Persist app settings (atomic write). Validates daysBack and sanitizes accounts
 * so no secrets are written. Returns the persisted payload.
 */
export function saveAppSettings(settings = {}, opts = {}) {
  const configPath = resolveConfigPath(opts);
  if (!configPath) throw new Error('No accounts config path configured');

  const dv = validateDaysBack(settings.daysBack);
  if (!dv.valid) throw new Error(dv.error);

  const accounts = (Array.isArray(settings.accounts) ? settings.accounts : []).map(sanitizeAccountForStorage);
  ensureSingleDefault(accounts);

  const finance = sanitizeFinanceForStorage(settings.finance ?? {});

  const payload = { daysBack: dv.value, accounts, finance };

  mkdirSync(dirname(configPath) || '.', { recursive: true });
  const tmp = configPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  renameSync(tmp, configPath);

  return payload;
}
