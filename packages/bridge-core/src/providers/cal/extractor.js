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
 * Container selectors that reliably indicate an OPEN transaction-detail dialog.
 *
 * A real run proved that BOTH pending and finalized rows expose one of these when
 * their detail window is open (a pending row's failure diagnostic showed
 * `[role="dialog"]` and `.modal-dialog` present AND visible). These are used for
 * the open/close waits — the deterministic "is the dialog on screen?" signal.
 *
 * Detection uses a Playwright LOCATOR (`.waitFor({ state })`), not an in-page
 * `waitForFunction`: the old polling predicate ran inside CAL's own JS context,
 * so once CAL's main thread jammed (after a dozen slow rows) the poll was starved
 * and timed out at 10s even though the modal was visible. Locator waits are driven
 * by Playwright and are immune to that starvation.
 */
const DIALOG_SELECTORS = [
  '[role="dialog"]',
  '.modal-dialog',
  'mat-dialog-container',
  '.cdk-dialog-container',
  '.transaction-details',
];
const DIALOG_SELECTOR = DIALOG_SELECTORS.join(', ');

/**
 * Broader selector set used ONLY to resolve the modal root during extraction
 * (content may live in a details table that sits outside the dialog container).
 * Extraction prefers a VISIBLE match so a persistent, hidden table from a prior
 * row can never be read as stale data.
 */
const MODAL_SELECTORS = [
  ...DIALOG_SELECTORS,
  '.cdk-overlay-pane',
  'table.details-table',
  '.details-table',
];

/** Selectors for an in-dialog close control / overlay backdrop (close fallback). */
const CLOSE_CONTROL_SELECTOR = [
  '[role="dialog"] [aria-label*="close" i]',
  '[role="dialog"] .close',
  '.modal-dialog [aria-label*="close" i]',
  '.modal-dialog .close',
  'button.close',
].join(', ');
const BACKDROP_SELECTOR = '.cdk-overlay-backdrop, .modal-backdrop';

// Short, safe, env-overridable timeouts. Defaults chosen so a healthy modal
// resolves fast and a genuinely stuck one fails quickly instead of hanging.
const MODAL_OPEN_TIMEOUT_MS  = Number(process.env.CAL_MODAL_OPEN_TIMEOUT_MS)  || 6000;
// Per-close-ATTEMPT confirmation window. A real run showed CAL ignores Escape, so
// the old single 1200ms wait was burned on every row before the fallback closed
// it. Each close action (Escape → close button → backdrop) now gets its own short
// confirmation and we return the instant the exact modal is gone.
const MODAL_CONFIRM_MS = Number(process.env.CAL_MODAL_CONFIRM_MS) || 350;

/** Failure diagnostics dir; redirected under userData in packaged builds. */
function debugDir() {
  return process.env.DEBUG_DIR || 'runtime/debug';
}

/** Heavy artifacts (full-page screenshot + HTML dump) are OFF unless opted in. */
function artifactsEnabled() {
  return process.env.CAL_MODAL_DEBUG_ARTIFACTS === 'true';
}

/**
 * Hebrew markers CAL shows on a transaction that is not finalized yet (the
 * amount may still change while CAL ingests it over a few days). Such rows must
 * NOT be exported — they would later change and produce duplicate/stale data.
 *
 * NOTE: CAL spells the class `descrition` (their typo), not `description`.
 * These markers are read from `.info-section`, `.info-section .descrition` and
 * `.payee-name`, falling back to the full panel text.
 */
export const PENDING_MARKERS = [
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
 * Click row `index` and wait for its detail dialog to become visible.
 *
 * @returns {Promise<{ opened: boolean, modal: import('playwright').ElementHandle|null }>}
 *   `opened` is false (non-retryable) only when the row itself is not found. On
 *   success `modal` is an element handle to the EXACT dialog that opened, so
 *   closeModal can confirm that specific element hides/detaches (immune to a
 *   broad selector locking onto a persistent, always-visible container).
 *
 * Throws (fast, at MODAL_OPEN_TIMEOUT_MS) when the dialog never appears; on that
 * failure it first logs lightweight, always-on diagnostics (row text, per-selector
 * status, URL, stage, error). Heavy screenshot/HTML artifacts are written only
 * when CAL_MODAL_DEBUG_ARTIFACTS=true.
 *
 * @param {import('playwright').Page} page
 * @param {number} index
 * @param {{ timeout?: number }} [options]
 */
export async function openTransactionModal(page, index, options = {}) {
  const timeout = options.timeout ?? MODAL_OPEN_TIMEOUT_MS;

  const clicked = await page.evaluate(i => {
    const rows = Array.from(document.querySelectorAll('.field'))
      .filter(div => div.children.length === 5);
    if (rows[i]) {
      rows[i].click();
      return true;
    }
    return false;
  }, index);

  if (!clicked) return { opened: false, modal: null };

  const dialog = page.locator(DIALOG_SELECTOR).first();
  try {
    // Deterministic, starvation-proof: wait (via Playwright, not in-page polling)
    // for the dialog container to be visible.
    await dialog.waitFor({ state: 'visible', timeout });
    // Capture the exact element that opened so the close confirmation targets it
    // specifically (not a re-resolved `.first()` that could point elsewhere).
    let modal = null;
    try { modal = await dialog.elementHandle(); } catch { modal = null; }
    return { opened: true, modal };
  } catch (err) {
    await reportModalFailure(page, index, err);
    throw err;
  }
}

/**
 * On modal-detection failure, log actionable, ALWAYS-ON diagnostics (row index,
 * row text, per-selector present/visible status, current URL, stage, error).
 * Heavy artifacts (full-page screenshot + HTML dump — the ~21s-per-failure cost
 * seen in the field) are written only when explicitly opted in.
 */
async function reportModalFailure(page, index, err) {
  let diag = [];
  let rowText = '(unavailable)';
  let url = '(unavailable)';

  try { url = page.url(); } catch { /* ignore */ }

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
    stage: 'openModal',
    rowText,
    url,
    selectorsTried: MODAL_SELECTORS,
    selectorStatus: diag,
    error: err.message,
  });

  if (artifactsEnabled()) {
    const dumpBase = await dumpDebugArtifacts(page, index).catch(() => null);
    if (dumpBase) {
      logger.warn(`Saved modal-failure debug artifacts to ${debugDir()}/${dumpBase}.{png,html}`, {
        provider: 'CAL',
      });
    }
  }
}

/**
 * Write a full-page screenshot + HTML dump for offline inspection. Opt-in only
 * (CAL_MODAL_DEBUG_ARTIFACTS=true) because a full-page screenshot of CAL's long
 * transaction list can take ~20s. Returns the base filename.
 */
async function dumpDebugArtifacts(page, index) {
  const dir = debugDir();
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `modal-fail_row${index + 1}_${ts}`;

  await page.screenshot({ path: join(dir, `${base}.png`), fullPage: true }).catch(() => {});

  const html = await page.content().catch(() => null);
  if (html !== null) {
    await writeFile(join(dir, `${base}.html`), html, 'utf-8').catch(() => {});
  }
  return base;
}

export async function extractModalData(page) {
  const raw = await page.evaluate(({ selectors, markers }) => {
    const isVisible = el => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0;
    };

    // Resolve the modal root to the first VISIBLE candidate. Preferring a visible
    // element means a persistent-but-hidden detail node left over from a previous
    // row can never be read as stale data.
    let modal = null;
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) { modal = el; break; }
      }
      if (modal) break;
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

    // Find the first VISIBLE match for a selector anywhere in the document.
    const firstVisible = sel => {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) return el;
      }
      return null;
    };

    // The matched root may BE the details table, contain it, or the table may
    // sit elsewhere in the overlay — handle all three. The document-level fallback
    // prefers a VISIBLE table so a hidden stale one is never read.
    const table =
      (modal.matches && modal.matches('table.details-table') ? modal : null) ||
      modal.querySelector('table.details-table') ||
      firstVisible('table.details-table');

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
      firstVisible('.card-description');
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

/**
 * Close the open detail dialog fast and deterministically, confirming against the
 * EXACT dialog element that opened (when provided).
 *
 * A real run proved CAL ignores Escape, so a single Escape-then-wait burned the
 * whole confirmation timeout on every row before a fallback actually closed it.
 * This tries the close actions in order and, after EACH, waits only a short window
 * (MODAL_CONFIRM_MS) for the exact modal to hide/detach — returning the instant it
 * is gone. A close action whose control is not present is skipped without spending
 * its confirmation window.
 *
 * Order: Escape (cheap, no misclick risk) → in-dialog close button → overlay
 * backdrop. `state: 'hidden'` / `waitForElementState('hidden')` both resolve on
 * detach OR hide, and never wait on a persistent details-table element.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').ElementHandle|null} [modal]  exact opened dialog
 * @param {{ confirmMs?: number }} [options]
 * @returns {Promise<{ closed: boolean, method: 'escape'|'closeButton'|'backdrop'|'none', ms: number }>}
 */
export async function closeModal(page, modal = null, options = {}) {
  const confirmMs = options.confirmMs ?? MODAL_CONFIRM_MS;
  const startedAt = Date.now();

  // Confirm the EXACT modal is gone when we have its handle; otherwise fall back
  // to the dialog selector. Both resolve on hide OR detach.
  const confirmHidden = async () => {
    if (modal && typeof modal.waitForElementState === 'function') {
      await modal.waitForElementState('hidden', { timeout: confirmMs });
    } else {
      await page.locator(DIALOG_SELECTOR).first().waitFor({ state: 'hidden', timeout: confirmMs });
    }
  };

  // Each attempt returns true if its close action was actually issued (so we then
  // wait for confirmation) or false if its control is absent (skip the wait).
  const attempts = [
    { method: 'escape', act: async () => { await page.keyboard.press('Escape').catch(() => {}); return true; } },
    { method: 'closeButton', act: async () => {
        const btn = page.locator(CLOSE_CONTROL_SELECTOR).first();
        if (!(await btn.count().catch(() => 0))) return false;
        await btn.click({ timeout: 400 }).catch(() => {});
        return true;
      } },
    { method: 'backdrop', act: async () => {
        const bd = page.locator(BACKDROP_SELECTOR).first();
        if (!(await bd.count().catch(() => 0))) return false;
        await bd.click({ timeout: 400 }).catch(() => {});
        return true;
      } },
  ];

  for (const attempt of attempts) {
    const issued = await attempt.act();
    if (!issued) continue;
    try {
      await confirmHidden();
      return { closed: true, method: attempt.method, ms: Date.now() - startedAt };
    } catch { /* not closed by this action — try the next */ }
  }

  return { closed: false, method: 'none', ms: Date.now() - startedAt };
}
