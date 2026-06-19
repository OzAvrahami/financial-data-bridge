import { fetchTransactions } from './fetchTransactions.js';
import { loadSourceAccounts, getEnabledAccounts } from '../config/sourceAccounts.js';
import { logger } from '../infrastructure/logger.js';

/**
 * Sequential multi-account fetch use case.
 *
 * Runs each configured source account one at a time (never in parallel — a single
 * browser session at any moment) and collects the per-account results into one
 * combined report. A failure in one account is recorded and does NOT abort the
 * remaining accounts.
 *
 * Provider-agnostic: each account names its own provider, so future providers
 * plug in with no change here. CAL is simply the first provider configured.
 *
 * Backward compatible: with no multi-account config, loadSourceAccounts() returns
 * the single default account and this behaves like one ordinary fetch.
 *
 * @param {object}   [opts]
 * @param {object[]} [opts.accounts]            - explicit source accounts (else loaded from config)
 * @param {number}   [opts.daysBack]            - global days-back; an account's own
 *                                                integer `daysBack` overrides it.
 * @param {Function} [opts.onEvent]             - secret-free progress callback. Receives
 *                                                account-start / account-done / account-error
 *                                                events plus the per-account phase events
 *                                                emitted by fetchTransactions.
 * @param {boolean}  [opts.resume]
 * @param {boolean}  [opts.fullFetch]
 * @param {boolean}  [opts.skipExport]
 * @param {object}   [opts.fetchConfig]
 * @param {boolean}  [opts.incremental]
 * @param {number}   [opts.earlyStopThreshold]
 *
 * @param {object|function} [_deps] - test seam forwarded to fetchTransactions.
 *        May be a single deps bundle (shared) or a function (account) => deps
 *        to provide isolated fakes per account.
 *
 * @returns {Promise<{
 *   accounts: Array<{ provider, providerAccountId, displayName, status,
 *                     transactionsExported, filePath, transactions, report, error }>,
 *   transactions: object[],
 *   summary: { totalAccounts, succeeded, failed, totalTransactionsExported }
 * }>}
 */
export async function fetchAllAccounts(opts = {}, _deps = {}) {
  // Explicit accounts are used as-is (tests/programmatic). When loading from
  // config, skip disabled accounts so "fetch all" runs only enabled ones.
  const accounts = opts.accounts ?? getEnabledAccounts(loadSourceAccounts());

  // Per-account fetch options forwarded only when explicitly provided, so each
  // call keeps fetchTransactions' own defaults otherwise. `fetchConfig` is handled
  // separately below so per-account daysBack can override the global value.
  const passthrough = {};
  for (const key of ['resume', 'fullFetch', 'skipExport', 'incremental', 'earlyStopThreshold']) {
    if (opts[key] !== undefined) passthrough[key] = opts[key];
  }

  // Global days-back baseline: explicit opts.daysBack wins, else any fetchConfig.daysBack.
  const baseFetchConfig = opts.fetchConfig ?? {};
  const globalDaysBack =
    Number.isInteger(opts.daysBack)            ? opts.daysBack :
    Number.isInteger(baseFetchConfig.daysBack) ? baseFetchConfig.daysBack :
    undefined;

  // Secret-free progress callback. A faulty listener must never abort the run.
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  const emit = (event) => {
    if (!onEvent) return;
    try { onEvent(event); } catch { /* listener errors are swallowed on purpose */ }
  };

  const accountResults  = [];
  const allTransactions = [];

  logger.info('Multi-account fetch starting', { accounts: accounts.length });

  for (const account of accounts) {
    const deps = typeof _deps === 'function' ? _deps(account) : _deps;

    // Per-account daysBack override wins over the global value.
    const effectiveDaysBack =
      Number.isInteger(account.daysBack) ? account.daysBack : globalDaysBack;
    const fetchConfig = { ...baseFetchConfig };
    if (effectiveDaysBack !== undefined) fetchConfig.daysBack = effectiveDaysBack;

    logger.info('Fetching source account', {
      provider:    account.provider,
      account:     account.providerAccountId,
      displayName: account.displayName,
    });

    emit({
      type:              'account-start',
      provider:          account.provider,
      providerAccountId: account.providerAccountId,
      displayName:       account.displayName,
      daysBack:          effectiveDaysBack ?? null,
    });

    try {
      const result = await fetchTransactions({
        providerName:      account.provider,
        providerAccountId: account.providerAccountId,
        displayName:       account.displayName,
        credentials:       account.credentials,
        ...(Object.keys(fetchConfig).length ? { fetchConfig } : {}),
        ...(onEvent ? { onEvent } : {}),
        ...passthrough,
      }, deps);

      accountResults.push({
        provider:             account.provider,
        providerAccountId:    account.providerAccountId,
        displayName:          account.displayName,
        status:               result.report.status,
        transactionsExported: result.transactions.length,
        filePath:             result.filePath,
        transactions:         result.transactions,
        report:               result.report,
        error:                null,
      });
      allTransactions.push(...result.transactions);

      emit({
        type:              'account-done',
        provider:          account.provider,
        providerAccountId: account.providerAccountId,
        displayName:       account.displayName,
        status:            result.report.status,
        summary:           summarizeReport(result.report),
      });
    } catch (err) {
      logger.error('Source account fetch failed', {
        provider: account.provider,
        account:  account.providerAccountId,
        error:    err.message,
      });
      accountResults.push({
        provider:             account.provider,
        providerAccountId:    account.providerAccountId,
        displayName:          account.displayName,
        status:               'failed',
        transactionsExported: 0,
        filePath:             null,
        transactions:         [],
        report:               null,
        error:                err.message,
      });

      emit({
        type:              'account-error',
        provider:          account.provider,
        providerAccountId: account.providerAccountId,
        displayName:       account.displayName,
        error:             err.message,
      });
    }
  }

  const succeeded = accountResults.filter(r => r.status === 'success' || r.status === 'partial').length;
  const failed    = accountResults.filter(r => r.status === 'failed').length;

  return {
    accounts:     accountResults,
    transactions: allTransactions,
    summary: {
      totalAccounts:             accounts.length,
      succeeded,
      failed,
      totalTransactionsExported: allTransactions.length,
    },
  };
}

/** Secret-free per-account count summary derived from a run report. */
function summarizeReport(report = {}) {
  return {
    sessionReused:       report.sessionReused === true,
    transactionsFetched: report.transactionsFetched ?? 0,
    pendingSkipped:      report.pendingSkippedCount ?? 0,
    skipped:             report.transactionsSkipped ?? 0,
    created:             report.createdCount ?? 0,
    updated:             report.updatedCount ?? 0,
    unchanged:           report.unchangedCount ?? 0,
    duplicates:          report.duplicatesSkipped ?? 0,
    exported:            report.newTransactionsExported ?? 0,
    exportPath:          report.exportPath ?? null,
  };
}
