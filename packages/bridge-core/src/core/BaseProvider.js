/**
 * Abstract base class for financial data providers.
 *
 * Provider lifecycle (called by the application layer in order):
 *   1. setPage(page)            — inject Playwright page
 *   2. isSessionValid(page)     — check whether a restored session is still alive
 *   3. login(credentials)       — authenticate from scratch
 *   4. fetchTransactions(opts)  — navigate and extract; returns { transactions, warnings }
 *   5. isAuthError(error)       — classify an error as auth-related for mid-run re-auth
 *   6. cleanup()                — optional provider-specific teardown before browser closes
 *
 * To add a new provider (e.g. MAX):
 *   1. Create src/providers/max/index.js that extends BaseProvider
 *   2. Implement login(), fetchTransactions(), and optionally isSessionValid() / isAuthError()
 *   3. Register it in src/providers/index.js — that is the only file to touch outside the folder
 */
export class BaseProvider {
  constructor(config) {
    this.config = config;
    this.page = null;
  }

  /** @param {import('playwright').Page} page */
  setPage(page) {
    this.page = page;
  }

  /** Human-readable provider name used in logs and output filenames. */
  get name() {
    throw new Error(`${this.constructor.name} must implement the 'name' getter`);
  }

  /**
   * Provider-level opt-in: when true, the application layer launches the browser
   * HEADED (visible, foregrounded) for this provider, overriding the configured
   * `headless` setting. Some sites only render their login UI reliably when a real,
   * visible browser window is active (CAL's login iframe is one such case).
   *
   * Default is false so every other provider keeps the configured behavior. A
   * provider opts in by overriding this getter to return true.
   * @returns {boolean}
   */
  get requiresVisibleBrowser() {
    return false;
  }

  /**
   * Check whether the current browser session is already authenticated.
   * Called once at startup after restoring saved session state.
   * Return false to trigger a fresh login.
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>}
   */
  async isSessionValid(page) {
    return false;
  }

  /**
   * Classify an error as an authentication failure (session expired, redirected to login).
   * Called when fetchTransactions() throws — returning true triggers automatic re-login.
   * Override in subclasses to inspect page URL, error message, etc.
   * @param {Error} error
   * @returns {Promise<boolean>}
   */
  async isAuthError(error) {
    return false;
  }

  /**
   * Authenticate with the provider.
   * @param {{ username: string, password: string }} credentials
   * @returns {Promise<void>}
   */
  async login(credentials) {
    throw new Error(`${this.constructor.name} must implement login(credentials)`);
  }

  /**
   * Fetch and return normalized transactions plus any recoverable warnings.
   * @param {{ daysBack?: number }} options
   * @returns {Promise<{ transactions: import('../schema/transaction.js').Transaction[], warnings: string[] }>}
   */
  async fetchTransactions(options) {
    throw new Error(`${this.constructor.name} must implement fetchTransactions(options)`);
  }

  /**
   * Optional provider-specific teardown. Called after fetchTransactions completes
   * (whether it succeeded or failed), before the browser closes.
   * Default is a no-op.
   * @returns {Promise<void>}
   */
  async cleanup() {}
}
