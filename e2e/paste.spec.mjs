import { ROSTER_V3_VECTOR, ROSTER_V6_VECTOR } from '../src/vectors.js';
import { encodePayload, maskOf } from '../src/codec.js';
import { expect, openDay, rosterPayload, rosterText, test } from './support/fixtures.mjs';

const banner = (page) => page.locator('.banner.err[role=alert]');

/** Players `from` to `to - 1`: ids p<i>, names "Player <i>". */
const squad = (from, to) => Array.from({ length: to - from }, (_, k) => ({ id: `p${from + k}`, name: `Player ${from + k}` }));
/** The mask naming payload players `from` to `to - 1`. */
const span = (from, to) => maskOf(Array.from({ length: to - from }, (_, k) => from + k));
// Exact texts: session.js mergeDayRoster (the day cap at :210, the game cap at :254).

test.describe('Open the day', () => {
  test('the golden v6 vector opens Lions with three set tabs, and its plan highlights Grace', async ({ page, openApp, press }) => {
    await openApp();
    await expect(page.getByText('CoachIQ Stats')).toBeVisible();
    await openDay(page, ROSTER_V6_VECTOR.encoded);
    await expect(page.locator('[data-action="select-set"]')).toHaveCount(3);
    await expect(page.locator('.title')).toContainText('vs Lions');
    await expect(banner(page)).toHaveCount(0);
    await press(page.locator('[data-action="serve-first"][data-us="1"]'));
    await expect(page.locator('.rows .row.serving .name')).toHaveText('Grace');
  });

  test('the golden v3 vector still opens, with no highlight', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, ROSTER_V3_VECTOR.encoded);
    await expect(page.locator('[data-action="select-set"]')).toHaveCount(3);
    await press(page.locator('[data-action="serve-first"][data-us="1"]'));
    await expect(page.locator('.rows .row.serving')).toHaveCount(0);
  });

  test('a payload wrapped by a mail app (CRLF and spaces) still opens', async ({ page, openApp }) => {
    await openApp();
    const text = rosterText();
    const wrapped = text.match(/.{1,40}/g).join('\r\n ');
    expect(wrapped, 'the paste really is wrapped').toContain('\r\n ');
    await openDay(page, wrapped);
    await expect(page.locator('.title')).toContainText('vs Lions');
  });

  const refusals = [
    ['an empty paste', '', 'This is not a CoachIQ payload'],
    ['plain text', 'hello coach', 'This is not a CoachIQ payload'],
    ['a stats payload', encodePayload('stats', { v: 4 }, 4), 'This is a stats payload, not a roster payload.'],
    ['a newer contract', encodePayload('roster', rosterPayload(), 9), 'made by a newer version of the Rotation Planner'],
    ['a serve order naming nobody', encodePayload('roster', rosterPayload({ games: [{ gameId: 'game-1', opponent: 'Lions', sets: [7, 3], serve: ['------', null] }] }), 6), 'game "game-1" set 1 serve order names nobody'],
    ['a corrupted payload', rosterText().slice(0, -3) + 'zzz', 'This payload is corrupted or incomplete'],
  ];
  for (const [label, text, message] of refusals) {
    test(`${label} is refused with its message, and Dismiss clears it`, async ({ page, openApp }) => {
      await openApp();
      await openDay(page, text);
      await expect(banner(page)).toContainText(message);
      await page.locator('[data-action="dismiss-paste-error"]').click();
      await expect(banner(page)).toHaveCount(0);
    });
  }

  test('a second roster for the same day merges with a banner', async ({ page, openApp }) => {
    await openApp();
    await openDay(page, rosterText());
    await page.locator('[data-action="open-switcher"]').click();
    await page.locator('[data-action="switcher-paste-new-day"]').click();
    await openDay(page, rosterText(rosterPayload({ games: [{ gameId: 'game-2', opponent: 'Falcons', sets: [1] }] })));
    await expect(page.getByText(/^Day updated — 1 new game/)).toBeVisible();
  });

  test('a roster for another day asks before replacing; Cancel keeps the day', async ({ page, openApp }) => {
    await openApp();
    await openDay(page, rosterText());
    await page.locator('[data-action="open-switcher"]').click();
    await page.locator('[data-action="switcher-paste-new-day"]').click();
    await openDay(page, rosterText(rosterPayload({ date: '2026-09-20' })));
    await expect(page.getByRole('heading', { name: 'Open a different day?' })).toBeVisible();
    await page.locator('[data-action="close-sheet"]').filter({ hasText: 'Cancel' }).click();
    await page.locator('[data-action="cancel-paste"]').click();
    await expect(page.locator('.title')).toContainText('19 Sep');
  });

  test('Replace the day opens the new date', async ({ page, openApp }) => {
    await openApp();
    await openDay(page, rosterText());
    await page.locator('[data-action="open-switcher"]').click();
    await page.locator('[data-action="switcher-paste-new-day"]').click();
    await openDay(page, rosterText(rosterPayload({ date: '2026-09-20' })));
    await page.locator('[data-action="replace-day-replace"]').click();
    await expect(page.locator('.title')).toContainText('20 Sep');
  });

  test('a merge past the 8-game day limit is refused', async ({ page, openApp }) => {
    await openApp();
    const games = Array.from({ length: 8 }, (_, i) => ({ gameId: `g${i}`, opponent: `Team ${i}`, sets: [1] }));
    await openDay(page, rosterText(rosterPayload({ games })));
    await page.locator('[data-action="open-switcher"]').click();
    await page.locator('[data-action="switcher-paste-new-day"]').click();
    await openDay(page, rosterText(rosterPayload({ games: [{ gameId: 'g9', opponent: 'Extra', sets: [1] }] })));
    await expect(page.getByText('Updating would make 9 games; the day limit is 8.')).toBeVisible();
  });

  test('a merge past the 16-player game limit is refused and the day is kept', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText(rosterPayload({ players: squad(0, 16), games: [{ gameId: 'game-1', opponent: 'Lions', sets: [span(0, 16)] }] })));
    // Player 0 has a count in Set 1, so a merge keeps her there (session.js mergeDayRoster) …
    const p0 = page.locator('[data-action="tap-count"][data-pid="p0"][data-stat="serve"][data-side="in"]');
    await press(p0);
    await expect(p0).toHaveText('1');
    await page.locator('[data-action="open-switcher"]').click();
    await page.locator('[data-action="switcher-paste-new-day"]').click();
    // … beside the sixteen this roster names for the game: seventeen.
    await openDay(page, rosterText(rosterPayload({ players: squad(1, 17), games: [{ gameId: 'game-1', opponent: 'Lions', sets: [span(0, 16)] }] })));
    await expect(banner(page).getByText('Updating "Lions" would make 17 players; the game limit is 16.', { exact: true })).toBeVisible(); // the banner also holds Dismiss
    await page.locator('[data-action="cancel-paste"]').click();
    await expect(p0).toHaveText('1');
    await expect(page.locator('[data-action="tap-count"][data-pid="p16"]')).toHaveCount(0);
  });

  test('a merge past the 32-player day limit is refused and the day is kept', async ({ page, openApp }) => {
    await openApp();
    const games = [
      { gameId: 'game-1', opponent: 'Lions', sets: [span(0, 16)] },
      { gameId: 'game-2', opponent: 'Falcons', sets: [span(16, 32)] },
    ];
    await openDay(page, rosterText(rosterPayload({ players: squad(0, 32), games })));
    await expect(page.locator('.rows .row')).toHaveCount(16);
    await page.locator('[data-action="open-switcher"]').click();
    await page.locator('[data-action="switcher-paste-new-day"]').click();
    await openDay(page, rosterText(rosterPayload({ players: squad(32, 33), games: [{ gameId: 'game-3', opponent: 'Hawks', sets: [span(0, 1)] }] })));
    await expect(banner(page).getByText('Updating would make 33 players; the day limit is 32.', { exact: true })).toBeVisible(); // the banner also holds Dismiss
    await page.locator('[data-action="cancel-paste"]').click();
    await page.locator('[data-action="open-switcher"]').click();
    await expect(page.locator('[data-action="switch-game"]')).toHaveCount(2);
    await expect(page.locator('[data-action="switch-game"][data-gid="game-3"]')).toHaveCount(0);
  });
});
