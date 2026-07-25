/**
 * Export-only DRY-RUN plan (validation, no mutation).
 *
 * Takes the export path's already-normalized, occurrence-keyed, FINALIZED
 * transactions and runs them through the SAME production identity logic —
 * fingerprint, classifyTransaction against the SeenStore, and FinanceLedger
 * lookups — to answer "what WOULD this run do?" without writing anything.
 *
 * Strictly read-only: it calls only `seenStore.lookup`/`classifyTransaction` and
 * `financeLedger.wasSentSuccessfully`/`lookup`. It never calls `.save()`, never
 * upserts, never records a send, and never contacts Finance. Identity remains the
 * existing fingerprint/dedupKey — never a row number.
 */

import { fingerprint, contentHash, classifyTransaction } from '../infrastructure/dedup.js';
import { logger } from '../infrastructure/logger.js';

// Identity fields required for a stable fingerprint (see dedup.fingerprint()).
const REQUIRED_IDENTITY = ['provider', 'accountId', 'transactionDate', 'merchantName', 'currency', 'transactionType'];

function missingIdentityFields(tx) {
  const missing = REQUIRED_IDENTITY.filter((f) => !String(tx[f] ?? '').trim());
  if (!Number.isFinite(tx.amount)) missing.push('amount');
  return missing;
}

/**
 * Build the dry-run plan (pure). SeenStore/FinanceLedger, if provided, MUST already
 * be loaded; they are read only. Pass null to treat all as new / never-sent.
 *
 * @param {object}   args
 * @param {object[]} args.transactions   normalized finalized txs (dedupKey assigned upstream)
 * @param {object}   [args.seenStore]    loaded SeenStore (read-only)
 * @param {object}   [args.financeLedger] loaded FinanceLedger (read-only)
 * @param {object}   [args.exportStats]  { totalRows, withinRange, pendingSkipped, finalized }
 * @param {boolean}  [args.fullFetch]
 * @returns {object} plan
 */
export function buildDryRunPlan({ transactions = [], seenStore = null, financeLedger = null, exportStats = null, fullFetch = false } = {}) {
  const warnings = [];

  // Base-fingerprint groups (duplicate detection is identity-based, not positional).
  const groups = new Map(); // baseFp → [dedupKey,...]
  for (const tx of transactions) {
    const fp = fingerprint(tx);
    const key = tx.dedupKey || fp;
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(key);
  }
  const duplicateGroups = [...groups.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(([baseFingerprint, dedupKeys]) => ({ baseFingerprint, count: dedupKeys.length, dedupKeys }));
  const duplicateOccurrences = duplicateGroups.reduce((n, g) => n + (g.count - 1), 0);

  let wouldBeNew = 0, wouldBeUpdated = 0, wouldBeUnchanged = 0;
  let alreadySentInFinanceLedger = 0, wouldSendToFinance = 0, blockedOrInvalid = 0;

  const invalidRows = [];
  const samples = [];

  transactions.forEach((tx, i) => {
    const key = tx.dedupKey || fingerprint(tx);
    const ch = contentHash(tx);

    // Local created/updated/unchanged against the SeenStore (read-only).
    const kind = seenStore ? classifyTransaction(seenStore, key, ch, fullFetch) : 'created';
    if (kind === 'created') wouldBeNew++;
    else if (kind === 'updated') wouldBeUpdated++;
    else wouldBeUnchanged++;

    // Finance eligibility mirrors syncTransactionsToFinance's gates (read-only).
    const missing = missingIdentityFields(tx);
    let blockedReason = null;
    if (missing.length) blockedReason = `missing_identity:${missing.join(',')}`;
    else if (tx.status !== 'completed') blockedReason = 'transaction_not_completed';
    else if (!(tx.chargeAmount > 0)) blockedReason = 'charge_amount_zero_or_negative';

    const alreadySent = !!(financeLedger && financeLedger.wasSentSuccessfully(key));
    if (alreadySent) alreadySentInFinanceLedger++;

    if (blockedReason) {
      blockedOrInvalid++;
      if (invalidRows.length < 20) invalidRows.push({ dedupKey: key, merchant: tx.merchantName, reason: blockedReason });
    } else if (!alreadySent) {
      wouldSendToFinance++;
    }

    if (samples.length < 10) {
      samples.push({
        date: tx.transactionDate, merchant: tx.merchantName, amount: tx.amount, currency: tx.currency,
        cardName: tx.accountId, chargeDate: tx.chargeDate, transactionType: tx.transactionType,
        originalAmount: tx.raw?.originalAmount ?? null, originalCurrency: tx.raw?.originalCurrency ?? null,
        dedupKey: key,
      });
    }
  });

  const missingIdentityRows = transactions
    .map((tx, index) => ({ index, missing: missingIdentityFields(tx), merchant: tx.merchantName, dedupKey: tx.dedupKey }))
    .filter((r) => r.missing.length)
    .slice(0, 20);

  const normalized = transactions.length;

  // Signal that the export identity may not line up with historical modal
  // fingerprints: everything looks new despite prior seen/ledger state existing.
  const priorStateExists = (seenStore?.size ?? 0) > 0 || (financeLedger?.size ?? 0) > 0;
  if (normalized > 0 && wouldBeNew === normalized && priorStateExists) {
    warnings.push('ALL transactions classified as NEW despite existing SeenStore/FinanceLedger state — export identity may not match historical modal fingerprints (check cardName).');
  }
  if (alreadySentInFinanceLedger > 0) {
    warnings.push(`${alreadySentInFinanceLedger} transaction(s) already present in FinanceLedger (would NOT be resent).`);
  }
  // Finance-duplicate risk: a non-empty ledger exists, yet NONE of the to-send
  // transactions are in it. If this period was previously synced (e.g. under the
  // modal path with different identities), enabling Sync could duplicate them.
  if (wouldSendToFinance > 0 && alreadySentInFinanceLedger === 0 && (financeLedger?.size ?? 0) > 0) {
    warnings.push(`${wouldSendToFinance} transaction(s) would be sent to Finance but NONE match the existing FinanceLedger (${financeLedger.size} entries). If this period was already synced under different historical identities, enabling Sync could create duplicates — verify before enabling Sync.`);
  }
  if (missingIdentityRows.length) {
    warnings.push(`${missingIdentityRows.length} row(s) missing required identity fields.`);
  }

  return {
    summary: {
      totalRows: exportStats?.totalRows ?? normalized,
      withinDaysBack: exportStats?.withinRange ?? normalized,
      pendingSkipped: exportStats?.pendingSkipped ?? 0,
      finalized: exportStats?.finalized ?? normalized,
      normalized,
      uniqueBaseFingerprints: groups.size,
      duplicateGroups: duplicateGroups.length,
      duplicateOccurrences,
      wouldBeNew, wouldBeUpdated, wouldBeUnchanged,
      alreadySentInFinanceLedger, wouldSendToFinance, blockedOrInvalid,
      warnings: warnings.length,
    },
    warnings,
    samples,
    duplicateGroupSamples: duplicateGroups.slice(0, 10),
    invalidRows,
    missingIdentityRows,
  };
}

/** Log the dry-run plan under the `[cal-export-plan]` prefix. Never throws. */
export function logDryRunPlan(plan) {
  const su = plan.summary;
  logger.info(
    `[cal-export-plan] summary totalRows=${su.totalRows} withinDaysBack=${su.withinDaysBack} ` +
    `pendingSkipped=${su.pendingSkipped} finalized=${su.finalized} normalized=${su.normalized} ` +
    `uniqueBaseFingerprints=${su.uniqueBaseFingerprints} duplicateGroups=${su.duplicateGroups} ` +
    `duplicateOccurrences=${su.duplicateOccurrences} wouldBeNew=${su.wouldBeNew} ` +
    `wouldBeUpdated=${su.wouldBeUpdated} wouldBeUnchanged=${su.wouldBeUnchanged} ` +
    `alreadySentInFinanceLedger=${su.alreadySentInFinanceLedger} wouldSendToFinance=${su.wouldSendToFinance} ` +
    `blockedOrInvalid=${su.blockedOrInvalid} warnings=${su.warnings}`,
    { provider: 'CAL' }
  );

  for (const w of plan.warnings) logger.warn(`[cal-export-plan] WARNING: ${w}`, { provider: 'CAL' });

  plan.samples.forEach((s, i) => {
    logger.info(
      `[cal-export-plan] sample#${i + 1} date=${s.date} merchant="${s.merchant}" amount=${s.amount} ` +
      `currency=${s.currency} cardName="${s.cardName}" chargeDate=${s.chargeDate} type="${s.transactionType}" ` +
      `originalAmount=${s.originalAmount ?? ''} originalCurrency=${s.originalCurrency ?? ''} dedupKey=${s.dedupKey}`,
      { provider: 'CAL' }
    );
  });

  for (const g of plan.duplicateGroupSamples) {
    logger.info(`[cal-export-plan] dupGroup fp=${g.baseFingerprint} count=${g.count} dedupKeys=[${g.dedupKeys.join(', ')}]`, { provider: 'CAL' });
  }
  for (const r of plan.invalidRows) {
    logger.warn(`[cal-export-plan] blocked/invalid merchant="${r.merchant}" dedupKey=${r.dedupKey} reason=${r.reason}`, { provider: 'CAL' });
  }
  for (const r of plan.missingIdentityRows) {
    logger.warn(`[cal-export-plan] missing-identity row index=${r.index} merchant="${r.merchant}" missing=[${r.missing.join(',')}]`, { provider: 'CAL' });
  }
}
