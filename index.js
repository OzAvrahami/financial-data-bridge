import { fetchTransactions } from './src/application/fetchTransactions.js';
import { fetchAllAccounts } from './src/application/fetchAllAccounts.js';
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
  if (report.pendingSkippedCount > 0) logger.info(`  Pending:      ${report.pendingSkippedCount} skipped (unfinalized)`);
  if (report.createdCount > 0)   logger.info(`  Created:      ${report.createdCount} new transaction(s)`);
  if (report.updatedCount > 0)   logger.info(`  Updated:      ${report.updatedCount} changed transaction(s)`);
  if (report.unchangedCount > 0) logger.info(`  Unchanged:    ${report.unchangedCount} (excluded from export)`);
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

// ── Combined multi-account summary ─────────────────────────────────────────────
function printCombinedSummary(combined) {
  const sep = '═'.repeat(52);
  logger.info(sep);
  logger.info(`Multi-account run  accounts=${combined.summary.totalAccounts}  ` +
              `ok=${combined.summary.succeeded}  failed=${combined.summary.failed}  ` +
              `exported=${combined.summary.totalTransactionsExported}`);
  logger.info(sep);
  for (const acc of combined.accounts) {
    const label = acc.displayName || `${acc.provider}/${acc.providerAccountId}`;
    if (acc.status === 'failed') {
      logger.warn(`  ✗ ${label}: failed — ${acc.error}`);
    } else {
      logger.info(`  ✓ ${label}: ${acc.status}, ${acc.transactionsExported} exported` +
                  (acc.filePath ? `  → ${acc.filePath}` : ''));
    }
  }
  logger.info(sep);
}

async function main() {
  const allAccounts = hasFlag('--all-accounts');
  const resume      = hasFlag('--resume');
  const fullFetch   = hasFlag('--full-fetch');

  // ── Multi-account flow ────────────────────────────────────────────────────
  if (allAccounts) {
    logger.info('Financial data bridge starting (all configured accounts)', { resume, fullFetch });
    const combined = await fetchAllAccounts({ resume, fullFetch });
    printCombinedSummary(combined);
    if (combined.summary.failed > 0) process.exit(1);
    return;
  }

  // ── Single-account flow (unchanged) ───────────────────────────────────────
  const accountId = getArg('--account') || process.env.ACCOUNT_ID || '';

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
