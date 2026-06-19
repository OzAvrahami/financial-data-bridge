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

> Fetch is currently **simulated (mock)** but settings-driven — it resolves your
> real configured accounts and validated days-back and reports what would run.
> Real provider automation is wired in a later step.

## Credentials & where things are stored

Credentials are entered in the UI and never touch the repo:

| What | Where | Notes |
|------|-------|-------|
| Account settings (metadata, days back) | `accounts.config.json` (repo root) | Gitignored. Stores only a `credentialKey` reference — never passwords. |
| Credentials (username/password) | `<userData>/credentials.enc.json` | Outside the repo. Encrypted via **Electron `safeStorage`** (Windows DPAPI / macOS Keychain / Linux libsecret). |
| Runtime state (sessions, dedup "seen", checkpoints, exports) | `runtime/` | Gitignored local state, created on demand. |

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
