import { decodeDayStats } from '../src/codec.js';
import { expect, openDay, rosterText, STORAGE_KEY, test } from './support/fixtures.mjs';

const CHROMIUM_ENGINES = ['android', 'chromium', 'edge'];

const count = (page, pid, stat, side) =>
  page.locator(`[data-action="tap-count"][data-pid="${pid}"][data-stat="${stat}"][data-side="${side}"]`);

async function recordSomething(page, press) {
  await press(count(page, 'grace', 'serve', 'in'));
  await press(count(page, 'grace', 'serve', 'in'));
  await press(count(page, 'grace', 'return', 'out'));
}

const readSaved = async (page) => JSON.parse(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY));

test.describe('Export', () => {
  test('nothing recorded shows the banner instead of the export screen', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText());
    await press(page.locator('[data-action="export"]'));
    await expect(page.getByText('Nothing recorded yet — tap a count, tap a point or enter a score first.')).toBeVisible();
    await expect(page.locator('#exportPayload')).toHaveCount(0);
  });

  test('the payload decodes to exactly what was recorded', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText());
    await recordSomething(page, press);
    await press(page.locator('[data-action="export"]'));
    // "Export stats" is a styled paragraph in ui.js (renderExport), not a heading.
    await expect(page.getByText('Export stats', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Thunder · 19 Sep · 1 game · 1 set · 1 player$/)).toBeVisible();
    const text = await page.locator('#exportPayload').inputValue();
    const decoded = decodeDayStats(text);
    expect(decoded.ok).toBe(true);
    const line = decoded.value.games[0].sets[0].players.find((p) => p.id === 'grace');
    expect(line).toEqual({ id: 'grace', serve: { in: 2, out: 0 }, return: { in: 0, out: 1 } });
  });

  test('Copy puts the payload on the clipboard, or falls back to selecting it', async ({ page, openApp, press }, testInfo) => {
    await openApp();
    await openDay(page, rosterText());
    await recordSomething(page, press);
    await press(page.locator('[data-action="export"]'));
    const text = await page.locator('#exportPayload').inputValue();
    expect((await readSaved(page)).session.lastExportedAt).toBeNull(); // not stamped by merely opening the screen
    await press(page.locator('[data-action="export-copy"]'));
    // The status is state-held (ui.js exportStatus), not a timer: it stays until Back, so a plain
    // auto-retrying assertion catches it.
    const copied = page.getByText("Copied — paste it into the planner's Stats dialog.");
    const fallback = page.getByText('The clipboard is not available here — select the text and copy it.');
    await expect(copied.or(fallback)).toBeVisible();
    const path = (await copied.isVisible()) ? 'copied' : 'fallback';
    if (CHROMIUM_ENGINES.includes(testInfo.project.name)) {
      expect(path).toBe('copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
    }
    if (path === 'copied') {
      expect((await readSaved(page)).session.lastExportedAt).toBeTruthy();
    } else {
      expect((await readSaved(page)).session.lastExportedAt).toBeNull();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('exportPayload');
    }
    testInfo.annotations.push({ type: 'clipboard', description: path });
  });

  // ui.js copyPayload (73-76): a rejecting writeText and an absent navigator.clipboard (`?.writeText`)
  // both fall through to selecting the textarea and report the fallback status.
  for (const [name, stub] of [
    ['a denied clipboard', () => ({ writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) })],
    ['no clipboard at all', () => undefined],
  ]) {
    test(`Copy falls back to selecting the payload with ${name}`, async ({ page, openApp, press }) => {
      await page.addInitScript(`Object.defineProperty(navigator, 'clipboard', { configurable: true, get: ${stub.toString()} });`);
      await openApp();
      await openDay(page, rosterText());
      await recordSomething(page, press);
      await press(page.locator('[data-action="export"]'));
      // The stub is in force before Copy is pressed.
      const stubbed = await page.evaluate(async () => {
        const c = navigator.clipboard;
        if (c === undefined) return 'absent';
        try { await c.writeText('x'); return 'accepted'; } catch (err) { return err.name; }
      });
      expect(stubbed).toBe(name === 'no clipboard at all' ? 'absent' : 'NotAllowedError');
      await press(page.locator('[data-action="export-copy"]'));
      await expect(page.getByText('The clipboard is not available here — select the text and copy it.')).toBeVisible();
      await expect(page.getByText("Copied — paste it into the planner's Stats dialog.")).toHaveCount(0);
      const box = await page.evaluate(() => {
        const t = document.getElementById('exportPayload');
        return { active: document.activeElement?.id, start: t.selectionStart, end: t.selectionEnd, length: t.value.length };
      });
      expect(box.length).toBeGreaterThan(0);
      expect(box).toEqual({ active: 'exportPayload', start: 0, end: box.length, length: box.length });
      expect((await readSaved(page)).session.lastExportedAt).toBeNull();
    });
  }

  test('Share… calls navigator.share with title and text where it exists', async ({ page, openApp, press }) => {
    await page.addInitScript(() => {
      window.__shared = [];
      navigator.share = (data) => {
        window.__shared.push(data);
        return Promise.resolve();
      };
    });
    await openApp();
    await openDay(page, rosterText());
    await recordSomething(page, press);
    await press(page.locator('[data-action="export"]'));
    await press(page.locator('[data-action="export-share"]'));
    await expect(page.getByText('Shared.')).toBeVisible();
    const shared = await page.evaluate(() => window.__shared);
    expect(shared).toHaveLength(1);
    expect(shared[0].title).toBe('CoachIQ stats · Thunder · 19 Sep');
    expect(shared[0].text).toBe(await page.locator('#exportPayload').inputValue());
    await expect.poll(async () => (await readSaved(page)).session.lastExportedAt).toBeTruthy();
  });

  test('Share… shows only where the real browser has navigator.share', async ({ page, openApp, press }, testInfo) => {
    await openApp();
    await openDay(page, rosterText());
    await recordSomething(page, press);
    await press(page.locator('[data-action="export"]'));
    const native = await page.evaluate(() => typeof navigator.share === 'function');
    await expect(page.locator('[data-action="export-share"]')).toHaveCount(native ? 1 : 0);
    testInfo.annotations.push({ type: 'share', description: native ? 'native navigator.share' : 'no navigator.share' });
  });

  test('Back returns to recording', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText());
    await recordSomething(page, press);
    await press(page.locator('[data-action="export"]'));
    await press(page.locator('[data-action="export-back"]'));
    await expect(page.locator('[data-action="export"]')).toBeVisible();
    await expect(page.locator('#exportPayload')).toHaveCount(0);
  });
});
