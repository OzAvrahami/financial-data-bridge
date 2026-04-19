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
    daysBack: parseInt(env('DAYS_BACK', '4'), 10),
  },

  export: {
    path: env('EXPORT_PATH', 'exports'),
  },

  session: {
    storageDir: env('SESSION_DIR', '.sessions'),
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
