import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const currentLevel = () => {
  if (process.env.DEBUG === 'true') return 'debug';
  return process.env.LOG_LEVEL || 'info';
};

// Optional file sink. When LOG_FILE is set (the desktop app sets it under
// runtime/debug so a packaged run — whose stdout is invisible — still leaves a
// readable log), every emitted line is ALSO appended there. Best-effort: a
// logging/IO error must never break a run, so all failures are swallowed.
let _logDirReady = false;
function writeToLogFile(line) {
  const file = process.env.LOG_FILE;
  if (!file) return;
  try {
    if (!_logDirReady) {
      mkdirSync(dirname(file), { recursive: true });
      _logDirReady = true;
    }
    appendFileSync(file, line);
  } catch {
    /* never let a logging failure affect the run */
  }
}

function log(level, message, meta) {
  if (LEVELS[level] < LEVELS[currentLevel()]) return;

  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const metaStr = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(sanitize(meta)) : '';
  const line = `${ts} [${tag}] ${message}${metaStr}\n`;

  if (level === 'error') process.stderr.write(line);
  else process.stdout.write(line);

  writeToLogFile(line);
}

// Strip known secret-looking keys from logged metadata
const SECRET_KEYS = new Set(['password', 'token', 'secret', 'credential', 'apiKey', 'api_key']);

function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

export const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};
