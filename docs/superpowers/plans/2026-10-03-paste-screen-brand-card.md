# Paste Screen Brand Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the copyright on screen as a brand card at the top of the "Open the day" paste screen: the ball mark, `CoachIQ Stats`, `Version <APP_VERSION>`, and `© 2026 Rory Bannon. All rights reserved.`

**Architecture:** `renderPaste()` in `src/ui.js` gains a static header block above the existing "Open the day" line. The copyright facts live as constants next to `APP_VERSION` in `src/session.js`, which is where the app already keeps its version. The new CSS goes in `src/styles.css` under the existing "paste roster screen" section. The record screen does not change, so `verify-density.mjs` is unaffected. This ships as release 4.2.0 with cache `ciq-stats-v11`.

**Tech Stack:** Plain ES modules rendered as template strings, `node --test` with the project's own fake DOM (`test/helpers/fake-dom.mjs`), and headless Edge via `puppeteer-core` for build checks.

**Spec:** `docs/copyright-mockup.html`, option 6 ("Paste screen brand card"). The user picked it on 2026-10-03. The mockup's `.brandcard` CSS and markup are the design source.

## Global Constraints

- Copyright text, exact: `© 2026 Rory Bannon. All rights reserved.` This matches the planner's About dialog and its `LICENSE` line `Copyright (c) 2026 Rory Bannon <rorybannon@outlook.com>`.
- App name, exact: `CoachIQ Stats`, the same as `<title>` in `src/index.html`.
- Version line, exact: `Version ${APP_VERSION}`. Never hardcode the number in the template.
- Light theme only. Use the existing `:root` tokens (`--fg-3`, `--line`, `--warn`, `--accent`) and no new colours.
- `src/ui.js` imports must stay on a single line, because the build inliner removes only full-line import statements (README "Develop").
- Interpolated values go through `esc()`, as everywhere else in `ui.js`.
- **Do not commit.** The user's global instructions forbid auto-commits. Leave all changes in the working tree, and the user commits.
- Release bump, both required (README "Update the app"): `APP_VERSION` `'4.1.0'` → `'4.2.0'` in `src/session.js`, and `CACHE` `'ciq-stats-v10'` → `'ciq-stats-v11'` in `src/sw.js`.

## Review Focus

1. **Record screen stays clean.** The card must never render on the record screen or its sheets, because every pixel there is row budget (`verify-density.mjs`). Pinned by the Task 1 test "the record screen shows no brand card".
2. **Paste screen reached again mid-day** (Games ▾ → "Paste a new day roster…", with Cancel shown). The coach expects the same card there. Pinned by the Task 1 test "the paste-again screen shows the brand card too".
3. **Smallest phone (320×568) with the error banner showing.** The card pushes content down, but "Open day" must stay on screen without scrolling. Pinned by the Task 2 headless check.
4. **Hardened build mangles the ©.** javascript-obfuscator moves string literals into an encoded array, and the page must still render `©` rather than mojibake. Pinned by the Task 2 headless check against `dist/`.
5. **Version drift.** The card's version must follow `APP_VERSION` on every bump. Pinned by the Task 1 test, which asserts against the imported constant, not a literal.

---

### Task 1: Brand card on the paste screen

**Files:**
- Modify: `src/session.js:9` (add two constants after `APP_VERSION`)
- Modify: `src/ui.js:6` (single-line import) and `src/ui.js:148-165` (`renderPaste`)
- Modify: `src/styles.css`, "paste roster screen" section (after `.summary-line`, around line 152)
- Test: `test/ui.test.mjs` (append three tests at the end)

**Interfaces:**
- Produces: `export const AUTHOR_NAME = 'Rory Bannon';` and `export const COPYRIGHT_YEAR = 2026;` in `src/session.js`. Rendered markup: `<div class="brandcard">` containing `.ball`, `h1.bname`, `.bver` and `.bcopy`.
- Consumes: the existing `APP_VERSION` and `esc()`, and the `freshEnv`, `bootUi`, `bootWithSession`, `click` and `newDayFromRoster` helpers already in `test/ui.test.mjs`.

- [ ] **Step 1: Write the failing tests**

Change the session import at the top of `test/ui.test.mjs` (line 19) so it also pulls in the version and copyright constants:

```js
import { parseSession, STORAGE_KEY, newDayFromRoster, serialiseSession, getCount, setServedFirst, tapPoint, setScore, APP_VERSION, AUTHOR_NAME, COPYRIGHT_YEAR } from '../src/session.js';
```

Append to the end of `test/ui.test.mjs`:

```js
// The copyright lives on the paste screen only (docs/copyright-mockup.html, option 6). The record
// screen has no height to spare (scripts/verify-density.mjs), so these pin both halves.
const COPYRIGHT = '© 2026 Rory Bannon. All rights reserved.';

test('the first-launch paste screen shows the brand card: name, live version, copyright', async () => {
  const { document } = freshEnv();
  await bootUi();
  const html = document.getElementById('app').innerHTML;
  assert.match(html, /class="brandcard"/);
  assert.ok(html.includes('CoachIQ Stats'), 'app name');
  assert.ok(html.includes(`Version ${APP_VERSION}`), 'version follows APP_VERSION');
  assert.ok(html.includes(COPYRIGHT), 'exact copyright wording');
  assert.equal(`© ${COPYRIGHT_YEAR} ${AUTHOR_NAME}. All rights reserved.`, COPYRIGHT, 'constants spell the same line');
});

test('the paste-again screen shows the brand card too', async () => {
  const day = newDayFromRoster({
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }],
    games: [{ gameId: 'g1', opponent: 'Lions', sets: [1] }],
  }, '2026-09-19T09:00:00Z');
  const { document } = await bootWithSession(day);
  click(document, '[data-action="open-switcher"]');
  click(document, '[data-action="switcher-paste-new-day"]');
  const html = document.getElementById('app').innerHTML;
  assert.match(html, /data-action="cancel-paste"/, 'this is the mid-day paste screen');
  assert.ok(html.includes(COPYRIGHT));
});

test('the record screen shows no brand card', async () => {
  const day = newDayFromRoster({
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }],
    games: [{ gameId: 'g1', opponent: 'Lions', sets: [1] }],
  }, '2026-09-19T09:00:00Z');
  const { document } = await bootWithSession(day);
  const html = document.getElementById('app').innerHTML;
  assert.match(html, /data-action="tap-count"/, 'this is the record screen');
  assert.doesNotMatch(html, /brandcard/);
  assert.ok(!html.includes('©'), 'no copyright on the record screen');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/ui.test.mjs`
Expected: the first two new tests FAIL. The import of `AUTHOR_NAME` / `COPYRIGHT_YEAR` gives `undefined`, and the HTML has no `brandcard`. The third test already PASSES, as a guard. Every existing test still passes.

- [ ] **Step 3: Add the constants**

In `src/session.js`, directly after `export const APP_VERSION = '4.1.0';` (line 9):

```js
export const AUTHOR_NAME = 'Rory Bannon';
export const COPYRIGHT_YEAR = 2026;
```

- [ ] **Step 4: Import them in `ui.js`**

In `src/ui.js` line 6, which must stay a single line, add `AUTHOR_NAME, COPYRIGHT_YEAR` after `APP_VERSION` in the import list:

```js
..., buildDayStatsPayload, gamePlayerIdsUnion, APP_VERSION, AUTHOR_NAME, COPYRIGHT_YEAR, MAX_SCORE, SESSION_SCHEMA } from './session.js';
```

- [ ] **Step 5: Render the card**

In `src/ui.js`, `renderPaste()`, insert the card as the first child of `.screen`, before the "Open the day" line:

```js
  return `
<div class="screen screen-pad">
  <div class="brandcard">
    <span class="ball" aria-hidden="true"></span>
    <h1 class="bname">CoachIQ Stats</h1>
    <div class="bver">Version ${esc(APP_VERSION)}</div>
    <div class="bcopy">© ${COPYRIGHT_YEAR} ${esc(AUTHOR_NAME)}. All rights reserved.</div>
  </div>
  <p class="summary-line" style="margin-bottom:12px;font-weight:650;font-size:15px;">Open the day</p>
```

The rest of the function is unchanged.

- [ ] **Step 6: Style the card**

In `src/styles.css`, in the `/* paste roster screen */` section, after the `.summary-line` rule, add the following. Values come from `docs/copyright-mockup.html` `.ball` and `.brandcard`. `h1` needs its UA margin and size reset.

```css
/* brand card at the top of the paste screen — the app's only on-screen copyright. Values from
   docs/copyright-mockup.html, option 6. Paste screen only: the record screen has no row budget
   to spare for it (scripts/verify-density.mjs). */
.brandcard { display:flex; flex-direction:column; align-items:center; text-align:center; padding:22px 0 18px; margin-bottom:14px; border-bottom:1px solid var(--line); flex:none; }
.brandcard .ball { width:44px; height:44px; margin-bottom:10px; border-radius:50%; background:conic-gradient(from 20deg, var(--warn), var(--accent), var(--warn)); box-shadow:inset 0 0 0 2px rgba(255,255,255,.85); }
.brandcard .bname { margin:0; font-size:19px; font-weight:650; letter-spacing:-.01em; line-height:1.3; }
.brandcard .bver { font-size:12px; color:var(--fg-3); }
.brandcard .bcopy { font-size:11px; color:var(--fg-3); margin-top:8px; }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: every test passes, including the three new ones.

- [ ] **Step 8: Leave the changes uncommitted**

Do not commit (see Global Constraints). Report the changed files: `src/session.js`, `src/ui.js`, `src/styles.css`, `test/ui.test.mjs`.

---

### Task 2: Release 4.2.0, build, and headless checks

**Files:**
- Modify: `src/session.js:9` (`APP_VERSION`)
- Modify: `src/sw.js:3` (`CACHE`)
- Modify: `README.md`, "Verify on the phone" checklist (add one line)
- Regenerated by the build: `dist/CoachIQ_Rotation_Planner_Client.html`, `dist/sw.js` (both tracked, as in earlier releases)
- Temporary, deleted after use: `scripts/.tmp-brandcard-check.mjs`

**Interfaces:**
- Consumes: the Task 1 markup (`.brandcard`, `.bcopy`) and the existing ids `#pasteText` and `[data-action="open-roster"]`.
- Produces: nothing later tasks use.

- [ ] **Step 1: Bump both release constants**

`src/session.js`: `export const APP_VERSION = '4.1.0';` becomes `export const APP_VERSION = '4.2.0';`
`src/sw.js` line 3: `const CACHE = 'ciq-stats-v10';` becomes `const CACHE = 'ciq-stats-v11';`

- [ ] **Step 2: Add the phone checklist line**

In `README.md` under "## Verify on the phone", insert this as the first item, before "Paste roster from the planner…":

```markdown
- [ ] First launch (and Games ▾ → Paste a new day roster…) shows the CoachIQ Stats card: ball, name, version 4.2.0, © 2026 Rory Bannon. All rights reserved. "Open day" is visible without scrolling.
```

- [ ] **Step 3: Test, build, verify**

Run: `npm test && npm run build && npm run verify`
Expected: all tests pass, then build output to `dist/`. Then `verify` prints PASS for build parity, the golden vector, and density. Density must still pass unchanged, since the record screen did not change.

- [ ] **Step 4: Write the headless brand-card check**

Create `scripts/.tmp-brandcard-check.mjs`. It lives in `scripts/` so it can import `browser-candidates.mjs` and resolve `puppeteer-core` from the project. The run step deletes it.

```js
// Temporary: checks the shipped dist/ paste screen renders the brand card intact (© survives the
// obfuscator) and that "Open day" stays on screen at the smallest phones, error banner showing.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BROWSER_CANDIDATES } from './browser-candidates.mjs';

const url = pathToFileURL('dist/CoachIQ_Rotation_Planner_Client.html').href;
const browser = await puppeteer.launch({ executablePath: BROWSER_CANDIDATES.find(existsSync), headless: true });
let failed = false;
for (const [w, h] of [[320, 568], [375, 652]]) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(url);
  await page.waitForSelector('#pasteText');
  await page.evaluate(() => { document.getElementById('pasteText').value = 'not a roster'; });
  await page.click('[data-action="open-roster"]');
  await page.waitForSelector('.banner.err');
  const r = await page.evaluate(() => {
    const btn = document.querySelector('[data-action="open-roster"]').getBoundingClientRect();
    return { copy: document.querySelector('.bcopy')?.textContent, btnBottom: btn.bottom, vh: innerHeight };
  });
  const ok = r.copy === '© 2026 Rory Bannon. All rights reserved.' && r.btnBottom <= r.vh;
  console.log(`${w}x${h}: copy=${JSON.stringify(r.copy)} openDayBottom=${r.btnBottom.toFixed(0)}/${r.vh} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failed = true;
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
```

- [ ] **Step 5: Run it, then delete it**

Run: `node scripts/.tmp-brandcard-check.mjs; rm scripts/.tmp-brandcard-check.mjs`
Expected: two lines, both ending in `PASS`, each showing `copy="© 2026 Rory Bannon. All rights reserved."`. If 320×568 fails because "Open day" sits below the fold, cut the card's vertical padding (`padding:22px 0 18px` → `14px 0 12px`, ball 44px → 36px). Then re-run Step 3 and this step. Do not shrink the textarea.

- [ ] **Step 6: Confirm the working tree and leave it uncommitted**

Run: `git status --short`
Expected: modified `README.md`, `dist/CoachIQ_Rotation_Planner_Client.html`, `dist/sw.js`, `src/session.js`, `src/styles.css`, `src/sw.js`, `src/ui.js`, `test/ui.test.mjs`, plus the untracked `docs/copyright-mockup.html` and this plan. No `scripts/.tmp-*` file. Do not commit. Do not run `npm run deploy`, because publishing is the user's call.
