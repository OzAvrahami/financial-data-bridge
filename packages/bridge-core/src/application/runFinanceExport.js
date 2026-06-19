import { readFileSync } from 'fs';
import {
  exportToFinanceSystem,
  shouldSendTransaction,
} from './exportToFinanceSystem.js';

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
 *
 * @returns {Promise<{
 *   executed: boolean, filePath: string|null, total: number,
 *   qualifying: object[], qualifyingCount: number, skipped: number,
 *   sentCount: number, apiUrl: string|null
 * }>}
 * @throws {FinanceExportInputError} for input/credential problems (validated before any network call)
 */
export async function runFinanceExport(options = {}) {
  const { filePath = null, transactions = null, execute = false, onBeforeSend = null } = options;

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
  const apiUrl = process.env.FINANCE_API_URL;
  const apiKey = process.env.FINANCE_API_KEY;

  if (!apiUrl) throw new FinanceExportInputError('FINANCE_API_URL is not set. Add it to your .env file.');
  if (!apiKey) throw new FinanceExportInputError('FINANCE_API_KEY is not set. Add it to your .env file.');

  if (onBeforeSend) {
    await onBeforeSend({ apiUrl, plan, filePath, transactions: txs });
  }

  // Pass the full list; exportToFinanceSystem() applies shouldSendTransaction()
  // internally — preserving the exact send behavior.
  await exportToFinanceSystem(txs);

  return { executed: true, filePath, ...plan, sentCount: plan.qualifyingCount, apiUrl };
}
