import { fetchTransactions } from './fetchTransactions.js';
import { loadSourceAccounts } from '../config/sourceAccounts.js';
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
  const accounts = opts.accounts ?? loadSourceAccounts();

  // Per-account fetch options forwarded only when explicitly provided, so each
  // call keeps fetchTransactions' own defaults otherwise.
  const passthrough = {};
  for (const key of ['resume', 'fullFetch', 'skipExport', 'fetchConfig', 'incremental', 'earlyStopThreshold']) {
    if (opts[key] !== undefined) passthrough[key] = opts[key];
  }

  const accountResults  = [];
  const allTransactions = [];

  logger.info('Multi-account fetch starting', { accounts: accounts.length });

  for (const account of accounts) {
    const deps = typeof _deps === 'function' ? _deps(account) : _deps;

    logger.info('Fetching source account', {
      provider:    account.provider,
      account:     account.providerAccountId,
      displayName: account.displayName,
    });

    try {
      const result = await fetchTransactions({
        providerName:      account.provider,
        providerAccountId: account.providerAccountId,
        displayName:       account.displayName,
        credentials:       account.credentials,
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
