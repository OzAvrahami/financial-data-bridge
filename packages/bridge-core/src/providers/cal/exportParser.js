/**
 * CAL export-file parser (feature-flagged alternative to modal extraction).
 *
 * Turns the file downloaded by CAL's "ייצוא" button into raw CAL transaction
 * rows in the EXACT shape the modal extractor produces (see extractor.js →
 * extractModalData). Those raw rows then flow through the unchanged
 * normalizer → assignOccurrenceKeys → SeenStore → FinanceLedger pipeline, so the
 * export path shares one identity/dedup/ledger mechanism with the modal path.
 *
 * IDENTITY: this parser NEVER invents an identity. It does not use the Excel row
 * number, file position, or any per-export ordinal as a transaction id. Identity
 * remains fingerprint(normalizedTx) over immutable business fields, exactly as for
 * the modal path. Duplicate-looking rows are preserved as separate rows here and
 * disambiguated downstream by assignOccurrenceKeys().
 *
 * Zero external dependencies: CSV, HTML-table, and (minimal) XLSX are all parsed
 * with Node built-ins. XLSX uses the built-in zlib to inflate the zip container.
 */

import zlib from 'zlib';
import { parseAmount, detectCurrency } from './normalizer.js';
import { detectPendingMarker, PENDING_MARKERS } from './extractor.js';

// ── Hebrew column identification ───────────────────────────────────────────────
// Headers are matched by keyword `includes` (after normalization) so quoting
// variants like בש"ח / בש״ח / בשח and stray whitespace all resolve. Order matters
// only for disambiguation; each field lists the keywords that identify its column.
export const CAL_EXPORT_FIELDS = {
  transactionDate: ['תאריך עסקה', 'תאריך העסקה'],
  merchant:        ['שם בית עסק', 'שם בית העסק'],
  amountIls:       ['סכום בשח', 'סכום בש"ח', 'סכום חיוב', 'סכום החיוב'],
  card:            ['כרטיס'],
  chargeDate:      ['מועד חיוב', 'מועד החיוב', 'תאריך חיוב'],
  transactionType: ['סוג עסקה', 'סוג העסקה'],
  // 'מזהה כרטיס' matches regardless of CAL's spelling of the suffix (the real file
  // has the typo "דיגילטי" instead of "דיגיטלי"). It is longer than the 'כרטיס'
  // card keyword, so longest-match keeps it out of the card column.
  walletId:        ['מזהה כרטיס', 'מזהה כרטיס בארנק דיגיטלי', 'ארנק דיגיטלי', 'ארנק דיגילטי'],
  discount:        ['הנחה'],
  notes:           ['הערות'],
};

// Pending markers recognised in the export's notes column: the modal path's
// markers PLUS the export-specific "עסקה בקליטה" (transaction being ingested).
export const CAL_EXPORT_PENDING_MARKERS = [...PENDING_MARKERS, 'עסקה בקליטה', 'בקליטה'];

/** Normalize a header/cell for matching: strip NBSP, gershayim/quote variants, spaces. */
function normHeader(s) {
  return String(s ?? '')
    .replace(/ /g, ' ')
    .replace(/["'׳״]/g, '')   // ", ', geresh ׳, gershayim ״
    .replace(/\s+/g, '')
    .trim();
}

// ── Encoding ───────────────────────────────────────────────────────────────────

// Minimal CP1255 (Windows Hebrew) high-byte table. ASCII (0x00–0x7F) passes
// through. Only the entries CAL files actually use are mapped precisely (₪, Hebrew
// letters, geresh/gershayim, NBSP); unmapped high bytes fall back to Latin-1.
const CP1255_HIGH = (() => {
  const m = {};
  m[0xA0] = ' '; m[0xA4] = '₪'; // NBSP, ₪
  m[0xAA] = '×'; m[0xBA] = '÷'; // × ÷
  m[0xD7] = '׳'; m[0xD8] = '״'; // geresh, gershayim
  m[0x93] = '“'; m[0x94] = '”'; m[0x91] = '‘'; m[0x92] = '’';
  for (let b = 0xE0; b <= 0xFA; b++) m[b] = String.fromCharCode(0x05D0 + (b - 0xE0)); // א–ת
  return m;
})();

function decodeCp1255(buf) {
  let out = '';
  for (const byte of buf) {
    if (byte < 0x80) out += String.fromCharCode(byte);
    else out += CP1255_HIGH[byte] ?? String.fromCharCode(byte);
  }
  return out;
}

/** Decode a Buffer to text, honoring a UTF-8 BOM and falling back to CP1255. */
export function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return { text: buf.slice(3).toString('utf-8'), encoding: 'utf-8-bom' };
  }
  const utf8 = buf.toString('utf-8');
  // A U+FFFD replacement char means the bytes were not valid UTF-8 → try CP1255.
  if (!utf8.includes('�')) return { text: utf8, encoding: 'utf-8' };
  return { text: decodeCp1255(buf), encoding: 'windows-1255' };
}

// ── Format detection ───────────────────────────────────────────────────────────

/** Classify the downloaded bytes: 'xlsx' | 'html' | 'csv'. */
export function detectFormat(buf) {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04) {
    return 'xlsx'; // PK.. zip container (xlsx is a zip)
  }
  const head = buf.slice(0, 4096).toString('latin1').toLowerCase();
  if (head.includes('<table') || head.includes('<html') || head.includes('<!doctype html')) return 'html';
  return 'csv';
}

// ── CSV ────────────────────────────────────────────────────────────────────────

/** Pick the delimiter by counting candidates on the first non-empty line. */
function detectDelimiter(text) {
  const line = text.split(/\r?\n/).find(l => l.trim().length) || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of line) if (ch in counts) counts[ch]++;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/** RFC4180-ish CSV → 2D array of trimmed string cells. Handles quotes + embedded delimiters/newlines. */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // swallow; \n handles the row break
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.map(r => r.map(cell => cell.trim())).filter(r => r.some(cell => cell.length));
}

// ── HTML table ───────────────────────────────────────────────────────────────

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Parse the FIRST <table> in the HTML into a 2D array of cell text. */
export function parseHtmlTable(html) {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  const scope = tableMatch ? tableMatch[0] : html;
  const rows = [];
  const trRe = /<tr[\s\S]*?<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(scope))) {
    const cells = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cell;
    while ((cell = cellRe.exec(tr[0]))) {
      cells.push(decodeEntities(cell[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim());
    }
    if (cells.some(c => c.length)) rows.push(cells);
  }
  return rows;
}

// ── XLSX (minimal, zero-dep) ───────────────────────────────────────────────────

/** Unzip entries whose name matches `keep(name)` from an xlsx via the central directory. */
function unzipEntries(buf, keep) {
  const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== EOCD) e--;
  if (e < 0) throw new Error('xlsx: no end-of-central-directory record');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== CEN) break;
    const method  = buf.readUInt16LE(p + 10);
    const compSz  = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extLen  = buf.readUInt16LE(p + 30);
    const cmtLen  = buf.readUInt16LE(p + 32);
    const lho     = buf.readUInt32LE(p + 42);
    const name    = buf.toString('utf-8', p + 46, p + 46 + nameLen);
    if (keep(name) && buf.readUInt32LE(lho) === LOC) {
      const lNameLen = buf.readUInt16LE(lho + 26);
      const lExtLen  = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lNameLen + lExtLen;
      const comp = buf.subarray(start, start + compSz);
      out.set(name, method === 0 ? comp : zlib.inflateRawSync(comp));
    }
    p += 46 + nameLen + extLen + cmtLen;
  }
  return out;
}

function xmlText(s) {
  return decodeEntities(String(s).replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)));
}

// Tag matchers that tolerate an XML namespace prefix (CAL's export uses `x:` on
// every element: <x:row>, <x:c>, <x:v>, <x:si>, <x:t>). Missing this was why the
// parser read zero rows/strings against the real file.
const RE_SI   = /<(?:\w+:)?si\b[\s\S]*?<\/(?:\w+:)?si>/g;
const RE_T    = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
const RE_ROW  = /<(?:\w+:)?row\b[\s\S]*?<\/(?:\w+:)?row>/g;
const RE_CELL = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
const RE_V    = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/;
const RE_IS_T = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/;

/** Column letters ("AB") → 0-based index. */
function colToIndex(ref) {
  const letters = (ref.match(/[A-Z]+/) || [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel serial date → YYYY-MM-DD (1900 date system, with the Excel leap-year bug). */
export function excelSerialToISO(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = Math.round((n - 25569) * 86400 * 1000); // 25569 = days from 1899-12-30 to 1970-01-01
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** Parse the first worksheet of an xlsx buffer into a 2D array of strings. */
export function parseXlsx(buf) {
  const entries = unzipEntries(buf, (name) =>
    name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(name));

  const sharedXml = entries.get('xl/sharedStrings.xml');
  // Prefer sheet1.xml; otherwise the first worksheet in sorted order.
  const sheetName = entries.has('xl/worksheets/sheet1.xml')
    ? 'xl/worksheets/sheet1.xml'
    : [...entries.keys()].filter(n => n.startsWith('xl/worksheets/')).sort()[0];
  const sheetXml = sheetName ? entries.get(sheetName) : null;
  if (!sheetXml) throw new Error('xlsx: no worksheet found under xl/worksheets/');

  const shared = [];
  if (sharedXml) {
    const s = sharedXml.toString('utf-8');
    for (const si of s.match(RE_SI) || []) {
      const parts = [...si.matchAll(RE_T)].map(m => xmlText(m[1]));
      shared.push(parts.join(''));
    }
  }

  const sheet = sheetXml.toString('utf-8');
  const rows = [];
  for (const rowXml of sheet.match(RE_ROW) || []) {
    const cells = [];
    for (const cm of rowXml.matchAll(RE_CELL)) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';               // undefined for a self-closing (empty) cell
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1] || '';
      const idx = ref ? colToIndex(ref) : cells.length;
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
      let value = '';
      if (type === 's') {
        const v = (body.match(RE_V) || [])[1];
        value = v != null ? (shared[Number(v)] ?? '') : '';
      } else if (type === 'inlineStr') {
        value = xmlText((body.match(RE_IS_T) || [])[1] || '');
      } else {
        value = xmlText((body.match(RE_V) || [])[1] || '');
      }
      cells[idx] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = '';
    if (cells.some(c => c && c.length)) rows.push(cells);
  }
  return rows;
}

// ── Rows → header-mapped records ───────────────────────────────────────────────

// Pre-normalized (field, keyword) pairs, longest keyword first so a specific
// header (מזהה כרטיס בארנק דיגיטלי) wins over a short substring keyword (כרטיס).
const FIELD_KEYWORDS = Object.entries(CAL_EXPORT_FIELDS)
  .flatMap(([field, kws]) => kws.map(k => ({ field, kw: normHeader(k) })))
  .sort((a, b) => b.kw.length - a.kw.length);

/**
 * Map header cells → field name per column index. For each column, the LONGEST
 * matching keyword wins (so כרטיס does not steal the wallet-id column), and each
 * field is claimed by at most one column (first column wins).
 */
function mapHeaderColumns(headerCells) {
  const colField = {};
  const usedFields = new Set();
  headerCells.forEach((cell, idx) => {
    const norm = normHeader(cell);
    if (!norm) return;
    const match = FIELD_KEYWORDS.find(({ field, kw }) => !usedFields.has(field) && norm.includes(kw));
    if (match) { colField[idx] = match.field; usedFields.add(match.field); }
  });
  return colField;
}

/**
 * Find the header row: the row matching the MOST distinct CAL columns (≥2), so a
 * preamble/title row that merely mentions one keyword (e.g. "כרטיס") is not
 * mistaken for the header.
 */
function locateHeaderRow(rows) {
  let best = -1;
  let bestScore = 1; // require at least 2 distinct column matches
  for (let i = 0; i < rows.length; i++) {
    const score = new Set(Object.values(mapHeaderColumns(rows[i]))).size;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/** Convert a 2D grid into an array of { field: value } records using the header row. */
export function rowsToRecords(rows) {
  const headerIdx = locateHeaderRow(rows);
  if (headerIdx < 0) return { records: [], colField: {}, headerIdx: -1 };
  const colField = mapHeaderColumns(rows[headerIdx]);
  const records = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cells = rows[r];
    const rec = {};
    let any = false;
    for (const [idx, field] of Object.entries(colField)) {
      const v = (cells[idx] ?? '').toString().trim();
      rec[field] = v;
      if (v) any = true;
    }
    rec._raw = cells;
    if (any) records.push(rec);
  }
  return { records, colField, headerIdx };
}

// ── Field parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a CAL date cell to YYYY-MM-DD. Accepts dd/mm/yyyy, dd/mm/yy, dd.mm.yyyy,
 * dd-mm-yyyy, an already-ISO string, or an Excel serial number. Returns '' if empty
 * or unparseable (explicit, tested).
 */
export function parseCalDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);      // already ISO
  const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})/);
  if (dmy) {
    const d = dmy[1].padStart(2, '0');
    const m = dmy[2].padStart(2, '0');
    const y = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${y}-${m}-${d}`;
  }
  if (/^\d+(\.\d+)?$/.test(s)) return excelSerialToISO(s);       // Excel serial
  return '';
}

/**
 * Extract the card/account name from the export's title row. This export has NO
 * card column, so the card comes from the title, e.g.:
 *   "פירוט עסקאות ... לכרטיס ויזה 2755"  →  "ויזה 2755"
 * Returns '' when the title has no "לכרטיס …" clause (caller warns; never invents
 * a row-number-based identity).
 */
export function parseCardNameFromTitle(title) {
  const s = String(title ?? '').replace(/\s+/g, ' ').trim();
  const m = s.match(/לכרטיס\s+(.+?)\s*$/);
  return m ? m[1].trim() : '';
}

/**
 * Extract a foreign original amount from the notes, e.g. "סכום העסקה הוא $ 125.6".
 * Returns { amountRaw, amount, currency } or null when no foreign amount is present.
 */
export function parseForeignFromNotes(notes) {
  const s = String(notes ?? '');
  const m = s.match(/סכום\s+העסקה\s+הוא\s*([^\n,;|]+)/);
  if (!m) return null;
  const raw = m[1].trim();
  const amount = parseAmount(raw);
  if (!amount) return null;
  const currency = detectCurrency(raw);
  return { amountRaw: raw, amount, currency };
}

/**
 * Map ONE header-mapped export record into the raw CAL shape consumed by
 * normalizeTransaction() — identical field names to the modal extractor's output.
 *
 * Amount policy (must match the modal path so fingerprints align):
 *   - chargeAmount / chargeAmountRaw   ← ILS "סכום בש״ח" (the billed amount) ALWAYS.
 *   - amount / amountRaw (== identity's transaction amount):
 *        · foreign row (notes carry an original amount) → the foreign amount/currency.
 *        · domestic row → the ILS amount (transaction amount == charge for ILS).
 *   The valid ILS charge is NEVER overwritten by the foreign amount.
 */
export function mapExportRecordToRaw(rec, { cardName = '' } = {}) {
  const notes = rec.notes || '';
  const ilsRaw = rec.amountIls || '';
  const foreign = parseForeignFromNotes(notes);

  const chargeAmountRaw = ilsRaw;
  const amountRaw = foreign ? foreign.amountRaw : ilsRaw;

  const raw = {
    transactionDate: parseCalDate(rec.transactionDate),
    // No card column in this export → the card comes from the title row. Prefer an
    // explicit card column if a future export adds one.
    cardName:        rec.card || cardName || '',
    businessName:    rec.merchant || '',
    expenseType:     '', // CAL export has no merchant-category column
    amount:          parseAmount(amountRaw),
    amountRaw,
    transactionType: rec.transactionType || '',
    chargeDate:      parseCalDate(rec.chargeDate),
    chargeAmount:    parseAmount(chargeAmountRaw),
    chargeAmountRaw,
    // Diagnostics-only; downstream identity uses amount/currency (above).
    originalAmount:   foreign ? foreign.amount : null,
    originalCurrency: foreign ? foreign.currency : null,
    walletId:        rec.walletId || '',
    discount:        rec.discount || '',
    notes,
    source:          'export',
    exportRecord:    rec,
  };

  // Pending / unfinalized detection: a known marker in the notes, OR a blank ILS
  // amount alongside an ingest note. Skipped downstream exactly like modal pending.
  const marker = detectPendingMarker(notes, CAL_EXPORT_PENDING_MARKERS);
  const blankAmountIntake = !parseAmount(ilsRaw) && /קליטה/.test(notes);
  if (marker || blankAmountIntake) {
    raw.pending = true;
    raw.pendingMarker = marker || 'עסקה בקליטה';
  }
  return raw;
}

// ── Top-level parse ────────────────────────────────────────────────────────────

/**
 * Parse a downloaded CAL export buffer into mapped raw rows + summary stats.
 *
 * Every row is preserved (no dedup here). daysBack filtering is applied locally by
 * transactionDate. The caller normalizes the withinRange & non-pending rows via the
 * shared normalizeTransaction and lets assignOccurrenceKeys/SeenStore/FinanceLedger
 * decide identity/dedup/finance — this function never assigns identity.
 *
 * @param {Buffer} buffer
 * @param {{ daysBack?: number, now?: Date }} [opts]
 * @returns {{
 *   format: string, encoding: string, columns: object, headerFound: boolean,
 *   mapped: Array<{ raw: object, pending: boolean, withinRange: boolean, transactionDate: string }>,
 *   stats: { totalRows: number, withinRange: number, pendingSkipped: number, finalized: number },
 *   warnings: string[]
 * }}
 */
export function parseCalExport(buffer, opts = {}) {
  const daysBack = Number.isFinite(opts.daysBack) ? opts.daysBack : Infinity;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const warnings = [];

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const format = detectFormat(buf);

  let rows;
  let encoding = 'binary';
  if (format === 'xlsx') {
    rows = parseXlsx(buf);
  } else {
    const dec = decodeBuffer(buf);
    encoding = dec.encoding;
    rows = format === 'html'
      ? parseHtmlTable(dec.text)
      : parseDelimited(dec.text, detectDelimiter(dec.text));
  }

  const { records, colField, headerIdx } = rowsToRecords(rows);
  if (headerIdx < 0) warnings.push('CAL export: no recognizable Hebrew header row found');

  // Card/account name from the title row(s) above the header — this export has no
  // card column. Applied to EVERY row so identity (fingerprint accountId) is stable.
  const titleText = headerIdx > 0 ? rows.slice(0, headerIdx).flat().join(' ') : '';
  const cardName = parseCardNameFromTitle(titleText);
  if (!cardName && headerIdx >= 0) {
    warnings.push(`CAL export: could not parse card name from title row: "${titleText.slice(0, 160)}"`);
  }

  // Local daysBack cutoff (inclusive). Rows with an unparseable date are KEPT
  // (withinRange=true) so we never silently drop a real transaction on a date-format
  // change — better to surface it downstream than to lose it.
  const cutoff = new Date(now);
  if (Number.isFinite(daysBack)) cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffISO = Number.isFinite(daysBack) ? cutoff.toISOString().slice(0, 10) : null;

  const mapped = [];
  let withinRange = 0, pendingSkipped = 0, finalized = 0, ignoredNonTransaction = 0;
  for (const rec of records) {
    const raw = mapExportRecordToRaw(rec, { cardName });
    // Only rows with a valid transaction date AND a merchant are transactions.
    // This drops blank rows and footer/summary rows (e.g. "סה״כ עסקאות בגיליון זה")
    // without ever collapsing real duplicate transactions.
    if (!raw.transactionDate || !raw.businessName) { ignoredNonTransaction++; continue; }

    const inRange = !cutoffISO || raw.transactionDate >= cutoffISO;
    const pending = raw.pending === true;
    if (inRange) {
      withinRange++;
      if (pending) pendingSkipped++; else finalized++;
    }
    mapped.push({ raw, pending, withinRange: inRange, transactionDate: raw.transactionDate });
  }

  return {
    format,
    encoding,
    cardName,
    columns: Object.fromEntries(Object.entries(colField).map(([idx, f]) => [f, Number(idx)])),
    headerFound: headerIdx >= 0,
    mapped,
    stats: { totalRows: mapped.length, withinRange, pendingSkipped, finalized, ignoredNonTransaction },
    warnings,
  };
}
