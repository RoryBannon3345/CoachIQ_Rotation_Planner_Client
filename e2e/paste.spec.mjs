import { ROSTER_V3_VECTOR } from '../src/vectors.js';
import { encodePayload } from '../src/codec.js';
import { expect, openDay, rosterPayload, rosterText, test } from './support/fixtures.mjs';

const banner = (page) => page.locator('.banner.err[role=alert]');

test.describe('Open the day', () => {
  test('the golden v3 vector opens Lions with three set tabs', async ({ page, openApp }) => {
    await openApp();
    await expect(page.getByText('CoachIQ Stats')).toBeVisible();
    await openDay(page, ROSTER_V3_VECTOR.encoded);
    await expect(page.locator('[data-action="select-set"]')).toHaveCount(3);
    await expect(page.locator('.title')).toContainText('vs Lions');
    await expect(banner(page)).toHaveCount(0);
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
});
