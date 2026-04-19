/**
 * CAL login flow.
 *
 * CAL uses an Angular Material form inside a cross-origin iframe hosted at
 * connect.cal-online.co.il. The selectors #mat-input-2 and #mat-input-3 are
 * Angular Material auto-generated IDs for the username and password fields.
 * These IDs are stable on this page but will break if CAL restructures the
 * login form. If login stops working, inspect the iframe for updated field IDs.
 *
 * 2FA note: if the account has two-factor auth enabled, this flow will hang
 * at verifyLoginSuccess() waiting for a post-login element that never appears.
 * In that case, the scraper cannot be fully automated without app-specific
 * 2FA handling.
 */

export async function login(page, username, password) {
  await page.waitForSelector('text=כניסה לחשבון', { timeout: 15000 });
  await page.click('text=כניסה לחשבון');

  const loginFrame = await waitForLoginFrame(page);

  await loginFrame.waitForSelector('#regular-login', { timeout: 15000 });
  await loginFrame.click('#regular-login');

  await loginFrame.waitForSelector('#mat-input-2', { timeout: 20000 });

  // Click to focus before fill — required by Angular Material inputs
  await loginFrame.click('#mat-input-2');
  await loginFrame.fill('#mat-input-2', username);

  await loginFrame.click('#mat-input-3');
  await loginFrame.fill('#mat-input-3', password);

  await loginFrame.click('button[type="submit"]');

  await verifyLoginSuccess(page);
}

async function waitForLoginFrame(page, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = page.frames().find(f => f.url().includes('connect.cal-online.co.il'));
    if (frame) return frame;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('CAL login iframe did not appear within timeout');
}

async function verifyLoginSuccess(page, timeout = 20000) {
  try {
    // "עסקאות וחיובים" is the main nav item that only renders when authenticated
    await page.waitForSelector('text=עסקאות וחיובים', { timeout });
  } catch {
    throw new Error(
      'Login verification failed: post-login navigation element not found. ' +
      'Check credentials or 2FA requirement.'
    );
  }
}
