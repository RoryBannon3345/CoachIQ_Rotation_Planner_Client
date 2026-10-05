import { expect, openDay, rosterPayload, rosterText, test } from './support/fixtures.mjs';

const action = (page, name) => page.locator(`[data-action="${name}"]`);
const openMenu = async (page, press) => press(action(page, 'open-menu'));
const graceServeIn = (page) =>
  page.locator('[data-action="tap-count"][data-pid="grace"][data-stat="serve"][data-side="in"]');

test.describe('Sheets', () => {
  test('Set score: invalid is refused, valid is shown typed, Clear removes it', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText());
    await expect(page.locator('button.pt.typed')).toHaveCount(0);
    await openMenu(page, press);
    await press(page.locator('.sheet [data-action="open-score"]'));
    await page.locator('#scoreUs').fill('25');
    await press(action(page, 'score-done'));
    await expect(page.getByText('Enter both scores or clear the score')).toBeVisible();
    await page.locator('#scoreThem').fill('21');
    await press(action(page, 'score-done'));
    await expect(page.locator('button.pt.typed')).toContainText('25–21');
    await press(page.locator('button.pt.typed'));
    await press(action(page, 'score-clear'));
    await expect(page.locator('button.pt.typed')).toHaveCount(0);
  });

  test('Players: untick and tick; a player with counts is locked', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText());
    await press(graceServeIn(page));
    await expect(graceServeIn(page)).toHaveText('1');
    await openMenu(page, press);
    await press(page.locator('.sheet [data-action="open-players"]'));
    const zoie = page.locator('li.tick[data-pid="zoie"]');
    await press(zoie);
    await expect(page.getByText(/of 3 in Set 1$/)).toBeVisible();
    await press(page.locator('li.tick[data-pid="grace"]'));
    await expect(page.getByText('Grace has counts in Set 1 — clear the set first to take her off.')).toBeVisible();
  });

  test('Add a sub: blank and duplicate names are refused; a new name joins', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText());
    await openMenu(page, press);
    await press(page.locator('.sheet [data-action="open-players"]'));
    await press(action(page, 'open-add-sub-from-players'));
    await press(action(page, 'sub-add'));
    await expect(page.getByText('Enter a name.')).toBeVisible();
    await page.locator('#subName').fill('Grace');
    await press(action(page, 'sub-add'));
    await expect(page.getByText(/Someone called Grace is already in today's players/)).toBeVisible();
    await page.locator('#subName').fill('Ava');
    await press(action(page, 'sub-add'));
    await expect(page.getByRole('heading', { name: 'Players' })).toBeVisible();
    await expect(page.locator('li.tick', { hasText: 'Ava' })).toBeVisible();
  });

  test('Games switcher: switch by tap and by keyboard Enter; Delete', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText(rosterPayload({ games: [{ gameId: 'game-1', opponent: 'Lions', sets: [1] }, { gameId: 'game-2', opponent: 'Falcons', sets: [1] }] })));
    await press(action(page, 'open-switcher'));
    await expect(page.locator('[data-action="switch-game"]')).toHaveCount(2);
    await press(page.locator('[data-action="switch-game"][data-gid="game-2"]'));
    await expect(page.locator('.title')).toContainText('vs Falcons');
    await press(action(page, 'open-switcher'));
    await page.locator('[data-action="switch-game"][data-gid="game-1"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.title')).toContainText('vs Lions');
    await press(action(page, 'open-switcher'));
    await press(page.locator('[data-action="ask-delete-game"][data-gid="game-2"]'));
    await press(action(page, 'confirm-delete-game'));
    await press(action(page, 'open-switcher'));
    await expect(page.locator('[data-action="switch-game"]')).toHaveCount(1);
    await expect(page.locator('[data-action="switch-game"][data-gid="game-1"]')).toHaveCount(1);
  });

  test('menu: flip serve-first, clear points, clear set', async ({ page, openApp, press }) => {
    // ui.js measures its 300 ms tap guard with Date.now(); the page clock is held still and stepped.
    await page.clock.install({ time: new Date('2026-09-19T10:00:00') });
    await openApp();
    await openDay(page, rosterText());
    await page.clock.pauseAt(new Date('2026-09-19T10:00:05'));
    await press(page.locator('[data-action="serve-first"][data-us="1"]'));
    await page.clock.runFor(350); // past ui.js's 300 ms guard
    await press(page.locator('[data-action="tap-point"][data-winner="U"]'));
    await expect(page.locator('[data-action="tap-point"][data-winner="U"]')).toHaveAttribute('aria-label', 'Us scored, 1');
    await openMenu(page, press);
    await press(action(page, 'menu-flip-serve-first'));
    await openMenu(page, press);
    await expect(action(page, 'menu-flip-serve-first')).toContainText('They served first');
    await press(action(page, 'menu-clear-points'));
    await press(action(page, 'confirm-clear-points'));
    // Clearing the points forgets who served first (session.js clearPoints): the question returns.
    await expect(page.locator('[data-action="tap-point"]')).toHaveCount(0);
    await expect(page.locator('[data-action="serve-first"]')).toHaveCount(2);
    await press(page.locator('[data-action="serve-first"][data-us="1"]'));
    await expect(page.locator('[data-action="tap-point"][data-winner="U"]')).toHaveAttribute('aria-label', 'Us scored, 0');
    await press(graceServeIn(page));
    await expect(graceServeIn(page)).toHaveText('1');
    await openMenu(page, press);
    await press(action(page, 'menu-clear-set'));
    await press(action(page, 'confirm-clear-set'));
    await expect(graceServeIn(page)).toHaveText('0');
  });

  test('deleting the last game returns to the paste screen; Start a new day too', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText());
    await openMenu(page, press);
    await press(action(page, 'menu-delete-game'));
    await press(action(page, 'confirm-delete-game'));
    await expect(page.locator('#pasteText')).toBeVisible();
    await openDay(page, rosterText());
    await expect(page.locator('#pasteText')).toHaveCount(0);
    await openMenu(page, press);
    await press(action(page, 'menu-new-day'));
    await press(action(page, 'confirm-new-day'));
    await expect(page.locator('#pasteText')).toBeVisible();
  });
});
