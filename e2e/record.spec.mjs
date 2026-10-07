import { expect, openDay, rosterText, test } from './support/fixtures.mjs';

const count = (page, pid, stat, side) =>
  page.locator(`[data-action="tap-count"][data-pid="${pid}"][data-stat="${stat}"][data-side="${side}"]`);

test.describe('Recording a set', () => {
  test('taps count on all four stats, and Undo takes the last one back', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText());
    for (const [stat, side] of [['serve', 'in'], ['serve', 'out'], ['return', 'in'], ['return', 'out']]) {
      await expect(count(page, 'grace', stat, side)).toHaveText('0');
      await press(count(page, 'grace', stat, side));
      await expect(count(page, 'grace', stat, side)).toHaveText('1');
    }
    await expect(page.locator('[data-action="undo"]')).toHaveText('↶ Undo Grace R out + Them, Them');
    await press(page.locator('[data-action="undo"]'));
    await expect(count(page, 'grace', 'return', 'out')).toHaveText('0');
    // Only the last tap came back.
    await expect(count(page, 'grace', 'return', 'in')).toHaveText('1');
    await expect(page.locator('[data-action="undo"]')).toHaveText('↶ Undo Grace R in');
  });

  test('minus subtracts once, and a tap at 0 does not use it up', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText());
    const c = count(page, 'grace', 'serve', 'in');
    await press(c);
    await press(c);
    await expect(c).toHaveText('2');
    const minus = page.locator('[data-action="toggle-minus"]');
    await expect(minus).toHaveAttribute('aria-pressed', 'false');
    await press(minus);
    await expect(minus).toHaveAttribute('aria-pressed', 'true');
    await expect(count(page, 'grace', 'serve', 'out')).toHaveText('0');
    await press(count(page, 'grace', 'serve', 'out')); // at 0: no change, minus stays on
    await expect(count(page, 'grace', 'serve', 'out')).toHaveText('0');
    await expect(minus).toHaveAttribute('aria-pressed', 'true');
    await press(c);
    await expect(c).toHaveText('1');
    await expect(minus).toHaveAttribute('aria-pressed', 'false');
  });

  test('serve-first, then point taps; a tap inside 300 ms is ignored', async ({ page, openApp, press }) => {
    // ui.js measures the guard with Date.now(), so the page clock is held still: a tap at the same
    // instant is deterministically inside 300 ms, and runFor(350) deterministically steps past it,
    // whatever the speed of the emulated touch.
    await page.clock.install({ time: new Date('2026-09-19T10:00:00') });
    await openApp();
    await openDay(page, rosterText());
    await page.clock.pauseAt(new Date('2026-09-19T10:00:05'));
    await press(page.locator('[data-action="serve-first"][data-us="1"]'));
    const us = page.locator('[data-action="tap-point"][data-winner="U"]');
    const them = page.locator('[data-action="tap-point"][data-winner="T"]');
    await expect(us).toHaveAttribute('aria-label', 'Us scored, 0');
    await press(us); // 0 ms after the answer, inside ui.js's 300 ms double-tap guard: ignored
    await expect(us).toHaveAttribute('aria-label', 'Us scored, 0');
    await expect(page.locator('[data-action="undo"]')).toHaveText('↶ Undo');
    await page.clock.runFor(350); // past ui.js's 300 ms guard
    await press(us);
    await expect(us).toHaveAttribute('aria-label', 'Us scored, 1');
    await press(them);
    await expect(them).toHaveAttribute('aria-label', 'Them scored, 1');
    await expect(us).toHaveAttribute('aria-label', 'Us scored, 1');
    await expect(page.locator('[data-action="undo"]')).toHaveText('↶ Undo point Them');
  });

  test('set tabs switch, and an empty set offers Tick players…', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText({ v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder', players: [{ id: 'grace', name: 'Grace' }], games: [{ gameId: 'game-1', opponent: 'Lions', sets: [1, 0] }] }));
    const set2 = page.locator('[data-action="select-set"][data-n="2"]');
    await expect(set2).not.toHaveClass(/\bon\b/);
    await expect(page.getByText('No players ticked for this set yet.')).toHaveCount(0);
    await press(set2);
    await expect(set2).toHaveClass(/\bon\b/);
    await expect(page.getByText('No players ticked for this set yet.')).toBeVisible();
    await press(page.locator('.rows [data-action="open-players"]'));
    await expect(page.getByRole('heading', { name: 'Players' })).toBeVisible();
  });

  test('stat taps drive the score: the next tap settles an open rally, and Undo takes back tap and points together', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText());
    const us = page.locator('[data-action="tap-point"][data-winner="U"]');
    const them = page.locator('[data-action="tap-point"][data-winner="T"]');
    await press(count(page, 'grace', 'serve', 'in')); // answers "we serve first"; the rally is open
    await expect(us).toHaveAttribute('aria-label', 'Us scored, 0');
    await expect(us).toHaveAttribute('data-open', '1');
    await expect(us).toHaveAttribute('data-serving', '1');
    await press(count(page, 'grace', 'serve', 'in')); // we served again: rally 1 to Us
    await expect(us).toHaveAttribute('aria-label', 'Us scored, 1');
    await expect(page.locator('.toast')).toHaveText('Us +1 · we serve');
    await press(count(page, 'grace', 'serve', 'out')); // rally 2 to Us, then the Out to Them
    await expect(us).toHaveAttribute('aria-label', 'Us scored, 2');
    await expect(them).toHaveAttribute('aria-label', 'Them scored, 1');
    await expect(them).toHaveAttribute('data-serving', '1');
    await expect(page.locator('.toast')).toHaveText('Us +1 · we serve, then Them +1 · Serve out');
    await expect(page.locator('[data-action="undo"]')).toHaveText('↶ Undo Grace S out + Us, Them');
    await press(page.locator('[data-action="undo"]'));
    await expect(us).toHaveAttribute('aria-label', 'Us scored, 1');
    await expect(them).toHaveAttribute('aria-label', 'Them scored, 0');
    await expect(us).toHaveAttribute('data-open', '1');
    await expect(count(page, 'grace', 'serve', 'out')).toHaveText('0');
  });
});
