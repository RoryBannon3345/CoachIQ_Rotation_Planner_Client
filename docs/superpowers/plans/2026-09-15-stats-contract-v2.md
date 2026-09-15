# Stats Contract v2 — Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **On execution start,** copy this file to `docs/superpowers/plans/2026-09-15-stats-contract-v2.md` in the client repo and work from there.

**Goal:** Make `CoachIQ_Rotation_Planner_Client` speak stats contract **v2** — accept a `CIQR2` day roster (1–8 games, one shared player directory) in a single paste, and emit one `CIQS2` day stats payload covering every game recorded.

**Architecture:** `src/codec.js` is re-ported verbatim from the planner's `src/contract/statsContract.ts` (TypeScript types stripped) — it is a shared file by contract, not a place for local invention. Above it, the session model moves from a flat `games[]` list to a single **day**: `{ date, team, players (directory), games[], activeGameId, lastExportedAt }`. Each game holds a `playerIds` tick-list into the directory rather than its own player array.

**Tech Stack:** Plain ES modules (no framework, no bundler runtime). `node --test` for tests. `scripts/build.mjs` concatenates `codec.js → vectors.js → session.js → ui.js` and strips `export`/`import` with line regexes; `scripts/build-prod.mjs` hardens into `dist/`.

**Spec:** `C:\_src\CoachIQ_Rotation_Planner\docs\stats-contract-v2-client-guide.md` (the change brief written for this app) and `C:\_src\CoachIQ_Rotation_Planner\docs\stats-contract.md` (the settled reference). Both get copied into `reference/` in Task 1.

---

## Context

The planner was updated to contract v2 and this app was not, so it now rejects every roster the coach sends. Reproduced exactly:

```
$ node -e "decodeRoster('CIQR2.eyJ2IjoyLCJraW5kIjoicm9zdGVyIi…fa5639cd')"
{"ok":false,"error":"This payload was made by a newer version of the stats app (contract 2); this app understands 1."}
```

The payload itself is sound — checksum `fa5639cd` verifies, and it decodes to a `{v:2, kind:'roster', date:'2026-09-18', team:'Blizzard'}` day with a 10-player directory (`addison`…`zoie`) and one game `game-mtyg6qub-1-mlcqku` vs `Practice_9_18` pre-selecting `roster:[0..9]`. The refusal comes solely from [src/codec.js:6](src/codec.js#L6) being `CONTRACT_VERSION = 1`. This is the designed v1 behaviour (guide §9: "there is no version of this rollout where the Planner goes out first and the old Client keeps working") — the fix is to ship contract v2 here.

The intended outcome: one roster email in the morning opens the whole day; the coach taps between games between sets without pasting anything; one stats payload goes back at the end of the day.

**Helpfully, this app is already multi-game.** `newSession()` is `{ activeGameId, games: [] }` and the switcher sheet already flips between games live. The work is in *ingest*, the *day directory + tick-list*, a *day-wide export*, and widening 3 sets to 5 — not in building a multi-game container.

**Decisions taken (do not re-litigate):**
1. Sets widen **3 → 5** everywhere (contract `MAX_SETS = 5`).
2. **One day at a time.** Session holds a single day. A roster for a different date prompts to replace.
3. **Migrate** existing schema-1 saves into the day shape rather than quarantining them.
4. The tick-list is a **sheet reached from the ⋯ menu**; the record screen keeps showing only ticked players.

---

## Global Constraints

Values below are copied verbatim from the spec. Every task's requirements implicitly include this section.

- `CONTRACT_VERSION = 2`; `PREFIX = { roster: 'CIQR', stats: 'CIQS' }`.
- `MAX_GAMES_PER_DAY = 8`, `MAX_DAY_PLAYERS = 24`, `MAX_ROSTER_PLAYERS = 12` (now bounds **one game's** tick-list), `MAX_SETS = 5` (**per game**), `MAX_COUNT = 999`, `MAX_NAME_LENGTH = 64`, `MAX_RECORDED_AT_LENGTH = 32`.
- `ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/`; `CLIENT_ID_PATTERN = /^cx-[A-Za-z0-9_-]{4,32}$/`.
- **Every error string is copied verbatim** from the guide's §10 catalogue. A reworded message is a defect, not a style choice. `AUTHOR_LABEL = { roster: 'the Rotation Planner', stats: 'the stats app' }` — but `'This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.'` names the stats app for **both** kinds, deliberately.
- **Contract rule 1:** every game's tick-list shows the **whole day directory**, pre-ticked from that game's `roster` indices. Never hide a directory player.
- **Contract rule 2:** `games[].roster: []` is legal — show the full directory with nothing ticked.
- **Contract rule 3:** a `cx-` id is only for someone **absent from the directory entirely**, never for a directory player this game did not pre-select.
- **`games[].roster` holds indices into the payload's own `players`, not ids.** Do not substitute id strings.
- **Stats never go by `mailto:`** — a day sheet reaches ~13 KB. Clipboard only.
- `String.fromCharCode` in a **loop**, never spread — spread overflows the stack at day-sheet sizes.
- **Every `import` statement must stay on one line** — `scripts/build.mjs` strips them with a line-based regex and silently leaves multi-line imports in the bundle.
- Golden vectors are byte-exact only with the documented **JSON key order**. Build payload object literals in the order the spec prints them.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `reference/*` | Frozen copies of the planner's contract sources | Refresh + add the v2 guide |
| `docs/day-mockup.html` | Visual preview of the new screens | **Create** |
| `src/codec.js` | Transport codec + v1/v2 validators + normalisers. Verbatim port, no local logic | Rewrite |
| `src/vectors.js` | Golden vector data, no imports | Add v2 vectors |
| `src/session.js` | Pure day/game state, storage envelope, day stats builder | Rewrite the model |
| `src/ui.js` | Screens, sheets, action router, persistence glue | Day-aware screens + tick-list sheet |
| `src/styles.css` | 5-tab set bar, tick-list rows | Extend |
| `src/sw.js` | PWA cache | Bump `CACHE` |
| `test/codec.test.mjs` | Codec + catalogue | Extend |
| `test/session.test.mjs` | State model + export | Rewrite assertions |
| `test/harden-app.test.mjs` | Plain-vs-obfuscated parity | Rename called functions |
| `scripts/verify-build.mjs` | Headless DOM smoke test | Paste a v2 roster |

---

## Task 1: Refresh `reference/` and mock up the new screens

The `reference/` copies are stale (planner commit `2c57064`, contract v1). Everything downstream is a port *from* these files, so they land first. Per the global CLAUDE.md rule, the UI mockup precedes implementation.

**Files:**
- Modify: `reference/stats-contract.md`, `reference/statsContract.ts`, `reference/vectors.ts`
- Create: `reference/stats-contract-v2-client-guide.md`, `docs/day-mockup.html`

- [ ] **Step 1: Copy the four planner sources in**

```bash
cd /c/_src/CoachIQ_Rotation_Planner_Client
P=/c/_src/CoachIQ_Rotation_Planner
cp "$P/docs/stats-contract.md"                     reference/stats-contract.md
cp "$P/docs/stats-contract-v2-client-guide.md"     reference/stats-contract-v2-client-guide.md
cp "$P/src/contract/statsContract.ts"              reference/statsContract.ts
cp "$P/src/contract/__fixtures__/vectors.ts"       reference/vectors.ts
grep -c "validateDayRosterPayload" reference/statsContract.ts   # expect >= 1
```

- [ ] **Step 2: Build `docs/day-mockup.html`**

A single static HTML file, styled from `src/styles.css`, showing side by side (no JS behaviour needed beyond tab switching):
1. **Paste screen** — "Open the day", helper "Paste the day roster copied from CoachIQ Rotation Planner".
2. **Record screen** — topbar `Games ▾ | Blizzard / vs Practice_9_18 · 18 Sep | ⋯`; set bar `[1][2][3][4][5]` + score button, at 320px width; 10 player rows.
3. **Players sheet** (the tick-list) — heading `Players — vs Practice_9_18`, the whole 10-name directory as checkbox rows with 44px targets, ticked per the pre-selection, a `+ Add a sub…` row, a `Done` button, and a footer count `10 of 12`.
4. **Switcher sheet** — day header `Blizzard · 18 Sep · exported 21:04`, one row per game with `N sets`, and `Paste a new day roster…` at the foot.
5. **Replace-day confirm sheet** — "Open a different day?" naming both dates and warning when the current day has unexported stats.
6. **Export screen** — day summary line `Blizzard · 18 Sep · 2 games · 5 sets · 10 players`.

- [ ] **Step 3: Open it for review**

```bash
start "" "C:\_src\CoachIQ_Rotation_Planner_Client\docs\day-mockup.html"
```

Stop here and get the mockup approved before Task 2.

- [ ] **Step 4: Commit**

```bash
git add reference docs/day-mockup.html
git commit -m "docs: refresh contract reference to v2 and mock up the day screens"
```

---

## Task 2: Port `src/codec.js` to contract v2

The header comment already says *"Do not edit; re-copy from those sources if the contract changes."* Do exactly that: port `reference/statsContract.ts` with TypeScript syntax stripped. Do not invent, reword or regularise anything.

**Files:**
- Modify: `src/codec.js`
- Test: `test/codec.test.mjs`

**Interfaces — Produces:**
```js
// constants
CONTRACT_VERSION=2, PREFIX, KIND_LABEL, AUTHOR_LABEL,
MAX_GAMES_PER_DAY=8, MAX_DAY_PLAYERS=24, MAX_ROSTER_PLAYERS=12,
MAX_SETS=5, MAX_COUNT=999, MAX_NAME_LENGTH=64, MAX_RECORDED_AT_LENGTH=32,
ID_PATTERN, CLIENT_ID_PATTERN
// transport
fnv1a32(bytes) -> string
toBase64Url(bytes) -> string
fromBase64Url(text) -> Uint8Array|null
encodePayload(kind, json, version = CONTRACT_VERSION) -> string
encodeDayRoster(p) / encodeDayStats(p)        // no version arg
encodeRoster(p) / encodeStats(p)              // pass 1 explicitly
decodePayload(text, expected) -> {ok:true,value}|{ok:false,error}
// shape
validateRosterPayload(v) / validateStatsPayload(v)          // v1, still live
validateDayRosterPayload(v) / validateDayStatsPayload(v)    // v2
normaliseRosterV1(p) / normaliseStatsV1(p) -> day payload
decodeDayRoster(text) / decodeDayStats(text) -> always a DAY payload
```
`decodeRoster` / `decodeStats` are **removed** — `decodeDayRoster` / `decodeDayStats` replace them so nothing downstream branches on `v`.

- [ ] **Step 1: Write the failing tests**

Append to `test/codec.test.mjs`:

```js
import { decodeDayRoster, decodeDayStats, encodeDayRoster, encodeDayStats, encodeRoster, encodeStats, encodePayload, CONTRACT_VERSION, MAX_SETS, MAX_DAY_PLAYERS, MAX_GAMES_PER_DAY } from '../src/codec.js';
import { DAY_ROSTER_VECTOR, DAY_STATS_VECTOR, ROSTER_VECTOR, STATS_VECTOR } from '../src/vectors.js';

test('contract version is 2', () => { assert.equal(CONTRACT_VERSION, 2); assert.equal(MAX_SETS, 5); assert.equal(MAX_DAY_PLAYERS, 24); assert.equal(MAX_GAMES_PER_DAY, 8); });

test('v2 golden vectors round-trip byte-exactly', () => {
  assert.equal(encodeDayRoster(DAY_ROSTER_VECTOR.payload), DAY_ROSTER_VECTOR.encoded);
  assert.equal(encodeDayStats(DAY_STATS_VECTOR.payload), DAY_STATS_VECTOR.encoded);
  assert.deepEqual(decodeDayRoster(DAY_ROSTER_VECTOR.encoded).value, DAY_ROSTER_VECTOR.payload);
  assert.deepEqual(decodeDayStats(DAY_STATS_VECTOR.encoded).value, DAY_STATS_VECTOR.payload);
});

test('the real planner payload decodes as a one-game day', () => {
  const r = decodeDayRoster('CIQR2.eyJ2IjoyLCJraW5kIjoicm9zdGVyIiwiZGF0ZSI6IjIwMjYtMDktMTgiLCJ0ZWFtIjoiQmxpenphcmQiLCJwbGF5ZXJzIjpbeyJpZCI6ImFkZGlzb24iLCJuYW1lIjoiQWRkaXNvbiJ9LHsiaWQiOiJicm9va2x5biIsIm5hbWUiOiJCcm9va2x5biJ9LHsiaWQiOiJicnlubiIsIm5hbWUiOiJCcnlubiJ9LHsiaWQiOiJlbWlseSIsIm5hbWUiOiJFbWlseSJ9LHsiaWQiOiJncmFjZSIsIm5hbWUiOiJHcmFjZSJ9LHsiaWQiOiJoYWlsZXkiLCJuYW1lIjoiSGFpbGV5In0seyJpZCI6ImxleGkiLCJuYW1lIjoiTGV4aSJ9LHsiaWQiOiJsaWx5IiwibmFtZSI6IkxpbHkifSx7ImlkIjoibWVsYW5pZSIsIm5hbWUiOiJNZWxhbmllIn0seyJpZCI6InpvaWUiLCJuYW1lIjoiWm9pZSJ9XSwiZ2FtZXMiOlt7ImdhbWVJZCI6ImdhbWUtbXR5ZzZxdWItMS1tbGNxa3UiLCJvcHBvbmVudCI6IlByYWN0aWNlXzlfMTgiLCJyb3N0ZXIiOlswLDEsMiwzLDQsNSw2LDcsOCw5XX1dfQ.fa5639cd');
  assert.ok(r.ok, r.error);
  assert.equal(r.value.date, '2026-09-18');
  assert.equal(r.value.team, 'Blizzard');
  assert.equal(r.value.players.length, 10);
  assert.deepEqual(r.value.games[0].roster, [0,1,2,3,4,5,6,7,8,9]);
});

test('a v1 roster normalises into a one-game day', () => {
  const r = decodeDayRoster(ROSTER_VECTOR.encoded);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { v: 2, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: ROSTER_VECTOR.payload.players,
    games: [{ gameId: 'game-1', opponent: 'Lions', roster: [0, 1] }] });
});

test('a v1 stats sheet normalises into a one-game day', () => {
  const r = decodeDayStats(STATS_VECTOR.encoded);
  assert.ok(r.ok);
  assert.equal(r.value.v, 2);
  assert.deepEqual(r.value.games, [{ gameId: 'game-1', sets: STATS_VECTOR.payload.sets }]);
});

test('transport errors name the authoring app per kind', () => {
  const bad = 'CIQR3.QQ.00000000';
  assert.equal(decodeDayRoster(bad).error,
    'This payload was made by a newer version of the Rotation Planner (contract 3); this app understands 2.');
  assert.equal(decodeDayStats('CIQS3.QQ.00000000').error,
    'This payload was made by a newer version of the stats app (contract 3); this app understands 2.');
  assert.equal(decodeDayRoster('CIQR2.QQ.00000000').error,
    'This payload is corrupted or incomplete — copy it again from the Rotation Planner.');
  assert.equal(decodeDayStats('CIQS2.QQ.00000000').error,
    'This payload is corrupted or incomplete — copy it again from the stats app.');
  assert.equal(decodeDayRoster('nonsense').error,
    'This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.');
});

test('an array body is corruption, not a payload', () => {
  const t = encodePayload('roster', [], 2);
  assert.equal(decodeDayRoster(t).error, 'This payload is corrupted or incomplete — copy it again from the Rotation Planner.');
});

test('v2 roster shape catalogue', () => {
  const enc = (p) => encodeDayRoster(p);
  const base = { v: 2, kind: 'roster', date: '2026-09-19', team: 'T', players: [{ id: 'a', name: 'A' }], games: [{ gameId: 'g', opponent: 'O', roster: [0] }] };
  assert.equal(decodeDayRoster(enc({ ...base, date: '' })).error, 'The roster payload is malformed: it has no date.');
  assert.equal(decodeDayRoster(enc({ ...base, games: [] })).error, 'The roster payload is malformed: it names no games.');
  assert.equal(decodeDayRoster(enc({ ...base, games: [{ gameId: 'g', opponent: 'O', roster: [1] }] })).error,
    'The roster payload is malformed: game "g" names player 1, but the payload lists only 1.');
  assert.equal(decodeDayRoster(enc({ ...base, games: [{ gameId: 'g', opponent: 'O', roster: [-1] }] })).error,
    'The roster payload is malformed: game "g" has a malformed player reference.');
  assert.equal(decodeDayRoster(enc({ ...base, games: [{ gameId: 'g', opponent: 'O', roster: [0, 0] }] })).error,
    'The roster payload is malformed: game "g" names player 0 twice.');
  // rule 2: an empty pre-selection is legal
  assert.ok(decodeDayRoster(enc({ ...base, games: [{ gameId: 'g', opponent: '', roster: [] }] })).ok);
});

test('v1 tightenings', () => {
  const s = (p) => decodeDayStats(encodeStats(p));
  const base = { v: 1, kind: 'stats', gameId: 'g', recordedAt: '2026-09-19T21:04:00Z',
    players: [{ id: 'a', name: 'A' }],
    sets: [{ n: 1, score: null, players: [] }] };
  assert.equal(s({ ...base, recordedAt: '' }).error, 'The stats payload is malformed: it has no recorded time.');
  assert.equal(s({ ...base, players: [] }).error, 'The stats payload is malformed: it names no players.');
  assert.equal(s({ ...base, sets: [{ n: 6, score: null, players: [] }] }).error,
    'The stats payload is malformed: set number "6" is not between 1 and 5.');
  // a 5-set v1 sheet is now legal
  assert.ok(s({ ...base, sets: [1,2,3,4,5].map((n) => ({ n, score: null, players: [] })) }).ok);
  assert.equal(decodeDayRoster(encodeRoster({ v: 1, kind: 'roster', gameId: 'g', team: 'T', opponent: 'O', date: '', players: [{ id: 'a', name: 'A' }] })).error,
    'The roster payload is malformed: it has no date.');
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npm test 2>&1 | head -40
```
Expected: import errors for `decodeDayRoster` / `DAY_ROSTER_VECTOR`.

- [ ] **Step 3: Rewrite `src/codec.js`**

Port from `reference/statsContract.ts`, stripping types. Specifically:

*Header* — update the provenance comment to name `reference/stats-contract-v2-client-guide.md` and `reference/statsContract.ts` with the current planner commit hash.

*New / changed constants* — add `MAX_GAMES_PER_DAY = 8`, `MAX_DAY_PLAYERS = 24`, `MAX_RECORDED_AT_LENGTH = 32`, `MAX_SETS = 5`; set `CONTRACT_VERSION = 2`; add `AUTHOR_LABEL = { roster: 'the Rotation Planner', stats: 'the stats app' }` and `function corrupt(expected)`.

*`decodePayload`* — three changes only: delete the local `kindLabel` literal at line 45 and use the exported `KIND_LABEL`; key the newer-version and corruption messages off `AUTHOR_LABEL[expected]` via `corrupt()`; add `Array.isArray(parsed)` to the step-7 guard. Everything else — the whitespace strip, the order of checks, the regexes — is unchanged.

*`encodePayload`* — gains the third parameter `version = CONTRACT_VERSION`. `encodeRoster` / `encodeStats` must now pass `1` **explicitly**; `encodeDayRoster` / `encodeDayStats` pass nothing.

*v1 validators, four tightenings* (all still emitting v1 wording):
- `validateRosterPayload`: `date` must be a non-empty string → `it has no date`.
- `validateStatsPayload`: `recordedAt` non-empty → `it has no recorded time`; and `> MAX_RECORDED_AT_LENGTH` → `its recorded time is <n> characters; the limit is 32`.
- `validateStatsPayload`: empty `players` → `it names no players`.
- `validateStatsPayload`: the hard-coded `3` at line 198 and the `n !== 1 && n !== 2 && n !== 3` at line 205 become `MAX_SETS`, with the messages `it records more than 5 sets` and `set number "<n>" is not between 1 and 5`.
- `parseScore` must require `Number.isFinite` on both entries.

*New v2 functions* — `parseDayPlayerList(value, kind)` (shared by both kinds), `validateDayRosterPayload`, `validateDayStatsPayload`, `normaliseRosterV1`, `normaliseStatsV1`, `decodeDayRoster`, `decodeDayStats`. Copy the message strings character for character from §10 of the guide; the three deliberate irregularities are `the day limit is 24` vs `the limit is 12`, `names <n> games; the limit is 8` (roster) vs `records more than 8 games` (stats), and `its version is not 1 or 2` at v2 vs `its version is not 1` at v1.

- [ ] **Step 4: Run the codec tests**

```bash
node --test test/codec.test.mjs
```
Expected: PASS. (`test/session.test.mjs` will still be failing — Task 4 fixes it.)

- [ ] **Step 5: Commit**

```bash
git add src/codec.js test/codec.test.mjs
git commit -m "feat(codec): port stats contract v2 — day payloads, author labels, 5 sets"
```

---

## Task 3: Add the v2 golden vectors

**Files:**
- Modify: `src/vectors.js`
- Test: covered by Task 2's tests

**Interfaces — Produces:** `DAY_ROSTER_VECTOR`, `DAY_STATS_VECTOR`, each `{ payload, encoded }`. `ROSTER_VECTOR` / `STATS_VECTOR` stay **frozen and byte-identical**.

- [ ] **Step 1: Append the two v2 vectors**

Payload literals must be built in the key order the guide §8 prints, or the encoded strings will not match. Expected encodings are `CIQR2.…7b1e1d96` and `CIQS2.…0342dd9e` — copy both verbatim from guide §8.

```js
const DAY_ROSTER_PAYLOAD = {
  v: 2, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
  games: [
    { gameId: 'game-1', opponent: 'Lions', roster: [0, 1] },
    { gameId: 'game-2', opponent: 'Falcons', roster: [1] },
  ],
};

// Note game-2's sets starting again at n: 1 — set numbers are scoped to a game, never to a day.
const DAY_STATS_PAYLOAD = {
  v: 2, kind: 'stats', recordedAt: '2026-09-19T21:04:00Z',
  players: [{ id: 'grace', name: 'Grace' }, { id: 'cx-8f2k1q', name: 'Ava' }],
  games: [
    { gameId: 'game-1', sets: [
      { n: 1, score: [25, 21], players: [
        { id: 'grace', serve: { in: 8, out: 2 }, return: { in: 5, out: 1 } },
        { id: 'cx-8f2k1q', serve: { in: 0, out: 0 }, return: { in: 3, out: 0 } },
      ] },
      { n: 2, score: null, players: [
        { id: 'grace', serve: { in: 4, out: 1 }, return: { in: 2, out: 2 } },
      ] },
    ] },
    { gameId: 'game-2', sets: [
      { n: 1, score: [25, 18], players: [
        { id: 'cx-8f2k1q', serve: { in: 6, out: 1 }, return: { in: 2, out: 0 } },
      ] },
    ] },
  ],
};

export const DAY_ROSTER_VECTOR = { payload: DAY_ROSTER_PAYLOAD, encoded: 'CIQR2.…7b1e1d96' }; // full string: guide §8
export const DAY_STATS_VECTOR  = { payload: DAY_STATS_PAYLOAD,  encoded: 'CIQS2.…0342dd9e' }; // full string: guide §8
```

- [ ] **Step 2: Verify byte-exactness**

```bash
node --test test/codec.test.mjs
```
Expected: the `v2 golden vectors round-trip byte-exactly` test PASSES. If it fails, the key order in the literal is wrong — fix the literal, never the expected string.

- [ ] **Step 3: Commit**

```bash
git add src/vectors.js && git commit -m "test: add the contract v2 golden vectors"
```

---

## Task 4: Rebuild `src/session.js` around a single day

The largest task. `sets` goes to 5 slots, `players` moves from the game up to the day, and each game gains a `playerIds` tick-list.

**Files:**
- Modify: `src/session.js`
- Test: `test/session.test.mjs`

**Interfaces — Consumes:** everything Task 2 produces.
**Interfaces — Produces:**

```js
SESSION_SCHEMA = 2; APP_VERSION = '2.0.0';
newSession()                                   -> { day: null }
newDayFromRoster(roster, nowIso)               -> Day
openDayRoster(s, roster, nowIso)               -> {kind:'opened',session} | {kind:'sameDay',day} | {kind:'otherDay',day,hasUnexported}
mergeDayRoster(s, roster, nowIso)              -> {ok:true,session} | {ok:false,error}
replaceDay(s, roster, nowIso)                  -> {ok:true,session}
dayPlayer(day, playerId)                       -> {id,name,sub} | undefined
gamePlayers(day, game)                         -> [{id,name,sub}]   // directory order, ticked only
setPlayerTicked(s, gameId, playerId, ticked)   -> {ok:true,session} | {ok:false,error}
addDayPlayer(s, gameId, name, id?)             -> {ok:true,session} | {ok:false,error}
gameLabel(day, game)                           -> `vs ${game.opponent} · ${formatDate(day.date)}`   // SIGNATURE CHANGED
setActiveGame(s, gameId) / deleteGame(s, gameId)          // same names, now reaching through s.day
setActiveSet / tap / undo / setScore / clearSet           // unchanged signatures, 5 slots
buildDayStatsPayload(day, nowIso)              -> {ok:true,value:{text,summary,payload}} | {ok:false,error}
parseSession(text)                             -> {ok:true,value,dropped} | {ok:false,error}
```

`newGameFromRoster`, `openRoster`, `updateRoster`, `addSub`, `buildStatsPayload` are **removed**.

**Two signature changes that will not fail loudly.** `gameLabel` takes `(day, game)` — its three `ui.js` call sites (`:160`, `:395`, `:560`) each need the day threaded in. And `firstName(game, playerId)` at `ui.js:34` reads `game.players`, which no longer exists; it becomes `firstName(day, playerId)` reading the directory. Both produce `undefined`/`""` rather than an exception, so they show up as a blank undo label or a blank sheet title, not a crash.

`deleteGame` keeps its name but must now refuse to delete the **last** game of a day — a day with no games is not a day (`games` is 1–8). Return `{ok:false, error:'This is the only game of the day. Paste a new day roster instead.'}`.

**The day shape:**

```js
{
  date: '2026-09-18',          // identity of the day
  team: 'Blizzard',            // may be ''
  importedAt: ISO,
  players: [{ id, name, sub }],// the DAY DIRECTORY, <= MAX_DAY_PLAYERS; sub:true = added on the day
  games: [{                    // <= MAX_GAMES_PER_DAY
    gameId, opponent,
    playerIds: [id, …],        // the tick-list, <= MAX_ROSTER_PLAYERS, directory order
    sets: [null, null, null, null, null],   // MAX_SETS slots, index n-1
    activeSet: 1,              // 1..MAX_SETS
    history: [],
  }],
  activeGameId,
  lastExportedAt: null,        // DAY-level: the export is the day
}
```

- [ ] **Step 1: Write the failing tests**

Rewrite `test/session.test.mjs` against `DAY_ROSTER_VECTOR.payload` (two games, `game-2` pre-selecting index `1` only — deliberately *not* everybody). Keep the existing tap/clamp/undo/history tests unchanged apart from the new call signatures, and add:

```js
test('one paste opens the whole day with per-game pre-selections', () => {
  const r = openDayRoster(newSession(), DAY_ROSTER_VECTOR.payload, ISO);
  assert.equal(r.kind, 'opened');
  const day = r.session.day;
  assert.equal(day.date, '2026-09-19');
  assert.deepEqual(day.players.map((p) => p.id), ['grace', 'zoie']);
  assert.deepEqual(day.games.map((g) => g.playerIds), [['grace', 'zoie'], ['zoie']]);
  assert.equal(day.games[0].sets.length, 5);
  assert.equal(day.activeGameId, 'game-1');
});

test('the tick-list shows the whole directory, not just the pre-selection', () => {
  // contract rule 1 — gamePlayers() filters, but the directory is intact for the UI to list
  const day = openDayRoster(newSession(), DAY_ROSTER_VECTOR.payload, ISO).session.day;
  assert.equal(day.players.length, 2);
  assert.deepEqual(gamePlayers(day, day.games[1]).map((p) => p.id), ['zoie']);
});

test('an empty pre-selection is legal and ticks nobody', () => {
  const roster = { ...DAY_ROSTER_VECTOR.payload, games: [{ gameId: 'g', opponent: '', roster: [] }] };
  const day = openDayRoster(newSession(), roster, ISO).session.day;
  assert.deepEqual(day.games[0].playerIds, []);
  assert.equal(day.players.length, 2);          // the directory is still whole
});

test('ticking respects the 12-player game cap', () => {
  // a 13th tick on a game already holding 12
  const r = setPlayerTicked(full12, 'game-1', 'zoie', true);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'This game already has 12 players; the stats app limit is 12.');
});

test('addDayPlayer respects the 24-player day cap', () => {
  const r = addDayPlayer(full24, 'game-1', 'Ava');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'The day already has 24 players; the stats app limit is 24.');
});

test('unticking a player who has counts in this game is refused', () => {
  const s = tap(opened, 'game-1', 1, 'grace', 'serve', 'in', 1);
  const r = setPlayerTicked(s, 'game-1', 'grace', false);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Grace has counts in this game — clear them first.');
});

test('unticking a player with no counts just removes her from this game', () => {
  const r = setPlayerTicked(opened, 'game-1', 'zoie', false);
  assert.ok(r.ok);
  assert.deepEqual(r.session.day.games[0].playerIds, ['grace']);
  assert.equal(r.session.day.players.length, 2);   // she stays in the directory
});

test('addDayPlayer mints a cx- id, joins the directory and ticks into this game', () => {
  const r = addDayPlayer(opened, 'game-1', '  Ava  ');
  assert.ok(r.ok);
  const day = r.session.day;
  const added = day.players[day.players.length - 1];
  assert.match(added.id, /^cx-[A-Za-z0-9]{8}$/);
  assert.equal(added.name, 'Ava');               // trimmed
  assert.equal(added.sub, true);
  assert.ok(day.games[0].playerIds.includes(added.id));
  assert.ok(!day.games[1].playerIds.includes(added.id));  // this game only
});

test('addDayPlayer rejects an empty or over-long name', () => {
  assert.equal(addDayPlayer(opened, 'game-1', '   ').error, 'Enter a name.');
  assert.equal(addDayPlayer(opened, 'game-1', 'x'.repeat(65)).error, 'That name is 65 characters; the limit is 64.');
});

test('buildDayStatsPayload emits one CIQS2 for every game with a played set', () => {
  // drive the DAY_STATS_VECTOR transcript and assert byte-equality with DAY_STATS_VECTOR.encoded
  assert.equal(built.value.text, DAY_STATS_VECTOR.encoded);
});

test('a game with no played set is omitted; no game at all refuses', () => {
  assert.equal(buildDayStatsPayload(emptyDay, ISO).error, 'Nothing recorded yet — tap a count or enter a score first.');
});

test('a schema-1 save migrates into a day', () => {
  const old = JSON.stringify({ schema: 1, savedAt: ISO, session: { activeGameId: 'g1', games: [ /* two 2026-09-18 games, 3-slot sets */ ] } });
  const p = parseSession(old);
  assert.ok(p.ok);
  assert.equal(p.value.day.date, '2026-09-18');
  assert.equal(p.value.day.games.length, 2);
  assert.equal(p.value.day.games[0].sets.length, 5);           // padded 3 -> 5
  assert.deepEqual(p.value.day.players.map((x) => x.id), [/* union, first-seen order */]);
});

test('a schema-1 save spanning two dates keeps the active game\'s day and drops the rest', () => {
  assert.equal(p.dropped, 1);
});
```

**Delete** the two assertions that pin the old set model — `test/session.test.mjs:132-139` currently requires `sets.slice(0,2)` and `activeSet = 4` to be rejected. Replace with `sets.slice(0,4)` rejected and `activeSet = 6` rejected.

- [ ] **Step 2: Run and watch them fail**

```bash
node --test test/session.test.mjs 2>&1 | head -30
```

- [ ] **Step 3: Implement the day model**

Notes on the parts that are not mechanical:

*Index resolution.* `newDayFromRoster` maps `games[].roster` indices through the payload's own `players` exactly once, at ingest:
```js
playerIds: g.roster.map((i) => roster.players[i].id)
```
Validation has already proved every index is in range, so no bounds check is needed here — but do not re-derive ids anywhere else.

*Same-date re-paste* (`mergeDayRoster`) — the analogue of today's `updateRoster`:
- Directory = roster entries (names refreshed, `sub:false`) **+** existing players who are `sub` or hold any count in any game. Over 24 → `Updating would make <n> players; the stats app day limit is 24.`
- A game already present keeps **its own** `playerIds` (filtered to the surviving directory) and all its sets/history — once she is recording, her ticks are ground truth and re-pasting exists to add games and fix names. A **new** game takes its pre-selection from the payload.
- A local game absent from the new roster is kept if any of its sets is played, otherwise dropped. Over 8 games → `Updating would make <n> games; the stats app limit is 8.`

*Different-date paste* is never silent: `openDayRoster` returns `{kind:'otherDay', hasUnexported}` and the UI confirms (Task 5). `hasUnexported` is `day.lastExportedAt === null && day.games.some(g => g.sets.some(isSetPlayed))`.

*Cap messages* (new strings, this app's own voice — they are not contract strings):
- `This game already has 12 players; the stats app limit is 12.`
- `The day already has 24 players; the stats app limit is 24.`
- `<Name> has counts in this game — clear them first.`

*`buildDayStatsPayload`* — build the literal in contract key order:
```js
const payload = {
  v: 2, kind: 'stats', recordedAt: nowIso,
  players: day.players.map((p) => ({ id: p.id, name: p.name })),   // the whole directory
  games,                                                            // played games only
};
```
Per-game sets reuse today's rules verbatim: omit a set where `!isSetPlayed`, omit an all-zero player line, `n` is the 1-based slot index, and iterate `gamePlayers(day, game)` so ordering is stable. Finish with `validateDayStatsPayload(payload)` and return `encodeDayStats`. Summary: `` `${day.team} · ${formatDate(day.date)} · ${nGames} game(s) · ${nSets} set(s) · ${nPlayers} player(s)` ``.

*Migration.* `parseSession` reads `envelope.schema` first: `2` parses the day shape; `1` parses the old `games[]` via a retained `parseGameV1` and then migrates; anything else is `MALFORMED`. Migration picks **one** day — the one containing `activeGameId`, else the lexicographically greatest `date` — builds the directory as the ordered union of that day's games' players (first name wins, `sub` OR-ed), sets `team` from the first game, `playerIds` from each game's own players, pads each `sets` array from 3 to 5 with `null`, and sets `lastExportedAt` to the greatest of the games'. Every game not in the chosen day counts into `dropped`, which makes the existing amber banner in `ui.js:83-88` fire with no change.

*`parseHistoryEntry`* — `value.n` becomes `Number.isInteger(n) && n >= 1 && n <= MAX_SETS`.
*`parseGame`* — `sets.length !== MAX_SETS`, `activeSet` in `1..MAX_SETS`, `playerIds` an array of ≤12 strings each present in the directory.
*`runSelfCheck`* — line 394 currently calls `encodePayload('roster', ROSTER_VECTOR.payload)`, which under `CONTRACT_VERSION = 2` would emit `CIQR2.` around a `"v":1` body and fail its own decode. It must call `encodeRoster` / `encodeStats` (explicit `1`) for the v1 vectors, `encodeDayRoster` / `encodeDayStats` for the v2 ones, and compare the v1 **decodes** against the *normalised* day shape, not the v1 payload.

- [ ] **Step 4: Run the tests**

```bash
node --test test/session.test.mjs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session.js test/session.test.mjs
git commit -m "feat(session): hold one day of games with a shared directory and 5 sets"
```

---

## Task 5: Day-aware screens in `src/ui.js`

**Files:**
- Modify: `src/ui.js`
- Test: exercised by Task 7's headless run

**Interfaces — Consumes:** Task 4's exports. **Produces:** new `data-action` values `open-players`, `toggle-player`, `players-add-sub`, `players-done`, `confirm-replace-day`, `day-exists-open`, `day-exists-update`, `paste-new-day`.

- [ ] **Step 1: Rewire imports and the day accessors**

Both import lines must stay **one line each** — the build's stripper is line-based.
```js
function currentDay() { return state.session.day; }
function currentGame() { const d = currentDay(); return d ? d.games.find((g) => g.gameId === d.activeGameId) || null : null; }
```
`gameLabel(day, game)` now takes both. `renderPaste`'s `showCancel` becomes `state.session.day !== null`.

- [ ] **Step 2: Rewrite `onOpenRoster` for the three-way ingest**

```js
const decoded = decodeDayRoster(text);          // was decodeRoster
…
const result = openDayRoster(state.session, decoded.value, new Date().toISOString());
if (result.kind === 'opened') { state.pasteText=''; state.screen='record'; return commit(result.session); }
if (result.kind === 'sameDay')  { state.sheet = { kind:'dayExists',  day: result.day, roster: decoded.value }; return render(); }
state.sheet = { kind:'replaceDay', day: result.day, roster: decoded.value, hasUnexported: result.hasUnexported };
render();
```

- [ ] **Step 3: Add the two day sheets**

`renderDayExistsSheet` — heading *"This day is already open"*, body naming the date and the count of games/sets recorded, buttons **Open it** / **Update the day** / Cancel. Mirrors the existing `gameExists` sheet at `ui.js:159-174`; reuse `renderGameExistsErrorSheet` for a failed merge.

`renderReplaceDaySheet` — heading *"Open a different day?"*, body naming both dates, and when `hasUnexported` an `.banner.err` reading *"18 Sep has stats you have not exported yet. They will be lost."*; buttons **Replace the day** (danger) / Cancel.

Their handlers:
```js
function onDayExistsOpen()   { state.sheet = null; state.screen = 'record'; render(); }
function onDayExistsUpdate() {
  const { roster } = state.sheet;
  const result = mergeDayRoster(state.session, roster, new Date().toISOString());
  if (!result.ok) { state.sheet = { kind: 'gameExistsError', message: result.error }; return render(); }
  state.sheet = null; state.screen = 'record'; commit(result.session);
}
function onConfirmReplaceDay() {
  const { roster } = state.sheet;
  const result = replaceDay(state.session, roster, new Date().toISOString());
  state.sheet = null; state.pasteText = ''; state.screen = 'record'; commit(result.session);
}
```

- [ ] **Step 4: Add the Players tick-list sheet**

This is the contract's rule 1 made visible — it lists **every** directory player, ticked or not.

```js
function renderPlayersSheet() {
  const day = currentDay(), game = currentGame();
  const ticked = new Set(game.playerIds);
  const rows = day.players.map((p) => `
    <li>
      <label class="tick">
        <input type="checkbox" data-action="toggle-player" data-pid="${esc(p.id)}" ${ticked.has(p.id) ? 'checked' : ''}>
        <span class="tname">${esc(p.name)}${p.sub ? ' <span class="gchip">Sub</span>' : ''}</span>
      </label>
    </li>`).join('');
  // + an "Add a sub…" row, an inline error slot, and a "N of 12" footer
}
```
- Tapping a checkbox calls `setPlayerTicked`; on `{ok:false}` re-render with `state.sheet.error = result.error` and leave the box as the model says (the full re-render restores it).
- `+ Add a sub…` reveals the existing `#subName` input inline and routes to `addDayPlayer`. Snapshot `#subName` in `runAction` the same way the `addSub` sheet does today (`ui.js:670-673`).
- Because `render()` replaces the whole DOM, add `.sheet` scroll preservation — it already exists at `ui.js:715-747`; confirm the tick-list uses class `.sheet` so it is covered.

- [ ] **Step 5: Update the record screen, menu and switcher**

- `renderRecord` rows: `gamePlayers(day, game).map((p) => renderRow(game, n, p))`.
- Set bar: `[1,2,3,4,5]` with the **numeral alone** as the label (not `Set 5`) so five tabs fit at 320px: `` `<button … data-n="${setN}" aria-label="Set ${setN}">${setN}</button>` ``.
- Topbar title group: team on the muted line, `vs ${opponent} · ${formatDate(day.date)}` on the main line.
- Menu: replace `Add a sub…` with **`Players…`** (`data-action="open-players"`); keep `Clear Set n…` and `Delete game…`. The old `addSub` sheet and its `menu-add-sub` action are removed — subs are added from inside the Players sheet.
- Switcher: add a day header line `${team} · ${formatDate(date)}${lastExportedAt ? ` · exported ${formatTime(...)}` : ''}`; per-game rows lose the per-game `exported` suffix (export is day-wide now); the footer button becomes **`Paste a new day roster…`** (`data-action="paste-new-day"`). Adding a single ad-hoc game is **out of scope** — a locally minted `gameId` would match nothing on import.

- [ ] **Step 6: Make Export day-wide**

```js
function onExport() {
  const day = currentDay(); if (!day) return;
  const nowIso = new Date().toISOString();
  const result = buildDayStatsPayload(day, nowIso);
  if (!result.ok) { state.banner = { kind:'err', text: result.error, dismissible:true }; return render(); }
  const decoded = decodeDayStats(result.value.text);
  console.assert(decoded.ok && JSON.stringify(decoded.value) === JSON.stringify(result.value.payload), 'exported stats payload failed to round-trip through decodeDayStats');
  state.exportData = { summary: result.value.summary, text: result.value.text };
  state.exportStatus = null; state.screen = 'export';
  commit({ ...state.session, day: { ...day, lastExportedAt: nowIso } });
}
```
`lastExportedAt` moves from per-game to day-level. Leave `copyPayload` / `onExportShare` untouched — the clipboard path is already the only one, and it must stay that way (a day sheet is ~13 KB).

- [ ] **Step 7: Register the new actions in `runAction`**

Add `open-players`, `toggle-player`, `players-add-sub`, `players-done`, `confirm-replace-day`, `day-exists-open`, `day-exists-update`, `paste-new-day`; remove `menu-add-sub`, `sub-add`, `game-exists-open`, `game-exists-update`, `switcher-new-game`.

- [ ] **Step 8: Bump the version and the service-worker cache**

`src/session.js`: `APP_VERSION = '2.0.0'`. `src/sw.js`: `CACHE = 'ciq-stats-v3'` — without this the installed PWA serves the cached v1 bundle and the coach sees no change at all.

- [ ] **Step 9: Build and eyeball it**

```bash
npm run build:dev && start "" "C:\_src\CoachIQ_Rotation_Planner_Client\dist-dev\CoachIQ_Rotation_Planner_Client.html"
```
Paste the real payload from the plan Context. Expect: a `Blizzard · vs Practice_9_18 · 18 Sep` record screen with 10 rows and five set tabs.

- [ ] **Step 10: Commit**

```bash
git add src/ui.js src/session.js src/sw.js
git commit -m "feat(ui): open a whole day from one paste, tick players per game, export the day"
```

---

## Task 6: Styles for five tabs and the tick-list

**Files:** Modify `src/styles.css`

- [ ] **Step 1: Make five set tabs fit 320px**

`.seg button` is `padding:6px 10px; min-height:44px` today, sized for three `Set N` labels. With bare numerals five fit, but pin it:

```css
.seg button { background:none; border:0; padding:6px 0; min-width:44px; min-height:44px; font-size:13px; font-weight:600; color:var(--fg-2); }
.seg button.on { background:var(--accent); color:var(--accent-fg); font-weight:700; }
```
`.setbar` keeps `display:flex; gap:8px` so the score button still sits to the right.

- [ ] **Step 2: Add tick-list rows**

```css
.ticklist { list-style:none; margin:0; padding:0; max-height:52vh; overflow-y:auto; }
.ticklist li { border-bottom:1px solid var(--line); }
.ticklist li:last-child { border-bottom:0; }
.tick { display:flex; align-items:center; gap:10px; padding:10px 4px; min-height:44px; cursor:pointer; }
.tick input[type="checkbox"] { width:22px; height:22px; accent-color:var(--accent); flex:none; }
.tick .tname { font-size:13.5px; font-weight:600; display:flex; align-items:center; gap:6px; }
.tickfoot { display:flex; justify-content:space-between; align-items:center; font-size:11.5px; color:var(--fg-3); padding:10px 4px 0; }
```

- [ ] **Step 3: Check at 320px**

In the dev build, DevTools device toolbar at 320×568. Expect no horizontal scroll and all five tabs visible.

- [ ] **Step 4: Commit**

```bash
git add src/styles.css && git commit -m "style: fit five set tabs and add the players tick-list"
```

---

## Task 7: Repoint the build verification and parity tests

**Files:** Modify `scripts/verify-build.mjs`, `test/harden-app.test.mjs`

- [ ] **Step 1: Give `verify-build.mjs` a v2 roster**

`scripts/verify-build.mjs:54-62` builds its fixture with `encodeRoster` — switch to `encodeDayRoster` and a two-game day. Its expectations at `:166-192` assert four player names plus the team and opponent appear in the rendered text; because the record screen now shows **only ticked players**, the fixture's first game must pre-select every name asserted. Keep the `zero textareas` / `≥30 elements` / `no .err banner` checks — they still hold, and they are what proves the paste screen was left behind.

- [ ] **Step 2: Rename the functions the parity harness drives**

`test/harden-app.test.mjs:57-147` calls `openRoster`, `buildStatsPayload`, `encodeStats`, `decodeStats` by name. Rename to `openDayRoster`, `buildDayStatsPayload`, `encodeDayStats`, `decodeDayStats` and feed it `DAY_ROSTER_VECTOR.payload`. `tap`, `setScore`, `undo`, `serialiseSession`, `parseSession` keep their names. Leave `assert.ok(!code.includes('CIQR'))` alone — it still passes, because the obfuscator keeps moving the prefix into its string array.

- [ ] **Step 3: Run the whole suite plus the headless verification**

```bash
npm test
npm run build && npm run verify
```
Expected: all tests PASS; `verify` reports the plain, hardened and shipped fingerprints identical.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-build.mjs test/harden-app.test.mjs dist
git commit -m "test: verify the build against a v2 day roster"
```

---

## Verification

End-to-end, in order:

1. **Unit** — `npm test`. Every test green, including the two v2 golden vectors byte-exact and the schema-1 migration.
2. **The reported failure** — the exact payload from the Context section pastes cleanly and produces a `Blizzard` / `vs Practice_9_18 · 18 Sep` record screen with all ten players and five set tabs.
3. **Headless** — `npm run build && npm run verify`. Plain, hardened and shipped builds must fingerprint identically.
4. **Round trip against the real planner** — record counts across two games, Export, copy the `CIQS2` text, and paste it into the planner's Stats dialog at `C:\_src\CoachIQ_Rotation_Planner`. It must import without a malformed-payload error and attribute each game's stats to the right game.
5. **Migration** — before upgrading, save a v1 session (paste a `CIQR1` roster into the current build, tap a few counts). Load the new build against the same `localStorage` origin; the day must appear with counts intact and `sets` padded to five.
6. **On a phone** — at 320px, five set tabs with no horizontal scroll; the Players sheet scrolls and every checkbox is a 44px target.

## Risks and sharp edges

- **`runSelfCheck` will fail closed if missed.** It calls `encodePayload('roster', ROSTER_VECTOR.payload)` with no version, which under `CONTRACT_VERSION = 2` emits `CIQR2.` around a `"v":1` body — the codec then refuses its own output, the boot banner goes red and **Export is disabled** (`ui.js:409`). Task 4 Step 3 fixes it; verify the ⋯ menu reports `Codec self-check: OK`.
- **The build's import stripper is line-based.** A wrapped `import { … }` survives into the bundle as a syntax error inside the IIFE. `npm test` passes regardless — only `npm run build` catches it.
- **Golden vectors are key-order sensitive.** If an encode test fails, the object literal's key order is wrong. Never edit the expected string.
- **Not bumping `sw.js`'s `CACHE`** leaves every installed PWA serving the old bundle. The symptom is indistinguishable from "the fix didn't work".
- **`commit()` writes the entire session on every tap.** A full day (8 games × 12 players × 5 sets) is a much larger synchronous `localStorage` write than v1's single game. Watch for tap latency on the phone; if it bites, debounce `commit` and keep the existing `visibilitychange` flush (`ui.js:764`) as the guarantee.
- **Unticking silently orphans counts** unless `setPlayerTicked` refuses it — `buildDayStatsPayload` iterates the tick-list, so an unticked player's counts would vanish from the export with no warning. The refusal is the safeguard, not a nicety.
- **`dist/` is committed** and deployed by `git subtree push --prefix dist origin gh-pages`. It must be rebuilt in the same commit range or the deployed app lags the source.
- **Ship both apps together.** Until this lands, the planner cannot talk to this client at all; after it lands, a `CIQR1` email still works via the normalisation path.

## Sequencing

Tasks 1 → 2 → 3 → 4 → 5 are strictly ordered (each consumes the last). **Task 6 (styles) can run in parallel with Task 5**, and **Task 7 can be drafted in parallel with Task 5** but only run green after it. Task 1 Step 3 is a hard review gate — get the mockup approved before any code changes.
