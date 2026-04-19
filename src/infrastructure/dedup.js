import { createHash } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

/**
 * Compute a stable 16-char hex fingerprint for a normalized transaction.
 *
 * Fields used: provider, accountId, transactionDate, merchantName, amount,
 *              currency, transactionType.
 *
 * Collision risk: two purchases at the same merchant on the same day for the
 * same amount in the same currency will produce the same fingerprint.
 * This is an accepted limitation for solo-developer use.
 */
export function fingerprint(t) {
  const key = [
    t.provider,
    t.accountId,
    t.transactionDate,
    t.merchantName,
    String(t.amount),
    t.currency,
    t.transactionType,
  ].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Persists the set of already-exported transaction fingerprints for a provider+account.
 *
 * Used to avoid re-exporting transactions seen in previous runs and to drive
 * incremental early-stop logic.
 *
 * One file per provider+account: {dir}/{provider}[_{accountId}].json
 */
export class SeenStore {
  constructor(dir = '.seen') {
    this.dir = dir;
    this._fps = new Set();
  }

  filePath(provider, accountId = 'default') {
    const suffix = accountId && accountId !== 'default' ? `_${accountId}` : '';
    return join(this.dir, `${provider}${suffix}.json`);
  }

  /** Loads persisted fingerprints from disk. Returns this for chaining. */
  async load(provider, accountId = 'default') {
    try {
      const raw = await readFile(this.filePath(provider, accountId), 'utf-8');
      const data = JSON.parse(raw);
      this._fps = new Set(Array.isArray(data.fingerprints) ? data.fingerprints : []);
    } catch {
      this._fps = new Set();
    }
    return this;
  }

  /** Persists current fingerprints to disk. */
  async save(provider, accountId = 'default') {
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      this.filePath(provider, accountId),
      JSON.stringify(
        { fingerprints: [...this._fps], savedAt: new Date().toISOString() },
        null,
        2
      ),
      'utf-8'
    );
  }

  has(fp)      { return this._fps.has(fp); }
  add(fp)      { this._fps.add(fp); }
  addMany(fps) { for (const fp of fps) this._fps.add(fp); }
  get size()   { return this._fps.size; }
}
