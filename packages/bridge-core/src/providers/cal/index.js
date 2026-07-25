import { BaseProvider } from '../../core/BaseProvider.js';
import { logger } from '../../infrastructure/logger.js';
import { withRetry } from '../../infrastructure/retry.js';
import { startTimer, elapsedMs, createLoopStats } from '../../infrastructure/timing.js';
import { login } from './auth.js';
import { navigateToTransactionsByDate, applyDateFilter } from './navigator.js';
import { countTransactions, openTransactionModal, extractModalData, closeModal } from './extractor.js';
import { normalizeTransaction } from './normalizer.js';
import { parseCalExport } from './exportParser.js';
import { downloadCalExport } from './exportDownloader.js';
import { compareTransactionSets, logCompareReport } from './exportCompare.js';

/**
 * CAL extraction path selection (as of 3.0.2).
 *
 * The Export/XLSX path is the DEFAULT and primary CAL extractor — it is
 * field-validated, far faster, and reuses the exact identity/dedup/ledger pipeline.
 * The per-row modal extractor remains ONLY as an explicitly-gated legacy fallback;
 * it is known-fragile and is never selected silently.
 *
 * Flags:
 *   CAL_USE_MODAL_LEGACY=true  → use the legacy modal extractor instead of export
 *   CAL_DISABLE_EXPORT=true     → alias for the above
 *   CAL_USE_EXPORT              → no longer required; accepted for backward compat.
 *                                 An explicit CAL_USE_EXPORT=false also selects legacy.
 */
function useModalLegacy() {
  return process.env.CAL_USE_MODAL_LEGACY === 'true'
    || process.env.CAL_DISABLE_EXPORT === 'true'
    || process.env.CAL_USE_EXPORT === 'false';
}
function useExportPath() {
  return !useModalLegacy();
}

/** Dev-only: run BOTH paths and log an identity comparison (dry-run, no import). */
function compareModalMode() {
  return process.env.CAL_EXPORT_COMPARE_MODAL === 'true';
}

/** Host of the CAL login iframe; its presence in the URL means the session dropped. */
const LOGIN_HOST = 'connect.cal-online.co.il';
/** Authenticated nav item — its absence mid-run also signals session loss. */
const AUTH_NAV_TEXT = 'עסקאות וחיובים';
/** A row taking longer than this is flagged so outliers are visible in the log. */
const SLOW_ROW_MS = 10000;
/** Emit a rowLoop progress line every N processed rows. */
const PROGRESS_EVERY = 10;

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Raised when CAL drops the session DURING the row loop (redirect to the login
 * host, or the authenticated nav disappearing). Deliberately NOT classified as a
 * retryable auth error (see isAuthError) so the run fails clearly with the last
 * processed row rather than silently restarting a full 300-row rescan. Automatic
 * re-login/resume is intentionally left for a later, approved change.
 */
export class CalSessionExpiredError extends Error {
  constructor(processedRows, totalRows, lastRowIndex) {
    super(`CAL session expired during row loop after ${processedRows}/${totalRows} rows`);
    this.name = 'CalSessionExpiredError';
    this.processedRows = processedRows;
    this.totalRows = totalRows;
    /** 0-based index of the last row attempted. */
    this.lastRowIndex = lastRowIndex;
  }
}

// ── CalProvider ───────────────────────────────────────────────────────────────

export class CalProvider extends BaseProvider {
  get name() {
    return 'CAL';
  }

  /**
   * CAL's login form lives in an Angular Material iframe (connect.cal-online.co.il)
   * that only opens reliably when a real, visible, foregrounded browser window is
   * active. Run headless/minimized and the "open login form" step times out. Opt
   * into a headed, foregrounded browser for the whole CAL run.
   */
  get requiresVisibleBrowser() {
    return true;
  }

  /**
   * Navigate to CAL homepage and check for the authenticated nav element.
   * Used to decide whether a saved session can be reused at startup.
   */
  async isSessionValid(page) {
    try {
      await page.goto('https://www.cal-online.co.il', { waitUntil: 'networkidle', timeout: 20000 });
      const count = await page.locator('text=עסקאות וחיובים').count();
      return count > 0;
    } catch {
      return false;
    }
  }

  /**
   * Cheap check for CAL session loss: redirected to the login host, or the
   * authenticated nav element gone. Used both to classify a fetch error and to
   * abort the row loop early with a clear message.
   */
  async _sessionLost() {
    try {
      const url = this.page?.url() ?? '';
      if (url.includes(LOGIN_HOST)) return true;
      const count = await this.page.locator(`text=${AUTH_NAV_TEXT}`).count();
      return count === 0;
    } catch {
      return false;
    }
  }

  /**
   * Detect whether an error during fetchTransactions indicates session expiry.
   * CAL session loss typically manifests as a redirect to the login iframe domain,
   * or as the authenticated nav element disappearing.
   *
   * A CalSessionExpiredError is deliberately NOT treated as retryable: it was
   * already raised because the session dropped mid-loop, and the current design is
   * to fail clearly (with the last processed row) rather than auto-restart a full
   * rescan. Automatic re-login/resume is a later, approved change.
   */
  async isAuthError(error) {
    if (error instanceof CalSessionExpiredError) return false;
    return this._sessionLost();
  }

  async login(credentials) {
    await this.page.goto('https://www.cal-online.co.il');
    await this.page.waitForLoadState('networkidle');
    // CAL requires an active, visible window for the login iframe to open. Bring
    // the browser to the front before the login flow starts (no-op if it already
    // is). bringToFront() exists on every real Playwright page; guarded so test
    // fakes without it still work.
    if (typeof this.page.bringToFront === 'function') {
      await this.page.bringToFront().catch(() => {});
    }
    await login(this.page, credentials.username, credentials.password);
  }

  /**
   * Export-file extraction path (feature flag CAL_USE_EXPORT=true).
   *
   * Downloads CAL's "ייצוא" file, parses it, maps each row into the SAME raw shape
   * the modal extractor produces, filters locally by daysBack, skips pending rows,
   * and returns normalized transactions via the SAME normalizeTransaction() used by
   * the modal path. Identity/dedup/ledger are untouched — assignOccurrenceKeys and
   * the SeenStore/FinanceLedger downstream decide identity and duplicates.
   *
   * VALIDATION: this is experimental. It emits loud `[cal-export]` summary counts
   * so the mapped output can be compared against the modal path (run Fetch-Only)
   * before it is trusted for a Sync to Finance.
   *
   * @returns {Promise<{ transactions: object[], warnings: string[], pendingSkipped: number, timing: object }>}
   */
  async _fetchViaExport({ daysBack, fetchStart, navMs, filterMs, dateFilterApplied }) {
    logger.info('[cal-export] using CAL Export/XLSX extraction (primary path)', { provider: 'CAL' });

    const dlStart = startTimer();
    const file = await downloadCalExport(this.page);
    const downloadMs = elapsedMs(dlStart);
    logger.info('[timing] cal.export.download', { provider: 'CAL', ms: downloadMs, size: file.size, extension: file.extension });

    const parseStart = startTimer();
    const parsed = parseCalExport(file.buffer, { daysBack });
    const parseMs = elapsedMs(parseStart);

    const warnings = [...parsed.warnings];
    const transactions = [];
    let pendingSkipped = 0;
    for (const row of parsed.mapped) {
      if (!row.withinRange) continue;      // outside requested daysBack
      if (row.pending) { pendingSkipped++; continue; } // never import pending/unfinalized
      transactions.push(normalizeTransaction(row.raw));
    }

    logger.info(
      `[cal-export] parsed export: format=${parsed.format} encoding=${parsed.encoding} ` +
      `headerFound=${parsed.headerFound} cardName="${parsed.cardName || ''}" ` +
      `totalRows=${parsed.stats.totalRows} withinDaysBack=${parsed.stats.withinRange} ` +
      `pendingSkipped=${parsed.stats.pendingSkipped} finalized=${parsed.stats.finalized} ` +
      `ignoredNonTransaction=${parsed.stats.ignoredNonTransaction ?? 0} daysBack=${daysBack} parseMs=${parseMs}`,
      { provider: 'CAL', columns: parsed.columns }
    );
    for (const w of parsed.warnings) logger.warn(`[cal-export] ${w}`, { provider: 'CAL' });

    const calFetchMs = elapsedMs(fetchStart);
    logger.info(
      `[timing-summary] scope=cal.export format=${parsed.format} encoding=${parsed.encoding} ` +
      `totalRows=${parsed.stats.totalRows} withinDaysBack=${parsed.stats.withinRange} ` +
      `pendingSkipped=${pendingSkipped} finalized=${transactions.length} ` +
      `navMs=${navMs} filterMs=${filterMs} downloadMs=${downloadMs} parseMs=${parseMs} calFetchMs=${calFetchMs}`,
      { provider: 'CAL' }
    );

    return {
      transactions,
      warnings,
      pendingSkipped,
      // Export parse stats surfaced for the dry-run plan (read-only diagnostics).
      exportStats: parsed.stats,
      timing: {
        source: 'export',
        calFetchMs, navMs, filterMs, downloadMs, parseMs, countMs: 0,
        dateFilterApplied,
        rowCount: parsed.stats.totalRows,
        rowLoopMs: 0,
        avgRowMs: 0, slowestRowMs: 0, slowestRowIndex: -1,
        openAvgMs: 0, openMaxMs: 0, extractAvgMs: 0, extractMaxMs: 0, closeAvgMs: 0, closeMaxMs: 0,
      },
    };
  }

  /**
   * DRY-RUN identity validation (CAL_USE_EXPORT + CAL_EXPORT_COMPARE_MODAL).
   *
   * Runs the export path then the modal path on the SAME already-filtered page,
   * compares the two finalized transaction sets' identities/dedupKeys/duplicate
   * occurrence counts, and logs a `[cal-export-compare]` report. Imports NOTHING
   * (returns an empty set) so SeenStore/FinanceLedger are not mutated and Finance is
   * never contacted. Intended for a SMALL window (daysBack 1–3).
   *
   * @returns {Promise<{ transactions: object[], warnings: string[], pendingSkipped: number, timing: object }>}
   */
  async _compareExportVsModal({ daysBack, fetchStart, navMs, filterMs, dateFilterApplied }) {
    logger.warn(
      `[cal-export-compare] DRY-RUN comparison active (CAL_EXPORT_COMPARE_MODAL=true) daysBack=${daysBack} — imports nothing, contacts no Finance`,
      { provider: 'CAL' }
    );

    // Export first (its download leaves the page intact), then modal extraction on
    // the same page. Both return normalized, finalized (pending-excluded) sets.
    const exportRes = await this._fetchViaExport({ daysBack, fetchStart: startTimer(), navMs, filterMs, dateFilterApplied });
    const modalRes  = await this._extractViaModal({ daysBack, startIndex: 0, onProgress: null, fetchStart: startTimer(), navMs, filterMs, dateFilterApplied });

    const report = compareTransactionSets(exportRes.transactions, modalRes.transactions);
    logCompareReport(report, { daysBack });

    return {
      // Dry-run: import nothing so no SeenStore/FinanceLedger entries are created.
      transactions: [],
      warnings: [
        `[cal-export-compare] dry-run only — 0 imported. exportFinalized=${report.summary.exportCount} ` +
        `modalFinalized=${report.summary.modalCount} identityMatch=${report.summary.identityMatch} ` +
        `exportOnly=${report.summary.exportOnlyCount} modalOnly=${report.summary.modalOnlyCount}`,
      ],
      pendingSkipped: 0,
      timing: {
        source: 'compare', calFetchMs: elapsedMs(fetchStart), navMs, filterMs, dateFilterApplied,
        rowCount: 0, countMs: 0, rowLoopMs: 0, avgRowMs: 0, slowestRowMs: 0, slowestRowIndex: -1,
        openAvgMs: 0, openMaxMs: 0, extractAvgMs: 0, extractMaxMs: 0, closeAvgMs: 0, closeMaxMs: 0,
      },
    };
  }

  /**
   * @param {object}   opts
   * @param {number}   [opts.daysBack=4]
   * @param {number}   [opts.startIndex=0]    - Row index to resume from (for checkpoint resume)
   * @param {Function} [opts.onProgress]      - Called after each extracted transaction,
   *                                            for checkpointing only. Signature:
   *                                            ({ index, total, transaction }) → Promise<void>.
   *                                            It CANNOT stop the scan — every row in the
   *                                            requested date range is always processed.
   * @returns {Promise<{ transactions: Transaction[], warnings: string[], pendingSkipped: number }>}
   */
  async fetchTransactions({ daysBack = 4, startIndex = 0, onProgress } = {}) {
    // ── Timing diagnostics (temporary — see infrastructure/timing.js) ─────────
    // Separates the fixed navigation/filter cost from the per-row extraction cost,
    // and reports per-sub-stage (modal-open / extract / close) aggregates so the
    // dominant cost in the loop is unambiguous rather than guessed at.
    const fetchStart = startTimer();

    const navStart = startTimer();
    await withRetry(
      () => navigateToTransactionsByDate(this.page),
      { attempts: 2, delay: 2000, label: 'CAL navigate to transactions' }
    );
    const navMs = elapsedMs(navStart);
    logger.info('[timing] cal.navigateToTransactions', { provider: 'CAL', ms: navMs });

    const filterStart = startTimer();
    const { dateFilterApplied } = await applyDateFilter(this.page, daysBack);
    const filterMs = elapsedMs(filterStart);
    logger.info('[timing] cal.applyDateFilter', { provider: 'CAL', daysBack, dateFilterApplied, ms: filterMs });

    // ── Path selection ────────────────────────────────────────────────────────
    // Dev compare mode: run BOTH paths on the same filtered page and log an identity
    // comparison. Dry-run — imports nothing, contacts no Finance, mutates no store.
    if (useExportPath() && compareModalMode()) {
      return this._compareExportVsModal({ daysBack, fetchStart, navMs, filterMs, dateFilterApplied });
    }
    // DEFAULT (3.0.2): download + parse CAL's Export/XLSX file.
    if (useExportPath()) {
      return this._fetchViaExport({ daysBack, fetchStart, navMs, filterMs, dateFilterApplied });
    }
    // Legacy fallback, only when explicitly requested (CAL_USE_MODAL_LEGACY=true):
    // the per-row modal extractor. Known-fragile; never selected silently.
    logger.warn('[cal] using LEGACY modal extraction (CAL_USE_MODAL_LEGACY) — export path is the supported default', { provider: 'CAL' });
    return this._extractViaModal({ daysBack, startIndex, onProgress, fetchStart, navMs, filterMs, dateFilterApplied });
  }

  /**
   * LEGACY per-row modal extraction path (behavior unchanged). Only used when
   * explicitly gated via CAL_USE_MODAL_LEGACY; the Export/XLSX path is the default.
   * Also invoked by the dev compare mode alongside the export path on the same page.
   * @returns {Promise<{ transactions: object[], warnings: string[], pendingSkipped: number, timing: object }>}
   */
  async _extractViaModal({ daysBack = 4, startIndex = 0, onProgress, fetchStart = startTimer(), navMs = 0, filterMs = 0, dateFilterApplied = true }) {
    const countStart = startTimer();
    const count = await countTransactions(this.page);
    const countMs = elapsedMs(countStart);
    logger.info('[timing] cal.countTransactions', { provider: 'CAL', ms: countMs });
    logger.info(`Found ${count} transaction row(s)`, { provider: 'CAL' });

    if (startIndex > 0) {
      logger.info(`Resuming from row ${startIndex + 1}/${count}`, { provider: 'CAL' });
    }

    const transactions = [];
    const warnings = [];
    let pendingSkipped = 0;
    let modalOpened = 0;

    // Per-sub-stage aggregates across the row loop (count/total/avg/min/max/slowest).
    const openStats     = createLoopStats('cal.row.openModal');
    const extractStats  = createLoopStats('cal.row.extract');
    const closeStats    = createLoopStats('cal.row.close');
    const rowStats      = createLoopStats('cal.row.total');
    const rowsStart     = startTimer();

    // Close-stage breakdown: which action actually closes CAL's modal, and how
    // fast. escapeStats/fallbackStats hold the per-row close ms split by method.
    let escapeConfirmed = 0, closeButtonUsed = 0, backdropUsed = 0, unconfirmedClose = 0;
    const escapeStats   = createLoopStats('cal.close.escape');
    const fallbackStats = createLoopStats('cal.close.fallback');

    logger.info(`[timing] cal.rowLoop.start total=${count} startIndex=${startIndex}`, { provider: 'CAL' });

    for (let i = startIndex; i < count; i++) {
      const rowStart = startTimer();
      let openMs = 0, extractMs = 0, closeMs = 0;
      let modal = null;
      try {
        // ── Open (fast, deterministic) with ONE session-aware retry ───────────
        // openTransactionModal already waits only until the dialog is visible and
        // fails fast. A single retry covers a transient miss; before retrying (and
        // after) we check for whole-session loss so we abort clearly instead of
        // burning retries + rescans against a logged-out page.
        const openStart = startTimer();
        let opened;
        try {
          ({ opened, modal } = await openTransactionModal(this.page, i));
        } catch (openErr) {
          if (await this._sessionLost()) throw new CalSessionExpiredError(i - startIndex, count, i);
          ({ opened, modal } = await openTransactionModal(this.page, i));
        }
        openMs = elapsedMs(openStart);
        openStats.record(openMs, i);

        if (!opened) {
          const msg = `Row ${i + 1}/${count} was not clickable — skipped`;
          logger.debug(msg);
          warnings.push(msg);
          continue;
        }
        modalOpened++;

        const extractStart = startTimer();
        const raw = await extractModalData(this.page);
        extractMs = elapsedMs(extractStart);
        extractStats.record(extractMs, i);

        // Close against the EXACT dialog element that opened, then record which
        // action closed it (Escape / close button / backdrop) for the summary.
        const closeStart = startTimer();
        const closeRes = await closeModal(this.page, modal);
        closeMs = elapsedMs(closeStart);
        closeStats.record(closeMs, i);
        if (closeRes.closed) {
          if (closeRes.method === 'escape')      { escapeConfirmed++; escapeStats.record(closeMs, i); }
          else if (closeRes.method === 'closeButton') { closeButtonUsed++; fallbackStats.record(closeMs, i); }
          else if (closeRes.method === 'backdrop')    { backdropUsed++;    fallbackStats.record(closeMs, i); }
        } else {
          unconfirmedClose++;
          // Correctness note: an unconfirmed close is the only stale-modal risk.
          // The next row's open re-clicks and re-waits for a visible dialog, and
          // extraction resolves the first VISIBLE modal root, so a fully-hidden
          // leftover cannot be read; a still-visible leftover is surfaced here.
          logger.warn(`Row ${i + 1}/${count} close not confirmed — possible stale modal`, { provider: 'CAL' });
        }

        if (raw) {
          // Skip pending/unfinalized CAL transactions: their amount can still
          // change, so exporting them now would create stale/duplicate data.
          // (Debug-level: on a large statement most rows can be pending, and a
          // per-row info line for each was noisy; the aggregate is logged below.)
          if (raw.pending) {
            pendingSkipped++;
            logger.debug(`Row ${i + 1}/${count} skipped — pending/unfinalized CAL transaction`, {
              provider: 'CAL',
              row: i + 1,
              merchant: raw.businessName || '(unknown)',
              marker: raw.pendingMarker,
            });
            continue;
          }

          const normalized = normalizeTransaction(raw);
          transactions.push(normalized);

          // Checkpoint only — never stops the scan; the full range is always read.
          // (Fires only for finalized/extracted rows; pending/skipped rows above
          // return early and never trigger a checkpoint write.)
          if (onProgress) {
            await onProgress({ index: i, total: count, transaction: normalized });
          }
        }
      } catch (err) {
        // Session loss aborts the whole loop — it must NOT be swallowed as a
        // per-row skip. Everything else is an isolated, recoverable row failure.
        if (err instanceof CalSessionExpiredError) {
          logger.warn(err.message, { provider: 'CAL', processed: err.processedRows, total: err.totalRows });
          throw err;
        }
        const msg = `Transaction ${i + 1}/${count} skipped: ${err.message}`;
        logger.warn(msg);
        warnings.push(msg);
        await closeModal(this.page, modal).catch(() => {});
      } finally {
        // Release the per-row element handle so a long scan cannot accumulate them.
        if (modal && typeof modal.dispose === 'function') await modal.dispose().catch(() => {});
        const rowMs = elapsedMs(rowStart);
        rowStats.record(rowMs, i);

        // Flag outlier rows so a slow stage is obvious without per-row debug logs.
        if (rowMs > SLOW_ROW_MS) {
          const stage = closeMs >= openMs && closeMs >= extractMs ? 'close'
            : extractMs >= openMs ? 'extract' : 'openModal';
          logger.warn(`[timing-warning] cal.row.slow index=${i + 1} stage=${stage} ms=${round1(rowMs)}`, { provider: 'CAL' });
        }
      }

      // Progress heartbeat every N rows: makes a long scan observable and shows
      // whether the site is degrading (rising avgRowMs) before it disconnects.
      const processed = i - startIndex + 1;
      if (processed % PROGRESS_EVERY === 0) {
        const elapsed = elapsedMs(rowsStart);
        logger.info(
          `[timing-progress] cal.rowLoop processed=${processed} total=${count} ` +
          `elapsedMs=${round1(elapsed)} avgRowMs=${round1(elapsed / processed)} ` +
          `modalOpened=${modalOpened} pendingAfterModal=${pendingSkipped}`,
          { provider: 'CAL' }
        );
      }
    }

    // ── Loop timing aggregates ────────────────────────────────────────────────
    // One info line per sub-stage. Comparing openModal / extract / close totals
    // shows exactly where the per-row time goes; slowestIndex flags outlier rows.
    const rowsProcessed = count - startIndex;
    const rowLoopMs = elapsedMs(rowsStart);
    logger.info('[timing] cal.rowLoop', { provider: 'CAL', rows: rowsProcessed, totalMs: rowLoopMs });
    openStats.log({ provider: 'CAL' });
    extractStats.log({ provider: 'CAL' });
    closeStats.log({ provider: 'CAL' });
    rowStats.log({ provider: 'CAL' });
    const calFetchMs = elapsedMs(fetchStart);
    logger.info('[timing] cal.fetchTransactions', { provider: 'CAL', rows: rowsProcessed, totalMs: calFetchMs });

    // Close-stage breakdown — reveals which action actually closes CAL's modal
    // (Escape vs close button vs backdrop) and the cost of each, so the close path
    // can be tuned to the one that works.
    const escSum   = escapeStats.summary();
    const fbSum    = fallbackStats.summary();
    const closeSum = closeStats.summary();
    logger.info(
      `[timing-summary] scope=cal.close escapeConfirmed=${escapeConfirmed} ` +
      `closeButtonUsed=${closeButtonUsed} backdropUsed=${backdropUsed} unconfirmed=${unconfirmedClose} ` +
      `escapeAvgMs=${escSum.avgMs} escapeMaxMs=${escSum.maxMs} ` +
      `fallbackAvgMs=${fbSum.avgMs} fallbackMaxMs=${fbSum.maxMs} ` +
      `closeAvgMs=${closeSum.avgMs} closeMaxMs=${closeSum.maxMs}`,
      { provider: 'CAL' }
    );

    if (pendingSkipped > 0) {
      logger.info(`${pendingSkipped} pending/unfinalized transaction(s) skipped`, { provider: 'CAL' });
    }

    // Compact timing bundle returned to the orchestrator so it can emit a single
    // `[timing-summary]` line stamped with the account name. Diagnostics only —
    // it carries no transaction data and never affects dedup/ledger/export.
    const os = openStats.summary();
    const es = extractStats.summary();
    const cs = closeStats.summary();
    const rs = rowStats.summary();
    const timing = {
      calFetchMs,
      navMs, filterMs, countMs,
      dateFilterApplied,
      rowCount: rowsProcessed,
      rowLoopMs,
      avgRowMs:     rs.avgMs,
      slowestRowMs: rs.maxMs,
      slowestRowIndex: rs.slowestIndex,
      openAvgMs:    os.avgMs, openMaxMs:    os.maxMs,
      extractAvgMs: es.avgMs, extractMaxMs: es.maxMs,
      closeAvgMs:   cs.avgMs, closeMaxMs:   cs.maxMs,
    };

    return { transactions, warnings, pendingSkipped, timing };
  }
}
