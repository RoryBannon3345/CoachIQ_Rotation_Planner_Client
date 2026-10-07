# Auto-score Us / Them from stat taps (side-out inference) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve In / Serve Out / Return In / Return Out taps write the set's rally log automatically, so the Us / Them pills are only needed for set point and untracked points.

**Architecture:** A pure `inferTap(set, stat, side)` in `src/session.js` decides which letters a tap appends, using the rule "the winner of a rally serves the next one". `tap()` applies it and records what it did on the history entry so one Undo reverses everything. The record screen in `src/ui.js` shows the serving side, the open rally, idle columns, a toast and a richer Undo label.

**Tech Stack:** Plain JavaScript ES modules, no framework, no dependencies. Unit tests with `node --test` (fake DOM in `test/helpers/fake-dom.mjs`); browser tests with Playwright (`e2e/`).

**Spec:** `docs/superpowers/specs/2026-10-07-auto-score-side-out-design.md`

## Global Constraints

- **Never commit.** The user's global rule: no `git commit`, no `git push`, no `npm run deploy`. Leave every change in the working tree. Replace any "commit" habit with "leave it for the controller".
- Never dispatch subagents.
- Plain JS, no new dependencies. Each `import` line in `src/` must stay on ONE line (the build inliner strips single-line imports only).
- Export contract unchanged: still v4. Do not touch `src/codec.js`, `src/vectors.js` or `reference/`.
- `SESSION_SCHEMA` stays `4`. New fields are optional on read (missing `pending` reads as `null`).
- `RETURN_OUT_ENDS_RALLY = true`, exported from `src/session.js`.
- Exact UI strings (copy verbatim):
  - toast phrases: `Us +1 · we serve`, `Them +1 · they serve`, `Us +1 · side-out`, `Them +1 · side-out`, `Them +1 · Serve out`, `Them +1 · Return out`; several joined by `, then `
  - Undo label for a count entry with letters: `↶ Undo <first name> <S|R> <in|out> + <Us|Them>[, <Us|Them>]`
- Pill `aria-label`s stay exactly as today (`Us scored, N` / `Them scored, N`).
- The record screen's row and bar heights must not change: `npm run verify` (includes `scripts/verify-density.mjs`) must pass.
- Toast lifetime `2500` ms; cleared by the next action of any kind.

## Review Focus

1. **Reload mid-rally**: a coach's phone sleeps with a rally open; on reopen the open rally (and the log) must still be there. Pinned in Task 1 ("an open rally survives a save and reload").
2. **Undo across sets**: Undo is per game, so the top entry may belong to a set not on screen; it must restore that set's log and open rally, never the visible set's. Pinned in Task 1.
3. **Typed score entered then cleared after a rally was opened**: Undo must not leave `pending` set with `servedFirst: null`, which the parser would refuse and so drop the whole game on next boot. Pinned in Task 1 (strip test, final round-trip assertion).
4. **The 200-rally cap**: at `MAX_POINTS` the count must still move and the open rally still update, with no letter added. Pinned in Task 1.
5. **Minus-mode correction during an open rally**: a decrement and its Undo must leave the log and open rally untouched. Pinned in Task 1.

---

### Task 1: Inference in the state model

**Files:**
- Modify: `src/session.js` (constants near line 13; `emptySet` line 25; `tap` 412-421; `tapPoint` 445-456; `clearPoints` 460-469; `undo` 471-488; `setScore` 490-500; `parseSetRecord` 607-628; `parseHistoryEntry` 641-654; `liftGameToSchema4` 953-958)
- Test: `test/session.test.mjs`

**Interfaces:**
- Consumes: existing `withGame`, `applyDelta`, `getCount`, `MAX_POINTS` (imported from codec), `UNDO_LIMIT`.
- Produces (Task 2 relies on these exact names):
  - `export const RETURN_OUT_ENDS_RALLY = true`
  - `export function setServer(setRecord) → 'U' | 'T' | null` (accepts `null`)
  - `export function inferTap(setRecord, stat, side) → { servedFirst: boolean, letters: Array<{ letter: 'U'|'T', why: 'resolve'|'sideout'|'out' }>, pending: null|'serve'|'return' }` (accepts `null` for an untouched set)
  - set records carry `pending: null | 'serve' | 'return'`
  - count history entries may carry `points` (1–2 letters), `servedFirstSet: true`, `pendingBefore`; point entries may carry `pendingBefore`

- [ ] **Step 1: Write the failing tests**

Append to the end of `test/session.test.mjs`:

```js
// ---- side-out inference (docs/superpowers/specs/2026-10-07-auto-score-side-out-design.md) ----
const set1 = (s) => s.games[0].sets[0];
const t = (s, pid, stat, side, delta = 1) => S.tap(s, 'game-1', 1, pid, stat, side, delta);

test('setServer: last letter, else the serve-first answer, else unknown', () => {
  assert.equal(S.setServer(null), null);
  assert.equal(S.setServer({ servedFirst: null, points: '', pending: null }), null);
  assert.equal(S.setServer({ servedFirst: true, points: '', pending: null }), 'U');
  assert.equal(S.setServer({ servedFirst: false, points: '', pending: null }), 'T');
  assert.equal(S.setServer({ servedFirst: true, points: 'UT', pending: null }), 'T');
});

test('inferTap covers every row of the serving-side rule', () => {
  const blank = { servedFirst: null, points: '', pending: null };
  assert.deepEqual(S.inferTap(null, 'serve', 'in'), { servedFirst: true, letters: [], pending: 'serve' });
  assert.deepEqual(S.inferTap(blank, 'return', 'in'), { servedFirst: false, letters: [], pending: 'return' });
  assert.deepEqual(S.inferTap(blank, 'serve', 'out'), { servedFirst: true, letters: [{ letter: 'T', why: 'out' }], pending: null });
  const mid = (pending, points) => ({ servedFirst: true, points, pending });
  assert.deepEqual(S.inferTap(mid('serve', 'U'), 'serve', 'in').letters, [{ letter: 'U', why: 'resolve' }]);
  assert.deepEqual(S.inferTap(mid('serve', 'U'), 'return', 'in').letters, [{ letter: 'T', why: 'resolve' }]);
  assert.deepEqual(S.inferTap(mid('return', 'T'), 'return', 'out'), { servedFirst: true, letters: [{ letter: 'T', why: 'resolve' }, { letter: 'T', why: 'out' }], pending: null });
  assert.deepEqual(S.inferTap(mid(null, 'T'), 'serve', 'in').letters, [{ letter: 'U', why: 'sideout' }]);
  assert.deepEqual(S.inferTap(mid(null, 'U'), 'return', 'in').letters, [{ letter: 'T', why: 'sideout' }]);
  assert.deepEqual(S.inferTap(mid(null, 'U'), 'serve', 'in').letters, []);
  assert.deepEqual(S.inferTap(mid(null, 'T'), 'return', 'in').letters, []);
  assert.equal(S.RETURN_OUT_ENDS_RALLY, true);
});

test('the worked example from docs/auto-score-options.pdf ends on UTTTUUTUUT', () => {
  let s = open();
  s = t(s, 'grace', 'serve', 'in'); // 1: answers serve-first, rally open
  assert.deepEqual([set1(s).servedFirst, set1(s).points, set1(s).pending], [true, '', 'serve']);
  s = t(s, 'grace', 'serve', 'in'); // 2: rally 1 to Us
  s = t(s, 'zoie', 'return', 'in'); // 3: rally 2 to Them
  s = t(s, 'zoie', 'return', 'out'); // 4: rally 3 to Them, then the Out
  assert.equal(set1(s).points, 'UTTT');
  // 5: their serve into the net, nobody taps
  s = t(s, 'grace', 'serve', 'in'); // 6: the untracked side-out to Us
  assert.equal(set1(s).points, 'UTTTU');
  s = t(s, 'grace', 'serve', 'out'); // 7
  s = t(s, 'zoie', 'return', 'in'); // 8
  assert.equal(set1(s).pending, 'return');
  s = t(s, 'grace', 'serve', 'in'); // 9
  s = t(s, 'grace', 'serve', 'in'); // 10
  assert.equal(set1(s).points, 'UTTTUUTUU');
  s = S.tapPoint(s, 'game-1', 1, 'T'); // set point, closed by hand
  assert.equal(set1(s).points, 'UTTTUUTUUT');
  assert.equal(set1(s).pending, null);
  assert.deepEqual(S.pointTally(set1(s).points), [5, 5]);
});

test('one Undo reverses a two-letter tap: count, both letters and the open rally', () => {
  let s = t(open(), 'grace', 'serve', 'in');
  s = t(s, 'grace', 'serve', 'out');
  assert.deepEqual([set1(s).points, set1(s).pending], ['UT', null]);
  const top = s.games[0].history.at(-1);
  assert.deepEqual(top, { kind: 'count', n: 1, playerId: 'grace', stat: 'serve', side: 'out', delta: 1, points: 'UT', pendingBefore: 'serve' });
  const u = S.undo(s, 'game-1');
  assert.deepEqual(u.undone, top);
  assert.deepEqual([set1(u.session).points, set1(u.session).pending, S.getCount(u.session.games[0], 1, 'grace').serve.out], ['', 'serve', 0]);
});

test('Undo of the first tap forgets the serve-first answer it gave', () => {
  const s = t(open(), 'zoie', 'return', 'in');
  assert.deepEqual(s.games[0].history[0], { kind: 'count', n: 1, playerId: 'zoie', stat: 'return', side: 'in', delta: 1, servedFirstSet: true, pendingBefore: null });
  const u = S.undo(s, 'game-1').session;
  assert.deepEqual([set1(u).servedFirst, set1(u).points, set1(u).pending], [null, '', null]);
});

test('Undo of a pill tap that closed an open rally re-opens it', () => {
  let s = t(open(), 'grace', 'serve', 'in');
  s = S.tapPoint(s, 'game-1', 1, 'U');
  assert.deepEqual(s.games[0].history.at(-1), { kind: 'point', n: 1, winner: 'U', pendingBefore: 'serve' });
  const u = S.undo(s, 'game-1').session;
  assert.deepEqual([set1(u).points, set1(u).pending], ['', 'serve']);
});

test('minus mode infers nothing, and its Undo leaves the log and open rally alone', () => {
  let s = t(open(), 'grace', 'serve', 'in');
  s = t(s, 'grace', 'serve', 'in'); // U, rally open
  s = t(s, 'grace', 'serve', 'in', -1); // a correction
  assert.deepEqual([set1(s).points, set1(s).pending], ['U', 'serve']);
  assert.deepEqual(s.games[0].history.at(-1), { kind: 'count', n: 1, playerId: 'grace', stat: 'serve', side: 'in', delta: -1 });
  const u = S.undo(s, 'game-1').session;
  assert.deepEqual([set1(u).points, set1(u).pending, S.getCount(u.games[0], 1, 'grace').serve.in], ['U', 'serve', 2]);
});

test('a typed-score set infers nothing', () => {
  let s = S.setScore(open(), 'game-1', 1, [25, 20]);
  s = t(s, 'grace', 'serve', 'out');
  assert.deepEqual([set1(s).points, set1(s).servedFirst, set1(s).pending], ['', null, null]);
  assert.deepEqual(s.games[0].history.at(-1), { kind: 'count', n: 1, playerId: 'grace', stat: 'serve', side: 'out', delta: 1 });
});

test('at MAX_POINTS the count still moves and the open rally still updates, but no letter is added', () => {
  let s = S.setServedFirst(open(), 'game-1', 1, true);
  for (let i = 0; i < 200; i++) s = S.tapPoint(s, 'game-1', 1, 'U');
  s = t(s, 'grace', 'serve', 'out');
  assert.equal(set1(s).points.length, 200);
  assert.equal(S.getCount(s.games[0], 1, 'grace').serve.out, 1);
  assert.equal(s.games[0].history.at(-1).points, undefined);
  s = t(s, 'grace', 'serve', 'in');
  assert.equal(set1(s).pending, 'serve');
});

test('clearPoints and a typed score strip inference from that set\'s history, so Undo cannot resurrect a rally', () => {
  let s = t(open(), 'grace', 'serve', 'in');
  s = t(s, 'grace', 'serve', 'in');
  s = S.clearPoints(s, 'game-1', 1);
  assert.deepEqual([set1(s).points, set1(s).servedFirst, set1(s).pending], ['', null, null]);
  assert.deepEqual(s.games[0].history.map((h) => Object.keys(h).sort().join()), ['delta,kind,n,playerId,side,stat', 'delta,kind,n,playerId,side,stat']);
  let u = S.undo(s, 'game-1').session;
  assert.deepEqual([set1(u).points, set1(u).servedFirst, set1(u).pending], ['', null, null]);

  s = t(open(), 'grace', 'serve', 'in'); // rally open, nothing logged yet
  s = S.setScore(s, 'game-1', 1, [25, 20]);
  assert.equal(set1(s).pending, null);
  s = S.setScore(s, 'game-1', 1, null); // typed score cleared again
  u = S.undo(s, 'game-1').session;
  assert.deepEqual([set1(u).servedFirst, set1(u).pending], [null, null]);
  assert.equal(S.parseSession(S.serialiseSession(u)).ok, true, 'the save stays readable');
});

test('an open rally survives a save and reload', () => {
  const s = t(open(), 'grace', 'serve', 'in');
  const parsed = S.parseSession(S.serialiseSession(s));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, s);
});

test('a schema-4 save written before this change (no pending key) still loads', () => {
  let s = S.setServedFirst(open(), 'game-1', 1, true);
  s = S.tapPoint(s, 'game-1', 1, 'U');
  const raw = JSON.parse(S.serialiseSession(s));
  delete raw.session.games[0].sets[0].pending;
  const parsed = S.parseSession(JSON.stringify(raw));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.games[0].sets[0].pending, null);
});

test('the parser refuses an open rally without a serve-first answer, and malformed new fields', () => {
  const s = t(open(), 'grace', 'serve', 'in');
  const withEdit = (edit) => {
    const raw = JSON.parse(S.serialiseSession(s));
    edit(raw.session.games[0]);
    return S.parseSession(JSON.stringify(raw)).ok;
  };
  // A one-game day: a refused game makes the whole day malformed.
  assert.equal(withEdit((g) => { g.sets[0].servedFirst = null; }), false);
  assert.equal(withEdit((g) => { g.sets[0].pending = 'rally'; }), false);
  assert.equal(withEdit((g) => { g.history[0].points = 'X'; }), false);
  assert.equal(withEdit((g) => { g.history[0].servedFirstSet = false; }), false);
  assert.equal(withEdit((g) => { g.history[0].pendingBefore = 'later'; }), false);
});

test('Undo of a tap made in another set restores that set, not the one on screen', () => {
  let s = t(open(), 'grace', 'serve', 'in'); // set 1: rally open
  s = S.tap(s, 'game-1', 2, 'grace', 'return', 'in', 1); // set 2: rally open
  s = t(s, 'grace', 'serve', 'in'); // set 1: U, still open
  s = S.setActiveSet(s, 'game-1', 2);
  const u = S.undo(s, 'game-1').session;
  assert.deepEqual([u.games[0].sets[0].points, u.games[0].sets[0].pending], ['', 'serve']);
  assert.deepEqual([u.games[0].sets[1].points, u.games[0].sets[1].pending], ['', 'return']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/session.test.mjs`
Expected: the new tests FAIL (`S.setServer is not a function`, `S.inferTap is not a function`, missing `pending`).

- [ ] **Step 3: Add the constant, `pending` on new sets, `setServer` and `inferTap`**

In `src/session.js`, after `export const UNDO_LIMIT = 400;` add:

```js
/** Does a Return Out end the rally with the point to Them, like a Serve Out? Ruling 1 of
 * docs/superpowers/specs/2026-10-07-auto-score-side-out-design.md; `false` makes a Return Out
 * leave the rally open, like a Return In. */
export const RETURN_OUT_ENDS_RALLY = true;
const PENDING_VALUES = [null, 'serve', 'return'];
```

Replace `emptySet` (and extend its comment) with:

```js
/** A set nobody has touched yet. `servedFirst` is null until the coach answers the set bar's
 * question (or the first stat tap answers it); `points` is one letter per rally (`U` we won it,
 * `T` they did) and is the set's score once it is non-empty; `pending` is the stat whose In tap
 * opened a rally nobody has won yet. Invariants: `points !== ''` implies `servedFirst !== null`;
 * `pending !== null` implies `servedFirst !== null` and no typed score. */
function emptySet() {
  return { score: null, counts: {}, servedFirst: null, points: '', pending: null };
}

function isTypedSet(set) {
  return set.points === '' && set.score !== null;
}
```

Directly after `pointTally`, add:

```js
/** Who serves the next rally: the winner of the last one, else the serve-first answer, else
 * null (not known yet). `setRecord` may be null for a set nobody has touched. */
export function setServer(setRecord) {
  if (!setRecord) return null;
  if (setRecord.points !== '') return setRecord.points[setRecord.points.length - 1];
  if (setRecord.servedFirst === null) return null;
  return setRecord.servedFirst ? 'U' : 'T';
}

/** What one stat tap says about the score, from the rule that the winner of a rally serves the
 * next one. Pure; `tap` applies it. Only meaningful for a logged set and a tap that raised a count. */
export function inferTap(setRecord, stat, side) {
  const set = setRecord ?? { servedFirst: null, points: '', pending: null };
  const servedFirst = set.servedFirst === null ? stat === 'serve' : set.servedFirst;
  const letters = [];
  if ((set.pending ?? null) !== null) {
    letters.push({ letter: stat === 'serve' ? 'U' : 'T', why: 'resolve' });
  } else {
    const server = setServer({ ...set, servedFirst });
    if (server === 'U' && stat === 'return') letters.push({ letter: 'T', why: 'sideout' });
    if (server === 'T' && stat === 'serve') letters.push({ letter: 'U', why: 'sideout' });
  }
  const endsRally = side === 'out' && (stat === 'serve' || RETURN_OUT_ENDS_RALLY);
  if (endsRally) letters.push({ letter: 'T', why: 'out' });
  return { servedFirst, letters, pending: endsRally ? null : stat };
}

/** That set's count entries lose their inference fields (they become plain count entries), so an
 * Undo after the log was cleared or replaced by a typed score reverses only the count. */
function stripInference(history, n) {
  return history.map((h) => {
    if (h.kind !== 'count' || h.n !== n) return h;
    const { points, servedFirstSet, pendingBefore, ...plain } = h;
    return plain;
  });
}
```

- [ ] **Step 4: Replace `tap`, `tapPoint`, `clearPoints`, `undo` and `setScore`**

```js
export function tap(s, gameId, n, playerId, stat, side, delta) {
  return withGame(s, gameId, (g) => {
    const before = getCount(g, n, playerId)[stat][side];
    const game = applyDelta(g, n, playerId, stat, side, delta);
    if (game === g) return g;
    const after = getCount(game, n, playerId)[stat][side];
    const entry = { kind: 'count', n, playerId, stat, side, delta: after - before };
    const prevSet = g.sets[n - 1] ?? emptySet();
    let sets = game.sets;
    if (entry.delta > 0 && !isTypedSet(prevSet)) {
      const inferred = inferTap(prevSet, stat, side);
      const room = Math.max(0, MAX_POINTS - prevSet.points.length);
      const appended = inferred.letters.slice(0, room).map((l) => l.letter).join('');
      const pendingBefore = prevSet.pending ?? null;
      const counted = game.sets[n - 1];
      sets = game.sets.slice();
      sets[n - 1] = { ...counted, servedFirst: inferred.servedFirst, points: counted.points + appended, pending: inferred.pending };
      if (appended !== '') entry.points = appended;
      if (prevSet.servedFirst === null) entry.servedFirstSet = true;
      if (pendingBefore !== inferred.pending) entry.pendingBefore = pendingBefore;
    }
    const history = [...game.history, entry].slice(-UNDO_LIMIT);
    return { ...game, sets, history };
  });
}
```

```js
/** One rally: `winner` is 'U' or 'T'. Refused (same reference) until servedFirst is answered or
 * once the set carries a typed score, or once the log is at MAX_POINTS — the planner would refuse a longer one. Not touched by minus mode.
 * Closes an open rally; the entry remembers it so Undo re-opens it. */
export function tapPoint(s, gameId, n, winner) {
  if (winner !== 'U' && winner !== 'T') return s;
  return withGame(s, gameId, (g) => {
    const set = g.sets[n - 1] ?? emptySet();
    if (set.servedFirst === null || set.points.length >= MAX_POINTS) return g;
    if (set.points === '' && set.score !== null) return g; // typed and logged are exclusive
    const closed = set.pending ?? null;
    const sets = g.sets.slice();
    sets[n - 1] = { ...set, points: set.points + winner, pending: null };
    const entry = { kind: 'point', n, winner };
    if (closed !== null) entry.pendingBefore = closed;
    const history = [...g.history, entry].slice(-UNDO_LIMIT);
    return { ...g, sets, history };
  });
}

/** Empties the set's log, forgets who served first and closes any open rally; the counts stay.
 * Drops that set's point entries from history the way clearSet drops by n, and strips the
 * inference fields from its count entries, so undo can never resurrect a rally. */
export function clearPoints(s, gameId, n) {
  return withGame(s, gameId, (g) => {
    const set = g.sets[n - 1];
    if (!set || (set.points === '' && set.servedFirst === null)) return g;
    const sets = g.sets.slice();
    sets[n - 1] = { ...set, servedFirst: null, points: '', pending: null };
    const history = stripInference(g.history.filter((h) => !(h.kind === 'point' && h.n === n)), n);
    return { ...g, sets, history };
  });
}
```

```js
export function undo(s, gameId) {
  const game = findGame(s, gameId);
  if (!game || game.history.length === 0) return { session: s, undone: null };
  const last = game.history[game.history.length - 1];
  const session = withGame(s, gameId, (g) => {
    const history = g.history.slice(0, -1);
    if (last.kind === 'point') {
      const set = g.sets[last.n - 1];
      // A letter that does not match the log's last one can only come from corrupt storage: drop the entry, leave the log alone.
      if (!set || set.points.length === 0 || set.points[set.points.length - 1] !== last.winner) return { ...g, history };
      let next = { ...set, points: set.points.slice(0, -1) };
      if ('pendingBefore' in last && !isTypedSet(next) && next.servedFirst !== null) next = { ...next, pending: last.pendingBefore };
      const sets = g.sets.slice();
      sets[last.n - 1] = next;
      return { ...g, sets, history };
    }
    const reverted = applyDelta(g, last.n, last.playerId, last.stat, last.side, -last.delta);
    const set = reverted.sets[last.n - 1];
    if (!set) return { ...reverted, history };
    let next = set;
    // Letters are removed only when the log still ends with them; anything else is corrupt storage.
    if (last.points && next.points.endsWith(last.points)) next = { ...next, points: next.points.slice(0, -last.points.length) };
    if ('pendingBefore' in last) next = { ...next, pending: last.pendingBefore };
    if (last.servedFirstSet && next.points === '') next = { ...next, servedFirst: null };
    if ((isTypedSet(next) || next.servedFirst === null) && next.pending !== null) next = { ...next, pending: null };
    if (next === set) return { ...reverted, history };
    const sets = reverted.sets.slice();
    sets[last.n - 1] = next;
    return { ...reverted, sets, history };
  });
  return { session, undone: last };
}

export function setScore(s, gameId, n, score) {
  return withGame(s, gameId, (g) => {
    const set = g.sets[n - 1] ?? emptySet();
    if (set.points !== '') return g;
    const sets = g.sets.slice();
    if (score === null) {
      sets[n - 1] = { ...set, score: null };
      return { ...g, sets };
    }
    sets[n - 1] = { ...set, score: [score[0], score[1]], servedFirst: null, pending: null };
    return { ...g, sets, history: stripInference(g.history, n) };
  });
}
```

- [ ] **Step 5: Teach the parser and the schema-3 lift about the new fields**

In `parseSetRecord`, replace the final `return` with:

```js
  const pending = value.pending === undefined ? null : value.pending;
  if (!PENDING_VALUES.includes(pending)) return undefined;
  if (pending !== null && (value.servedFirst === null || (value.points === '' && score !== null))) return undefined;
  return { score, counts, servedFirst: value.servedFirst, points: value.points, pending };
```

Replace `parseHistoryEntry` with:

```js
function parseHistoryEntry(value) {
  if (!isPlainObject(value)) return undefined;
  if (!Number.isInteger(value.n) || value.n < 1 || value.n > MAX_SETS) return undefined;
  if (value.kind === 'point') {
    if (value.winner !== 'U' && value.winner !== 'T') return undefined;
    const point = { kind: 'point', n: value.n, winner: value.winner };
    if (value.pendingBefore !== undefined) {
      if (value.pendingBefore !== 'serve' && value.pendingBefore !== 'return') return undefined;
      point.pendingBefore = value.pendingBefore;
    }
    return point;
  }
  if (value.kind !== 'count') return undefined;
  if (typeof value.playerId !== 'string') return undefined;
  if (value.stat !== 'serve' && value.stat !== 'return') return undefined;
  if (value.side !== 'in' && value.side !== 'out') return undefined;
  if (typeof value.delta !== 'number' || !Number.isInteger(value.delta)) return undefined;
  const count = { kind: 'count', n: value.n, playerId: value.playerId, stat: value.stat, side: value.side, delta: value.delta };
  if (value.points !== undefined) {
    if (typeof value.points !== 'string' || !/^[UT]{1,2}$/.test(value.points)) return undefined;
    count.points = value.points;
  }
  if (value.servedFirstSet !== undefined) {
    if (value.servedFirstSet !== true) return undefined;
    count.servedFirstSet = true;
  }
  if (value.pendingBefore !== undefined) {
    if (!PENDING_VALUES.includes(value.pendingBefore)) return undefined;
    count.pendingBefore = value.pendingBefore;
  }
  return count;
}
```

In `liftGameToSchema4`, change the set default to include `pending: null`:

```js
  const sets = Array.isArray(g.sets) ? g.sets.map((set) => (isPlainObject(set) ? { servedFirst: null, points: '', pending: null, ...set } : set)) : g.sets;
```

- [ ] **Step 6: Run the whole unit suite**

Run: `npm test`
Expected: the new tests PASS. Some existing tests fail because inference now runs on their taps. For each failing test decide: is the new value the behaviour the spec asks for (update the expectation, never weaken it to something vaguer), or a regression (fix the code)? Known intended changes:

- `schema 4: a fresh set record carries servedFirst null and empty points` → rename to `schema 4: the first tap of a fresh set answers serve-first and opens a rally`; expect the set `{ score: null, counts: { grace: { serve: { in: 1, out: 0 }, return: { in: 0, out: 0 } } }, servedFirst: true, points: '', pending: 'serve' }` and history `{ kind: 'count', n: 1, playerId: 'grace', stat: 'serve', side: 'in', delta: 1, servedFirstSet: true, pendingBefore: null }`.
- `undo reverses its own kind across a mixed history` → first undone is `{ kind: 'count', n: 1, playerId: 'zoie', stat: 'return', side: 'out', delta: 1, points: 'TT' }` (a side-out then the Out; log goes `UTT` → `U`); second undone is `{ kind: 'point', n: 1, winner: 'U', pendingBefore: 'serve' }`. The other assertions stay.
- `a schema-3 save migrates…` → the migrated set gains `pending: null`.
- Export tests that tap counts may now see `servedFirst` / `points` on a set: that is the inferred log, and expected.

List every test you changed, with old and new expectation, in your report.

Expected after fixes: all tests pass (`ℹ fail 0`).

- [ ] **Step 7: Leave the changes uncommitted** and write your report.

---

### Task 2: Record screen — serving dot, open rally, idle columns, toast, Undo label

**Files:**
- Modify: `src/ui.js` (import line 6; `state` 13-26; `renderRow` 555-566; `renderRecord` 568-632; `onTapCount` 640-654; `runAction` 961-981)
- Modify: `src/styles.css` (set bar block 42-58; counters 113-117)
- Test: `test/ui.test.mjs`

**Interfaces:**
- Consumes from Task 1: `setServer(setRecord)`, `inferTap(setRecord, stat, side)`, set field `pending`, count entry field `points`.
- Produces: markup contract used by Task 3's browser tests — pills carry `data-serving="1"` / `data-open="1"`; counters and column headers carry class `idle`; toast is `<div class="toast" role="status" aria-live="polite">…</div>`.

- [ ] **Step 1: Write the failing tests**

In `test/ui.test.mjs`, add `tap` to the `../src/session.js` import list (keep it one line). Append:

```js
const ONE_SET = { v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder', players: [{ id: 'grace', name: 'Grace' }], games: [{ gameId: 'g1', opponent: 'Lions', sets: [1] }] };

test('a stat tap that scores shows a toast naming why, and Undo names the letters', async () => {
  const { document } = await bootWithSession(newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z'));
  click(document, '[data-action="tap-count"][data-pid="grace"][data-stat="serve"][data-side="in"]');
  let html = document.getElementById('app').innerHTML;
  assert.doesNotMatch(html, /class="toast"/, 'the first tap only answers serve-first');
  click(document, '[data-action="tap-count"][data-pid="grace"][data-stat="serve"][data-side="out"]');
  html = document.getElementById('app').innerHTML;
  assert.match(html, /<div class="toast" role="status" aria-live="polite">Us \+1 · we serve, then Them \+1 · Serve out<\/div>/);
  assert.match(html, /↶ Undo Grace S out \+ Us, Them/);
  click(document, '[data-action="toggle-minus"]');
  assert.doesNotMatch(document.getElementById('app').innerHTML, /class="toast"/, 'the next action of any kind clears it');
});

test('the serving side gets the dot, the other pair of columns goes idle, and an open rally dashes both pills', async () => {
  let day = newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z');
  day = tap(day, 'g1', 1, 'grace', 'serve', 'in', 1); // we serve, rally open
  let html = await renderWith(day, 'g1');
  assert.match(html, /class="pt us serving open" data-action="tap-point" data-winner="U" data-serving="1" data-open="1" aria-label="Us scored, 0"/);
  assert.match(html, /class="pt them open" data-action="tap-point" data-winner="T" data-open="1" aria-label="Them scored, 0"/);
  assert.match(html, /class="cnt in idle"[^>]*data-stat="return" data-side="in"/);
  assert.match(html, /class="cnt in"[^>]*data-stat="serve" data-side="in"/);
  assert.match(html, /<span class="idle">Return In<\/span>/);

  day = tap(day, 'g1', 1, 'grace', 'return', 'out', 1); // rally to Them, then the Out: they serve, nothing open
  html = await renderWith(day, 'g1');
  assert.match(html, /class="pt them serving" data-action="tap-point" data-winner="T" data-serving="1" aria-label="Them scored, 2"/);
  assert.doesNotMatch(html, /data-open="1"/);
  assert.match(html, /class="cnt out idle"[^>]*data-stat="serve" data-side="out"/);
});

test('a typed-score set shows no dot, no idle columns and no toast', async () => {
  let day = setScore(newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z'), 'g1', 1, [25, 21]);
  day = tap(day, 'g1', 1, 'grace', 'serve', 'out', 1);
  const html = await renderWith(day, 'g1');
  assert.doesNotMatch(html, /idle|data-serving|data-open|class="toast"/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/ui.test.mjs`
Expected: the three new tests FAIL (no `toast`, no `serving`/`idle` markup, label lacks `+ Us, Them`).

- [ ] **Step 3: Import, state and helpers in `src/ui.js`**

Add `setServer, inferTap` to the existing single-line `./session.js` import (keep it one line).

In `state`, after `serveFirstAt`, add:

```js
  toast: null, // null | { text } — set by a stat tap that scored; see showToast
```

After `statLetter`, add:

```js
const TOAST_MS = 2500;
const TOAST_PHRASE = {
  resolve: { U: 'Us +1 · we serve', T: 'Them +1 · they serve' },
  sideout: { U: 'Us +1 · side-out', T: 'Them +1 · side-out' },
};

/** "Us +1 · we serve, then Them +1 · Serve out" — one phrase per letter a stat tap appended. */
function toastText(letters, stat) {
  return letters.map((l) => (l.why === 'out' ? `Them +1 · ${stat === 'serve' ? 'Serve' : 'Return'} out` : TOAST_PHRASE[l.why][l.letter])).join(', then ');
}

function showToast(text) {
  const toast = { text };
  state.toast = toast;
  const timer = setTimeout(() => {
    if (state.toast !== toast) return;
    state.toast = null;
    render();
  }, TOAST_MS);
  // Node's timers keep `node --test` alive; a browser's numeric id has no unref.
  if (timer && typeof timer.unref === 'function') timer.unref();
}

/** 'UT' → 'Us, Them' for the Undo label. */
function lettersLabel(points) {
  return [...points].map((c) => (c === 'U' ? 'Us' : 'Them')).join(', ');
}
```

- [ ] **Step 4: Markup — rows, column headers, pills, toast, Undo label**

Replace `renderRow` with:

```js
function renderRow(game, n, player, idleStat) {
  const c = getCount(game, n, player.id);
  const subChip = player.sub ? ' <span class="gchip">Sub</span>' : '';
  const idle = (stat) => (stat === idleStat ? ' idle' : '');
  return `
<div class="row">
  <div class="name">${esc(player.name)}${subChip}</div>
  <button type="button" class="cnt in${idle('serve')}" data-action="tap-count" data-pid="${esc(player.id)}" data-stat="serve" data-side="in">${c.serve.in}</button>
  <button type="button" class="cnt out${idle('serve')}" data-action="tap-count" data-pid="${esc(player.id)}" data-stat="serve" data-side="out">${c.serve.out}</button>
  <button type="button" class="cnt in${idle('return')}" data-action="tap-count" data-pid="${esc(player.id)}" data-stat="return" data-side="in">${c.return.in}</button>
  <button type="button" class="cnt out${idle('return')}" data-action="tap-count" data-pid="${esc(player.id)}" data-stat="return" data-side="out">${c.return.out}</button>
</div>`;
}
```

In `renderRecord`:

1. Move the `setRecord` / `asked` / `typed` lines so they come before `rowsHtml`, then add right after them:

```js
  // Who serves next, and which pair of counters the serving side is not using. Typed sets never infer.
  const server = setRecord && !typed ? setServer(setRecord) : null;
  const open = !!setRecord && !typed && setRecord.pending != null;
  const idleStat = server === 'U' ? 'return' : server === 'T' ? 'serve' : null;
  const idleCls = (stat) => (stat === idleStat ? ' class="idle"' : '');
```

2. Pass it to the rows: `players.map((p) => renderRow(game, n, p, idleStat))`.

3. Replace the `else if (asked)` branch with:

```js
  } else if (asked) {
    const [us, them] = pointTally(setRecord.points);
    const cls = (side) => `${server === side ? ' serving' : ''}${open ? ' open' : ''}`;
    const data = (side) => `${server === side ? ' data-serving="1"' : ''}${open ? ' data-open="1"' : ''}`;
    strip = `<button type="button" class="pt us${cls('U')}" data-action="tap-point" data-winner="U"${data('U')} aria-label="Us scored, ${us}">Us <span class="big">${us}</span></button>
    <button type="button" class="pt them${cls('T')}" data-action="tap-point" data-winner="T"${data('T')} aria-label="Them scored, ${them}"><span class="big">${them}</span> Them</button>`;
  }
```

4. Replace the Undo label line with:

```js
  const undoLabel = !top ? '↶ Undo' : top.kind === 'point' ? `↶ Undo point ${top.winner === 'U' ? 'Us' : 'Them'}` : `↶ Undo ${firstName(day, top.playerId)} ${statLetter(top.stat)} ${top.side}${top.points ? ` + ${lettersLabel(top.points)}` : ''}`;
```

5. Replace the column-header line with:

```js
  <div class="colhead"><span>Player</span><span${idleCls('serve')}>Serve In</span><span${idleCls('serve')}>Serve Out</span><span${idleCls('return')}>Return In</span><span${idleCls('return')}>Return Out</span></div>
```

6. Directly before `<div class="bottombar">` add:

```js
  ${state.toast ? `<div class="toast" role="status" aria-live="polite">${esc(state.toast.text)}</div>` : ''}
```

- [ ] **Step 5: Behaviour — the toast on a scoring tap, cleared by the next action**

Replace `onTapCount` with:

```js
function onTapCount(btn) {
  const game = currentGame();
  if (!game) return;
  const n = clampedActiveSet(game);
  const pid = btn.dataset.pid;
  const stat = btn.dataset.stat;
  const side = btn.dataset.side;
  const delta = state.minusMode ? -1 : 1;
  const previousSession = state.session;
  const setBefore = game.sets[n - 1];
  const tapped = tap(state.session, game.gameId, n, pid, stat, side, delta);
  // one-shot: only switches itself off when the tap actually changed something — a no-op tap
  // (count already at 0) must not silently consume minus mode.
  if (state.minusMode && tapped !== previousSession) state.minusMode = false;
  if (tapped !== previousSession) {
    const after = tapped.games.find((g) => g.gameId === game.gameId);
    const top = after.history[after.history.length - 1];
    // The letters tap() actually appended (the MAX_POINTS cap can trim them), with inferTap's reasons.
    if (top && top.kind === 'count' && top.points) showToast(toastText(inferTap(setBefore, stat, side).letters.slice(0, top.points.length), stat));
  }
  commit({ ...tapped, lastChangedAt: new Date().toISOString() });
}
```

In `runAction`, directly before `const action = btn.dataset.action;`, add:

```js
  // A toast describes only the tap that raised it; the next action of any kind takes it away.
  state.toast = null;
```

- [ ] **Step 6: Styles**

In `src/styles.css`, after the `.setbar .pt.typed { … }` rule add:

```css
/* Side-out inference (docs/superpowers/specs/2026-10-07-auto-score-side-out-design.md): a dot on
   the side serving next, and a dashed border on both while an In tap has left a rally open. */
.setbar .pt.serving::before { content:''; width:7px; height:7px; border-radius:50%; background:currentColor; flex:none; }
.setbar .pt.open { border-style:dashed; }
```

Inside the existing `@media (max-width: 350px)` block add:

```css
  .setbar .pt { gap:4px; }
  .setbar .pt.serving::before { width:6px; height:6px; }
```

After the `.minus .cnt` rule add:

```css
/* The pair the serving side is not using. Still fully tappable: a tap there is a side-out. */
.cnt.idle, .colhead span.idle { opacity:.5; }
/* What a scoring stat tap did. Floats over the rows so the layout never moves; never takes a tap. */
.toast { position:absolute; left:12px; right:12px; bottom:calc(64px + env(safe-area-inset-bottom)); z-index:5; background:var(--fg); color:#fff; border-radius:8px; padding:8px 12px; font-size:12.5px; font-weight:600; text-align:center; pointer-events:none; box-shadow:var(--shadow); }
```

- [ ] **Step 7: Run the unit suite**

Run: `npm test`
Expected: all tests pass (`ℹ fail 0`). If an existing UI test fails only because its regex now meets the new `idle` / `serving` / `open` markup or a `+ Us` Undo label that the spec requires, update its expectation and list it in your report.

- [ ] **Step 8: Leave the changes uncommitted** and write your report.

---

### Task 3: Browser tests, release bump, build and full verification

**Files:**
- Modify: `e2e/record.spec.mjs`
- Modify: `src/session.js` (`APP_VERSION`, line 9), `src/sw.js` (`CACHE`, line 3)
- Modify: `README.md` (manual checklist, after line 211)
- Regenerate: `dist/` via `npm run build` (never edit by hand)

**Interfaces:**
- Consumes: Task 2's markup contract (`data-serving`, `data-open`, `.toast`, Undo label) and Task 1's behaviour.
- Produces: the release 4.3.0 build in `dist/`.

- [ ] **Step 1: Update the first record test and add the auto-scoring test**

In `e2e/record.spec.mjs`, in `taps count on all four stats, and Undo takes the last one back`, the four taps are Serve In (answers serve-first, rally open), Serve Out (rally to Us, then the Out), Return In (rally open) and Return Out (rally to Them, then the Out). Change the first Undo label assertion to:

```js
    await expect(page.locator('[data-action="undo"]')).toHaveText('↶ Undo Grace R out + Them, Them');
```

The second (`'↶ Undo Grace R in'`) stays.

Add inside the `test.describe('Recording a set', …)` block:

```js
  test('stat taps drive the score: the next tap settles an open rally, and Undo takes back tap and points together', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText());
    const us = page.locator('[data-action="tap-point"][data-winner="U"]');
    const them = page.locator('[data-action="tap-point"][data-winner="T"]');
    await press(count(page, 'grace', 'serve', 'in')); // answers "we serve first"; the rally is open
    await expect(us).toHaveAttribute('aria-label', 'Us scored, 0');
    await expect(us).toHaveAttribute('data-open', '1');
    await expect(us).toHaveAttribute('data-serving', '1');
    await press(count(page, 'grace', 'serve', 'in')); // we served again: rally 1 to Us
    await expect(us).toHaveAttribute('aria-label', 'Us scored, 1');
    await expect(page.locator('.toast')).toHaveText('Us +1 · we serve');
    await press(count(page, 'grace', 'serve', 'out')); // rally 2 to Us, then the Out to Them
    await expect(us).toHaveAttribute('aria-label', 'Us scored, 2');
    await expect(them).toHaveAttribute('aria-label', 'Them scored, 1');
    await expect(them).toHaveAttribute('data-serving', '1');
    await expect(page.locator('.toast')).toHaveText('Us +1 · we serve, then Them +1 · Serve out');
    await expect(page.locator('[data-action="undo"]')).toHaveText('↶ Undo Grace S out + Us, Them');
    await press(page.locator('[data-action="undo"]'));
    await expect(us).toHaveAttribute('aria-label', 'Us scored, 1');
    await expect(them).toHaveAttribute('aria-label', 'Them scored, 0');
    await expect(us).toHaveAttribute('data-open', '1');
    await expect(count(page, 'grace', 'serve', 'out')).toHaveText('0');
  });
```

- [ ] **Step 2: Release bump**

In `src/session.js`: `export const APP_VERSION = '4.3.0';`
In `src/sw.js`: `const CACHE = 'ciq-stats-v12';`
Search the repo (excluding `dist/` and `node_modules/`) for other pins of `4.2.0` or `ciq-stats-v11` in tests or scripts; update any that pin the release, and name them in your report.

- [ ] **Step 3: README checklist line**

After the line that starts `- [ ] Tap We serve first, tap Us twice and Them once` in `README.md`, add:

```markdown
- [ ] On a fresh set tap Grace Serve In twice, then Serve Out → the bar reads Us 2 / 1 Them with the dot on Them, the toast says "Us +1 · we serve, then Them +1 · Serve out", and one Undo takes back the Out tap and both of its points (Us 1 / 0 Them, both pills dashed).
```

- [ ] **Step 4: Build and verify**

Run, in order, and capture the tail of each output for your report:

```bash
npm test
npm run build
npm run verify
npm run test:browsers
```

Expected: unit tests `fail 0`; build succeeds and rewrites `dist/`; verify prints its passes (build, golden vector, density); every browser project passes. If other browser tests fail only because stat taps now write points (for example an export check that now sees a rally log, or an Undo label that now names letters), update their expectations to the inferred values and list each one in your report. Anything else is a regression: fix the code, not the test.

- [ ] **Step 5: Leave everything uncommitted** (including `dist/`) and write your report.
