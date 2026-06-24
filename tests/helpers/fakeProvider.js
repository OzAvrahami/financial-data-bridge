/**
 * Configurable fake provider for integration tests.
 *
 * Does not extend BaseProvider to avoid any import-time side effects,
 * but satisfies the same interface the application layer calls.
 *
 * Usage:
 *   const provider = createFakeProvider({ sessionValid: true });
 *   const provider = createFakeProvider({ fetchResult: { transactions: [...], warnings: [] } });
 *   const provider = createFakeProvider({
 *     authError: true,
 *     fetch: (fetchCall, loginCount) => {
 *       if (fetchCall === 1) throw new Error('session expired');
 *       return { transactions: [], warnings: [] };
 *     },
 *   });
 *
 * fetchTransactions accepts { daysBack, startIndex, onProgress }. The fake calls
 * onProgress for each transaction (mirroring CalProvider) so checkpoint tests
 * work. onProgress is checkpoint-only and never stops the scan — every row in the
 * (sliced-from-startIndex) set is always processed.
 */
export function createFakeProvider(opts = {}) {
  let _loginCallCount = 0;
  let _fetchCallCount = 0;
  let _cleanupCalled  = false;
  let _lastDaysBack;

  return {
    name: opts.name ?? 'FAKE',
    page: null,

    // Opt-in flag mirrored from BaseProvider; lets tests exercise the headed-launch
    // override in the application layer without a real provider/browser.
    requiresVisibleBrowser: opts.requiresVisibleBrowser ?? false,

    setPage(page) { this.page = page; },

    async isSessionValid() {
      return opts.sessionValid ?? false;
    },

    async isAuthError() {
      return opts.authError ?? false;
    },

    async login() {
      _loginCallCount++;
      if (opts.loginError) throw opts.loginError;
    },

    async fetchTransactions({ daysBack, startIndex = 0, onProgress } = {}) {
      _fetchCallCount++;
      _lastDaysBack = daysBack;

      let result;
      if (typeof opts.fetch === 'function') {
        result = opts.fetch(_fetchCallCount, _loginCallCount);
      } else if (opts.fetchError) {
        throw opts.fetchError;
      } else {
        result = opts.fetchResult ?? { transactions: [], warnings: [] };
      }

      const allTransactions = result?.transactions ?? [];
      const warnings        = result?.warnings     ?? [];
      const toProcess       = allTransactions.slice(startIndex);
      const outputTransactions = [];

      for (let i = 0; i < toProcess.length; i++) {
        const tx = toProcess[i];
        outputTransactions.push(tx);

        // Checkpoint-only callback; its return value is ignored (no early-stop).
        if (onProgress) {
          await onProgress({
            index:       startIndex + i,
            total:       allTransactions.length,
            transaction: tx,
          });
        }
      }

      return { transactions: outputTransactions, warnings };
    },

    async cleanup() {
      _cleanupCalled = true;
    },

    // Call-count accessors for assertions
    get loginCallCount() { return _loginCallCount; },
    get fetchCallCount()  { return _fetchCallCount; },
    get cleanupCalled()   { return _cleanupCalled; },
    get lastDaysBack()    { return _lastDaysBack; },
  };
}
