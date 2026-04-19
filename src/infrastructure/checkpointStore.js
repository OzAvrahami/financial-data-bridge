import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';

/**
 * Persists in-progress fetch state so a run can be resumed after interruption.
 *
 * One checkpoint file per provider+account: {dir}/{provider}[_{accountId}].json
 *
 * Lifecycle:
 *   - Written after each extracted transaction (via onProgress in fetchTransactions)
 *   - Cleared on successful run completion
 *   - Preserved on failure or interruption — used for resume on next run
 */
export class CheckpointStore {
  constructor(dir = '.checkpoints') {
    this.dir = dir;
  }

  filePath(provider, accountId = 'default') {
    const suffix = accountId && accountId !== 'default' ? `_${accountId}` : '';
    return join(this.dir, `${provider}${suffix}.json`);
  }

  /** Returns the parsed checkpoint or null (missing or corrupt file). */
  async load(provider, accountId = 'default') {
    try {
      const raw = await readFile(this.filePath(provider, accountId), 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      // Treat corrupt/unreadable checkpoint as missing — start fresh
      return null;
    }
  }

  async save(provider, accountId = 'default', checkpoint) {
    const path = this.filePath(provider, accountId);
    await mkdir(this.dir, { recursive: true });
    await writeFile(path, JSON.stringify(checkpoint, null, 2), 'utf-8');
  }

  async clear(provider, accountId = 'default') {
    await unlink(this.filePath(provider, accountId)).catch(err => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}
