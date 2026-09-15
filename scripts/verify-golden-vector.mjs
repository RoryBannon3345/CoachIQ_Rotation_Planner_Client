/**
 * Boots the SHIPPED dist/ bundle in headless Edge, pastes the contract's fixed
 * cross-app golden vector (guide §8; never regenerate it -- it is quoted byte for byte
 * in reference/stats-contract-v3-client-guide.md and the planner's own test suite),
 * and asserts the four facts a hand-eyeballed check in a browser cannot leave behind
 * for a reviewer:
 *
 *   1. `vs Lions` (3 sets: masks [3,1,2]) shows exactly three set tabs; `vs Falcons`
 *      (2 sets: masks [2,0]) shows exactly two.
 *   2. Lions set 1 (mask 3) lists both Grace and Zoe; set 2 (mask 1) lists Grace only;
 *      set 3 (mask 2) lists Zoe only.
 *   3. Falcons set 2 (mask 0) shows the "no players ticked for this set" empty state,
 *      and no `.err` banner appears anywhere on the page.
 *   4. Opening the players sheet on Lions set 2 shows BOTH players -- the whole day
 *      directory, never a per-set filtered view -- with only Grace ticked. A player
 *      absent from a set's mask must still be visible and tickable there.
 *
 * Follows the launch/boot conventions of scripts/verify-build.mjs (browser discovery,
 * incognito browser context, delegated-click driving). Exits non-zero on any failure.
 *
 * Usage: node scripts/verify-golden-vector.mjs
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { BROWSER_CANDIDATES } from './browser-candidates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_HTML = 'CoachIQ_Rotation_Planner_Client.html';
const SHIPPED_HTML = join(ROOT, 'dist', APP_HTML);

const executablePath = BROWSER_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chromium-based browser found; cannot verify.');
  process.exit(2);
}

if (!existsSync(SHIPPED_HTML)) {
  console.error(`${SHIPPED_HTML} does not exist -- run \`npm run build\` first.`);
  process.exit(2);
}

// The exact fixed golden vector from guide §8. Never regenerate this string.
const GOLDEN_VECTOR = 'CIQR3.eyJ2IjozLCJraW5kIjoicm9zdGVyIiwiZGF0ZSI6IjIwMjYtMDktMTkiLCJ0ZWFtIjoiVGh1bmRlciIsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJuYW1lIjoiR3JhY2UiLCJqZXJzZXkiOjd9LHsiaWQiOiJ6b2llIiwibmFtZSI6Ilpvw6sifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJvcHBvbmVudCI6Ikxpb25zIiwic2V0cyI6WzMsMSwyXX0seyJnYW1lSWQiOiJnYW1lLTIiLCJvcHBvbmVudCI6IkZhbGNvbnMiLCJzZXRzIjpbMiwwXX1dfQ.e9e26391';

const problems = [];
const fail = (msg) => { problems.push(msg); console.error(`FAIL: ${msg}`); };

async function waitSettled(page) {
  await page.waitForSelector('#app *', { timeout: 10_000 });
}

/** Reads the current screen's set tabs (`.seg button`) and the visible row names. */
async function readRecordScreen(page) {
  return page.evaluate(() => {
    const app = document.getElementById('app');
    const segButtons = [...document.querySelectorAll('.seg button')];
    const names = [...document.querySelectorAll('.rows .row .name')].map((el) => el.textContent.trim());
    const emptyState = document.querySelector('.rows.empty-state') !== null;
    const emptyStateText = document.querySelector('.rows.empty-state p')?.textContent.trim() ?? null;
    const errBanner = app ? app.querySelector('.err') !== null : false;
    return { setTabCount: segButtons.length, names, emptyState, emptyStateText, errBanner };
  });
}

async function selectSet(page, n) {
  const clicked = await page.evaluate((setN) => {
    const btn = document.querySelector(`.seg button[data-action="select-set"][data-n="${setN}"]`);
    if (!btn) return false;
    btn.click();
    return true;
  }, n);
  if (!clicked) throw new Error(`no set tab for set ${n}`);
  await waitSettled(page);
}

async function switchGame(page, gameId) {
  const clicked = await page.evaluate((gid) => {
    const openSwitcher = document.querySelector('[data-action="open-switcher"]');
    if (!openSwitcher) return 'missing [data-action="open-switcher"]';
    openSwitcher.click();
    const row = document.querySelector(`[data-action="switch-game"][data-gid="${gid}"]`);
    if (!row) return `missing switcher row for game "${gid}"`;
    row.click();
    return null;
  }, gameId);
  if (clicked) throw new Error(clicked);
  await waitSettled(page);
}

/** Opens the players sheet for the CURRENTLY active game/set and returns its tick-list. */
async function readPlayersSheet(page) {
  const err = await page.evaluate(() => {
    const openMenu = document.querySelector('[data-action="open-menu"]');
    if (!openMenu) return 'missing [data-action="open-menu"]';
    openMenu.click();
    const openPlayers = document.querySelector('[data-action="open-players"]');
    if (!openPlayers) return 'missing [data-action="open-players"]';
    openPlayers.click();
    return null;
  });
  if (err) throw new Error(err);
  await waitSettled(page);
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.ticklist li.tick:not(.addsub)')];
    return rows.map((li) => ({
      name: li.querySelector('.tname')?.textContent.trim() ?? '',
      checked: li.querySelector('input[type="checkbox"]')?.checked ?? false,
    }));
  });
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--allow-file-access-from-files'],
});

try {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });

    await page.goto(pathToFileURL(SHIPPED_HTML).href, { waitUntil: 'load' });
    await waitSettled(page);

    const pasted = await page.evaluate((text) => {
      const area = document.getElementById('pasteText');
      const open = document.querySelector('[data-action="open-roster"]');
      if (!area || !open) return false;
      area.value = text;
      open.click();
      return true;
    }, GOLDEN_VECTOR);
    if (!pasted) fail('could not find the paste screen (#pasteText / [data-action="open-roster"])');
    await waitSettled(page);

    // --- Fact 1 & Lions set 1: game-1 (Lions) is active by default after opening a day. ---
    let record = await readRecordScreen(page);
    if (record.errBanner) fail('an error banner (.err) is showing right after pasting the golden vector');
    if (record.setTabCount !== 3) fail(`vs Lions shows ${record.setTabCount} set tabs -- expected 3`);
    if (!(record.names.includes('Grace') && record.names.includes('Zoë'))) {
      fail(`Lions set 1 (mask 3) shows [${record.names.join(', ')}] -- expected both Grace and Zoë`);
    }

    // --- Fact 2: Lions set 2 (mask 1, Grace only) and set 3 (mask 2, Zoë only). ---
    await selectSet(page, 2);
    record = await readRecordScreen(page);
    if (!(record.names.includes('Grace') && !record.names.includes('Zoë'))) {
      fail(`Lions set 2 (mask 1) shows [${record.names.join(', ')}] -- expected Grace only`);
    }

    await selectSet(page, 3);
    record = await readRecordScreen(page);
    if (!(record.names.includes('Zoë') && !record.names.includes('Grace'))) {
      fail(`Lions set 3 (mask 2) shows [${record.names.join(', ')}] -- expected Zoë only`);
    }

    // --- Fact 4: players sheet on Lions set 2 -- whole directory, only Grace ticked. ---
    await selectSet(page, 2);
    let ticklist = await readPlayersSheet(page);
    if (ticklist.length !== 2) {
      fail(`Lions set 2 players sheet shows ${ticklist.length} rows -- expected 2 (the whole day directory)`);
    } else {
      const grace = ticklist.find((r) => r.name === 'Grace');
      const zoe = ticklist.find((r) => r.name === 'Zoë');
      if (!grace || !zoe) fail(`Lions set 2 players sheet rows are [${ticklist.map((r) => r.name).join(', ')}] -- expected Grace and Zoë`);
      if (!grace?.checked) fail('Lions set 2 players sheet does not show Grace as checked');
      if (zoe?.checked) fail('Lions set 2 players sheet shows Zoë as checked, but mask 1 does not include her');
    }
    await page.evaluate(() => document.querySelector('[data-action="close-sheet"]')?.click());
    await waitSettled(page);

    // --- Fact 1 (Falcons) & Fact 3: switch to game-2 (Falcons), 2 set tabs, set 2 (mask 0) empty. ---
    await switchGame(page, 'game-2');
    record = await readRecordScreen(page);
    if (record.setTabCount !== 2) fail(`vs Falcons shows ${record.setTabCount} set tabs -- expected 2`);

    await selectSet(page, 2);
    record = await readRecordScreen(page);
    if (!record.emptyState) {
      fail(`Falcons set 2 (mask 0) does not show the empty state -- rows shown: [${record.names.join(', ')}]`);
    } else if (record.emptyStateText !== 'No players ticked for this set yet.') {
      fail(`Falcons set 2 empty-state text is "${record.emptyStateText}" -- expected "No players ticked for this set yet."`);
    }
    if (record.errBanner) fail('Falcons set 2 (mask 0) shows an error banner -- a mask of 0 must never be treated as an error');

    if (pageErrors.length) {
      for (const e of pageErrors) fail(`runtime error: ${e}`);
    }
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}

if (problems.length === 0) {
  console.log('PASS: golden vector CIQR3… decodes and renders correctly in the shipped dist/ bundle.');
  console.log('  vs Lions: 3 set tabs, set 1 = Grace+Zoë, set 2 = Grace only, set 3 = Zoë only.');
  console.log('  vs Falcons: 2 set tabs, set 2 (mask 0) shows the empty state, no error banner.');
  console.log('  Lions set 2 players sheet: whole directory (Grace, Zoë), only Grace ticked.');
} else {
  console.error(`FAILED: ${problems.length} problem(s) found.`);
}

process.exit(problems.length === 0 ? 0 : 1);
