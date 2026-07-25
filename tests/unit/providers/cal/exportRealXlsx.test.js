import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCalExport,
  parseCardNameFromTitle,
  parseXlsx,
} from '../../../../packages/bridge-core/src/providers/cal/exportParser.js';
import { normalizeTransaction } from '../../../../packages/bridge-core/src/providers/cal/normalizer.js';
import { fingerprint, assignOccurrenceKeys } from '../../../../packages/bridge-core/src/infrastructure/dedup.js';

/**
 * Sanitized fixture that reproduces the REAL CAL export structure (no personal
 * data): namespaced `x:` tags, shared strings, a title row, multiline row-2
 * headers with the "דיגילטי" typo, Excel serial dates, numeric amounts, a blank
 * row, and footer rows. This is what broke the parser (namespaced tags → 0 rows).
 */

// CRC-free stored-entry zip builder (the reader uses sizes/offsets, not CRC).
function buildZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

const COL = (i) => String.fromCharCode(65 + i);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Build a namespaced (x:) xlsx with shared strings from a 2D grid. A cell that is
 * a number → numeric; a non-empty string → shared string; null/'' → self-closing
 * empty cell. Rows that are entirely empty are still emitted (parser skips them).
 */
function buildNsXlsx(grid) {
  const shared = [];
  const idxOf = new Map();
  const stringIdx = (s) => {
    if (!idxOf.has(s)) { idxOf.set(s, shared.length); shared.push(s); }
    return idxOf.get(s);
  };

  const rowsXml = grid.map((row, r) => {
    const cells = row.map((v, c) => {
      const ref = `${COL(c)}${r + 1}`;
      if (v == null || v === '') return `<x:c r="${ref}" t="s" />`;
      if (typeof v === 'number') return `<x:c r="${ref}"><x:v>${v}</x:v></x:c>`;
      return `<x:c r="${ref}" t="s"><x:v>${stringIdx(String(v))}</x:v></x:c>`;
    }).join('');
    return `<x:row r="${r + 1}" spans="1:${row.length}">${cells}</x:row>`;
  }).join('');

  const sheet = `<?xml version="1.0" encoding="utf-8"?>` +
    `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<x:sheetData>${rowsXml}</x:sheetData></x:worksheet>`;

  const sst = `<?xml version="1.0" encoding="utf-8"?>` +
    `<x:sst xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((s) => `<x:si><x:t>${esc(s)}</x:t></x:si>`).join('') + `</x:sst>`;

  return buildZip([
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf-8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sst, 'utf-8') },
  ]);
}

// Excel serials (1900 system): 46218=2026-07-15, 46224..46228 = Jul 21..25 2026.
const TITLE = 'פירוט עסקאות לפלוני אלמוני לחשבון דיסקונט כאל 999999999 לכרטיס ויזה 1234';
const HEADERS = ['תאריך\nעסקה', 'שם בית עסק', 'סכום\nבש"ח', 'מועד\nחיוב', 'סוג\nעסקה', 'מזהה כרטיס\nבארנק דיגילטי', 'הערות'];
// [date, merchant, amountILS, chargeDate, type, wallet, notes]
const GRID = [
  [TITLE, null, null, null, null, null, null],                                                 // row 1: title
  HEADERS,                                                                                       // row 2: headers
  [46228, 'WOLT', 129.9, 46230, 'רכישה רגילה', null, null],                                       // finalized
  [46227, 'WOLT', 55.0, 46230, 'רכישה רגילה', null, null],                                        // finalized
  [46225, 'MY FUNDED FUTURES', 300.0, 46230, 'רכישה רגילה', null, null],                          // dup #1
  [46225, 'MY FUNDED FUTURES', 300.0, 46230, 'רכישה רגילה', null, null],                          // dup #2 (identical)
  [46224, 'AMAZON', 465.0, 46230, 'רכישה רגילה', null, 'סכום העסקה הוא $ 125.6'],                  // finalized foreign
  [46228, 'SHOP P1', 8.0, null, 'רכישה רגילה', null, 'עסקה בקליטה'],                               // pending
  [46226, 'SHOP P2', 12.0, null, 'רכישה רגילה', null, 'עסקה בקליטה'],                              // pending
  [null, null, null, null, null, null, null],                                                    // blank row
  [null, 'סה"כ עסקאות בגיליון זה', 1000.9, null, null, null, null],                               // footer (no date)
  ['הסכומים בש"ח', null, null, null, null, null, null],                                           // footer text (no date/merchant)
];

const NOW = new Date('2026-07-25T12:00:00Z');

describe('parseCardNameFromTitle', () => {
  it('extracts "ויזה 1234" from the title row', () => {
    assert.equal(parseCardNameFromTitle(TITLE), 'ויזה 1234');
  });
  it('returns empty when there is no "לכרטיס" clause', () => {
    assert.equal(parseCardNameFromTitle('פירוט עסקאות ללא כרטיס'), '');
  });
});

describe('parseXlsx handles namespaced tags + shared strings + serial dates', () => {
  it('reads the multiline row-2 headers and a data row', () => {
    const rows = parseXlsx(buildNsXlsx(GRID));
    assert.ok(rows.length >= 3);
    assert.equal(rows[0][0], TITLE);          // title row
    assert.equal(rows[1][1], 'שם בית עסק');    // header row
    assert.equal(rows[2][1], 'WOLT');          // first data row merchant
    assert.equal(rows[2][0], '46228');         // serial date preserved as text
  });
});

describe('parseCalExport against the sanitized real-structure fixture', () => {
  const parsed = parseCalExport(buildNsXlsx(GRID), { daysBack: 10, now: NOW });

  it('finds headers, card name, and the expected columns (incl. wallet typo)', () => {
    assert.equal(parsed.format, 'xlsx');
    assert.equal(parsed.headerFound, true);
    assert.equal(parsed.cardName, 'ויזה 1234');
    assert.deepEqual(parsed.columns, {
      transactionDate: 0, merchant: 1, amountIls: 2, chargeDate: 3,
      transactionType: 4, walletId: 5, notes: 6,
    });
    assert.equal(parsed.warnings.length, 0);
  });

  it('produces the expected counts and ignores footer/blank rows', () => {
    assert.equal(parsed.stats.totalRows, 7);           // 5 finalized + 2 pending
    assert.equal(parsed.stats.pendingSkipped, 2);
    assert.equal(parsed.stats.finalized, 5);
    assert.equal(parsed.stats.ignoredNonTransaction, 2); // 2 footer rows (blank row not counted)
  });

  it('parses Excel serial dates and maps into the shared normalized shape', () => {
    const wolt = parsed.mapped.find(m => m.raw.businessName === 'WOLT');
    assert.equal(wolt.raw.transactionDate, '2026-07-25');
    assert.equal(wolt.raw.cardName, 'ויזה 1234');
    const tx = normalizeTransaction(wolt.raw);
    assert.equal(tx.provider, 'CAL');
    assert.equal(tx.accountId, 'ויזה 1234');
    assert.equal(tx.status, 'completed');
  });

  it('parses the foreign original amount but keeps the ILS charge', () => {
    const amazon = parsed.mapped.find(m => m.raw.businessName === 'AMAZON');
    assert.equal(amazon.raw.amount, 125.6);
    assert.equal(amazon.raw.originalCurrency, 'USD');
    assert.equal(amazon.raw.chargeAmount, 465);
  });

  it('flags the "עסקה בקליטה" rows as pending', () => {
    const pend = parsed.mapped.filter(m => m.pending);
    assert.equal(pend.length, 2);
    assert.ok(pend.every(m => m.raw.businessName.startsWith('SHOP P')));
  });

  it('preserves duplicate MY FUNDED FUTURES rows (distinct dedupKeys, not collapsed)', () => {
    const kept = parsed.mapped.filter(m => m.withinRange && !m.pending).map(m => normalizeTransaction(m.raw));
    const mff = kept.filter(t => t.merchantName === 'MY FUNDED FUTURES');
    assert.equal(mff.length, 2, 'both duplicate rows survive parsing');
    assert.equal(fingerprint(mff[0]), fingerprint(mff[1]), 'same base fingerprint');
    assignOccurrenceKeys(kept);
    const [a, b] = kept.filter(t => t.merchantName === 'MY FUNDED FUTURES');
    assert.notEqual(a.dedupKey, b.dedupKey, 'occurrence keys keep them separate');
  });
});
