import { BaseProvider } from '../../core/BaseProvider.js';
import { logger } from '../../infrastructure/logger.js';
import { withRetry } from '../../infrastructure/retry.js';
import { login } from './auth.js';
import { navigateToTransactionsByDate, applyDateFilter } from './navigator.js';
import { countTransactions, openTransactionModal, extractModalData, closeModal } from './extractor.js';
import { normalizeTransaction } from './normalizer.js';

// ── CalProvider ───────────────────────────────────────────────────────────────

export class CalProvider extends BaseProvider {
  get name() {
    return 'CAL';
  }

  /**
   * Navigate to CAL homepage and check for the authenticated nav element.
   * Used to decide whether a saved session can be reused at startup.
   */
  async isSessionValid(page) {
    try {
      await page.goto('https://www.cal-online.co.il', { waitUntil: 'networkidle', timeout: 20000 });
      const count = await page.locator('text=עסקאות וחיובים').count();
      return count > 0;
    } catch {
      return false;
    }
  }

  /**
   * Detect whether an error during fetchTransactions indicates session expiry.
   * CAL session loss typically manifests as a redirect to the login iframe domain,
   * or as the authenticated nav element disappearing.
   */
  async isAuthError(error) {
    try {
      const url = this.page?.url() ?? '';
      // Redirected to the cross-origin login iframe host
      if (url.includes('connect.cal-online.co.il')) return true;
      // Session dropped without a visible redirect — nav is gone
      const count = await this.page.locator('text=עסקאות וחיובים').count({ timeout: 3000 });
      return count === 0;
    } catch {
      return false;
    }
  }

  async login(credentials) {
    await this.page.goto('https://www.cal-online.co.il');
    await this.page.waitForLoadState('networkidle');
    await login(this.page, credentials.username, credentials.password);
  }

  /**
   * @param {object}   opts
   * @param {number}   [opts.daysBack=4]
   * @param {number}   [opts.startIndex=0]    - Row index to resume from (for checkpoint resume)
   * @param {Function} [opts.onProgress]      - Called after each extracted transaction.
   *                                            Signature: ({ index, total, transaction }) → Promise<boolean>
   *                                            Return false to stop the loop early.
   * @returns {Promise<{ transactions: Transaction[], warnings: string[] }>}
   */
  async fetchTransactions({ daysBack = 4, startIndex = 0, onProgress } = {}) {
    await withRetry(
      () => navigateToTransactionsByDate(this.page),
      { attempts: 2, delay: 2000, label: 'CAL navigate to transactions' }
    );

    await applyDateFilter(this.page, daysBack);

    const count = await countTransactions(this.page);
    logger.info(`Found ${count} transaction row(s)`, { provider: 'CAL' });

    if (startIndex > 0) {
      logger.info(`Resuming from row ${startIndex + 1}/${count}`, { provider: 'CAL' });
    }

    const transactions = [];
    const warnings = [];

    for (let i = startIndex; i < count; i++) {
      try {
        const opened = await withRetry(
          () => openTransactionModal(this.page, i),
          { attempts: 2, delay: 800, label: `CAL modal ${i + 1}/${count}` }
        );

        if (!opened) {
          const msg = `Row ${i + 1}/${count} was not clickable — skipped`;
          logger.debug(msg);
          warnings.push(msg);
          continue;
        }

        const raw = await extractModalData(this.page);
        await closeModal(this.page);

        if (raw) {
          const normalized = normalizeTransaction(raw);
          transactions.push(normalized);

          if (onProgress) {
            const shouldContinue = await onProgress({ index: i, total: count, transaction: normalized });
            if (shouldContinue === false) break;
          }
        }
      } catch (err) {
        const msg = `Transaction ${i + 1}/${count} skipped: ${err.message}`;
        logger.warn(msg);
        warnings.push(msg);
        await closeModal(this.page).catch(() => {});
      }
    }

    return { transactions, warnings };
  }
}
