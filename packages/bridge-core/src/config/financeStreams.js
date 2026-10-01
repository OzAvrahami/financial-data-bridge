// Local routing only; the consumer still authorizes exact payment_source_name.
export function financeV2Streams(config = {}) {
  if (config.contractVersion === 2) throw new Error('Global v2 selection is unsupported; select exact CAL streams');
  const rows = config.v2Streams === undefined ? [] : config.v2Streams;
  if (!Array.isArray(rows) || rows.length > 32) throw new Error('Invalid CAL v2 stream selection');
  const seen = new Set();
  return rows.map(row => {
    if (!row || Object.keys(row).some(k => !['provider', 'providerAccountId', 'paymentSourceName'].includes(k))
      || row.provider !== 'cal'
      || !['providerAccountId', 'paymentSourceName'].every(k => typeof row[k] === 'string'
        && row[k].length > 0 && row[k].length <= 255 && row[k] === row[k].trim() && !/[\p{Cc}]/u.test(row[k])))
      throw new Error('Each v2 stream needs CAL, an exact source account ID and an exact payment source name');
    const key = JSON.stringify([row.provider, row.providerAccountId, row.paymentSourceName]);
    if (seen.has(key)) throw new Error('Duplicate CAL v2 stream selection');
    seen.add(key);
    return { ...row };
  });
}

// Never trim/fold card names or infer identity from last4/displayName.
export function financeContractVersion(transaction, config = {}) {
  return financeV2Streams(config).some(s => s.provider === String(transaction.provider || '').toLowerCase()
    && s.providerAccountId === (transaction.providerAccountId || 'default')
    && s.paymentSourceName === transaction.accountId) ? 2 : 1;
}

export function validateFinanceStreamBatch(transactions, config = {}) {
  const selectedNames = new Set(financeV2Streams(config).map(s => s.paymentSourceName));
  // The current consumer cannot distinguish accounts sharing one registration name.
  if (transactions.some(tx => selectedNames.has(tx.accountId) && financeContractVersion(tx, config) !== 2))
    throw new Error('CAL stream name collision: an unselected account shares a registered payment source name; resolve registration scope before syncing');
}
