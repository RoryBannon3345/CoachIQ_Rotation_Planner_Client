// Density of the record screen on phones and the tablet, carried over from scripts/verify-density.mjs
// (same viewports, same thresholds), run in every phone/tablet engine instead of one Chrome.
// The desktop projects do not run this file: density is a phone and tablet property (controller ruling R4),
// so those cells show as "not run" in the grid.
import { expect, openDay, rosterPayload, rosterText, test } from './support/fixtures.mjs';

const PHONE_PROJECTS = ['iphone', 'android', 'firefox-phone', 'ipad'];

/** styles.css `grid-auto-rows: minmax(38px, 1fr)`: below this the list scrolls rather than shrinks. */
const ROW_FLOOR = 38;

// verify-density's names, so the same roster reads the same in both.
const NAMES = ['Addison', 'Brooklyn', 'Brynn', 'Emily', 'Grace', 'Hailey', 'Lexi', 'Lily', 'Melanie', 'Maya', 'Nora', 'Zoie', 'Olivia', 'Piper', 'Quinn', 'Ruby'];
const LONG_NAME = `${'A'.repeat(31)} ${'B'.repeat(32)}`; // 64 characters, the planner's cap

/** A one-game day whose single set ticks every player, so all `n` rows render. */
function rosterOf(n, name = (i) => NAMES[i]) {
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: name(i) }));
  return rosterText(rosterPayload({ players, games: [{ gameId: 'g1', opponent: 'Practice_9_18', sets: [2 ** n - 1] }] }));
}

// verify-density's CASES, verbatim. The 12-player heights are the app's share of a real iPhone screen
// (a browser tab keeps 652 of 812 CSS px, a home-screen launch 734); they are used instead of each
// device's own taller viewport because the shorter screen is the one that can fail.
const CASES = [
  { label: 'iPhone X-class, browser tab', w: 375, h: 652, n: 12, allVisible: true, minTarget: 35 },
  { label: 'iPhone X-class, home screen', w: 375, h: 734, n: 12, allVisible: true, minTarget: 42 },
  { label: 'iPhone 15 Pro, browser tab', w: 393, h: 692, n: 12, allVisible: true, minTarget: 38 },
  { label: 'iPhone 15 Pro, home screen', w: 393, h: 774, n: 12, allVisible: true, minTarget: 44 },
  { label: 'X-class browser, 6 players', w: 375, h: 652, n: 6, allVisible: true, minTarget: 60 },
  { label: 'iPhone SE 1st gen, 6 players', w: 320, h: 568, n: 6, allVisible: true, minTarget: 44 },
  { label: 'X-class browser, 16 players', w: 375, h: 652, n: 16, allVisible: false, scrolls: true, minTarget: 35 },
  { label: 'iPhone 15 Pro home, 16 players', w: 393, h: 774, n: 16, allVisible: false, minTarget: 35 },
];

/** What verify-density measures, in the page. Everything is compared with `.rows`, not the viewport. */
function measure(page) {
  return page.evaluate(() => {
    const rows = document.querySelector('.rows');
    const all = [...document.querySelectorAll('.rows .row')];
    const box = rows.getBoundingClientRect();
    const last = all[all.length - 1].getBoundingClientRect();
    const bar = document.querySelector('[data-action="export"]').getBoundingClientRect();
    return {
      rendered: all.length,
      heights: all.map((r) => +r.getBoundingClientRect().height.toFixed(1)),
      target: +all[0].querySelector('.cnt').getBoundingClientRect().height.toFixed(1),
      // Half a pixel is for sub-pixel layout, not slack.
      allVisible: last.bottom <= box.bottom + 0.5,
      scrollable: rows.scrollHeight > rows.clientHeight + 0.5,
      exportBottom: bar.bottom,
      innerHeight: window.innerHeight,
    };
  });
}

const setBarHeight = (page) => page.evaluate(() => +document.querySelector('.setbar').getBoundingClientRect().height.toFixed(1));

test.describe('Fits a phone', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(!PHONE_PROJECTS.includes(testInfo.project.name), 'density is a phone and tablet property');
  });

  // Every verify-density viewport in every phone/tablet engine. setViewportSize keeps the project's
  // touch and mobile emulation; only the CSS size changes, which is all the layout reads.
  for (const c of CASES) {
    test(`${c.label}: ${c.n} players at ${c.w}x${c.h}`, async ({ page, openApp, press }) => {
      await page.setViewportSize({ width: c.w, height: c.h });
      await openApp();
      await openDay(page, rosterOf(c.n));
      await expect(page.locator('.rows .row')).toHaveCount(c.n);

      // The strip must keep its height from the ask state to the live state, or the rows jump.
      const askH = await setBarHeight(page);
      await press(page.locator('[data-action="serve-first"][data-us="1"]'));
      await expect(page.locator('[data-action="tap-point"]').first()).toBeVisible();
      const liveH = await setBarHeight(page);
      expect(Math.abs(askH - liveH), `set bar ${askH}px asking, ${liveH}px live`).toBeLessThanOrEqual(0.5);
      expect(askH, 'set bar asking').toBeLessThanOrEqual(60);
      expect(liveH, 'set bar live').toBeLessThanOrEqual(60);

      const m = await measure(page);
      expect(m.rendered).toBe(c.n);
      const rowH = m.heights[0];
      if (c.allVisible) {
        // Fits while the rows are above the floor; at the floor the list is meant to scroll.
        expect(rowH, `rows hit the ${ROW_FLOOR}px floor and the roster no longer fits`).toBeGreaterThan(ROW_FLOOR + 0.5);
        expect(m.allVisible, `only part of the roster is visible at ${rowH}px rows`).toBe(true);
        // And the whole screen, Export included, is on screen: nothing pushed the bottom bar off.
        expect(m.exportBottom, 'Export button bottom edge').toBeLessThanOrEqual(m.innerHeight + 0.5);
      }
      if (c.n > 12) for (const h of m.heights) expect(h, `rows shrank under the ${ROW_FLOOR}px floor`).toBeGreaterThanOrEqual(ROW_FLOOR - 0.5);
      // Vacuity guard: the long-game cases must really be too long, or "scrolls" proves nothing.
      if (c.scrolls) expect(m.scrollable, 'a game too long for the screen did not scroll').toBe(true);
      expect(m.target, `tap target ${m.target}px`).toBeGreaterThanOrEqual(c.minTarget);
    });
  }

  // Each project's own device size (iPhone 15, Pixel 7, 393x852 Firefox, iPad) with a full game.
  test('12 players fit on one screen at the device size', async ({ page, openApp }) => {
    await openApp();
    await openDay(page, rosterOf(12));
    await expect(page.locator('.rows .row')).toHaveCount(12);
    const m = await measure(page);
    expect(m.allVisible, 'last of 12 rows is inside the list').toBe(true);
    expect(m.scrollable, 'twelve rows at the device size need no scrolling').toBe(false);
    expect(m.exportBottom).toBeLessThanOrEqual(m.innerHeight + 0.5);
    expect(m.target).toBeGreaterThanOrEqual(35);
  });

  test(`16 players at the device size keep every row at or above the ${ROW_FLOOR} px floor`, async ({ page, openApp }) => {
    await openApp();
    await openDay(page, rosterOf(16));
    const m = await measure(page);
    expect(m.heights).toHaveLength(16);
    for (const h of m.heights) expect(h).toBeGreaterThanOrEqual(ROW_FLOOR - 0.5);
    // At the device size sixteen rows may or may not need scrolling (the iPad is tall); when they do
    // not, the floor still held. The 375x652 case above pins that sixteen do scroll on a phone.
  });
});

/** The count buttons of one row, plus how far the page and the row reach sideways. */
function rowReach(page, pid) {
  return page.evaluate((id) => {
    const row = document.querySelector(`.rows .row:has([data-pid="${id}"])`);
    const name = row.querySelector('.name');
    return {
      width: window.innerWidth,
      docScroll: document.documentElement.scrollWidth,
      rowScroll: row.scrollWidth,
      rowClient: row.clientWidth,
      nameScroll: name.scrollWidth,
      nameClient: name.clientWidth,
      buttons: [...row.querySelectorAll('[data-action="tap-count"]')].map((b) => {
        const r = b.getBoundingClientRect();
        return { stat: b.dataset.stat, side: b.dataset.side, left: r.left, right: r.right };
      }),
    };
  }, pid);
}

async function expectLongNameContained(page) {
  const r = await rowReach(page, 'p1');
  // Vacuity guard: the name really is longer than its cell, so the clip is what keeps the row in.
  expect(r.nameScroll, 'the 64-character name overflows its own cell').toBeGreaterThan(r.nameClient);
  expect(r.buttons).toHaveLength(4);
  for (const b of r.buttons) {
    expect(b.left, `${b.stat} ${b.side} left edge`).toBeGreaterThanOrEqual(0);
    expect(b.right, `${b.stat} ${b.side} right edge`).toBeLessThanOrEqual(r.width);
  }
  expect(r.rowScroll, 'the row is wider than itself').toBeLessThanOrEqual(r.rowClient + 0.5);
  expect(r.docScroll, 'the page scrolls sideways').toBeLessThanOrEqual(r.width);
}

test.describe('Long names on a phone', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(!PHONE_PROJECTS.includes(testInfo.project.name), 'density is a phone and tablet property');
  });

  test('a 64-character name does not push the count buttons off screen', async ({ page, openApp }) => {
    await openApp();
    await openDay(page, rosterOf(6, (i) => (i === 0 ? LONG_NAME : NAMES[i])));
    await expect(page.locator('.rows .row')).toHaveCount(6);
    await expectLongNameContained(page);
  });

  test.describe('the smallest phone', () => {
    test.use({ viewport: { width: 320, height: 568 } });

    test('a 64-character name still fits at 320 px', async ({ page, openApp }) => {
      await openApp();
      await openDay(page, rosterOf(6, (i) => (i === 0 ? LONG_NAME : NAMES[i])));
      await expect(page.locator('.rows .row')).toHaveCount(6);
      expect(page.viewportSize().width).toBe(320);
      await expectLongNameContained(page);
    });
  });
});
