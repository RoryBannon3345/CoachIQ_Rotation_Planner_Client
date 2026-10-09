# The Undo list — design

Date: 2026-10-09 · Status: bounded design approved by Rory in chat (option E of `docs/undo-minus-mockup.html`) · Builds on: `docs/superpowers/specs/2026-10-07-minus-cancels-and-typed-score-design.md` (4.4.0) and `docs/superpowers/specs/2026-10-08-rotation-number-design.md` (4.7.0)

## Goal

The record screen's bottom bar has one way to take a tap back. The **−** button and its one-shot minus mode go. **↶ Undo ▾** opens a bottom sheet listing the game's history, newest first: the top row undoes exactly as Undo does today, and any older count tap offers a **−1** that takes one from that cell. Nothing in `src/session.js` changes.

## Why

Today Undo reverses the *last* entry in time order (a count tap and the letters it inferred, a point, or a re-align), across every set of the game. The − button arms a mode in which the *next* count tapped goes down by one, wherever it is, leaving the rally log alone. Both "take something back", and nothing on screen says which to reach for: the coach has to answer "was that my last tap?" first. The list makes the two jobs one button and shows what each row will change before it changes.

## 1. The bar

- `.bottombar` is two columns, `grid-template-columns:1fr 1fr`. The `.bottombar .minus` rule and the `.minus .cnt` red-outline rule are deleted.
- The button is `<button type="button" class="btn sm undo" data-action="open-undo" ${undoDisabled}>↶ Undo ▾</button>`, disabled exactly when `game.history.length === 0`, as today. Export is unchanged.
- `state.minusMode`, the `toggle-minus` action, the `minus` class on `.screen`, `aria-pressed` and the delta logic in `onTapCount` all go. A count tap is always +1.

## 2. The sheet

`open-undo` sets `state.sheet = { kind: 'undo' }` (a no-op when the history is empty) and renders through the existing `.screen.sheet-host > .sheet` pattern, backdrop-closes like the Games and Menu sheets:

```html
<div class="screen sheet-host" data-action="close-sheet">
  <div class="sheet">
    <h3>Take back</h3>
    <p class="helper">Newest first. The top row undoes it, points and all. A −1 takes one from that count and leaves the points alone.</p>
    <ul class="menu undo-list">
      …one <li> per history entry, newest first…
    </ul>
  </div>
</div>
```

The list is the whole of `game.history` (at most 400 entries), newest first, so a mistake from any point in the game can be fixed. The sheet already scrolls and `render()` preserves its scroll position.

### Rows

Every row's text is `entryText(day, h)`, first names throughout, in the toast's vocabulary:

| Entry | Text |
|---|---|
| `count`, delta > 0 | `Grace · Serve In +1`, then ` · ` plus the letters it appended when `h.points` is set: `U` → `Us +1`, `T` → `Them +1`, joined by `, `. So `Hailey · Serve In +1 · Us +1` or `Grace · Serve Out +1 · Us +1, Them +1`. |
| `count`, delta < 0 | `Grace · Serve In −1` |
| `point` | `Us +1` or `Them +1` |
| `align` | the existing `alignText(day, h)`: `Re-aligned to Grace`, `Lexi serving for Hailey`, `Grace back in` |

Stat and side words are `Serve`/`Return` and `In`/`Out`. When `h.n` is not the set on screen a `<span class="set">set ${h.n}</span>` follows the `.what` span (a flex sibling, so a long row's ellipsis never hides it), so an Undo that reaches into another set says so before it happens.

What a row does depends on its position and kind:

- **The top row**, whatever its kind, is a button with the `↶ Undo` pill: `<li><button type="button" data-action="undo"><span class="what">…</span><span class="pill">↶ Undo</span></button></li>`. It calls `onUndo()` unchanged (letters, re-align, serve record and open rally all come back as today), then closes the sheet.
- **A lower `count` row with delta > 0** is a button with the `−1` pill: `<li><button type="button" data-action="undo-minus" data-n="${h.n}" data-pid="${h.playerId}" data-stat="${h.stat}" data-side="${h.side}"><span class="what">…</span><span class="pill minus">−1</span></button></li>`. It is `disabled` when that cell already reads 0 (`getCount(game, h.n, h.playerId)[h.stat][h.side] === 0`).
- **Every other lower row** (a point, a re-align, an earlier −1) is context only: `<li class="muted-line context"><span>…</span></li>`, no button. Undoing back to it would also discard the correct taps after it, which this feature is not for.

### `undo-minus`

`onUndoMinus(btn)` reads the four data attributes and calls `tap(state.session, game.gameId, n, pid, stat, side, -1)`: the same call the − button made. If the session changed it shows the `Open rally cancelled` toast under the same condition `onTapCount` uses today (the new top entry is a `count` with `delta < 0` and `pendingBefore`), stamps `lastChangedAt`, commits, and closes the sheet. A no-op tap (the cell was 0; the row is disabled so this is belt and braces) just closes the sheet.

**Known trade-off, kept on purpose.** `tap()` keeps its 4.4.0 rule: a minus on the cell that opened the open rally cancels that rally. The opener is always the newest raising count tap for its set, so this fires only when the coach picks an older row for the **same player and cell** while that rally is open (Grace Serve In twice in a row, then −1 on the older one). The toast says so, and the top row's Undo reverses it. One code path beats two.

### Closing

Any row that acts closes the sheet (`state.sheet = null`) before `commit()` re-renders. The backdrop closes it without acting. There is no Done button. A row tapped within 300 ms of the sheet opening does nothing and the sheet stays open: the bottom row renders over the bar button that opened it, so the second tap of a double tap must not act.

## 3. CSS

Added after the `.sheet ul.menu .muted-line` rule in `src/styles.css`:

```css
/* the Undo list (undo-list spec §2) */
.sheet ul.menu.undo-list button { display:flex; justify-content:space-between; align-items:center; gap:8px; }
.sheet ul.menu.undo-list .what { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sheet ul.menu.undo-list .pill { flex:none; font-size:11px; font-weight:700; border-radius:999px; padding:3px 9px; border:1px solid var(--line-2); background:var(--bg-4); }
.sheet ul.menu.undo-list li:first-child .pill { background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
.sheet ul.menu.undo-list .pill.minus { color:var(--err); border-color:var(--err-border); background:var(--err-bg); }
.sheet ul.menu.undo-list button:disabled { opacity:.45; }
.sheet ul.menu.undo-list .context { color:var(--fg-3); justify-content:flex-start; gap:8px; }
.sheet ul.menu.undo-list .set { flex:none; font-size:10px; color:var(--fg-3); }
```

`.bottombar` becomes `grid-template-columns:1fr 1fr`. Nothing else in the bar or the rows changes; the density guard is untouched because the sheet floats.

## 4. Tests

- `test/ui.test.mjs`: the three minus-mode cases are replaced. New cases pin: the bar markup (two buttons, `↶ Undo ▾`, disabled on an empty history); the sheet markup (top row `↶ Undo` pill whatever its kind, lower raising count rows `−1`, lower point/align/minus rows context only, `set N` tag on another set's row, `−1` disabled at 0); Undo through the sheet reverses the top entry and closes the sheet; `−1` through the sheet subtracts from an older cell, leaves `points` alone and closes the sheet; the kept trade-off (`−1` on an older row for the opener's cell says `Open rally cancelled`); and that the toast-clearing test uses `open-undo` as its "next action".
- `e2e/record.spec.mjs`: the first test opens the list and presses the top row; "minus subtracts once" becomes "the list takes one from an older tap"; "a minus on the wrong row cancels the open rally" becomes the same scenario through the list.
- `test/build-prod.test.mjs`: `minusMode` leaves the identifier list; `renderUndoSheet` takes its place.
- `test/session.test.mjs` and `test/harden-app.test.mjs` are unchanged.

## 5. Release

`APP_VERSION` `'4.8.0'`, `CACHE` `'ciq-stats-v17'`. README "Verify on the phone": the `"−" mode` bullet and the `then − and Grace Serve In` bullet are rewritten for the list, and a (4.8.0) bullet is added. Mockup: `docs/undo-minus-mockup.html`, option E.
