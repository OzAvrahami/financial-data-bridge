// Versioned evidence; never change dedup fields or invent missing provider values.
const currencies = { '₪': 'ILS', '$': 'USD', '€': 'EUR', '£': 'GBP' };
export function printedMoney(raw, { exportIls = false } = {}) {
  const text = String(raw ?? '').trim();
  const tokens = text.match(/-?\d[\d,]*(?:\.\d+)?/g);
  if (!tokens || tokens.length !== 1) return null;
  if (!/^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(tokens[0])) return null;
  const amount = tokens[0].replace(/,/g, '');
  if (!/^-?\d{1,28}(?:\.\d{1,6})?$/.test(amount)) return null;
  const codes = new Set(text.toUpperCase().match(/(?<![A-Z])(?:ILS|USD|EUR|GBP|RON|JPY|KWD)(?![A-Z])/g) || []);
  for (const [symbol, code] of Object.entries(currencies)) if (text.includes(symbol)) codes.add(code);
  if (!codes.size && exportIls) codes.add('ILS'); // CAL export's explicitly billed-ILS column
  if (codes.size !== 1) return null;
  return { amount, currency: [...codes][0], scale: (amount.split('.')[1] || '').length };
}

export function economicEvent(transaction) {
  const raw = transaction.raw || {};
  const type = String(raw.transactionType ?? transaction.transactionType ?? '').trim().replace(/\s+/g, ' ');
  if (raw.transactionType && transaction.transactionType && type !== transaction.transactionType.trim())
    return { kind: 'unknown', basis: 'unknown', provider_type: type };
  if (['רגיל', 'רגילה', 'מיידית', 'הוראת קבע'].includes(type))
    return { kind: 'purchase', basis: 'full_purchase', provider_type: type };
  if (/זיכוי|החזר/.test(type)) return { kind: 'refund', basis: 'unknown', provider_type: type };
  if (/תשלומ|תשלום/.test(type)) {
    const part = /תשלום\s+(\d+)\s+(?:מתוך|מ-)\s*(\d+)/.exec(type);
    return { kind: 'purchase', basis: 'installment_part', provider_type: type,
      installment: { number: part ? Number(part[1]) : null, count: part ? Number(part[2]) : null, purchase_id: null } };
  }
  return { kind: 'unknown', basis: 'unknown', provider_type: type };
}

export function buildEvidence(transaction) {
  const raw = transaction.raw || {};
  const billed = printedMoney(raw.chargeAmountRaw, { exportIls: raw.source === 'export' });
  const original = printedMoney(raw.amountRaw, { exportIls: raw.source === 'export' && !raw.originalCurrency });
  return { version: 2, billed, original, event: economicEvent(transaction) };
}
