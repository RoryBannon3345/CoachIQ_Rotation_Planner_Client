# The rotation number and a plain Undo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The record screen shows the rotation the phone thinks we are in as an "R3" pill beside the Player column header, worked out from serve-first, the rally log and the 4.6.0 re-align shift; and the Undo button reads plain `↶ Undo`.

**Architecture:** `src/session.js` gets two pure exported helpers, `rotationAt(set, order, at)` and `rotation(set, order)`, that share the side-out walk with the existing private `planIndex` (one loop, two readers). `src/ui.js`'s `renderRecord` passes the number into the column header markup and drops the descriptive Undo label; `src/styles.css` gets one rule. Tests: `node --test` units for the helper and the markup, Playwright for the pill and the label on the shipped bundle.

**Tech Stack:** Plain JavaScript ES modules, no framework, no dependencies. `node --test` with the fake DOM in `test/helpers/fake-dom.mjs`; Playwright in `e2e/` over the built `dist/`; puppeteer-core scripts in `scripts/verify-*.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-08-rotation-number-design.md` (mockup: `docs/rotation-number-mockup.html`, option C). Background: `docs/superpowers/specs/2026-10-08-server-highlight-design.md` §3 defines the reading rule, `shift` and `standIns` that this plan reads.

## Global Constraints

- **Implementers never commit.** No `git commit`, `git push`, `git add`, `git stash`, `git checkout`, no `npm run deploy`, no `buildAndDeploy.bat`. Leave every change in the working tree; the controller manages git and the deploy after the whole plan is done.
- Implementers never dispatch subagents.
- Plain JS, no new dependencies. Each `import` line in `src/` must stay on ONE line (the build inliner strips single-line imports only).
- `rotation = mod(t + shift, 6) + 1`, where `t` counts rallies before `at` that we won while they served, and `shift` is the set's stored re-align offset (`set.shift ?? 0`). It is the rotation we stand in, so while they serve it is one **behind** the highlighted next server. Never advance it on a rally we lose.
- `rotationAt` returns `null` when: `set` is null, `isTypedSet(set)`, `set.servedFirst === null`, or `order` is an array whose length is not 6 (a Train line). A `null`/missing `order` still returns a number.
- Exact markup: the Player header is `<span>Player<span class="rot" data-rotation="3">R3</span></span>` with a number, and `<span>Player</span>` without. The Undo button is `<button type="button" class="btn sm undo" data-action="undo" ${undoDisabled}>↶ Undo</button>`, disabled exactly when `game.history.length === 0`.
- CSS is exactly one rule, added after `.colhead span:first-child` in `src/styles.css`: `.colhead .rot { display:inline-block; margin-left:6px; padding:0 5px; border-radius:999px; background:var(--accent); color:#fff; font-size:8px; line-height:1.2; letter-spacing:.04em; vertical-align:top; }`. The pill must not raise `.colhead`; `npm run verify:density` is the judge.
- Release: `APP_VERSION` `'4.7.0'`, service worker `CACHE` `'ciq-stats-v16'`, `dist/` rebuilt by `npm run build` only (never `node scripts/build.mjs`).
- Run every browser (`npm run verify`, `npm run test:browsers`, `npx playwright test …`) from **PowerShell** only; the Bash sandbox kills browsers.

## Review Focus

1. **Receiving first, before the first side-out:** the pill must read R1 while they serve, even though the highlighted next server is entry 1 (rotation 2). Pinned in Task 1 (`logged(false, '')` and `logged(false, 'T')`) and Task 2 (the receive-first ui case).
2. **A re-align, then Undo:** the pill must move with the shift and come back with Undo of the align entry. Pinned in Task 2 (ui test with `serveIn('cat')` then undo).
3. **A Train plan (7 to 16 long):** no pill and no exception, while the highlight still works. Pinned in Task 1 (`ORDER7` is null) and Task 2 (`planDay(['0123456', null])` renders no pill).
4. **An older roster with no plan:** the pill still shows from the rally log; `shift` is 0 there. Pinned in Task 1 (`order` null returns a number) and Task 2 (`ONE_SET` renders R1).
5. **The density budget:** a pill taller than the 8px header line pushes the twelfth row off an iPhone SE screen. Pinned in Task 4 (`npm run verify:density` must pass) and by the `line-height:1.2; vertical-align:top` in the rule.

---

### Task 1: `rotationAt` and `rotation` in session.js

**Files:**
- Modify: `src/session.js` (the `planIndex` helper at about line 660, and the exports right after `plannedServer`)
- Test: `test/session.test.mjs` (append after the `plannedServerAt` tests, about line 1417)

**Interfaces:**
- Consumes: the private `mod(a, m)`, `isTypedSet(set)`, and the set shape `{ servedFirst, points, shift }` as stored today.
- Produces: `export function rotationAt(set, order, at)` → `1..6 | null`; `export function rotation(set, order)` → `rotationAt(set, order, set.points.length)`. Task 2 imports `rotation`.

- [ ] **Step 1: Write the failing tests**

Append to `test/session.test.mjs` (after the existing `plannedServerAt` tests; `ORDER6`, `ORDER7`, `logged` and `SERVE_ORDER_VECTOR` are already in scope there; if `ORDER7` is not defined at module scope, define it as `const ORDER7 = [...ORDER6, 'gia'];` next to `ORDER6`):

```js
// ---- the rotation number (docs/superpowers/specs/2026-10-08-rotation-number-design.md) ----
test('rotationAt is the rotation we stand in: side-outs we win move it, lost rallies do not', () => {
  assert.equal(S.rotationAt(logged(true, ''), ORDER6, 0), 1, 'we serve first: rotation 1');
  assert.equal(S.rotationAt(logged(false, ''), ORDER6, 0), 1, 'we receive first: still rotation 1 (the next server is rotation 2)');
  assert.equal(S.rotationAt(logged(false, 'T'), ORDER6, 1), 1, 'they hold serve: no rotation');
  assert.equal(S.rotationAt(logged(false, 'U'), ORDER6, 1), 2, 'our first side-out: rotation 2');
  assert.equal(S.rotationAt(logged(true, 'T'), ORDER6, 1), 1, 'we lose our first rally: still rotation 1 while they serve');
  assert.equal(S.rotationAt(logged(true, 'TU'), ORDER6, 2), 2, 'we win it back: rotation 2');
  assert.equal(S.rotationAt(logged(true, 'UU'), ORDER6, 2), 1, 'a run of our rallies is one rotation');
  assert.equal(S.rotationAt(logged(true, 'TUTU'), ORDER6, 2), 2, 'at reads a prefix of the log');
});

test('rotationAt wraps past 6, adds the shift, and ignores stand-ins', () => {
  assert.equal(S.rotationAt(logged(true, 'TU'.repeat(5)), ORDER6, 10), 6);
  assert.equal(S.rotationAt(logged(true, 'TU'.repeat(6)), ORDER6, 12), 1, 'six side-outs wrap to rotation 1');
  assert.equal(S.rotationAt(logged(true, '', { shift: 2 }), ORDER6, 0), 3);
  assert.equal(S.rotationAt(logged(false, '', { shift: 5 }), ORDER6, 0), 6, 'rotation 6; the next server after the side-out is entry 0');
  assert.equal(S.rotationAt(logged(true, '', { standIns: { 0: 'gia' } }), ORDER6, 0), 1);
});

test('rotationAt is null for a Train-length plan, a typed set, an unanswered set or no set, and counts without a plan', () => {
  assert.equal(S.rotationAt(logged(true, 'TU'), ORDER7, 2), null, 'a 7-long plan walks spots, not rotations');
  assert.equal(S.rotationAt(logged(true, 'TU'), null, 2), 2, 'no plan: the log alone');
  assert.equal(S.rotationAt(logged(true, 'TU'), undefined, 2), 2);
  assert.equal(S.rotationAt({ ...logged(true, ''), score: [25, 20], points: '' }, ORDER6, 0), null, 'a typed set');
  assert.equal(S.rotationAt(logged(null, ''), ORDER6, 0), null, 'serve-first unanswered');
  assert.equal(S.rotationAt(null, ORDER6, 0), null, 'an untouched set');
});

test('rotation reads the end of the log, and while we serve its server is the planned server', () => {
  assert.equal(S.rotation(logged(true, 'TUU'), ORDER6), 2);
  assert.equal(S.rotation(null, ORDER6), null);
  const v = SERVE_ORDER_VECTOR;
  const set = logged(v.servedFirst, v.points);
  let weServe = v.servedFirst;
  for (let i = 0; i < v.points.length; i += 1) {
    if (weServe) assert.equal(v.order[S.rotationAt(set, v.order, i) - 1], v.servers[i], `rally ${i}`);
    weServe = v.points[i] === 'U';
  }
});
```

Check first that `isTypedSet` treats `{ score: [25, 20], points: '' }` as typed (grep `function isTypedSet` in `src/session.js`); if it needs other fields, build the typed set the way `setScore` does.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/session.test.mjs`
Expected: the four new tests FAIL with `S.rotationAt is not a function`.

- [ ] **Step 3: Share the side-out walk and add the helpers**

In `src/session.js`, replace the private `planIndex` with a shared walk plus two readers:

```js
/** The side-out walk for rally `at` of a logged set (spec §3 steps 1-2): `t` counts the rallies before
 * `at` that we won while they served, and `serving` is who serves rally `at`. Shared by the planned
 * server and the rotation number so the two can never disagree. */
function sideOuts(set, at) {
  let serving = set.servedFirst ? 'U' : 'T';
  let t = 0;
  for (let i = 0; i < at && i < set.points.length; i += 1) {
    if (set.points[i] === 'U' && serving === 'T') t += 1;
    serving = set.points[i];
  }
  return { t, serving };
}

/** The order index for rally `at` of a logged set (spec §3 steps 1-4): the turn is the side-out count
 * while we serve rally `at`, and the next one while they do. */
function planIndex(set, length, at) {
  const { t, serving } = sideOuts(set, at);
  const turn = serving === 'U' ? t : t + 1;
  return mod(turn + (set.shift ?? 0), length);
}
```

Then, after `plannedServer`, add:

```js
/** The rotation we are standing in for rally `at` of a logged set, 1-6: our side-outs before `at`
 * plus the re-align shift, mod 6, plus 1. The same whether we serve or receive; while they serve,
 * the highlighted next server is one rotation ahead. Null for an untouched or typed set, before
 * serve-first is answered, or under a Train-length plan (a line of spots, not rotations). No plan
 * at all still counts from the log. */
export function rotationAt(set, order, at) {
  if (!set || isTypedSet(set) || set.servedFirst === null) return null;
  if (Array.isArray(order) && order.length !== 6) return null;
  return mod(sideOuts(set, at).t + (set.shift ?? 0), 6) + 1;
}

/** rotationAt at the end of the log: the number the record screen shows. */
export function rotation(set, order) {
  return rotationAt(set, order, set ? set.points.length : 0);
}
```

- [ ] **Step 4: Run the whole unit suite**

Run: `npm test`
Expected: all PASS, including every existing `plannedServerAt` test (the refactor must not change its results) and the self-check test that reads `SERVE_ORDER_VECTOR`.

### Task 2: The pill in the column header

**Files:**
- Modify: `src/ui.js` (the import line at the top, which must stay on one line; `renderRecord` around lines 627–679)
- Modify: `src/styles.css` (after `.colhead span:first-child`, line 94)
- Test: `test/ui.test.mjs` (append after the planned-server tests; `planDay`, `renderWith`, `bootWithSession`, `click`, `serveIn`, `ONE_SET` are in scope)
- Test: `e2e/record.spec.mjs` (a new test after 'the planned server is highlighted while we serve and while we receive')

**Interfaces:**
- Consumes: `rotation(set, order)` from Task 1.
- Produces: the header markup `<span>Player<span class="rot" data-rotation="N">RN</span></span>`. Task 3 and the README rely on nothing else.

- [ ] **Step 1: Write the failing unit tests**

Append to `test/ui.test.mjs`:

```js
// ---- the rotation number (docs/superpowers/specs/2026-10-08-rotation-number-design.md) ----
const pill = (n) => new RegExp(`<span>Player<span class="rot" data-rotation="${n}">R${n}</span></span>`);
const noPill = /<span>Player<\/span>/;

test('the Player header shows the rotation we stand in, through a serve, a lost rally and a side-out', async () => {
  let day = setServedFirst(planDay(), 'g1', 1, true);
  assert.match(await renderWith(day, 'g1'), pill(1));
  day = tapPoint(day, 'g1', 1, 'T'); // we lose: they serve, Bea is next, but we are still in rotation 1
  assert.match(await renderWith(day, 'g1'), pill(1));
  day = tapPoint(day, 'g1', 1, 'U'); // side-out: rotation 2
  assert.match(await renderWith(day, 'g1'), pill(2));
  let recv = setServedFirst(planDay(), 'g1', 1, false);
  assert.match(await renderWith(recv, 'g1'), pill(1), 'receiving first is still rotation 1');
  recv = tapPoint(recv, 'g1', 1, 'U');
  assert.match(await renderWith(recv, 'g1'), pill(2));
});

test('the rotation shows without a plan, and not before serve-first, for a typed set or under a Train plan', async () => {
  const older = setServedFirst(newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z'), 'g1', 1, true);
  assert.match(await renderWith(older, 'g1'), pill(1), 'an older roster');
  assert.match(await renderWith(planDay(), 'g1'), noPill, 'serve-first unanswered');
  assert.match(await renderWith(setScore(planDay(), 'g1', 1, [25, 20]), 'g1'), noPill, 'a typed set');
  const train = setServedFirst(planDay(['0123456', null]), 'g1', 1, true);
  const html = await renderWith(train, 'g1');
  assert.match(html, noPill, 'a Train-length plan');
  assert.equal(servingRows(html).length, 1, 'the highlight still works under a Train plan');
});

test('a re-align moves the rotation, and Undo brings it back', async () => {
  const { document } = await bootWithSession(planDay());
  click(document, serveIn('cat')); // answers "we serve first"; the plan says Ana (rotation 1), Cat is rotation 3
  assert.match(document.getElementById('app').innerHTML, pill(3));
  click(document, '[data-action="undo"]');
  assert.match(document.getElementById('app').innerHTML, pill(1));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- test/ui.test.mjs`
Expected: the three new tests FAIL (the header has no pill).

- [ ] **Step 3: Render the pill**

In `src/ui.js`:
1. Add `rotation` to the single-line import from `./session.js` (next to `plannedServer`).
2. In `renderRecord`, right after the `serverId` line:

```js
  const order = Array.isArray(game.serveOrders) ? game.serveOrders[n - 1] : null;
  const serverId = typed ? null : plannedServer(setRecord, order);
  // The rotation we stand in (rotation spec §1): null when there is nothing to count or the plan is a Train line.
  const rot = typed ? null : rotation(setRecord, order);
  const rotHtml = rot === null ? '' : `<span class="rot" data-rotation="${rot}">R${rot}</span>`;
```

(Replace the existing `serverId` line, which computed `order` inline, with these.)
3. In the returned template, change the column header's first cell to `<span>Player${rotHtml}</span>`.

In `src/styles.css`, after `.colhead span:first-child { text-align:left; }`, add:

```css
.colhead .rot { display:inline-block; margin-left:6px; padding:0 5px; border-radius:999px; background:var(--accent); color:#fff; font-size:8px; line-height:1.2; letter-spacing:.04em; vertical-align:top; }
```

- [ ] **Step 4: Run the unit suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Add the browser test**

In `e2e/record.spec.mjs`, after the test 'the planned server is highlighted while we serve and while we receive', add:

```js
  test('the Player header shows the rotation, which moves only when we win the ball back', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText(plannedPayload()));
    const rot = page.locator('.colhead .rot');
    await expect(rot).toHaveCount(0); // serve-first not answered yet
    await press(page.locator('[data-action="serve-first"][data-us="1"]'));
    await expect(rot).toHaveText('R1');
    await press(count(page, 'grace', 'serve', 'out')); // rally lost: they serve; still rotation 1
    await expect(rot).toHaveText('R1');
    await expect(page.locator('.rows .row.serving .name')).toHaveText('Zoë');
    await press(count(page, 'zoie', 'serve', 'in')); // side-out: rotation 2
    await expect(rot).toHaveText('R2');
    await expect(rot).toHaveAttribute('data-rotation', '2');
  });
```

- [ ] **Step 6: Build and run that spec on one project, from PowerShell**

Run (PowerShell): `npm run build; npx playwright test e2e/record.spec.mjs --project="iPhone 15"`
(If the project name differs, list them with `npx playwright test --list` and pick the iPhone one.)
Expected: the new test passes, and the existing record tests still pass.

### Task 3: Plain `↶ Undo`

**Files:**
- Modify: `src/ui.js` (the `undoLabel` line, about 662, and the button at about 684; the now-unused helpers `statLetter` at about 45 and `lettersLabel` at about 82 if nothing else uses them)
- Test: `test/ui.test.mjs` lines about 367, 542, 667–677
- Test: `e2e/record.spec.mjs` lines about 15, 20, 57, 64, 97, 145, 149; `e2e/persist.spec.mjs` line about 61

**Interfaces:**
- Consumes: nothing new.
- Produces: the Undo button is always `↶ Undo`; its disabled state is unchanged.

- [ ] **Step 1: Update the unit tests first**

In `test/ui.test.mjs`:
- Line ~367: replace `assert.match(html, /↶ Undo point Them/);` with `assert.match(html, /data-action="undo" >↶ Undo<\/button>/);` (the button renders `data-action="undo" ${undoDisabled}>`, so with history there is one space before `>`; check the exact rendered string with a quick `console.log` if the regex misses, and match what is rendered).
- Line ~542: replace `assert.match(html, /↶ Undo Grace S out \+ Us, Them/);` with the same enabled-Undo assertion.
- The test at ~667 'a Serve tap for someone else re-aligns: the toast names her, Undo reads ↶ Undo re-align and keeps the stat': rename it to '… re-aligns: the toast names her, one Undo takes back the re-align and keeps the stat', and replace both label assertions (`↶ Undo re-align` and `↶ Undo Cat S in`) with `assert.match(html, /data-action="undo" >↶ Undo<\/button>/);`. The `servingRow` and count assertions stay, so the test still proves the first Undo reverses only the re-align.
- Add one new test:

```js
test('the Undo button is plain ↶ Undo, disabled with no history and enabled with some', async () => {
  const day = newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z');
  assert.match(await renderWith(day, 'g1'), /data-action="undo" disabled>↶ Undo<\/button>/);
  const html = await renderWith(tap(day, 'g1', 1, 'grace', 'serve', 'in', 1), 'g1');
  assert.match(html, /data-action="undo" >↶ Undo<\/button>/);
  assert.doesNotMatch(html, /Undo Grace|Undo point|Undo re-align/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- test/ui.test.mjs`
Expected: the edited and new tests FAIL on the old labels.

- [ ] **Step 3: Simplify the label**

In `src/ui.js`, replace the `undoLabel` line with nothing and render the button as:

```js
    <button type="button" class="btn sm undo" data-action="undo" ${undoDisabled}>↶ Undo</button>
```

Then grep `statLetter(` and `lettersLabel(` in `src/ui.js`. If their only caller was the old label, delete both functions and their comments. Keep `firstName` (the toasts use it) and fix its comment at ~73 ("First names, like the Undo label" → "First names.").

- [ ] **Step 4: Run the unit suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Update the browser assertions**

In `e2e/record.spec.mjs`:
- Line ~15 `toHaveText('↶ Undo Grace R out + Them, Them')` → `toBeEnabled()`.
- Line ~20 `toHaveText('↶ Undo Grace R in')` → `toHaveText('↶ Undo')` (one explicit label check in the suite).
- Line ~57 `toHaveText('↶ Undo')` → `toBeDisabled()` (it was proving the ignored tap left no history).
- Line ~64 `toHaveText('↶ Undo point Them')` → `toBeEnabled()`.
- Line ~97 `toHaveText('↶ Undo Grace S out + Us, Them')` → `toBeEnabled()`.
- Lines ~145 and ~149 (`↶ Undo re-align`, `↶ Undo Lily S in`) → delete both lines; the `serving` and count assertions around them already prove the behaviour.

In `e2e/persist.spec.mjs` line ~61: delete the `toHaveText('↶ Undo re-align')` line; the following press and `serving` assertion prove the re-align is still undoable after reload.

- [ ] **Step 6: Build and run the two specs, from PowerShell**

Run (PowerShell): `npm run build; npx playwright test e2e/record.spec.mjs e2e/persist.spec.mjs --project="iPhone 15"`
Expected: PASS.

### Task 4: Release 4.7.0

**Files:**
- Modify: `src/session.js:9` (`APP_VERSION`), `src/sw.js:3` (`CACHE`)
- Modify: `README.md` (line 5, and the Verify checklist after the `(4.6.0)` lines at ~218–220)
- Modify: `dist/` via `npm run build`

- [ ] **Step 1: Bump the version and cache**

`src/session.js`: `export const APP_VERSION = '4.7.0';`
`src/sw.js`: `const CACHE = 'ciq-stats-v16';`
Grep `4.6.0` and `ciq-stats-v15` across `test/`, `e2e/`, `scripts/`; if any test asserts the old value, update it to the new one.

- [ ] **Step 2: README**

Line 5 ends today with "The record screen highlights the player who should be serving." Change it to "The record screen highlights the player who should be serving and shows the rotation we are in."

After the three `(4.6.0)` checklist lines, add:

```
- [ ] (4.7.0) Tap We serve first → the Player column header shows "R1"; tap Serve Out for the highlighted player → still "R1" while they serve (the highlight moves to our next server); tap Serve In for her → "R2". Receiving first also starts at "R1".
- [ ] (4.7.0) Open an older roster (no plan) and answer serve-first → the "R" pill still shows; a Train set (a plan longer than six) shows no pill.
- [ ] (4.7.0) Tap Serve In for someone other than the highlighted player → the pill jumps to her rotation; the Undo button reads plain "↶ Undo", and one Undo puts the pill and the highlight back.
```

Also update the two older checklist lines that quote a descriptive label: line ~211 `Undo reads '↶ Undo point Them'` → `Undo is enabled`; line ~219 `Undo reads "↶ Undo re-align": one Undo …` → `one Undo …`. Line ~203 "Undo reverses the last tap and shows what it undid" → "Undo reverses the last tap".

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `dist/CoachIQ_Rotation_Planner_Client.html` and `dist/sw.js` rewritten; `git status` shows both modified.

- [ ] **Step 4: Gates, from PowerShell**

Run (PowerShell), in order:
1. `npm test` → all pass.
2. `npm run verify` → the parity check, the golden vector and **the density check** all pass. If density fails on the column header, shrink the pill (`line-height:1.1`, then `font-size:7.5px`) and rebuild; never touch `.colhead`'s padding.
3. `npm run test:browsers` → all pass on every project (the phone-fit specs are skipped on desktop projects, which is expected).

Report the exact pass/fail output of each. Do not commit.
