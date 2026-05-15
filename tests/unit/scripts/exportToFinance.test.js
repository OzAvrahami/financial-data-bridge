/**
 * Unit tests for scripts/exportToFinance.js CLI.
 *
 * Uses spawnSync to invoke the script as a child process so that argument
 * parsing, guard logic, and exit codes can be tested without mocking Node
 * internals. No real HTTP calls are ever made — FINANCE_API_URL and
 * FINANCE_API_KEY are stripped from the environment for every test.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync, writeSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const SCRIPT       = join(__dirname, '..', '..', '..', 'scripts', 'exportToFinance.js');
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const COMPLETED_TX = {
  provider:        'CAL',
  accountId:       'ויזה5304',
  transactionDate: '2026-05-10',
  chargeDate:      '2026-06-10',
  merchantName:    'TOPSTEP',
  amount:          85,
  currency:        'USD',
  chargeAmount:    254.68,
  chargeCurrency:  'ILS',
  transactionType: 'הוראת קבע',
  status:          'completed',
  dedupKey:        'abc123def456abc1',
  raw:             {},
};

const PENDING_TX = {
  ...COMPLETED_TX,
  status:       'pending',
  chargeDate:   '',
  chargeAmount: 0,
  dedupKey:     'def456abc123def4',
};

// ── Temp file setup ──────────────────────────────────────────────────────────

let tmpDir;
let fileAllCompleted;    // [COMPLETED_TX, COMPLETED_TX]
let fileEmpty;           // []
let fileMixed;           // [COMPLETED_TX, PENDING_TX]
let fileNotJson;         // not valid JSON

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'export-finance-test-'));

  fileAllCompleted = join(tmpDir, 'all-completed.json');
  fileEmpty        = join(tmpDir, 'empty.json');
  fileMixed        = join(tmpDir, 'mixed.json');
  fileNotJson      = join(tmpDir, 'not-json.txt');

  writeFileSync(fileAllCompleted, JSON.stringify([COMPLETED_TX, COMPLETED_TX]), 'utf-8');
  writeFileSync(fileEmpty,        JSON.stringify([]),                           'utf-8');
  writeFileSync(fileMixed,        JSON.stringify([COMPLETED_TX, PENDING_TX]),  'utf-8');
  writeFileSync(fileNotJson,      'this is not json',                          'utf-8');
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helper ───────────────────────────────────────────────────────────────────

/**
 * Run the script in a child process.
 *
 * Safety guarantee: FINANCE_API_URL and FINANCE_API_KEY are always set to ''
 * (empty string) in the child's environment. dotenv.config() — which the script
 * calls at startup — respects already-set env vars and will NOT override an
 * existing empty string with the real value from .env. This prevents any test
 * from accidentally hitting the real finance API.
 *
 * To test credential-validation logic, pass the desired value back via extraEnv:
 *   run([...], { FINANCE_API_URL: 'https://example.invalid' })
 */
function run(args = [], extraEnv = {}) {
  const safeEnv = Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => k !== 'FINANCE_API_URL' && k !== 'FINANCE_API_KEY')
  );
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    cwd:      PROJECT_ROOT,
    env:      {
      ...safeEnv,
      FINANCE_API_URL: '', // blocks dotenv from loading the real value
      FINANCE_API_KEY: '', // blocks dotenv from loading the real value
      ...extraEnv,         // caller can selectively restore specific vars
    },
  });
}

// ── Tests: argument validation ────────────────────────────────────────────────

describe('exportToFinance CLI — argument validation', () => {
  it('exits 1 and prints usage when --file is absent', () => {
    const r = run([]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--file/);
    assert.match(r.stderr, /Usage/i);
  });

  it('exits 1 when --file has no following value', () => {
    const r = run(['--file']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--file/);
  });

  it('exits 1 when --file value is another flag (--file --execute)', () => {
    const r = run(['--file', '--execute']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--file/);
  });

  it('exits 1 when the file does not exist', () => {
    const r = run(['--file', '/nonexistent/path/transactions.json']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot read/i);
  });

  it('exits 1 when the file contains invalid JSON', () => {
    const r = run(['--file', fileNotJson]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot read/i);
  });
});

// ── Tests: dry-run (default behavior) ────────────────────────────────────────

describe('exportToFinance CLI — dry-run (no --execute)', () => {
  it('exits 0 without --execute', () => {
    const r = run(['--file', fileAllCompleted]);
    assert.equal(r.status, 0, `unexpected stderr: ${r.stderr}`);
  });

  it('prints "DRY RUN" header', () => {
    const r = run(['--file', fileAllCompleted]);
    assert.match(r.stdout, /DRY RUN/);
  });

  it('shows correct "Would be sent" count', () => {
    const r = run(['--file', fileAllCompleted]);
    // 2 completed transactions → 2 sent
    assert.match(r.stdout, /Would be sent:\s+2/);
  });

  it('shows correct counts for a mixed file', () => {
    const r = run(['--file', fileMixed]);
    assert.match(r.stdout, /Would be sent:\s+1/);
    assert.match(r.stdout, /Would be skipped:\s+1/);
  });

  it('lists each qualifying transaction with merchant name and dedupKey', () => {
    const r = run(['--file', fileAllCompleted]);
    assert.match(r.stdout, /TOPSTEP/);
    assert.match(r.stdout, /abc123def456abc1/);
  });

  it('handles an empty file gracefully (0 qualifying)', () => {
    const r = run(['--file', fileEmpty]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Would be sent:\s+0/);
  });

  it('does not require FINANCE_API_URL or FINANCE_API_KEY — no credentials needed for dry-run', () => {
    // run() already strips these; this test makes the safety guarantee explicit
    const r = run(['--file', fileAllCompleted]);
    assert.equal(r.status, 0, 'dry-run must succeed with no API credentials in environment');
    assert.doesNotMatch(r.stderr, /FINANCE_API/);
  });

  it('prints a reminder showing how to add --execute', () => {
    const r = run(['--file', fileAllCompleted]);
    assert.match(r.stdout, /--execute/);
  });
});

// ── Tests: --execute credential validation ────────────────────────────────────

describe('exportToFinance CLI — --execute credential guards', () => {
  it('exits 1 with --execute when FINANCE_API_URL is not set', () => {
    const r = run(['--file', fileAllCompleted, '--execute']);
    // run() strips FINANCE_API_URL by default
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FINANCE_API_URL/);
  });

  it('exits 1 with --execute when FINANCE_API_URL is set but FINANCE_API_KEY is missing', () => {
    const r = run(['--file', fileAllCompleted, '--execute'], {
      FINANCE_API_URL: 'https://example.invalid/api',
      // FINANCE_API_KEY intentionally omitted — stripped by run()
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FINANCE_API_KEY/);
  });

  it('URL validation fires before any HTTP attempt — no network traffic on missing key', () => {
    // With a clearly unreachable URL, any accidental fetch() would time-out or error.
    // But since the key is missing, the script must exit before reaching fetch().
    // We assert exit 1 and no fetch-related error in stderr.
    const r = run(['--file', fileAllCompleted, '--execute'], {
      FINANCE_API_URL: 'https://definitely.invalid.host.example/api',
      // no FINANCE_API_KEY
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FINANCE_API_KEY/);
    assert.doesNotMatch(r.stderr, /fetch|ENOTFOUND|network/i);
  });
});
