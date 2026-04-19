/**
 * Fake SeenStore for integration tests.
 * Holds fingerprints in memory — no filesystem access.
 */
export class FakeSeenStore {
  /**
   * @param {string[]} initialFingerprints - Fingerprints to treat as already-seen.
   */
  constructor(initialFingerprints = []) {
    this._fps  = new Set(initialFingerprints);
    this.saved = false;
  }

  filePath(provider, accountId = 'default') {
    const suffix = accountId && accountId !== 'default' ? `_${accountId}` : '';
    return `.seen/${provider}${suffix}.json`;
  }

  async load(provider, accountId = 'default') {
    return this; // already initialized
  }

  has(fp)      { return this._fps.has(fp); }
  add(fp)      { this._fps.add(fp); }
  addMany(fps) { for (const fp of fps) this._fps.add(fp); }
  get size()   { return this._fps.size; }

  async save(provider, accountId = 'default') {
    this.saved = true;
  }
}
