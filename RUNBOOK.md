# Runbook — CAL Automation

> Practical, command-by-command guide for running this project.
> Everything below is based on the actual code in this repo (not the README, which
> describes an older single-file version). Where the code and README disagree, the
> code wins and is noted.

---

## 1. What this project does

This is a **financial data bridge** (`package.json` name: `financial-data-provider`, v3.0.0).
It automates pulling credit-card transactions from the **CAL** (Cal Online) website and
moving them into your own finance system.

End to end it:

1. Logs in to `https://www.cal-online.co.il` using Playwright (a headless Chromium browser).
2. Navigates to the "transactions by date" page and filters to the last few days.
3. Opens each transaction, extracts and normalizes the details.
4. Deduplicates against previously-seen transactions (so reruns don't re-export the same rows).
5. Writes the new/changed transactions to a JSON file in `exports/`.
6. Separately, a second command reads that JSON file and **pushes the transactions to your
   finance API** (`exportToFinanceSystem`).

There are **two ways to run it**:
- **CLI mode** — one-shot fetch (`node index.js`), good for running locally on demand.
- **API mode** — a long-running Express server (`node src/api/index.js`) that fetches on an
  HTTP request. This is the production/Railway mode.

The fetch step and the finance-export step are **separate commands** — fetching does not
automatically push to your finance system.

---

## 2. Prerequisites

| Requirement | Detail |
|-------------|--------|
| Node.js | Project uses ES modules (`"type": "module"`) and built-in `fetch`. Use **Node.js 18+** (the README says 14+, but `fetch` in `exportToFinanceSystem.js` requires Node 18+). |
| npm | Comes with Node. Used for install + run scripts. |
| Browser | **Chromium**, installed via Playwright (`BrowserManager` calls `chromium.launch`). |
| Playwright | `@playwright/test@^1.56.1` (already in `package.json` dependencies). |
| CAL account | A valid Cal Online username + password. May require manual 2FA the first time. |
| Finance system API | A reachable finance API endpoint + bearer key (only needed for the `export:finance` step). |

---

## 3. First-time setup

Run these once, in the project root (`D:\code\financial-data-bridge`):

```powershell
# 1. Install dependencies
npm install

# 2. Install the Chromium browser Playwright drives
npx playwright install chromium

# 3. Create your .env from the template (a .env already exists in this repo; only do
#    this if you need a fresh one)
copy .env.example .env
```

Then edit `.env` and fill in at least `CAL_USERNAME` and `CAL_PASSWORD` (see section 4).

> Note: `.env.example` already exists in the project, so no new example file was created.

---

## 4. Environment variables

All variables are read in `src/config.js` (via `dotenv`) and in `scripts/exportToFinance.js`
/ `src/application/exportToFinanceSystem.js`. Do **not** put real secrets in `.env.example`
or in git — `.env` is gitignored.

### Required for fetching

| Variable | Used for | Default |
|----------|----------|---------|
| `CAL_USERNAME` | CAL login username. Fetch fails without it. | _(none)_ |
| `CAL_PASSWORD` | CAL login password. Fetch fails without it. | _(none)_ |

### Required only for `export:finance --execute`

| Variable | Used for | Default |
|----------|----------|---------|
| `FINANCE_API_URL` | The finance system endpoint transactions are POSTed to. | _(none — required at execute time)_ |
| `FINANCE_API_KEY` | Bearer token sent as `Authorization: Bearer <key>`. | _(none — required at execute time)_ |

> `FINANCE_API_URL` / `FINANCE_API_KEY` are **not** listed in `.env.example` but are
> required by the export step. Add them to your `.env` manually.

### Optional (have defaults)

| Variable | Used for | Default |
|----------|----------|---------|
| `PROVIDER` | Which provider to use. Only `cal` is implemented. | `cal` |
| `CAL_ACCOUNT_ID` | Label for this account; appears in session + export filenames. | `default` |
| `HEADLESS` | `true` = no visible browser window; `false` = watch it run (debugging). | `true` |
| `SLOW_MO` | Milliseconds of delay between browser actions (debugging / anti-bot). | `0` |
| `DAYS_BACK` | How many days back to fetch. | `4` |
| `INCREMENTAL` | Stop early once enough consecutive already-seen rows are found. | `true` |
| `EARLY_STOP_THRESHOLD` | Consecutive already-seen rows before stopping. | `10` |
| `EXPORT_PATH` | Folder for exported JSON files. | `exports` |
| `SESSION_DIR` | Folder for saved login sessions (auth cookies). | `.sessions` |
| `CHECKPOINT_DIR` | Folder for mid-run checkpoints (for `--resume`). | `.checkpoints` |
| `SEEN_DIR` | Folder for dedup "seen" state. | `.seen` |
| `API_PORT` | Port for the Express API server. | `3000` |
| `API_KEY` | If set, API requests must send a matching `X-API-Key` header. Empty = open. | _(empty)_ |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`. | `info` |
| `DEBUG` | `true` forces log level to `debug` and prints stack traces. | `false` |
| `ACCOUNT_ID` | Same as the `--account` CLI flag; overrides the provider's accountId. | _(empty)_ |

---

## 5. Normal run command

The everyday "pull my latest CAL transactions" command:

```powershell
npm run fetch
```

This runs `node index.js` (CLI mode). It logs in (or reuses a saved session), fetches the
last `DAYS_BACK` days (default 4), deduplicates, and writes new/changed transactions to
`exports/`.

To then push those transactions to your finance system, see section 8
(`npm run export:finance`). Fetching alone does **not** send anything to the finance API.

---

## 6. Execution flow

This is the real flow as implemented in `src/application/fetchTransactions.js` and
`src/providers/cal/`:

1. **Load config + credentials** (`src/config.js`). If `CAL_USERNAME`/`CAL_PASSWORD` are
   missing, the run fails immediately with a clear error.
2. **(Optional) load checkpoint** — only if `--resume` is passed; lets a previously
   interrupted run continue from where it stopped.
3. **Load "seen" dedup state** — unless `--full-fetch` is passed.
4. **Launch Chromium** and try to **restore a saved session** from `.sessions/`.
5. **Validate session** — visits the CAL homepage and checks for the authenticated nav
   element. If valid, login is skipped. If not, it performs a **fresh login** (with one
   retry) and saves the new session.
6. **Navigate** to "transactions by date" and **apply the date filter** (`DAYS_BACK`).
7. **Iterate each transaction row**: open its modal, extract the data, normalize it. After
   each row a checkpoint is saved and incremental early-stop is evaluated.
   - If the session drops mid-run, it detects the auth error, **re-authenticates once**, and
     resumes the fetch.
8. **Skip pending/unfinalized transactions.** After opening each detail panel, the
   extractor checks for CAL's "not finalized yet" markers (e.g. *הסכום לא סופי*,
   *העסקה עדיין לא נקלטה*, *עדיין בתהליך קליטה*). Such rows are **not exported** (their
   amount can still change) and are counted separately in the summary as `Pending: N
   skipped (unfinalized)`.
9. **Deduplicate** the remaining rows into created / updated / unchanged. Only created +
   updated are exported.
10. **Export** the created/updated transactions to `exports/<provider>[_<account>]_<YYYY-MM-DD>.json`
   (via a safe write-then-rename in `src/exporter.js`). If nothing is new, no file is written.
11. **Update the seen store**, **clear the checkpoint** (run completed), and **print a run
    summary** to the log.
12. **Finance sync is a separate step** — run `npm run export:finance` against the exported
    JSON file to POST transactions to `FINANCE_API_URL`.

---

## 7. Output folders and files

| Folder | What's in it | Created by |
|--------|--------------|------------|
| `exports/` | Exported transaction JSON, named `<provider>[_<account>]_<YYYY-MM-DD>.json` (e.g. `cal_2026-06-01.json`). This is the file you feed to `export:finance`. | `src/exporter.js` |
| `.sessions/` | Saved Playwright login state (auth cookies) per provider/account. Gitignored. Deleting forces a fresh login. | `SessionStore` |
| `.checkpoints/` | Mid-run progress checkpoints used by `--resume`. Cleared on a successful run. | `CheckpointStore` |
| `.seen/` | Deduplication state — which transactions have already been exported. | `SeenStore` |

**Logs**: there is no log *file*. Logs are written to **stdout/stderr** by
`src/infrastructure/logger.js` (errors → stderr, everything else → stdout). To save them,
redirect output yourself, e.g. `npm run fetch *> run.log` (PowerShell). Passwords and
tokens are automatically redacted from log metadata.

---

## 8. Useful commands

| Purpose | Command | When to use it |
|---------|---------|----------------|
| Fetch latest transactions (CLI) | `npm run fetch` | Normal daily/on-demand pull. |
| Fetch for a specific account | `node index.js --account my_visa` | When you run more than one CAL account. |
| Resume an interrupted run | `node index.js --resume` | A previous run crashed/was stopped partway. |
| Full re-fetch (ignore dedup) | `node index.js --full-fetch` | Re-export everything, ignoring the seen store. |
| Preview finance export (dry-run) | `npm run export:finance -- --file exports/cal_2026-06-01.json` | Always run first — shows what would be sent, sends nothing. |
| Send to finance system (real) | `npm run export:finance -- --file exports/cal_2026-06-01.json --execute` | After verifying the dry-run; requires `FINANCE_API_URL` + `FINANCE_API_KEY`. |
| Start the API server | `npm start` | Production/long-running mode; exposes HTTP endpoints. |
| Trigger a fetch via the API | `curl -X POST http://localhost:3000/transactions/fetch -H "Content-Type: application/json" -d '{\"daysBack\":4}'` | When running in API mode. Add `-H "X-API-Key: <key>"` if `API_KEY` is set. |
| API health check | `curl http://localhost:3000/health` | Confirm the server is up. |
| API run metrics | `curl http://localhost:3000/metrics` | See in-memory run stats (resets on restart). |
| Clean generated output for a fresh test | `Remove-Item exports\*.json, exports\*.json.tmp -Force; Remove-Item logs\debug\* -Recurse -Force -ErrorAction SilentlyContinue` | Wipe previous exports + debug artifacts before re-running. Does **not** touch `.env`, `.sessions/`, `.seen/`, or `.checkpoints/`. |
| Run all tests | `npm test` | Verify code after changes. |
| Run unit tests only | `npm run test:unit` | Faster feedback loop. |
| Run integration tests only | `npm run test:integration` | Exercise the fetch/resume/api flows. |

> Note the `--` in `npm run export:finance -- --file ...`: npm needs `--` to pass flags
> through to the script.

### CLI vs API — which run command?

- **`npm run fetch` (`node index.js`)** — runs once and exits. Use locally / on demand.
- **`npm start` (`node src/api/index.js`)** — starts a server that runs until stopped and
  fetches on `POST /transactions/fetch`. Use for deployment (see `RAILWAY.md`). Do **not**
  use the CLI command as a long-running service; it exits after one run.

---

## 9. How to verify a successful run

After `npm run fetch`:

1. **Read the run summary** printed at the end (`Run summary ...`). Check `Status:` is
   `success` (or `partial` if some rows were skipped — see the listed warnings).
2. **Look in `exports/`** for a freshly dated file (`cal_<today>.json`). If the summary says
   "No new or updated transactions to export", that's normal — it means nothing changed
   since the last run.
3. The summary also reports `Created`, `Updated`, `Unchanged`, `Duplicates`, whether the
   session was reused, and where the file was exported.
4. Exit code is `0` on success and `1` on failure.

After `npm run export:finance ... --execute`:

- You should see `Sending payload:` / `Exported transaction:` lines per transaction and a
  final `Done. All qualifying transactions sent successfully.` Any HTTP failure throws and
  stops with a non-zero exit code.

After `npm start` (API mode):

- `curl http://localhost:3000/health` returns `{"status":"ok",...}`.

---

## 10. Common issues and fixes

**Login failed / stuck at login**
- Verify `CAL_USERNAME` / `CAL_PASSWORD` in `.env` are correct.
- CAL may require 2FA. Run with a visible browser to complete it manually:
  set `HEADLESS=false` in `.env`, then `npm run fetch`.
- The code clears the stored session automatically on known auth failures. You can also
  manually delete the `.sessions/` folder to force a clean login.

**Missing environment variable**
- "Missing credentials for provider cal" → set `CAL_USERNAME` and `CAL_PASSWORD`.
- "FINANCE_API_URL is not set" / "FINANCE_API_KEY is not set" → add both to `.env` before
  running `export:finance --execute`.

**Browser / driver problem**
- "Executable doesn't exist" or browser launch errors → run `npx playwright install chromium`.
- On Linux/containers, sandbox errors are mitigated by the built-in
  `--no-sandbox --disable-dev-shm-usage` args; ensure the Playwright base image matches the
  Playwright version (see `RAILWAY.md`).

**File was not downloaded / no export file appeared**
- If the summary says "No new or updated transactions to export", nothing changed — this is
  expected. To force a full re-export, run `node index.js --full-fetch`.
- If you expected older transactions, increase the window: set `DAYS_BACK` higher (e.g.
  `DAYS_BACK=30`) or pass it via the API body.
- Watch the run to debug extraction: `HEADLESS=false` and `SLOW_MO=200`, plus `DEBUG=true`
  for verbose logs.

**Upload / sync to finance system failed**
- The error includes the HTTP status and response body
  (`Failed to export transaction "...": <status> <body>`). Check `FINANCE_API_URL`,
  `FINANCE_API_KEY`, and that the endpoint accepts the payload shape in
  `src/application/exportToFinanceSystem.js`.
- Only transactions with `status === "completed"` and `chargeAmount > 0` are sent; pending
  rows are skipped by design. Run the dry-run first to see counts.

**Permissions problem**
- If exports/session/checkpoint folders can't be written, ensure the process can write to
  the project directory (or the `*_DIR` / `EXPORT_PATH` paths you configured). The app
  creates these folders automatically when it has permission.

**Network / session problem**
- Mid-run session loss is handled: the app re-authenticates once and continues. If it still
  fails, the checkpoint is preserved — rerun with `node index.js --resume`.
- For flaky network, the login and navigation steps already retry once automatically.

**API returns 401**
- `API_KEY` is set, so requests must include a matching `X-API-Key` header.

---

## 11. Developer notes

- **README is outdated.** `README.md` (Hebrew) describes a v1 single-file layout
  (`fetch-transactions.js`, `utils/calClient.js`) that no longer exists. The real entry
  points are `index.js` (CLI) and `src/api/index.js` (API). Trust this runbook + the code.
- **No business logic in entry points.** Both CLI and API call the single use case
  `fetchTransactions()` in `src/application/fetchTransactions.js`.
- **Provider pattern.** Providers register themselves via a side-effect import
  (`src/providers/index.js`) into `providerRegistry`. Only `cal` is implemented; `max` is
  stubbed in comments for future extension.
- **Headless default is `true`** in code (`src/config.js`), contradicting the README which
  says it runs visibly. Set `HEADLESS=false` to watch it.
- **Dedup identity** is occurrence-aware: `assignOccurrenceKeys()` gives each transaction a
  `dedupKey`, which is reused as the finance system's `external_id` for idempotent upserts.
- **Anti-bot measures** in `BrowserManager`: `he-IL` locale, a real-looking user agent, and
  a `navigator.webdriver = undefined` init script. `SLOW_MO` further humanizes timing.
- **Safe writes.** Exports use write-to-`.tmp`-then-rename so a crash never leaves a
  half-written JSON file.
- **Pending/unfinalized transactions are skipped at extraction** (`src/providers/cal/extractor.js`).
  `detectPendingMarker()` matches CAL's Hebrew markers read from `.info-section`,
  `.info-section .descrition` (CAL's class is spelled `descrition`), and `.payee-name`
  (falling back to the full panel text). Skips never reach the export and are reported as
  `report.pendingSkippedCount` (CLI summary line `Pending: N skipped`), separate from
  extraction failures and unchanged/duplicate rows.
- **Finance export is intentionally a separate, opt-in step** and defaults to dry-run.
  Real sends require the explicit `--execute` flag.
- **Deployment**: see `RAILWAY.md`. Production uses API mode with a persistent volume at
  `/app/data` so `.sessions`, `.checkpoints`, `.seen`, and `exports` survive restarts.

---

## Summary

**Files created**
- `RUNBOOK.md` (this file).
- `.env.example` was **not** created — it already exists in the project.

**Main run command**
- `npm run fetch` (one-shot CLI fetch → writes JSON to `exports/`).
- Then `npm run export:finance -- --file exports/<file>.json --execute` to push to your
  finance system.

**Details you must fill in manually**
- `.env`: real `CAL_USERNAME` and `CAL_PASSWORD`.
- `.env`: `FINANCE_API_URL` and `FINANCE_API_KEY` (required for the finance export step;
  not present in `.env.example`).
- Confirm your Node.js version is **18+** (needed for built-in `fetch`).
- The finance system's expected payload/response contract — verify it matches
  `src/application/exportToFinanceSystem.js` before doing a real `--execute`.
