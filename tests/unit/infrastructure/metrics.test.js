import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { metrics } from '../../../packages/bridge-core/src/infrastructure/metrics.js';
import { createRunReport, finalizeReport } from '../../../packages/bridge-core/src/schema/runReport.js';

// Reset metrics between tests so they don't interfere within this file's process.
beforeEach(() => metrics.reset());

function makeReport(overrides = {}) {
  const r = createRunReport({ provider: overrides.provider ?? 'cal' });
  Object.assign(r, overrides);
  finalizeReport(r, { status: overrides.status ?? 'success', error: overrides.error });
  return r;
}

describe('metrics.recordRun', () => {
  it('increments totalRuns', () => {
    metrics.recordRun(makeReport());
    metrics.recordRun(makeReport());
    assert.equal(metrics.snapshot().totalRuns, 2);
  });

  it('increments successfulRuns for status=success', () => {
    metrics.recordRun(makeReport({ status: 'success' }));
    const s = metrics.snapshot();
    assert.equal(s.successfulRuns, 1);
    assert.equal(s.partialRuns, 0);
    assert.equal(s.failedRuns, 0);
  });

  it('increments partialRuns for status=partial', () => {
    metrics.recordRun(makeReport({ status: 'partial' }));
    const s = metrics.snapshot();
    assert.equal(s.partialRuns, 1);
    assert.equal(s.successfulRuns, 0);
  });

  it('increments failedRuns for status=failed', () => {
    metrics.recordRun(makeReport({ status: 'failed', error: new Error('crash') }));
    const s = metrics.snapshot();
    assert.equal(s.failedRuns, 1);
  });

  it('accumulates totalRetries across runs', () => {
    metrics.recordRun(makeReport({ retryCount: 2 }));
    metrics.recordRun(makeReport({ retryCount: 1 }));
    assert.equal(metrics.snapshot().totalRetries, 3);
  });

  it('increments totalReAuths when reAuthOccurred is true', () => {
    metrics.recordRun(makeReport({ reAuthOccurred: true }));
    metrics.recordRun(makeReport({ reAuthOccurred: false }));
    assert.equal(metrics.snapshot().totalReAuths, 1);
  });

  it('accumulates totalTransactionsFetched and Skipped', () => {
    metrics.recordRun(makeReport({ transactionsFetched: 10, transactionsSkipped: 2 }));
    metrics.recordRun(makeReport({ transactionsFetched: 5, transactionsSkipped: 0 }));
    const s = metrics.snapshot();
    assert.equal(s.totalTransactionsFetched, 15);
    assert.equal(s.totalTransactionsSkipped, 2);
  });

  it('updates lastRunAt, lastRunDurationMs, lastRunStatus, lastRunProvider', () => {
    metrics.recordRun(makeReport({ provider: 'max', status: 'success' }));
    const s = metrics.snapshot();
    assert.ok(s.lastRunAt);
    assert.ok(s.lastRunDurationMs >= 0);
    assert.equal(s.lastRunStatus, 'success');
    assert.equal(s.lastRunProvider, 'max');
  });
});

describe('metrics.snapshot', () => {
  it('returns a copy — mutations do not affect internal state', () => {
    const snap = metrics.snapshot();
    snap.totalRuns = 9999;
    assert.equal(metrics.snapshot().totalRuns, 0);
  });

  it('includes uptimeSec', () => {
    const s = metrics.snapshot();
    assert.ok(typeof s.uptimeSec === 'number' && s.uptimeSec >= 0);
  });
});

describe('metrics.reset', () => {
  it('zeroes all counters', () => {
    metrics.recordRun(makeReport({ status: 'success', transactionsFetched: 5, retryCount: 1 }));
    metrics.reset();
    const s = metrics.snapshot();
    assert.equal(s.totalRuns, 0);
    assert.equal(s.successfulRuns, 0);
    assert.equal(s.totalRetries, 0);
    assert.equal(s.totalTransactionsFetched, 0);
    assert.equal(s.lastRunAt, null);
  });
});
