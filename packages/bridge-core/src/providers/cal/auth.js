/**
 * CAL login flow.
 *
 * CAL uses an Angular Material form inside a cross-origin iframe hosted at
 * connect.cal-online.co.il. We drive the flow off stable signals where possible:
 *   - the iframe is detected by its URL host (not by text), and
 *   - the form fields use the stable Angular Material ids #regular-login /
 *     #mat-input-2 / #mat-input-3, and submit via button[type="submit"].
 * The only text locators are the Hebrew homepage CTA ("כניסה לחשבון") and the
 * authenticated nav item ("עסקאות וחיובים") used as a page-state check. Those are
 * the genuine UI strings; they are kept as-is and are NOT surfaced in error
 * messages (so a Windows console can never mojibake them).
 *
 * IMPORTANT: a fresh login must run on a CLEAN, logged-out context. The caller
 * clears cookies/storage before invoking login() when a restored session was
 * found to be expired — otherwise stale cookies keep the homepage in a
 * half-authenticated view and the login CTA never appears.
 *
 * 2FA note: if the account has two-factor auth enabled, this flow will time out
 * at the "verify login" phase waiting for the post-login nav that never appears.
 */

import { mkdir } from 'fs/promises';
import { join } from 'path';
import { logger } from '../../infrastructure/logger.js';

/** The login form lives in this cross-origin iframe; detected by URL (stable). */
export const LOGIN_FRAME_HOST = 'connect.cal-online.co.il';
/** Homepage CTA that opens the login iframe (logged-out state only). */
export const LOGIN_CTA_TEXT = 'כניסה לחשבון';
/** Authenticated nav item — only rendered once logged in (page-state check). */
export const AUTH_NAV_TEXT = 'עסקאות וחיובים';

/**
 * Error raised when a specific login phase fails. The message names the phase and
 * whether it timed out — never page content, credentials, cookies, tokens, or the
 * raw (possibly Hebrew) locator that triggered it.
 */
export class CalLoginError extends Error {
  constructor(phase, { timedOut = false, detail = '' } = {}) {
    super(
      `CAL login failed during "${phase}"${timedOut ? ' (timed out)' : ''}.` +
      // `detail` is only ever a safe, content-free string (e.g. a debug artifact
      // file path) — never page content, credentials, cookies, or a raw locator.
      (detail ? ` ${detail}` : '')
    );
    this.name = 'CalLoginError';
    this.phase = phase;
    this.timedOut = timedOut;
  }
}

function isTimeout(err) {
  return /timeout|timed out/i.test(err?.message ?? '');
}

/** Run a login phase, normalizing any failure into a content-free CalLoginError. */
async function phase(name, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CalLoginError) throw err;
    throw new CalLoginError(name, { timedOut: isTimeout(err) });
  }
}

/** Find the CAL login iframe by URL host (stable signal), or null if not present. */
function findLoginFrame(page) {
  return page.frames().find(f => (f.url() || '').includes(LOGIN_FRAME_HOST)) || null;
}

/** Poll for the login iframe by URL until it appears or the timeout elapses. */
async function waitForLoginFrame(page, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let frame = findLoginFrame(page);
  while (!frame && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    frame = findLoginFrame(page);
  }
  return frame; // may be null
}

/** Directory for failure diagnostics; redirected under userData in packaged builds. */
function debugDir() {
  return process.env.DEBUG_DIR || 'runtime/debug';
}

/**
 * Bring the browser window to the front. CAL only opens its login iframe when a
 * real, visible window is active, so we foreground the page before the form step.
 * bringToFront() exists on every real Playwright page; guarded so test fakes
 * without it (and any failure) are harmless no-ops.
 */
async function bringToFront(page) {
  if (typeof page.bringToFront === 'function') {
    await page.bringToFront().catch(() => {});
  }
}

/**
 * A single attempt to reach the login iframe. Prefer the stable iframe URL signal:
 * if the iframe is already present, use it directly; otherwise click the homepage
 * CTA (clean logged-out state) and wait for the iframe by URL.
 */
async function tryOpenLoginForm(page) {
  let frame = findLoginFrame(page);
  if (!frame) {
    await page.waitForSelector(`text=${LOGIN_CTA_TEXT}`, { timeout: 15000 });
    await page.click(`text=${LOGIN_CTA_TEXT}`);
    frame = await waitForLoginFrame(page, 15000);
  }
  if (!frame) throw new CalLoginError('open login form', { timedOut: true });
  return frame;
}

/**
 * Save content-free diagnostics for a failed "open login form" step under
 * runtime/debug/: a full-page screenshot, plus the current URL and page title
 * (logged, not embedded in the thrown error). Returns the artifact details or
 * null if nothing could be captured. Never throws.
 */
async function dumpLoginFormDebug(page) {
  try {
    if (typeof page.screenshot !== 'function') return null;
    const dir = debugDir();
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = join(dir, `cal-open-login-fail_${ts}.png`);

    let url = '(unavailable)';
    let title = '(unavailable)';
    try { url = (typeof page.url === 'function' ? page.url() : '') || '(unavailable)'; } catch { /* ignore */ }
    try { title = (typeof page.title === 'function' ? await page.title() : '') || '(unavailable)'; } catch { /* ignore */ }

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    return { screenshotPath, url, title };
  } catch {
    return null;
  }
}

/**
 * Reach the login form, retrying ONLY the form-opening step exactly once before
 * failing. The retry never re-runs credential entry, submit, or the transaction
 * fetch. On final failure it persists diagnostics (screenshot + URL + title) and
 * raises a content-free CalLoginError naming the debug artifact path.
 */
async function openLoginForm(page) {
  await bringToFront(page);
  try {
    return await tryOpenLoginForm(page);
  } catch (firstErr) {
    logger.warn('CAL "open login form" failed — retrying once', {
      provider: 'CAL',
      timedOut: firstErr instanceof CalLoginError ? firstErr.timedOut : isTimeout(firstErr),
    });
    await bringToFront(page);
    try {
      return await tryOpenLoginForm(page);
    } catch (secondErr) {
      const timedOut = secondErr instanceof CalLoginError ? secondErr.timedOut : isTimeout(secondErr);
      const artifact = await dumpLoginFormDebug(page);
      if (artifact) {
        logger.warn(`Saved CAL login-form debug artifacts to ${artifact.screenshotPath}`, {
          provider: 'CAL',
          url:   artifact.url,
          title: artifact.title,
        });
      }
      throw new CalLoginError('open login form', {
        timedOut,
        detail: artifact ? `Debug artifacts: ${artifact.screenshotPath}` : '',
      });
    }
  }
}

export async function login(page, username, password) {
  // Phase 1 — reach the login form (with one safe retry of just this step).
  const loginFrame = await openLoginForm(page);

  // Phase 2 — select the regular (username/password) login tab (stable id).
  await phase('select regular login', async () => {
    await loginFrame.waitForSelector('#regular-login', { timeout: 15000 });
    await loginFrame.click('#regular-login');
  });

  // Phase 3 — fill credentials (stable Angular Material input ids; click to focus
  // before fill, which Material inputs require).
  await phase('enter credentials', async () => {
    await loginFrame.waitForSelector('#mat-input-2', { timeout: 20000 });
    await loginFrame.click('#mat-input-2');
    await loginFrame.fill('#mat-input-2', username);
    await loginFrame.click('#mat-input-3');
    await loginFrame.fill('#mat-input-3', password);
  });

  // Phase 4 — submit.
  await phase('submit', async () => {
    await loginFrame.click('button[type="submit"]');
  });

  // Phase 5 — verify via the authenticated nav element (page-state check).
  await phase('verify login', async () => {
    await page.waitForSelector(`text=${AUTH_NAV_TEXT}`, { timeout: 20000 });
  });
}
