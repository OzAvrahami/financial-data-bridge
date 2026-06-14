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
    daysBack:           parseInt(env('DAYS_BACK', '4'), 10),
    // When true, stop early once earlyStopThreshold consecutive already-seen
    // transactions are encountered (incremental mode).
    incremental:        env('INCREMENTAL', 'true') === 'true',
    earlyStopThreshold: parseInt(env('EARLY_STOP_THRESHOLD', '10'), 10),
  },

  // Runtime/local state lives under runtime/ (see runtimeMigration.js for the
  // non-destructive copy from the legacy .seen/.sessions/.checkpoints/exports
  // locations). Each path remains individually overridable via env.
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

  // Multi-account (source account) configuration.
  // Accounts may be defined inline via the SOURCE_ACCOUNTS env var (JSON array)
  // or in a JSON file at this path. If neither exists, the system falls back to
  // the single default account derived from PROVIDER + {PROVIDER}_* credentials.
  accounts: {
    configPath: env('ACCOUNTS_CONFIG', 'accounts.config.json'),
  },

  api: {
    port: parseInt(env('API_PORT', '3000'), 10),
    // If set, the API requires an X-API-Key header matching this value.
    // Leave empty (default) for open localhost access.
    key: env('API_KEY', ''),
  },

  log: {
    level: env('LOG_LEVEL', 'info'),
  },

  debug: env('DEBUG', 'false') === 'true',
};
