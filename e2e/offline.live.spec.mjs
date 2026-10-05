import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, guardPage, test } from './support/fixtures.mjs';

const LIVE_URL = 'https://rorybannon3345.github.io/CoachIQ_Rotation_Planner_Client/CoachIQ_Rotation_Planner_Client.html';
const FAVICON_URL = 'https://rorybannon3345.github.io/favicon.ico';
// Nothing listens on port 9 (discard), so every request through this proxy fails: a phone with no signal.
const DEAD_PROXY = 'http://127.0.0.1:9';

// Loads the DEPLOYED copy (read-only), so it proves what coaches actually get, and needs the internet.
// The coach scenario is "open the app once, close it, open it again with no signal", so the test does just
// that with two launches of one browser profile; the second launch has a dead proxy. (context.setOffline
// plus reload is not used: Playwright's WebKit rejects service-worker navigations while offline,
// microsoft/playwright#42775.)
test.describe('Offline launch @live', () => {
  test('the deployed app opens again with the network off', async ({ playwright, browserName }, testInfo) => {
    const { defaultBrowserType, trace, screenshot, ...contextOptions } = testInfo.project.use;
    const profile = mkdtempSync(join(tmpdir(), 'ciq-offline-'));
    const launch = (extra = {}) => playwright[browserName].launchPersistentContext(profile, { ...contextOptions, ...extra });
    // A cache-busted same-origin URL that does not exist: GitHub Pages answers 404 when the network is up.
    const probeUrl = () => `${new URL('.', LIVE_URL).href}__offline-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    const probe = (page, url) => page.evaluate((u) => fetch(u).then((r) => r.status, () => 'rejected'), url);
    // The online page logs a console error for every 404, which the page text does not tie to a URL: the probe
    // below causes one on purpose in every engine, and Edge adds one for /favicon.ico (it asks the github.io
    // host root on the first load; the app has no <link rel=icon>, and nothing the coach sees breaks). So the
    // allowance is broad but the 404 URLs themselves are pinned by the response check below.
    const allowed404 = [/Failed to load resource: the server responded with a status of 404/];
    const notFound = [];
    let version;

    try {
      // Launch 1, online: load, wait for the service worker to take control, then close.
      const first = await launch();
      try {
        const page = first.pages()[0] ?? (await first.newPage());
        const unexpected = guardPage(page, allowed404);
        page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });
        await page.goto(LIVE_URL);
        await expect(page.locator('#pasteText')).toBeVisible();
        version = (await page.locator('.bver').textContent()).trim();
        testInfo.annotations.push({ type: 'deployed version', description: version });
        await page.evaluate(() => navigator.serviceWorker.ready);
        await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 15_000 }).toBe(true);
        // The network is really up: a missing file is a 404 from the host.
        expect(await probe(page, probeUrl()), 'online, a missing file is a 404').toBe(404);
        expect(unexpected(), 'errors logged by the online page').toEqual([]);
      } finally {
        await first.close();
      }
      // The only 404 the page itself caused is the favicon (the probe's own 404 is excluded).
      expect(notFound.filter((u) => !u.includes('__offline-probe-') && u !== FAVICON_URL), 'unexpected 404s online').toEqual([]);

      // Launch 2, no signal: the same profile with a dead proxy.
      const second = await launch({ proxy: { server: DEAD_PROXY } });
      try {
        const page = second.pages()[0] ?? (await second.newPage());
        const unexpected = guardPage(page, []);
        const response = await page.goto(LIVE_URL);
        expect(response.fromServiceWorker(), 'the offline document came from the service worker').toBe(true);
        expect(response.status()).toBe(200);
        await expect(page.locator('#pasteText')).toBeVisible();
        await expect(page.getByText('CoachIQ Stats')).toBeVisible();
        await expect(page.locator('.bver')).toHaveText(version);
        expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
        // The network is really cut: the same missing file is no longer answered by the host. The worker
        // falls back to the cached app page (200) or the fetch rejects; either way it is not a 404.
        expect(await probe(page, probeUrl()), 'offline, the host cannot answer').not.toBe(404);
        expect(unexpected(), 'errors logged by the offline page').toEqual([]);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
