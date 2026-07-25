import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCalExport,
  parseCalDate,
  parseForeignFromNotes,
  mapExportRecordToRaw,
  decodeBuffer,
  detectFormat,
  parseXlsx,
  excelSerialToISO,
} from '../../../../packages/bridge-core/src/providers/cal/exportParser.js';
import { normalizeTransaction } from '../../../../packages/bridge-core/src/providers/cal/normalizer.js';
import { fingerprint, assignOccurrenceKeys } from '../../../../packages/bridge-core/src/infrastructure/dedup.js';

// Deterministic "today" for daysBack filtering.
const NOW = new Date('2026-07-25T12:00:00Z');

// Header row uses gershayim (״) exactly like CAL, avoiding ASCII-quote CSV escaping.
const HEADERS = ['תאריך עסקה', 'שם בית עסק', 'סכום בש״ח', 'כרטיס', 'מועד חיוב', 'סוג עסקה', 'מזהה כרטיס בארנק דיגיטלי', 'הנחה', 'הערות'];

/** Build a CSV buffer (optionally with a UTF-8 BOM and a preamble title row). */
function csvBuffer(rows, { bom = false, preamble = null } = {}) {
  const lines = [];
  if (preamble) lines.push(preamble);
  lines.push(HEADERS.join(','));
  for (const r of rows) lines.push(r.join(','));
  const text = lines.join('\r\n');
  return bom ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf-8')]) : Buffer.from(text, 'utf-8');
}

const DOMESTIC = ['15/07/2026', 'WOLT', '129.90', 'ויזה 1234', '20/08/2026', 'רגיל', '', '', ''];
const FOREIGN  = ['18/07/2026', 'AMAZON', '465.00', 'ויזה 1234', '20/08/2026', 'רגיל', '', '', 'סכום העסקה הוא $ 125.6'];
const PENDING  = ['24/07/2026', 'PENDING SHOP', '', 'ויזה 1234', '', 'רגיל', '', '', 'עסקה בקליטה'];
const OLD      = ['01/07/2026', 'OLD SHOP', '50.00', 'ויזה 1234', '20/08/2026', 'רגיל', '', '', '']; // outside 10-day window

describe('parseCalDate', () => {
  it('parses dd/mm/yyyy', () => assert.equal(parseCalDate('15/07/2026'), '2026-07-15'));
  it('parses dd/mm/yy (2-digit year → 20xx)', () => assert.equal(parseCalDate('15/07/26'), '2026-07-15'));
  it('parses dd.mm.yyyy and dd-mm-yyyy', () => {
    assert.equal(parseCalDate('03.02.2026'), '2026-02-03');
    assert.equal(parseCalDate('03-02-2026'), '2026-02-03');
  });
  it('passes through ISO', () => assert.equal(parseCalDate('2026-07-15'), '2026-07-15'));
  it('parses an Excel serial number', () => assert.equal(parseCalDate('46218'), excelSerialToISO('46218')));
  it('returns empty for blank/garbage', () => {
    assert.equal(parseCalDate(''), '');
    assert.equal(parseCalDate('not a date'), '');
  });
});

describe('parseForeignFromNotes', () => {
  it('extracts USD original amount from "סכום העסקה הוא $ 125.6"', () => {
    const f = parseForeignFromNotes('סכום העסקה הוא $ 125.6');
    assert.equal(f.amount, 125.6);
    assert.equal(f.currency, 'USD');
  });
  it('extracts $ 75.0', () => {
    assert.equal(parseForeignFromNotes('סכום העסקה הוא $ 75.0').amount, 75);
  });
  it('returns null when there is no foreign amount note', () => {
    assert.equal(parseForeignFromNotes(''), null);
    assert.equal(parseForeignFromNotes('עסקה בקליטה'), null);
  });
});

describe('mapExportRecordToRaw (shape + amount policy)', () => {
  it('domestic ILS: amount == chargeAmount, currency ILS', () => {
    const raw = mapExportRecordToRaw({ transactionDate: '15/07/2026', merchant: 'WOLT', amountIls: '129.90', card: 'ויזה 1234', chargeDate: '20/08/2026', transactionType: 'רגיל' });
    assert.equal(raw.transactionDate, '2026-07-15');
    assert.equal(raw.amount, 129.9);
    assert.equal(raw.chargeAmount, 129.9);
    assert.equal(raw.businessName, 'WOLT');
    assert.equal(raw.cardName, 'ויזה 1234');
    assert.equal(raw.pending, undefined);
  });

  it('foreign: original amount/currency from notes, ILS charge NOT overwritten', () => {
    const raw = mapExportRecordToRaw({ transactionDate: '10/07/2026', merchant: 'AMAZON', amountIls: '465.00', card: 'ויזה 1234', chargeDate: '20/08/2026', transactionType: 'רגיל', notes: 'סכום העסקה הוא $ 125.6' });
    assert.equal(raw.amount, 125.6, 'amount is the foreign original');
    assert.equal(raw.amountRaw, '$ 125.6');
    assert.equal(raw.chargeAmount, 465, 'ILS charge is preserved');
    assert.equal(raw.originalAmount, 125.6);
    assert.equal(raw.originalCurrency, 'USD');
  });

  it('flags pending on "עסקה בקליטה"', () => {
    const raw = mapExportRecordToRaw({ transactionDate: '24/07/2026', merchant: 'X', amountIls: '', notes: 'עסקה בקליטה' });
    assert.equal(raw.pending, true);
    assert.ok(raw.pendingMarker);
  });

  it('flags pending on a blank ILS amount with an intake note', () => {
    const raw = mapExportRecordToRaw({ transactionDate: '24/07/2026', merchant: 'X', amountIls: '', notes: 'בתהליך קליטה כרגע' });
    assert.equal(raw.pending, true);
  });
});

describe('mapping feeds the SAME normalizer/fingerprint as the modal path', () => {
  it('normalizeTransaction produces expected identity fields for a domestic row', () => {
    const tx = normalizeTransaction(mapExportRecordToRaw({
      transactionDate: '15/07/2026', merchant: 'WOLT', amountIls: '129.90',
      card: 'ויזה 1234', chargeDate: '20/08/2026', transactionType: 'רגיל',
    }));
    assert.equal(tx.provider, 'CAL');
    assert.equal(tx.accountId, 'ויזה 1234');   // card name feeds fingerprint's accountId
    assert.equal(tx.merchantName, 'WOLT');
    assert.equal(tx.amount, 129.9);
    assert.equal(tx.currency, 'ILS');
    assert.equal(tx.status, 'completed');       // chargeDate present
    assert.equal(typeof fingerprint(tx), 'string');
  });
});

describe('duplicate-looking rows are preserved (not collapsed) and reuse existing dedup', () => {
  it('two identical rows survive parsing and get DISTINCT dedupKeys via assignOccurrenceKeys', () => {
    const buf = csvBuffer([DOMESTIC, DOMESTIC], { bom: true });
    const parsed = parseCalExport(buf, { daysBack: 30, now: NOW });
    const kept = parsed.mapped.filter(m => m.withinRange && !m.pending);
    assert.equal(kept.length, 2, 'both duplicate-looking rows are preserved by the parser');

    const txs = kept.map(m => normalizeTransaction(m.raw));
    assert.equal(fingerprint(txs[0]), fingerprint(txs[1]), 'same base fingerprint (identical business fields)');

    assignOccurrenceKeys(txs);
    assert.notEqual(txs[0].dedupKey, txs[1].dedupKey, 'occurrence keys disambiguate — not collapsed');
    assert.equal(txs[1].dedupKey, `${fingerprint(txs[1])}|#2`);
  });
});

describe('parseCalExport (CSV, full flow)', () => {
  it('parses Hebrew headers, skips pending, filters daysBack, keeps finalized', () => {
    const buf = csvBuffer([DOMESTIC, FOREIGN, PENDING, OLD], { bom: true });
    const parsed = parseCalExport(buf, { daysBack: 10, now: NOW });

    assert.equal(parsed.format, 'csv');
    assert.equal(parsed.encoding, 'utf-8-bom');
    assert.equal(parsed.headerFound, true);
    assert.equal(parsed.stats.totalRows, 4);
    // OLD (01/07) is outside the 10-day window (cutoff 2026-07-15).
    assert.equal(parsed.stats.withinRange, 3);
    assert.equal(parsed.stats.pendingSkipped, 1);   // PENDING
    assert.equal(parsed.stats.finalized, 2);        // DOMESTIC + FOREIGN
  });

  it('tolerates a preamble title row before the header', () => {
    const buf = csvBuffer([DOMESTIC], { preamble: 'עסקאות בכרטיס אשראי - דוח' });
    const parsed = parseCalExport(buf, { daysBack: 30, now: NOW });
    assert.equal(parsed.headerFound, true);
    assert.equal(parsed.stats.finalized, 1);
  });

  it('handles a blank ILS amount row without crashing', () => {
    const buf = csvBuffer([['12/07/2026', 'BLANKAMT', '', 'ויזה 1234', '20/08/2026', 'רגיל', '', '', '']]);
    const parsed = parseCalExport(buf, { daysBack: 30, now: NOW });
    assert.equal(parsed.stats.totalRows, 1);
    assert.equal(parsed.mapped[0].raw.chargeAmount, 0);
  });
});

describe('decodeBuffer / encoding', () => {
  it('detects a UTF-8 BOM', () => {
    const b = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('שלום', 'utf-8')]);
    const d = decodeBuffer(b);
    assert.equal(d.encoding, 'utf-8-bom');
    assert.equal(d.text, 'שלום');
  });

  it('decodes Windows-1255 (₪ + Hebrew) when the bytes are not valid UTF-8', () => {
    // CP1255: ₪=0xA4, ש=0xF9, ל=0xEC, ו=0xE5, ם=0xED
    const b = Buffer.from([0xA4, 0xF9, 0xEC, 0xE5, 0xED]);
    const d = decodeBuffer(b);
    assert.equal(d.encoding, 'windows-1255');
    assert.equal(d.text, '₪שלום');
  });
});

// ── Minimal XLSX round-trip (zero-dep zip built inline) ────────────────────────

/** CRC-free stored-entry zip builder (parser reads sizes/offsets, not CRC). */
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);              // method 0 (stored)
    local.writeUInt32LE(0, 14);             // crc (unchecked)
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 10);               // method 0
    cen.writeUInt32LE(0, 16);               // crc
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);          // local header offset
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const cdStart = offset;
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/** Build an xlsx (inline strings) sheet from a 2D array of strings. */
function buildXlsx(rows) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rowXml = rows.map((cells, r) => {
    const cs = cells.map((v, c) => {
      const ref = String.fromCharCode(65 + c) + (r + 1);
      return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cs}</row>`;
  }).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>${rowXml}</sheetData></worksheet>`;
  return buildZip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf-8') }]);
}

describe('XLSX parsing (minimal, zero-dep)', () => {
  it('detects the xlsx (PK) container', () => {
    const buf = buildXlsx([HEADERS, DOMESTIC]);
    assert.equal(detectFormat(buf), 'xlsx');
  });

  it('parseXlsx reads the header + data rows', () => {
    const rows = parseXlsx(buildXlsx([HEADERS, DOMESTIC]));
    assert.deepEqual(rows[0], HEADERS);
    assert.equal(rows[1][1], 'WOLT');
  });

  it('parseCalExport maps an xlsx end-to-end', () => {
    const parsed = parseCalExport(buildXlsx([HEADERS, DOMESTIC, FOREIGN]), { daysBack: 30, now: NOW });
    assert.equal(parsed.format, 'xlsx');
    assert.equal(parsed.headerFound, true);
    assert.equal(parsed.stats.finalized, 2);
  });
});

describe('HTML-table export parsing', () => {
  it('parses an HTML table disguised as an export', () => {
    const row = c => `<tr>${c.map(x => `<td>${x}</td>`).join('')}</tr>`;
    const html = `<html><body><table>${row(HEADERS)}${row(DOMESTIC)}</table></body></html>`;
    const parsed = parseCalExport(Buffer.from(html, 'utf-8'), { daysBack: 30, now: NOW });
    assert.equal(parsed.format, 'html');
    assert.equal(parsed.headerFound, true);
    assert.equal(parsed.stats.finalized, 1);
  });
});
