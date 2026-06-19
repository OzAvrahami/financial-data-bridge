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
 * Run the finance export when enabled. Pure orchestration: the injected
 * `runFinanceExport` (bridge-core) does the work and already redacts its own
 * errors. Returns a secret-free status object; never throws.
 *
 * Behavior:
 *   - disabled            → { enabled:false, attempted:false }  (CAL fetch unaffected)
 *   - enabled, no creds   → { attempted:false, ok:false, error } (clear, no network)
 *   - enabled, with creds → runs export; failure is reported, never thrown
 */
async function maybeRunFinance({ financeConfig, runFinanceExport, transactions, onEvent }) {
  const emit = (e) => { try { if (typeof onEvent === 'function') onEvent(e); } catch { /* ignore */ } };

  if (!financeConfig || !financeConfig.enabled) {
    return { enabled: false, attempted: false };
  }
  if (!financeConfig.apiUrl || !financeConfig.apiKey) {
    const error = !financeConfig.apiUrl
      ? 'Finance export is enabled but the API URL is not set. Configure it in Financial System Integration.'
      : 'Finance export is enabled but no API key is saved. Add it in Financial System Integration.';
    emit({ type: 'finance-error', error });
    return { enabled: true, attempted: false, ok: false, error };
  }

  emit({ type: 'finance-start', total: transactions.length });
  try {
    const r = await runFinanceExport({
      transactions,
      execute: true,
      financeConfig: { apiUrl: financeConfig.apiUrl, apiKey: financeConfig.apiKey },
    });
    emit({ type: 'finance-done', sent: r.sentCount, qualifying: r.qualifyingCount, skipped: r.skipped });
    return { enabled: true, attempted: true, ok: true, sent: r.sentCount, qualifying: r.qualifyingCount, skipped: r.skipped };
  } catch (err) {
    // bridge-core has already redacted secrets/URLs from this message.
    emit({ type: 'finance-error', error: err.message });
    return { enabled: true, attempted: true, ok: false, error: err.message };
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
  daysBack,
  settings,
  credentialStore,
  fetchAllAccounts,
  getDefaultAccount,
  getEnabledAccounts,
  validateDaysBack,
  onEvent,
  financeConfig,
  runFinanceExport,
}) {
  const dv = validateDaysBack(daysBack ?? settings?.daysBack);
  if (!dv.valid) return { ok: false, error: `Invalid days back: ${dv.error}` };

  const normalizedMode = mode === 'default' ? 'default' : 'all';

  const sel = selectAccounts({ settings, mode: normalizedMode, getDefaultAccount, getEnabledAccounts });
  if (sel.error) return { ok: false, error: sel.error };

  const accounts = attachCredentials({ accounts: sel.accounts, credentialStore });

  const result = await fetchAllAccounts({
    accounts,
    daysBack: dv.value,
    onEvent: typeof onEvent === 'function' ? onEvent : undefined,
  });

  // Finance export only runs when enabled; a failure here never aborts the run
  // (CAL transactions are already fetched and written to runtime/exports).
  const finance = await maybeRunFinance({
    financeConfig,
    runFinanceExport,
    transactions: result.transactions ?? [],
    onEvent,
  });

  return {
    ok: true,
    mode: normalizedMode,
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
  maybeRunFinance,
  runDesktopFetch,
};
