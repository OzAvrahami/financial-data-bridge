/**
 * Unit tests for the CAL login flow (no real browser).
 *
 * A configurable fake page/frame drives the login() state machine, verifying:
 *   - it detects the login iframe by URL and skips the homepage CTA when the
 *     iframe is already present (stable page-state preference);
 *   - it clicks the CTA + uses the stable form selectors when starting clean;
 *   - timeouts produce a phase-labeled CalLoginError that leaks no page content,
 *     credentials, or the raw (Hebrew) locator.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  login,
  CalLoginError,
  LOGIN_FRAME_HOST,
  LOGIN_CTA_TEXT,
  AUTH_NAV_TEXT,
} from '../../../../packages/bridge-core/src/providers/cal/auth.js';

const FORM_SELECTORS = new Set(['#regular-login', '#mat-input-2', '#mat-input-3', 'button[type="submit"]']);

function makeFrame(url = `https://${LOGIN_FRAME_HOST}/login`) {
  const calls = { clicks: [], fills: [] };
  return {
    calls,
    url: () => url,
    async waitForSelector(sel) {
      if (!FORM_SELECTORS.has(sel)) throw new Error('Timeout 15000ms exceeded');
      return {};
    },
    async click(sel) { calls.clicks.push(sel); },
    async fill(sel, val) { calls.fills.push([sel, val]); },
  };
}

/**
 * @param {object} o
 * @param {object[]} o.initialFrames
 * @param {(sel:string)=>boolean} o.pageHas  - which page-level selectors resolve
 * @param {()=>object[]} [o.onCtaClick]      - frames to expose after the CTA click
 */
function makePage({ initialFrames = [], pageHas = () => true, onCtaClick } = {}) {
  const calls = { waits: [], clicks: [] };
  let frames = initialFrames;
  return {
    calls,
    frames: () => frames,
    async waitForSelector(sel) {
      calls.waits.push(sel);
      if (!pageHas(sel)) throw new Error('Timeout 20000ms exceeded');
      return {};
    },
    async click(sel) {
      calls.clicks.push(sel);
      if (onCtaClick) frames = onCtaClick();
    },
  };
}

describe('CAL login — clean start via homepage CTA', () => {
  it('clicks the CTA, fills the stable form fields, and verifies via page state', async () => {
    const frame = makeFrame();
    const page = makePage({
      initialFrames: [],               // iframe not present yet
      pageHas: () => true,             // CTA + auth nav both resolve
      onCtaClick: () => [frame],       // CTA click reveals the login iframe
    });

    await login(page, 'SECRET_USER', 'SECRET_PASS');

    assert.ok(page.calls.clicks.includes(`text=${LOGIN_CTA_TEXT}`), 'CTA clicked to open the form');
    assert.deepEqual(frame.calls.clicks, ['#regular-login', '#mat-input-2', '#mat-input-3', 'button[type="submit"]']);
    assert.deepEqual(frame.calls.fills, [['#mat-input-2', 'SECRET_USER'], ['#mat-input-3', 'SECRET_PASS']]);
    // verified by the authenticated nav (page-state), not by guessing.
    assert.ok(page.calls.waits.includes(`text=${AUTH_NAV_TEXT}`), 'verifies via authenticated nav');
  });
});

describe('CAL login — reuses an already-open iframe (page-state preference)', () => {
  it('does not wait for or click the CTA when the login iframe is already present', async () => {
    const frame = makeFrame();
    const page = makePage({ initialFrames: [frame], pageHas: () => true });

    await login(page, 'u', 'p');

    assert.ok(!page.calls.waits.includes(`text=${LOGIN_CTA_TEXT}`), 'CTA wait skipped');
    assert.ok(!page.calls.clicks.includes(`text=${LOGIN_CTA_TEXT}`), 'CTA click skipped');
    assert.deepEqual(frame.calls.fills, [['#mat-input-2', 'u'], ['#mat-input-3', 'p']]);
  });
});

describe('CAL login — phase-labeled, content-free errors', () => {
  it('throws CalLoginError naming the verify phase, with no Hebrew/credentials leaked', async () => {
    const frame = makeFrame();
    // Everything resolves except the post-login nav → verify phase times out.
    const page = makePage({
      initialFrames: [frame],
      pageHas: (sel) => sel !== `text=${AUTH_NAV_TEXT}`,
    });

    await assert.rejects(
      () => login(page, 'SECRET_USER', 'SECRET_PASS'),
      (err) => {
        assert.ok(err instanceof CalLoginError, 'is a CalLoginError');
        assert.equal(err.phase, 'verify login');
        assert.equal(err.timedOut, true);
        assert.match(err.message, /verify login/);
        assert.ok(!/[֐-׿]/.test(err.message), 'no Hebrew locator text in the message');
        assert.ok(!/SECRET_USER|SECRET_PASS/.test(err.message), 'no credentials in the message');
        return true;
      }
    );
  });

  it('throws CalLoginError for the open-login-form phase when the CTA never appears', async () => {
    const page = makePage({ initialFrames: [], pageHas: () => false }); // CTA never resolves

    await assert.rejects(
      () => login(page, 'u', 'p'),
      (err) => {
        assert.ok(err instanceof CalLoginError);
        assert.equal(err.phase, 'open login form');
        assert.ok(!/[֐-׿]/.test(err.message), 'no Hebrew in the message');
        return true;
      }
    );
  });
});
