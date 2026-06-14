/**
 * Application API surface.
 *
 * This is the stable set of reusable use-case functions that entry points call:
 *   - the CLI scripts (index.js, scripts/exportToFinance.js)
 *   - the HTTP API (src/api/server.js)
 *   - tests
 *   - a future local desktop (Electron) UI
 *
 * Entry points stay thin: they parse input and render output. All business logic
 * lives behind these functions.
 */

// Fetch use case — authenticate, fetch, dedup, optionally export. Provider-agnostic
// (currently CAL); already the single fetch entry point used by CLI + API + tests.
export { fetchTransactions } from './fetchTransactions.js';

// Multi-account fetch — run each configured source account sequentially and
// combine the results into one report.
export { fetchAllAccounts } from './fetchAllAccounts.js';

// Source-account configuration (generic, multi-provider).
export { loadSourceAccounts, isMultiAccountConfigured } from '../config/sourceAccounts.js';

// Finance export use case — load, plan (dry-run), and optionally send transactions.
export {
  runFinanceExport,
  planFinanceExport,
  loadTransactionFile,
  FinanceExportInputError,
} from './runFinanceExport.js';

// Lower-level finance helpers (kept exported for direct use / testing).
export {
  exportToFinanceSystem,
  shouldSendTransaction,
} from './exportToFinanceSystem.js';
