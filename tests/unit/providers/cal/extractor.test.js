import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectPendingMarker } from '../../../../packages/bridge-core/src/providers/cal/extractor.js';

// detectPendingMarker drives the skip decision in the CAL fetch loop:
// a non-null result means the transaction is pending/unfinalized and is skipped
// (not exported); null means it is finalized and exported normally.
describe('detectPendingMarker (CAL pending/unfinalized detection)', () => {
  it('skips a transaction containing "העסקה עדיין לא נקלטה"', () => {
    const text =
      'העסקה עדיין לא נקלטה אצלנו ויכול להיות שהסכום שלה עוד ישתנה. תהליך הקליטה יכול לקחת כמה ימים';
    const marker = detectPendingMarker(text);
    assert.ok(marker, 'expected a pending marker to be detected');
    assert.ok(text.includes(marker));
  });

  it('skips a transaction containing "הסכום לא סופי"', () => {
    const text = 'הסכום לא סופי – העסקה עדיין בתהליך קליטה שיכול לקחת כמה ימים';
    const marker = detectPendingMarker(text);
    assert.ok(marker, 'expected a pending marker to be detected');
    assert.ok(text.includes(marker));
  });

  it('skips a transaction containing "עדיין בתהליך קליטה"', () => {
    const text = 'העסקה עדיין בתהליך קליטה';
    const marker = detectPendingMarker(text);
    assert.ok(marker, 'expected a pending marker to be detected');
    assert.ok(text.includes(marker));
  });

  it('exports a finalized transaction with no pending markers (returns null)', () => {
    const text = 'WOLT  מסעדות  129.90 ₪  סוג העסקה: רגיל  מועד החיוב: 02/12/25';
    assert.equal(detectPendingMarker(text), null);
  });

  it('returns null for empty / missing text', () => {
    assert.equal(detectPendingMarker(''), null);
    assert.equal(detectPendingMarker(undefined), null);
  });

  it('returns the specific matched marker, not just a boolean', () => {
    assert.equal(detectPendingMarker('foo הסכום לא סופי bar'), 'הסכום לא סופי');
  });
});
