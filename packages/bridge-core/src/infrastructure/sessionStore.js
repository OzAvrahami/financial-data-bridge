import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { logger } from './logger.js';

/**
 * Persists Playwright browser storage state (cookies + localStorage) per provider.
 *
 * Files are stored as: {storageDir}/{providerName}.json
 * If an accountId is supplied, stored as: {storageDir}/{providerName}_{accountId}.json
 * This isolates sessions when multiple accounts per provider are needed later.
 */
export class SessionStore {
  constructor(storageDir = 'runtime/sessions') {
    this.storageDir = storageDir;
  }

  _filePath(providerName, accountId = '') {
    const safe = s => s.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const name = accountId ? `${safe(providerName)}_${safe(accountId)}` : safe(providerName);
    return join(this.storageDir, `${name}.json`);
  }

  /** Returns parsed storage state or null if not found / unreadable. */
  async load(providerName, accountId = '') {
    const filePath = this._filePath(providerName, accountId);
    try {
      const raw = await readFile(filePath, 'utf-8');
      logger.debug('Loaded session state from disk', { provider: providerName, file: filePath });
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Saves Playwright storageState object to disk. */
  async save(providerName, accountId = '', storageState) {
    const filePath = this._filePath(providerName, accountId);
    await mkdir(this.storageDir, { recursive: true });
    await writeFile(filePath, JSON.stringify(storageState, null, 2), 'utf-8');
    logger.debug('Saved session state to disk', { provider: providerName, file: filePath });
  }

  /** Removes the session file so the next run performs a fresh login. */
  async clear(providerName, accountId = '') {
    const filePath = this._filePath(providerName, accountId);
    await unlink(filePath).catch(() => {});
    logger.debug('Cleared session state', { provider: providerName });
  }
}
