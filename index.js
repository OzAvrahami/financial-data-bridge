import { fetchTransactions } from './src/application/fetchTransactions.js';
import { logger } from './src/infrastructure/logger.js';
import { config } from './src/config.js';

// ── Argument parsing ──────────────────────────────────────────────────────────
function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return '';
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

// ── Execution summary ─────────────────────────────────────────────────────────
function printSummary(report) {
  const sep = '─'.repeat(52);
  logger.info(sep);
  logger.info(`Run summary  provider=${report.provider}  account=${report.accountId}`);
  logger.info(`  Status:       ${report.status}`);
  logger.info(`  Duration:     ${((report.durationMs ?? 0) / 1000).toFixed(1)}s`);
  logger.info(`  Considered:   ${report.totalTransactionsConsidered} transaction(s)`);
  logger.info(`  Fetched:      ${report.transactionsFetched} (this run), ${report.transactionsSkipped} skipped`);
  logger.info(`  Exported:     ${report.newTransactionsExported} new transaction(s)`);

  if (report.alreadySeenCount > 0)  logger.info(`  Already seen: ${report.alreadySeenCount} (excluded from export)`);
  if (report.duplicatesSkipped > 0) logger.info(`  Duplicates:   ${report.duplicatesSkipped} within-run`);
  if (report.earlyStopTriggered)    logger.info(`  Early stop:   ${report.earlyStopReason}`);
  if (report.resumed)               logger.info(`  Resumed:      from checkpoint ${report.checkpointPath}`);
  if (report.sessionReused)         logger.info('  Session:      reused (no login needed)');
  if (report.reAuthOccurred)        logger.warn('  Re-auth:      mid-run re-authentication occurred');
  if (report.retryCount > 0)        logger.info(`  Retries:      ${report.retryCount}`);
  if (report.exportPath)            logger.info(`  Exported to:  ${report.exportPath}`);

  if (report.warnings.length > 0) {
    logger.warn(`  Warnings (${report.warnings.length}):`);
    report.warnings.forEach(w => logger.warn(`    • ${w}`));
  }

  logger.info(sep);
}

async function main() {
  const accountId = getArg('--account') || process.env.ACCOUNT_ID || '';
  const resume    = hasFlag('--resume');
  const fullFetch = hasFlag('--full-fetch');

  const opts = {
    ...(accountId ? { accountId } : {}),
    resume,
    fullFetch,
  };

  logger.info('Financial data bridge starting', {
    provider:  config.provider,
    account:   accountId || config.credentials[config.provider]?.accountId || 'default',
    resume,
    fullFetch,
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
