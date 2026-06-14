# Financial Data Bridge

Automated financial-data tooling: logs into provider websites (CAL today; designed
for more), fetches and normalizes transactions, deduplicates them, writes JSON
exports, and can push them to a finance system. Runs as a CLI, an HTTP API, or a
local Desktop app.

## Repository layout

```
financial-data-bridge/
├─ apps/
│  ├─ cli/                # CLI entrypoint (npm run fetch / fetch:all)
│  │  └─ index.js
│  └─ desktop/            # Electron desktop app (npm run desktop)
│     ├─ main.cjs
│     ├─ preload.cjs
│     └─ renderer/        # index.html, styles.css, renderer.js
├─ packages/
│  └─ bridge-core/        # All reusable business logic
│     └─ src/
│        ├─ api/          # Express server (npm start)
│        ├─ application/  # use cases: fetchTransactions, fetchAllAccounts, export
│        ├─ config/       # source-account configuration
│        ├─ core/         # browser manager, provider registry, base provider
│        ├─ infrastructure/  # dedup, stores, retry, metrics, logger, migration
│        ├─ providers/    # provider implementations (cal/)
│        ├─ schema/       # transaction + run-report models
│        ├─ config.js
│        └─ exporter.js
├─ scripts/               # standalone scripts (exportToFinance.js)
├─ tests/                 # unit / integration / helpers / fixtures
├─ docs/                  # RUNBOOK.md, RAILWAY.md
├─ runtime/               # local state (gitignored): seen/ sessions/ checkpoints/ exports/
├─ accounts.config.example.json
├─ Dockerfile
├─ .env.example
└─ package.json
```

## Setup

```bash
npm install
cp .env.example .env   # then fill in CAL_USERNAME / CAL_PASSWORD
```

See **[docs/RUNBOOK.md](docs/RUNBOOK.md)** for the full operations guide and
**[docs/RAILWAY.md](docs/RAILWAY.md)** for deployment.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run fetch` | Fetch the default account (one-shot CLI). |
| `npm run fetch:all` | Fetch every configured source account sequentially. |
| `npm run desktop` | Open the local Electron desktop dashboard. |
| `npm start` | Start the HTTP API server. |
| `npm run export:finance -- --file runtime/exports/<file>.json` | Preview a finance export (dry-run). Add `--execute` to send. |
| `npm test` | Run the full test suite. |

## Multi-account configuration

Define multiple source accounts (per provider) via `SOURCE_ACCOUNTS` (inline JSON)
or an `accounts.config.json` file (copy `accounts.config.example.json`). Credentials
are referenced by env-var name, never inlined. With no config, the single default
CAL account is used. See docs/RUNBOOK.md.

## Runtime state

Local state (dedup "seen" state, sessions, checkpoints, exports) lives under
`runtime/` and is gitignored. Legacy root folders (`.seen/`, `.sessions/`,
`.checkpoints/`, `exports/`) are migrated automatically and non-destructively on
first run — see docs/RUNBOOK.md §7.1.

## Security

- `.env` and `accounts.config.json` are never committed and never read in the
  desktop renderer (only in the Node/main process).
- The desktop renderer is sandboxed (contextIsolation on, nodeIntegration off).

## License

MIT
