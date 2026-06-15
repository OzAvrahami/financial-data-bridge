# Runbook — Financial Data Bridge

Developer / operations notes for the **desktop-first** Financial Data Bridge.
End-user instructions live in the root `README.md`; this file is for developers.

## 1. What this project is

A desktop (Electron) app that drives a reusable engine (`packages/bridge-core`)
to log into a provider (CAL today), fetch + normalize + deduplicate transactions,
and export them. The **desktop app is the primary entry point**. A small CLI
(`apps/cli/index.js`) remains as a **developer fallback** that exercises real
provider automation from the terminal.

## 2. Prerequisites

- Node.js 18+ and npm.
- `npm install` (installs Playwright + Electron).
- First Playwright run may need browsers: `npx playwright install chromium`.

## 3. Run

```bash
npm run desktop        # the normal way to run the product
npm test               # full test suite
```

`npm run desktop` is the only command normal users need. The desktop app does not
use `.env` and stores credentials securely via the OS (see §4).

`dev:fetch` / `dev:fetch:all` are **advanced developer-only** commands — see §10.

## 4. Configuration & credentials

| Item | Location | Notes |
|------|----------|-------|
| Account metadata (provider, id, display name, enabled, default, days back) | `accounts.config.json` (repo root, gitignored) | Object form `{ daysBack, accounts:[…] }`. Stores a `credentialKey` reference — never secrets. See `accounts.config.example.json`. |
| Credentials (username/password) | `<userData>/credentials.enc.json` (e.g. `%APPDATA%\Financial Data Bridge\` on Windows) | Encrypted via Electron `safeStorage` (DPAPI/Keychain/libsecret). Outside the repo. **This is how all normal credentials are stored.** |
| Non-secret dev/runtime tweaks | `.env` (gitignored) | Optional. Holds NO credentials — only non-secret overrides (see `.env.example`). |

**Credential model (desktop):** the user enters username/password in
**Account Settings → Save Credentials**. The renderer sends them once to the
main process, which encrypts and stores them under the account's `credentialKey`.
The renderer only ever sees a **Saved / Not saved** status — never the saved
password. Saving overwrites; deleting an account prunes its stored credentials.
**Limitation:** the encrypted file is decryptable only by the same OS user on the
same machine; moved elsewhere, credentials must be re-entered.

## 5. Runtime state (`runtime/`)

Local, gitignored state created on demand:

| Folder | Purpose | Created by |
|--------|---------|------------|
| `runtime/seen/` | Dedup "seen" state (which transactions were already exported). | `SeenStore` |
| `runtime/sessions/` | Saved Playwright login state per provider/account. | `SessionStore` |
| `runtime/checkpoints/` | Mid-run checkpoints for resume. | `CheckpointStore` |
| `runtime/exports/` | Exported transaction JSON. | `exporter.js` |

Defaults come from `packages/bridge-core/src/config.js` and are individually
overridable via env (`SEEN_DIR`, `SESSION_DIR`, `CHECKPOINT_DIR`, `EXPORT_PATH`).
Legacy root locations (`.seen/`, `.sessions/`, `.checkpoints/`, `exports/`) are
no longer used; `runtimeMigration.js` non-destructively copies any leftovers into
`runtime/` on first CLI/real run.

## 6. Architecture

- **`apps/desktop`** — Electron app. `main.cjs` (trusted Node side + IPC),
  `preload.cjs` (sandboxed bridge), `renderer/` (UI), `credentialStore.cjs`
  (safeStorage credential store).
- **`apps/cli/index.js`** — developer CLI fallback over the engine.
- **`packages/bridge-core/src`** — the engine:
  - `application/` — use cases: `fetchTransactions`, `fetchAllAccounts`,
    `runFinanceExport`, `exportToFinanceSystem`.
  - `config/` — `config.js`, `sourceAccounts.js`, `appSettings.js`.
  - `providers/cal/` — CAL provider (auth, navigator, extractor, normalizer).
  - `infrastructure/` — dedup, stores, retry, metrics, logger, runtimeMigration.
  - `schema/` — transaction + run-report models.

No business logic lives in entry points — desktop, CLI, and tests all call the
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
`credentials.enc.json` / `*.enc.json`, `runtime/`, and the legacy `.seen/`,
`.sessions/`, `.checkpoints/`, `exports/`. Verify with:

```bash
git ls-files -ci --exclude-standard   # should be empty
```

## 9. Troubleshooting

- **Login stuck / 2FA** — run `npm run dev:fetch` with `HEADLESS=false` to watch
  the browser and complete 2FA manually the first time.
- **Everything re-exported** — the dedup "seen" state was reset/missing
  (`runtime/seen/`). Expected after clearing runtime state.
- **Credentials "Not saved" after entering them** — ensure OS secure storage is
  available; the Environment panel reports `secureStorage: available/unavailable`.
- **Desktop won't open** — run `npm install`, then `npm run desktop`; check the
  terminal for errors.

## 10. Advanced developer fallback (CLI) — not the normal path

> ⚠️ For maintainers/CI only. End users and normal setup should use the desktop
> app (`npm run desktop`); credentials belong in the OS-encrypted store, not here.

The CLI commands run real provider automation from the terminal:

```bash
npm run dev:fetch       # one-shot fetch of the default account
npm run dev:fetch:all   # fetch all enabled configured accounts
```

Because the CLI has no UI keychain, it reads credentials from environment
variables (e.g. via a local, gitignored `.env`). These are **intentionally absent
from `.env.example`** so the normal path never points users at file-based secrets.
To use the CLI fallback, a developer sets, in their own `.env`:

```dotenv
# single default account
CAL_USERNAME=...
CAL_PASSWORD=...
# optional account label
# CAL_ACCOUNT_ID=my_visa
```

For multiple accounts via the CLI, set `SOURCE_ACCOUNTS` (inline JSON) or
`ACCOUNTS_CONFIG` (file path) where each account's credentials are referenced by
**env-var name** (e.g. `"usernameEnv": "OZ_CAL_USERNAME"`), then define those
env vars — never inline secret values. The desktop app does not use any of this.
