/**
 * Unit tests for the finance sync audit report writer (JSON + CSV).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { toCsv, writeFinanceSyncReport, REPORT_COLUMNS } from '../../../packages/bridge-core/src/infrastructure/financeReport.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'finance-report-test-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ROW = {
  runId: 'rid', timestamp: '2026-06-22T00:00:00Z', provider: 'CAL', accountId: 'oz',
  accountLabel: 'Oz CAL', transactionDate: '2026-06-01', merchant: 'Cafe, "The Best"',
  amount: 10, chargeAmount: 12.5, currency: 'ILS', status: 'completed',
  localDedupStatus: 'unchanged', financeStatus: 'sent', reason: 'sent', apiStatus: 201,
  financeTransactionId: 'fin_1', dedupKey: 'abc123',
};

describe('toCsv', () => {
  it('emits the header row in column order', () => {
    const csv = toCsv([]);
    assert.equal(csv.trim(), REPORT_COLUMNS.join(','));
  });

  it('quotes fields containing commas and quotes', () => {
    const csv = toCsv([ROW]);
    const lines = csv.trim().split('\n');
    assert.equal(lines.length, 2);
    // The merchant field must be quoted with embedded quotes doubled.
    assert.match(lines[1], /"Cafe, ""The Best"""/);
  });
});

describe('writeFinanceSyncReport', () => {
  it('writes both JSON and CSV with matching content', async () => {
    const counts = { considered: 1, sent: 1, alreadySent: 0, skipped: 0, failed: 0 };
    const { jsonPath, csvPath } = await writeFinanceSyncReport({
      dir, runId: 'rid', summary: counts, rows: [ROW],
    });
    assert.ok(existsSync(jsonPath));
    assert.ok(existsSync(csvPath));
    assert.equal(jsonPath, join(dir, 'finance-sync-rid.json'));

    const json = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    assert.equal(json.runId, 'rid');
    assert.deepEqual(json.summary, counts);
    assert.equal(json.transactions.length, 1);
    assert.equal(json.transactions[0].financeStatus, 'sent');

    const csv = readFileSync(csvPath, 'utf-8');
    assert.match(csv.split('\n')[0], /^runId,timestamp,provider/);
  });
});
