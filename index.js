import { fetchTransactions } from './src/application/fetchTransactions.js';
import { logger } from './src/infrastructure/logger.js';
import { config } from './src/config.js';

// ── Argument parsing ──────────────────────────────────────────────────────────
// Supports --account <id> flag or ACCOUNT_ID env variable.
// Example: node index.js --account mycard
function getCliAccountId() {
  const idx = process.argv.indexOf('--account');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.ACCOUNT_ID || '';
}

// ── Execution summary ─────────────────────────────────────────────────────────
function printSummary(report) {
  const sep = '─'.repeat(52);
  logger.info(sep);
  logger.info(`Run summary  provider=${report.provider}  account=${report.accountId}`);
  logger.info(`  Status:       ${report.status}`);
  logger.info(`  Duration:     ${((report.durationMs ?? 0) / 1000).toFixed(1)}s`);
  logger.info(`  Transactions: ${report.transactionsFetched} fetched, ${report.transactionsSkipped} skipped`);
  if (report.sessionReused)  logger.info('  Session:      reused (no login needed)');
  if (report.reAuthOccurred) logger.warn('  Re-auth:      mid-run re-authentication occurred');
  if (report.retryCount > 0) logger.info(`  Retries:      ${report.retryCount}`);
  if (report.exportPath)     logger.info(`  Exported to:  ${report.exportPath}`);

  if (report.warnings.length > 0) {
    logger.warn(`  Warnings (${report.warnings.length}):`);
    report.warnings.forEach(w => logger.warn(`    • ${w}`));
  }

  logger.info(sep);
}

async function main() {
  const accountId = getCliAccountId();
  const opts = accountId ? { accountId } : {};

  logger.info('Financial data bridge starting', {
    provider: config.provider,
    account: accountId || config.credentials[config.provider]?.accountId || 'default',
  });

  const { report } = await fetchTransactions(opts);
  printSummary(report);

  if (report.status === 'failed') {
    process.exit(1);
  }
}

main().catch(err => {
  logger.error('Fatal error', { message: err.message });
  if (config.debug) logger.error(err.stack);
  process.exit(1);
});
