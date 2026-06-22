import { join } from 'path';
import { BrowserManager } from '../core/BrowserManager.js';
import { SessionStore } from '../infrastructure/sessionStore.js';
import { CheckpointStore } from '../infrastructure/checkpointStore.js';
import { SeenStore, contentHash, classifyTransaction, assignOccurrenceKeys } from '../infrastructure/dedup.js';
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
 * The desktop app and tests call this function — no business logic lives in the entry point.
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
 *
 * The full requested date range (daysBack) is ALWAYS scanned end to end. The
 * seen/dedup state decides only whether a transaction is exported — never whether
 * scanning continues. There is no early-stop optimization.
 *
 * @param {object} _deps  - Injectable overrides for testing. Not used in production.
 * @param {object}  [_deps.provider]
 * @param {object}  [_deps.browser]
 * @param {object}  [_deps.sessionStore]
 * @param {object}  [_deps.checkpointStore]
 * @param {object}  [_deps.seenStore]
 * @param {number}  [_deps.retryDelay]
 *
 * @returns {Promise<{ transactions: Transaction[], consideredTransactions: Transaction[], filePath: string|null, report: RunReport }>}
 *   `transactions` is the local-export set (created + updated). `consideredTransactions`
 *   is every transaction inspected this run, each tagged with `localDedupStatus`
 *   ('new' | 'updated' | 'unchanged' | 'duplicate') for downstream finance sync.
 */
export async function fetchTransactions(opts = {}, _deps = {}) {
  const providerName  = opts.providerName  ?? config.provider;
  const credentials   = opts.credentials   ?? config.credentials[providerName];
  // Stable source-account id used to scope all runtime state (session / seen /
  // checkpoint files) and stamped onto exported transactions. `accountId` is kept
  // as an alias so existing callers and the existing default flow are unchanged.
  const providerAccountId = opts.providerAccountId ?? opts.accountId ?? credentials?.accountId ?? 'default';
  const accountId     = providerAccountId;
  const displayName   = opts.displayName ?? '';
  const browserConfig = opts.browserConfig ?? config.browser;
  const fetchConfig   = opts.fetchConfig   ?? config.fetch;
  const exportConfig  = opts.exportConfig  ?? config.export;
  const sessionDir    = opts.sessionDir    ?? config.session.storageDir;
  const skipExport    = opts.skipExport    ?? false;

  const resume    = opts.resume    ?? false;
  const fullFetch = opts.fullFetch ?? false;

  const report = createRunReport({ provider: providerName, accountId, providerAccountId, displayName });

  // Structured, secret-free progress events for the UI / telemetry. Carries only
  // provider/account identifiers and counts — never credentials or page content.
  // A faulty listener must never break a fetch.
  const emit = (event) => {
    if (typeof opts.onEvent !== 'function') return;
    try { opts.onEvent({ provider: providerName, providerAccountId, displayName, ...event }); }
    catch { /* listener errors are swallowed on purpose */ }
  };

  // ── Validation ────────────────────────────────────────────────────────────
  if (!credentials?.username || !credentials?.password) {
    // Account-specific message (no .env reference — the desktop injects
    // credentials from the OS-encrypted store, not the environment).
    const err = new Error(
      `Missing credentials for ${displayName || providerAccountId} (${providerName}). ` +
      `Add a username and password for this account.`
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
      // A restored-but-invalid session leaves stale auth cookies in the context.
      // Logging in on top of that dirty state is what fails (the logged-out login
      // entry never renders). Drop the stale persisted session so a later run
      // won't reload it, and clear the live context before EACH attempt so every
      // try — including retries — starts from a clean, logged-out page.
      if (savedSession) {
        await sessionStore.clear(providerName, accountId).catch(() => {});
      }

      await withRetry(
        async () => {
          await browser.clearSession().catch(() => {});
          await provider.login(credentials);
        },
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

    emit({ type: 'login', sessionReused: report.sessionReused === true });

    // ── Build onProgress callback ─────────────────────────────────────────
    // Called by the provider after each extracted transaction, solely to save a
    // checkpoint for crash/interruption recovery. It NEVER stops the scan: the
    // entire requested date range is always inspected so that newly finalized,
    // previously missed, or modified transactions anywhere in the window are
    // discoverable. Dedup/export decisions happen after the full fetch loop below.
    const onProgress = async ({ index }) => {
      await checkpointStore.save(providerName, accountId, {
        provider: providerName,
        accountId,
        startedAt: report.startedAt,
        daysBack:  fetchConfig.daysBack,
        nextIndex: index + 1,
        transactions: priorTransactions,
        warnings:     priorWarnings,
      });
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
          async () => {
            // Re-auth also starts from a clean context: the mid-run session loss
            // left stale/redirected state that a plain re-login would inherit.
            await browser.clearSession().catch(() => {});
            await provider.login(credentials);
          },
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

    const { transactions: fetchedTransactions, warnings: providerWarnings = [], pendingSkipped = 0 } = fetchResult;

    // ── Merge prior (checkpoint) + this run's transactions ────────────────
    const allTransactions = [...priorTransactions, ...fetchedTransactions];

    // ── Assign occurrence-aware dedupKey to every transaction ─────────────
    // Must happen before the dedup loop so that two identical business-field
    // transactions (e.g. two recurring charges at the same merchant) each
    // receive a distinct dedupKey rather than collapsing into one.
    assignOccurrenceKeys(allTransactions);

    // ── Stamp source-account metadata on every transaction ────────────────
    // Source attribution for export + downstream consumers. These fields are NOT
    // part of fingerprint()/contentHash(), so stamping them never changes dedup
    // identity or existing seen state. `provider` is only set when the provider
    // did not already set it (CAL sets 'CAL'); we never overwrite it.
    for (const tx of allTransactions) {
      tx.providerAccountId   = providerAccountId;
      tx.providerDisplayName = displayName;
      if (!tx.provider) tx.provider = providerName;
    }

    report.transactionsFetched        = fetchedTransactions.length;
    report.transactionsSkipped        = providerWarnings.length;
    // Counted separately from extraction failures (transactionsSkipped) and
    // from unchanged/duplicate transactions.
    report.pendingSkippedCount        = pendingSkipped;
    report.totalTransactionsConsidered = allTransactions.length;
    report.warnings.push(...priorWarnings, ...providerWarnings);

    emit({
      type: 'fetched',
      transactionsFetched: report.transactionsFetched,
      pendingSkipped:      report.pendingSkippedCount,
      skipped:             report.transactionsSkipped,
    });

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
    // Uses tx.dedupKey (set by assignOccurrenceKeys above) as the canonical
    // identity so that business-field duplicates get distinct keys.
    const seenInRun       = new Set();
    const exportedTxs     = []; // created + updated — emitted to caller and export file
    let createdCount      = 0;
    let updatedCount      = 0;
    let unchangedCount    = 0;
    let withinRunDupCount = 0;

    // Every transaction considered this run, tagged with its local dedup outcome.
    // This is the input the finance sync engine needs: finance must decide what to
    // send based on its OWN ledger, not on the local created/updated/unchanged
    // status, so it needs to see ALL considered transactions — not just the
    // created/updated ones that flow into the local export file. Each tx is also
    // stamped in place with `localDedupStatus` so it travels with the object.
    const consideredTxs = [];

    for (const tx of allTransactions) {
      const key = tx.dedupKey;

      if (seenInRun.has(key)) {
        withinRunDupCount++;
        tx.localDedupStatus = 'duplicate';
        consideredTxs.push(tx);
        continue;
      }
      seenInRun.add(key);

      const ch   = contentHash(tx);
      const kind = classifyTransaction(seenStore, key, ch, fullFetch);

      if (kind === 'created') {
        createdCount++;
        tx.localDedupStatus = 'new';
        exportedTxs.push(tx);
      } else if (kind === 'updated') {
        updatedCount++;
        tx.localDedupStatus = 'updated';
        exportedTxs.push(tx);
      } else {
        unchangedCount++;
        tx.localDedupStatus = 'unchanged';
      }
      consideredTxs.push(tx);
    }

    report.createdCount            = createdCount;
    report.updatedCount            = updatedCount;
    report.unchangedCount          = unchangedCount;
    report.duplicatesSkipped       = withinRunDupCount;
    report.newTransactionsExported = createdCount + updatedCount;

    emit({
      type:       'dedup',
      created:    createdCount,
      updated:    updatedCount,
      unchanged:  unchangedCount,
      duplicates: withinRunDupCount,
    });

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

    emit({ type: 'export', exported: exportedTxs.length, filePath });

    // ── Update seen store ─────────────────────────────────────────────────
    if (!fullFetch) {
      for (const tx of exportedTxs) seenStore.upsert(tx.dedupKey, contentHash(tx));
      await seenStore.save(providerName, accountId);
    }

    // ── Clear checkpoint (run completed successfully) ─────────────────────
    await checkpointStore.clear(providerName, accountId);

    // ── Finalize report ───────────────────────────────────────────────────
    const runStatus = providerWarnings.length > 0 ? 'partial' : 'success';
    finalizeReport(report, { status: runStatus });
    metrics.recordRun(report);

    // `transactions` stays the local-export set (created + updated) for backward
    // compatibility. `consideredTransactions` is the full set the finance sync
    // engine evaluates against its own ledger.
    return { transactions: exportedTxs, consideredTransactions: consideredTxs, filePath, report };

  } catch (err) {
    // Clear the stored session on known auth failures so the next run starts clean
    const isAuthFailure =
      err?.name === 'CalLoginError' ||
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
