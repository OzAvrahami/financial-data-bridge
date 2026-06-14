# Deploying on Railway

## Start command

The production start command is `node packages/bridge-core/src/api/index.js`
(API mode). The Dockerfile `CMD` and `package.json` `start` script both point here.

Do **not** use `node apps/cli/index.js` (CLI mode) on Railway — it exits after one
run and Railway will restart it in a loop.

## Required environment variables

Set these in the Railway service's **Variables** panel:

```env
# Provider credentials
PROVIDER=cal
CAL_USERNAME=<your_cal_username>
CAL_PASSWORD=<your_cal_password>
CAL_ACCOUNT_ID=<optional_account_label>

# API security — always set in production
API_KEY=<strong-random-secret>

# Persistent state directories (must match the Volume mount below)
SESSION_DIR=/app/data/sessions
CHECKPOINT_DIR=/app/data/checkpoints
SEEN_DIR=/app/data/seen
EXPORT_PATH=/app/data/exports

# Browser
NODE_ENV=production
SLOW_MO=100
```

`SLOW_MO=100` adds a 100 ms delay between Playwright actions, reducing
machine-speed interaction patterns that banking sites may flag.

## Persistent Volume (required)

Railway containers have an ephemeral filesystem. Without a volume, session
cookies, dedup state, checkpoints, and exports are wiped on every restart.

1. In your Railway service → **Volumes** → **Add Volume**
2. Set the mount path to `/app/data`
3. Confirm the env vars above use `/app/data/...` paths

The application creates subdirectories automatically on first run.

## Triggering scrapes

The server exposes `POST /transactions/fetch`. Call it from an external
scheduler (Railway Cron service, GitHub Actions, etc.):

```bash
curl -X POST https://<your-service>.railway.app/transactions/fetch \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <your_api_key>" \
  -d '{"daysBack": 4}'
```

## Health check

```bash
curl https://<your-service>.railway.app/health
```

## Dockerfile image version

The Dockerfile uses `mcr.microsoft.com/playwright:v1.56.1-noble` which matches
the `@playwright/test@1.56.1` dependency in `package.json`. If you upgrade
Playwright, update both together.
