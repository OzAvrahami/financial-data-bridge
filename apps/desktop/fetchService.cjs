/**
 * Desktop fetch orchestration (Electron MAIN process).
 *
 * Pure, dependency-injected glue between the desktop settings + credential store
 * and the bridge-core fetch use case. Deliberately free of Electron and
 * bridge-core imports so it:
 *   - is unit-testable under plain Node (no Electron, no Playwright), and
 *   - reimplements NONE of the fetch/dedup/export business logic — all of that
 *     stays in bridge-core (fetchAllAccounts → fetchTransactions).
 *
 * SECURITY: decrypted credentials live only inside the in-memory account objects
 * handed to bridge-core. They are never returned to the renderer, written to
 * disk, or included in the progress events / summaries produced here.
 */

class ConcurrentFetchError extends Error {
  constructor(message = 'A fetch is already running. Wait for it to finish.') {
    super(message);
    this.name = 'ConcurrentFetchError';
  }
}

/**
 * Single-flight lock: only one fetch may run at a time (the authoritative
 * main-process concurrency guard). `run` rejects with ConcurrentFetchError if a
 * task is already in flight, and always releases the lock when the task settles.
 */
function createFetchLock() {
  let running = false;
  return {
    isRunning: () => running,
    async run(fn) {
      if (running) throw new ConcurrentFetchError();
      running = true;
      try { return await fn(); }
      finally { running = false; }
    },
  };
}

/**
 * Choose the target accounts for a run (pure).
 * @returns {{ accounts: object[] } | { error: string }}
 */
function selectAccounts({ settings, mode, getDefaultAccount, getEnabledAccounts }) {
  const accounts = settings?.accounts ?? [];
  if (mode === 'default') {
    const def = getDefaultAccount(accounts);
    if (!def) return { error: 'No accounts configured. Add one in Account Settings.' };
    return { accounts: [def] };
  }
  const enabled = getEnabledAccounts(accounts);
  if (enabled.length === 0) {
    return { error: 'No enabled accounts to fetch. Enable at least one account.' };
  }
  return { accounts: enabled };
}

/**
 * Attach decrypted credentials (from the OS-secure store) to each target account,
 * in memory only. A missing/undecryptable credential yields empty strings so that
 * bridge-core surfaces a clear, account-specific "Missing credentials" error — and,
 * for a Fetch All run, continues with the remaining accounts.
 */
function attachCredentials({ accounts, credentialStore }) {
  return accounts.map((a) => {
    let creds = null;
    try { creds = a.credentialKey ? credentialStore.getCredentials(a.credentialKey) : null; }
    catch { creds = null; }
    return {
      provider:          a.provider,
      providerAccountId: a.providerAccountId,
      displayName:       a.displayName,
      // Per-account override preserved; null means "use the global days-back".
      daysBack:          Number.isInteger(a.daysBack) ? a.daysBack : null,
      credentials: {
        username: creds?.username ?? '',
        password: creds?.password ?? '',
      },
    };
  });
}

/** Reduce a bridge-core per-account result to secret-free fields for the renderer. */
function sanitizeAccountResult(r = {}) {
  const rep = r.report || {};
  return {
    provider:          r.provider,
    providerAccountId: r.providerAccountId,
    displayName:       r.displayName,
    status:            r.status,
    error:             r.error ?? null,
    sessionReused:       rep.sessionReused === true,
    transactionsFetched: rep.transactionsFetched ?? 0,
    pendingSkipped:      rep.pendingSkippedCount ?? 0,
    skipped:             rep.transactionsSkipped ?? 0,
    created:             rep.createdCount ?? 0,
    updated:             rep.updatedCount ?? 0,
    unchanged:           rep.unchangedCount ?? 0,
    duplicates:          rep.duplicatesSkipped ?? 0,
    exported:            r.transactionsExported ?? rep.newTransactionsExported ?? 0,
    exportPath:          rep.exportPath ?? null,
  };
}

/**
 * Run the finance SYNC step. Pure orchestration over the injected bridge-core
 * `syncTransactionsToFinance` engine, which owns all the real logic: per-transaction
 * ledger-aware status, retries, and the audit report. Returns a secret-free status
 * object; never throws.
 *
 * This is decoupled from local dedup: it evaluates EVERY considered transaction
 * (not just the locally new/updated ones) so an unchanged-locally transaction that
 * was never accepted by finance is still eligible, and a prior finance failure is
 * retried. The engine, not this layer, decides per-transaction outcomes.
 *
 * Run mode:
 *   - 'fetch-only' → finance is never touched. Every transaction's finance status
 *     is not_attempted / run_mode_fetch_only. No ledger writes, no API calls.
 *   - 'sync'       → run the engine. It still self-gates on enabled / URL / key /
 *     fetchSucceeded, recording the matching not_attempted reason and writing a
 *     report. A thrown error is reported, never propagated.
 */
async function runFinanceSync({
  financeMode,
  financeConfig,
  syncTransactionsToFinance,
  consideredTransactions,
  fetchSucceeded,
  onEvent,
  ledgerDir,
  reportsDir,
}) {
  const emit = (e) => { try { if (typeof onEvent === 'function') onEvent(e); } catch { /* ignore */ } };

  // Fetch Only: finance is intentionally not executed.
  if (financeMode !== 'sync') {
    emit({ type: 'finance-not-attempted', reason: 'run_mode_fetch_only', considered: consideredTransactions.length });
    return {
      mode: 'fetch-only',
      attempted: false,
      notAttempted: true,
      reason: 'run_mode_fetch_only',
      considered: consideredTransactions.length,
    };
  }

  if (typeof syncTransactionsToFinance !== 'function') {
    const error = 'Finance sync engine is unavailable.';
    emit({ type: 'finance-error', error });
    return { mode: 'sync', attempted: false, ok: false, error };
  }

  try {
    const r = await syncTransactionsToFinance({
      consideredTransactions,
      financeConfig: { enabled: financeConfig.enabled, apiUrl: financeConfig.apiUrl, apiKey: financeConfig.apiKey },
      fetchSucceeded,
      onEvent,
      ...(ledgerDir ? { ledgerDir } : {}),
      ...(reportsDir ? { reportsDir } : {}),
    });
    return {
      mode:          'sync',
      attempted:     r.executed,
      notAttempted:  !r.executed,
      reason:        r.notAttemptedReason,
      // A run is "ok" when it actually executed and nothing failed mid-send.
      ok:            r.executed && r.counts.failed === 0,
      counts:        r.counts,
      reportPath:    r.reportPaths?.jsonPath ?? null,
      reportCsvPath: r.reportPaths?.csvPath ?? null,
    };
  } catch (err) {
    // bridge-core redacts secrets/URLs from its own messages.
    emit({ type: 'finance-error', error: err.message });
    return { mode: 'sync', attempted: true, ok: false, error: err.message };
  }
}

/**
 * Run the real bridge-core multi-account fetch for the desktop.
 *
 * All heavy lifting (login, Playwright, dedup, export, failure isolation) happens
 * inside the injected `fetchAllAccounts`. This function only selects accounts,
 * injects credentials, forwards the global days-back + progress callback, runs the
 * finance export when enabled, and returns a sanitized, secret-free result.
 *
 * @returns {Promise<{ ok:true, mode, daysBack, summary, accounts, finance }
 *                   | { ok:false, error:string }>}
 */
async function runDesktopFetch({
  mode,
  financeMode,
  daysBack,
  settings,
  credentialStore,
  fetchAllAccounts,
  getDefaultAccount,
  getEnabledAccounts,
  validateDaysBack,
  onEvent,
  financeConfig,
  syncTransactionsToFinance,
  ledgerDir,
  reportsDir,
}) {
  const dv = validateDaysBack(daysBack ?? settings?.daysBack);
  if (!dv.valid) return { ok: false, error: `Invalid days back: ${dv.error}` };

  const normalizedMode = mode === 'default' ? 'default' : 'all';
  // 'sync' performs the finance sync after fetching; anything else is Fetch Only.
  const normalizedFinanceMode = financeMode === 'sync' ? 'sync' : 'fetch-only';

  const sel = selectAccounts({ settings, mode: normalizedMode, getDefaultAccount, getEnabledAccounts });
  if (sel.error) return { ok: false, error: sel.error };

  const accounts = attachCredentials({ accounts: sel.accounts, credentialStore });

  const result = await fetchAllAccounts({
    accounts,
    daysBack: dv.value,
    onEvent: typeof onEvent === 'function' ? onEvent : undefined,
  });

  // Finance sync is a separate, ledger-aware step. It never aborts the run (CAL
  // transactions are already fetched and written to runtime/exports). It receives
  // the FULL considered set from successful accounts — NOT just the locally
  // new/updated ones — so finance status is decided on its own merits.
  const fetchSucceeded = (result.summary?.succeeded ?? 0) > 0;
  const finance = await runFinanceSync({
    financeMode: normalizedFinanceMode,
    financeConfig: financeConfig ?? { enabled: false },
    syncTransactionsToFinance,
    consideredTransactions: result.consideredTransactions ?? [],
    fetchSucceeded,
    onEvent,
    ledgerDir,
    reportsDir,
  });

  return {
    ok: true,
    mode: normalizedMode,
    financeMode: normalizedFinanceMode,
    daysBack: dv.value,
    summary: result.summary,
    accounts: (result.accounts ?? []).map(sanitizeAccountResult),
    finance,
  };
}

module.exports = {
  ConcurrentFetchError,
  createFetchLock,
  selectAccounts,
  attachCredentials,
  sanitizeAccountResult,
  runFinanceSync,
  runDesktopFetch,
};
