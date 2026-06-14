/**
 * Unit tests for the reusable runFinanceExport() application function.
 *
 * These exercise the function directly (in-process) — the complement to the
 * spawn-based CLI tests in tests/unit/scripts/exportToFinance.test.js. No real
 * HTTP calls are made: only dry-run and pre-send validation paths are tested,
 * all of which return/throw before any network access.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runFinanceExport,
  planFinanceExport,
  loadTransactionFile,
  FinanceExportInputError,
} from '../../../src/application/runFinanceExport.js';

const COMPLETED_TX = {
  provider: 'CAL', accountId: 'acct', transactionDate: '2026-05-10',
  chargeDate: '2026-06-10', merchantName: 'TOPSTEP', amount: 85, currency: 'USD',
  chargeAmount: 254.68, chargeCurrency: 'ILS', status: 'completed',
  dedupKey: 'abc123def456abc1', raw: {},
};
const PENDING_TX = { ...COMPLETED_TX, status: 'pending', chargeAmount: 0, dedupKey: 'def456abc123def4' };

let tmpDir, fileMixed, fileNotJson;

before(() => {
  tmpDir      = mkdtempSync(join(tmpdir(), 'run-finance-export-test-'));
  fileMixed   = join(tmpDir, 'mixed.json');
  fileNotJson = join(tmpDir, 'not-json.txt');
  writeFileSync(fileMixed, JSON.stringify([COMPLETED_TX, PENDING_TX]), 'utf-8');
  writeFileSync(fileNotJson, 'this is not json', 'utf-8');
});

after(() => rmSync(tmpDir, { recursive: true, force: true }));

describe('planFinanceExport', () => {
  it('splits qualifying from skipped without IO', () => {
    const plan = planFinanceExport([COMPLETED_TX, PENDING_TX]);
    assert.equal(plan.total, 2);
    assert.equal(plan.qualifyingCount, 1);
    assert.equal(plan.skipped, 1);
    assert.equal(plan.qualifying[0].merchantName, 'TOPSTEP');
  });
});

describe('loadTransactionFile', () => {
  it('throws FinanceExportInputError on unreadable file', () => {
    assert.throws(() => loadTransactionFile('/nope/missing.json'), FinanceExportInputError);
  });
  it('throws FinanceExportInputError on invalid JSON', () => {
    assert.throws(() => loadTransactionFile(fileNotJson), /cannot read/);
  });
});

describe('runFinanceExport — dry-run', () => {
  it('returns plan from a file without executing', async () => {
    const r = await runFinanceExport({ filePath: fileMixed });
    assert.equal(r.executed, false);
    assert.equal(r.total, 2);
    assert.equal(r.qualifyingCount, 1);
    assert.equal(r.skipped, 1);
    assert.equal(r.sentCount, 0);
  });

  it('accepts a pre-loaded transactions array', async () => {
    const r = await runFinanceExport({ transactions: [COMPLETED_TX] });
    assert.equal(r.executed, false);
    assert.equal(r.qualifyingCount, 1);
  });

  it('throws when neither filePath nor transactions is given', async () => {
    await assert.rejects(() => runFinanceExport({}), FinanceExportInputError);
  });
});

describe('runFinanceExport — execute credential guards', () => {
  const saved = {};
  before(() => { saved.url = process.env.FINANCE_API_URL; saved.key = process.env.FINANCE_API_KEY; });
  after(() => {
    if (saved.url === undefined) delete process.env.FINANCE_API_URL; else process.env.FINANCE_API_URL = saved.url;
    if (saved.key === undefined) delete process.env.FINANCE_API_KEY; else process.env.FINANCE_API_KEY = saved.key;
  });

  it('throws (before any network call) when FINANCE_API_URL is missing', async () => {
    delete process.env.FINANCE_API_URL;
    delete process.env.FINANCE_API_KEY;
    await assert.rejects(
      () => runFinanceExport({ transactions: [COMPLETED_TX], execute: true }),
      /FINANCE_API_URL/
    );
  });

  it('throws when key is missing even with URL set', async () => {
    process.env.FINANCE_API_URL = 'https://example.invalid/api';
    delete process.env.FINANCE_API_KEY;
    await assert.rejects(
      () => runFinanceExport({ transactions: [COMPLETED_TX], execute: true }),
      /FINANCE_API_KEY/
    );
  });
});
