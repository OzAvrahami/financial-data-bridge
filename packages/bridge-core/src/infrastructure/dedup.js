import { createHash } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

/**
 * Compute a stable 16-char hex dedupKey for a normalized transaction.
 * Identifies the same real-world transaction across runs.
 *
 * Uses only immutable identity fields: provider, accountId, transactionDate,
 * merchantName, amount, currency, transactionType.
 *
 * Two transactions with identical business fields produce the same base fingerprint.
 * Use assignOccurrenceKeys() to disambiguate them within a fetch batch.
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
 * Assign a stable `dedupKey` to every transaction in the array, in place.
 *
 * For transactions whose base fingerprint appears exactly once in the batch,
 * dedupKey equals fingerprint(tx) — backward-compatible with existing SeenStore
 * entries (no re-export on upgrade).
 *
 * For transactions whose base fingerprint appears more than once (genuine business-
 * field duplicates such as two recurring charges for the same amount), occurrence
 * indices are assigned in extraction order:
 *   occurrenceIndex 1  → dedupKey = fingerprint(tx)          (no suffix — backward compat)
 *   occurrenceIndex 2  → dedupKey = fingerprint(tx) + "|#2"
 *   occurrenceIndex N  → dedupKey = fingerprint(tx) + "|#N"
 *
 * This ensures:
 *   - A transaction that was unique in a prior run (stored as baseFp) is still
 *     matched correctly if it remains the first occurrence in a later run.
 *   - A genuinely new second occurrence gets a distinct key and is treated as 'created'.
 *
 * Risk: occurrence order depends on DOM extraction order. If CAL reorders rows between
 * runs, the mapping of "first" vs "second" occurrence may shift. There is no server-side
 * unique identifier available to anchor the assignment.
 *
 * @param {Transaction[]} transactions - Mutated in place.
 */
export function assignOccurrenceKeys(transactions) {
  // First pass: count how many times each base fingerprint appears.
  const totalCount = new Map(); // baseFp → total occurrences in this batch
  for (const tx of transactions) {
    const baseFp = fingerprint(tx);
    totalCount.set(baseFp, (totalCount.get(baseFp) ?? 0) + 1);
  }

  // Second pass: assign dedupKey in extraction order.
  const seenCount = new Map(); // baseFp → how many we have assigned so far
  for (const tx of transactions) {
    const baseFp = fingerprint(tx);
    const occ = (seenCount.get(baseFp) ?? 0) + 1;
    seenCount.set(baseFp, occ);
    tx.dedupKey = occ === 1 ? baseFp : `${baseFp}|#${occ}`;
  }
}

/**
 * Compute a 16-char hex hash of the mutable content fields of a transaction.
 * Used to detect when a previously-seen transaction has been updated
 * (e.g. pending → completed, chargeDate/chargeAmount settling, category change).
 *
 * Fields: status, chargeDate, chargeAmount, chargeCurrency, category.
 * Excludes: identity fields (covered by fingerprint) and raw (unstable metadata).
 */
export function contentHash(t) {
  const key = [
    t.status ?? '',
    t.chargeDate ?? '',
    String(t.chargeAmount ?? ''),
    t.chargeCurrency ?? '',
    t.category ?? '',
  ].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Classify a transaction against what is stored in the seen store.
 *
 * Returns:
 *   'created'   - not previously seen; export as new
 *   'updated'   - previously seen but content changed; re-export
 *   'unchanged' - previously seen with identical content; skip
 *
 * Legacy entries (migrated from v1 fingerprint-only format, contentHash === null)
 * are treated as 'unchanged' to avoid a mass re-export on first migration run.
 *
 * When fullFetch is true, always returns 'created' (ignores stored state).
 *
 * @param {SeenStore} store
 * @param {string} fp - dedupKey (fingerprint)
 * @param {string} ch - content hash
 * @param {boolean} [fullFetch]
 * @returns {'created'|'updated'|'unchanged'}
 */
export function classifyTransaction(store, fp, ch, fullFetch = false) {
  if (fullFetch) return 'created';
  const entry = store.lookup(fp);
  if (!entry) return 'created';
  if (entry.contentHash == null) return 'unchanged'; // v1 legacy migration
  if (entry.contentHash === ch) return 'unchanged';
  return 'updated';
}

/**
 * Persists per-transaction seen state (dedupKey → contentHash) per provider+account.
 *
 * Used to classify transactions as created/updated/unchanged and to drive
 * incremental early-stop on consecutive unchanged transactions.
 *
 * One file per provider+account: {dir}/{provider}[_{accountId}].json
 *
 * File format v2:
 *   { "entries": { "<fp>": { "contentHash": "...", "lastSeenAt": "...", "updatedAt": "..." } }, "savedAt": "..." }
 *
 * Legacy format v1 (fingerprints array) is auto-migrated on load:
 *   contentHash set to null → treated as 'unchanged' by classifyTransaction.
 */
export class SeenStore {
  constructor(dir = 'runtime/seen') {
    this.dir = dir;
    this._entries = new Map(); // fp → { contentHash, lastSeenAt, updatedAt }
  }

  filePath(provider, accountId = 'default') {
    const suffix = accountId && accountId !== 'default' ? `_${accountId}` : '';
    return join(this.dir, `${provider}${suffix}.json`);
  }

  /** Returns the stored entry for a fingerprint, or null if not seen before. */
  lookup(fp) {
    return this._entries.get(fp) ?? null;
  }

  /**
   * Insert or update the entry for a fingerprint.
   * Sets updatedAt when an existing entry's contentHash changes.
   */
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

  /** Returns true if this fingerprint has ever been seen (any content). */
  has(fp) { return this._entries.has(fp); }

  get size() { return this._entries.size; }

  /** Loads persisted entries from disk. Automatically migrates v1 format. */
  async load(provider, accountId = 'default') {
    try {
      const raw = await readFile(this.filePath(provider, accountId), 'utf-8');
      const data = JSON.parse(raw);

      if (data.entries && typeof data.entries === 'object') {
        // v2 format
        this._entries = new Map(Object.entries(data.entries));
      } else if (Array.isArray(data.fingerprints)) {
        // v1 format — migrate with null contentHash (treated as unchanged)
        this._entries = new Map(
          data.fingerprints.map(fp => [fp, { contentHash: null, lastSeenAt: null, updatedAt: null }])
        );
      } else {
        this._entries = new Map();
      }
    } catch {
      this._entries = new Map();
    }
    return this;
  }

  /** Persists current entries to disk in v2 format. */
  async save(provider, accountId = 'default') {
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      this.filePath(provider, accountId),
      JSON.stringify(
        { entries: Object.fromEntries(this._entries), savedAt: new Date().toISOString() },
        null,
        2
      ),
      'utf-8'
    );
  }
}
