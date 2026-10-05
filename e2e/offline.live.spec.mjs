import { expect, test } from './support/fixtures.mjs';

const LIVE_URL = 'https://rorybannon3345.github.io/CoachIQ_Rotation_Planner_Client/CoachIQ_Rotation_Planner_Client.html';

// Loads the DEPLOYED copy (read-only), so it proves what coaches actually get, and needs the internet.
test.describe('Offline launch @live', () => {
  test('the deployed app opens again with the network off', async ({ page, context, allowConsoleError }, testInfo) => {
    // Playwright's WebKit cannot navigate offline once a service worker controls the page: reload fails with
    // 'WebKit encountered an internal error' even when the worker answers with a literal response, and an
    // in-page location.reload() never reloads either (verified). iPhone and iPad are WebKit emulations.
    // https://github.com/microsoft/playwright/issues/42775
    test.fail(['iphone', 'ipad', 'webkit'].includes(testInfo.project.name),
      'WebKit offline emulation rejects service-worker navigations (microsoft/playwright#42775); the app cannot work around it');
    // Edge only: it asks the github.io host root for /favicon.ico on the first (online) load and gets a 404.
    // The app has no <link rel=icon>; nothing the coach sees breaks. Chromium headless does not ask.
    if (testInfo.project.name === 'edge') allowConsoleError(/Failed to load resource: the server responded with a status of 404/);
    await page.goto(LIVE_URL);
    await expect(page.locator('#pasteText')).toBeVisible();
    const version = (await page.locator('.bver').textContent()).trim();
    testInfo.annotations.push({ type: 'deployed version', description: version });
    console.log(`deployed copy shows: ${version}`);

    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 15_000 }).toBe(true);

    // Mark this document, so a reload that really happened is provable: the marker is lost on reload.
    await page.evaluate(() => { window.__beforeReload = true; });
    await context.setOffline(true);

    const response = await page.reload();
    expect(await page.evaluate(() => window.__beforeReload === undefined), 'the page really reloaded').toBe(true);
    expect(response.fromServiceWorker(), 'the offline document came from the service worker').toBe(true);
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    await expect(page.locator('#pasteText')).toBeVisible();
    await expect(page.getByText('CoachIQ Stats')).toBeVisible();
    await expect(page.locator('.bver')).toHaveText(version);
  });
});