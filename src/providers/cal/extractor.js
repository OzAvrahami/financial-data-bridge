/**
 * CAL DOM extraction logic.
 *
 * Transaction rows are identified by `.field` divs with exactly 5 child elements.
 * This heuristic works on the current CAL Angular app structure. If the transaction
 * list stops returning results, inspect whether CAL changed this layout.
 *
 * All parsing of Hebrew label keys happens here — nothing CAL-specific leaks
 * into the normalizer or application layers.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { logger } from '../../infrastructure/logger.js';
import { parseAmount } from './normalizer.js';

/**
 * Ordered list of selectors that may identify the transaction detail window.
 *
 * CAL's overlay does NOT reliably expose `role="dialog"` (clicking a row visibly
 * opens the detail panel, yet `[role="dialog"]` never becomes visible — that was
 * the cause of the repeated 10s timeouts). The detail *content* is a far more
 * reliable signal, so the content markers (`table.details-table`, `.table-key`)
 * are included here and the detection succeeds as soon as any one of them is
 * visible.
 *
 * Order is most-specific-container → content-marker. Detection waits for the
 * first one that becomes visible; extraction resolves the modal root the same way.
 */
const MODAL_SELECTORS = [
  '[role="dialog"]',
  'mat-dialog-container',
  '.cdk-dialog-container',
  '.cdk-overlay-pane',
  '.modal-dialog',
  '.transaction-details',
  'table.details-table',
  '.details-table',
];

const MODAL_TIMEOUT_MS = 10000;
const DEBUG_DIR = 'logs/debug';

/**
 * Hebrew markers CAL shows on a transaction that is not finalized yet (the
 * amount may still change while CAL ingests it over a few days). Such rows must
 * NOT be exported — they would later change and produce duplicate/stale data.
 *
 * NOTE: CAL spells the class `descrition` (their typo), not `description`.
 * These markers are read from `.info-section`, `.info-section .descrition` and
 * `.payee-name`, falling back to the full panel text.
 */
const PENDING_MARKERS = [
  'העסקה עדיין לא נקלטה',
  'עדיין לא נקלטה',
  'הסכום לא סופי',
  'עדיין בתהליך קליטה',
  'תהליך קליטה',
];

/**
 * Return the first pending/unfinalized marker found in `text`, or null.
 * Pure + exported so the skip rule can be unit-tested without a browser.
 *
 * @param {string} text
 * @param {string[]} [markers]
 * @returns {string|null}
 */
export function detectPendingMarker(text, markers = PENDING_MARKERS) {
  if (!text) return null;
  return markers.find(marker => text.includes(marker)) || null;
}

export async function countTransactions(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.field'))
      .filter(div => div.children.length === 5)
      .length
  );
}

/**
 * Click row `index` and wait for the detail window to become visible.
 *
 * Returns false (non-retryable) only when the row itself is not found.
 * Throws on detection timeout so withRetry can retry transient failures; on
 * timeout it first records diagnostics + a debug dump (see logs/debug/).
 */
export async function openTransactionModal(page, index) {
  const clicked = await page.evaluate(i => {
    const rows = Array.from(document.querySelectorAll('.field'))
      .filter(div => div.children.length === 5);
    if (rows[i]) {
      rows[i].click();
      return true;
    }
    return false;
  }, index);

  if (!clicked) return false;

  try {
    // Wait until ANY candidate selector is present AND visible. Resolves as soon
    // as the detail content appears, so a matched modal no longer waits 10s.
    await page.waitForFunction(
      sels => sels.some(sel => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden'
          && style.display !== 'none'
          && rect.width > 0
          && rect.height > 0;
      }),
      MODAL_SELECTORS,
      { timeout: MODAL_TIMEOUT_MS }
    );
    return true;
  } catch (err) {
    await reportModalFailure(page, index, err);
    throw err;
  }
}

/**
 * On modal-detection failure, log actionable diagnostics and persist a
 * screenshot + DOM dump for offline inspection.
 */
async function reportModalFailure(page, index, err) {
  // Per-selector presence/visibility, plus the row's visible text.
  let diag = [];
  let rowText = '(unavailable)';
  try {
    diag = await page.evaluate(sels => sels.map(sel => {
      const el = document.querySelector(sel);
      if (!el) return { sel, present: false, visible: false };
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visible = style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0;
      return { sel, present: true, visible };
    }), MODAL_SELECTORS);
  } catch { /* page may be mid-navigation */ }

  try {
    rowText = await page.evaluate(i => {
      const rows = Array.from(document.querySelectorAll('.field'))
        .filter(div => div.children.length === 5);
      const row = rows[i];
      if (!row) return '(row not found)';
      return (row.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    }, index);
  } catch { /* ignore */ }

  logger.warn('Modal detection failed', {
    provider: 'CAL',
    row: index + 1,
    rowText,
    selectorsTried: MODAL_SELECTORS,
    selectorStatus: diag,
    error: err.message,
  });

  const dumpBase = await dumpDebugArtifacts(page, index).catch(() => null);
  if (dumpBase) {
    logger.warn(`Saved modal-failure debug artifacts to ${DEBUG_DIR}/${dumpBase}.{png,html}`, {
      provider: 'CAL',
    });
  }
}

/** Write a full-page screenshot + HTML dump to logs/debug/. Returns the base filename. */
async function dumpDebugArtifacts(page, index) {
  await mkdir(DEBUG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `modal-fail_row${index + 1}_${ts}`;

  await page.screenshot({ path: join(DEBUG_DIR, `${base}.png`), fullPage: true }).catch(() => {});

  const html = await page.content().catch(() => null);
  if (html !== null) {
    await writeFile(join(DEBUG_DIR, `${base}.html`), html, 'utf-8').catch(() => {});
  }
  return base;
}

export async function extractModalData(page) {
  const raw = await page.evaluate(({ selectors, markers }) => {
    // Resolve the modal root using the same candidate list as detection.
    let modal = null;
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { modal = el; break; }
    }
    if (!modal) return null;

    const raw = {
      transactionDate: '',
      cardName: '',
      businessName: '',
      expenseType: '',
      amount: 0,
      amountRaw: '',
      transactionType: '',
      chargeDate: '',
      chargeAmount: 0,
      chargeAmountRaw: '',
    };

    const parseDate = str => {
      const m = str.match(/(\d{2})\/(\d{2})\/(\d{2})/);
      return m ? `20${m[3]}-${m[2]}-${m[1]}` : '';
    };

    // The matched root may BE the details table, contain it, or the table may
    // sit elsewhere in the overlay — handle all three.
    const table =
      (modal.matches && modal.matches('table.details-table') ? modal : null) ||
      modal.querySelector('table.details-table') ||
      document.querySelector('table.details-table');

    if (table) {
      table.querySelectorAll('tr').forEach(row => {
        const key = row.querySelector('.table-key')?.textContent?.trim();
        const val = row.querySelector('.table-value')?.textContent?.trim();

        if (!key || !val) return;

        switch (key) {
          case 'שם בית עסק':   raw.businessName    = val; break;
          case 'תאריך ושעה':   raw.transactionDate = parseDate(val); break;
          // Store the raw amount strings only; numeric parsing happens in Node
          // via the shared parseAmount() helper (handles currency codes too).
          case 'סכום העסקה':   raw.amountRaw       = val; break;
          case 'סוג העסקה':    raw.transactionType = val; break;
          case 'מועד החיוב':   raw.chargeDate      = parseDate(val); break;
          case 'סכום החיוב':   raw.chargeAmountRaw = val; break;
          case 'ענף בית העסק': raw.expenseType     = val; break;
        }
      });
    }

    const cardDesc =
      modal.querySelector('.card-description') ||
      document.querySelector('.card-description');
    if (cardDesc) raw.cardName = cardDesc.textContent.trim();

    // ── Pending / unfinalized detection ─────────────────────────────────────
    // Read status text from the preferred sections; fall back to the whole
    // panel if those sections are absent. Does NOT rely on card/amount/merchant.
    // (CAL's class is spelled `descrition`, not `description`.)
    const pendingEls = [
      modal.querySelector('.info-section .descrition'),
      modal.querySelector('.info-section'),
      modal.querySelector('.payee-name'),
    ].filter(Boolean);

    let pendingText = pendingEls.map(el => el.textContent || '').join(' ');
    if (!pendingText.trim()) pendingText = modal.textContent || '';

    const matchedMarker = markers.find(marker => pendingText.includes(marker)) || '';
    if (matchedMarker) {
      // Set only when pending so finalized (exported) transactions keep their
      // existing raw shape unchanged.
      raw.pending = true;
      raw.pendingMarker = matchedMarker;
    }

    return raw;
  }, { selectors: MODAL_SELECTORS, markers: PENDING_MARKERS });

  if (!raw) return null;

  // Parse numeric amounts from the captured strings using the shared helper.
  // Done here (not in the browser) so a single, unit-tested parser is the only
  // source of truth. raw.amountRaw / raw.chargeAmountRaw are left untouched.
  raw.amount       = parseAmount(raw.amountRaw);
  raw.chargeAmount = parseAmount(raw.chargeAmountRaw);

  return raw;
}

export async function closeModal(page) {
  await page.keyboard.press('Escape');
  // Wait for the detail window to disappear rather than a fixed timeout.
  // Considered closed once none of the candidate selectors remain visible.
  await page.waitForFunction(
    sels => !sels.some(sel => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0;
    }),
    MODAL_SELECTORS,
    { timeout: 5000 }
  ).catch(() => {});
}
