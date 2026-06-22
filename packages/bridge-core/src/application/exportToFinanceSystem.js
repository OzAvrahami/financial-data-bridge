import { parseAmount } from '../providers/cal/normalizer.js';
import { logger } from '../infrastructure/logger.js';
import { redactSecrets, truncate } from '../infrastructure/redact.js';

/**
 * Resolve the original-currency amount for the payload, guarding against 0.
 * Order: positive transaction.amount → re-parse raw.amountRaw → positive
 * chargeAmount → null (no usable amount). The re-parse step recovers value from
 * older export files written before the amount parser was fixed.
 *
 * @returns {number|null} null means "no usable amount — do not send".
 */
export function resolveOriginalAmount(transaction) {
    if (transaction.amount > 0) return transaction.amount;

    const reparsed = parseAmount(transaction.raw?.amountRaw);
    if (reparsed > 0) return reparsed;

    if (transaction.chargeAmount > 0) return transaction.chargeAmount;

    return null;
}

export function shouldSendTransaction(transaction) {
    if (!transaction) return false;

    if (transaction.status !== "completed") {
        return false;
    }

    if (!transaction.chargeAmount || transaction.chargeAmount <= 0) {
        return false;
    }

    return true;
}

/** Build the finance-system payload for a single transaction. */
function buildFinancePayload(transaction, originalAmount) {
    return {
        type: "expense",
        amount: transaction.chargeAmount,
        date: transaction.transactionDate,
        description: transaction.merchantName,
        charge_date: transaction.chargeDate,
        //category_id: null,
        //payment_source_id: null,
        payment_source_name: transaction.accountId,
        currency: transaction.currency,
        original_amount: originalAmount,
        //exchange_rate: null,
        //notes: null,
        //tags: [],
        // dedupKey is assigned by assignOccurrenceKeys() before export. It is sent
        // as external_id so the finance system COULD dedupe on it — but we do not
        // rely on that (idempotency is unverified); the local FinanceLedger is the
        // authoritative "already sent" record. Transactions with identical business
        // fields get distinct keys (baseFp vs baseFp|#2).
        external_id: transaction.dedupKey,
    };
}

/**
 * Send a SINGLE transaction to the finance system and classify the outcome.
 *
 * Unlike exportToFinanceSystem (which throws on the first failure), this never
 * throws for an API/network problem — it returns a structured result so the
 * finance sync engine can record a per-transaction audit status and continue.
 * All returned text is secret-redacted.
 *
 * The caller is responsible for the should-send checks (status/amount); this
 * function only guards the original-amount fallback before sending.
 *
 * @param {object} transaction
 * @param {{ apiUrl?: string, apiKey?: string }} [financeConfig]
 * @param {{ fetch?: typeof fetch }} [deps]
 * @returns {Promise<{ ok: true, apiStatus: number, financeTransactionId: string|null }
 *                  | { ok: false, classification: 'api_validation_failed'|'api_error',
 *                      apiStatus: number|null, message: string }>}
 */
export async function sendTransactionToFinance(transaction, financeConfig = {}, deps = {}) {
    const fetchImpl = deps.fetch ?? fetch;
    const apiUrl = financeConfig.apiUrl ?? process.env.FINANCE_API_URL;
    const apiKey = financeConfig.apiKey ?? process.env.FINANCE_API_KEY;

    if (!apiUrl) throw new Error("Missing finance API URL");
    if (!apiKey) throw new Error("Missing finance API key");

    // Guard against sending original_amount: 0 (e.g. older export files where a
    // foreign-currency amount failed to parse). A validation problem, not an API one.
    const originalAmount = resolveOriginalAmount(transaction);
    if (originalAmount == null) {
        return {
            ok: false,
            classification: "api_validation_failed",
            apiStatus: null,
            message: `no positive amount available`,
        };
    }

    const payload = buildFinancePayload(transaction, originalAmount);

    // NB: never log the payload (financial data) or the auth header (secret).
    let response;
    try {
        response = await fetchImpl(apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
        });
    } catch (err) {
        // Network/TLS/DNS failure — strip any secret or secret-bearing URL.
        return {
            ok: false,
            classification: "api_error",
            apiStatus: null,
            message: `Finance request failed: ${redactSecrets(err.message, [apiKey, apiUrl])}`,
        };
    }

    if (!response.ok) {
        // The response body may echo sensitive data — redact + truncate it.
        const bodyText = await response.text().catch(() => "");
        const safeBody = bodyText ? ` — ${truncate(redactSecrets(bodyText, [apiKey]), 200)}` : "";
        // 4xx → the request was rejected (validation/auth); 5xx/other → server-side.
        const classification = response.status >= 400 && response.status < 500
            ? "api_validation_failed"
            : "api_error";
        return {
            ok: false,
            classification,
            apiStatus: response.status,
            message: `HTTP ${response.status}${safeBody}`,
        };
    }

    // Best-effort extraction of a finance-side id for the audit trail.
    let financeTransactionId = null;
    try {
        const data = await response.json();
        financeTransactionId = data?.id ?? data?.transaction_id ?? data?.data?.id ?? null;
    } catch { /* body may be empty or non-JSON — id stays null */ }

    return { ok: true, apiStatus: response.status, financeTransactionId };
}

/**
 * Send qualifying transactions to the finance system (all-or-throw helper).
 *
 * Kept for backward compatibility and direct/CLI use. The desktop Sync to Finance
 * flow uses the per-transaction sendTransactionToFinance() via the finance sync
 * engine instead, so it can record a per-transaction ledger/audit status.
 *
 * Credentials come from `financeConfig` (the desktop passes the UI-configured,
 * in-memory values). `process.env` is only a fallback for tests/CLI-less callers.
 *
 * @param {object[]} transactions
 * @param {{ apiUrl?: string, apiKey?: string }} [financeConfig]
 */
export async function exportToFinanceSystem(transactions, financeConfig = {}) {
    if (!Array.isArray(transactions)) {
        throw new Error("Expected transactions to be an array");
    }

    const apiUrl = financeConfig.apiUrl ?? process.env.FINANCE_API_URL;
    const apiKey = financeConfig.apiKey ?? process.env.FINANCE_API_KEY;

    if (!apiUrl) throw new Error("Missing finance API URL");
    if (!apiKey) throw new Error("Missing finance API key");

    let sent = 0;
    for (const transaction of transactions) {
        if (!shouldSendTransaction(transaction)) {
            continue;
        }

        const result = await sendTransactionToFinance(transaction, { apiUrl, apiKey });
        if (!result.ok) {
            throw new Error(`Failed to export "${transaction.merchantName}": ${result.message}`);
        }
        sent++;
    }

    logger.info(`Finance export sent ${sent} transaction(s)`);
    return { sent };
}
