# Runbook — Financial Data Bridge

Developer / maintainer notes for the **desktop** Financial Data Bridge.
End-user instructions live in the root `README.md`; this file is for people
working on the code.

## 1. What this project is

A desktop (Electron) app that drives a reusable engine (`packages/bridge-core`)
to log into a provider (CAL today), fetch + normalize + deduplicate transactions,
and export them. The desktop app is the only entry point; all business logic
lives in the engine's `application/` use cases, which the desktop (and tests)
call.

## 2. Prerequisites

- Node.js 18+ and npm.
- `npm install` (installs Playwright + Electron).
- First Playwright run may need browsers: `npx playwright install chromium`.

## 3. Run

```bash
npm run desktop        # run the app
npm test               # full test suite
```

`npm run desktop` is all that is needed to run the product. The desktop app does
not require a `.env` file and stores credentials securely via the OS (see §4).

## 4. Configuration & credentials

| Item | Location | Notes |
|------|----------|-------|
| App settings (days back, accounts, finance `{enabled, apiUrl, credentialKey}`) | `<userData>/settings.json` (e.g. `%APPDATA%\Financial Data Bridge\` on Windows) | Object form `{ daysBack, accounts:[…], finance:{…} }`. Stores `credentialKey` references — never secrets. Migrated automatically from a legacy repo-root `accounts.config.json` on first run (the legacy file is copied, never deleted). |
| Credentials (CAL username/password) | `<userData>/credentials.enc.json` | Encrypted via Electron `safeStorage` (DPAPI/Keychain/libsecret). Outside the repo. |
| Finance API key/token | `<userData>/credentials.enc.json` (under the finance `credentialKey`) | Encrypted via Electron `safeStorage`. Never written to settings, logs, exports, or errors. |

**Credential model:** the user enters CAL username/password in **Account Settings
→ Save Credentials**, and the finance API key in **Financial System Integration →
Save Key**. The renderer sends each secret once to the main process, which encrypts
and stores it under its `credentialKey`. The renderer only ever sees a **Saved /
Not saved** status — never the saved secret. Saving overwrites; deleting prunes.
**Limitation:** the encrypted file is decryptable only by the same OS user on the
same machine; moved elsewhere, secrets must be re-entered.

**Financial System Integration:** enable/disable the integration, set the API
URL/endpoint, save/replace/delete the API key, and run **Test Connection** — all
from the desktop UI. Configuration comes entirely from the UI — **not** from `.env`.

**Two explicit run modes (finance is never sent implicitly):**

- **Fetch Only** (the **Fetch All / Fetch Default** buttons): fetch from CAL,
  deduplicate, and write the local export. The finance API is **never contacted**;
  every transaction's finance status for the run is `not_attempted` with reason
  `run_mode_fetch_only`.
- **Sync to Finance** (the **Sync All / Sync Default** buttons, in the Financial
  System Integration card): fetch, save locally, **then** run the ledger-aware
  finance sync. These buttons stay disabled until the integration is enabled and
  both the API URL and API key are saved. The API key is held in memory only (it
  never touches disk in plaintext).

**Finance sync is decoupled from local dedup.** Local `new/updated/unchanged`
status answers "did the local export change?", **not** "did finance accept it?".
The sync engine therefore evaluates **every** considered transaction against a
dedicated **finance sync ledger** (see §5), so:

- an unchanged-locally transaction that was never sent to finance is still sent;
- a transaction that failed a prior finance send is retried;
- a transaction with a prior successful send is `already_sent` (not resent);
- an already-sent transaction whose local content later changed is **flagged for
  review** (`already_sent_content_changed`) rather than resent, because the finance
  API's idempotency is unverified and resending could create a duplicate.

**Idempotency:** each send includes `external_id` = the transaction `dedupKey`, so
the finance system *could* dedupe on it, but the app does **not** rely on that. The
local finance sync ledger is the authoritative "already sent" record; only
transactions without a prior successful-send record are sent.

**Audit report:** every Sync to Finance run writes a per-transaction report (JSON +
CSV) to `runtime/reports/finance-sync-<runId>.{json,csv}`, with one row per
considered transaction (`localDedupStatus`, `financeStatus`, `reason`, `apiStatus`,
`financeTransactionId`, `dedupKey`, …). Use **Open Last Report** to reveal it.

## 5. Runtime state (`runtime/`)

Local, gitignored state created on demand under `runtime/`:

| Folder | Purpose | Created by |
|--------|---------|------------|
| `runtime/seen/` | Dedup "seen" state (which transactions were already exported). | `SeenStore` |
| `runtime/sessions/` | Saved Playwright login state per provider/account. | `SessionStore` |
| `runtime/checkpoints/` | Mid-run checkpoints for resume. | `CheckpointStore` |
| `runtime/exports/` | Exported transaction JSON. | `exporter.js` |
| `runtime/finance-ledger/` | Per-transaction finance sync state (was it accepted by finance?), one file per provider+account. Authoritative "already sent" record, independent of `seen/`. | `FinanceLedger` |
| `runtime/reports/` | Per-run finance sync audit reports (JSON + CSV). | `financeReport.js` |

Defaults come from `packages/bridge-core/src/config.js`. The folder is kept in
git via `runtime/.gitkeep`; its contents are ignored.

## 6. Architecture

- **`apps/desktop`** — Electron app. `main.cjs` (trusted Node side + IPC),
  `preload.cjs` (sandboxed bridge), `renderer/` (UI), `credentialStore.cjs`
  (safeStorage credential store).
- **`packages/bridge-core/src`** — the engine:
  - `application/` — use cases: `fetchTransactions`, `fetchAllAccounts`,
    `runFinanceExport`, `exportToFinanceSystem`, `syncTransactionsToFinance`
    (the ledger-aware finance sync engine).
  - `config/` — `config.js`, `sourceAccounts.js`, `appSettings.js`.
  - `providers/cal/` — CAL provider (auth, navigator, extractor, normalizer).
  - `infrastructure/` — dedup, stores (incl. `FinanceLedger`), `financeReport`,
    retry, metrics, logger.
  - `schema/` — transaction + run-report models.

No business logic lives in entry points — the desktop and tests all call the
`application/` use cases.

## 7. Engine notes

- **Fetch scope — `daysBack` is authoritative.** The entire requested date range
  is always scanned end to end; the seen/dedup state decides only whether a
  transaction is *exported*, never whether scanning continues. There is no
  consecutive-unchanged "early stop". Increasing `daysBack` re-inspects the larger
  window, so previously missed, newly finalized (previously pending), or modified
  transactions anywhere inside it are discovered. Normalization, pending filtering,
  dedup, and export decisions are applied only after the full range is read.
- **Dedup identity** is occurrence-aware: `assignOccurrenceKeys()` assigns each
  transaction a `dedupKey`, reused as the finance system's `external_id`.
- **Local dedup vs finance sync are separate concerns.** `fetchTransactions`
  returns both `transactions` (the local-export set: created + updated) and
  `consideredTransactions` (every transaction inspected, each tagged with
  `localDedupStatus`). Finance sync consumes the latter and decides what to send
  using the `FinanceLedger`, never the local dedup status.
- **Multi-account scoping:** session/seen/checkpoint state and exports are keyed
  by `provider` + `providerAccountId`, so accounts never collide.
- **Pending/unfinalized transactions are skipped at extraction** and reported
  separately (`report.pendingSkippedCount`).
- **Safe writes:** exports use write-to-`.tmp`-then-rename.

## 8. Privacy / git hygiene

Never tracked (see `.gitignore`): `.env`, `accounts.config.json`,
`credentials.enc.json` / `*.enc.json`, and `runtime/`. Verify with:

```bash
git ls-files -ci --exclude-standard   # should be empty
```

## 9. Troubleshooting

- **Everything re-exported** — the dedup "seen" state was reset/missing
  (`runtime/seen/`). Expected after clearing runtime state.
- **Credentials "Not saved" after entering them** — ensure OS secure storage is
  available; the Environment panel reports `secureStorage: available/unavailable`.
- **Desktop won't open** — run `npm install`, then `npm run desktop`; check the
  terminal for errors.
