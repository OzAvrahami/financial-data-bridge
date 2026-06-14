/**
 * Generic source-account configuration.
 *
 * A "source account" is one login/profile to fetch from — independent of which
 * provider it belongs to. The same structure supports CAL today and future
 * providers (MAX, banks, …) tomorrow.
 *
 * Each source account has:
 *   - provider           : lowercase provider key (e.g. 'cal', 'max')
 *   - providerAccountId  : stable internal id (e.g. 'oz_cal', 'wife_cal') — scopes
 *                          session / seen / checkpoint state and export namespaces
 *   - displayName        : human-friendly label (e.g. 'Oz CAL')
 *   - credentials        : resolved { username, password }
 *
 * Configuration sources, in priority order:
 *   1. opts.accounts          — explicit array (programmatic / tests)
 *   2. SOURCE_ACCOUNTS env    — inline JSON array
 *   3. accounts.config.json   — JSON file (path from config.accounts.configPath)
 *   4. backward-compat default — single account from PROVIDER + {PROVIDER}_* env
 *
 * Credentials in (2)/(3) are referenced by env-var NAME, never inlined, so the
 * config file is safe to share. Example file entry:
 *   {
 *     "provider": "cal",
 *     "providerAccountId": "oz_cal",
 *     "displayName": "Oz CAL",
 *     "credentials": { "usernameEnv": "OZ_CAL_USERNAME", "passwordEnv": "OZ_CAL_PASSWORD" }
 *   }
 */

import { readFileSync, existsSync } from 'fs';
import { config as defaultConfig } from '../config.js';

/**
 * Resolve a credential spec into concrete { username, password }.
 * Accepts direct values ({ username, password }) or env references
 * ({ usernameEnv, passwordEnv }). Direct values win when both are present.
 */
export function resolveCredentials(credSpec = {}, env = process.env) {
  const username =
    credSpec.username ??
    (credSpec.usernameEnv ? env[credSpec.usernameEnv] : undefined) ??
    '';
  const password =
    credSpec.password ??
    (credSpec.passwordEnv ? env[credSpec.passwordEnv] : undefined) ??
    '';
  return { username, password };
}

/** Normalize a raw account descriptor into the canonical source-account shape. */
export function normalizeAccount(raw = {}, env = process.env) {
  const provider          = String(raw.provider ?? '').toLowerCase();
  const providerAccountId = raw.providerAccountId ?? raw.accountId ?? 'default';
  const displayName       = raw.displayName ?? `${provider.toUpperCase()} (${providerAccountId})`;
  // `credentials` may hold the spec, or the spec may be inline on the raw object.
  const credentials       = resolveCredentials(raw.credentials ?? raw, env);
  return { provider, providerAccountId, displayName, credentials };
}

/** Read the raw (un-normalized) account list from env or file, or null if none. */
function readRawAccounts({ config, env }) {
  // 1. Inline env JSON
  if (env.SOURCE_ACCOUNTS) {
    try {
      const parsed = JSON.parse(env.SOURCE_ACCOUNTS);
      const list = Array.isArray(parsed) ? parsed : parsed?.accounts;
      if (Array.isArray(list) && list.length > 0) return list;
    } catch {
      /* malformed env JSON → fall through to file/default */
    }
  }

  // 2. Config file
  const path = config?.accounts?.configPath;
  if (path && existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      const list = Array.isArray(parsed) ? parsed : parsed?.accounts;
      if (Array.isArray(list) && list.length > 0) return list;
    } catch {
      /* malformed file → fall through to default */
    }
  }

  return null;
}

/** True when a multi-account config (env or file) is present. */
export function isMultiAccountConfigured(opts = {}) {
  const config = opts.config ?? defaultConfig;
  const env    = opts.env    ?? process.env;
  return readRawAccounts({ config, env }) != null;
}

/**
 * Load the configured source accounts.
 *
 * Always returns a non-empty array. When nothing is configured it returns the
 * single backward-compatible default account, so existing single-account setups
 * keep working with zero new config.
 *
 * @param {object}   [opts]
 * @param {object[]} [opts.accounts] - explicit raw account descriptors (tests/programmatic)
 * @param {object}   [opts.config]   - config object override (defaults to app config)
 * @param {object}   [opts.env]      - env object override (defaults to process.env)
 * @returns {{ provider: string, providerAccountId: string, displayName: string, credentials: { username: string, password: string } }[]}
 */
export function loadSourceAccounts(opts = {}) {
  const config = opts.config ?? defaultConfig;
  const env    = opts.env    ?? process.env;

  if (Array.isArray(opts.accounts) && opts.accounts.length > 0) {
    return opts.accounts.map(a => normalizeAccount(a, env));
  }

  const raw = readRawAccounts({ config, env });
  if (raw) return raw.map(a => normalizeAccount(a, env));

  // Backward-compat default: single account from the existing single-provider env.
  const provider          = config.provider;
  const creds             = config.credentials?.[provider] ?? {};
  const providerAccountId = creds.accountId || 'default';
  return [{
    provider,
    providerAccountId,
    displayName: `${String(provider).toUpperCase()} (${providerAccountId})`,
    credentials: { username: creds.username ?? '', password: creds.password ?? '' },
  }];
}
