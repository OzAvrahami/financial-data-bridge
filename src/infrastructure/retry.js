import { logger } from './logger.js';

/**
 * Retry an async function with exponential backoff.
 * @param {() => Promise<any>} fn
 * @param {{
 *   attempts?: number,
 *   delay?: number,
 *   backoff?: number,
 *   label?: string,
 *   onRetry?: (attemptNumber: number) => void
 * }} opts
 */
export async function withRetry(fn, {
  attempts = 3,
  delay = 1000,
  backoff = 1.5,
  label = 'operation',
  onRetry,
} = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        const wait = Math.round(delay * Math.pow(backoff, i));
        logger.warn(`${label} failed, retrying`, { attempt: i + 1, of: attempts, waitMs: wait, error: err.message });
        if (typeof onRetry === 'function') onRetry(i + 1);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastError;
}
