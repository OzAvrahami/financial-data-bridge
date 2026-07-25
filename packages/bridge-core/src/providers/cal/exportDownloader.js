/**
 * Download the CAL transactions export file ("ייצוא") via Playwright.
 *
 * Discovery is layered and defensive because CAL's toolbar markup is not stable:
 *   1. Fast, robust Playwright locator strategies (role / text / aria / xpath).
 *   2. If those miss, a DOM sweep tags every clickable candidate and a pure
 *      ranking function (pickExportCandidate) chooses the best export control —
 *      never the Print control.
 *   3. If still not found, rich discovery artifacts (screenshot, reduced HTML,
 *      candidate JSON) are saved and their paths are put in the thrown error so the
 *      real DOM can be inspected.
 *
 * Parsing lives in exportParser.js; this module only locates + fetches the bytes.
 */

import { mkdir, stat, readFile, writeFile } from 'fs/promises';
import { join, extname } from 'path';
import { logger } from '../../infrastructure/logger.js';

// Matches an Export control's visible text / accessible name / class. Note CAL's
// real button shows "יצוא" (one yod) as visible text but "ייצוא לאקסל" as its
// aria-label, so both spellings AND "אקסל" (Excel) must match.
export const EXPORT_RE = /ייצוא|יצוא|אקסל|export|excel|csv|xls/i;
/** Matches a Print control — must never be chosen in place of Export. */
export const PRINT_RE = /הדפסה|print/i;
/** Hebrew-export text specifically (highest-confidence signal). */
const HE_EXPORT_RE = /ייצוא|יצוא|אקסל/;

/** textContent keywords the discovery dump reports on. */
const DISCOVERY_KEYWORDS = ['ייצוא', 'יצוא', 'Excel', 'CSV', 'XLS', 'xls', 'export', 'download', 'הורדה', 'הדפסה'];

/** Where downloads are saved (overridable). Defaults under the debug dir. */
export function exportDownloadDir() {
  if (process.env.CAL_DOWNLOAD_DIR) return process.env.CAL_DOWNLOAD_DIR;
  const base = process.env.DEBUG_DIR || 'runtime/debug';
  return join(base, 'downloads');
}

/** Where export-discovery diagnostics are saved. */
function discoveryDir() {
  const base = process.env.DEBUG_DIR || 'runtime/debug';
  return join(base, 'cal-export-discovery');
}

/**
 * Pure ranking of candidate clickable elements → the index of the best Export
 * control, or -1. Excludes the Print control, prefers explicit Hebrew "ייצוא"
 * text, then export/excel/xls/csv, then accessible name/title, then real
 * button/anchor tags. Exported for unit testing without a browser.
 *
 * @param {Array<{index:number,tagName?:string,innerText?:string,textContent?:string,ariaLabel?:string,title?:string,role?:string,className?:string,visible?:boolean,disabled?:boolean}>} candidates
 * @returns {number} candidate.index of the best match, or -1
 */
export function pickExportCandidate(candidates = []) {
  let best = -1;
  let bestScore = 0;
  for (const c of candidates) {
    if (c.visible === false || c.disabled) continue;
    const own  = `${c.innerText || ''} ${c.textContent || ''} ${c.ariaLabel || ''} ${c.title || ''}`;
    const meta = `${own} ${c.className || ''}`;
    if (!EXPORT_RE.test(meta)) continue;               // not export-related at all
    // A Print control whose own text/name says print and nothing export → skip.
    if (PRINT_RE.test(own) && !EXPORT_RE.test(own)) continue;

    let score = 1;
    if (HE_EXPORT_RE.test(own)) score += 6;            // explicit "ייצוא"
    if (/export|excel|csv|xls/i.test(own)) score += 3;
    if (EXPORT_RE.test(c.ariaLabel || '') || EXPORT_RE.test(c.title || '')) score += 2;
    const tag = (c.tagName || '').toUpperCase();
    if (tag === 'BUTTON' || tag === 'A') score += 2;
    if ((c.role || '') === 'button') score += 1;
    if (/excel|xls|export/i.test(c.className || '')) score += 1;
    if (PRINT_RE.test(own)) score -= 5;                // ambiguous (export+print) → de-prioritize

    if (score > bestScore) { bestScore = score; best = c.index; }
  }
  return best;
}

/**
 * Wait for the transactions view + top action toolbar before searching. Every wait
 * is best-effort (non-fatal) — discovery diagnostics handle the miss case.
 */
async function waitForToolbar(page) {
  // Rows / table present (not just networkidle).
  await page.waitForFunction(() => {
    const rows = Array.from(document.querySelectorAll('.field')).filter(d => d.children.length === 5);
    return rows.length > 0 || !!document.querySelector('table');
  }, { timeout: 15000 }).catch(() => {});
  // The action toolbar carrying Export/Print text becomes visible.
  await page.locator('text=/ייצוא|יצוא|הדפסה/i').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
}

/** Describe a resolved locator for the verify-before-click log. Never throws. */
async function describeLocator(locator) {
  try {
    return await locator.evaluate((el) => ({
      tagName: el.tagName,
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      ariaLabel: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      className: typeof el.className === 'string' ? el.className : '',
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
    }));
  } catch { return null; }
}

/**
 * Try the ordered Playwright locator strategies. Returns { locator, strategy, desc }
 * for the first VISIBLE, non-Print match, or null.
 */
async function findExportViaLocators(page) {
  // High-confidence, DOM-specific strategies first (from the real CAL markup:
  // <span class="export"><img><button aria-label="ייצוא לאקסל">יצוא</button></span>),
  // then progressively broader fallbacks. The <button> is always the click target.
  const strategies = [
    ['button[aria-label*=ייצוא]', () => page.locator('button[aria-label*="ייצוא"]')],
    ['button[aria-label*=יצוא]',  () => page.locator('button[aria-label*="יצוא"]')],
    ['button[aria-label*=אקסל]',  () => page.locator('button[aria-label*="אקסל"]')],
    ['span.export button',        () => page.locator('span.export button')],
    ['.export button',            () => page.locator('.export button')],
    ['button:has-text(יצוא)',     () => page.locator('button:has-text("יצוא")')],
    ['button:has-text(ייצוא)',    () => page.locator('button:has-text("ייצוא")')],
    ['role:button/name',          () => page.getByRole('button', { name: /ייצוא|יצוא|אקסל|excel|export|csv|xls/i })],
    ['role:link/name',            () => page.getByRole('link',   { name: EXPORT_RE })],
    ['a:has-text(יצוא)',          () => page.locator('a:has-text("יצוא"), a:has-text("ייצוא")')],
    ['[role=button]:has-text(יצוא)', () => page.locator('[role="button"]:has-text("יצוא"), [role="button"]:has-text("ייצוא")')],
    ['aria/title~export', () => page.locator(
      '[aria-label*="ייצוא"],[aria-label*="יצוא"],[aria-label*="אקסל"],[title*="ייצוא"],[title*="יצוא"],[title*="אקסל"],' +
      '[aria-label*="export" i],[aria-label*="excel" i],[aria-label*="xls" i],[aria-label*="csv" i],' +
      '[title*="export" i],[title*="excel" i]'
    )],
    ['text→clickable-ancestor', () => page.locator(
      ':text("יצוא"), :text("ייצוא")'
    ).locator('xpath=ancestor-or-self::*[self::button or self::a or @role="button"][1]')],
    ['class~excel/xls/export', () => page.locator(
      '[class*="excel" i],[class*="xls" i],[class*="export" i]'
    )],
  ];

  for (const [strategy, make] of strategies) {
    let loc;
    try { loc = make(); } catch { continue; }
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 5); i++) {
      const candidate = loc.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const desc = await describeLocator(candidate);
      const own = `${desc?.text || ''} ${desc?.ariaLabel || ''} ${desc?.title || ''}`;
      // Reject a Print-only element that slipped through a broad class selector.
      if (PRINT_RE.test(own) && !EXPORT_RE.test(own)) continue;
      return { locator: candidate, strategy, desc };
    }
  }
  return null;
}

/**
 * DOM sweep: tag every visible clickable candidate with data-cal-export-candidate,
 * and return descriptors + toolbar context for both ranking and diagnostics.
 */
async function collectCandidates(page) {
  return page.evaluate((keywords) => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
    };
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const sel = 'button, a, [role="button"], mat-icon, [class*="icon"], [onclick], input[type="button"], input[type="submit"]';
    const nodes = Array.from(document.querySelectorAll(sel));
    const clickables = [];
    let idx = 0;
    for (const el of nodes) {
      if (clickables.length >= 250) break;
      if (!vis(el)) continue;
      el.setAttribute('data-cal-export-candidate', String(idx));
      const r = el.getBoundingClientRect();
      clickables.push({
        index: idx,
        tagName: el.tagName,
        innerText: clean(el.innerText).slice(0, 120),
        textContent: clean(el.textContent).slice(0, 120),
        ariaLabel: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        role: el.getAttribute('role') || '',
        className: typeof el.className === 'string' ? el.className.slice(0, 160) : '',
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        visible: true,
        bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      });
      idx++;
    }

    // Elements whose textContent contains an export/print-related keyword.
    const keywordMatches = [];
    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      if (keywordMatches.length >= 60) break;
      const t = clean(el.textContent);
      if (!t || t.length > 60) continue; // skip large containers; want the leaf-ish label
      if (keywords.some((k) => t.includes(k))) {
        keywordMatches.push({
          tagName: el.tagName,
          text: t.slice(0, 80),
          ariaLabel: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
        });
      }
    }

    const toolbarEl = document.querySelector('[class*="toolbar" i], [class*="actions" i], [class*="table-header" i], [class*="grid-header" i]');
    const tableVisible = Array.from(document.querySelectorAll('.field')).some((d) => d.children.length === 5)
      || !!document.querySelector('table');

    return {
      url: location.href,
      title: document.title,
      tableVisible,
      toolbarText: toolbarEl ? clean(toolbarEl.textContent).slice(0, 400) : '',
      clickables,
      keywordMatches,
    };
  }, DISCOVERY_KEYWORDS);
}

/** Capture a reduced HTML snapshot (toolbar/table region, capped). */
async function reducedHtml(page) {
  return page.evaluate(() => {
    const pick = document.querySelector('[class*="toolbar" i], [class*="table" i], main, [role="main"]') || document.body;
    return (pick?.outerHTML || document.documentElement.outerHTML || '').slice(0, 300000);
  }).catch(() => null);
}

/** Save screenshot + reduced HTML + candidate JSON. Returns the saved paths. */
async function saveDiscoveryArtifacts(page, data, reason) {
  const dir = discoveryDir();
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `export-discovery_${ts}`;
  const paths = {
    json: join(dir, `${base}.json`),
    png:  join(dir, `${base}.png`),
    html: join(dir, `${base}.html`),
  };

  await writeFile(paths.json, JSON.stringify({ reason, ...data }, null, 2), 'utf-8').catch(() => {});
  await page.screenshot({ path: paths.png, fullPage: true }).catch(() => {});
  const html = await reducedHtml(page);
  if (html != null) await writeFile(paths.html, html, 'utf-8').catch(() => {});

  logger.warn('[cal-export] saved export-discovery artifacts', {
    provider: 'CAL',
    reason,
    json: paths.json, png: paths.png, html: paths.html,
    url: data.url, title: data.title,
    tableVisible: data.tableVisible,
    clickables: data.clickables?.length ?? 0,
    keywordMatches: data.keywordMatches?.length ?? 0,
  });
  return paths;
}

/**
 * Resolve the export control locator: locator strategies first, then a DOM-sweep +
 * ranking fallback. On success returns { locator, strategy, desc }. On failure it
 * ALWAYS saves discovery artifacts and throws an error whose message names the
 * artifact paths + a short DOM summary (never a bare "not found").
 */
async function resolveExportControl(page) {
  const viaLocator = await findExportViaLocators(page);
  if (viaLocator) return viaLocator;

  // Fallback: sweep + rank. This also tags candidates so we can click by index.
  const data = await collectCandidates(page).catch(() => null);
  if (data) {
    const idx = pickExportCandidate(data.clickables);
    if (idx >= 0) {
      const locator = page.locator(`[data-cal-export-candidate="${idx}"]`).first();
      const desc = data.clickables.find((c) => c.index === idx) || null;
      return { locator, strategy: 'dom-sweep+rank', desc };
    }
  }

  // Genuinely not found → persist diagnostics and throw with their paths.
  const paths = data
    ? await saveDiscoveryArtifacts(page, data, 'export-control-not-found')
    : { json: '(unavailable)', png: '(unavailable)', html: '(unavailable)' };
  const summary = data
    ? `buttons=${data.clickables.length} keywordMatches=${data.keywordMatches.length} tableVisible=${data.tableVisible}`
    : 'no DOM snapshot';
  const err = new Error(
    `CAL export control ("ייצוא") not found. ${summary}. ` +
    `Discovery saved: ${paths.json} | ${paths.png} | ${paths.html}`
  );
  err.discovery = paths;
  throw err;
}

/**
 * Trigger and save the CAL export download.
 *
 * @param {import('playwright').Page} page  a page on the (filtered) transactions view
 * @param {{ downloadDir?: string, timeout?: number }} [opts]
 * @returns {Promise<{ path, suggestedFilename, extension, size, buffer }>}
 */
export async function downloadCalExport(page, opts = {}) {
  const downloadDir = opts.downloadDir ?? exportDownloadDir();
  const timeout = opts.timeout ?? 30000;
  await mkdir(downloadDir, { recursive: true });

  await waitForToolbar(page);

  // Optional proactive discovery dump for debugging even when a control IS found.
  if (process.env.CAL_EXPORT_DISCOVERY === 'true') {
    const data = await collectCandidates(page).catch(() => null);
    if (data) await saveDiscoveryArtifacts(page, data, 'proactive');
  }

  const control = await resolveExportControl(page); // throws (with artifacts) if truly absent

  // Verify-before-click diagnostics.
  const bbox = await control.locator.boundingBox().catch(() => null);
  const enabled = await control.locator.isEnabled().catch(() => null);
  logger.info('[cal-export] export control located', {
    provider: 'CAL',
    strategy: control.strategy,
    tagName: control.desc?.tagName,
    text: control.desc?.text ?? control.desc?.innerText,
    ariaLabel: control.desc?.ariaLabel,
    title: control.desc?.title,
    bbox, enabled,
  });

  // Arm the download listener BEFORE clicking so a fast download is never missed.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout }),
    control.locator.click({ timeout: 10000 }),
  ]);

  const suggestedFilename = download.suggestedFilename() || `cal-export-${Date.now()}`;
  const safeName = suggestedFilename.replace(/[^\w.\-]+/g, '_');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(downloadDir, `${ts}_${safeName}`);
  await download.saveAs(path);

  const { size } = await stat(path);
  const extension = extname(suggestedFilename).toLowerCase();
  const buffer = await readFile(path);

  logger.info('[cal-export] downloaded export file', {
    provider: 'CAL', path, suggestedFilename, extension, size, strategy: control.strategy,
  });

  return { path, suggestedFilename, extension, size, buffer };
}
