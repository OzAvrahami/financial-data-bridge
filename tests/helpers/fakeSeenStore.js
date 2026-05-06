/**
 * Fake SeenStore for integration tests.
 * Holds entries in memory — no filesystem access.
 *
 * Constructor accepts:
 *   string[]  — legacy form: fingerprints with no known contentHash (contentHash=null).
 *               Classified as 'unchanged' by classifyTransaction (migration path).
 *   object    — { [fp]: contentHash } for seeding specific hashes in update-aware tests.
 */
export class FakeSeenStore {
  constructor(initialEntries = []) {
    this._entries = new Map(); // fp → { contentHash, lastSeenAt, updatedAt }
    this.saved = false;

    if (Array.isArray(initialEntries)) {
      for (const fp of initialEntries) {
        this._entries.set(fp, { contentHash: null, lastSeenAt: null, updatedAt: null });
      }
    } else {
      for (const [fp, hash] of Object.entries(initialEntries)) {
        this._entries.set(fp, { contentHash: hash, lastSeenAt: new Date().toISOString(), updatedAt: null });
      }
    }
  }

  filePath(provider, accountId = 'default') {
    const suffix = accountId && accountId !== 'default' ? `_${accountId}` : '';
    return `.seen/${provider}${suffix}.json`;
  }

  async load(provider, accountId = 'default') {
    return this;
  }

  /** Returns the stored entry for a fingerprint, or null. */
  lookup(fp) {
    return this._entries.get(fp) ?? null;
  }

  /** Insert or update an entry with a specific contentHash. */
  upsert(fp, newContentHash) {
    const existing = this._entries.get(fp);
    const now = new Date().toISOString();
    const contentChanged =
      existing && existing.contentHash != null && existing.contentHash !== newContentHash;
    this._entries.set(fp, {
      contentHash: newContentHash,
      lastSeenAt: now,
      updatedAt: contentChanged ? now : (existing?.updatedAt ?? null),
    });
  }

  has(fp)    { return this._entries.has(fp); }
  get size() { return this._entries.size; }

  async save(provider, accountId = 'default') {
    this.saved = true;
  }
}
