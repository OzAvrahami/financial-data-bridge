/**
 * Unit tests for the reusable runFinanceExport() application function.
 *
 * These exercise the function directly (in-process). No real HTTP calls are made:
 * only dry-run and pre-send validation paths are tested, all of which return/throw
 * before any network access.
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
  testFinanceConnection,
  FinanceExportInputError,
} from '../../../packages/bridge-core/src/application/runFinanceExport.js';
import { exportToFinanceSystem } from '../../../packages/bridge-core/src/application/exportToFinanceSystem.js';

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

  it('throws (before any network call) when the finance URL is missing', async () => {
    delete process.env.FINANCE_API_URL;
    delete process.env.FINANCE_API_KEY;
    await assert.rejects(
      () => runFinanceExport({ transactions: [COMPLETED_TX], execute: true }),
      /Finance API URL is not configured/
    );
  });

  it('throws when key is missing even with URL set', async () => {
    process.env.FINANCE_API_URL = 'https://example.invalid/api';
    delete process.env.FINANCE_API_KEY;
    await assert.rejects(
      () => runFinanceExport({ transactions: [COMPLETED_TX], execute: true }),
      /Finance API key is not saved/
    );
  });

  it('error messages never reference .env', async () => {
    delete process.env.FINANCE_API_URL;
    delete process.env.FINANCE_API_KEY;
    await assert.rejects(
      () => runFinanceExport({ transactions: [COMPLETED_TX], execute: true }),
      (err) => { assert.ok(!/\.env/i.test(err.message), 'must not mention .env'); return true; }
    );
  });

  it('uses the in-memory financeConfig instead of env (validation passes; sending uses injected config)', async () => {
    delete process.env.FINANCE_API_URL;
    delete process.env.FINANCE_API_KEY;
    // With financeConfig provided, the missing-credential guards must NOT trigger.
    // We stop before the network by passing an empty transaction list (nothing qualifies).
    const r = await runFinanceExport({
      transactions: [],
      execute: true,
      financeConfig: { apiUrl: 'https://fin.example/api', apiKey: 'tok' },
    });
    assert.equal(r.executed, true);
    assert.equal(r.sentCount, 0);
    assert.equal(r.apiUrl, 'https://fin.example/api'); // returned URL is the safe (query-stripped) form
  });
});

describe('testFinanceConnection', () => {
  const CFG = { apiUrl: 'https://fin.example/api', apiKey: 'sk_test_TOKEN' };

  it('reports OK for any HTTP response (e.g. 405 on a POST-only endpoint)', async () => {
    const r = await testFinanceConnection(CFG, { fetch: async () => ({ status: 405 }) });
    assert.equal(r.ok, true);
    assert.match(r.message, /HTTP 405/);
  });

  it('reports auth failure for 401/403', async () => {
    const r = await testFinanceConnection(CFG, { fetch: async () => ({ status: 401 }) });
    assert.equal(r.ok, false);
    assert.match(r.message, /Authentication failed/);
  });

  it('reports a redacted connection failure when fetch throws', async () => {
    const r = await testFinanceConnection(CFG, {
      fetch: async () => { throw new Error('ECONNREFUSED to sk_test_TOKEN'); },
    });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.message, /sk_test_TOKEN/, 'secret must be redacted');
    assert.match(r.message, /\[REDACTED\]/);
  });

  it('throws a clear error when URL or key is missing', async () => {
    await assert.rejects(() => testFinanceConnection({ apiKey: 'x' }), /Finance API URL is not set/);
    await assert.rejects(() => testFinanceConnection({ apiUrl: 'https://x' }), /Finance API key is not saved/);
  });
});

describe('exportToFinanceSystem — secret redaction on failure', () => {
  it('redacts the API key from a non-OK HTTP error', async () => {
    const apiKey = 'sk_live_DEADBEEF';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => `server error referencing ${apiKey} and more`,
    });
    try {
      await assert.rejects(
        () => exportToFinanceSystem([COMPLETED_TX], { apiUrl: 'https://fin.example/api', apiKey }),
        (err) => {
          assert.doesNotMatch(err.message, /sk_live_DEADBEEF/, 'API key must be redacted');
          assert.match(err.message, /HTTP 500/);
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
