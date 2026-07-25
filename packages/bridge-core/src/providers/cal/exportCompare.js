/**
 * Identity comparison between the export path and the modal path (validation only).
 *
 * Given two arrays of already-normalized, finalized CAL transactions (one from each
 * path, same account + date window), this assigns occurrence keys with the SAME
 * assignOccurrenceKeys logic and compares identity (fingerprint/dedupKey), content,
 * and duplicate occurrence counts. It is pure: it never touches SeenStore,
 * FinanceLedger, Finance, or the network, and never uses row numbers as identity.
 *
 * The goal is the one gate before enabling Sync: prove the export path yields the
 * SAME dedupKeys as the trusted modal path, so the finance ledger is not bypassed.
 */

import { fingerprint, assignOccurrenceKeys } from '../../infrastructure/dedup.js';
import { logger } from '../../infrastructure/logger.js';

// Identity fields (must match dedup.fingerprint()). A difference here changes the
// dedupKey, so it surfaces as an export-only / modal-only key, not a matched diff.
const IDENTITY_FIELDS = ['provider', 'accountId', 'transactionDate', 'merchantName', 'amount', 'currency', 'transactionType'];
// Content fields (affect contentHash / update-classification, NOT identity).
const CONTENT_FIELDS = ['chargeAmount', 'chargeDate', 'chargeCurrency', 'category'];

const s = (v) => String(v ?? '');
/** Identity key with accountId (cardName) removed — for diagnosing card-only diffs. */
const looseKey = (t) => [t.provider, t.transactionDate, t.merchantName, s(t.amount), t.currency, t.transactionType].join('|');

/**
 * @param {object[]} exportTxs  normalized finalized transactions from the export path
 * @param {object[]} modalTxs   normalized finalized transactions from the modal path
 * @returns {{
 *   summary: object, exportOnly: string[], modalOnly: string[],
 *   fieldMismatches: Array<{dedupKey:string, diffs:object}>,
 *   cardNameMismatches: Array<{looseKey:string, exportCardName:string, modalCardName:string}>,
 *   duplicateGroups: Array<{baseFingerprint:string, exportCount:number, modalCount:number, match:boolean}>
 * }}
 */
export function compareTransactionSets(exportTxs = [], modalTxs = []) {
  // Clone so assigning dedupKeys never mutates the caller's objects.
  const exp = exportTxs.map((t) => ({ ...t }));
  const mod = modalTxs.map((t) => ({ ...t }));
  assignOccurrenceKeys(exp);
  assignOccurrenceKeys(mod);

  const expByKey = new Map(exp.map((t) => [t.dedupKey, t]));
  const modByKey = new Map(mod.map((t) => [t.dedupKey, t]));

  const exportOnly = [...expByKey.keys()].filter((k) => !modByKey.has(k));
  const modalOnly  = [...modByKey.keys()].filter((k) => !expByKey.has(k));
  const matchedKeys = [...expByKey.keys()].filter((k) => modByKey.has(k));

  // Field-level diffs on matched pairs (same dedupKey ⇒ identity already equal, so
  // these are almost always CONTENT diffs such as category/chargeDate).
  const fieldMismatches = [];
  for (const k of matchedKeys) {
    const a = expByKey.get(k), b = modByKey.get(k);
    const diffs = {};
    for (const f of [...IDENTITY_FIELDS, ...CONTENT_FIELDS]) {
      if (s(a[f]) !== s(b[f])) diffs[f] = { export: a[f], modal: b[f] };
    }
    if (Object.keys(diffs).length) fieldMismatches.push({ dedupKey: k, diffs });
  }

  // Card-only differences: an export-only key and a modal-only key that agree on
  // every identity field EXCEPT accountId (cardName). This is the main risk called
  // out for the export path, so it gets its own bucket.
  const cardNameMismatches = [];
  const expLoose = new Map(); for (const t of exp) if (!modByKey.has(t.dedupKey)) expLoose.set(looseKey(t), t);
  const modLoose = new Map(); for (const t of mod) if (!expByKey.has(t.dedupKey)) modLoose.set(looseKey(t), t);
  for (const [lk, et] of expLoose) {
    const mt = modLoose.get(lk);
    if (mt && s(et.accountId) !== s(mt.accountId)) {
      cardNameMismatches.push({ looseKey: lk, exportCardName: et.accountId, modalCardName: mt.accountId });
    }
  }

  // Duplicate group analysis by base fingerprint.
  const countByFp = (txs) => {
    const m = new Map();
    for (const t of txs) { const fp = fingerprint(t); m.set(fp, (m.get(fp) ?? 0) + 1); }
    return m;
  };
  const expGroups = countByFp(exp), modGroups = countByFp(mod);
  const duplicateGroups = [];
  for (const fp of new Set([...expGroups.keys(), ...modGroups.keys()])) {
    const ec = expGroups.get(fp) ?? 0, mc = modGroups.get(fp) ?? 0;
    if (ec > 1 || mc > 1 || ec !== mc) {
      duplicateGroups.push({ baseFingerprint: fp, exportCount: ec, modalCount: mc, match: ec === mc });
    }
  }

  const identityMatch = exportOnly.length === 0 && modalOnly.length === 0;
  return {
    summary: {
      exportCount: exp.length,
      modalCount: mod.length,
      matched: matchedKeys.length,
      exportOnlyCount: exportOnly.length,
      modalOnlyCount: modalOnly.length,
      fieldMismatchCount: fieldMismatches.length,
      cardNameMismatchCount: cardNameMismatches.length,
      duplicateGroupDiscrepancies: duplicateGroups.filter((g) => !g.match).length,
      identityMatch,
    },
    exportOnly,
    modalOnly,
    fieldMismatches: fieldMismatches.slice(0, 10),
    cardNameMismatches: cardNameMismatches.slice(0, 10),
    duplicateGroups,
  };
}

/** Log a clear, greppable `[cal-export-compare]` report. Never throws. */
export function logCompareReport(report, meta = {}) {
  const su = report.summary;
  logger.info(
    `[cal-export-compare] summary daysBack=${meta.daysBack ?? '?'} ` +
    `exportFinalized=${su.exportCount} modalFinalized=${su.modalCount} matched=${su.matched} ` +
    `exportOnly=${su.exportOnlyCount} modalOnly=${su.modalOnlyCount} ` +
    `contentDiffs=${su.fieldMismatchCount} cardNameDiffs=${su.cardNameMismatchCount} ` +
    `dupGroupDiscrepancies=${su.duplicateGroupDiscrepancies} identityMatch=${su.identityMatch}`,
    { provider: 'CAL' }
  );

  if (su.identityMatch && su.fieldMismatchCount === 0) {
    logger.info('[cal-export-compare] PASS — export and modal produced identical dedupKeys and content', { provider: 'CAL' });
  } else {
    logger.warn('[cal-export-compare] DIFFERENCES found — review before enabling Sync', { provider: 'CAL' });
  }

  if (report.exportOnly.length) logger.warn(`[cal-export-compare] export-only dedupKeys (first 10): ${report.exportOnly.slice(0, 10).join(', ')}`, { provider: 'CAL' });
  if (report.modalOnly.length)  logger.warn(`[cal-export-compare] modal-only dedupKeys (first 10): ${report.modalOnly.slice(0, 10).join(', ')}`, { provider: 'CAL' });

  for (const m of report.cardNameMismatches) {
    logger.warn(`[cal-export-compare] cardName differs — export="${m.exportCardName}" modal="${m.modalCardName}" for ${m.looseKey}`, { provider: 'CAL' });
  }
  for (const fm of report.fieldMismatches) {
    logger.warn(`[cal-export-compare] content diff dedupKey=${fm.dedupKey} ${JSON.stringify(fm.diffs)}`, { provider: 'CAL' });
  }
  for (const g of report.duplicateGroups.filter((x) => !x.match)) {
    logger.warn(`[cal-export-compare] duplicate-count mismatch fp=${g.baseFingerprint} export=${g.exportCount} modal=${g.modalCount}`, { provider: 'CAL' });
  }
}
