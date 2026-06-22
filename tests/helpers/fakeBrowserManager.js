/**
 * Fake BrowserManager for integration tests.
 * Does not launch a real browser. Returns a plain object as the "page".
 */
export class FakeBrowserManager {
  constructor() {
    this.launched = false;
    this.closed = false;
    this.launchOptions = null;
    this.launchStorageState = null;
    this._storageState = { cookies: [], origins: [] };
    this.clearSessionCount = 0;
  }

  async launch(options, storageState) {
    this.launched = true;
    this.launchOptions = options;
    this.launchStorageState = storageState;
    return {}; // fake page object — providers in tests don't use it
  }

  async getStorageState() {
    return this._storageState;
  }

  async clearSession() {
    this.clearSessionCount++;
    this._storageState = { cookies: [], origins: [] };
  }

  async screenshot() {}

  async close() {
    this.closed = true;
  }
}
