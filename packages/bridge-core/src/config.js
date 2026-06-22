import dotenv from 'dotenv';

dotenv.config();

const env = (key, fallback = '') => process.env[key] ?? fallback;

export const config = {
  provider: env('PROVIDER', 'cal'),

  credentials: {
    cal: {
      username:  env('CAL_USERNAME'),
      password:  env('CAL_PASSWORD'),
      // Identifies which account/card profile this is. Used in session filenames
      // and export filenames so multiple accounts don't collide.
      accountId: env('CAL_ACCOUNT_ID', 'default'),
    },
    // To add MAX:
    // max: { username: env('MAX_USERNAME'), password: env('MAX_PASSWORD'), accountId: env('MAX_ACCOUNT_ID', 'default') },
  },

  browser: {
    headless: env('HEADLESS', 'true') === 'true',
    slowMo:   parseInt(env('SLOW_MO', '0'), 10),
  },

  fetch: {
    // The full requested date range is always scanned end to end; there is no
    // early-stop. daysBack is authoritative for how far back to fetch.
    daysBack: parseInt(env('DAYS_BACK', '4'), 10),
  },

  // Runtime/local state lives under runtime/ (gitignored). Each path remains
  // individually overridable via env for development.
  export: {
    path: env('EXPORT_PATH', 'runtime/exports'),
  },

  session: {
    storageDir: env('SESSION_DIR', 'runtime/sessions'),
  },

  checkpoint: {
    dir: env('CHECKPOINT_DIR', 'runtime/checkpoints'),
  },

  seen: {
    dir: env('SEEN_DIR', 'runtime/seen'),
  },

  // Per-transaction finance sync ledger — the authoritative record of whether a
  // transaction was successfully sent to the finance system (independent of local
  // dedup state). One file per provider+account.
  financeLedger: {
    dir: env('FINANCE_LEDGER_DIR', 'runtime/finance-ledger'),
  },

  // Per-run finance sync audit reports (JSON + CSV), one row per considered tx.
  reports: {
    dir: env('REPORTS_DIR', 'runtime/reports'),
  },

  // Multi-account (source account) configuration.
  // Accounts may be defined inline via the SOURCE_ACCOUNTS env var (JSON array)
  // or in a JSON file at this path. If neither exists, the system falls back to
  // the single default account derived from PROVIDER + {PROVIDER}_* credentials.
  accounts: {
    configPath: env('ACCOUNTS_CONFIG', 'accounts.config.json'),
  },

  log: {
    level: env('LOG_LEVEL', 'info'),
  },

  debug: env('DEBUG', 'false') === 'true',
};
