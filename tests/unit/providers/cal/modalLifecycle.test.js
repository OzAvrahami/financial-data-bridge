import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  openTransactionModal,
  closeModal,
} from '../../../../packages/bridge-core/src/providers/cal/extractor.js';
import {
  CalProvider,
  CalSessionExpiredError,
} from '../../../../packages/bridge-core/src/providers/cal/index.js';

/**
 * Minimal fake Playwright page covering just the surface the modal lifecycle uses:
 * evaluate (row click), locator().first().{waitFor,count,click,elementHandle},
 * keyboard.press, url, screenshot, content. Behavior is injected per test.
 *
 * `openWaitFor` / `hiddenWaitFor` are invoked for visible/hidden locator waits
 * respectively; throw/reject to simulate "never became visible" / "still open".
 */
function makeFakePage({
  clickResult = true,
  openWaitFor,
  hiddenWaitFor,
  closeBtnCount = 0,
  backdropCount = 0,
  url = 'https://www.cal-online.co.il/some/page',
  modalHandle = null,
} = {}) {
  const calls = { escape: 0, screenshot: 0, closeBtnClick: 0, backdropClick: 0 };
  const page = {
    async evaluate() { return clickResult; },
    url: () => url,
    keyboard: { press: async () => { calls.escape++; } },
    async screenshot() { calls.screenshot++; },
    // Return null so dumpDebugArtifacts writes no HTML file during tests (the
    // screenshot spy above already prevents a PNG write).
    async content() { return null; },
    locator(sel) {
      const handle = {
        first() { return handle; },
        async count() {
          if (sel.includes('close')) return closeBtnCount;
          if (sel.includes('backdrop')) return backdropCount;
          return 0;
        },
        async click() { sel.includes('close') ? calls.closeBtnClick++ : calls.backdropClick++; },
        async elementHandle() { return modalHandle; },
        async waitFor({ state } = {}) {
          if (state === 'hidden') { if (hiddenWaitFor) return hiddenWaitFor(); return; }
          if (openWaitFor) return openWaitFor();
        },
      };
      return handle;
    },
  };
  page._calls = calls;
  return page;
}

/** A fake element handle whose hidden-confirmation is controlled per test. */
function makeModalHandle(waitImpl) {
  const h = { calls: 0, disposed: 0 };
  h.waitForElementState = async ({ state } = {}) => {
    h.calls++;
    if (state === 'hidden' && waitImpl) return waitImpl();
  };
  h.dispose = async () => { h.disposed++; };
  return h;
}

describe('openTransactionModal (modal ready detection + exact root)', () => {
  it('returns opened=true and the exact modal handle when the dialog is visible', async () => {
    const modalHandle = makeModalHandle(() => {});
    const page = makeFakePage({ clickResult: true, openWaitFor: () => {}, modalHandle });
    const res = await openTransactionModal(page, 0);
    assert.equal(res.opened, true);
    assert.equal(res.modal, modalHandle, 'the exact opened element handle is returned for a precise close');
  });

  it('returns opened=false (non-retryable) when the row is not found', async () => {
    const page = makeFakePage({ clickResult: false });
    const res = await openTransactionModal(page, 99);
    assert.equal(res.opened, false);
    assert.equal(res.modal, null);
  });

  it('throws quickly when the dialog never appears', async () => {
    const page = makeFakePage({ openWaitFor: () => { throw new Error('Timeout 6000ms exceeded'); } });
    await assert.rejects(() => openTransactionModal(page, 0), /Timeout/);
  });
});

describe('reportModalFailure artifact policy', () => {
  afterEach(() => { delete process.env.CAL_MODAL_DEBUG_ARTIFACTS; });

  it('does NOT capture a screenshot by default', async () => {
    const page = makeFakePage({ openWaitFor: () => { throw new Error('Timeout'); } });
    await assert.rejects(() => openTransactionModal(page, 0));
    assert.equal(page._calls.screenshot, 0, 'screenshot must be off unless opted in');
  });

  it('captures a screenshot when CAL_MODAL_DEBUG_ARTIFACTS=true', async () => {
    process.env.CAL_MODAL_DEBUG_ARTIFACTS = 'true';
    const page = makeFakePage({ openWaitFor: () => { throw new Error('Timeout'); } });
    await assert.rejects(() => openTransactionModal(page, 0));
    assert.equal(page._calls.screenshot, 1);
  });
});

describe('closeModal (fast, deterministic, method-reporting)', () => {
  it('closes on the Escape fast path and reports method=escape', async () => {
    const page = makeFakePage({ hiddenWaitFor: () => {} });
    const res = await closeModal(page, null);
    assert.equal(res.closed, true);
    assert.equal(res.method, 'escape');
    assert.equal(page._calls.escape, 1);
    assert.equal(page._calls.closeBtnClick, 0, 'no fallback needed when Escape works');
  });

  it('falls back to the close button when Escape does not close it', async () => {
    let n = 0;
    const page = makeFakePage({
      closeBtnCount: 1,
      hiddenWaitFor: () => { if (n++ === 0) throw new Error('still open'); },
    });
    const res = await closeModal(page, null);
    assert.equal(res.closed, true);
    assert.equal(res.method, 'closeButton');
    assert.equal(page._calls.closeBtnClick, 1);
  });

  it('falls back to the backdrop when there is no close button', async () => {
    let n = 0;
    const page = makeFakePage({
      closeBtnCount: 0,
      backdropCount: 1,
      hiddenWaitFor: () => { if (n++ === 0) throw new Error('still open'); },
    });
    const res = await closeModal(page, null);
    assert.equal(res.closed, true);
    assert.equal(res.method, 'backdrop');
    assert.equal(page._calls.backdropClick, 1);
    assert.equal(page._calls.closeBtnClick, 0);
  });

  it('reports closed=false when no action confirms the dialog closed', async () => {
    const page = makeFakePage({ closeBtnCount: 0, backdropCount: 0, hiddenWaitFor: () => { throw new Error('still open'); } });
    const res = await closeModal(page, null);
    assert.equal(res.closed, false);
    assert.equal(res.method, 'none');
  });

  it('confirms against the EXACT modal handle when provided (not a broad selector)', async () => {
    const modalHandle = makeModalHandle(() => {}); // resolves hidden immediately
    // hiddenWaitFor throws so, if the code fell back to the selector path, it would fail.
    const page = makeFakePage({ hiddenWaitFor: () => { throw new Error('selector path must not be used'); } });
    const res = await closeModal(page, modalHandle);
    assert.equal(res.closed, true);
    assert.equal(res.method, 'escape');
    assert.ok(modalHandle.calls >= 1, 'the exact handle was used for close confirmation');
  });
});

describe('CalSessionExpiredError + isAuthError classification', () => {
  it('carries processed/total/lastRowIndex and a clear message', () => {
    const err = new CalSessionExpiredError(21, 300, 20);
    assert.equal(err.processedRows, 21);
    assert.equal(err.totalRows, 300);
    assert.equal(err.lastRowIndex, 20);
    assert.match(err.message, /session expired during row loop after 21\/300 rows/);
  });

  it('is NOT treated as a retryable auth error (no auto full-rescan)', async () => {
    const provider = new CalProvider({});
    provider.setPage(makeFakePage({ url: 'https://connect.cal-online.co.il/login' }));
    assert.equal(await provider.isAuthError(new CalSessionExpiredError(1, 2, 0)), false);
  });

  it('_sessionLost is true on a redirect to the login host', async () => {
    const provider = new CalProvider({});
    provider.setPage(makeFakePage({ url: 'https://connect.cal-online.co.il/login' }));
    assert.equal(await provider._sessionLost(), true);
  });

  it('_sessionLost is false while the authenticated nav is still present', async () => {
    const provider = new CalProvider({});
    const page = makeFakePage({ url: 'https://www.cal-online.co.il/dashboard' });
    page.locator = (sel) => ({
      first() { return this; },
      async count() { return sel.includes('עסקאות') ? 1 : 0; },
      async waitFor() {},
      async click() {},
    });
    provider.setPage(page);
    assert.equal(await provider._sessionLost(), false);
  });
});
