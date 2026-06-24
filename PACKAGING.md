# Packaging the Desktop App

This document explains how to build a distributable Windows build of **Financial
Data Bridge** with [electron-builder](https://www.electron.build/), where the
output lands, how to install/run it, and the important caveats.

## TL;DR

```bash
# Full Windows distributables (NSIS installer + portable .exe):
npm run dist:desktop:win

# Same, but for the current OS using electron-builder defaults:
npm run dist:desktop

# Unpacked build only (no installer) — fastest way to smoke-test:
npm run pack:desktop
```

All three first run `npm run bundle:browsers` to download the Playwright Chromium
that gets shipped inside the app (see [Playwright Chromium](#playwright-chromium)).

## Prerequisites

- Node.js + npm, and `npm install` already run in the repo.
- Windows is required to produce the Windows targets natively (this is what the
  scripts above assume). Building Windows installers from macOS/Linux needs Wine
  and is out of scope here.
- ~1.5 GB free disk: the bundled Chromium is ~550 MB and is copied into the
  installer payload.

## What gets built and where

The output directory is **`release/`** (configured in `electron-builder.yml`).
After `npm run dist:desktop:win` you get:

| File | What it is |
| --- | --- |
| `release/Financial Data Bridge-3.0.0-x64.exe` | **NSIS installer** — double-click to install. |
| `release/Financial Data Bridge-3.0.0-portable.exe` | **Portable** — runs without installing. |
| `release/win-unpacked/` | The unpacked app (what `pack:desktop` stops at). |
| `release/*.blockmap`, `release/latest.yml` | Updater/metadata sidecars. |

(The exact version number tracks `package.json`'s `version`.)

## Installing / running

- **Installer:** run `Financial Data Bridge-<version>-x64.exe`. It is a
  non–one-click NSIS installer, so you can choose the install directory. It
  creates Start Menu and desktop shortcuts.
- **Portable:** run `Financial Data Bridge-<version>-portable.exe` directly — no
  installation, good for a USB stick or a quick trial. It unpacks to a temp dir
  on each launch.
- **Unpacked (dev smoke test):** run
  `release/win-unpacked/Financial Data Bridge.exe`.

### Where the app stores your data

The installed app folder is **read-only**. All writable state lives under your
per-user Electron `userData` directory:

```
%APPDATA%\Financial Data Bridge\
├── settings.json            ← non-secret settings (days back, accounts, finance URL)
├── credentials.enc.json     ← OS-encrypted secrets (Windows DPAPI)
└── runtime\
    ├── exports\             ← fetched transaction JSON
    ├── sessions\            ← Playwright login sessions (auth cookies)
    ├── seen\               ← dedup fingerprints
    ├── checkpoints\
    ├── finance-ledger\     ← per-transaction finance-sync record
    └── reports\            ← finance-sync audit reports (JSON + CSV)
```

Nothing is written inside `Program Files` / the install directory. To fully reset
the app, delete `%APPDATA%\Financial Data Bridge`.

## Playwright Chromium

The app drives CAL with Playwright, which needs a real Chromium binary. On a
developer machine Playwright uses a browser it downloaded into the global
per-user cache (`%LOCALAPPDATA%\ms-playwright`). **That cache does not exist on a
fresh machine**, so a distributable must ship its own browser.

How this repo handles it:

1. `scripts/bundle-browsers.mjs` (run by every `dist:*` / `pack:*` script via
   `npm run bundle:browsers`) downloads Chromium — the full browser **and** the
   headless shell, pinned to the revision the installed Playwright requires —
   into **`./pw-browsers`** by setting `PLAYWRIGHT_BROWSERS_PATH` for the install.
2. `electron-builder.yml` ships that folder via `extraResources`, so it ends up at
   `…/resources/pw-browsers` inside the packaged app.
3. At runtime the Electron main process (`apps/desktop/runtimePaths.cjs`, wired in
   `apps/desktop/main.cjs`) sets `PLAYWRIGHT_BROWSERS_PATH` to that bundled folder
   **only when packaged** (`app.isPackaged`). In a dev checkout the global cache
   is used unchanged.

The result: **the installed app runs on a clean computer with no Playwright, no
`npx playwright install`, and no source checkout required.** Browser binaries are
bundled, not installed post-hoc.

> If you ever want a *smaller* installer instead, you could drop the bundled
> browser and require end users to run `npx playwright install chromium` after
> install — but that needs Node/npm on the target machine and internet access, so
> it is **not** used here. Bundling is the default precisely to keep the
> distributable self-contained.

## Known warning: unsigned app / Windows SmartScreen

These builds are **not code-signed**. On first run Windows SmartScreen will show
*"Windows protected your PC"*. This is expected for an unsigned app — to proceed
click **More info → Run anyway**. The installer may also trigger a UAC prompt.

To remove the warning you must sign the binaries with an authenticode
certificate (EV certificates avoid the SmartScreen reputation warm-up). That is a
manual, credential-bearing step and is intentionally not configured here.

## What must NOT be committed

These are generated/large/private and are covered by `.gitignore`:

- `release/` (and `dist-desktop/`) — build output, hundreds of MB, reproducible.
- `pw-browsers/` — the bundled Chromium (~550 MB), reproducible on demand.
- `runtime/` — local fetched data, sessions, checkpoints, ledgers, reports.
- `accounts.config.json`, `*.enc.json`, `.env*` — config and secrets.

Only the configuration that *produces* a build is committed: `electron-builder.yml`,
`scripts/bundle-browsers.mjs`, the `dist:*`/`pack:*` npm scripts, and the runtime
path wiring under `apps/desktop/`.
