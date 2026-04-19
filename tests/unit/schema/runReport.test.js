import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRunReport, finalizeReport } from '../../../src/schema/runReport.js';

describe('createRunReport', () => {
  it('sets provider and accountId from arguments', () => {
    const r = createRunReport({ provider: 'cal', accountId: 'mycard' });
    assert.equal(r.provider, 'cal');
    assert.equal(r.accountId, 'mycard');
  });

  it('defaults accountId to "default" when omitted', () => {
    const r = createRunReport({ provider: 'cal' });
    assert.equal(r.accountId, 'default');
  });

  it('starts with status "running"', () => {
    const r = createRunReport({ provider: 'cal' });
    assert.equal(r.status, 'running');
  });

  it('starts with all counters at zero and flags false', () => {
    const r = createRunReport({ provider: 'cal' });
    assert.equal(r.transactionsFetched, 0);
    assert.equal(r.transactionsSkipped, 0);
    assert.equal(r.retryCount, 0);
    assert.equal(r.reAuthOccurred, false);
    assert.equal(r.sessionReused, false);
  });

  it('starts with null timestamps and empty collections', () => {
    const r = createRunReport({ provider: 'cal' });
    assert.equal(r.finishedAt, null);
    assert.equal(r.durationMs, null);
    assert.equal(r.fatalError, null);
    assert.equal(r.exportPath, null);
    assert.deepEqual(r.warnings, []);
  });

  it('records a valid ISO startedAt', () => {
    const before = Date.now();
    const r = createRunReport({ provider: 'cal' });
    const after = Date.now();
    const ts = new Date(r.startedAt).getTime();
    assert.ok(ts >= before && ts <= after, 'startedAt should be within the test window');
  });
});

describe('finalizeReport', () => {
  it('sets finishedAt, durationMs, and status on success', () => {
    const r = createRunReport({ provider: 'cal' });
    finalizeReport(r, { status: 'success' });
    assert.equal(r.status, 'success');
    assert.ok(r.finishedAt, 'finishedAt should be set');
    assert.ok(r.durationMs >= 0, 'durationMs should be non-negative');
    assert.equal(r.fatalError, null);
  });

  it('sets fatalError from an Error object', () => {
    const r = createRunReport({ provider: 'cal' });
    finalizeReport(r, { status: 'failed', error: new Error('connection refused') });
    assert.equal(r.status, 'failed');
    assert.equal(r.fatalError, 'connection refused');
  });

  it('handles string errors as fatalError fallback', () => {
    const r = createRunReport({ provider: 'cal' });
    finalizeReport(r, { status: 'failed', error: 'plain string error' });
    assert.equal(r.fatalError, 'plain string error');
  });

  it('sets "partial" status correctly', () => {
    const r = createRunReport({ provider: 'cal' });
    finalizeReport(r, { status: 'partial' });
    assert.equal(r.status, 'partial');
    assert.equal(r.fatalError, null);
  });

  it('returns the mutated report', () => {
    const r = createRunReport({ provider: 'cal' });
    const returned = finalizeReport(r, { status: 'success' });
    assert.equal(returned, r);
  });

  it('durationMs reflects elapsed time', async () => {
    const r = createRunReport({ provider: 'cal' });
    await new Promise(res => setTimeout(res, 10));
    finalizeReport(r, { status: 'success' });
    assert.ok(r.durationMs >= 10, `expected durationMs >= 10, got ${r.durationMs}`);
  });
});
