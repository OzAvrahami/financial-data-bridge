/**
 * Finance export CLI.
 *
 * Reads a local transaction JSON file produced by `npm run fetch` and sends
 * qualifying transactions to the finance system via runFinanceExport().
 *
 * Default: dry-run. Prints what would be sent but makes zero HTTP requests.
 * Real send requires the explicit --execute flag.
 *
 * This script is a thin wrapper: it parses CLI args and formats output. All
 * business logic (loading, filtering, validation, sending) lives in the reusable
 * application function runFinanceExport(), which the desktop UI and tests also use.
 *
 * Usage:
 *   node scripts/exportToFinance.js --file exports/CAL_YYYY-MM-DD.json
 *   node scripts/exportToFinance.js --file exports/CAL_YYYY-MM-DD.json --execute
 */

import dotenv from 'dotenv';
import {
  runFinanceExport,
  FinanceExportInputError,
} from '../src/application/runFinanceExport.js';

dotenv.config();

const SEP = '─'.repeat(60);

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs() {
  const fileIdx = process.argv.indexOf('--file');
  const filePath =
    fileIdx !== -1 &&
    process.argv[fileIdx + 1] &&
    !process.argv[fileIdx + 1].startsWith('--')
      ? process.argv[fileIdx + 1]
      : null;

  const execute = process.argv.includes('--execute');
  return { filePath, execute };
}

// ── Presentation ────────────────────────────────────────────────────────────

function printDryRun(filePath, result) {
  process.stdout.write(SEP + '\n');
  process.stdout.write('DRY RUN — no data will be sent\n');
  process.stdout.write(SEP + '\n');
  process.stdout.write(`File:              ${filePath}\n`);
  process.stdout.write(`Total loaded:      ${result.total} transaction(s)\n`);
  process.stdout.write(`Would be sent:     ${result.qualifyingCount} (status=completed, chargeAmount>0)\n`);
  process.stdout.write(`Would be skipped:  ${result.skipped} (pending or chargeAmount≤0)\n`);

  if (result.qualifyingCount > 0) {
    process.stdout.write('\nTransactions that WOULD be sent:\n');
    result.qualifying.forEach((tx, i) => {
      const merchant = (tx.merchantName ?? '').padEnd(24);
      const amount   = `${tx.amount} ${tx.currency} → ${tx.chargeAmount} ${tx.chargeCurrency}`;
      const key      = tx.dedupKey || '(no dedupKey)';
      process.stdout.write(`  #${i + 1}  ${tx.transactionDate}  ${merchant}  ${amount}  [${key}]\n`);
    });
  }

  process.stdout.write('\nTo send for real, add --execute:\n');
  process.stdout.write(`  npm run export:finance -- --file ${filePath} --execute\n`);
  process.stdout.write(SEP + '\n');
}

// Printed just before transactions are sent, so the header appears above the
// per-transaction output produced by exportToFinanceSystem().
function printExecuteHeader({ apiUrl, plan, filePath }) {
  process.stdout.write(SEP + '\n');
  process.stdout.write(`Exporting ${plan.qualifyingCount} of ${plan.total} transaction(s)\n`);
  process.stdout.write(`File:    ${filePath}\n`);
  process.stdout.write(`Target:  ${apiUrl}\n`);
  process.stdout.write(SEP + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { filePath, execute } = parseArgs();

  if (!filePath) {
    process.stderr.write(
      'Error: --file <path> is required.\n\n' +
      'Usage:\n' +
      '  npm run export:finance -- --file exports/CAL_YYYY-MM-DD.json\n' +
      '  npm run export:finance -- --file exports/CAL_YYYY-MM-DD.json --execute\n'
    );
    process.exit(1);
  }

  let result;
  try {
    result = await runFinanceExport({
      filePath,
      execute,
      onBeforeSend: printExecuteHeader,
    });
  } catch (err) {
    // Input/credential problems are user-correctable — print and exit cleanly.
    // Anything else (e.g. a mid-send HTTP failure) bubbles to the Fatal handler.
    if (err instanceof FinanceExportInputError) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  if (!result.executed) {
    printDryRun(filePath, result);
    return;
  }

  process.stdout.write('Done. All qualifying transactions sent successfully.\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
