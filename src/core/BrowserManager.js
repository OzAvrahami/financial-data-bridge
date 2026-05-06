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
    this.browser = await chromium.launch({
      headless: options.headless ?? true,
      slowMo: options.slowMo ?? 0,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    const contextOptions = {
      locale: 'he-IL',
      viewport: { width: 1280, height: 720 },
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
