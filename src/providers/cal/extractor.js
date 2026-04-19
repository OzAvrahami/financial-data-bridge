/**
 * CAL DOM extraction logic.
 *
 * Transaction rows are identified by `.field` divs with exactly 5 child elements.
 * This heuristic works on the current CAL Angular app structure. If the transaction
 * list stops returning results, inspect whether CAL changed this layout.
 *
 * All parsing of Hebrew label keys happens here — nothing CAL-specific leaks
 * into the normalizer or application layers.
 */

export async function countTransactions(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.field'))
      .filter(div => div.children.length === 5)
      .length
  );
}

export async function openTransactionModal(page, index) {
  const clicked = await page.evaluate(i => {
    const rows = Array.from(document.querySelectorAll('.field'))
      .filter(div => div.children.length === 5);
    if (rows[i]) {
      rows[i].click();
      return true;
    }
    return false;
  }, index);

  if (!clicked) return false;

  // Throws on timeout so that callers using withRetry can retry on transient failures.
  // Returns false only when the row itself was not found (non-retryable).
  await page.waitForSelector('[role="dialog"]', { state: 'visible', timeout: 10000 });
  return true;
}

export async function extractModalData(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"]');
    if (!modal) return null;

    const raw = {
      transactionDate: '',
      cardName: '',
      businessName: '',
      expenseType: '',
      amount: 0,
      transactionType: '',
      chargeDate: '',
      chargeAmount: 0,
      // DEBUG: preserve raw strings from the DOM before any stripping.
      // Remove these _debug fields once currency extraction is implemented.
      _debug_amountRaw: '',
      _debug_chargeAmountRaw: '',
      _debug_allTableRows: [],
    };

    const parseDate = str => {
      const m = str.match(/(\d{2})\/(\d{2})\/(\d{2})/);
      return m ? `20${m[3]}-${m[2]}-${m[1]}` : '';
    };

    const table = modal.querySelector('table.details-table');
    if (table) {
      table.querySelectorAll('tr').forEach(row => {
        const key = row.querySelector('.table-key')?.textContent?.trim();
        const val = row.querySelector('.table-value')?.textContent?.trim();

        // DEBUG: capture every key/value pair from the modal table.
        if (key) raw._debug_allTableRows.push({ key, val: val ?? '' });

        if (!key || !val) return;

        switch (key) {
          case 'שם בית עסק':   raw.businessName    = val; break;
          case 'תאריך ושעה':   raw.transactionDate = parseDate(val); break;
          case 'סכום העסקה':
            raw._debug_amountRaw = val;          // DEBUG: full cell text before strip
            raw.amount = parseFloat(val.replace(/[₪$,]/g, '')) || 0;
            break;
          case 'סוג העסקה':    raw.transactionType = val; break;
          case 'מועד החיוב':   raw.chargeDate      = parseDate(val); break;
          case 'סכום החיוב':
            raw._debug_chargeAmountRaw = val;    // DEBUG: full cell text before strip
            raw.chargeAmount = parseFloat(val.replace(/[₪$,]/g, '')) || 0;
            break;
          case 'ענף בית העסק': raw.expenseType     = val; break;
        }
      });
    }

    const cardDesc = modal.querySelector('.card-description');
    if (cardDesc) raw.cardName = cardDesc.textContent.trim();

    return raw;
  });
}

export async function closeModal(page) {
  await page.keyboard.press('Escape');
  // Wait for the dialog to disappear rather than a fixed timeout
  await page.waitForSelector('[role="dialog"]', { state: 'hidden', timeout: 5000 }).catch(() => {});
}
