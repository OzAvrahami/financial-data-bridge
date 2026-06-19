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

/**
 * Send qualifying transactions to the finance system.
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

        // Guard against sending original_amount: 0 (e.g. older export files where
        // a foreign-currency amount failed to parse). Falls back safely.
        const originalAmount = resolveOriginalAmount(transaction);
        if (originalAmount == null) {
            throw new Error(
                `Refusing to export "${transaction.merchantName}": no positive amount available`
            );
        }

        const payload = {
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
            // dedupKey is assigned by assignOccurrenceKeys() before export.
            // Transactions with identical business fields get distinct keys (baseFp vs baseFp|#2).
            external_id: transaction.dedupKey,
        };

        // NB: never log the payload (financial data) or the auth header (secret).
        let response;
        try {
            response = await fetch(apiUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`,
                },
                body: JSON.stringify(payload),
            });
        } catch (err) {
            // Network/TLS/DNS failure — strip any secret or secret-bearing URL.
            throw new Error(
                `Finance request failed: ${redactSecrets(err.message, [apiKey, apiUrl])}`
            );
        }

        if (!response.ok) {
            // The response body may echo sensitive data — redact + truncate it.
            const bodyText = await response.text().catch(() => "");
            const safeBody = bodyText ? ` — ${truncate(redactSecrets(bodyText, [apiKey]), 200)}` : "";
            throw new Error(
                `Failed to export "${transaction.merchantName}": HTTP ${response.status}${safeBody}`
            );
        }

        sent++;
    }

    logger.info(`Finance export sent ${sent} transaction(s)`);
    return { sent };
}
