/**
 * Unit tests for the FinanceLedger — the authoritative per-transaction record of
 * what the finance system actually accepted (independent of local dedup state).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FinanceLedger } from '../../../packages/bridge-core/src/infrastructure/financeLedger.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'finance-ledger-test-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('FinanceLedger', () => {
  it('reports a never-seen key as not sent', () => {
    const l = new FinanceLedger(dir);
    assert.equal(l.lookup('nope'), null);
    assert.equal(l.wasSentSuccessfully('nope'), false);
  });

  it('records a successful send and persists it across load()', async () => {
    const l = new FinanceLedger(dir);
    l.recordSent('k1', { contentHash: 'h1', apiStatus: 201, financeTransactionId: 'fin_1' });
    assert.equal(l.wasSentSuccessfully('k1'), true);
    await l.save('cal', 'oz');
    assert.ok(existsSync(l.filePath('cal', 'oz')));

    const reloaded = await new FinanceLedger(dir).load('cal', 'oz');
    assert.equal(reloaded.wasSentSuccessfully('k1'), true);
    const e = reloaded.lookup('k1');
    assert.equal(e.contentHash, 'h1');
    assert.equal(e.financeTransactionId, 'fin_1');
    assert.equal(e.apiStatus, 201);
    assert.ok(e.sentAt);
  });

  it('a failed attempt is NOT counted as sent and stays eligible for retry', () => {
    const l = new FinanceLedger(dir);
    l.recordFailed('k2', { reason: 'api_error', apiStatus: 500 });
    assert.equal(l.wasSentSuccessfully('k2'), false);
    const e = l.lookup('k2');
    assert.equal(e.financeStatus, 'failed');
    assert.equal(e.reason, 'api_error');
    assert.equal(e.sentAt, null);
  });

  it('a failure after a prior success never downgrades the success', () => {
    const l = new FinanceLedger(dir);
    l.recordSent('k3', { contentHash: 'h', apiStatus: 201 });
    l.recordFailed('k3', { reason: 'api_error', apiStatus: 500 });
    assert.equal(l.wasSentSuccessfully('k3'), true, 'a real prior send must survive a later failure');
  });

  it('a missing/corrupt file loads as an empty ledger', async () => {
    const l = await new FinanceLedger(dir).load('cal', 'missing');
    assert.equal(l.size, 0);
  });
});
