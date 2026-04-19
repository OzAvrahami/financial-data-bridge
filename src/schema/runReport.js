/**
 * Execution report schema — describes the outcome of a single provider fetch run.
 *
 * @typedef {Object} RunReport
 * @property {string}   provider
 * @property {string}   accountId
 * @property {string}   startedAt                 - ISO timestamp
 * @property {string|null} finishedAt             - ISO timestamp, null while running
 * @property {number|null} durationMs             - wall-clock ms, null while running
 * @property {'running'|'success'|'partial'|'failed'} status
 * @property {number}   transactionsFetched       - rows extracted by provider in this run
 * @property {number}   transactionsSkipped       - rows the provider could not extract
 * @property {number}   retryCount                - login/re-auth retries at application layer
 * @property {boolean}  reAuthOccurred
 * @property {boolean}  sessionReused
 * @property {string[]} warnings
 * @property {string|null} fatalError
 * @property {string|null} exportPath
 * // Phase 4 — checkpoint + resume
 * @property {boolean}  resumed                   - true when a checkpoint was loaded and used
 * @property {boolean}  checkpointUsed
 * @property {string|null} checkpointPath
 * // Phase 4 — dedup + incremental
 * @property {number}   totalTransactionsConsidered - prior (checkpoint) + fetched this run
 * @property {number}   alreadySeenCount           - transactions already in SeenStore
 * @property {number}   duplicatesSkipped          - within-run duplicate fingerprints
 * @property {number}   newTransactionsExported    - transactions written to the export file
 * @property {boolean}  earlyStopTriggered
 * @property {string|null} earlyStopReason
 */

export function createRunReport({ provider, accountId = 'default' } = {}) {
  return {
    provider,
    accountId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    status: 'running',
    transactionsFetched: 0,
    transactionsSkipped: 0,
    retryCount: 0,
    reAuthOccurred: false,
    sessionReused: false,
    warnings: [],
    fatalError: null,
    exportPath: null,
    // Phase 4
    resumed: false,
    checkpointUsed: false,
    checkpointPath: null,
    totalTransactionsConsidered: 0,
    alreadySeenCount: 0,
    duplicatesSkipped: 0,
    newTransactionsExported: 0,
    earlyStopTriggered: false,
    earlyStopReason: null,
  };
}

/** Stamps finishedAt/durationMs and sets status. Mutates and returns the report. */
export function finalizeReport(report, { status, error = null } = {}) {
  const now = new Date();
  report.finishedAt = now.toISOString();
  report.durationMs = now - new Date(report.startedAt);
  report.status = status;
  if (error) report.fatalError = error.message ?? String(error);
  return report;
}
