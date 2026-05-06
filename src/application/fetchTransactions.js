import { join } from 'path';
import { BrowserManager } from '../core/BrowserManager.js';
import { SessionStore } from '../infrastructure/sessionStore.js';
import { CheckpointStore } from '../infrastructure/checkpointStore.js';
import { SeenStore, fingerprint, contentHash, classifyTransaction } from '../infrastructure/dedup.js';
import { logger } from '../infrastructure/logger.js';
import { withRetry } from '../infrastructure/retry.js';
import { metrics } from '../infrastructure/metrics.js';
import { createRunReport, finalizeReport } from '../schema/runReport.js';
import { exportToJSON } from '../exporter.js';
import { config } from '../config.js';

// Side-effect import: populates the providerRegistry.
import '../providers/index.js';
import { providerRegistry } from '../core/providerRegistry.js';

/**
 * Core application use case: authenticate (or reuse session), fetch transactions,
 * handle mid-run re-authentication, deduplicate, optionally export, and return a
 * structured execution report alongside the data.
 *
 * Both CLI and API call this function — no business logic lives in either entrypoint.
 *
 * @param {object} opts
 * @param {string}  [opts.providerName]          - e.g. 'cal'. Defaults to config.provider.
 * @param {string}  [opts.accountId]             - Account/profile identifier.
 * @param {object}  [opts.credentials]           - { username, password }
 * @param {object}  [opts.browserConfig]         - { headless, slowMo }
 * @param {object}  [opts.fetchConfig]           - { daysBack }
 * @param {object}  [opts.exportConfig]          - { path }
 * @param {string}  [opts.sessionDir]            - Directory for session state files
 * @param {boolean} [opts.skipExport]            - Skip writing the JSON file
 * @param {boolean} [opts.resume]                - Resume from checkpoint if one exists (default: false)
 * @param {boolean} [opts.fullFetch]             - Ignore seen store; export all transactions (default: false)
 * @param {boolean} [opts.incremental]           - Stop early on consecutive already-seen rows
 * @param {number}  [opts.earlyStopThreshold]    - Consecutive already-seen rows before stopping
 *
 * @param {object} _deps  - Injectable overrides for testing. Not used in production.
 * @param {object}  [_deps.provider]
 * @param {object}  [_deps.browser]
 * @param {object}  [_deps.sessionStore]
 * @param {object}  [_deps.checkpointStore]
 * @param {object}  [_deps.seenStore]
 * @param {number}  [_deps.retryDelay]
 *
 * @returns {Promise<{ transactions: Transaction[], filePath: string|null, report: RunReport }>}
 */
export async function fetchTransactions(opts = {}, _deps = {}) {
  const providerName  = opts.providerName  ?? config.provider;
  const credentials   = opts.credentials   ?? config.credentials[providerName];
  const accountId     = opts.accountId     ?? credentials?.accountId ?? 'default';
  const browserConfig = opts.browserConfig ?? config.browser;
  const fetchConfig   = opts.fetchConfig   ?? config.fetch;
  const exportConfig  = opts.exportConfig  ?? config.export;
  const sessionDir    = opts.sessionDir    ?? config.session.storageDir;
  const skipExport    = opts.skipExport    ?? false;

  // Phase 4 options
  const resume             = opts.resume             ?? false;
  const fullFetch          = opts.fullFetch           ?? false;
  const incremental        = opts.incremental        ?? fetchConfig.incremental        ?? true;
  const earlyStopThreshold = opts.earlyStopThreshold ?? fetchConfig.earlyStopThreshold ?? 3;

  const report = createRunReport({ provider: providerName, accountId });

  // ── Validation ────────────────────────────────────────────────────────────
  if (!credentials?.username || !credentials?.password) {
    const err = new Error(
      `Missing credentials for provider "${providerName}". ` +
      `Set ${providerName.toUpperCase()}_USERNAME and ${providerName.toUpperCase()}_PASSWORD in .env`
    );
    finalizeReport(report, { status: 'failed', error: err });
    metrics.recordRun(report);
    throw err;
  }

  const retryDelay       = _deps.retryDelay       ?? 2000;
  const sessionStore     = _deps.sessionStore     ?? new SessionStore(sessionDir);
  const browser          = _deps.browser          ?? new BrowserManager();
  const provider         = _deps.provider         ?? providerRegistry.create(providerName, config);
  const checkpointStore  = _deps.checkpointStore  ?? new CheckpointStore(config.checkpoint.dir);
  const seenStore        = _deps.seenStore        ?? new SeenStore(config.seen.dir);

  try {
    // ── Load checkpoint (if resume requested) ─────────────────────────────
    let checkpoint = null;
    if (resume) {
      checkpoint = await checkpointStore.load(providerName, accountId);
      if (checkpoint) {
        report.resumed        = true;
        report.checkpointUsed = true;
        report.checkpointPath = checkpointStore.filePath(providerName, accountId);
        logger.info('Resuming from checkpoint', {
          provider: providerName,
          account:  accountId,
          nextIndex: checkpoint.nextIndex,
          priorTransactions: checkpoint.transactions?.length ?? 0,
        });
      } else {
        logger.info('No checkpoint found — starting fresh run', { provider: providerName, account: accountId });
      }
    }

    const startIndex         = checkpoint?.nextIndex      ?? 0;
    const priorTransactions  = checkpoint?.transactions   ?? [];
    const priorWarnings      = checkpoint?.warnings       ?? [];

    // ── Load seen fingerprints ─────────────────────────────────────────────
    if (!fullFetch) {
      await seenStore.load(providerName, accountId);
      logger.debug(`Loaded ${seenStore.size} seen fingerprint(s)`, { provider: providerName });
    }

    // ── Session restore ───────────────────────────────────────────────────
    const savedSession = await sessionStore.load(providerName, accountId);
    const page = await browser.launch(browserConfig, savedSession);
    provider.setPage(page);

    // ── Session validation ────────────────────────────────────────────────
    let authenticated = false;

    if (savedSession) {
      logger.info('Attempting to reuse saved session', { provider: providerName, account: accountId });
      authenticated = await provider.isSessionValid(page);

      if (authenticated) {
        report.sessionReused = true;
        logger.info('Session valid — skipping login', { provider: providerName, account: accountId });
      } else {
        logger.info('Session expired — performing fresh login', { provider: providerName, account: accountId });
      }
    }

    // ── Initial authentication (if needed) ────────────────────────────────
    if (!authenticated) {
      await withRetry(
        () => provider.login(credentials),
        {
          attempts: 2,
          delay: retryDelay,
          label: `${provider.name} login`,
          onRetry: () => { report.retryCount++; },
        }
      );
      logger.info('Login successful', { provider: providerName, account: accountId });

      const newState = await browser.getStorageState();
      await sessionStore.save(providerName, accountId, newState);
    }

    // ── Build onProgress callback ─────────────────────────────────────────
    // Called by the provider after each extracted transaction. Handles:
    //   1. Checkpoint save (for recovery on interruption)
    //   2. Classification for incremental early-stop (consecutive unchanged)
    //
    // Note: classification here drives early-stop only. The authoritative
    // dedup/export classification runs after the full fetch loop below.
    let consecutiveUnchanged = 0;

    const onProgress = async ({ index, transaction }) => {
      const fp   = fingerprint(transaction);
      const ch   = contentHash(transaction);
      const kind = classifyTransaction(seenStore, fp, ch, fullFetch);

      if (kind === 'unchanged') {
        consecutiveUnchanged++;
      } else {
        consecutiveUnchanged = 0; // created or updated resets the counter
      }

      await checkpointStore.save(providerName, accountId, {
        provider: providerName,
        accountId,
        startedAt: report.startedAt,
        daysBack:  fetchConfig.daysBack,
        nextIndex: index + 1,
        transactions: priorTransactions,
        warnings:     priorWarnings,
      });

      // Early stop: return false to signal the provider to break its loop
      if (incremental && earlyStopThreshold > 0 && consecutiveUnchanged >= earlyStopThreshold) {
        report.earlyStopTriggered = true;
        report.earlyStopReason    = `${earlyStopThreshold} consecutive unchanged transactions`;
        logger.info(`Early stop triggered: ${report.earlyStopReason}`, { provider: providerName });
        return false;
      }

      return true;
    };

    // ── Fetch transactions (with mid-run re-auth guard) ───────────────────
    logger.info('Fetching transactions', {
      provider: providerName,
      account:  accountId,
      daysBack: fetchConfig.daysBack,
      ...(startIndex > 0 ? { resumingFromIndex: startIndex } : {}),
    });

    let fetchResult;
    let reAuthAttempted = false;

    try {
      fetchResult = await provider.fetchTransactions({
        daysBack:   fetchConfig.daysBack,
        startIndex,
        onProgress,
      });
    } catch (fetchErr) {
      const isAuth = await provider.isAuthError(fetchErr).catch(() => false);

      if (isAuth && !reAuthAttempted) {
        reAuthAttempted = true;
        report.reAuthOccurred = true;
        logger.warn('Mid-run session loss detected — re-authenticating', {
          provider: providerName,
          account:  accountId,
          error:    fetchErr.message,
        });

        await withRetry(
          () => provider.login(credentials),
          {
            attempts: 2,
            delay:    retryDelay,
            label:    `${provider.name} re-auth`,
            onRetry:  () => { report.retryCount++; },
          }
        );

        const reAuthState = await browser.getStorageState();
        await sessionStore.save(providerName, accountId, reAuthState);

        logger.info('Re-authentication successful — retrying fetch', { provider: providerName, account: accountId });

        fetchResult = await provider.fetchTransactions({
          daysBack:   fetchConfig.daysBack,
          startIndex,
          onProgress,
        });
      } else {
        throw fetchErr;
      }
    }

    const { transactions: fetchedTransactions, warnings: providerWarnings = [] } = fetchResult;

    // ── Merge prior (checkpoint) + this run's transactions ────────────────
    const allTransactions = [...priorTransactions, ...fetchedTransactions];

    report.transactionsFetched        = fetchedTransactions.length;
    report.transactionsSkipped        = providerWarnings.length;
    report.totalTransactionsConsidered = allTransactions.length;
    report.warnings.push(...priorWarnings, ...providerWarnings);

    logger.info(`Fetched ${fetchedTransactions.length} transaction(s) in this run segment`, {
      provider: providerName,
      account:  accountId,
      prior:    priorTransactions.length,
      total:    allTransactions.length,
      skipped:  providerWarnings.length,
    });

    if (providerWarnings.length > 0) {
      logger.warn(`${providerWarnings.length} transaction(s) skipped during extraction`, { provider: providerName });
    }

    // ── Deduplication ─────────────────────────────────────────────────────
    // Classify each transaction as created / updated / unchanged.
    // Also deduplicate within this run (same dedupKey appearing twice).
    const seenInRun       = new Set();
    const exportedTxs     = []; // created + updated — emitted to caller and export file
    let createdCount      = 0;
    let updatedCount      = 0;
    let unchangedCount    = 0;
    let withinRunDupCount = 0;

    for (const tx of allTransactions) {
      const fp = fingerprint(tx);

      if (seenInRun.has(fp)) {
        withinRunDupCount++;
        continue;
      }
      seenInRun.add(fp);

      const ch   = contentHash(tx);
      const kind = classifyTransaction(seenStore, fp, ch, fullFetch);

      if (kind === 'created') {
        createdCount++;
        exportedTxs.push(tx);
      } else if (kind === 'updated') {
        updatedCount++;
        exportedTxs.push(tx);
      } else {
        unchangedCount++;
      }
    }

    report.createdCount            = createdCount;
    report.updatedCount            = updatedCount;
    report.unchangedCount          = unchangedCount;
    report.duplicatesSkipped       = withinRunDupCount;
    report.newTransactionsExported = createdCount + updatedCount;

    if (unchangedCount > 0) {
      logger.info(`${unchangedCount} unchanged transaction(s) excluded from export`, { provider: providerName });
    }
    if (updatedCount > 0) {
      logger.info(`${updatedCount} transaction(s) updated since last run`, { provider: providerName });
    }
    if (withinRunDupCount > 0) {
      logger.info(`${withinRunDupCount} within-run duplicate(s) skipped`, { provider: providerName });
    }

    // ── Persist refreshed session ─────────────────────────────────────────
    const finalState = await browser.getStorageState();
    await sessionStore.save(providerName, accountId, finalState);

    // ── Export ────────────────────────────────────────────────────────────
    let filePath = null;
    if (!skipExport && exportedTxs.length > 0) {
      const dateStr       = new Date().toISOString().split('T')[0];
      const accountSuffix = accountId && accountId !== 'default' ? `_${accountId}` : '';
      filePath = join(exportConfig.path, `${providerName}${accountSuffix}_${dateStr}.json`);
      await exportToJSON(exportedTxs, filePath);
      report.exportPath = filePath;
      logger.info(`Exported ${exportedTxs.length} transaction(s) to ${filePath} (created: ${createdCount}, updated: ${updatedCount})`);
    } else if (!skipExport && exportedTxs.length === 0) {
      logger.info('No new or updated transactions to export', { provider: providerName });
    }

    // ── Update seen store ─────────────────────────────────────────────────
    if (!fullFetch) {
      for (const tx of exportedTxs) seenStore.upsert(fingerprint(tx), contentHash(tx));
      await seenStore.save(providerName, accountId);
    }

    // ── Clear checkpoint (run completed successfully) ─────────────────────
    await checkpointStore.clear(providerName, accountId);

    // ── Finalize report ───────────────────────────────────────────────────
    const runStatus = providerWarnings.length > 0 ? 'partial' : 'success';
    finalizeReport(report, { status: runStatus });
    metrics.recordRun(report);

    return { transactions: exportedTxs, filePath, report };

  } catch (err) {
    // Clear the stored session on known auth failures so the next run starts clean
    const isAuthFailure =
      err.message?.includes('Login verification failed') ||
      err.message?.includes('login iframe did not appear') ||
      err.message?.includes('Missing credentials');

    if (isAuthFailure) {
      logger.warn('Auth failure — clearing stored session', { provider: providerName, account: accountId });
      await sessionStore.clear(providerName, accountId).catch(() => {});
    }

    // Checkpoint is NOT cleared on failure — preserved for resume

    finalizeReport(report, { status: 'failed', error: err });
    metrics.recordRun(report);

    throw err;

  } finally {
    await provider.cleanup().catch(() => {});
    await browser.close();
  }
}
