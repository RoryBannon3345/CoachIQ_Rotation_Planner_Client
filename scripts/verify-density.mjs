// verify-density.mjs — boots the shipped dist/ bundle at real iPhone viewports and asserts
// that a full 12-player game fits on one screen, with tap targets that stay hittable.
//
// This exists because the failure it guards is invisible. A roster that overflows by a few
// pixels looks exactly like one that fits until a coach reaches for the twelfth girl mid-rally
// and finds she has to scroll — and the pixels move whenever the chrome above the rows changes.
// Two real examples, both found by measuring rather than reading: the topbar's height is set by
// its 44px icon buttons and ignores its own min-height, and at 375px wide "RETURN OUT" wrapped
// to a second line, silently costing 12.7px on exactly the device that could least afford it.
//
// The viewport heights are the app's share of the screen, measured off a real iPhone
// screenshot: a browser tab keeps 652 of an X-class device's 812 CSS px (the URL bar and
// toolbar take the rest), and a home-screen launch keeps 734.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_CANDIDATES } from './browser-candidates.mjs';
import { APP_HTML } from './build.mjs';
import { encodeDayRoster } from '../src/codec.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = join(ROOT, 'dist', APP_HTML);

/** The floor in styles.css (`grid-auto-rows: minmax(38px, 1fr)`). Below this the list is meant
 *  to scroll rather than shrink, so a viewport too short for 12 rows is a pass, not a failure. */
const ROW_FLOOR = 38;

const NAMES = ['Addison', 'Brooklyn', 'Brynn', 'Emily', 'Grace', 'Hailey', 'Lexi', 'Lily', 'Melanie', 'Maya', 'Nora', 'Zoie'];

/** A one-game day whose single set names every player, so all `n` rows render. */
function rosterFor(n) {
  return encodeDayRoster({
    v: 3, kind: 'roster', date: '2026-09-18', team: 'Blizzard',
    players: NAMES.slice(0, n).map((name, i) => ({ id: `p${i + 1}`, name })),
    games: [{ gameId: 'g1', opponent: 'Practice_9_18', sets: [2 ** n - 1] }],
  });
}

const CASES = [
  // label, width, height, players, expectations
  { label: 'iPhone X-class, browser tab', w: 375, h: 652, n: 12, allVisible: true, minTarget: 35 },
  { label: 'iPhone X-class, home screen', w: 375, h: 734, n: 12, allVisible: true, minTarget: 42 },
  { label: 'iPhone 15 Pro, browser tab', w: 393, h: 692, n: 12, allVisible: true, minTarget: 38 },
  { label: 'iPhone 15 Pro, home screen', w: 393, h: 774, n: 12, allVisible: true, minTarget: 44 },
  // Six players must not leave the rows squashed at the top with dead space below them:
  // the same rule that compresses twelve has to expand six.
  { label: 'X-class browser, 6 players', w: 375, h: 652, n: 6, allVisible: true, minTarget: 60 },
];

if (!existsSync(SHIPPED)) {
  console.error(`FAIL: ${SHIPPED} does not exist — run \`npm run build\` first.`);
  process.exit(1);
}
const exe = BROWSER_CANDIDATES.find(existsSync);
if (!exe) {
  console.error('FAIL: no Edge or Chrome found. Checked:');
  for (const c of BROWSER_CANDIDATES) console.error(`  ${c}`);
  process.exit(1);
}

let failed = false;
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] });
try {
  for (const c of CASES) {
    // Its own context per case: the app saves the day to localStorage, so a shared profile
    // would send the second case straight to the record screen with no paste box to fill.
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: c.w, height: c.h, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await page.goto(`file://${SHIPPED.replace(/\\/g, '/')}`);
    await page.waitForSelector('textarea');
    await page.evaluate((text) => {
      const ta = document.querySelector('textarea');
      ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, rosterFor(c.n));
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /open day/i.test(b.textContent)).click());
    await page.waitForSelector('.row');

    const m = await page.evaluate(() => {
      const rows = document.querySelector('.rows');
      const all = [...document.querySelectorAll('.row')];
      const box = rows.getBoundingClientRect();
      const last = all[all.length - 1].getBoundingClientRect();
      return {
        rendered: all.length,
        rowH: +all[0].getBoundingClientRect().height.toFixed(1),
        target: +all[0].querySelector('.cnt').getBoundingClientRect().height.toFixed(1),
        // The half-pixel allowance is for sub-pixel layout, not slack: a row hidden by a
        // whole pixel is a row the coach has to scroll for.
        allVisible: last.bottom <= box.bottom + 0.5,
      };
    });

    const problems = [];
    if (m.rendered !== c.n) problems.push(`rendered ${m.rendered} rows, expected ${c.n}`);
    // Only enforce "fits" while the rows are above the floor. Once they are at it, the list
    // is supposed to scroll — that is the documented trade, not a regression.
    if (c.allVisible && !m.allVisible && m.rowH > ROW_FLOOR + 0.5) {
      problems.push(`only part of the roster is visible at ${m.rowH}px rows`);
    } else if (c.allVisible && !m.allVisible) {
      problems.push(`rows hit the ${ROW_FLOOR}px floor and the roster no longer fits`);
    }
    if (m.target < c.minTarget) problems.push(`tap target ${m.target}px is under the ${c.minTarget}px this case requires`);

    const status = problems.length ? 'FAIL' : 'ok  ';
    console.log(`${status} ${c.label.padEnd(30)} ${c.n} players | row ${String(m.rowH).padStart(5)}px | target ${String(m.target).padStart(5)}px | all visible: ${m.allVisible ? 'yes' : 'no'}`);
    for (const p of problems) console.error(`       ${p}`);
    if (problems.length) failed = true;
    await ctx.close();
  }
} finally {
  await browser.close();
}

if (failed) {
  console.error('\nFAIL: the record screen no longer fits a full roster. Something above the rows grew —');
  console.error('      check .topbar / .setbar / .colhead heights, and whether a column header wrapped.');
  process.exit(1);
}
console.log('\nPASS: a full 12-player game fits on one screen on every supported iPhone viewport,');
console.log('      and a 6-player game expands to fill it rather than squashing to the top.');
