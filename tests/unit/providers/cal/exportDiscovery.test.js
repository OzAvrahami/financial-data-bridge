import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickExportCandidate,
  EXPORT_RE,
  PRINT_RE,
} from '../../../../packages/bridge-core/src/providers/cal/exportDownloader.js';

// Candidate descriptors mirror what collectCandidates() emits from the DOM sweep.
const cand = (index, over = {}) => ({
  index, tagName: 'BUTTON', innerText: '', textContent: '', ariaLabel: '', title: '',
  role: '', className: '', disabled: false, visible: true, ...over,
});

describe('pickExportCandidate', () => {
  it('picks a button whose "ייצוא" text lives in a nested span (button carries the innerText)', () => {
    const cands = [
      cand(0, { innerText: 'הדפסה' }),
      cand(1, { innerText: 'ייצוא' }), // button.innerText includes the child span text
    ];
    assert.equal(pickExportCandidate(cands), 1);
  });

  it('picks an anchor export link', () => {
    const cands = [
      cand(0, { tagName: 'DIV', className: 'row' }),
      cand(1, { tagName: 'A', innerText: 'ייצוא לאקסל' }),
    ];
    assert.equal(pickExportCandidate(cands), 1);
  });

  it('picks a button identified only by aria-label / title', () => {
    assert.equal(pickExportCandidate([
      cand(0, { innerText: '', ariaLabel: 'ייצוא לאקסל' }),
    ]), 0);
    assert.equal(pickExportCandidate([
      cand(0, { innerText: '', title: 'Export to Excel' }),
    ]), 0);
  });

  it('does NOT select Print when Export is also present', () => {
    const cands = [
      cand(0, { innerText: 'הדפסה', className: 'print-icon' }),
      cand(1, { innerText: 'ייצוא', className: 'excel-icon' }),
    ];
    const chosen = pickExportCandidate(cands);
    assert.equal(chosen, 1);
    assert.notEqual(chosen, 0);
  });

  it('returns -1 when only a Print control exists', () => {
    assert.equal(pickExportCandidate([cand(0, { innerText: 'הדפסה' })]), -1);
    assert.equal(pickExportCandidate([cand(0, { innerText: 'Print', ariaLabel: 'Print' })]), -1);
  });

  it('skips hidden or disabled candidates', () => {
    assert.equal(pickExportCandidate([cand(0, { innerText: 'ייצוא', visible: false })]), -1);
    assert.equal(pickExportCandidate([cand(0, { innerText: 'ייצוא', disabled: true })]), -1);
  });

  it('prefers explicit "ייצוא" text over a generic export/excel class', () => {
    const cands = [
      cand(0, { innerText: '', className: 'btn export-excel' }), // weak: class only
      cand(1, { innerText: 'ייצוא' }),                            // strong: explicit text
    ];
    assert.equal(pickExportCandidate(cands), 1);
  });

  it('matches xls/csv/excel/export variants', () => {
    assert.equal(pickExportCandidate([cand(0, { innerText: 'Export CSV' })]), 0);
    assert.equal(pickExportCandidate([cand(0, { innerText: 'Download XLS' })]), 0);
    assert.equal(pickExportCandidate([cand(0, { ariaLabel: 'excel' })]), 0);
  });

  it('handles the empty candidate list', () => {
    assert.equal(pickExportCandidate([]), -1);
    assert.equal(pickExportCandidate(), -1);
  });

  it('picks the REAL CAL button (visible text "יצוא", aria-label "ייצוא לאקסל", inside span.export)', () => {
    // <span class="export"><img><button aria-label="ייצוא לאקסל">יצוא</button></span>
    const cands = [
      cand(0, { tagName: 'IMG', innerText: '', className: 'export' }),
      cand(1, { tagName: 'BUTTON', innerText: 'יצוא', textContent: 'יצוא', ariaLabel: 'ייצוא לאקסל', className: 'butn-small-piping border-none ng-star-inserted' }),
    ];
    assert.equal(pickExportCandidate(cands), 1);
  });

  it('picks the real export button, never the print button, when both are present', () => {
    const cands = [
      cand(0, { tagName: 'BUTTON', innerText: 'הדפסה', ariaLabel: 'הדפסה', className: 'print' }),
      cand(1, { tagName: 'BUTTON', innerText: 'יצוא', ariaLabel: 'ייצוא לאקסל', className: 'butn-small-piping' }),
    ];
    assert.equal(pickExportCandidate(cands), 1);
  });

  it('matches the Excel Hebrew token "אקסל"', () => {
    assert.ok(EXPORT_RE.test('ייצוא לאקסל'));
    assert.ok(EXPORT_RE.test('אקסל'));
    assert.equal(pickExportCandidate([cand(0, { innerText: '', ariaLabel: 'ייצוא לאקסל' })]), 0);
  });
});

describe('export/print regexes', () => {
  it('EXPORT_RE matches the expected tokens', () => {
    for (const t of ['ייצוא', 'יצוא', 'export', 'Excel', 'CSV', 'xls']) assert.ok(EXPORT_RE.test(t), t);
  });
  it('PRINT_RE matches print tokens and not export', () => {
    assert.ok(PRINT_RE.test('הדפסה'));
    assert.ok(PRINT_RE.test('Print'));
    assert.ok(!PRINT_RE.test('ייצוא'));
  });
});
