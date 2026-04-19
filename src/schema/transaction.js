/**
 * Normalized transaction model shared across all providers.
 *
 * @typedef {Object} Transaction
 * @property {string} provider          - Provider identifier (e.g. 'CAL', 'MAX')
 * @property {string} accountId         - Card last-4 or account identifier
 * @property {string} transactionDate   - ISO date YYYY-MM-DD of when the charge occurred
 * @property {string} chargeDate        - ISO date YYYY-MM-DD of when it bills (empty if pending)
 * @property {string} merchantName      - Name of the merchant
 * @property {string} category          - Merchant category (e.g. restaurants, online)
 * @property {number} amount            - Transaction amount in original currency
 * @property {string} currency          - ISO 4217 currency code (e.g. 'ILS', 'USD')
 * @property {number} chargeAmount      - Billing amount in charge currency (ILS for Israeli cards)
 * @property {string} chargeCurrency    - Currency the card is billed in
 * @property {string} transactionType   - Provider-specific type string (e.g. 'רגיל', 'תשלומים')
 * @property {string} status            - 'pending' | 'completed'
 * @property {Object} raw               - Original provider data, unmodified
 */

export function createTransaction(fields = {}) {
  return {
    provider: '',
    accountId: '',
    transactionDate: '',
    chargeDate: '',
    merchantName: '',
    category: '',
    amount: 0,
    currency: 'ILS',
    chargeAmount: 0,
    chargeCurrency: 'ILS',
    transactionType: '',
    status: 'pending',
    raw: {},
    ...fields,
  };
}
