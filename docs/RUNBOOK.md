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
| Account metadata (provider, id, display name, enabled, default, days back) | `accounts.config.json` (repo root, gitignored) | Object form `{ daysBack, accounts:[…] }`. Stores a `credentialKey` reference — never secrets. See `accounts.config.example.json`. |
| Credentials (username/password) | `<userData>/credentials.enc.json` (e.g. `%APPDATA%\Financial Data Bridge\` on Windows) | Encrypted via Electron `safeStorage` (DPAPI/Keychain/libsecret). Outside the repo. **This is how all credentials are stored.** |

**Credential model:** the user enters username/password in **Account Settings →
Save Credentials**. The renderer sends them once to the main process, which
encrypts and stores them under the account's `credentialKey`. The renderer only
ever sees a **Saved / Not saved** status — never the saved password. Saving
overwrites; deleting an account prunes its stored credentials.
**Limitation:** the encrypted file is decryptable only by the same OS user on the
same machine; moved elsewhere, credentials must be re-entered.

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
