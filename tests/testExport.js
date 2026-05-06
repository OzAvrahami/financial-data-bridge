import fs from "fs";
import path from "path";
import { exportToFinanceSystem } from "../src/application/exportToFinanceSystem.js";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
    try {
        const filePath = path.join(__dirname, "../exports/cal_2026-05-06.json");

        const raw = fs.readFileSync(filePath, "utf-8");

        const transactions = JSON.parse(raw);

        console.log("Loaded transactions:", transactions.length);

        await exportToFinanceSystem(transactions);

        console.log("Done");

    } catch (err) {
        console.error("Error:", err.message);
    } 
}

run();