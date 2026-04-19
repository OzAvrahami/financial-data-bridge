import { BaseProvider } from '../../core/BaseProvider.js';
import { logger } from '../../infrastructure/logger.js';
import { withRetry } from '../../infrastructure/retry.js';
import { login } from './auth.js';
import { navigateToTransactionsByDate, applyDateFilter } from './navigator.js';
import { countTransactions, openTransactionModal, extractModalData, closeModal } from './extractor.js';
import { normalizeTransaction } from './normalizer.js';

// ── Debug helpers ─────────────────────────────────────────────────────────────
// Emit detailed debug info when:
//   (a) the merchant name matches a target string, OR
//   (b) amount and chargeAmount both exist and differ by more than 1%
//       (proxy for a foreign-currency conversion)
//
// Remove this block once currency extraction is implemented.

const DEBUG_MERCHANT = 'MyFunded Futures';

function isForeignCurrencyCandidate(raw) {
  if (!raw.amount || !raw.chargeAmount) return false;
  const ratio = Math.abs(raw.chargeAmount - raw.amount) / raw.amount;
  return ratio > 0.01; // amounts differ by more than 1%
}

function isTargetMerchant(raw) {
  return raw.businessName?.includes(DEBUG_MERCHANT);
}

async function debugTransaction(page, raw, normalized, index) {
  const reason = isTargetMerchant(raw)
    ? `merchant match ("${DEBUG_MERCHANT}")`
    : 'foreign-currency candidate (amount ≠ chargeAmount)';

  logger.debug(`[DEBUG] Transaction ${index + 1} flagged: ${reason}`);
  logger.debug('[DEBUG] Raw extracted object:', { raw });
  logger.debug('[DEBUG] Normalized transaction:', { normalized });

  if (raw._debug_amountRaw) {
    logger.debug('[DEBUG] סכום העסקה cell (verbatim):', { text: raw._debug_amountRaw });
  }
  if (raw._debug_chargeAmountRaw) {
    logger.debug('[DEBUG] סכום החיוב cell (verbatim):', { text: raw._debug_chargeAmountRaw });
  }
  if (raw._debug_allTableRows?.length) {
    logger.debug('[DEBUG] All modal table rows:', { rows: raw._debug_allTableRows });
  }

  // Save a screenshot of the (already-closed) page for manual inspection.
  // If the modal is still open when this runs, the screenshot will show it.
  try {
    const safeName = raw.businessName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
    const screenshotPath = `exports/debug_${safeName}_${index + 1}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });
    logger.debug(`[DEBUG] Screenshot saved to: ${screenshotPath}`);
  } catch (err) {
    logger.debug('[DEBUG] Screenshot failed (modal already closed):', { error: err.message });
  }
}

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
   * @returns {Promise<{ transactions: Transaction[], warnings: string[] }>}
   */
  async fetchTransactions({ daysBack = 4 } = {}) {
    await withRetry(
      () => navigateToTransactionsByDate(this.page),
      { attempts: 2, delay: 2000, label: 'CAL navigate to transactions' }
    );

    await applyDateFilter(this.page, daysBack);

    const count = await countTransactions(this.page);
    logger.info(`Found ${count} transaction row(s)`, { provider: 'CAL' });

    const transactions = [];
    const warnings = [];

    for (let i = 0; i < count; i++) {
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

          // DEBUG: emit detailed info for foreign-currency candidates and target merchant.
          // Screenshot is taken after closeModal so it shows the list page, not the open modal.
          if (isTargetMerchant(raw) || isForeignCurrencyCandidate(raw)) {
            await debugTransaction(this.page, raw, normalized, i);
          }

          transactions.push(normalized);
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
