/**
 * CAL page navigation and date filter logic.
 */

import { logger } from '../../infrastructure/logger.js';

export async function navigateToTransactionsByDate(page) {
  await page.click('text=עסקאות וחיובים');
  // Wait for submenu to render before clicking the target item
  await page.waitForSelector('text=עסקאות לפי תאריך ביצוע', { timeout: 10000 });
  await page.click('text=עסקאות לפי תאריך ביצוע');
  await page.waitForLoadState('networkidle');
}

export async function applyDateFilter(page, daysBack = 4) {
  await page.click('text=סינון');

  const filterFrame = await findFilterFrame(page);

  await filterFrame.waitForSelector('text=בחירת טווח', { timeout: 10000 });
  await filterFrame.click('text=בחירת טווח');

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  const day   = String(startDate.getDate()).padStart(2, '0');
  const month = String(startDate.getMonth() + 1).padStart(2, '0');
  const year  = String(startDate.getFullYear()).slice(-2);

  // The filter form has three separate text inputs for DD / MM / YY.
  // This relies on them being the first three text/date inputs in the filter panel.
  const dateInputs = await filterFrame.locator('input[type="text"], input[type="date"]').all();

  const dateFilterApplied = dateInputs.length >= 3;
  if (dateFilterApplied) {
    await dateInputs[0].click();
    await dateInputs[0].fill(day);
    await dateInputs[1].click();
    await dateInputs[1].fill(month);
    await dateInputs[2].click();
    await dateInputs[2].fill(year);
  } else {
    // The date inputs were not found, so NO from-date is applied and CAL falls
    // back to its default (much larger) range. This silently multiplies the row
    // count — and thus the per-row modal extraction cost — far beyond `daysBack`.
    // Surface it loudly so an oversized scan is diagnosable rather than mysterious.
    logger.warn('CAL date filter inputs not found — proceeding WITHOUT a date filter (default range)', {
      provider: 'CAL',
      inputsFound: dateInputs.length,
      requestedDaysBack: daysBack,
    });
  }

  await filterFrame.click('text=לצפייה בעסקאות');
  await page.waitForLoadState('networkidle');

  // Report whether a real date filter was applied so the caller can flag an
  // oversized (unfiltered) scan in its timing summary. Not part of extraction.
  return { dateFilterApplied, inputsFound: dateInputs.length };
}

async function findFilterFrame(page, timeout = 10000) {
  // The filter panel may render inside an iframe or directly on the page.
  // Poll until "בחירת טווח" is visible in any frame.
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frames = [page, ...page.frames()];
    for (const frame of frames) {
      try {
        const count = await frame.locator('text=בחירת טווח').count();
        if (count > 0) return frame;
      } catch {
        // Frame may not be accessible yet
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  // If not found in any iframe, fall back to the main page
  return page;
}
