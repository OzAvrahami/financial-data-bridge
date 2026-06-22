import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { join } from 'path';

/**
 * Persists per-transaction FINANCE SYNC state, separate from the local dedup
 * SeenStore. This is the authoritative answer to "was this transaction already
 * sent to the finance system?" — a question the local new/updated/unchanged dedup
 * status cannot answer.
 *
 * Why a dedicated ledger:
 *   - Local "unchanged" means "identical to what we exported locally last time".
 *     It does NOT mean "the finance system accepted it". A transaction can be
 *     unchanged locally yet never successfully sent (finance disabled at the time,
 *     a prior API failure, or it was first saved before finance sync existed).
 *   - Without this record, an unchanged-locally transaction is excluded from the
 *     local export set and could be missed by finance forever. The ledger lets the
 *     sync engine consider EVERY transaction and decide independently.
 *
 * One file per provider+account: {dir}/{provider}[_{accountId}].json
 *
 * File format:
 *   {
 *     "entries": {
 *       "<dedupKey>": {
 *         "financeStatus": "sent" | "failed",
 *         "reason": "<reason code>",
 *         "contentHash": "<hash at the time it was sent>",
 *         "apiStatus": 201,
 *         "financeTransactionId": "<id returned by finance, if any>",
 *         "sentAt": "<ISO ts of last successful send, null if never>",
 *         "lastAttemptAt": "<ISO ts of last attempt>",
 *         "attempts": 3
 *       }
 *     },
 *     "savedAt": "<ISO ts>"
 *   }
 *
 * Only successful sends carry a non-null `sentAt`. Entries with financeStatus
 * "failed" remain eligible for retry on the next Sync to Finance run.
 */
export class FinanceLedger {
  constructor(dir = 'runtime/finance-ledger') {
    this.dir = dir;
    this._entries = new Map(); // dedupKey → entry
  }

  filePath(provider, accountId = 'default') {
    const suffix = accountId && accountId !== 'default' ? `_${accountId}` : '';
    return join(this.dir, `${provider}${suffix}.json`);
  }

  /** Returns the stored entry for a dedupKey, or null if never recorded. */
  lookup(dedupKey) {
    return this._entries.get(dedupKey) ?? null;
  }

  /** True only when this dedupKey has a successful prior send (sentAt set). */
  wasSentSuccessfully(dedupKey) {
    const e = this._entries.get(dedupKey);
    return !!(e && e.sentAt && e.financeStatus === 'sent');
  }

  /** Record a successful send. Stores the contentHash so later content changes are detectable. */
  recordSent(dedupKey, { contentHash = null, apiStatus = null, financeTransactionId = null } = {}) {
    const now = new Date().toISOString();
    const prev = this._entries.get(dedupKey);
    this._entries.set(dedupKey, {
      financeStatus: 'sent',
      reason: 'already_sent_successfully',
      contentHash,
      apiStatus,
      financeTransactionId,
      sentAt: now,
      lastAttemptAt: now,
      attempts: (prev?.attempts ?? 0) + 1,
    });
  }

  /** Record a failed attempt. Preserves any prior successful sentAt (never downgrades a real send). */
  recordFailed(dedupKey, { reason = 'api_error', apiStatus = null } = {}) {
    const now = new Date().toISOString();
    const prev = this._entries.get(dedupKey);
    // If it was previously sent successfully, do not overwrite that success.
    if (prev && prev.sentAt && prev.financeStatus === 'sent') {
      this._entries.set(dedupKey, { ...prev, lastAttemptAt: now, attempts: (prev.attempts ?? 0) + 1 });
      return;
    }
    this._entries.set(dedupKey, {
      financeStatus: 'failed',
      reason,
      contentHash: prev?.contentHash ?? null,
      apiStatus,
      financeTransactionId: prev?.financeTransactionId ?? null,
      sentAt: prev?.sentAt ?? null,
      lastAttemptAt: now,
      attempts: (prev?.attempts ?? 0) + 1,
    });
  }

  get size() { return this._entries.size; }

  /** Loads persisted entries from disk. Missing/corrupt file → empty ledger. */
  async load(provider, accountId = 'default') {
    try {
      const raw = await readFile(this.filePath(provider, accountId), 'utf-8');
      const data = JSON.parse(raw);
      this._entries = data?.entries && typeof data.entries === 'object'
        ? new Map(Object.entries(data.entries))
        : new Map();
    } catch {
      this._entries = new Map();
    }
    return this;
  }

  /** Persists current entries to disk (atomic-ish write-then-rename via .tmp). */
  async save(provider, accountId = 'default') {
    await mkdir(this.dir, { recursive: true });
    const path = this.filePath(provider, accountId);
    const tmp = path + '.tmp';
    await writeFile(
      tmp,
      JSON.stringify({ entries: Object.fromEntries(this._entries), savedAt: new Date().toISOString() }, null, 2),
      'utf-8'
    );
    await rename(tmp, path);
  }
}
