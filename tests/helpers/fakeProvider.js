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
 */
export function createFakeProvider(opts = {}) {
  let _loginCallCount = 0;
  let _fetchCallCount = 0;
  let _cleanupCalled = false;

  return {
    name: opts.name ?? 'FAKE',
    page: null,

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

    async fetchTransactions(fetchOpts) {
      _fetchCallCount++;
      if (typeof opts.fetch === 'function') {
        return opts.fetch(_fetchCallCount, _loginCallCount);
      }
      if (opts.fetchError) throw opts.fetchError;
      return opts.fetchResult ?? { transactions: [], warnings: [] };
    },

    async cleanup() {
      _cleanupCalled = true;
    },

    // Call-count accessors for assertions
    get loginCallCount()  { return _loginCallCount; },
    get fetchCallCount()  { return _fetchCallCount; },
    get cleanupCalled()   { return _cleanupCalled; },
  };
}
