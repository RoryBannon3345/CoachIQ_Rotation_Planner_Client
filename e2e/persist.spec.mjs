import { expect, openDay, plannedPayload, rosterText, STORAGE_KEY, test } from './support/fixtures.mjs';

test.describe('Saving on the device', () => {
  test('counts, points and the typed score survive a reload', async ({ page, openApp, press }) => {
    // ui.js measures its 300 ms tap guard with Date.now(), so the page clock is held still and
    // stepped past the guard with runFor(350), as in record.spec.mjs.
    await page.clock.install({ time: new Date('2026-09-19T10:00:00') });
    await openApp();
    await openDay(page, rosterText());
    await page.clock.pauseAt(new Date('2026-09-19T10:00:05'));
    await press(page.locator('[data-action="tap-count"][data-pid="grace"][data-stat="serve"][data-side="in"]'));
    await page.clock.runFor(350); // past ui.js's 300 ms guard
    await press(page.locator('[data-action="tap-point"][data-winner="T"]'));
    await expect(page.locator('[data-action="tap-point"][data-winner="T"]')).toHaveAttribute('aria-label', 'Them scored, 1');
    await press(page.locator('[data-action="select-set"][data-n="2"]'));
    await press(page.locator('[data-action="open-menu"]'));
    await press(page.locator('.sheet [data-action="open-score"]'));
    await page.locator('#scoreUs').fill('20');
    await page.locator('#scoreThem').fill('25');
    await press(page.locator('[data-action="score-done"]'));
    await expect(page.locator('button.pt.typed')).toContainText('20–25');
    await page.reload();
    await expect(page.locator('button.pt.typed')).toContainText('20–25');
    await press(page.locator('[data-action="select-set"][data-n="1"]'));
    await expect(page.locator('[data-action="tap-count"][data-pid="grace"][data-stat="serve"][data-side="in"]')).toHaveText('1');
    await expect(page.locator('[data-action="tap-point"][data-winner="T"]')).toHaveAttribute('aria-label', 'Them scored, 1');
  });

  test('a schema-3 save from an older release is migrated and opens with its numbers', async ({ page, openApp }) => {
    // The schema-3 envelope from test/session.test.mjs's migration test, verbatim.
    const envelope = JSON.stringify({
      schema: 3, savedAt: '2026-09-19T20:00:00Z',
      session: {
        date: '2026-09-19', team: 'Thunder',
        players: [{ id: 'grace', name: 'Grace', sub: false }],
        games: [{ gameId: 'game-1', opponent: 'Lions', setCount: 3, setPlayerIds: [['grace'], ['grace'], ['grace'], [], []],
          sets: [{ score: [25, 20], counts: { grace: { serve: { in: 2, out: 0 }, return: { in: 0, out: 0 } } } }, null, null, null, null],
          activeSet: 1, history: [{ n: 1, playerId: 'grace', stat: 'serve', side: 'in', delta: 1 }] }],
        activeGameId: 'game-1', importedAt: '2026-09-19T09:00:00Z', lastExportedAt: null, lastChangedAt: null,
      },
    });
    await openApp({ storage: { [STORAGE_KEY]: envelope } });
    await expect(page.locator('.title')).toContainText('vs Lions');
    await expect(page.locator('[data-action="tap-count"][data-pid="grace"][data-stat="serve"][data-side="in"]')).toHaveText('2');
    await expect(page.locator('button.pt.typed')).toContainText('25–20');
    await expect.poll(async () => JSON.parse(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).schema).toBe(4);
    const saved = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY));
    expect(saved.session).toMatchObject({ team: 'Thunder', date: '2026-09-19' });
    expect(saved.session.games[0]).toMatchObject({ gameId: 'game-1', opponent: 'Lions' });
    expect(saved.session.games[0].sets[0]).toMatchObject({ score: [25, 20], counts: { grace: { serve: { in: 2, out: 0 } } } });
  });

  test('a re-alignment survives a reload, and Undo still takes it back', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText(plannedPayload()));
    await press(page.locator('[data-action="tap-count"][data-pid="lily"][data-stat="serve"][data-side="in"]')); // the plan says Grace
    const serving = page.locator('.rows .row.serving .name');
    await expect(serving).toHaveText('Lily');
    await page.reload();
    await expect(serving).toHaveText('Lily');
    await press(page.locator('[data-action="open-undo"]'));
    await page.waitForTimeout(350); // past ui.js's 300 ms Take back guard
    await press(page.locator('.undo-list [data-action="undo"]'));
    await expect(serving).toHaveText('Grace');
  });
});
