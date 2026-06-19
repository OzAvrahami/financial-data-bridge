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

**Financial System Integration:** enable/disable finance export, set the API
URL/endpoint, save/replace/delete the API key, and run **Test Connection** — all
from the desktop UI. When enabled, finance export runs automatically after each
fetch, sending qualifying transactions in memory (the key never touches disk in
plaintext). When disabled, fetching CAL transactions works without contacting the
finance API. Configuration comes entirely from the UI — **not** from `.env`.

## 5. Runtime state (`runtime/`)

Local, gitignored state created on demand under `runtime/`:

| Folder | Purpose | Created by |
|--------|---------|------------|
| `runtime/seen/` | Dedup "seen" state (which transactions were already exported). | `SeenStore` |
| `runtime/sessions/` | Saved Playwright login state per provider/account. | `SessionStore` |
| `runtime/checkpoints/` | Mid-run checkpoints for resume. | `CheckpointStore` |
| `runtime/exports/` | Exported transaction JSON. | `exporter.js` |

Defaults come from `packages/bridge-core/src/config.js`. The folder is kept in
git via `runtime/.gitkeep`; its contents are ignored.

## 6. Architecture

- **`apps/desktop`** — Electron app. `main.cjs` (trusted Node side + IPC),
  `preload.cjs` (sandboxed bridge), `renderer/` (UI), `credentialStore.cjs`
  (safeStorage credential store).
- **`packages/bridge-core/src`** — the engine:
  - `application/` — use cases: `fetchTransactions`, `fetchAllAccounts`,
    `runFinanceExport`, `exportToFinanceSystem`.
  - `config/` — `config.js`, `sourceAccounts.js`, `appSettings.js`.
  - `providers/cal/` — CAL provider (auth, navigator, extractor, normalizer).
  - `infrastructure/` — dedup, stores, retry, metrics, logger.
  - `schema/` — transaction + run-report models.

No business logic lives in entry points — the desktop and tests all call the
`application/` use cases.

## 7. Engine notes

- **Dedup identity** is occurrence-aware: `assignOccurrenceKeys()` assigns each
  transaction a `dedupKey`, reused as the finance system's `external_id`.
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
