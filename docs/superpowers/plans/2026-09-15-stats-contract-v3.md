# Stats Contract v3 (Roster Bitmask Sets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept `CIQR3.` roster emails, whose `games[].sets` bitmasks give each game its own set count and each set its own membership, and surface that as per-game set tabs and per-set tick lists.

**Architecture:** Three layers change in order, each independently testable. `src/codec.js` becomes a v3 port of the Planner's `statsContract.ts` — mask helpers, a v3 roster validator, and the v2 validator demoted to a private legacy normaliser. `src/session.js` replaces each game's single `playerIds` array with `setPlayerIds` (one list per set) plus an explicit `setCount`, and bumps the saved-session schema 2 → 3 with a migration. `src/ui.js` renders `setCount` tabs and opens the players sheet against the active set. The stats encoder is untouched throughout.

**Tech Stack:** Vanilla ES modules, no framework. Node's built-in test runner (`node --test`). Build via `scripts/build-prod.mjs` (terser + javascript-obfuscator + html-minifier-terser), verified by `scripts/verify-build.mjs` (headless Edge via puppeteer-core).

**Spec:** `reference/stats-contract-v3-client-guide.md` (authoritative), with `C:\_src\CoachIQ_Rotation_Planner\src\contract\statsContract.ts` overriding it wherever the two disagree. Full format reference: `C:\_src\CoachIQ_Rotation_Planner\docs\stats-contract.md`. UI preview: `docs/v3-per-set-mockup.html`.

## Global Constraints

- **Read masks with arithmetic only.** `maskHas(mask, index)` is `Math.floor(mask / 2 ** index) % 2 === 1`. Never `|`, `&` or `<<` on a mask. A reviewer must reject any bitwise mask read on sight.
- **The stats encoder does not change.** `buildDayStatsPayload` keeps emitting `v: 2` / `CIQS2.`. The Planner accepts `v: 2` and `v: 3` indefinitely. Do not bump it.
- **`src/codec.js` is a verbatim port.** Port functions from `statsContract.ts` with TypeScript type syntax stripped and nothing else changed — same logic, same order, same error strings.
- **Constants, unchanged:** `MAX_ROSTER_PLAYERS` 12, `MAX_DAY_PLAYERS` 24, `MAX_SETS` 5, `MAX_GAMES_PER_DAY` 8, `MAX_COUNT` 999, `MAX_NAME_LENGTH` 64, `MAX_RECORDED_AT_LENGTH` 32.
- **`CONTRACT_VERSION` becomes 3.** `NOT_A_KNOWN_VERSION` becomes `'its version is not 1, 2 or 3'`.
- **Imports must stay on one line.** The build inliner strips only full-line `import` statements.
- **Never auto-commit beyond the plan's own commit steps.** Each task ends with exactly one commit.
- **Golden vector, never regenerated:** `CIQR3.eyJ2IjozLCJraW5kIjoicm9zdGVyIiwiZGF0ZSI6IjIwMjYtMDktMTkiLCJ0ZWFtIjoiVGh1bmRlciIsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJuYW1lIjoiR3JhY2UiLCJqZXJzZXkiOjd9LHsiaWQiOiJ6b2llIiwibmFtZSI6Ilpvw6sifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJvcHBvbmVudCI6Ikxpb25zIiwic2V0cyI6WzMsMSwyXX0seyJnYW1lSWQiOiJnYW1lLTIiLCJvcHBvbmVudCI6IkZhbGNvbnMiLCJzZXRzIjpbMiwwXX1dfQ.e9e26391`

---

## File Structure

| File | Change | Responsibility after the change |
|---|---|---|
| `src/codec.js` | Modify | Contract codec. Gains mask helpers, a v3 roster validator, a private v2 legacy validator, `normaliseRosterV2`, and `CONTRACT_VERSION = 3`. |
| `src/vectors.js` | Modify | Golden vectors. Gains `ROSTER_V3_VECTOR`, `ROSTER_V2_AS_V3`, and a rewritten `ROSTER_V1_AS_DAY`. |
| `src/session.js` | Modify | Day state. Game record gains `setCount` + `setPlayerIds`, loses `playerIds`. Schema 2 → 3 with migration. |
| `src/ui.js` | Modify | Screens. `setCount` tabs, per-set tick list, per-set row filter, switcher subtitle. |
| `src/sw.js` | Modify | Cache name bump so phones pick up the new build. |
| `test/codec.test.mjs` | Modify | v3 vector, mask arithmetic, v3 error catalogue, legacy normalisation. |
| `test/session.test.mjs` | Modify | Per-set ingest/merge/tick, schema-3 round-trip, schema-2 migration. |
| `test/ui.test.mjs` | Modify | Tab count and per-set tick list rendering. |
| `test/harden-app.test.mjs` | Modify | Built-bundle smoke roster moves to v3 shape. |
| `scripts/verify-build.mjs` | Modify | Parity harness roster moves to v3 shape. |
| `README.md` | Modify | Contract references v2 → v3; reference-file table. |
| `reference/statsContract.ts`, `reference/vectors.ts` | Replace | Re-copied from the Planner at v3. |
| `docs/v3-per-set-mockup.html` | Already created | UI preview for this plan. |

**Task order is dependency order.** Task 1 is pure reference data. Tasks 2–3 make the codec read v3. Task 4 changes state shape. Task 5 changes the UI. Task 6 updates the build harnesses and docs. Tasks 2–5 each leave the test suite green.

---

### Task 1: Refresh the reference copies and add the v3 golden vectors

**Files:**
- Replace: `reference/statsContract.ts` (copy from `C:\_src\CoachIQ_Rotation_Planner\src\contract\statsContract.ts`)
- Replace: `reference/vectors.ts` (copy from `C:\_src\CoachIQ_Rotation_Planner\src\contract\__fixtures__\vectors.ts`)
- Modify: `src/vectors.js`
- Test: `test/codec.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `ROSTER_V3_VECTOR` (`{ payload, encoded }`), `ROSTER_V2_AS_V3`, and a rewritten `ROSTER_V1_AS_DAY`, all exported from `src/vectors.js`. `STATS_V2_VECTOR`, `STATS_VECTOR`, `ROSTER_VECTOR`, `STATS_V1_AS_DAY` keep their current values and names.

- [ ] **Step 1: Copy the two reference files**

```bash
cd "C:/_src/CoachIQ_Rotation_Planner_Client"
cp "C:/_src/CoachIQ_Rotation_Planner/src/contract/statsContract.ts" reference/statsContract.ts
cp "C:/_src/CoachIQ_Rotation_Planner/src/contract/__fixtures__/vectors.ts" reference/vectors.ts
```

Confirm `reference/statsContract.ts` now contains `export const CONTRACT_VERSION = 3;`.

- [ ] **Step 2: Add the v3 vectors to `src/vectors.js`**

Append to `src/vectors.js`, after the existing `STATS_V2_VECTOR` export:

```js
/**
 * The v3 vectors: the same two-game day, with `games[].roster` replaced by `games[].sets`.
 * `game-1` runs three sets with different membership each time (both players, then Grace alone,
 * then Zoe alone) — the shape that could not be expressed at all before v3. `game-2` runs two
 * sets and has nobody picked for the second: a mask of `0`, legal on purpose.
 */
const ROSTER_V3_PAYLOAD = {
  v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
  games: [
    { gameId: 'game-1', opponent: 'Lions', sets: [3, 1, 2] },
    { gameId: 'game-2', opponent: 'Falcons', sets: [2, 0] },
  ],
};

export const ROSTER_V3_VECTOR = {
  payload: ROSTER_V3_PAYLOAD,
  encoded: 'CIQR3.eyJ2IjozLCJraW5kIjoicm9zdGVyIiwiZGF0ZSI6IjIwMjYtMDktMTkiLCJ0ZWFtIjoiVGh1bmRlciIsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJuYW1lIjoiR3JhY2UiLCJqZXJzZXkiOjd9LHsiaWQiOiJ6b2llIiwibmFtZSI6Ilpvw6sifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJvcHBvbmVudCI6Ikxpb25zIiwic2V0cyI6WzMsMSwyXX0seyJnYW1lSWQiOiJnYW1lLTIiLCJvcHBvbmVudCI6IkZhbGNvbnMiLCJzZXRzIjpbMiwwXX1dfQ.e9e26391',
};
```

- [ ] **Step 3: Rewrite the two normalised-shape fixtures**

`ROSTER_V1_AS_DAY` currently describes the v2 shape. Replace its whole definition (including its doc comment) with the v3 shape, and add `ROSTER_V2_AS_V3` beside it. Both are hand-written, never computed — comparing a decoder against its own normaliser evaluated at runtime is a tautology that passes even when the normaliser is wrong. Key order matches `normaliseRosterV2`'s literal order (`v, kind, date, team, players, games`).

```js
/**
 * `ROSTER_V1_AS_DAY` — the day shape `normaliseRosterV1`/`decodeDayRoster` must produce from
 * `ROSTER_VECTOR.payload` at v3. A v1 roster is a one-game day whose directory is that game's
 * players, so its single set names every one of them: two players, indices 0 and 1, mask 3.
 */
export const ROSTER_V1_AS_DAY = {
  v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
  games: [{ gameId: 'game-1', opponent: 'Lions', sets: [3] }],
};

/**
 * `ROSTER_V2_AS_V3` — the day shape `decodeDayRoster` must produce from `ROSTER_V2_VECTOR.payload`.
 * A v2 game carried no set structure, so each normalises to ONE set holding its whole roster:
 * `game-1`'s `roster: [0, 1]` becomes mask 3, `game-2`'s `roster: [1]` becomes mask 2.
 */
export const ROSTER_V2_AS_V3 = {
  v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
  games: [
    { gameId: 'game-1', opponent: 'Lions', sets: [3] },
    { gameId: 'game-2', opponent: 'Falcons', sets: [2] },
  ],
};
```

- [ ] **Step 4: Write the failing vector test**

In `test/codec.test.mjs`, add the import of `ROSTER_V3_VECTOR` to the existing `../src/vectors.js` import line (keep it one line), and add this test after `golden v2 roster vector round-trips byte-exact`:

```js
test('golden v3 roster vector round-trips byte-exact', () => {
  assert.equal(encodeDayRoster(ROSTER_V3_VECTOR.payload), ROSTER_V3_VECTOR.encoded);
  assert.deepEqual(decodeDayRoster(ROSTER_V3_VECTOR.encoded), { ok: true, value: ROSTER_V3_VECTOR.payload });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL. `encodeDayRoster` still stamps `CIQR2.`, so the equality assertion reports a `CIQR2.`-prefixed string against the `CIQR3.` expectation. Several existing tests also fail because `ROSTER_V1_AS_DAY` changed shape — that is expected and Task 2 fixes it.

- [ ] **Step 6: Commit the vectors**

```bash
git add reference/statsContract.ts reference/vectors.ts src/vectors.js test/codec.test.mjs
git commit -m "test: add v3 golden roster vectors and refresh reference copies

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Port the mask helpers and the v3 roster validator into the codec

**Files:**
- Modify: `src/codec.js:6` (`CONTRACT_VERSION`), `src/codec.js:555` (`NOT_A_KNOWN_VERSION`), `src/codec.js:407-462` (`validateDayRosterPayload`), `src/codec.js:560-572` (`normaliseRosterV1`), `src/codec.js:577-592` (`decodeDayRoster`)
- Test: `test/codec.test.mjs`

**Interfaces:**
- Consumes: `ROSTER_V3_VECTOR`, `ROSTER_V2_AS_V3`, `ROSTER_V1_AS_DAY` from Task 1.
- Produces, all exported from `src/codec.js`:
  - `maskHas(mask: number, index: number) => boolean`
  - `maskOf(indices: number[]) => number`
  - `maskMembers(mask: number, size: number) => number[]`
  - `maskCount(mask: number, size: number) => number`
  - `maskUnion(a: number, b: number, size: number) => number`
  - `validateDayRosterPayload(value)` — now validates **v3**, returning `{ ok: true, value: { v: 3, kind, date, team, players, games: [{ gameId, opponent, sets: number[] }] } }`
  - `normaliseRosterV1(p)` — now returns the **v3** shape
  - `decodeDayRoster(text)` — dispatches v1 / v2 / v3, always returning the v3 shape
  - `CONTRACT_VERSION === 3`
  - `validateDayRosterPayloadV2` stays **module-private**, matching the reference.

- [ ] **Step 1: Write the failing tests**

In `test/codec.test.mjs`, add `maskHas, maskOf, maskMembers, maskCount, maskUnion` to the existing `../src/codec.js` import list, and `ROSTER_V2_AS_V3` to the `../src/vectors.js` import list (both stay one line each). Then add:

```js
test('mask helpers use arithmetic and survive past bit 30', () => {
  assert.equal(maskHas(3, 0), true);
  assert.equal(maskHas(3, 1), true);
  assert.equal(maskHas(1, 0), true);
  assert.equal(maskHas(1, 1), false);
  assert.equal(maskHas(2, 0), false);
  assert.equal(maskHas(2, 1), true);
  assert.equal(maskHas(0, 0), false);
  assert.deepEqual(maskMembers(3, 2), [0, 1]);
  assert.deepEqual(maskMembers(1, 2), [0]);
  assert.deepEqual(maskMembers(2, 2), [1]);
  assert.deepEqual(maskMembers(0, 2), []);
  assert.equal(maskOf([0, 1]), 3);
  assert.equal(maskOf([1]), 2);
  assert.equal(maskOf([]), 0);
  assert.equal(maskOf([1, 1]), 2, 'a repeated index must not set a second, higher bit');
  assert.equal(maskCount(3, 2), 2);
  assert.equal(maskCount(0, 2), 0);
  assert.equal(maskUnion(1, 2, 2), 3);
  assert.equal(maskUnion(3, 2, 2), 3);
  // The bug the arithmetic form exists to prevent: `1 << 31` is negative, `2 ** 31` is not.
  assert.equal(maskHas(2 ** 31, 31), true);
  assert.equal(maskHas(2 ** 40, 40), true);
  assert.deepEqual(maskMembers(2 ** 35 + 1, 36), [0, 35]);
});

test('the guide\u00a78 worked example decodes to the documented tick lists', () => {
  const r = decodeDayRoster(ROSTER_V3_VECTOR.encoded);
  assert.equal(r.ok, true);
  const names = r.value.players.map((p) => p.name);
  const membersOf = (game, i) => maskMembers(game.sets[i], names.length).map((x) => names[x]);
  const [g1, g2] = r.value.games;
  assert.equal(g1.sets.length, 3, 'sets.length is the set count');
  assert.deepEqual(membersOf(g1, 0), ['Grace', 'Zoë']);
  assert.deepEqual(membersOf(g1, 1), ['Grace']);
  assert.deepEqual(membersOf(g1, 2), ['Zoë']);
  assert.equal(g2.sets.length, 2);
  assert.deepEqual(membersOf(g2, 0), ['Zoë']);
  assert.deepEqual(membersOf(g2, 1), [], 'mask 0 is nobody pre-ticked, not a missing set');
});

test('legacy rosters normalise to exactly one set holding the whole roster', () => {
  assert.deepEqual(decodeDayRoster(ROSTER_VECTOR.encoded), { ok: true, value: ROSTER_V1_AS_DAY });
  assert.deepEqual(decodeDayRoster(ROSTER_V2_VECTOR.encoded), { ok: true, value: ROSTER_V2_AS_V3 });
  // One set, not three and not five — inventing a set count would present a fabrication as data.
  for (const g of decodeDayRoster(ROSTER_V2_VECTOR.encoded).value.games) assert.equal(g.sets.length, 1);
});

test('a CIQR4 roster is refused as newer, naming the Rotation Planner', () => {
  const future = ROSTER_V3_VECTOR.encoded.replace('CIQR3.', 'CIQR4.');
  assert.deepEqual(decodeDayRoster(future), {
    ok: false,
    error: 'This payload was made by a newer version of the Rotation Planner (contract 4); this app understands 3.',
  });
});

test('v3 roster catalogue', () => {
  const manyPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: 'x' }));
  const base = { v: 3, kind: 'roster', date: 'd', team: 't', players: manyPlayers(2) };
  const game = (sets) => ({ ...base, games: [{ gameId: 'g', opponent: 'o', sets }] });
  // Not a mask at all: negative, fractional, a string, or past the safe-integer range.
  for (const bad of [-1, 1.5, '0', 2 ** 53]) {
    assert.equal(
      validateDayRosterPayload(game([bad])).error,
      'The roster payload is malformed: game "g" set 1 is not a legal roster mask.',
    );
  }
  // A legal integer that sets a bit the directory cannot support. 5 is 101b over 2 players.
  assert.equal(
    validateDayRosterPayload(game([5])).error,
    'The roster payload is malformed: game "g" set 1 names a player outside the directory.',
  );
  // The set number in the message is positional: the second entry reports as set 2.
  assert.equal(
    validateDayRosterPayload(game([3, 4])).error,
    'The roster payload is malformed: game "g" set 2 names a player outside the directory.',
  );
  assert.equal(validateDayRosterPayload(game([])).error, 'The roster payload is malformed: game "g" records no sets.');
  assert.equal(validateDayRosterPayload(game('x')).error, 'The roster payload is malformed: game "g" has no set list.');
  assert.equal(
    validateDayRosterPayload(game([1, 1, 1, 1, 1, 1])).error,
    'The roster payload is malformed: game "g" records more than 5 sets.',
  );
  // The 12-cap is the UNION across sets, not any one set's count.
  const thirteen = { v: 3, kind: 'roster', date: 'd', team: 't', players: manyPlayers(13) };
  assert.equal(
    validateDayRosterPayload({ ...thirteen, games: [{ gameId: 'g', opponent: 'o', sets: [2 ** 13 - 1] }] }).error,
    'The roster payload is malformed: game "g" names 13 players; the limit is 12.',
  );
  // Same 13 players spread one-per-set still trips the union cap.
  assert.equal(
    validateDayRosterPayload({ ...thirteen, games: [{ gameId: 'g', opponent: 'o', sets: [2 ** 12 - 1, 2 ** 12] }] }).error,
    'The roster payload is malformed: game "g" names 13 players; the limit is 12.',
  );
  // A mask of 0 is legal: the coach sent the day before picking that set.
  assert.equal(validateDayRosterPayload(game([0])).ok, true);
  assert.equal(validateDayRosterPayload(game([3, 0, 1])).ok, true);
  // A v2 body reaching the v3 validator directly is a version fault, named with all three.
  assert.equal(
    validateDayRosterPayload({ v: 2, kind: 'roster', date: 'd', team: 't', players: manyPlayers(2), games: [] }).error,
    'The roster payload is malformed: its version is not 1, 2 or 3.',
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with `maskHas is not defined` (or an import error) plus the Task 1 vector failures still outstanding.

- [ ] **Step 3: Add the mask helpers to `src/codec.js`**

Insert immediately after `fnv1a32` (around `src/codec.js:17`), ported verbatim from `reference/statsContract.ts:286-334`:

```js
/**
 * Set-membership bitmasks: how `games[].sets` says who is in a set.
 *
 * Bit `i` of a mask means "the player at `players[i]` is in this set". One integer replaces one
 * index array per set, which is what makes per-set membership affordable in a `mailto:` body.
 *
 * **These use arithmetic, never bitwise operators, and that is load-bearing.** JavaScript's `|`,
 * `&` and `<<` coerce to *signed* 32-bit, so `2 ** 31 | 0` is `-2147483648`. At `MAX_DAY_PLAYERS`
 * of 24 the highest bit is `2 ** 23` and either form would work today — but the arithmetic form
 * keeps working to 2^53, so raising that cap later cannot silently corrupt rosters. Anyone
 * "simplifying" these back to bitwise operators reintroduces a bug that only appears once the
 * directory passes 31 players, and appears as wrong girls on a tick-list, not as an error.
 */
export function maskHas(mask, index) {
  return Math.floor(mask / 2 ** index) % 2 === 1;
}

/** The mask naming exactly `indices`. A repeated index is ignored rather than added twice, which
 *  would set a different, higher bit and name a player nobody chose. */
export function maskOf(indices) {
  let mask = 0;
  for (const index of indices) if (!maskHas(mask, index)) mask += 2 ** index;
  return mask;
}

/** The indices `mask` names, ascending, considering only bits below `size`. */
export function maskMembers(mask, size) {
  const members = [];
  for (let i = 0; i < size; i += 1) if (maskHas(mask, i)) members.push(i);
  return members;
}

/** How many players `mask` names, considering only bits below `size`. */
export function maskCount(mask, size) {
  let count = 0;
  for (let i = 0; i < size; i += 1) if (maskHas(mask, i)) count += 1;
  return count;
}

/** Every player named by either mask. `a` is carried through unfiltered; only `b`'s contribution
 *  is bounded to bits below `size` — safe because every mask reaching this helper has already
 *  been range-checked against the same directory. */
export function maskUnion(a, b, size) {
  let union = a;
  for (let i = 0; i < size; i += 1) if (maskHas(b, i) && !maskHas(union, i)) union += 2 ** i;
  return union;
}
```

- [ ] **Step 4: Bump the two version constants**

`src/codec.js:6`:

```js
export const CONTRACT_VERSION = 3;
```

`src/codec.js:555` — update the value and the doc comment to name all three:

```js
/** The one version detail every day validator and both day decoders report. Deliberately names
 * *all three* versions this app reads rather than only the one being validated: a coach who pasted
 * the wrong thing needs to know what is acceptable, not which branch refused her. */
const NOT_A_KNOWN_VERSION = 'its version is not 1, 2 or 3';
```

- [ ] **Step 5: Demote the existing v2 validator to a private legacy function**

Rename `export function validateDayRosterPayload` at `src/codec.js:407` to `function validateDayRosterPayloadV2` — dropping `export`, matching the reference, which keeps it module-private. Leave its body exactly as it is: it still reads `rawGame.roster`, still returns `{ v: 2, ... }`, and is now reached only through `decodeDayRoster`'s v2 branch.

- [ ] **Step 6: Add the v3 roster validator**

Insert directly after `validateDayRosterPayloadV2`, ported from `reference/statsContract.ts:816-878`:

```js
/**
 * The v3 roster validator. `games[].roster` (one index array per game) is gone; `games[].sets` is
 * one bitmask per set, positional, and `sets.length` is how many sets the game has.
 *
 * The per-game cap is checked on the **union** across the game's sets, which is the same rule v2
 * enforced — in v2 `roster` *was* that union.
 */
export function validateDayRosterPayload(value) {
  if (!isRecord(value)) return malformed('roster', 'it is not an object');
  if (value.v !== 3) return malformed('roster', NOT_A_KNOWN_VERSION);
  if (value.kind !== 'roster') return malformed('roster', 'its kind is not "roster"');
  if (!isNonEmptyString(value.date)) return malformed('roster', 'it has no date');
  // `team` may be empty: `createTeam` does not trim, so a coach who never named her team has one.
  if (typeof value.team !== 'string') return malformed('roster', 'it has no team name');

  const directory = parseDayPlayerList('roster', value.players, true);
  if (!directory.ok) return directory;
  const players = directory.value;

  if (!Array.isArray(value.games)) return malformed('roster', 'it has no game list');
  if (value.games.length === 0) return malformed('roster', 'it names no games');
  if (value.games.length > MAX_GAMES_PER_DAY) {
    return malformed('roster', `it names ${value.games.length} games; the limit is ${MAX_GAMES_PER_DAY}`);
  }

  const games = [];
  const seenGameIds = new Set();
  for (const rawGame of value.games) {
    if (!isRecord(rawGame)) return malformed('roster', 'one of its games is malformed');
    const gameId = rawGame.gameId;
    if (typeof gameId !== 'string' || gameId.length === 0) return malformed('roster', 'one of its games has no id');
    if (seenGameIds.has(gameId)) return malformed('roster', `game id "${gameId}" appears twice`);
    seenGameIds.add(gameId);
    // `opponent` may be empty, the same way `team` may.
    if (typeof rawGame.opponent !== 'string') return malformed('roster', `game "${gameId}" has no opponent name`);

    if (!Array.isArray(rawGame.sets)) return malformed('roster', `game "${gameId}" has no set list`);
    if (rawGame.sets.length === 0) return malformed('roster', `game "${gameId}" records no sets`);
    if (rawGame.sets.length > MAX_SETS) {
      return malformed('roster', `game "${gameId}" records more than ${MAX_SETS} sets`);
    }

    const sets = [];
    let union = 0;
    const ceiling = 2 ** players.length;
    for (let i = 0; i < rawGame.sets.length; i += 1) {
      const rawMask = rawGame.sets[i];
      const n = i + 1;
      // Anything that is not a whole number at or above zero is not a mask at all, so it is a
      // malformed value rather than an out-of-range one — the same distinction v2 drew for indices.
      if (typeof rawMask !== 'number' || !Number.isSafeInteger(rawMask) || rawMask < 0) {
        return malformed('roster', `game "${gameId}" set ${n} is not a legal roster mask`);
      }
      if (rawMask >= ceiling) {
        return malformed('roster', `game "${gameId}" set ${n} names a player outside the directory`);
      }
      sets.push(rawMask);
      union = maskUnion(union, rawMask, players.length);
    }

    const named = maskCount(union, players.length);
    if (named > MAX_ROSTER_PLAYERS) {
      return malformed('roster', `game "${gameId}" names ${named} players; the limit is ${MAX_ROSTER_PLAYERS}`);
    }

    games.push({ gameId, opponent: rawGame.opponent, sets });
  }

  return { ok: true, value: { v: 3, kind: 'roster', date: value.date, team: value.team, players, games } };
}
```

- [ ] **Step 7: Add `normaliseRosterV2` and re-route `normaliseRosterV1` through it**

Replace the whole of `normaliseRosterV1` (`src/codec.js:560-572`) with, ported from `reference/statsContract.ts:985-1014`:

```js
/**
 * A v2 roster lifted into the v3 shape.
 *
 * A v2 payload carried no set structure at all, so there is nothing to recover: each game
 * normalises to **one set** holding that game's whole roster. This is lossy and deliberately so —
 * inventing three sets because three is the usual number would put a fabricated set count in front
 * of a coach and call it data. A coach who wants real per-set membership re-sends from the Planner.
 */
function normaliseRosterV2(p) {
  return {
    v: 3,
    kind: 'roster',
    date: p.date,
    team: p.team,
    players: p.players,
    games: p.games.map((g) => ({ gameId: g.gameId, opponent: g.opponent, sets: [maskOf(g.roster)] })),
  };
}

/**
 * A v1 roster lifted into the v3 shape, via v2 so that "what a legacy payload's single set means"
 * has exactly one definition.
 *
 * A v1 roster is a one-game day whose directory is that game's players, so every index `0..n-1` is
 * on its tick-list, and `date`/`team` lift to the top. v1's own 12-player cap lands exactly on
 * `MAX_ROSTER_PLAYERS`, so even a full v1 roster normalises to a legal game.
 */
export function normaliseRosterV1(p) {
  return normaliseRosterV2({
    v: 2,
    kind: 'roster',
    date: p.date,
    team: p.team,
    players: p.players,
    games: [{ gameId: p.gameId, opponent: p.opponent, roster: p.players.map((_, i) => i) }],
  });
}
```

- [ ] **Step 8: Add the v3 branch to `decodeDayRoster`**

In `decodeDayRoster` (`src/codec.js:577`), replace the v2 branch and add a v3 one:

```js
  if (version === 2) {
    const v2 = validateDayRosterPayloadV2(decoded.value);
    if (!v2.ok) return v2;
    return { ok: true, value: normaliseRosterV2(v2.value) };
  }
  if (version === 3) return validateDayRosterPayload(decoded.value);
  return malformed('roster', NOT_A_KNOWN_VERSION);
```

- [ ] **Step 9: Update the pre-existing tests that assumed v2**

Three existing tests in `test/codec.test.mjs` now assert stale expectations:

1. `'v2 constants'` (line ~35) — change `assert.equal(CONTRACT_VERSION, 2)` to `assert.equal(CONTRACT_VERSION, 3)` and rename the test to `'contract constants'`.
2. `'golden v2 roster vector round-trips byte-exact'` (line ~24) — `encodeDayRoster` now stamps `CIQR3.`, so the encode half is no longer meaningful for a v2 payload. Replace the whole test body with an explicit-version encode plus the normalising decode:

```js
test('golden v2 roster vector still encodes and decodes, normalising to one set per game', () => {
  assert.equal(encodePayload('roster', ROSTER_V2_VECTOR.payload, 2), ROSTER_V2_VECTOR.encoded);
  assert.deepEqual(decodeDayRoster(ROSTER_V2_VECTOR.encoded), { ok: true, value: ROSTER_V2_AS_V3 });
});
```

3. `'real planner roster payload decodes to a one-game day'` (line ~83) — the final assertion reads `result.value.games[0].roster`. That field is gone. Replace it with:

```js
  assert.deepEqual(result.value.games[0].sets, [1023], 'ten players, indices 0-9, normalised to one set');
```

(`2 ** 10 - 1 === 1023`.)

4. `'v2 roster catalogue'` (line ~99) — it calls `validateDayRosterPayload` with v2 bodies, which is now the v3 validator. Rewrite each call to go through the real legacy path instead, which is what a coach's old email actually takes:

```js
test('v2 roster catalogue, reached through the legacy decode path', () => {
  const manyPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: 'x' }));
  const decodeV2 = (body) => decodeDayRoster(encodePayload('roster', { v: 2, kind: 'roster', date: 'd', team: 't', ...body }, 2));
  assert.equal(
    decodeV2({ players: manyPlayers(25), games: [{ gameId: 'g', opponent: 'o', roster: [] }] }).error,
    'The roster payload is malformed: it names 25 players; the day limit is 24.',
  );
  const manyGames = (n) => Array.from({ length: n }, (_, i) => ({ gameId: `g${i}`, opponent: 'o', roster: [] }));
  assert.equal(
    decodeV2({ players: manyPlayers(2), games: manyGames(9) }).error,
    'The roster payload is malformed: it names 9 games; the limit is 8.',
  );
  assert.equal(
    decodeV2({ players: manyPlayers(2), games: [{ gameId: 'g', opponent: 'o', roster: Array(13).fill(0) }] }).error,
    'The roster payload is malformed: game "g" names 13 players; the limit is 12.',
  );
  for (const bad of [-1, 1.5, '0']) {
    assert.equal(
      decodeV2({ players: manyPlayers(2), games: [{ gameId: 'g', opponent: 'o', roster: [bad] }] }).error,
      'The roster payload is malformed: game "g" has a malformed player reference.',
    );
  }
  assert.equal(
    decodeV2({ players: manyPlayers(2), games: [{ gameId: 'g', opponent: 'o', roster: [5] }] }).error,
    'The roster payload is malformed: game "g" names player 5, but the payload lists only 2.',
  );
  assert.equal(
    decodeV2({ players: manyPlayers(2), games: [{ gameId: 'g', opponent: 'o', roster: [0, 0] }] }).error,
    'The roster payload is malformed: game "g" names player 0 twice.',
  );
  // An empty v2 roster normalises to one set with a mask of 0 — a set that exists, nobody picked.
  const empty = decodeV2({ players: manyPlayers(2), games: [{ gameId: 'g', opponent: 'o', roster: [] }] });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.value.games[0].sets, [0]);
});
```

Add `encodePayload` to the `../src/codec.js` import list if it is not already there (it is, at line 5).

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS, including Task 1's vector test. `test/session.test.mjs` and `test/ui.test.mjs` will now fail — `newDayFromRoster` still reads `g.roster`, which no longer exists. That is Task 4's job; if the runner stops early, run `node --test test/codec.test.mjs` to confirm this task in isolation before moving on.

- [ ] **Step 11: Commit**

```bash
git add src/codec.js test/codec.test.mjs
git commit -m "feat: read games[].sets bitmasks at contract v3

CONTRACT_VERSION 3. Mask helpers are arithmetic, never bitwise: JavaScript's
| and & coerce to signed 32-bit, so a bit past 30 would silently pre-tick the
wrong players rather than error. CIQR1./CIQR2. emails normalise to one set
holding the game's whole roster, via normaliseRosterV2.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Teach `runSelfCheck` the v3 vectors

**Files:**
- Modify: `src/session.js:2` (import line), `src/session.js:760-780` (`runSelfCheck`)
- Test: `test/session.test.mjs`

**Interfaces:**
- Consumes: `decodeDayRoster`, `encodeDayRoster` from Task 2; `ROSTER_V3_VECTOR`, `ROSTER_V2_AS_V3`, `ROSTER_V1_AS_DAY` from Task 1.
- Produces: `runSelfCheck()` unchanged in signature — `{ ok: true } | { ok: false, error: string }`. The Export button stays disabled while it reports `ok: false`.

This is its own task because `runSelfCheck` gates the Export button at runtime: if it silently starts failing, a coach loses the ability to send her day, with no error visible except a greyed-out button.

- [ ] **Step 1: Write the failing test**

Add to `test/session.test.mjs`:

```js
test('runSelfCheck passes and covers all three roster versions', () => {
  assert.deepEqual(runSelfCheck(), { ok: true });
});
```

Add `runSelfCheck` to the existing `../src/session.js` import line, and `ROSTER_V3_VECTOR` to the `../src/vectors.js` import line.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/session.test.mjs`
Expected: FAIL with `{ ok: false, error: 'day roster vector encode' }` — `encodeDayRoster` now emits `CIQR3.` while the check still compares against `ROSTER_V2_VECTOR.encoded`.

- [ ] **Step 3: Update the roster half of `runSelfCheck`**

In `src/session.js`, add `ROSTER_V3_VECTOR, ROSTER_V2_AS_V3` to the `./vectors.js` import (one line), and replace the four roster-related lines inside `runSelfCheck`:

```js
    if (encodeDayRoster(ROSTER_V3_VECTOR.payload) !== ROSTER_V3_VECTOR.encoded) return { ok: false, error: 'day roster vector encode' };
```

and, in the decode block:

```js
    const r3 = decodeDayRoster(ROSTER_V3_VECTOR.encoded);
    if (!r3.ok || JSON.stringify(r3.value) !== JSON.stringify(ROSTER_V3_VECTOR.payload)) return { ok: false, error: 'day roster vector decode' };
    const r2 = decodeDayRoster(ROSTER_V2_VECTOR.encoded);
    if (!r2.ok || JSON.stringify(r2.value) !== JSON.stringify(ROSTER_V2_AS_V3)) return { ok: false, error: 'legacy v2 roster vector decode' };
    const r1 = decodeDayRoster(ROSTER_VECTOR.encoded);
    if (!r1.ok || JSON.stringify(r1.value) !== JSON.stringify(ROSTER_V1_AS_DAY)) return { ok: false, error: 'legacy roster vector decode' };
```

Leave every stats line in `runSelfCheck` exactly as it is — `encodeDayStats(STATS_V2_VECTOR.payload)` must still equal `STATS_V2_VECTOR.encoded`. This is the check that will catch anyone bumping the stats encoder by accident.

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/session.test.mjs -t 'runSelfCheck'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session.js test/session.test.mjs
git commit -m "test: cover all three roster versions in runSelfCheck

The stats vector assertions stay on CIQS2. deliberately — the stats encoder
does not move at v3, and this is what catches an accidental bump.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Give each set its own membership in the session model

**Files:**
- Modify: `src/session.js` — `SESSION_SCHEMA` (line 8), `hasAnyCount` (78-88), `newDayFromRoster` (96-117), `mergeDayRoster` (136-195), `setPlayerTicked` (213-238), `addSub` (240-265), `parseGame` (477-506), `parseDay` (509-556), `migrateSchema1` (~690-720)
- Test: `test/session.test.mjs`

**Interfaces:**
- Consumes: `maskHas`, `maskMembers`, `maskCount`, `maskOf`, `maskUnion` from Task 2.
- Produces — the game record becomes:

```js
{ gameId: string, opponent: string, setCount: number, setPlayerIds: string[][], sets: (SetRecord|null)[], activeSet: number, history: HistoryEntry[] }
```

  - `setCount` — integer 1..`MAX_SETS`. How many tabs this game has.
  - `setPlayerIds` — always `MAX_SETS` entries long, one array of directory ids per set slot. Slots at or beyond `setCount` are kept (never truncated) so a set count that later grows back does not lose her ticks.
  - `sets` — unchanged: always `MAX_SETS` entries, `null` or `{ score, counts }`.
  - `playerIds` is **removed**. Every reader must move to `setPlayerIds[n - 1]`.
  - New exports: `gameSetCount(game) => number`, `gamePlayerIdsUnion(game) => string[]` (directory-order union across `setPlayerIds[0..setCount-1]`).
  - Changed signatures: `setPlayerTicked(s, gameId, n, playerId, ticked)` and `addSub(s, gameId, n, name, id)` — both gain `n` as the third argument.
  - `SESSION_SCHEMA` becomes `3`.

**Design decisions this task locks in** (all surfaced in `docs/v3-per-set-mockup.html` §4):

- The 12-player cap is enforced on the **union across sets**, matching the reference's `maskCount(union, …)`. Ticking a 13th distinct girl into any set is what gets refused.
- Un-ticking is guarded **per set**: a player may be removed from a set she has no counts in, even if she has counts in another set.
- `mergeDayRoster` never shrinks `setCount` below recorded data: `setCount = Math.max(incoming.sets.length, highestPlayedSlot + 1)`. The function is documented as non-destructive by construction; this keeps that true.
- A schema-2 save migrates to `setCount = MAX_SETS` with the old `playerIds` copied into every slot, so an in-progress day already on a phone looks and behaves exactly as it did.

- [ ] **Step 1: Write the failing tests**

Add to `test/session.test.mjs` (and add `ROSTER_V3_VECTOR` to the vectors import, `gameSetCount, gamePlayerIdsUnion` to the session import):

```js
const rosterV3 = ROSTER_V3_VECTOR.payload;

test('ingest gives each game its own set count and each set its own membership', () => {
  const day = newDayFromRoster(rosterV3, '2026-09-19T09:00:00Z');
  const [g1, g2] = day.games;
  assert.equal(g1.setCount, 3, 'sets.length is authoritative, per game');
  assert.equal(g2.setCount, 2, 'games in one day may differ');
  assert.deepEqual(g1.setPlayerIds[0], ['grace', 'zoie']);
  assert.deepEqual(g1.setPlayerIds[1], ['grace']);
  assert.deepEqual(g1.setPlayerIds[2], ['zoie']);
  assert.deepEqual(g2.setPlayerIds[0], ['zoie']);
  assert.deepEqual(g2.setPlayerIds[1], [], 'mask 0 is nobody pre-ticked');
  assert.equal(g1.setPlayerIds.length, MAX_SETS, 'always MAX_SETS slots, whatever setCount says');
  assert.equal(g1.sets.length, MAX_SETS);
  assert.deepEqual(gamePlayerIdsUnion(g1), ['grace', 'zoie']);
  assert.deepEqual(gamePlayerIdsUnion(g2), ['zoie']);
});

test('a legacy roster ingests as exactly one set', () => {
  const legacy = decodeDayRoster(ROSTER_V2_VECTOR.encoded);
  const day = newDayFromRoster(legacy.value, '2026-09-19T09:00:00Z');
  assert.equal(day.games[0].setCount, 1, 'one set, not three and not five');
  assert.deepEqual(day.games[0].setPlayerIds[0], ['grace', 'zoie']);
});

test('ticking is per set and does not leak between sets', () => {
  const day = newDayFromRoster(rosterV3, '2026-09-19T09:00:00Z');
  const r = setPlayerTicked(day, 'game-1', 2, 'zoie', true);
  assert.equal(r.ok, true);
  const g1 = r.session.games[0];
  assert.deepEqual(g1.setPlayerIds[1], ['grace', 'zoie'], 'added to set 2');
  assert.deepEqual(g1.setPlayerIds[0], ['grace', 'zoie'], 'set 1 untouched');
  assert.deepEqual(g1.setPlayerIds[2], ['zoie'], 'set 3 untouched');
});

test('un-ticking is guarded by counts in THAT set, not anywhere in the game', () => {
  let day = newDayFromRoster(rosterV3, '2026-09-19T09:00:00Z');
  day = tap(day, 'game-1', 1, 'grace', 'serve', 'in', 1);
  // Grace has counts in set 1, so set 1 refuses.
  const refused = setPlayerTicked(day, 'game-1', 1, 'grace', false);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Grace has counts in Set 1/);
  // She has none in set 2, so set 2 allows it even though set 1 has counts.
  const allowed = setPlayerTicked(day, 'game-1', 2, 'grace', false);
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.session.games[0].setPlayerIds[1], []);
});

test('the 12-player cap is the union across a game\u0027s sets', () => {
  const players = Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const roster = {
    v: 3, kind: 'roster', date: '2026-09-19', team: 'T', players,
    games: [{ gameId: 'g', opponent: 'o', sets: [2 ** 12 - 1, 0] }],
  };
  const day = newDayFromRoster(roster, '2026-09-19T09:00:00Z');
  assert.equal(gamePlayerIdsUnion(day.games[0]).length, 12);
  // The 13th distinct girl, ticked into a DIFFERENT set, still trips the cap.
  const r = setPlayerTicked(day, 'g', 2, 'p12', true);
  assert.equal(r.ok, false);
  assert.match(r.error, /12 players/);
  // But re-ticking somebody already in the union into another set is fine.
  assert.equal(setPlayerTicked(day, 'g', 2, 'p0', true).ok, true);
});

test('a sub joins only the set she was added to', () => {
  const day = newDayFromRoster(rosterV3, '2026-09-19T09:00:00Z');
  const r = addSub(day, 'game-1', 3, 'Ava', 'cx-testtest');
  assert.equal(r.ok, true);
  assert.equal(r.session.players.at(-1).id, 'cx-testtest');
  assert.deepEqual(r.session.games[0].setPlayerIds[2], ['zoie', 'cx-testtest']);
  assert.deepEqual(r.session.games[0].setPlayerIds[0], ['grace', 'zoie'], 'set 1 untouched');
});

test('a merge never shrinks a set count below recorded data', () => {
  let day = newDayFromRoster(rosterV3, '2026-09-19T09:00:00Z');
  day = tap(day, 'game-1', 3, 'zoie', 'serve', 'in', 1);
  const shrunk = { ...rosterV3, games: [{ gameId: 'game-1', opponent: 'Lions', sets: [3] }, rosterV3.games[1]] };
  const res = openDayRoster(day, shrunk, '2026-09-19T12:00:00Z');
  assert.equal(res.kind, 'sameDay');
  assert.equal(res.session.games[0].setCount, 3, 'set 3 has counts, so the game keeps three tabs');
});

test('a merge refreshes each set\u0027s ticks and keeps players who have counts there', () => {
  let day = newDayFromRoster(rosterV3, '2026-09-19T09:00:00Z');
  day = tap(day, 'game-1', 1, 'zoie', 'serve', 'in', 1);
  // The re-sent roster drops Zoë from set 1, but she has counts in it.
  const resent = { ...rosterV3, games: [{ gameId: 'game-1', opponent: 'Lions', sets: [1, 1, 2] }, rosterV3.games[1]] };
  const res = openDayRoster(day, resent, '2026-09-19T12:00:00Z');
  assert.equal(res.kind, 'sameDay');
  assert.deepEqual(res.session.games[0].setPlayerIds[0], ['grace', 'zoie'], 'kept: she has counts in set 1');
  assert.deepEqual(res.session.games[0].setPlayerIds[1], ['grace'], 'set 2 takes the incoming mask');
});

test('schema 3 round-trips, and a schema 2 save migrates to five tabs', () => {
  const day = newDayFromRoster(rosterV3, '2026-09-19T09:00:00Z');
  const parsed = parseSession(serialiseSession(day));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, day);

  const schema2 = JSON.stringify({
    schema: 2, savedAt: '2026-09-19T20:00:00Z',
    session: {
      date: '2026-09-19', team: 'Thunder',
      players: [{ id: 'grace', name: 'Grace', sub: false }, { id: 'zoie', name: 'Zoë', sub: false }],
      games: [{
        gameId: 'game-1', opponent: 'Lions', playerIds: ['grace', 'zoie'],
        sets: [null, null, null, null, null], activeSet: 1, history: [],
      }],
      activeGameId: 'game-1', importedAt: '2026-09-19T09:00:00Z', lastExportedAt: null, lastChangedAt: null,
    },
  });
  const migrated = parseSession(schema2);
  assert.equal(migrated.ok, true);
  const g = migrated.value.games[0];
  assert.equal(g.setCount, MAX_SETS, 'a schema-2 day was recorded under a five-tab UI; keep five');
  assert.equal(g.playerIds, undefined, 'the flat list is gone');
  for (let i = 0; i < MAX_SETS; i += 1) assert.deepEqual(g.setPlayerIds[i], ['grace', 'zoie']);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/session.test.mjs`
Expected: FAIL — `gameSetCount is not exported`, plus `newDayFromRoster` throwing or producing `playerIds` because it still reads `g.roster`.

- [ ] **Step 3: Bump the schema and add the two helpers**

`src/session.js:8`:

```js
export const SESSION_SCHEMA = 3;
```

Add `maskMembers, maskCount, maskOf, maskUnion, maskHas` to the `./codec.js` import line (keep it one line). Then add, next to `gameLabel`:

```js
/** How many set tabs this game has. `sets.length` from the roster is authoritative, but a game
 * whose count was later reduced by a re-sent roster keeps whatever it needs to show recorded
 * data — see `mergeDayRoster`. */
export function gameSetCount(game) {
  return game.setCount;
}

/** Everyone this game names across its live sets, in directory order is the caller's job — this
 * returns first-seen order, which is what the 12-player cap counts. The cap is the union across
 * sets, exactly as `validateDayRosterPayload` measures it with `maskCount(union, …)`; a per-set
 * cap would let us build a day the planner then refuses. */
export function gamePlayerIdsUnion(game) {
  const seen = [];
  for (let i = 0; i < game.setCount; i += 1) {
    for (const id of game.setPlayerIds[i]) if (!seen.includes(id)) seen.push(id);
  }
  return seen;
}

/** The highest slot index holding a played set, or -1 when nothing is recorded. */
function highestPlayedSlot(game) {
  let highest = -1;
  game.sets.forEach((set, i) => { if (isSetPlayed(set)) highest = i; });
  return highest;
}

/** `setPlayerIds` padded to MAX_SETS. Slots beyond `setCount` are retained rather than dropped,
 * so a count that later grows back does not lose ticks the coach already made. */
function padSetPlayerIds(lists) {
  const out = [];
  for (let i = 0; i < MAX_SETS; i += 1) out.push(lists[i] ? [...lists[i]] : []);
  return out;
}
```

- [ ] **Step 4: Rewrite `hasAnyCount` as a per-set check**

Replace `hasAnyCount` (`src/session.js:78-88`) with:

```js
/** Counts in one specific set. Un-ticking is guarded per set now: a girl who played set 1 may
 * legitimately be taken off set 2's list, and refusing that would make the per-set tick-list
 * unusable after the first tap. */
function hasCountInSet(game, n, playerId) {
  const set = game.sets[n - 1];
  if (!set) return false;
  const c = set.counts[playerId];
  if (!c) return false;
  return c.serve.in + c.serve.out + c.return.in + c.return.out > 0;
}
```

- [ ] **Step 5: Rewrite `newDayFromRoster`**

```js
/** `roster` is always a v3 day roster payload — `decodeDayRoster` normalises v1 and v2 before it
 * ever reaches here, so nothing below branches on a version. */
export function newDayFromRoster(roster, nowIso) {
  const directory = roster.players.map((p) => ({ id: p.id, name: p.name, sub: false }));
  const size = directory.length;
  const games = roster.games.map((g) => ({
    gameId: g.gameId,
    opponent: g.opponent,
    // sets.length is the one and only source of truth for how many sets this game has, and
    // different games in the same day legitimately differ.
    setCount: g.sets.length,
    // Mask -> ids, resolved exactly once, here at ingest. validateDayRosterPayload has already
    // proved every mask is in range, so maskMembers cannot name a player outside the directory.
    setPlayerIds: padSetPlayerIds(g.sets.map((mask) => maskMembers(mask, size).map((i) => directory[i].id))),
    sets: Array(MAX_SETS).fill(null),
    activeSet: 1,
    history: [],
  }));
  return {
    date: roster.date,
    team: roster.team,
    players: directory,
    games,
    activeGameId: games[0] ? games[0].gameId : null,
    importedAt: nowIso,
    lastExportedAt: null,
    lastChangedAt: null,
  };
}
```

- [ ] **Step 6: Rewrite the two game-building blocks in `mergeDayRoster`**

Replace the `matchedGames` block:

```js
  // Games already present (matched on gameId): keep sets/history/activeSet, take the new opponent.
  // Each set's new tick list = that set's incoming ids, plus anyone already ticked there who has
  // counts in THAT set or is a sub.
  const matchedGames = s.games.map((g) => {
    const rg = roster.games.find((x) => x.gameId === g.gameId);
    if (!rg) return g; // a local game the roster no longer names: keep it, untouched.
    const incoming = rg.sets.map((mask) => maskMembers(mask, roster.players.length).map((i) => roster.players[i].id));
    const setPlayerIds = padSetPlayerIds(
      g.setPlayerIds.map((existing, i) => {
        if (i >= incoming.length) return existing; // a set the new roster does not describe
        const keep = existing.filter((id) => !incoming[i].includes(id) && (hasCountInSet(g, i + 1, id) || subLookup.get(id)));
        return [...incoming[i], ...keep];
      }),
    );
    // Never below what is already recorded: mergeDayRoster is non-destructive by construction,
    // and dropping a tab would hide counts that buildDayStatsPayload still exports.
    const setCount = Math.max(incoming.length, highestPlayedSlot(g) + 1);
    return { ...g, opponent: rg.opponent, setCount, setPlayerIds };
  });
  for (const g of matchedGames) {
    const named = gamePlayerIdsUnion(g).length;
    if (named > MAX_ROSTER_PLAYERS) {
      return {
        ok: false,
        error: `Updating "${g.opponent || g.gameId}" would make ${named} players; the game limit is ${MAX_ROSTER_PLAYERS}.`,
      };
    }
  }
```

Replace the `appendedGames` block:

```js
  const appendedGames = newRosterGames.map((rg) => ({
    gameId: rg.gameId,
    opponent: rg.opponent,
    setCount: rg.sets.length,
    setPlayerIds: padSetPlayerIds(rg.sets.map((mask) => maskMembers(mask, roster.players.length).map((i) => roster.players[i].id))),
    sets: Array(MAX_SETS).fill(null),
    activeSet: 1,
    history: [],
  }));
```

- [ ] **Step 7: Rewrite `setPlayerTicked` and `addSub` to take a set number**

```js
export function setPlayerTicked(s, gameId, n, playerId, ticked) {
  const game = findGame(s, gameId);
  if (!game) return { ok: false, error: 'That game does not exist.' };
  const current = game.setPlayerIds[n - 1];
  if (ticked) {
    if (current.includes(playerId)) return { ok: true, session: s };
    // The cap is the union across sets, matching validateDayRosterPayload's maskCount(union, …).
    // Somebody already named by another set costs nothing to add here.
    const union = gamePlayerIdsUnion(game);
    if (!union.includes(playerId) && union.length >= MAX_ROSTER_PLAYERS) {
      return { ok: false, error: `This game already has ${MAX_ROSTER_PLAYERS} players; the stats app limit is ${MAX_ROSTER_PLAYERS}.` };
    }
    const session = withGame(s, gameId, (g) => {
      const setPlayerIds = g.setPlayerIds.slice();
      setPlayerIds[n - 1] = [...current, playerId];
      return { ...g, setPlayerIds };
    });
    return { ok: true, session };
  }
  if (!current.includes(playerId)) return { ok: true, session: s };
  // The refusal is the safeguard: buildDayStatsPayload derives lines from what is recorded, and a
  // player hidden from the record screen while her counts sat in sets[n].counts would be a silent
  // inconsistency the coach could not see. Scoped to this set — she may still be off set 2's list.
  if (hasCountInSet(game, n, playerId)) {
    const player = s.players.find((p) => p.id === playerId);
    const name = player ? player.name : playerId;
    return { ok: false, error: `${name} has counts in Set ${n} — clear the set first to take her off.` };
  }
  const session = withGame(s, gameId, (g) => {
    const setPlayerIds = g.setPlayerIds.slice();
    setPlayerIds[n - 1] = current.filter((id) => id !== playerId);
    return { ...g, setPlayerIds };
  });
  return { ok: true, session };
}

export function addSub(s, gameId, n, name, id) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0) return { ok: false, error: 'Enter a name.' };
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `That name is ${trimmed.length} characters; the limit is ${MAX_NAME_LENGTH}.` };
  }
  const game = findGame(s, gameId);
  if (!game) return { ok: false, error: 'That game does not exist.' };
  // Section 5 rule 3 made enforceable: a cx- id minted for somebody already in the directory
  // under her real id imports at the planner as a stranger, and by then the two are indistinguishable.
  const lower = trimmed.toLowerCase();
  if (s.players.some((p) => p.name.toLowerCase() === lower)) {
    return { ok: false, error: `Someone called ${trimmed} is already in today's players — tick her instead.` };
  }
  if (s.players.length >= MAX_DAY_PLAYERS) {
    return { ok: false, error: `Today already has ${MAX_DAY_PLAYERS} players; the day limit is ${MAX_DAY_PLAYERS}.` };
  }
  if (gamePlayerIdsUnion(game).length >= MAX_ROSTER_PLAYERS) {
    return { ok: false, error: `This game already has ${MAX_ROSTER_PLAYERS} players; the stats app limit is ${MAX_ROSTER_PLAYERS}.` };
  }
  const playerId = id ?? newClientId();
  // She joins the set she was added to, and only that one — a sub who comes on for set 3 is not
  // in sets 1 and 2, and assuming otherwise would pre-tick her into sets she never played.
  const session = {
    ...s,
    players: [...s.players, { id: playerId, name: trimmed, sub: true }],
    games: s.games.map((g) => {
      if (g.gameId !== gameId) return g;
      const setPlayerIds = g.setPlayerIds.slice();
      setPlayerIds[n - 1] = [...setPlayerIds[n - 1], playerId];
      return { ...g, setPlayerIds };
    }),
  };
  return { ok: true, session };
}
```

- [ ] **Step 8: Update `parseGame` for schema 3**

Replace the `playerIds` block in `parseGame` (`src/session.js:481-490`) with a `setCount` + `setPlayerIds` block, and leave the `sets`/`activeSet`/`history` parsing exactly as it is:

```js
  if (!Number.isInteger(value.setCount) || value.setCount < 1 || value.setCount > MAX_SETS) return undefined;
  if (!Array.isArray(value.setPlayerIds) || value.setPlayerIds.length !== MAX_SETS) return undefined;
  const setPlayerIds = [];
  const union = new Set();
  for (const rawList of value.setPlayerIds) {
    if (!Array.isArray(rawList)) return undefined;
    const seenInSet = new Set();
    const list = [];
    for (const id of rawList) {
      if (typeof id !== 'string') return undefined;
      if (seenInSet.has(id)) return undefined;
      if (!directoryIds.has(id)) return undefined;
      seenInSet.add(id);
      union.add(id);
      list.push(id);
    }
    setPlayerIds.push(list);
  }
  if (union.size > MAX_ROSTER_PLAYERS) return undefined;
```

and the return becomes:

```js
  return { gameId: value.gameId, opponent: value.opponent, setCount: value.setCount, setPlayerIds, sets, activeSet: value.activeSet, history };
```

- [ ] **Step 9: Add the schema-2 migration**

`parseSession` currently branches `schema === 2` straight to `parseDay`. Add a schema-2 lift above it. Put this function next to `migrateSchema1`:

```js
/**
 * A schema-2 saved day lifted to schema 3.
 *
 * A schema-2 save carries no set count and one flat tick list per game, because the UI it was
 * written by showed five tabs unconditionally and had no per-set membership to record. So it keeps
 * five tabs, and every set inherits that game's whole list. Deliberately NOT derived from what she
 * happened to have played: shrinking an in-progress day's tabs under her while she is recording is
 * a worse failure than showing two tabs she will not use. A CIQR3. paste for the same date merges
 * real per-set masks in.
 */
function migrateSchema2(day) {
  return {
    ...day,
    games: day.games.map((g) => {
      const { playerIds, ...rest } = g;
      return { ...rest, setCount: MAX_SETS, setPlayerIds: padSetPlayerIds(Array(MAX_SETS).fill(playerIds)) };
    }),
  };
}
```

`parseDay` validates against the *new* shape, so the lift must run on the raw envelope before it — which means `migrateSchema2` above takes the **raw** session, not a parsed day. Write it as the single implementation, defensively (its input is untrusted JSON off a phone):

```js
/**
 * A schema-2 saved day lifted to schema 3, in the raw — `parseDay` validates the schema-3 shape,
 * so the lift has to happen before it, on untrusted JSON. Anything malformed is passed through
 * untouched for `parseDay` to reject in the one place that does rejection.
 *
 * A schema-2 save carries no set count and one flat tick list per game, because the UI that wrote
 * it showed five tabs unconditionally and had no per-set membership to record. So it keeps five
 * tabs, and every set inherits that game's whole list. Deliberately NOT derived from what she
 * happened to have played: shrinking an in-progress day's tabs under her while she is recording is
 * a worse failure than showing two tabs she will not use. A CIQR3. paste for the same date merges
 * real per-set masks in.
 */
function migrateSchema2(session) {
  if (!isPlainObject(session) || !Array.isArray(session.games)) return session;
  return {
    ...session,
    games: session.games.map((g) => {
      if (!isPlainObject(g) || !Array.isArray(g.playerIds)) return g;
      const { playerIds, ...rest } = g;
      return { ...rest, setCount: MAX_SETS, setPlayerIds: Array.from({ length: MAX_SETS }, () => [...playerIds]) };
    }),
  };
}
```

Delete the earlier draft of `migrateSchema2` from Step 9's opening — this is the only version. Then restructure `parseSession`'s legs:

```js
  if (envelope.schema === 3) {
    const result = parseDay(session);
    if (result === undefined) return MALFORMED;
    return { ok: true, value: result.day, dropped: result.dropped };
  }

  if (envelope.schema === 2) {
    // Wrapped because this ships to phones holding a schema-2 save; boot must never throw.
    try {
      const result = parseDay(migrateSchema2(session));
      if (result === undefined) return MALFORMED;
      return { ok: true, value: result.day, dropped: result.dropped };
    } catch {
      return MALFORMED;
    }
  }
```

and widen the envelope guard at the top of `parseSession`:

```js
  if (envelope.schema !== 1 && envelope.schema !== 2 && envelope.schema !== 3) return MALFORMED;
```

- [ ] **Step 10: Update `migrateSchema1`'s game builder**

In `migrateSchema1` (`src/session.js:~695-705`), the games map currently emits `playerIds` and pads `sets` 3 → 5. A schema-1 day came from a three-set UI. Replace that map with:

```js
    // Per-set lists = that game's own players, in every slot: a schema-1 save has no per-set
    // membership either, so the tick lists reproduce exactly what she was recording.
    games: keptGames.map((g) => ({
      gameId: g.gameId,
      opponent: g.opponent,
      setCount: MAX_SETS,
      setPlayerIds: padSetPlayerIds(Array(MAX_SETS).fill(g.players.map((p) => p.id))),
      sets: [...g.sets, null, null], // pad 3 to 5
      activeSet: g.activeSet,
      history: g.history,
    })),
```

Leave every `3` in the schema-1 *parser* (`src/session.js:570`, `595`, `602`) untouched — those describe the legacy save format on disk, not the contract.

- [ ] **Step 11: Run the tests**

Run: `node --test test/session.test.mjs`
Expected: PASS. Fix any pre-existing test in the file that still constructs a v2 roster (`roster: [...]`) or reads `game.playerIds` — those at lines ~34, ~219-244, ~269-294 all need their `roster:` arrays turned into `sets:` masks. `maskOf([0, 1])` is `3`; `maskOf([1])` is `2`; `maskOf([])` is `0`.

- [ ] **Step 12: Commit**

```bash
git add src/session.js test/session.test.mjs
git commit -m "feat: give every set its own tick list and set count

The game record's single playerIds becomes setPlayerIds, one list per set,
plus an explicit setCount from the roster's sets.length. The 12-player cap is
measured as the union across sets, matching the planner's maskCount(union).
Un-ticking is guarded per set. Saved sessions go to schema 3; a schema-2 day
keeps five tabs so an in-progress day on a phone is unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Render `setCount` tabs and a per-set tick list

**Files:**
- Modify: `src/ui.js` — `renderPlayersSheet` (308-347), `onToggleTick` (359-375), `onOpenAddSubFromPlayers` (377-382), `onSubAdd` (668-687), `renderSwitcherSheet` (387-400), `renderRecord` (~535-580), `renderSelfCheckBanner`/menu `Clear Set` label if it reads a stale set
- Test: `test/ui.test.mjs`

**Interfaces:**
- Consumes: `gameSetCount`, `gamePlayerIdsUnion`, `setPlayerTicked(s, gameId, n, playerId, ticked)`, `addSub(s, gameId, n, name, id)` from Task 4.
- Produces: no new exports. The `players` sheet state gains an `n` field: `{ kind: 'players', gameId, n, error }`. The `addSub` sheet state gains `n` likewise.

Match `docs/v3-per-set-mockup.html` for copy and layout.

- [ ] **Step 1: Write the failing tests**

`test/ui.test.mjs` builds a day from a roster fixture at line ~61. Change that fixture to the v3 shape and add:

```js
test('the set bar shows exactly sets.length tabs, per game', () => {
  const day = newDayFromRoster({
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }, { id: 'zoie', name: 'Zoë' }],
    games: [
      { gameId: 'game-1', opponent: 'Lions', sets: [3, 1, 2] },
      { gameId: 'game-2', opponent: 'Falcons', sets: [2, 0] },
    ],
  }, '2026-09-19T09:00:00Z');

  const html1 = renderWith(day, 'game-1');
  assert.equal((html1.match(/data-action="select-set"/g) || []).length, 3);
  assert.match(html1, /data-n="3"/);
  assert.doesNotMatch(html1, /data-n="4"/, 'no phantom fourth tab');

  const html2 = renderWith(day, 'game-2');
  assert.equal((html2.match(/data-action="select-set"/g) || []).length, 2, 'same day, different count');
});

test('each set shows its own rows, and mask 0 offers the sheet rather than an error', () => {
  const day = newDayFromRoster({
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }, { id: 'zoie', name: 'Zoë' }],
    games: [{ gameId: 'game-2', opponent: 'Falcons', sets: [2, 0] }],
  }, '2026-09-19T09:00:00Z');

  const set1 = renderWith(day, 'game-2', 1);
  assert.match(set1, /Zoë/);
  assert.doesNotMatch(set1, /Grace/);

  const set2 = renderWith(day, 'game-2', 2);
  assert.match(set2, /No players ticked for this set yet/);
  assert.doesNotMatch(set2, /malformed|error|Error/);
});

test('the players sheet shows the whole directory, pre-ticked from that set only', () => {
  const day = newDayFromRoster({
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }, { id: 'zoie', name: 'Zoë' }],
    games: [{ gameId: 'game-1', opponent: 'Lions', sets: [3, 1, 2] }],
  }, '2026-09-19T09:00:00Z');

  const sheet = renderPlayersSheetWith(day, 'game-1', 2);
  // Pre-selection, not a whitelist: Zoë is absent from set 2's mask but must still be tickable.
  assert.match(sheet, /Grace/);
  assert.match(sheet, /Zoë/);
  assert.equal((sheet.match(/data-action="toggle-tick"/g) || []).length, 2);
  assert.equal((sheet.match(/checkbox" tabindex="-1" checked/g) || []).length, 1, 'only Grace pre-ticked');
  assert.match(sheet, /Set 2 · tick who is playing this set/);
});
```

`renderWith` / `renderPlayersSheetWith` are helpers over the existing fake-DOM harness in `test/helpers/fake-dom.mjs` — follow whatever pattern the current `test/ui.test.mjs` already uses to drive `render()` and read `document.body.innerHTML`, setting `game.activeSet` and `state.sheet` before rendering.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/ui.test.mjs`
Expected: FAIL — five `select-set` buttons found where three were expected.

- [ ] **Step 3: Build the set tabs from `setCount`**

`src/ui.js:551` — replace the hardcoded array:

```js
  // sets.length, per game, is the one source of truth for how many sets a game has. Hardcoding
  // five showed a coach two tabs the planner never asked for; hardcoding three would hide the
  // later sets of a four- or five-set game.
  const seg = Array.from({ length: game.setCount }, (_, i) => i + 1)
    .map((setN) => `<button type="button" class="${setN === n ? 'on' : ''}" aria-label="Set ${setN}" data-action="select-set" data-n="${setN}">${setN}</button>`)
    .join('');
```

- [ ] **Step 4: Filter the record rows by the active set's list**

In the same function, replace the `ticked`/`players`/`rowsHtml` block:

```js
  const ticked = new Set(game.setPlayerIds[n - 1]);
  // Directory order, stable — never derived from the set's own list order.
  const players = day.players.filter((p) => ticked.has(p.id));
  // A mask of 0 (and so an empty list) is legal — never auto-tick everybody and never treat it as
  // an error; offer the players sheet instead.
  const rowsHtml = players.length === 0
    ? `<div class="rows empty-state"><p>No players ticked for this set yet.</p><button type="button" class="btn primary" data-action="open-players">Tick players…</button></div>`
    : `<div class="rows">${players.map((p) => renderRow(game, n, p)).join('')}</div>`;
```

- [ ] **Step 5: Make the players sheet per-set**

`onOpenPlayers` carries the active set into the sheet state:

```js
function onOpenPlayers() {
  const game = currentGame();
  if (!game) return;
  state.sheet = { kind: 'players', gameId: game.gameId, n: game.activeSet, error: null };
  render();
}
```

In `renderPlayersSheet`, replace the `ticked` line, the per-row `count` hint, the helper line and the footer:

```js
  const n = sheet.n;
  const ticked = new Set(game.setPlayerIds[n - 1]);
```

```js
    const count = setCounts(game, n, p.id);
```

```js
    <p class="helper">${esc(gameLabel(game, i))} · Set ${n} · tick who is playing this set</p>
```

```js
    <div class="tickfoot">
      <span>${ticked.size} of ${day.players.length} in Set ${n}</span>
```

Add `setCounts` next to the existing `totalCounts` helper — the hint must now report counts in *this* set, because that is what the un-tick guard keys on:

```js
/** This player's counts in one set. `totalCounts` (whole game) would mark a row "locked" in a set
 * she has nothing recorded in, when setPlayerTicked would in fact let her off it. */
function setCounts(game, n, playerId) {
  const c = getCount(game, n, playerId);
  return c.serve.in + c.serve.out + c.return.in + c.return.out;
}
```

- [ ] **Step 6: Pass the set number through the tick and sub handlers**

```js
function onToggleTick(pid) {
  const sheet = state.sheet;
  if (!sheet || sheet.kind !== 'players') return;
  const game = state.session.games.find((g) => g.gameId === sheet.gameId);
  if (!game) return;
  const ticked = game.setPlayerIds[sheet.n - 1].includes(pid);
  const result = setPlayerTicked(state.session, sheet.gameId, sheet.n, pid, !ticked);
  if (!result.ok) {
    // Surface as an inline banner in the sheet — never silently revert.
    state.sheet = { ...sheet, error: result.error };
    render();
    return;
  }
  state.sheet = { ...sheet, error: null };
  commit(result.session);
}

function onOpenAddSubFromPlayers() {
  const sheet = state.sheet;
  if (!sheet || sheet.kind !== 'players') return;
  state.sheet = { kind: 'addSub', name: '', error: null, gameId: sheet.gameId, n: sheet.n, returnTo: 'players' };
  render();
}
```

In `onSubAdd`, pass the set through and return to the same set's sheet:

```js
  const result = addSub(state.session, game.gameId, sheet.n, sheet.name || '');
```

```js
  if (sheet.returnTo === 'players') {
    // She has just proved she is picking players — return to the players sheet rather than
    // closing, so the sub she just added is right there to tick.
    state.sheet = { kind: 'players', gameId: game.gameId, n: sheet.n, error: null };
    commit(result.session);
    return;
  }
```

Find every other place that opens an `addSub` sheet (grep `kind: 'addSub'`) and give each an `n`. Where there is no sheet to inherit from, use `currentGame().activeSet`.

- [ ] **Step 7: Update the switcher subtitle**

`src/ui.js:392-393`:

```js
    const played = g.sets.filter(isSetPlayed).length;
    const named = gamePlayerIdsUnion(g).length;
    // "of N sets" because N is real data now — the roster said so, per game.
    const subtitle = `${played} of ${g.setCount} set${g.setCount === 1 ? '' : 's'} · ${named} player${named === 1 ? '' : 's'}`;
```

Add `gamePlayerIdsUnion` to the `./session.js` import line (keep it one line).

- [ ] **Step 8: Guard `activeSet` against a shrinking set count**

A merge can reduce `setCount` below a game's current `activeSet`, leaving the record screen pointed at a tab that no longer renders. Clamp it where the set is read, in the record renderer:

```js
  // A merge may have reduced this game's set count under a coach sitting on a later tab.
  const n = Math.min(game.activeSet, game.setCount);
```

and in `setActiveSet` (`src/session.js`), refuse a set past the count:

```js
export function setActiveSet(s, gameId, n) {
  return withGame(s, gameId, (g) => (n < 1 || n > g.setCount ? g : { ...g, activeSet: n }));
}
```

- [ ] **Step 9: Run the tests**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 10: Commit**

```bash
git add src/ui.js src/session.js test/ui.test.mjs
git commit -m "feat: show sets.length tabs and give each set its own tick list

Every set's tick list shows the whole day directory pre-ticked from that set's
own mask — a pre-selection, not a whitelist, so a coach can still tick someone
the morning's plan left out.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Update the build harnesses, the service worker and the docs

**Files:**
- Modify: `scripts/verify-build.mjs:46-75`
- Modify: `test/harden-app.test.mjs:75-85`
- Modify: `src/sw.js:3`
- Modify: `README.md:5`, `README.md:123`, `README.md:147-161`
- Modify: `src/session.js:9` (`APP_VERSION`)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: a hardened `dist/` bundle whose rendered output matches `dist-dev/`.

- [ ] **Step 1: Move the two harness rosters to the v3 shape**

`scripts/verify-build.mjs:70-71` — replace the `roster:` arrays with `sets:` masks. Four players (indices 0-3) is `maskOf([0,1,2,3]) === 15`; two (0,1) is `3`. Give the two games different set counts so the harness actually exercises the per-game count:

```js
    { gameId: 'verify-1', opponent: OPPONENT, sets: [15, 15, 3] },
    { gameId: SECOND_GAME_ID, opponent: 'Second "FC"', sets: [3, 0] },
```

Bump the payload's `v` to `3` wherever this object sets it, and update the comment at line 46 from `CIQR2.` to `CIQR3.`.

`test/harden-app.test.mjs:79-80` — same treatment:

```js
      { gameId: GAME, opponent: 'Away "FC"', sets: [3] },
      { gameId: GAME2, opponent: 'Second "FC"', sets: [1, 1] },
```

Bump that payload's `v` to `3` too.

- [ ] **Step 2: Run the unit suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Bump the cache name and app version**

`src/sw.js:3`:

```js
const CACHE = 'ciq-stats-v4';
```

`src/session.js:9`:

```js
export const APP_VERSION = '3.0.0';
```

The cache name is this app's only cache-busting mechanism — nothing is content-hashed, so a phone holding the old build keeps serving it until this string changes.

- [ ] **Step 4: Update the README**

Line 5 — `CIQR2…` becomes `CIQR3…`, and note the stats direction is unchanged:

```
Exchanges CIQR3… roster payloads (with per-set membership bitmasks) and CIQS2… stats payloads with the planner by copy and paste, with no server or network required.
```

Line 123 — the cache example becomes `ciq-stats-v3` → `ciq-stats-v4`.

Lines 147-161 — update the reference-file table: `statsContract.ts` and `vectors.ts` now cover "v1, v2 and v3"; add a row for `stats-contract-v3-client-guide.md`; record the planner commit the reference copies came from. Get it with:

```bash
git -C "C:/_src/CoachIQ_Rotation_Planner" rev-parse --short HEAD
```

- [ ] **Step 5: Build and verify**

```bash
npm run build
npm run build:dev
npm run verify
```

Expected: `npm run verify` boots both bundles in headless Edge and reports no render diff. If it cannot find Edge, report that to the user rather than skipping the step — it is the only check that the obfuscated bundle behaves like the readable one, and mask arithmetic surviving obfuscation is exactly the kind of thing it exists to catch.

- [ ] **Step 6: Paste the golden vector into the built app by hand**

Open `dist/CoachIQ_Rotation_Planner_Client.html` in a browser, paste the §8 golden vector from the Global Constraints above, and confirm against `docs/v3-per-set-mockup.html`:

- `vs Lions` shows **three** set tabs; `vs Falcons` shows **two**.
- Lions Set 1 lists Grace and Zoë; Set 2 lists Grace only; Set 3 lists Zoë only.
- Falcons Set 2 shows "No players ticked for this set yet" with no error banner.
- Opening Players on Lions Set 2 shows **both** girls, with only Grace ticked.

- [ ] **Step 7: Commit**

```bash
git add scripts/verify-build.mjs test/harden-app.test.mjs src/sw.js src/session.js README.md dist/ dist-dev/
git commit -m "chore: move build harnesses and docs to contract v3

Cache name bumped so phones pick up the new bundle — nothing is content-hashed,
so the cache key is the only busting mechanism this app has.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Section 9 checklist coverage

| Guide §9 item | Task |
|---|---|
| Stop reading `games[].roster`; read `games[].sets` | 2 (codec), 4 (session) |
| Build `sets.length` tabs per game, not three | 4 (`setCount`), 5 (`seg`) |
| Read every mask with `maskHas`/`maskMembers`, never `\|`/`&` | 2 (helpers ported verbatim; test asserts past bit 30) |
| Whole day directory on every set's tick list, from that set's own mask | 5 (`renderPlayersSheet`) |
| A mask of `0` is "nothing pre-ticked", never an error or a missing set | 2 (validator accepts), 4 (empty list), 5 (empty state) |
| Normalise `CIQR1.`/`CIQR2.` to one set per game | 2 (`normaliseRosterV2`) |
| No changes to the stats encoder | Enforced: Task 3 keeps `runSelfCheck` asserting `CIQS2.` |
| Accept `CIQR3.`, keep accepting `CIQR2.`/`CIQR1.` | 2 (`decodeDayRoster` three-way dispatch) |

## Self-review notes

- **Spec coverage:** every §9 item maps to a task above. §8's golden vector is asserted in Task 1 (byte-exact) and Task 2 (decoded tick lists), and checked by hand in the built app in Task 6. §11's error catalogue is covered in Task 2's `v3 roster catalogue`, including the two strings §11 omits (`has no set list`, `records no sets`) that the reference implementation does emit.
- **Type consistency:** `setPlayerIds` and `setCount` are used under those exact names in Tasks 4, 5 and 6. `setPlayerTicked` and `addSub` take `n` as their third argument everywhere after Task 4. `gamePlayerIdsUnion` returns `string[]`; callers use `.length` and `.includes`.
- **Known deviation from the guide, deliberate:** the guide's §5 rationale (a three-tab Client losing sets 4 and 5) does not describe this app, which hardcodes five. The change is still correct; it is a display-correctness fix, not a data-loss fix. Flagged to the user before planning.
- **Decisions not in the guide**, taken from the reference implementation or from this codebase's existing invariants, all listed in `docs/v3-per-set-mockup.html` §4: union-based 12-cap, per-set un-tick guard, merge never shrinking below recorded data, schema-2 days keeping five tabs.
