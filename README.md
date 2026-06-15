# Financial Data Bridge

A **desktop application** that logs into your financial provider (CAL today;
multi-provider by design), fetches and deduplicates transactions, and can export
them. Built with **Electron** on top of a reusable **bridge-core** engine.

The desktop app is the primary, user-facing entry point — non-technical users do
not need to edit files or run terminal commands.

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

## Where things are stored

| What | Where | Notes |
|------|-------|-------|
| Account settings (metadata, days back) | `accounts.config.json` (repo root) | Gitignored. Stores only a `credentialKey` reference — never passwords. |
| Credentials (username/password) | `<userData>/credentials.enc.json` | Outside the repo. Encrypted via **Electron `safeStorage`** (Windows DPAPI / macOS Keychain / Linux libsecret). |
| Runtime state (sessions, dedup "seen", checkpoints, exports) | `runtime/` | Gitignored local state. |

**Credential security:** passwords are entered in the UI, sent once to the
Electron main process, and stored **encrypted by the OS**. The renderer never
receives a saved password back — only a “Saved / Not saved” status. The encrypted
file is decryptable only by the same OS user on the same machine.

## Repository layout

```
apps/
  desktop/         # Electron app (main.cjs, preload.cjs, renderer/, credentialStore.cjs)
  cli/             # developer CLI fallback (apps/cli/index.js)
packages/
  bridge-core/src/ # engine: application/, providers/, config/, infrastructure/, schema/, …
tests/             # unit + integration
runtime/           # local state (gitignored)
docs/RUNBOOK.md    # developer/operations notes
accounts.config.example.json
.env.example       # developer-only fallback config
```

## Developer commands

| Command | Purpose |
|---------|---------|
| `npm run desktop` | **Run the app. This is the normal command.** |
| `npm test` | Run the full test suite. |
| `npm run test:unit` / `npm run test:integration` | Run a subset. |

There are also two **advanced developer-only** CLI commands
(`dev:fetch` / `dev:fetch:all`) that run real provider automation from the
terminal. They are **not** part of normal use, require maintainer-managed env
configuration, and are documented in
**[docs/RUNBOOK.md → Advanced developer fallback](docs/RUNBOOK.md)**.

See **[docs/RUNBOOK.md](docs/RUNBOOK.md)** for deeper developer/ops notes.

## License

MIT
