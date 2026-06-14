import dotenv from 'dotenv';
import { parseAmount } from '../providers/cal/normalizer.js';

dotenv.config();

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

export async function exportToFinanceSystem(transactions) {
    if (!Array.isArray(transactions)) {
        throw new Error("Expected transactions to be an array");
    }

    const apiUrl = process.env.FINANCE_API_URL;
    const apiKey = process.env.FINANCE_API_KEY;

    if (!apiUrl) throw new Error("Missing FINANCE_API_URL");
    if (!apiKey) throw new Error("Missing FINANCE_API_KEY");

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

        console.log("Sending payload:", JSON.stringify(payload, null, 2));

        const response = await fetch(apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Failed to export transaction "${transaction.merchantName}": ${response.status} ${errorText}`
            );
        }

        console.log("Exported transaction:", transaction.merchantName);
    }
}
