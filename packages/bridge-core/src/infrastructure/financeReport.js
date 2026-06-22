import { writeFile, mkdir, rename } from 'fs/promises';
import { join } from 'path';

/**
 * Writes the per-run finance sync audit report as BOTH JSON and CSV under the
 * reports directory (default runtime/reports). One row/object per transaction
 * considered for finance sync, so the local dedup status and the finance sync
 * status are always reconcilable after the fact.
 */

// Column order is also the CSV header order. Keep in sync with the audit rows
// produced by syncTransactionsToFinance().
export const REPORT_COLUMNS = [
  'runId',
  'timestamp',
  'provider',
  'accountId',
  'accountLabel',
  'transactionDate',
  'merchant',
  'amount',
  'chargeAmount',
  'currency',
  'status',
  'localDedupStatus',
  'financeStatus',
  'reason',
  'apiStatus',
  'financeTransactionId',
  'dedupKey',
];

/** Escape a single CSV field per RFC 4180 (quote if it contains , " or newline). */
function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize audit rows to a CSV string with a header line. */
export function toCsv(rows, columns = REPORT_COLUMNS) {
  const header = columns.join(',');
  const lines = rows.map((row) => columns.map((c) => csvField(row[c])).join(','));
  return [header, ...lines].join('\n') + '\n';
}

/** Build the base file name (no extension) for a run's report. */
export function reportBaseName(runId) {
  return `finance-sync-${runId}`;
}

async function atomicWrite(path, content) {
  const tmp = path + '.tmp';
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, path);
}

/**
 * Write the JSON and CSV report files for a sync run.
 *
 * @param {object}   args
 * @param {string}   args.dir       Reports directory (e.g. runtime/reports).
 * @param {string}   args.runId     Stable, filename-safe run id.
 * @param {object}   args.summary   Counts + metadata for the run.
 * @param {object[]} args.rows      One audit row per considered transaction.
 * @returns {Promise<{ jsonPath: string, csvPath: string }>}
 */
export async function writeFinanceSyncReport({ dir, runId, summary, rows }) {
  await mkdir(dir, { recursive: true });
  const base = reportBaseName(runId);
  const jsonPath = join(dir, `${base}.json`);
  const csvPath = join(dir, `${base}.csv`);

  await atomicWrite(jsonPath, JSON.stringify({ runId, summary, transactions: rows }, null, 2));
  await atomicWrite(csvPath, toCsv(rows));

  return { jsonPath, csvPath };
}
