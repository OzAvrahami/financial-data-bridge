/**
 * One-time, non-destructive migration of local runtime state from the legacy
 * pre-restructure locations into the new `runtime/` layout.
 *
 * Legacy → new:
 *   .seen/        → runtime/seen/
 *   .sessions/    → runtime/sessions/
 *   .checkpoints/ → runtime/checkpoints/
 *   exports/      → runtime/exports/
 *
 * Guarantees:
 *   - Copies files only; never deletes the legacy files.
 *   - Never overwrites a file that already exists in the new location.
 *   - Idempotent: once new files exist, subsequent runs copy nothing.
 *
 * This prevents the directory move from looking like "no seen state" — which
 * would otherwise reclassify everything as new and trigger a full re-export.
 *
 * Invoked from entrypoints (CLI / API) at startup — NOT from the core use cases,
 * so tests that call fetchTransactions() directly never touch the filesystem.
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';
import { config } from '../config.js';

/** Legacy → new directory pairs, derived from the active config. */
export function defaultMigrationPairs(cfg = config) {
  return [
    { from: '.seen',        to: cfg.seen.dir },
    { from: '.sessions',    to: cfg.session.storageDir },
    { from: '.checkpoints', to: cfg.checkpoint.dir },
    { from: 'exports',      to: cfg.export.path },
  ];
}

/**
 * Copy legacy runtime files into the new locations. Returns the list of newly
 * created destination paths. Safe to call repeatedly.
 */
export function migrateRuntimeState(pairs = defaultMigrationPairs()) {
  const copied = [];

  for (const { from, to } of pairs) {
    if (!from || !to || from === to) continue;     // nothing to do / same path
    if (!existsSync(from)) continue;               // no legacy dir

    let entries;
    try {
      entries = readdirSync(from, { withFileTypes: true });
    } catch {
      continue;
    }

    let madeDir = false;
    for (const entry of entries) {
      if (!entry.isFile()) continue;               // shallow: these dirs are flat
      const src = join(from, entry.name);
      const dst = join(to, entry.name);
      if (existsSync(dst)) continue;               // never overwrite new state
      try {
        if (!madeDir) { mkdirSync(to, { recursive: true }); madeDir = true; }
        copyFileSync(src, dst);
        copied.push(dst);
      } catch {
        /* skip individual file errors; migration is best-effort */
      }
    }
  }

  return copied;
}

let _done = false;

/** Run migrateRuntimeState() at most once per process. Never throws. */
export function migrateRuntimeStateOnce(pairs) {
  if (_done) return [];
  _done = true;
  try {
    const copied = migrateRuntimeState(pairs);
    if (copied.length > 0) {
      logger.info(`Runtime migration: copied ${copied.length} legacy file(s) into runtime/`, { count: copied.length });
    }
    return copied;
  } catch (err) {
    logger.warn('Runtime migration skipped due to error', { error: err.message });
    return [];
  }
}
