import { chromium } from '@playwright/test';

export class BrowserManager {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /**
   * @param {object} options - headless, slowMo
   * @param {object|null} storageState - Playwright storage state to restore (cookies + localStorage)
   */
  async launch(options = {}, storageState = null) {
    const headless = options.headless ?? true;

    // When running headed (e.g. CAL, which needs a visible login window) open a
    // normal maximized window so the page has real, foreground dimensions.
    const args = ['--no-sandbox', '--disable-dev-shm-usage'];
    if (!headless) args.push('--start-maximized');

    this.browser = await chromium.launch({
      headless,
      slowMo: options.slowMo ?? 0,
      args,
    });

    const contextOptions = {
      locale: 'he-IL',
      // Headed: let the page fill the real (maximized) window. Headless: keep the
      // deterministic fixed viewport.
      viewport: headless ? { width: 1280, height: 720 } : null,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };

    if (storageState) {
      contextOptions.storageState = storageState;
    }

    this.context = await this.browser.newContext(contextOptions);

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    this.page = await this.context.newPage();
    return this.page;
  }

  /** Capture current session state for persistence. */
  async getStorageState() {
    if (!this.context) return null;
    return this.context.storageState();
  }

  /**
   * Clear authentication state (cookies + best-effort web storage) so the context
   * is logged out. Used when a restored session is expired: a fresh login must
   * start from a clean state, otherwise stale cookies keep the site in a broken
   * half-authenticated view and the logged-out login entry never renders.
   */
  async clearSession() {
    if (!this.context) return;
    await this.context.clearCookies().catch(() => {});
    // localStorage/sessionStorage are per-origin; clear them for the current page
    // if it is on a real origin (no-op/throws harmlessly on about:blank).
    if (this.page) {
      await this.page.evaluate(() => {
        try { localStorage.clear(); sessionStorage.clear(); } catch { /* not on a real origin */ }
      }).catch(() => {});
    }
  }

  async screenshot(filePath) {
    if (this.page) {
      await this.page.screenshot({ path: filePath, fullPage: true });
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}
