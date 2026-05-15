/**
 * Finance export CLI.
 *
 * Reads a local transaction JSON file produced by `npm run fetch` and sends
 * qualifying transactions to the finance system via exportToFinanceSystem().
 *
 * Default: dry-run. Prints what would be sent but makes zero HTTP requests.
 * Real send requires the explicit --execute flag.
 *
 * Usage:
 *   node scripts/exportToFinance.js --file exports/CAL_YYYY-MM-DD.json
 *   node scripts/exportToFinance.js --file exports/CAL_YYYY-MM-DD.json --execute
 */

import { readFileSync } from 'fs';
import dotenv from 'dotenv';
import {
  exportToFinanceSystem,
  shouldSendTransaction,
} from '../src/application/exportToFinanceSystem.js';

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

  // ── Load file ───────────────────────────────────────────────────────────────

  let transactions;
  try {
    transactions = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`Error: cannot read "${filePath}": ${err.message}\n`);
    process.exit(1);
  }

  if (!Array.isArray(transactions)) {
    process.stderr.write(`Error: "${filePath}" must contain a JSON array of transactions.\n`);
    process.exit(1);
  }

  const qualifying = transactions.filter(shouldSendTransaction);
  const skipped    = transactions.length - qualifying.length;

  // ── Dry-run (default) ───────────────────────────────────────────────────────

  if (!execute) {
    process.stdout.write(SEP + '\n');
    process.stdout.write('DRY RUN — no data will be sent\n');
    process.stdout.write(SEP + '\n');
    process.stdout.write(`File:              ${filePath}\n`);
    process.stdout.write(`Total loaded:      ${transactions.length} transaction(s)\n`);
    process.stdout.write(`Would be sent:     ${qualifying.length} (status=completed, chargeAmount>0)\n`);
    process.stdout.write(`Would be skipped:  ${skipped} (pending or chargeAmount≤0)\n`);

    if (qualifying.length > 0) {
      process.stdout.write('\nTransactions that WOULD be sent:\n');
      qualifying.forEach((tx, i) => {
        const merchant = (tx.merchantName ?? '').padEnd(24);
        const amount   = `${tx.amount} ${tx.currency} → ${tx.chargeAmount} ${tx.chargeCurrency}`;
        const key      = tx.dedupKey || '(no dedupKey)';
        process.stdout.write(`  #${i + 1}  ${tx.transactionDate}  ${merchant}  ${amount}  [${key}]\n`);
      });
    }

    process.stdout.write('\nTo send for real, add --execute:\n');
    process.stdout.write(`  npm run export:finance -- --file ${filePath} --execute\n`);
    process.stdout.write(SEP + '\n');
    return;
  }

  // ── Execute mode ────────────────────────────────────────────────────────────
  // Validate credentials before any network call so the error is immediate and clear.

  const apiUrl = process.env.FINANCE_API_URL;
  const apiKey = process.env.FINANCE_API_KEY;

  if (!apiUrl) {
    process.stderr.write('Error: FINANCE_API_URL is not set. Add it to your .env file.\n');
    process.exit(1);
  }
  if (!apiKey) {
    process.stderr.write('Error: FINANCE_API_KEY is not set. Add it to your .env file.\n');
    process.exit(1);
  }

  process.stdout.write(SEP + '\n');
  process.stdout.write(`Exporting ${qualifying.length} of ${transactions.length} transaction(s)\n`);
  process.stdout.write(`File:    ${filePath}\n`);
  process.stdout.write(`Target:  ${apiUrl}\n`);
  process.stdout.write(SEP + '\n');

  await exportToFinanceSystem(transactions);

  process.stdout.write('Done. All qualifying transactions sent successfully.\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
