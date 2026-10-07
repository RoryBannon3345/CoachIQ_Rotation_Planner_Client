# Minus cancels an open rally, and typing a final score over a log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A minus on the tap that opened the open rally cancels that rally, and a set with a rally log can have its log replaced by a typed final score in one step.

**Architecture:** Both rules live in the pure state model `src/session.js`: `tap()` gains a minus branch that clears `pending` when the decrement targets the rally's opener (recorded as `pendingBefore`, so the existing Undo re-opens it), and a new `replaceLogWithScore()` composes the existing `clearPoints` and `setScore`. `src/ui.js` adds a toast, a menu item and a "replace mode" for the existing score sheet.

**Tech Stack:** Plain JavaScript ES modules, no framework, no dependencies. `node --test` with the fake DOM in `test/helpers/fake-dom.mjs`; Playwright in `e2e/`.

**Spec:** `docs/superpowers/specs/2026-10-07-minus-cancels-and-typed-score-design.md` (mockup: `docs/minus-and-typed-score-mockup.html`)

## Global Constraints

- **Never commit.** No `git commit`, `git push`, `git add`, `git stash`, `git checkout`, no `npm run deploy`. Leave every change in the working tree; the controller manages git.
- Never dispatch subagents.
- Plain JS, no new dependencies. Each `import` line in `src/` must stay on ONE line (the build inliner strips single-line imports only).
- Export contract unchanged (v4); `SESSION_SCHEMA` stays 4; no new stored fields. Do not touch `src/codec.js`, `src/vectors.js`, `reference/`.
- Exact UI strings (verbatim):
  - toast: `Open rally cancelled`
  - menu item: `Type the final score…` (data-action `open-score`), directly above `Clear points for Set n…`, logged sets only
  - replace-mode helper: `Replaces the rally log (Us A – B Them, R rallies) with the score you type. Serve and return counts stay. Undo can't bring the log back.` (`1 rally` when R is 1)
  - replace-mode buttons: `Cancel` (`btn`, data-action `close-sheet`) and `Replace log` (`btn danger`, data-action `score-done`)
- Release: `APP_VERSION` `4.4.0`, service worker `CACHE` `ciq-stats-v13`, `dist/` rebuilt by `npm run build` only.
- The record screen's row and bar heights must not change (`npm run verify` passes).

## Review Focus

1. **A minus on a different player's In counter while a rally is open** (correcting an old miscount mid-rally): must not cancel the rally. Pinned in Task 1 ("a minus anywhere else leaves the open rally alone").
2. **Undo of the cancelling minus**: must re-open the rally and restore the count. Pinned in Task 1.
3. **Reload after a cancel or a replace**: the save must stay readable. Pinned in Task 1 (round-trip assertions).
4. **Replace on a one-rally log**: helper must say `1 rally`. Pinned in Task 2.
5. **Unlogged set's score sheet**: must look and behave exactly as before (Clear score / Done). Pinned in Task 2.

---

### Task 1: State model — minus cancels the opener's rally; replaceLogWithScore

**Files:**
- Modify: `src/session.js` (`tap`, currently `export function tap(` around line 424; add `rallyOpener` above it; add `replaceLogWithScore` after `setScore`)
- Test: `test/session.test.mjs` (append at the end; reuse the helpers `open`, `set1`, `t` already defined near the end of the file)

**Interfaces:**
- Consumes: existing `withGame`, `applyDelta`, `getCount`, `emptySet`, `isTypedSet`, `inferTap`, `clearPoints`, `setScore`, `UNDO_LIMIT`, `MAX_POINTS`.
- Produces (Task 2 imports by this exact name): `export function replaceLogWithScore(s, gameId, n, score /* [us, them] */) → session`. A cancelling minus history entry is `{ kind: 'count', n, playerId, stat, side: 'in', delta: -1, pendingBefore: 'serve' | 'return' }`.

- [ ] **Step 1: Write the failing tests** — append to `test/session.test.mjs`:

```js
// ---- minus cancels an open rally; replace a log with a typed score
// (docs/superpowers/specs/2026-10-07-minus-cancels-and-typed-score-design.md) ----

test('a minus on the tap that opened the rally cancels it: no phantom point', () => {
  let s = t(open(), 'grace', 'serve', 'in');
  s = t(s, 'grace', 'serve', 'in'); // rally 1 to Us; Grace's second serve opens a rally — the wrong row
  s = t(s, 'grace', 'serve', 'in', -1);
  assert.deepEqual([set1(s).points, set1(s).pending], ['U', null]);
  assert.deepEqual(s.games[0].history.at(-1), { kind: 'count', n: 1, playerId: 'grace', stat: 'serve', side: 'in', delta: -1, pendingBefore: 'serve' });
  assert.equal(S.parseSession(S.serialiseSession(s)).ok, true);
  s = t(s, 'zoie', 'serve', 'in'); // the right row opens the rally afresh
  assert.deepEqual([set1(s).points, set1(s).pending], ['U', 'serve']);
});

test('Undo of a cancelling minus re-opens the rally and restores the count', () => {
  let s = t(open(), 'grace', 'serve', 'in');
  s = t(s, 'grace', 'serve', 'in', -1);
  assert.equal(set1(s).pending, null);
  const u = S.undo(s, 'game-1').session;
  assert.deepEqual([set1(u).pending, S.getCount(u.games[0], 1, 'grace').serve.in], ['serve', 1]);
});

test('a minus anywhere else leaves the open rally alone', () => {
  let s = t(open(), 'zoie', 'serve', 'in'); // answers serve-first, rally open
  s = t(s, 'grace', 'serve', 'out'); // rally to Us, then the Out: nothing open
  s = t(s, 'grace', 'return', 'in'); // they serve; Grace's return opens a rally
  s = t(s, 'grace', 'serve', 'in'); // we serve: rally to Us, and Grace's serve opens one
  assert.deepEqual([set1(s).points, set1(s).pending], ['UTU', 'serve']);
  const kept = (next, why) => assert.equal(set1(next).pending, 'serve', why);
  const other = t(s, 'zoie', 'serve', 'in', -1);
  kept(other, 'another player');
  assert.equal('pendingBefore' in other.games[0].history.at(-1), false);
  kept(t(s, 'grace', 'serve', 'out', -1), 'the Out side');
  kept(t(s, 'grace', 'return', 'in', -1), 'the other stat');
  kept(t(s, 'grace', 'return', 'out', -1), 'a no-op at 0');
});

test('replaceLogWithScore swaps the rally log for a typed score in one step; counts stay', () => {
  let s = t(open(), 'grace', 'serve', 'in');
  s = t(s, 'grace', 'serve', 'in');
  s = S.tapPoint(s, 'game-1', 1, 'T');
  s = S.replaceLogWithScore(s, 'game-1', 1, [25, 23]);
  assert.deepEqual([set1(s).score, set1(s).points, set1(s).servedFirst, set1(s).pending], [[25, 23], '', null, null]);
  assert.equal(S.getCount(s.games[0], 1, 'grace').serve.in, 2);
  assert.deepEqual(s.games[0].history.map((h) => Object.keys(h).sort().join()), ['delta,kind,n,playerId,side,stat', 'delta,kind,n,playerId,side,stat']);
  assert.equal(S.isSetPlayed(set1(s)), true);
  assert.equal(S.parseSession(S.serialiseSession(s)).ok, true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/session.test.mjs`
Expected: the four new tests FAIL (`pending` stays `'serve'` after the minus; `S.replaceLogWithScore is not a function`).

- [ ] **Step 3: Implement** in `src/session.js`.

Above `export function tap(`, add:

```js
/** The tap that opened set n's open rally: the most recent count entry for that set that raised
 * a count. While a rally is open no later raising tap or pill tap can exist for that set (each
 * would have moved or closed `pending`), so this is the opener. Null if the 400-entry cap dropped it. */
function rallyOpener(history, n) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i];
    if (h.kind === 'count' && h.n === n && h.delta > 0) return h;
  }
  return null;
}
```

In `tap`, directly after the closing `}` of the `if (entry.delta > 0 && !isTypedSet(prevSet)) { … }` block, add an `else if` so the block reads `if (…) { … } else if (…) { … }`:

```js
    } else if (entry.delta < 0 && !isTypedSet(prevSet) && (prevSet.pending ?? null) !== null && side === 'in' && stat === prevSet.pending) {
      // A minus on the tap that opened the open rally — the "wrong row" correction — cancels that
      // rally. Undo of this entry re-opens it through pendingBefore.
      const opener = rallyOpener(g.history, n);
      if (opener && opener.playerId === playerId && opener.stat === stat) {
        sets = game.sets.slice();
        sets[n - 1] = { ...game.sets[n - 1], pending: null };
        entry.pendingBefore = prevSet.pending;
      }
    }
```

After `setScore`, add:

```js
/** Swaps a set's rally log for a typed final score in one step: the log, the serve-first answer
 * and any open rally go (clearPoints), then the score is typed (setScore). Counts stay. Like
 * clearPoints it cannot be undone — the score sheet says so before it runs. */
export function replaceLogWithScore(s, gameId, n, score) {
  return setScore(clearPoints(s, gameId, n), gameId, n, score);
}
```

Also update the comment above `tap` if it describes minus taps as never touching `pending`.

- [ ] **Step 4: Run the whole unit suite**

Run: `npm test`
Expected: all pass (`ℹ fail 0`). If an existing test fails, decide whether the spec requires the new value (update precisely, never loosen) or it is a regression (fix the code); list each in the report.

- [ ] **Step 5: Leave the changes uncommitted** and write the report.

---

### Task 2: Record screen — cancel toast, menu item, replace-mode score sheet

**Files:**
- Modify: `src/ui.js` (import line 6; `onTapCount`; `renderMenuSheet` ~468-491; `renderScoreSheet` ~302-322; `onOpenScore` ~765-773; `onScoreDone` ~794-811)
- Test: `test/ui.test.mjs` (append at the end; `ONE_SET`, `tap`, `bootWithSession`, `renderWith`, `click`, `parseSession`, `STORAGE_KEY`, `newDayFromRoster` already exist in the file)

**Interfaces:**
- Consumes: `replaceLogWithScore(s, gameId, n, score)` from Task 1; a cancelling minus entry carries `pendingBefore`.
- Produces: markup used by Task 3's browser tests — the toast `<div class="toast" role="status" aria-live="polite">Open rally cancelled</div>`; menu `<button type="button" data-action="open-score">Type the final score…</button>`; sheet buttons `<button type="button" class="btn" data-action="close-sheet">Cancel</button>` and `<button type="button" class="btn danger" data-action="score-done">Replace log</button>`.

- [ ] **Step 1: Write the failing tests** — append to `test/ui.test.mjs`:

```js
test('a minus that cancels the open rally says so, and the pills stop looking open', async () => {
  let day = newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z');
  day = tap(day, 'g1', 1, 'grace', 'serve', 'in', 1); // rally open
  const { document } = await bootWithSession(day);
  click(document, '[data-action="toggle-minus"]');
  click(document, '[data-action="tap-count"][data-pid="grace"][data-stat="serve"][data-side="in"]');
  const html = document.getElementById('app').innerHTML;
  assert.match(html, /<div class="toast" role="status" aria-live="polite">Open rally cancelled<\/div>/);
  assert.doesNotMatch(html, /data-open="1"/);
});

test('a logged set offers Type the final score…; the sheet replaces the log with the typed score', async () => {
  let day = newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z');
  day = tap(day, 'g1', 1, 'grace', 'serve', 'in', 1);
  day = tap(day, 'g1', 1, 'grace', 'serve', 'out', 1); // log UT
  const { store, document } = await bootWithSession(day);
  click(document, '[data-action="open-menu"]');
  let html = document.getElementById('app').innerHTML;
  assert.match(html, /data-action="open-score">Type the final score…<\/button><\/li>\s*<li><button type="button" data-action="menu-clear-points"/);
  click(document, '[data-action="open-score"]');
  html = document.getElementById('app').innerHTML;
  assert.match(html, /Replaces the rally log \(Us 1 – 1 Them, 2 rallies\) with the score you type\. Serve and return counts stay\. Undo can&#39;t bring the log back\./);
  assert.match(html, /id="scoreUs"[^>]*value="1"/);
  assert.match(html, /id="scoreThem"[^>]*value="1"/);
  assert.match(html, /<button type="button" class="btn" data-action="close-sheet">Cancel<\/button>/);
  assert.match(html, /<button type="button" class="btn danger" data-action="score-done">Replace log<\/button>/);
  assert.doesNotMatch(html, /score-clear/);
  click(document, '[data-action="score-done"]');
  const saved = parseSession(store.get(STORAGE_KEY)).value.games[0].sets[0];
  assert.deepEqual([saved.score, saved.points, saved.servedFirst, saved.pending], [[1, 1], '', null, null]);
  assert.equal(saved.counts.grace.serve.out, 1);
});

test('a one-rally log says "1 rally"; an unlogged set keeps the old score sheet', async () => {
  let day = newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z');
  day = tap(day, 'g1', 1, 'grace', 'serve', 'out', 1); // log T
  let env = await bootWithSession(day);
  click(env.document, '[data-action="open-menu"]');
  click(env.document, '[data-action="open-score"]');
  assert.match(env.document.getElementById('app').innerHTML, /\(Us 0 – 1 Them, 1 rally\)/);

  env = await bootWithSession(newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z'));
  click(env.document, '[data-action="open-menu"]');
  click(env.document, '[data-action="open-score"]');
  const html = env.document.getElementById('app').innerHTML;
  assert.match(html, /Enter the final score once the set is over\./);
  assert.match(html, /data-action="score-clear">Clear score<\/button>/);
  assert.match(html, /data-action="score-done">Done<\/button>/);
  assert.doesNotMatch(html, /Replace log/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/ui.test.mjs`
Expected: the three new tests FAIL (no toast, no menu item, old sheet copy).

- [ ] **Step 3: Implement in `src/ui.js`.**

Add `replaceLogWithScore` to the single-line `./session.js` import.

In `onTapCount`, the existing line
`if (top && top.kind === 'count' && top.points) showToast(…);`
gains an `else if` right after it:

```js
    else if (top && top.kind === 'count' && top.delta < 0 && 'pendingBefore' in top) showToast('Open rally cancelled');
```

In `renderMenuSheet`, replace the logged branch of the score/clear-points line so that it reads:

```js
      ${logged ? `<li><button type="button" data-action="open-score">Type the final score…</button></li><li><button type="button" data-action="menu-clear-points">Clear points for Set ${n}…</button></li>` : `<li><button type="button" data-action="open-score">Set score…</button></li>`}
```

Replace `onOpenScore` with:

```js
function onOpenScore() {
  const game = currentGame();
  if (!game) return;
  const n = clampedActiveSet(game);
  const setRecord = game.sets[n - 1];
  // A set with a rally log opens the sheet in replace mode: prefilled with the tally, and Done swaps
  // the log for the typed score. Decided once, here, so Done does what the sheet said it would.
  if (setRecord && setRecord.points !== '') {
    const tally = pointTally(setRecord.points);
    state.sheet = { kind: 'score', n, replace: true, tally, rallies: setRecord.points.length, us: String(tally[0]), them: String(tally[1]), error: null };
  } else {
    const score = setRecord && setRecord.score;
    state.sheet = { kind: 'score', n, replace: false, us: score ? String(score[0]) : '', them: score ? String(score[1]) : '', error: null };
  }
  render();
}
```

In `renderScoreSheet`, replace the helper paragraph and the actions block with:

```js
    <p class="helper" style="margin-bottom:14px;">${sheet.replace
      ? esc(`Replaces the rally log (Us ${sheet.tally[0]} – ${sheet.tally[1]} Them, ${sheet.rallies} ${sheet.rallies === 1 ? 'rally' : 'rallies'}) with the score you type. Serve and return counts stay. Undo can't bring the log back.`)
      : 'Enter the final score once the set is over.'}</p>
```

```js
    <div class="actions">
      ${sheet.replace
        ? `<button type="button" class="btn" data-action="close-sheet">Cancel</button>
      <button type="button" class="btn danger" data-action="score-done">Replace log</button>`
        : `<button type="button" class="btn danger" data-action="score-clear">Clear score</button>
      <button type="button" class="btn primary" data-action="score-done">Done</button>`}
    </div>
```

In `onScoreDone`, replace the `setScore` call line with:

```js
  const session = sheet.replace
    ? replaceLogWithScore(state.session, game.gameId, sheet.n, [us, them])
    : setScore(state.session, game.gameId, sheet.n, [us, them]);
```

- [ ] **Step 4: Run the unit suite**

Run: `npm test`
Expected: all pass (`ℹ fail 0`). List any existing test you had to update and why.

- [ ] **Step 5: Leave the changes uncommitted** and write the report.

---

### Task 3: Browser tests, release 4.4.0, build and full verification

**Files:**
- Modify: `e2e/record.spec.mjs`, `e2e/sheets.spec.mjs`
- Modify: `src/session.js` (`APP_VERSION`), `src/sw.js` (`CACHE`)
- Modify: `README.md` (manual checklist; after the auto-scoring line that starts `- [ ] On a fresh set tap Grace Serve In twice`)
- Modify: `docs/superpowers/specs/2026-10-07-auto-score-side-out-design.md` (ruling 6: one closing sentence)
- Regenerate: `dist/` via `npm run build`

**Interfaces:**
- Consumes: Task 1 behaviour; Task 2 markup (toast text, menu item, `Replace log` button).
- Produces: the 4.4.0 build in `dist/`.

- [ ] **Step 1: Browser tests.** The default fixture roster (`e2e/support/fixtures.mjs`) has Grace, Zoë (`zoie`) and Lily in set 1.

Add to the `test.describe('Recording a set', …)` block in `e2e/record.spec.mjs`:

```js
  test('a minus on the wrong row cancels the open rally, so the right row starts it afresh', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText());
    const us = page.locator('[data-action="tap-point"][data-winner="U"]');
    await press(count(page, 'zoie', 'serve', 'in')); // answers serve-first, rally open
    await press(count(page, 'grace', 'serve', 'in')); // rally 1 to Us; Grace's tap opens rally 2 — but Zoë served
    await expect(us).toHaveAttribute('aria-label', 'Us scored, 1');
    await press(page.locator('[data-action="toggle-minus"]'));
    await press(count(page, 'grace', 'serve', 'in'));
    await expect(page.locator('.toast')).toHaveText('Open rally cancelled');
    await expect(us).not.toHaveAttribute('data-open', '1');
    await press(count(page, 'zoie', 'serve', 'in')); // the right row: a fresh rally, no phantom point
    await expect(us).toHaveAttribute('aria-label', 'Us scored, 1');
    await expect(us).toHaveAttribute('data-open', '1');
  });
```

Add to the `test.describe('Sheets', …)` block in `e2e/sheets.spec.mjs` (it already defines `action`, `openMenu`, `graceServeIn`):

```js
  test('Type the final score… replaces a rally log with the typed score', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText());
    await press(graceServeIn(page)); // answers serve-first, rally open
    await press(graceServeIn(page)); // rally 1 to Us: the set now has a log
    await openMenu(page, press);
    await press(page.locator('.sheet [data-action="open-score"]'));
    await expect(page.locator('.sheet')).toContainText('Replaces the rally log (Us 1 – 0 Them, 1 rally)');
    await expect(page.locator('#scoreUs')).toHaveValue('1');
    await page.locator('#scoreUs').fill('25');
    await page.locator('#scoreThem').fill('23');
    await press(page.locator('.sheet [data-action="score-done"]'));
    await expect(page.locator('button.pt.typed')).toContainText('25–23');
    await expect(page.locator('[data-action="tap-point"]')).toHaveCount(0);
    await expect(graceServeIn(page)).toHaveText('2');
  });
```

- [ ] **Step 2: Release bump.** `src/session.js`: `export const APP_VERSION = '4.4.0';` — `src/sw.js`: `const CACHE = 'ciq-stats-v13';`. Search tests and scripts (not `dist/`, not `node_modules/`) for pins of `4.3.0` or `ciq-stats-v12` and update any that pin the release; name them in the report.

- [ ] **Step 3: README.** After the auto-scoring checklist line, add:

```markdown
- [ ] Tap Zoë Serve In, then Grace Serve In (the wrong row), then − and Grace Serve In → the toast says "Open rally cancelled" and the pills stop being dashed; Zoë Serve In then opens a fresh rally and the score does not move.
- [ ] On a set with a rally log, Menu → Type the final score… → the sheet shows the log's tally and warns it replaces the log; Replace log with 25–23 → the bar shows 25–23 typed and the counts are unchanged.
```

- [ ] **Step 4: Close ruling 6 in the 4.3.0 spec.** At the end of ruling 6 in `docs/superpowers/specs/2026-10-07-auto-score-side-out-design.md`, append the sentence:
`Resolved in 4.4.0: Rory chose the third option — see docs/superpowers/specs/2026-10-07-minus-cancels-and-typed-score-design.md.`

- [ ] **Step 5: Build and verify**, capturing the tail of each:

```bash
npm test
npm run build
npm run verify
npm run test:browsers
```

Expected: unit `fail 0`; build OK; verify PASS (build, golden vector, density); every browser project passes. A failure that is only an expected consequence of the new behaviour gets its expectation updated precisely and listed; anything else is a regression to report.

- [ ] **Step 6: Leave everything uncommitted** (including `dist/`) and write the report.
