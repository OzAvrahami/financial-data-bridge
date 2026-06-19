# Financial Data Bridge

A **desktop application** that logs into your financial provider (CAL today;
multi-provider by design), fetches and deduplicates transactions, and can export
them. Built with **Electron** on top of a reusable **bridge-core** engine.

The desktop app is the only way to use this project. There is no terminal
workflow to learn — you add accounts, enter credentials, and run from the window.

## Run the desktop app

```bash
npm install      # once (Electron is a devDependency)
npm run desktop
```

A window opens with: **Environment**, **Source Accounts**, **Fetch Settings**
(days back), **Account Settings** (add/edit/delete accounts, enter username &
password directly), **Actions**, a **Last Run Summary**, and a **Run Log**.

> **Fetch runs real provider automation.** Clicking **Fetch Default Account** or
> **Fetch All Accounts** logs into the provider (CAL) with your saved credentials
> via Playwright, fetches and deduplicates transactions, and writes exports under
> `runtime/exports/`. Credentials are decrypted in the main process and passed to
> the engine in memory only — never to the renderer, the config file, or logs.
> Progress streams to the Run Log; only one run executes at a time.

## Credentials & where things are stored

Credentials are entered in the UI and never touch the repo:

| What | Where | Notes |
|------|-------|-------|
| App settings (days back, accounts, finance config) | `<userData>/settings.json` | Outside the repo. Stores only `credentialKey` references — never secrets. Auto-migrated from a legacy repo-root `accounts.config.json` on first run (legacy file copied, never deleted). |
| Credentials (CAL username/password) and finance API key | `<userData>/credentials.enc.json` | Outside the repo. Encrypted via **Electron `safeStorage`** (Windows DPAPI / macOS Keychain / Linux libsecret). |
| Runtime state (sessions, dedup "seen", checkpoints, exports) | `runtime/` | Gitignored local state, created on demand. |

**Financial System Integration:** the **Financial System Integration** panel lets
you enable/disable finance export, set the API URL, save/replace/delete the API
key (encrypted by the OS), and run **Test Connection**. When enabled, finance
export runs automatically after each fetch. All of this is configured in the UI —
the app does **not** read finance settings from `.env`.

**Credential security:** passwords are entered in the UI, sent once to the
Electron main process, and stored **encrypted by the OS**. The renderer never
receives a saved password back — only a “Saved / Not saved” status. The encrypted
file is decryptable only by the same OS user on the same machine.

## Repository layout

```
apps/
  desktop/         # Electron app (main.cjs, preload.cjs, renderer/, credentialStore.cjs)
packages/
  bridge-core/src/ # engine: application/, providers/, config/, infrastructure/, schema/, …
tests/             # unit + integration
runtime/           # local state (gitignored)
docs/RUNBOOK.md    # developer/maintainer notes
accounts.config.example.json
```

## Commands

| Command | Purpose |
|---------|---------|
| `npm run desktop` | **Run the app. This is the normal command.** |
| `npm test` | Run the full test suite. |
| `npm run test:unit` / `npm run test:integration` | Run a subset. |

See **[docs/RUNBOOK.md](docs/RUNBOOK.md)** for developer/maintainer notes.

## License

MIT
