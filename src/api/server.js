import express from 'express';
import { fetchTransactions } from '../application/fetchTransactions.js';
import { providerRegistry } from '../core/providerRegistry.js';
import { metrics } from '../infrastructure/metrics.js';
import { logger } from '../infrastructure/logger.js';
import { config } from '../config.js';

// Populates the registry (same side-effect import as CLI)
import '../providers/index.js';

// ── Optional API key authentication ──────────────────────────────────────────
// If API_KEY env is set, every request must include a matching X-API-Key header.
// If API_KEY is empty (default), the server is open — suitable for localhost use.
function apiKeyMiddleware(req, res, next) {
  const requiredKey = config.api.key;
  if (!requiredKey) return next();

  const provided = req.headers['x-api-key'];
  if (!provided || provided !== requiredKey) {
    return res.status(401).json(apiError('UNAUTHORIZED', 'Missing or invalid X-API-Key header'));
  }
  next();
}

// ── Consistent error response shape ──────────────────────────────────────────
function apiError(code, message, details) {
  const body = { error: { code, message } };
  if (details) body.error.details = details;
  return body;
}

export function createServer() {
  const app = express();
  app.use(express.json());
  app.use(apiKeyMiddleware);

  // ── GET /health ───────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      providers: providerRegistry.list(),
    });
  });

  // ── GET /metrics ──────────────────────────────────────────────────────────
  // Lightweight in-memory run statistics. Resets on process restart.
  app.get('/metrics', (_req, res) => {
    res.json(metrics.snapshot());
  });

  // ── POST /transactions/fetch ──────────────────────────────────────────────
  // Body (all optional):
  //   provider          string  — defaults to PROVIDER env
  //   accountId         string  — defaults to {PROVIDER}_ACCOUNT_ID env
  //   daysBack          number  — defaults to DAYS_BACK env
  //   skipExport        boolean — if true, transactions returned but not written to disk
  //   resume            boolean — resume from checkpoint if one exists
  //   fullFetch         boolean — ignore seen store; export all transactions
  //
  // Response: { provider, accountId, count, filePath, transactions, report }
  app.post('/transactions/fetch', async (req, res) => {
    const body        = req.body ?? {};
    const providerName = (body.provider ?? config.provider).toLowerCase();
    const daysBack    = typeof body.daysBack === 'number' ? body.daysBack : undefined;
    const skipExport  = body.skipExport  === true;
    const resume      = body.resume      === true;
    const fullFetch   = body.fullFetch   === true;

    // Validate provider
    if (!providerRegistry.has(providerName)) {
      return res.status(400).json(apiError(
        'UNKNOWN_PROVIDER',
        `Unknown provider: "${providerName}"`,
        { available: providerRegistry.list() }
      ));
    }

    const credentials = config.credentials[providerName];

    // Resolve accountId: request body > credentials config > 'default'
    const accountId = body.accountId ?? credentials?.accountId ?? 'default';

    // Validate credentials exist (avoid leaking which fields are missing)
    if (!credentials?.username || !credentials?.password) {
      return res.status(500).json(apiError(
        'MISSING_CREDENTIALS',
        `No credentials configured for provider "${providerName}". Check your .env file.`
      ));
    }

    logger.info('API: fetch request received', { provider: providerName, account: accountId, daysBack, resume, fullFetch });

    try {
      const result = await fetchTransactions({
        providerName,
        accountId,
        credentials,
        fetchConfig: daysBack !== undefined ? { daysBack } : undefined,
        skipExport,
        resume,
        fullFetch,
      });

      res.json({
        provider:     providerName,
        accountId:    result.report.accountId,
        count:        result.transactions.length,
        filePath:     result.filePath,
        transactions: result.transactions,
        report:       result.report,
      });
    } catch (err) {
      logger.error('API: fetch failed', { provider: providerName, account: accountId, error: err.message });
      res.status(500).json(apiError('FETCH_FAILED', err.message));
    }
  });

  return app;
}
