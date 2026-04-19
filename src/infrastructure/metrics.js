/**
 * In-memory run statistics.
 *
 * Intentionally simple: no persistence, no time-series, no external dependencies.
 * Resets when the process restarts. Useful for API /metrics during a session
 * and for spotting patterns in logs.
 */

const state = {
  totalRuns: 0,
  successfulRuns: 0,
  partialRuns: 0,
  failedRuns: 0,
  totalRetries: 0,
  totalReAuths: 0,
  totalTransactionsFetched: 0,
  totalTransactionsSkipped: 0,
  lastRunAt: null,
  lastRunDurationMs: null,
  lastRunStatus: null,
  lastRunProvider: null,
};

export const metrics = {
  /** Called by the application layer at the end of every run (success or failure). */
  recordRun(report) {
    state.totalRuns++;
    state.lastRunAt = report.finishedAt;
    state.lastRunDurationMs = report.durationMs;
    state.lastRunStatus = report.status;
    state.lastRunProvider = report.provider;
    state.totalRetries += report.retryCount ?? 0;
    if (report.reAuthOccurred) state.totalReAuths++;
    state.totalTransactionsFetched += report.transactionsFetched ?? 0;
    state.totalTransactionsSkipped += report.transactionsSkipped ?? 0;

    if (report.status === 'success') state.successfulRuns++;
    else if (report.status === 'partial') state.partialRuns++;
    else if (report.status === 'failed') state.failedRuns++;
  },

  /** Returns a shallow copy of current stats. */
  snapshot() {
    return { ...state, uptimeSec: Math.floor(process.uptime()) };
  },

  /** Reset all counters to zero. Intended for use in tests only. */
  reset() {
    Object.assign(state, {
      totalRuns: 0,
      successfulRuns: 0,
      partialRuns: 0,
      failedRuns: 0,
      totalRetries: 0,
      totalReAuths: 0,
      totalTransactionsFetched: 0,
      totalTransactionsSkipped: 0,
      lastRunAt: null,
      lastRunDurationMs: null,
      lastRunStatus: null,
      lastRunProvider: null,
    });
  },
};
