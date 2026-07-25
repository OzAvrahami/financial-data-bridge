/**
 * Lightweight performance timing helpers (temporary diagnostics).
 *
 * All output goes through the existing structured logger under a single
 * `[timing]` message prefix so every timing line is greppable:
 *
 *     node ... 2>&1 | grep '\[timing\]'
 *
 * Design goals:
 *   - Zero behavior change: timers only measure and log; they never alter control
 *     flow, swallow errors, or change return values.
 *   - Low volume by default: stage timings and per-loop AGGREGATES log at `info`
 *     (one line each). Individual per-row timings log only at `debug` so a normal
 *     run stays quiet while `DEBUG=true` gives row-by-row detail.
 *
 * These are intended to be easy to remove once the CAL sync bottleneck is
 * characterised — search for `timing.js` and `[timing]`.
 */

import { logger } from './logger.js';

/** High-resolution monotonic clock in ms (falls back to Date.now). */
const now = () =>
  (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

/** Round to 0.1ms so log lines stay readable. */
const round1 = (n) => Math.round(n * 10) / 10;

/** Start a timer; returns an opaque start mark for elapsedMs(). */
export function startTimer() {
  return now();
}

/** Milliseconds elapsed since a startTimer() mark, rounded to 0.1ms. */
export function elapsedMs(startMark) {
  return round1(now() - startMark);
}

/**
 * Run an async stage, log its duration at `info` under `[timing] <label>`, and
 * return whatever the stage returned. The duration is logged even when the stage
 * throws, so a slow-then-failing stage is still visible. The error is re-thrown
 * unchanged.
 *
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @param {object} [meta]  extra secret-free fields to include on the log line
 * @returns {Promise<T>}
 */
export async function timeStage(label, fn, meta = {}) {
  const t = now();
  let ok = true;
  try {
    return await fn();
  } catch (err) {
    ok = false;
    throw err;
  } finally {
    logger.info(`[timing] ${label}`, { ...meta, ms: round1(now() - t), ...(ok ? {} : { failed: true }) });
  }
}

/**
 * Accumulator for per-item loop timing. Records each item's duration and, on
 * summary(), reports count / total / average / min / max plus the index of the
 * slowest item — the numbers needed to tell "many rows, each cheap" apart from
 * "a few rows each hitting a timeout".
 *
 * @param {string} label
 */
export function createLoopStats(label) {
  let count = 0;
  let total = 0;
  let min = Infinity;
  let max = 0;
  let slowestIndex = -1;

  return {
    /** Record one item's elapsed ms (from a startTimer mark via elapsedMs, or raw ms). */
    record(ms, index) {
      count++;
      total += ms;
      if (ms < min) min = ms;
      if (ms > max) { max = ms; slowestIndex = index; }
    },
    /** Plain object snapshot (also used by tests). */
    summary() {
      return {
        count,
        totalMs: round1(total),
        avgMs:   count ? round1(total / count) : 0,
        minMs:   count ? round1(min) : 0,
        maxMs:   round1(max),
        slowestIndex,
      };
    },
    /** Log the aggregate at info under `[timing] <label>`. */
    log(meta = {}) {
      logger.info(`[timing] ${label}`, { ...meta, ...this.summary() });
    },
  };
}
