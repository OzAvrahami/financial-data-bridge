/**
 * Integration tests for the HTTP API layer.
 *
 * Tests focus on:
 *   - Routing and endpoint presence
 *   - Request validation and error response shape
 *   - API key authentication middleware
 *
 * The POST /transactions/fetch happy path is not tested here because it
 * requires a real browser. That flow is covered by fetchTransactions.test.js
 * using injected fakes. The API layer just calls the same function.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/api/server.js';
import { metrics } from '../../src/infrastructure/metrics.js';

// ── Test server lifecycle ─────────────────────────────────────────────────────

let server;
let baseUrl;

before(async () => {
  // Clear any env-based API key from other tests
  delete process.env.API_KEY;

  const app = createServer();
  await new Promise(resolve => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;
});

after(() => {
  server?.close();
});

async function get(path, headers = {}) {
  return fetch(`${baseUrl}${path}`, { headers });
}

async function post(path, body, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ── GET /health ───────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });

  it('includes a timestamp', async () => {
    const res = await get('/health');
    const body = await res.json();
    assert.ok(body.timestamp, 'should include timestamp');
    assert.ok(!isNaN(new Date(body.timestamp).getTime()), 'timestamp should be valid ISO');
  });

  it('includes the providers array', async () => {
    const res = await get('/health');
    const body = await res.json();
    assert.ok(Array.isArray(body.providers), 'providers should be an array');
    assert.ok(body.providers.includes('cal'), 'cal should be registered');
  });
});

// ── GET /metrics ──────────────────────────────────────────────────────────────

describe('GET /metrics', () => {
  it('returns 200', async () => {
    const res = await get('/metrics');
    assert.equal(res.status, 200);
  });

  it('includes expected metric fields', async () => {
    const res = await get('/metrics');
    const body = await res.json();
    assert.ok(typeof body.totalRuns === 'number');
    assert.ok(typeof body.successfulRuns === 'number');
    assert.ok(typeof body.failedRuns === 'number');
    assert.ok(typeof body.uptimeSec === 'number');
  });

  it('reflects recorded runs', async () => {
    metrics.reset();

    // Simulate a recorded run
    const { createRunReport, finalizeReport } = await import('../../src/schema/runReport.js');
    const r = createRunReport({ provider: 'cal' });
    r.transactionsFetched = 7;
    finalizeReport(r, { status: 'success' });
    metrics.recordRun(r);

    const res = await get('/metrics');
    const body = await res.json();
    assert.equal(body.totalRuns, 1);
    assert.equal(body.successfulRuns, 1);
    assert.equal(body.totalTransactionsFetched, 7);
  });
});

// ── POST /transactions/fetch — validation ─────────────────────────────────────

describe('POST /transactions/fetch — validation', () => {
  it('returns 400 with structured error for unknown provider', async () => {
    const res = await post('/transactions/fetch', { provider: 'does_not_exist' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'UNKNOWN_PROVIDER');
    assert.ok(body.error.message.includes('does_not_exist'));
    assert.ok(Array.isArray(body.error.details?.available));
  });

  it('returns 400 with UNKNOWN_PROVIDER for a clearly invalid provider name', async () => {
    const res = await post('/transactions/fetch', { provider: 'nonexistent_provider_xyz' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'UNKNOWN_PROVIDER');
  });

  it('returns structured error — not a bare string', async () => {
    const res = await post('/transactions/fetch', { provider: 'unknown_xyz' });
    const body = await res.json();
    // Error must be an object with code and message, not a raw string
    assert.equal(typeof body.error, 'object');
    assert.ok(typeof body.error.code === 'string');
    assert.ok(typeof body.error.message === 'string');
  });
});

// ── API key authentication ────────────────────────────────────────────────────

describe('API key authentication', () => {
  let secureServer;
  let secureBase;

  before(async () => {
    // Start a fresh server with API_KEY set
    process.env.API_KEY = 'my-secret-key-123';
    // We must create the server AFTER setting the env var.
    // But the config module is already cached with the old value.
    // We test the middleware directly instead by using createServer's apiKeyMiddleware.
    // The middleware reads config.api.key at request time, not at import time.
    // config is loaded once at module import. So we need a different approach:
    // Re-import with a fresh config is not easily possible without cache busting.
    //
    // Instead, test the middleware behavior via a manual express app:
    const express = (await import('express')).default;
    const { config } = await import('../../src/config.js');

    // Temporarily override config.api.key for this test suite
    const originalKey = config.api.key;
    config.api.key = 'my-secret-key-123';

    const app = createServer();
    await new Promise(resolve => {
      secureServer = app.listen(0, resolve);
    });
    secureBase = `http://localhost:${secureServer.address().port}`;

    // Store original for cleanup
    secureServer._originalKey = originalKey;
    secureServer._config = config;
  });

  after(() => {
    if (secureServer) {
      secureServer._config.api.key = secureServer._originalKey;
      secureServer.close();
    }
    delete process.env.API_KEY;
  });

  it('returns 401 when no X-API-Key header provided', async () => {
    const res = await fetch(`${secureBase}/health`);
    assert.equal(res.status, 401);
  });

  it('returns 401 when wrong X-API-Key provided', async () => {
    const res = await fetch(`${secureBase}/health`, {
      headers: { 'x-api-key': 'wrong-key' },
    });
    assert.equal(res.status, 401);
  });

  it('returns 200 when correct X-API-Key provided', async () => {
    const res = await fetch(`${secureBase}/health`, {
      headers: { 'x-api-key': 'my-secret-key-123' },
    });
    assert.equal(res.status, 200);
  });

  it('401 response has structured error body', async () => {
    const res = await fetch(`${secureBase}/health`);
    const body = await res.json();
    assert.equal(body.error.code, 'UNAUTHORIZED');
    assert.ok(body.error.message);
  });
});
