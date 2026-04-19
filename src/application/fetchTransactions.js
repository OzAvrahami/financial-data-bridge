import { join } from 'path';
import { BrowserManager } from '../core/BrowserManager.js';
import { SessionStore } from '../infrastructure/sessionStore.js';
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
 * handle mid-run re-authentication, collect warnings, optionally export, and
 * return a structured execution report alongside the data.
 *
 * Both CLI and API call this function — no business logic lives in either entrypoint.
 *
 * @param {object} opts
 * @param {string}  [opts.providerName]   - e.g. 'cal'. Defaults to config.provider.
 * @param {string}  [opts.accountId]      - Account/profile identifier. Defaults to config credentials value.
 * @param {object}  [opts.credentials]    - { username, password }. Defaults to config.credentials[provider].
 * @param {object}  [opts.browserConfig]  - { headless, slowMo }
 * @param {object}  [opts.fetchConfig]    - { daysBack }
 * @param {object}  [opts.exportConfig]   - { path }
 * @param {string}  [opts.sessionDir]     - Directory for session state files
 * @param {boolean} [opts.skipExport]     - Skip writing the JSON file (e.g. for API-only callers)
 *
 * @param {object} _deps  - Injectable overrides for testing. Not used in production.
 * @param {object}  [_deps.provider]      - Fake provider instance (bypasses providerRegistry)
 * @param {object}  [_deps.browser]       - Fake BrowserManager instance
 * @param {object}  [_deps.sessionStore]  - Fake SessionStore instance
 * @param {number}  [_deps.retryDelay]    - ms delay for login/re-auth retries (default 2000; use 0 in tests)
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

  const retryDelay   = _deps.retryDelay   ?? 2000;
  const sessionStore = _deps.sessionStore ?? new SessionStore(sessionDir);
  const browser      = _deps.browser      ?? new BrowserManager();
  const provider     = _deps.provider     ?? providerRegistry.create(providerName, config);

  try {
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

    // ── Fetch transactions (with mid-run re-auth guard) ───────────────────
    logger.info('Fetching transactions', { provider: providerName, account: accountId, daysBack: fetchConfig.daysBack });

    let fetchResult;
    let reAuthAttempted = false;

    try {
      fetchResult = await provider.fetchTransactions({ daysBack: fetchConfig.daysBack });
    } catch (fetchErr) {
      // Check whether the error looks like a session expiry
      const isAuth = await provider.isAuthError(fetchErr).catch(() => false);

      if (isAuth && !reAuthAttempted) {
        reAuthAttempted = true;
        report.reAuthOccurred = true;
        logger.warn('Mid-run session loss detected — re-authenticating', {
          provider: providerName,
          account: accountId,
          error: fetchErr.message,
        });

        await withRetry(
          () => provider.login(credentials),
          {
            attempts: 2,
            delay: retryDelay,
            label: `${provider.name} re-auth`,
            onRetry: () => { report.retryCount++; },
          }
        );

        const reAuthState = await browser.getStorageState();
        await sessionStore.save(providerName, accountId, reAuthState);

        logger.info('Re-authentication successful — retrying fetch', { provider: providerName, account: accountId });

        // One retry after re-auth. If this also fails we let it propagate.
        fetchResult = await provider.fetchTransactions({ daysBack: fetchConfig.daysBack });
      } else {
        throw fetchErr;
      }
    }

    // ── Collect results ───────────────────────────────────────────────────
    const { transactions, warnings: providerWarnings = [] } = fetchResult;

    report.transactionsFetched = transactions.length;
    report.transactionsSkipped = providerWarnings.length;
    report.warnings.push(...providerWarnings);

    logger.info(`Fetched ${transactions.length} transaction(s)`, {
      provider: providerName,
      account: accountId,
      skipped: providerWarnings.length,
    });

    if (providerWarnings.length > 0) {
      logger.warn(`${providerWarnings.length} transaction(s) skipped during extraction`, {
        provider: providerName,
      });
    }

    // ── Persist refreshed session ─────────────────────────────────────────
    const finalState = await browser.getStorageState();
    await sessionStore.save(providerName, accountId, finalState);

    // ── Export ────────────────────────────────────────────────────────────
    let filePath = null;
    if (!skipExport && transactions.length > 0) {
      const dateStr = new Date().toISOString().split('T')[0];
      const accountSuffix = accountId && accountId !== 'default' ? `_${accountId}` : '';
      filePath = join(exportConfig.path, `${providerName}${accountSuffix}_${dateStr}.json`);
      await exportToJSON(transactions, filePath);
      report.exportPath = filePath;
      logger.info(`Exported ${transactions.length} transaction(s) to ${filePath}`);
    }

    // ── Finalize report ───────────────────────────────────────────────────
    const runStatus = providerWarnings.length > 0 ? 'partial' : 'success';
    finalizeReport(report, { status: runStatus });
    metrics.recordRun(report);

    return { transactions, filePath, report };

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

    finalizeReport(report, { status: 'failed', error: err });
    metrics.recordRun(report);

    throw err;

  } finally {
    await provider.cleanup().catch(() => {});
    await browser.close();
  }
}
