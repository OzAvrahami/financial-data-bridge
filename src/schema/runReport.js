/**
 * Execution report schema — describes the outcome of a single provider fetch run.
 *
 * @typedef {Object} RunReport
 * @property {string}   provider            - e.g. 'cal'
 * @property {string}   accountId           - account/profile identifier
 * @property {string}   startedAt           - ISO timestamp
 * @property {string|null} finishedAt       - ISO timestamp, null while running
 * @property {number|null} durationMs       - wall-clock ms, null while running
 * @property {'running'|'success'|'partial'|'failed'} status
 * @property {number}   transactionsFetched
 * @property {number}   transactionsSkipped
 * @property {number}   retryCount          - login/re-auth retries at the application layer
 * @property {boolean}  reAuthOccurred      - true if mid-run re-authentication was triggered
 * @property {boolean}  sessionReused       - true if a saved session was valid at startup
 * @property {string[]} warnings            - recoverable errors / skipped items
 * @property {string|null} fatalError       - message of the exception that killed the run
 * @property {string|null} exportPath       - file written, or null
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
