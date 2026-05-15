import dotenv from 'dotenv';

dotenv.config();

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
            original_amount: transaction.amount,
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
