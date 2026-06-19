import { readFileSync } from 'fs';
import {
  exportToFinanceSystem,
  shouldSendTransaction,
} from './exportToFinanceSystem.js';
import { redactSecrets, safeUrl } from '../infrastructure/redact.js';

/** Resolve finance credentials from the in-memory config, falling back to env (tests/CLI). */
function resolveFinanceCredentials(financeConfig = {}) {
  return {
    apiUrl: financeConfig.apiUrl ?? process.env.FINANCE_API_URL,
    apiKey: financeConfig.apiKey ?? process.env.FINANCE_API_KEY,
  };
}

/**
 * Raised for problems with the *input* to a finance export — a missing/unreadable
 * file, a malformed payload, or missing API credentials. Callers can distinguish
 * these (user-correctable, validated before any network call) from errors thrown
 * mid-send by exportToFinanceSystem(); the desktop UI uses it to show a friendly
 * validation message.
 */
export class FinanceExportInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FinanceExportInputError';
  }
}

/**
 * Read and parse a transactions JSON file produced by a fetch run.
 *
 * @param {string} filePath
 * @returns {object[]} parsed transaction array
 * @throws {FinanceExportInputError} if the file cannot be read/parsed or is not an array
 */
export function loadTransactionFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new FinanceExportInputError(`cannot read "${filePath}": ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new FinanceExportInputError(`"${filePath}" must contain a JSON array of transactions.`);
  }

  return parsed;
}

/**
 * Pure planning step: split a transaction list into what would be sent vs skipped.
 * No IO, no env access — safe to call from a UI preview without side effects.
 *
 * @param {object[]} transactions
 * @returns {{ total: number, qualifying: object[], qualifyingCount: number, skipped: number }}
 */
export function planFinanceExport(transactions) {
  const qualifying = transactions.filter(shouldSendTransaction);
  return {
    total:           transactions.length,
    qualifying,
    qualifyingCount: qualifying.length,
    skipped:         transactions.length - qualifying.length,
  };
}

/**
 * Reusable finance-export use case. Loads transactions (from a file path or a
 * provided array), computes the plan, and — only when `execute` is true —
 * validates credentials and sends qualifying transactions to the finance system.
 *
 * This is the single entry point shared by the desktop app and tests. It performs
 * no console output and never calls process.exit(); it returns a structured
 * result or throws.
 *
 * @param {object}   options
 * @param {string}   [options.filePath]      Path to a transactions JSON file. Required unless `transactions` is given.
 * @param {object[]} [options.transactions]  Pre-loaded transaction array (takes precedence over filePath).
 * @param {boolean}  [options.execute=false] If false (default), dry-run: nothing is sent. If true, send for real.
 * @param {function} [options.onBeforeSend]  Optional async hook called just before sending (execute mode only),
 *                                           with { apiUrl, plan, filePath, transactions }. A UI can use it
 *                                           to surface progress, or ignore it.
 * @param {{ apiUrl?: string, apiKey?: string }} [options.financeConfig]  In-memory finance credentials
 *                                           (the desktop passes the UI-configured values). Falls back to
 *                                           process.env when omitted.
 *
 * @returns {Promise<{
 *   executed: boolean, filePath: string|null, total: number,
 *   qualifying: object[], qualifyingCount: number, skipped: number,
 *   sentCount: number, apiUrl: string|null
 * }>}
 * @throws {FinanceExportInputError} for input/credential problems (validated before any network call)
 */
export async function runFinanceExport(options = {}) {
  const { filePath = null, transactions = null, execute = false, onBeforeSend = null, financeConfig = {} } = options;

  // ── Resolve the transaction list ──────────────────────────────────────────
  let txs = transactions;
  if (!txs) {
    if (!filePath) {
      throw new FinanceExportInputError('Either "filePath" or "transactions" is required.');
    }
    txs = loadTransactionFile(filePath);
  } else if (!Array.isArray(txs)) {
    throw new FinanceExportInputError('"transactions" must be an array.');
  }

  const plan = planFinanceExport(txs);

  // ── Dry-run (default) ──────────────────────────────────────────────────────
  if (!execute) {
    return { executed: false, filePath, ...plan, sentCount: 0, apiUrl: null };
  }

  // ── Execute mode ───────────────────────────────────────────────────────────
  // Validate credentials before any network call so the error is immediate and clear.
  const { apiUrl, apiKey } = resolveFinanceCredentials(financeConfig);

  if (!apiUrl) {
    throw new FinanceExportInputError(
      'Finance API URL is not configured. Set it in Financial System Integration settings.'
    );
  }
  if (!apiKey) {
    throw new FinanceExportInputError(
      'Finance API key is not saved. Add it in Financial System Integration settings.'
    );
  }

  if (onBeforeSend) {
    await onBeforeSend({ apiUrl: safeUrl(apiUrl), plan, filePath, transactions: txs });
  }

  // Pass the full list; exportToFinanceSystem() applies shouldSendTransaction()
  // internally — preserving the exact send behavior.
  await exportToFinanceSystem(txs, { apiUrl, apiKey });

  // Return a redacted URL only (never the key); callers/UI display this safely.
  return { executed: true, filePath, ...plan, sentCount: plan.qualifyingCount, apiUrl: safeUrl(apiUrl) };
}

/**
 * Lightweight connectivity/auth check for the finance system. Performs a single
 * GET to the configured endpoint with the Bearer token and interprets the result.
 * Never sends a transaction. All returned/thrown text is secret-redacted.
 *
 * @param {{ apiUrl?: string, apiKey?: string }} [financeConfig]
 * @param {{ fetch?: typeof fetch }} [deps]  inject a fetch impl for testing
 * @returns {Promise<{ ok: boolean, status?: number, message: string }>}
 */
export async function testFinanceConnection(financeConfig = {}, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const { apiUrl, apiKey } = resolveFinanceCredentials(financeConfig);

  if (!apiUrl) throw new FinanceExportInputError('Finance API URL is not set.');
  if (!apiKey) throw new FinanceExportInputError('Finance API key is not saved.');

  let response;
  try {
    response = await fetchImpl(apiUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    return { ok: false, message: `Connection failed: ${redactSecrets(err.message, [apiKey, apiUrl])}` };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: response.status, message: `Authentication failed (HTTP ${response.status}) — check the API key.` };
  }
  // Any other HTTP response (incl. 404/405 for a POST-only endpoint) proves the
  // server is reachable and the key was accepted at the transport layer.
  return { ok: true, status: response.status, message: `Connection OK (HTTP ${response.status}).` };
}
