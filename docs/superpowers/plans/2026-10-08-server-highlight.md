# Highlight the planned server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The record screen highlights the player who should serve (our server while we serve, our next server while they serve), from the set's planned serve order in a contract-6 roster plus the rallies logged so far; a Serve tap for someone else re-aligns the plan with a toast, and Undo takes it back.

**Architecture:** `src/codec.js`/`src/vectors.js` become a type-stripped port of the Planner's contract 6 (roster `games[].serve`, roster pinned to 6, stats pinned to 5). `src/session.js` resolves each set's serve string to player ids at ingest (`game.serveOrders`), keeps a per-set alignment (`shift`, `standIns`), predicts with the pure `plannedServerAt`/`plannedServer`, and re-aligns inside `tap()` with a separate `align` history entry that Undo, the opener-cancelling minus, the clears and persistence all understand. `src/ui.js` marks the predicted row and adds the re-align toast and Undo label; `src/styles.css` gets one rule.

**Tech Stack:** Plain JavaScript ES modules, no framework, no dependencies. `node --test` with the fake DOM in `test/helpers/fake-dom.mjs`; Playwright in `e2e/` over the built `dist/`; puppeteer-core scripts in `scripts/verify-*.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-08-server-highlight-design.md` (mockup: `docs/server-highlight-mockup.html`) and the Planner's contract-6 spec `C:\_src\CoachIQ_Rotation_Planner\docs\superpowers\specs\2026-10-08-roster-serve-order-design.md` (the `serve` field, its reading rule, the five refusals, the golden vectors).

**Prerequisite:** the Planner plan `C:\_src\CoachIQ_Rotation_Planner\docs\superpowers\plans\2026-10-08-roster-serve-order.md` must be executed first (its Tasks 1–5; its Task 6, the round trip, runs after this plan). Its `src/contract/statsContract.ts` (contract 6, that plan's Task 2) and frozen `src/contract/__fixtures__/vectors.ts` (`ROSTER_V6_VECTOR`, `ROSTER_V3_AS_V6`, `ROSTER_V2_AS_V6`, `ROSTER_V1_AS_V6` from its Task 2; `SERVE_ORDER_VECTOR` from its Task 1) are what Task 1 copies and ports. The JS and data in Task 1 below are taken from that plan's code, names included. If `C:\_src\CoachIQ_Rotation_Planner\src\contract\statsContract.ts` does not contain `export const CONTRACT_VERSION = 6;`, STOP and report — do not start this plan.

## Global Constraints

- **Never commit.** No `git commit`, `git push`, `git add`, `git stash`, `git checkout`, no `npm run deploy`. Leave every change in the working tree; the controller manages git. Rory commits only when he asks.
- Implementers never dispatch subagents.
- Plain JS, no new dependencies. Each `import` line in `src/` must stay on ONE line (the build inliner strips single-line imports only).
- `src/codec.js` and `src/vectors.js` are verbatim ports of `reference/statsContract.ts` and `reference/vectors.ts` (TypeScript type syntax stripped, same logic, same order, same error strings). Never hand-invent contract code or data, and never regenerate an encoded vector string. Where this plan's reference JS differs from the Planner's real code, **the Planner's code wins**.
- `CONTRACT_VERSION` 6. `encodeDayRoster` pinned to 6 (`CIQR6.`); `encodeDayStats` pinned to **5** (the phone still exports `CIQS5.`). Today `encodeDayStats` has no pin at all (it uses `CONTRACT_VERSION`), so the pin is a real code change: without it the phone would emit `CIQS6.` around a `v: 5` body. `NOT_A_KNOWN_VERSION` = `'its version is not 1, 2, 3, 4, 5 or 6'`. `SERVE_ORDER_PATTERN` = `/^[0-9a-v-]{6,16}$/` (length is checked only as 6–16).
- Contract-6 refusal details, verbatim (each wrapped by `malformed('roster', …)` as `The roster payload is malformed: <detail>.`):
  - `game "<gid>" has no serve list with one entry per set`
  - `game "<gid>" set <n> has a serve order that is not legal`
  - `game "<gid>" set <n> serve order names player <i>, but the payload lists only <N>`
  - `game "<gid>" set <n> serve order names a player who is not in that set`
  - `game "<gid>" set <n> serve order names nobody`
- `SESSION_SCHEMA` stays 4. New stored fields are optional and never fatal: set `shift` (whole number 0–15, else 0), set `standIns` (keys `/^\d{1,2}$/` below 16, legal ids; a bad entry is skipped), game `serveOrders` (`MAX_SETS` entries, each `null` or an array 6–16 long of directory ids or `null`; a bad entry becomes `null`; missing → five nulls). History entries are read strictly.
- Exact UI strings: toasts `<P> back in`, `Re-aligned to <P>`, `<P> serving for <Q>`, `<P> serving` (first names via `firstName`); after a scoring phrase they join with `. ` (e.g. `Us +1 · side-out. Re-aligned to Bea`); Undo label `↶ Undo re-align`. The cancel toast stays `Open rally cancelled`.
- The server's row is `<div class="row serving" data-serving="1" aria-current="true">`; every other row stays `<div class="row">`. CSS is exactly one rule, no dot: `.row.serving, .row.serving:nth-child(even) { background:var(--info-bg); box-shadow:inset 4px 0 0 var(--accent); }`. No height changes.
- Release: `APP_VERSION` `'4.6.0'`, service worker `CACHE` `'ciq-stats-v15'`, `dist/` rebuilt by `npm run build` only.
- Run every browser (`npm run verify`, `npm run test:browsers`, `npx playwright test …`) from **PowerShell** only — the Bash sandbox kills browsers.

## Review Focus

1. **A re-paste mid-set that changes the order** (the coach re-sends after fixing the lineup): that set's `shift`/`standIns` must reset and its align Undo steps must go, so Undo cannot restore an alignment that described the old plan; an unchanged order must keep everything. Pinned in Task 3.
2. **A Serve tap when the log is at `MAX_POINTS`**: no `serveBy`, so no re-align and no align entry. Pinned in Task 4.
3. **The 400-entry history cap**: a re-align pushes two entries at once; both must survive the slice and both must Undo in order. Pinned in Task 4.
4. **Minus on the opener with other entries in between** (a minus on an old miscount, or a tap in another set, after the re-aligning serve): the cancel must still reverse its re-align, and Undo of the minus must restore it. Pinned in Task 4.
5. **A saved session from 4.5.0** (no `serveOrders`, `shift`, `standIns`): it must load, predict nothing, and record as before. Pinned in Task 4 (and the tolerant reads in Tasks 2–3).

---

## File Structure

| File | Change | Responsibility after the change |
|---|---|---|
| `reference/statsContract.ts`, `reference/vectors.ts`, `reference/stats-contract.md` | Replace | Re-copied from the Planner at contract 6. |
| `reference/stats-contract-v6-client-guide.md` | Create (copy) | The Planner's contract-6 client guide. |
| `src/codec.js` | Modify | Contract 6 port: v6 roster validator, private v3 validator, `normaliseRosterV3`, pins 6/5. |
| `src/vectors.js` | Modify | Adds `ROSTER_V6_VECTOR`, `ROSTER_V3_AS_V6`, `ROSTER_V2_AS_V6`, `ROSTER_V1_AS_V6`, `SERVE_ORDER_VECTOR`; drops `ROSTER_V2_AS_V3`, `ROSTER_V1_AS_DAY`. |
| `src/session.js` | Modify | `serveOrders` at ingest/merge; set `shift`/`standIns`; `plannedServerAt`/`plannedServer`; re-align in `tap`; `align` Undo; clears; persistence; self-check. |
| `src/ui.js` | Modify | Row highlight, re-align toast, `↶ Undo re-align`. |
| `src/styles.css` | Modify | The `.row.serving` rule. |
| `src/sw.js` | Modify | `ciq-stats-v15`. |
| `test/codec.test.mjs` | Modify | Contract-6 vectors, normalisation, refusals, pins. |
| `test/session.test.mjs` | Modify | Prediction, storage, re-align, Undo, minus, clears, persistence. |
| `test/ui.test.mjs` | Modify | Roster text at v6; highlight, toasts, Undo label, CSS. |
| `test/harden-app.test.mjs` | Modify | Driver roster at v6; `CIQR7` too-new; a stand-in step. |
| `scripts/verify-build.mjs`, `scripts/verify-density.mjs` | Modify | Rosters at v6. |
| `scripts/verify-golden-vector.mjs` | Modify | Pastes the frozen `CIQR6.` vector; checks the highlight. |
| `e2e/support/fixtures.mjs` | Modify | Roster at v6, `plannedPayload()`, `rosterText` fills a missing `serve`. |
| `e2e/record.spec.mjs`, `e2e/paste.spec.mjs`, `e2e/persist.spec.mjs` | Modify | Browser coverage. |
| `README.md` | Modify | `CIQR6.`, reference table, `(4.6.0)` checklist. |
| `dist/` | Regenerate | `npm run build`. |

**Task order is dependency order.** Task 1 changes the wire contract and keeps the unit suite green. Task 2 adds the prediction (and its self-check). Task 3 stores the plan. Task 4 re-aligns. Task 5 is the screen. Task 6 the browser harnesses. Task 7 the release. Tasks 1–5 each end with `npm test` green; `npm run verify` and the browser suites are red from Task 1 until Task 6 moves their rosters to v6.

---

### Task 1: Port contract 6 — reference copies, codec, vectors

**Files:**
- Replace: `reference/statsContract.ts`, `reference/vectors.ts`, `reference/stats-contract.md`; Create: `reference/stats-contract-v6-client-guide.md`
- Modify: `src/codec.js` (header :1-5; `CONTRACT_VERSION` :7; `encodeRoster` comment :392-394; `encodeDayRoster` :404-410; `encodeDayStats` :412-415; `NOT_A_KNOWN_VERSION` :435-438; v3 validator :536-605; `normaliseRosterV2`/`normaliseRosterV1` :753-789; `decodeDayRoster` :796-820)
- Modify: `src/vectors.js` (append after `ROSTER_V3_VECTOR` :87-90; replace `ROSTER_V1_AS_DAY` :157-166 and `ROSTER_V2_AS_V3` :168-180)
- Modify (keep green): `src/session.js` (import line :4; `runSelfCheck` roster legs :1240, :1244-1245, :1254-1257), `test/session.test.mjs` (import :5; test at :642-653), `test/harden-app.test.mjs` (roster :70-84, too-new :139-141, assertion :226-229), `test/ui.test.mjs` (`ROSTER_TEXT` :55-62)
- Test: `test/codec.test.mjs`

**Interfaces:**
- Consumes: the Planner's contract-6 `statsContract.ts` and `vectors.ts`.
- Produces (later tasks import these exact names):
  - `src/codec.js` exports: `CONTRACT_VERSION = 6`; `SERVE_ORDER_PATTERN = /^[0-9a-v-]{6,16}$/`; `encodeDayRoster(payload) → 'CIQR6.…'`; `encodeDayStats(payload) → 'CIQS5.…'`; `validateDayRosterPayload(value)` validates a v6 body; `decodeDayRoster(text) → { ok: true, value: DayRosterV6 } | { ok: false, error }`; `normaliseRosterV1(p) → DayRosterV6`. `DayRosterV6 = { v: 6, kind: 'roster', date, team, players: [{ id, name, jersey? }], games: [{ gameId, opponent, sets: number[], serve: (string|null)[] }] }`, each game rebuilt in the key order `gameId, opponent, sets, serve`.
  - `src/codec.js` private: `validateDayRosterPayloadV3(value, version = 3)`, `parseServeList(gameId, value, sets, size)`, `normaliseRosterV3(p)`.
  - `src/vectors.js`: `ROSTER_V6_VECTOR` (`{ payload, encoded }`), `ROSTER_V3_AS_V6`, `ROSTER_V2_AS_V6`, `ROSTER_V1_AS_V6` (the Client's own `ROSTER_V2_AS_V3` and `ROSTER_V1_AS_DAY` are renamed to the last two), and `SERVE_ORDER_VECTOR` = `{ order: (string|null)[], servedFirst: boolean, points: string, servers: (string|null)[] }` (`servers` has one entry per rally: the Planner's server when we serve it, `null` when they do).

- [ ] **Step 1: Copy the four reference files**

```bash
cd "C:/_src/CoachIQ_Rotation_Planner_Client"
cp "C:/_src/CoachIQ_Rotation_Planner/src/contract/statsContract.ts" reference/statsContract.ts
cp "C:/_src/CoachIQ_Rotation_Planner/src/contract/__fixtures__/vectors.ts" reference/vectors.ts
cp "C:/_src/CoachIQ_Rotation_Planner/docs/stats-contract.md" reference/stats-contract.md
cp "C:/_src/CoachIQ_Rotation_Planner/docs/stats-contract-v6-client-guide.md" reference/stats-contract-v6-client-guide.md
grep -n "CONTRACT_VERSION = 6" reference/statsContract.ts
grep -n "ROSTER_V6_VECTOR\|SERVE_ORDER_VECTOR\|ROSTER_V3_AS_V6" reference/vectors.ts
```

Expected: both greps print matches. If not, STOP (the Planner plan has not run).

Read `reference/statsContract.ts` from `CONTRACT_VERSION` to the end and `reference/vectors.ts` in full before Step 4. The names and code in Steps 4-5 are taken from the Planner plan (`SERVE_ORDER_PATTERN`, `validateDayRosterPayloadV3`, `parseServeList`, `normaliseRosterV3`, `ROSTER_V6_VECTOR`, `ROSTER_V3_AS_V6`, `ROSTER_V2_AS_V6`, `ROSTER_V1_AS_V6`, `SERVE_ORDER_VECTOR`). If the reference files differ from them, the reference files win; name every difference in the report.

- [ ] **Step 2: Write the failing codec tests** in `test/codec.test.mjs`.

In the codec import (lines 3-9), change line 8 to:

```js
  normaliseRosterV1, normaliseStatsV1, maskHas, maskOf, maskMembers, maskCount, maskUnion, serveTurnCount, SERVE_ORDER_PATTERN,
```

Replace the vectors import on line 10 with:

```js
import { ROSTER_VECTOR, STATS_VECTOR, ROSTER_V2_VECTOR, STATS_V2_VECTOR, ROSTER_V3_VECTOR, ROSTER_V6_VECTOR, ROSTER_V3_AS_V6, ROSTER_V2_AS_V6, ROSTER_V1_AS_V6, STATS_V1_AS_DAY, STATS_V4_VECTOR, STATS_V5_VECTOR, STATS_V4_AS_V5, STATS_V2_AS_V5, STATS_V3_AS_V5, STATS_V3_VECTOR } from '../src/vectors.js';
```

Replace the test at lines 24-27 with:

```js
test('golden v2 roster vector still encodes and decodes, normalising to one set per game at v6', () => {
  assert.equal(encodePayload('roster', ROSTER_V2_VECTOR.payload, 2), ROSTER_V2_VECTOR.encoded);
  assert.deepEqual(decodeDayRoster(ROSTER_V2_VECTOR.encoded), { ok: true, value: ROSTER_V2_AS_V6 });
});
```

Replace the test at lines 28-31 with:

```js
test('golden v3 roster vector still encodes at 3, and decodes to v6 with no plan', () => {
  assert.equal(encodePayload('roster', ROSTER_V3_VECTOR.payload, 3), ROSTER_V3_VECTOR.encoded);
  assert.deepEqual(decodeDayRoster(ROSTER_V3_VECTOR.encoded), { ok: true, value: ROSTER_V3_AS_V6 });
});
test('golden v6 roster vector round-trips byte-exact', () => {
  assert.equal(encodeDayRoster(ROSTER_V6_VECTOR.payload), ROSTER_V6_VECTOR.encoded);
  assert.ok(ROSTER_V6_VECTOR.encoded.startsWith('CIQR6.'));
  assert.deepEqual(decodeDayRoster(ROSTER_V6_VECTOR.encoded), { ok: true, value: ROSTER_V6_VECTOR.payload });
});
```

Replace the test at lines 73-78 with:

```js
test('legacy rosters normalise to v6: v1 and v2 to exactly one set holding the whole roster, and no plan anywhere', () => {
  assert.deepEqual(decodeDayRoster(ROSTER_VECTOR.encoded), { ok: true, value: ROSTER_V1_AS_V6 });
  assert.deepEqual(decodeDayRoster(ROSTER_V2_VECTOR.encoded), { ok: true, value: ROSTER_V2_AS_V6 });
  // One set, not three and not five — inventing a set count would present a fabrication as data.
  for (const g of decodeDayRoster(ROSTER_V2_VECTOR.encoded).value.games) assert.equal(g.sets.length, 1);
  for (const encoded of [ROSTER_VECTOR.encoded, ROSTER_V2_VECTOR.encoded, ROSTER_V3_VECTOR.encoded]) {
    for (const g of decodeDayRoster(encoded).value.games) {
      assert.deepEqual(g.serve, g.sets.map(() => null), 'one null per set: an older roster carries no plan');
    }
  }
});
```

Replace the test at lines 80-87 with:

```js
test('a CIQR7 roster is refused as newer, naming the Rotation Planner', () => {
  // 7, not 6: version 6 is this app's own contract now, so only a 7 is genuinely "newer".
  const future = ROSTER_V6_VECTOR.encoded.replace('CIQR6.', 'CIQR7.');
  assert.deepEqual(decodeDayRoster(future), {
    ok: false,
    error: 'This payload was made by a newer version of the Rotation Planner (contract 7); this app understands 6.',
  });
});
```

Replace the whole `test('v3 roster catalogue', …)` at lines 89-140 with:

```js
test('roster catalogue: the v3 set rules, read at contract 6', () => {
  const manyPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: 'x' }));
  const base = { v: 6, kind: 'roster', date: 'd', team: 't', players: manyPlayers(2) };
  const nulls = (sets) => (Array.isArray(sets) ? sets.map(() => null) : []);
  const game = (sets) => ({ ...base, games: [{ gameId: 'g', opponent: 'o', sets, serve: nulls(sets) }] });
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
  // The 16-cap is the UNION across sets, not any one set's count.
  const seventeen = { v: 6, kind: 'roster', date: 'd', team: 't', players: manyPlayers(17) };
  assert.equal(
    validateDayRosterPayload({ ...seventeen, games: [{ gameId: 'g', opponent: 'o', sets: [2 ** 17 - 1], serve: [null] }] }).error,
    'The roster payload is malformed: game "g" names 17 players; the limit is 16.',
  );
  // The same 17 players spread across two sets still trip the union cap.
  assert.equal(
    validateDayRosterPayload({ ...seventeen, games: [{ gameId: 'g', opponent: 'o', sets: [2 ** 16 - 1, 2 ** 16], serve: [null, null] }] }).error,
    'The roster payload is malformed: game "g" names 17 players; the limit is 16.',
  );
  // Exactly 16 is legal.
  assert.equal(
    validateDayRosterPayload({ ...seventeen, games: [{ gameId: 'g', opponent: 'o', sets: [2 ** 16 - 1], serve: [null] }] }).ok,
    true,
  );
  // A mask of 0 is legal: the coach sent the day before picking that set.
  assert.equal(validateDayRosterPayload(game([0])).ok, true);
  assert.equal(validateDayRosterPayload(game([3, 0, 1])).ok, true);
  // A v2 or v3 body reaching the v6 validator directly is a version fault, named with all six.
  for (const v of [2, 3]) {
    assert.equal(
      validateDayRosterPayload({ v, kind: 'roster', date: 'd', team: 't', players: manyPlayers(2), games: [] }).error,
      'The roster payload is malformed: its version is not 1, 2, 3, 4, 5 or 6.',
    );
  }
});

test('the serve-order pattern is the Planner’s: 6 to 16 base-32 characters or dashes', () => {
  assert.equal(SERVE_ORDER_PATTERN.source, '^[0-9a-v-]{6,16}$');
});

test('base 32 reaches the 32nd directory player: 0–9, then a for index 10, up to v', () => {
  const players = Array.from({ length: MAX_DAY_PLAYERS }, (_, i) => ({ id: `p${i}`, name: 'x' }));
  const game = { gameId: 'g1', opponent: 'Lions', sets: [maskOf([0, 9, 10, 31])], serve: ['09av--'] };
  const day = { ...ROSTER_V6_VECTOR.payload, players, games: [game] };
  assert.deepEqual(validateDayRosterPayload(day), { ok: true, value: day });
});

test('a game over its cap is reported as that, not as its 17-spot order: every v3 check runs first', () => {
  const players = Array.from({ length: 17 }, (_, i) => ({ id: `p${i}`, name: 'x' }));
  const seventeen = [...Array(17).keys()];
  const order = seventeen.map((i) => i.toString(32)).join('');
  assert.equal(order, '0123456789abcdefg');
  assert.equal(
    validateDayRosterPayload({ ...ROSTER_V6_VECTOR.payload, players, games: [{ gameId: 'g1', opponent: 'Lions', sets: [maskOf(seventeen)], serve: [order] }] }).error,
    'The roster payload is malformed: game "g1" names 17 players; the limit is 16.',
  );
});

test('each v6 game is rebuilt field by field, dropping unknown fields, in a fixed key order', () => {
  const base = ROSTER_V6_VECTOR.payload;
  const decoded = validateDayRosterPayload({ ...base, games: [{ ...base.games[0], ghost: 1 }, base.games[1]] });
  assert.deepEqual(decoded, { ok: true, value: base });
  assert.deepEqual(Object.keys(decoded.value.games[0]), ['gameId', 'opponent', 'sets', 'serve']);
});

test('contract 6 serve-order refusals match the Planner catalogue', () => {
  const players = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  // Set 1 is mask 3 (a, b); set 2 is mask 7 (a, b, c).
  const day = (extra) => ({ v: 6, kind: 'roster', date: 'd', team: 't', players, games: [{ gameId: 'g', opponent: 'o', sets: [3, 7], ...extra }] });
  const fault = (extra) => validateDayRosterPayload(day(extra)).error;
  const M = 'The roster payload is malformed: ';
  const noList = `${M}game "g" has no serve list with one entry per set.`;
  assert.equal(fault({}), noList, 'missing');
  assert.equal(fault({ serve: 'x' }), noList, 'not an array');
  assert.equal(fault({ serve: [null] }), noList, 'one entry for two sets');
  assert.equal(fault({ serve: [null, null, null] }), noList, 'three entries for two sets');
  assert.equal(fault({ serve: [null, 7] }), `${M}game "g" set 2 has a serve order that is not legal.`, 'wrong type');
  for (const bad of ['01010', '0'.repeat(17), '01010W', '01010z', '010 10']) {
    assert.equal(fault({ serve: [bad, null] }), `${M}game "g" set 1 has a serve order that is not legal.`, JSON.stringify(bad));
  }
  assert.equal(fault({ serve: [null, '012v12'] }), `${M}game "g" set 2 serve order names player 31, but the payload lists only 3.`);
  assert.equal(fault({ serve: ['012012', null] }), `${M}game "g" set 1 serve order names a player who is not in that set.`);
  assert.equal(fault({ serve: ['------', null] }), `${M}game "g" set 1 serve order names nobody.`);
  assert.equal(validateDayRosterPayload(day({ serve: ['01-01-', '0120120'] })).ok, true, 'a dash is an empty spot; 7 long is a Train set');
  assert.equal(validateDayRosterPayload(day({ serve: [null, '0123456789abcdef'.replace(/[3-9a-f]/g, '2')] })).ok, true, '16 long is the maximum');
});

test('a stats body at 6 is not a known version: the stats half stays at 5', () => {
  const six = { ...STATS_V5_VECTOR.payload, v: 6 };
  assert.equal(validateDayStatsPayload(six).error, 'The stats payload is malformed: its version is not 1, 2, 3, 4, 5 or 6.');
  assert.equal(decodeDayStats(encodePayload('stats', six, 6)).error, 'The stats payload is malformed: its version is not 1, 2, 3, 4, 5 or 6.');
});
```

Replace the test at lines 174-176 with:

```js
test('the roster is pinned to 6 and the stats sheet to 5', () => {
  assert.ok(encodeDayRoster(ROSTER_V6_VECTOR.payload).startsWith('CIQR6.'));
  assert.equal(encodeDayStats(STATS_V5_VECTOR.payload), STATS_V5_VECTOR.encoded);
  assert.ok(encodeDayStats(STATS_V5_VECTOR.payload).startsWith('CIQS5.'));
});
```

In `test('contract constants', …)` (line 194) change `assert.equal(CONTRACT_VERSION, 5);` to `assert.equal(CONTRACT_VERSION, 6);`.

In `test('transport error catalogue', …)` replace lines 215-216, and in `test('kind-aware transport messages, verbatim', …)` replace lines 225-226, with:

```js
  assert.equal(decodeRoster('CIQR7.abc.00000000').error, 'This payload was made by a newer version of the Rotation Planner (contract 7); this app understands 6.');
  assert.equal(decodeStats('CIQS7.abc.00000000').error, 'This payload was made by a newer version of the stats app (contract 7); this app understands 6.');
```

In `test('legacy path: …', …)` (line 262) change `ROSTER_V1_AS_DAY` to `ROSTER_V1_AS_V6`.

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/codec.test.mjs`
Expected: FAIL — the import throws (`does not provide an export named 'ROSTER_V6_VECTOR'`), so every test in the file fails.

- [ ] **Step 4: Port the vectors into `src/vectors.js`.**

Port from `reference/vectors.ts` with TypeScript annotations stripped (`: DayRosterPayload`, the `SERVE_ORDER_VECTOR` type annotation). The literals below are the Planner plan's (Task 2 Step 1a and Task 1 Step 3), copied exactly; check them against `reference/vectors.ts` character for character. If they differ, the reference file wins: stop and report the difference. Every id in them (`grace`, `zoie`, `emily`, `lexi`, `lily`, `brooklyn`, `melanie`, `addison`) matches `ID_PATTERN`, so the session's persistence checks accept them.

After `ROSTER_V3_VECTOR` (line 90), insert:

```js
/**
 * The v6 roster vector: the v3 day plus contract 6's `serve`, one entry per set. Between them the two
 * games cover:
 * - a dash (`game-1` set 1: Grace, Zoë, Grace, nobody, Zoë, Grace);
 * - `null` (`game-1` set 2, and `game-2` set 2, which has nobody in it);
 * - a Train-length entry of 7 (`game-1` set 3);
 * - a single server for every turn (`game-2` set 1).
 *
 * Generated once with the real encoder and frozen: never regenerate the encoded string.
 */
const ROSTER_V6_PAYLOAD = {
  v: 6, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
  games: [
    { gameId: 'game-1', opponent: 'Lions', sets: [3, 1, 2], serve: ['010-10', null, '1111111'] },
    { gameId: 'game-2', opponent: 'Falcons', sets: [2, 0], serve: ['111111', null] },
  ],
};

export const ROSTER_V6_VECTOR = {
  payload: ROSTER_V6_PAYLOAD,
  encoded: 'CIQR6.eyJ2Ijo2LCJraW5kIjoicm9zdGVyIiwiZGF0ZSI6IjIwMjYtMDktMTkiLCJ0ZWFtIjoiVGh1bmRlciIsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJuYW1lIjoiR3JhY2UiLCJqZXJzZXkiOjd9LHsiaWQiOiJ6b2llIiwibmFtZSI6Ilpvw6sifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJvcHBvbmVudCI6Ikxpb25zIiwic2V0cyI6WzMsMSwyXSwic2VydmUiOlsiMDEwLTEwIixudWxsLCIxMTExMTExIl19LHsiZ2FtZUlkIjoiZ2FtZS0yIiwib3Bwb25lbnQiOiJGYWxjb25zIiwic2V0cyI6WzIsMF0sInNlcnZlIjpbIjExMTExMSIsbnVsbF19XX0.841c281c',
};

/**
 * What `decodeDayRoster` must return for each legacy roster vector, written by hand and never
 * computed: comparing the decoder against its own normaliser would pass even when the normaliser is
 * wrong. Each is the legacy day at `v: 6` with `serve` all `null`, because a legacy roster carried no
 * serve order. A v2 game, and the single game of a v1 roster, becomes one set holding its whole
 * roster (`normaliseRosterV2`).
 */
export const ROSTER_V3_AS_V6 = {
  v: 6, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
  games: [
    { gameId: 'game-1', opponent: 'Lions', sets: [3, 1, 2], serve: [null, null, null] },
    { gameId: 'game-2', opponent: 'Falcons', sets: [2, 0], serve: [null, null] },
  ],
};

export const ROSTER_V2_AS_V6 = {
  v: 6, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
  games: [
    { gameId: 'game-1', opponent: 'Lions', sets: [3], serve: [null] },
    { gameId: 'game-2', opponent: 'Falcons', sets: [2], serve: [null] },
  ],
};

export const ROSTER_V1_AS_V6 = {
  v: 6, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
  games: [{ gameId: 'game-1', opponent: 'Lions', sets: [3], serve: [null] }],
};
```

Delete the Client's own `ROSTER_V1_AS_DAY` (lines 157-166) and `ROSTER_V2_AS_V3` (lines 168-180), doc comments included: `ROSTER_V1_AS_V6` and `ROSTER_V2_AS_V6` above replace them. In the `STATS_V1_AS_DAY` doc comment (line 184), change "for the same reason as `ROSTER_V1_AS_DAY`" to "for the same reason as `ROSTER_V1_AS_V6`".

After `STATS_V5_VECTOR` (line 155), insert (the Planner's Task 1 vector; copy the arrays exactly):

```js
/**
 * Contract 6's serve-order check: pure data, so the phone can test its own reading of a `serve`
 * string against the Planner. Built once from `replaySet` on `plannedServeOrder.test.ts`'s
 * `vectorSet()` (six slots, Lily/Brynn a front/back pair, and a usable serve override: Lily serves
 * rotation 3 for Brynn), then frozen. That test checks it against a fresh replay; never regenerate it.
 *
 * `order` is `plannedServeOrder` of that set: player ids, entry r-1 = rotation r. We receive first,
 * so our first serve is entry 1. The 36 rallies hold 10 serve turns of ours, so the order wraps past
 * entry 5 back to Emily. `servers[i]` is who served rally `i` for us, or `null` while they served.
 */
export const SERVE_ORDER_VECTOR = {
  order: ['emily', 'lexi', 'lily', 'brooklyn', 'melanie', 'addison'],
  servedFirst: false,
  points: 'TTUUUTTUTUUTTUUTUUTTUUUTUTTUUTUUTUTU',
  servers: [
    null, null, null, 'lexi', 'lexi', 'lexi', null, null, 'lily', null, 'brooklyn', 'brooklyn',
    null, null, 'melanie', 'melanie', null, 'addison', 'addison', null, null, 'emily', 'emily', 'emily',
    null, 'lexi', null, null, 'lily', 'lily', null, 'brooklyn', 'brooklyn', null, 'melanie', null,
  ],
};
```

`ROSTER_V6_VECTOR`'s game-1 set 3 (`'1111111'`) is codec coverage for a 7-long order, not a realistic plan. The session self-check's prediction leg uses `SERVE_ORDER_VECTOR` only (Task 2).

- [ ] **Step 5: Port contract 6 into `src/codec.js`.**

Port the Planner plan's Task 2 Step 3 code (now in `reference/statsContract.ts`) with type syntax stripped and nothing else changed: same names, same check order, same doc comments, same error strings. The JS below is that code, type-stripped, for the implementer and the reviewer. If `reference/statsContract.ts` differs from it anywhere, the reference file wins; name the difference in the report.

Header (lines 1-5):

```js
// codec.js — verbatim port of the CoachIQ stats contract codec.
// Source: reference/statsContract.ts (constants, validators, v1-v6 functions), with TypeScript type syntax stripped,
// and the client guides reference/stats-contract-v4-client-guide.md and reference/stats-contract-v6-client-guide.md.
// v5 has no separate client guide: reference/stats-contract.md covers it.
// Do not edit; re-copy from those sources if the contract changes.
```

`CONTRACT_VERSION` (line 7). Above it, port the Planner's added docblock paragraph, and change the value:

```js
/**
 * Version 6 gives each roster game a `serve` list: one compact string per set naming the planned
 * server of each of our rotation turns (docs/superpowers/specs/2026-10-08-roster-serve-order-design.md),
 * so the phone can highlight who should be serving. Nothing is removed, but a v5 Client would
 * validate a v6 roster field by field and drop every order without a word, so it bumps the way v4
 * and v5 did. The roster is sent at 6 (`encodeDayRoster`); the stats half is unchanged, and
 * `encodeDayStats` is pinned to 5.
 */
export const CONTRACT_VERSION = 6;
```

After `serveTurnCount` (it ends at line 188), add:

```js
/**
 * A legal `DayRosterGame.serve` entry (contract 6): 6–16 characters, each a directory index in
 * base 32 or `-` for nobody. Base 32 is `0`–`9` then `a`–`v`, so `parseInt(c, 32)` is 0–31,
 * which covers `MAX_DAY_PLAYERS`. Six characters for a slot set; one per spot in a Train line,
 * never fewer than six. At most `MAX_ROSTER_PLAYERS`, because a longer line names more players
 * than a game may.
 */
export const SERVE_ORDER_PATTERN = /^[0-9a-v-]{6,16}$/;
```

`encodeRoster`'s doc comment (lines 392-394): "`CONTRACT_VERSION` is 5 now, and without it this would emit a `CIQR5.` prefix" becomes "`CONTRACT_VERSION` is 6 now, and without it this would emit a `CIQR6.` prefix".

`encodeDayRoster` and `encodeDayStats` (lines 404-415), replaced with:

```js
/** Encodes a day roster pinned to **6**, the contract that added `serve`. `decodePayload` treats a
 * body `v` that differs from the prefix as corruption, so the pin and `DayRosterPayload.v` move
 * together or not at all. Contracts 4 and 5 left the roster alone and pinned it to 3. A phone
 * older than contract 6 refuses `CIQR6.` as "made by a newer version", which is the point. */
export function encodeDayRoster(payload) {
  return encodePayload('roster', payload, 6);
}

/** Encodes a day stats sheet pinned to **5**. The stats shape did not change at contract 6 (only
 * the roster gained `serve`), and an un-updated Planner must keep reading `CIQS5.`.
 * `decodePayload` treats a body `v` that differs from the prefix as corruption, so the pin and
 * `DayStatsPayload.v` move together or not at all, as the roster pin did for contracts 4 and 5. */
export function encodeDayStats(payload) {
  return encodePayload('stats', payload, 5);
}
```

`NOT_A_KNOWN_VERSION` (lines 435-438): in the docblock, `*all five* versions` → `*all six* versions`, and the constant becomes:

```js
const NOT_A_KNOWN_VERSION = 'its version is not 1, 2, 3, 4, 5 or 6';
```

Replace the v3 validator and its docblock (lines 536-605) with the private `validateDayRosterPayloadV3`, `parseServeList` and the public v6 `validateDayRosterPayload`:

```js
/**
 * The v3 roster checks: a day, its directory, and every game as a list of per-set masks.
 *
 * The per-game cap is checked on the **union** across the game's sets, which is the same rule v2
 * enforced (in v2, `roster` *was* that union). That is deliberate: it keeps `overCapGame` in
 * `StatsToolbar.tsx` correct without change, and it is the rule that actually matters, since the
 * Client's tick-list for a game shows everyone the game names across all its sets.
 *
 * `version` is the body `v` it accepts: 3 on the legacy decode path, and 6 when
 * `validateDayRosterPayload` runs it over a v6 body before reading `serve`. Either way it
 * returns the v3 shape.
 */
function validateDayRosterPayloadV3(value, version = 3) {
  if (!isRecord(value)) return malformed('roster', 'it is not an object');
  if (value.v !== version) return malformed('roster', NOT_A_KNOWN_VERSION);
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

/**
 * One game's contract 6 `serve` list, checked against the game's validated `sets` and the
 * directory size, and rebuilt entry by entry. Checks run in this order:
 * 1. the list's shape and length;
 * 2. each set's characters;
 * 3. each index against the directory, then against that set's mask;
 * 4. "names nobody".
 */
function parseServeList(gameId, value, sets, size) {
  if (!Array.isArray(value) || value.length !== sets.length) {
    return malformed('roster', `game "${gameId}" has no serve list with one entry per set`);
  }
  const serve = [];
  for (let i = 0; i < value.length; i += 1) {
    const order = value[i];
    const n = i + 1;
    if (order === null) {
      serve.push(null);
      continue;
    }
    if (typeof order !== 'string' || !SERVE_ORDER_PATTERN.test(order)) {
      return malformed('roster', `game "${gameId}" set ${n} has a serve order that is not legal`);
    }
    const mask = sets[i] ?? 0;
    let named = false;
    for (const c of order) {
      if (c === '-') continue;
      const index = parseInt(c, 32);
      if (index >= size) {
        return malformed('roster', `game "${gameId}" set ${n} serve order names player ${index}, but the payload lists only ${size}`);
      }
      if (!maskHas(mask, index)) {
        return malformed('roster', `game "${gameId}" set ${n} serve order names a player who is not in that set`);
      }
      named = true;
    }
    // An order with nobody in it says nothing a `null` would not, so the sender sends `null`.
    if (!named) return malformed('roster', `game "${gameId}" set ${n} serve order names nobody`);
    serve.push(order);
  }
  return { ok: true, value: serve };
}

/**
 * The v6 roster validator. It runs the v3 checks first, over the whole day, so a game over its
 * cap is reported as that (the message `StatsToolbar.tsx` already warns about) rather than as a
 * bad serve order. Then it checks each game's `serve` (`parseServeList`). Rebuilt field by field,
 * like every validator here; never spread.
 */
export function validateDayRosterPayload(value) {
  const base = validateDayRosterPayloadV3(value, 6);
  if (!base.ok) return base;
  // `validateDayRosterPayloadV3` has proved `value` is a record whose `games` is an array with one
  // record per entry of `base.value.games`, in the same order.
  const rawGames = value.games;
  const { date, team, players } = base.value;
  const games = [];
  for (const [i, game] of base.value.games.entries()) {
    const rawGame = rawGames[i];
    const serve = parseServeList(game.gameId, isRecord(rawGame) ? rawGame.serve : undefined, game.sets, players.length);
    if (!serve.ok) return serve;
    games.push({ gameId: game.gameId, opponent: game.opponent, sets: game.sets, serve: serve.value });
  }
  return { ok: true, value: { v: 6, kind: 'roster', date, team, players, games } };
}
```

`normaliseRosterV2` (lines 753-770) is unchanged: it still returns `v: 3`. Insert `normaliseRosterV3` right after it, and replace `normaliseRosterV1` (lines 772-789) with the version that goes V2 → V3:

```js
/**
 * A v3 roster lifted into the v6 shape. Everything is kept, and `serve` is all `null`: a v3
 * payload carried no serve order, and inventing one would put a plan in front of the coach
 * that nobody made.
 */
function normaliseRosterV3(p) {
  return {
    v: 6,
    kind: 'roster',
    date: p.date,
    team: p.team,
    players: p.players,
    games: p.games.map((g) => ({ gameId: g.gameId, opponent: g.opponent, sets: g.sets, serve: g.sets.map(() => null) })),
  };
}

/**
 * A v1 roster lifted into the v6 shape, via v2 and v3 so that "what a legacy payload's single set means" has exactly one definition.
 *
 * A v1 roster is a one-game day whose directory is that game's players, so every index `0..n-1` is
 * on its tick-list, and `date`/`team` lift to the top. v1's own player cap *is*
 * `MAX_ROSTER_PLAYERS`, so even a full v1 roster normalises to a legal game.
 */
export function normaliseRosterV1(p) {
  return normaliseRosterV3(normaliseRosterV2({
    v: 2,
    kind: 'roster',
    date: p.date,
    team: p.team,
    players: p.players,
    games: [{ gameId: p.gameId, opponent: p.opponent, roster: p.players.map((_, i) => i) }],
  }));
}
```

`decodeDayRoster` (lines 796-820): the docblock's first line becomes "Decodes any roster version this app reads and always returns the v6 day shape.", and the body becomes:

```js
export function decodeDayRoster(text) {
  const decoded = decodePayload(text, 'roster');
  if (!decoded.ok) return decoded;
  const version = bodyVersion(decoded.value);
  if (version === 1) {
    const v1 = validateRosterPayload(decoded.value);
    if (!v1.ok) return v1;
    return { ok: true, value: normaliseRosterV1(v1.value) };
  }
  if (version === 2) {
    const v2 = validateDayRosterPayloadV2(decoded.value);
    if (!v2.ok) return v2;
    return { ok: true, value: normaliseRosterV3(normaliseRosterV2(v2.value)) };
  }
  if (version === 3) {
    const v3 = validateDayRosterPayloadV3(decoded.value);
    if (!v3.ok) return v3;
    return { ok: true, value: normaliseRosterV3(v3.value) };
  }
  if (version === 6) return validateDayRosterPayload(decoded.value);
  return malformed('roster', NOT_A_KNOWN_VERSION);
}
```

`decodeDayStats` and `validateDayStatsPayload` do not change. A stats body at 6 reaches their final `malformed('stats', NOT_A_KNOWN_VERSION)`. A roster body at 4 or 5 reaches `decodeDayRoster`'s.

- [ ] **Step 6: Keep the rest of the suite green.** The pin and the vector renames break four callers.

`src/session.js` line 4 (one line):

```js
import { ROSTER_VECTOR, STATS_VECTOR, ROSTER_V2_VECTOR, STATS_V2_VECTOR, STATS_V4_VECTOR, STATS_V5_VECTOR, STATS_V4_AS_V5, STATS_V2_AS_V5, STATS_V3_VECTOR, STATS_V3_AS_V5, ROSTER_V1_AS_V6, STATS_V1_AS_DAY, ROSTER_V3_VECTOR, ROSTER_V6_VECTOR, ROSTER_V3_AS_V6, ROSTER_V2_AS_V6 } from './vectors.js';
```

In `runSelfCheck`, line 1240 becomes:

```js
    if (encodeDayRoster(ROSTER_V6_VECTOR.payload) !== ROSTER_V6_VECTOR.encoded) return { ok: false, error: 'day roster vector encode' };
```

lines 1244-1245 become:

```js
    const r6 = decodeDayRoster(ROSTER_V6_VECTOR.encoded);
    if (!r6.ok || JSON.stringify(r6.value) !== JSON.stringify(ROSTER_V6_VECTOR.payload)) return { ok: false, error: 'day roster vector decode' };
    const r3 = decodeDayRoster(ROSTER_V3_VECTOR.encoded);
    if (!r3.ok || JSON.stringify(r3.value) !== JSON.stringify(ROSTER_V3_AS_V6)) return { ok: false, error: 'legacy v3 roster vector decode' };
```

and lines 1254-1257 become:

```js
    const r2 = decodeDayRoster(ROSTER_V2_VECTOR.encoded);
    if (!r2.ok || JSON.stringify(r2.value) !== JSON.stringify(ROSTER_V2_AS_V6)) return { ok: false, error: 'legacy v2 roster vector decode' };
    const r1 = decodeDayRoster(ROSTER_VECTOR.encoded);
    if (!r1.ok || JSON.stringify(r1.value) !== JSON.stringify(ROSTER_V1_AS_V6)) return { ok: false, error: 'legacy roster vector decode' };
```

Also in `src/session.js`, the comment above `newDayFromRoster` (lines 160-161) becomes: "`roster` is always a contract-6 day roster payload — `decodeDayRoster` normalises v1, v2 and v3 before it ever reaches here, so nothing below branches on a version." Line 1144's "A CIQR3. paste" becomes "A roster paste".

`test/session.test.mjs` line 5:

```js
import { ROSTER_VECTOR, ROSTER_V2_VECTOR, STATS_V4_AS_V5, POINTS_46, ROSTER_V3_VECTOR, ROSTER_V6_VECTOR, ROSTER_V1_AS_V6, ROSTER_V2_AS_V6, ROSTER_V3_AS_V6 } from '../src/vectors.js';
```

and replace the test at lines 642-653 with:

```js
test('decodeDayRoster normalises every roster version (v1, v2, v3, v6) to the contract-6 day shape', () => {
  assert.deepEqual(decodeDayRoster(ROSTER_VECTOR.encoded), { ok: true, value: ROSTER_V1_AS_V6 });
  assert.deepEqual(decodeDayRoster(ROSTER_V2_VECTOR.encoded), { ok: true, value: ROSTER_V2_AS_V6 });
  assert.deepEqual(decodeDayRoster(ROSTER_V3_VECTOR.encoded), { ok: true, value: ROSTER_V3_AS_V6 });
  assert.deepEqual(decodeDayRoster(ROSTER_V6_VECTOR.encoded), { ok: true, value: ROSTER_V6_VECTOR.payload });
});
```

`test/harden-app.test.mjs`: replace the driver's step-2 comment's "a two-game v3 day" with "a two-game contract-6 day" and the roster (lines 73-83) with:

```js
  const rosterText = encodeDayRoster({
    v: 6, kind: 'roster', date: '2026-09-19', team: 'Home & Co <b>',
    players: [
      { id: 'p1', name: 'Ada <&> "Q"', jersey: 7 },
      { id: 'p2', name: "Zo\\u00eb O'Brien" },
    ],
    games: [
      { gameId: GAME, opponent: 'Away "FC"', sets: [3], serve: ['010101'] },
      { gameId: GAME2, opponent: 'Second "FC"', sets: [1, 1], serve: ['000000', null] },
    ],
  });
```

Lines 139-141 become:

```js
  //     "CIQR7." is a version above CONTRACT_VERSION (6) -- decodePayload refuses it
  //     before it ever checks the checksum, so garbage after the version is fine.
  const tooNew = decodeDayRoster('CIQR7.x.00000000');
```

and the assertion at lines 226-229 becomes:

```js
  assert.ok(
    baseline.includes('decodeDayRoster.tooNew => {"ok":false,"error":"This payload was made by a newer version of the Rotation Planner (contract 7); this app understands 6."}'),
    'AUTHOR_LABEL[expected] resolved correctly for a too-new roster'
  );
```

`test/ui.test.mjs` `ROSTER_TEXT` (lines 55-62):

```js
const ROSTER_TEXT = encodeDayRoster({
  v: 6,
  kind: 'roster',
  date: '2026-09-19',
  team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace' }],
  games: [{ gameId: 'g1', opponent: 'Lions', sets: [1], serve: [null] }], // mask 1 = index 0 = grace, one set, no plan
});
```

- [ ] **Step 7: Run the whole unit suite**

Run: `npm test`
Expected: all pass (`ℹ fail 0`), including `self-check passes` and the harden-app parity test. If an existing test fails, decide whether contract 6 requires the new value (update it precisely, never loosen) or it is a regression (fix the code); list each in the report.

- [ ] **Step 8: Checkpoint — do not commit; leave changes in the working tree.**

---

### Task 2: Predict the planned server

**Files:**
- Modify: `src/session.js` (`emptySet` :28-36; add `mod`, `planIndex`, `plannedServerAt`, `plannedServer` after `setServer` :521-528; persistence helpers before `parseSetRecord` :775; `parseSetRecord` :798-805; add `serveOrderVectorFails` above `runSelfCheck` :1236 and call it there; import line :4)
- Test: `test/session.test.mjs` (update the schema-3 expectation at :962; append at the end)

**Interfaces:**
- Consumes: `SERVE_ORDER_VECTOR` from Task 1.
- Produces:
  - Set record shape: `{ score, counts, servedFirst, points, pending, serveBy, shift: number /* 0..15 */, standIns: { [orderIndex: string]: playerId } }`.
  - `export function plannedServerAt(set, order, at) → string | null` — `order` is `(string|null)[]` or `null`.
  - `export function plannedServer(set, order) → string | null` (= `plannedServerAt(set, order, set.points.length)`).
  - Internal (Task 4 uses them): `mod(a, m) → number`, `planIndex(set, length, at) → number`, `isShift(x) → boolean`, `isOrderIndexKey(k) → boolean`, `isPlayerId(x) → boolean`.
  - `export function serveOrderVectorFails(vector) → boolean` (`vector` has SERVE_ORDER_VECTOR's shape); `runSelfCheck()` calls it on `SERVE_ORDER_VECTOR` and reports error `'serve order vector'` when it returns true.

- [ ] **Step 1: Write the failing tests.**

Change the vectors import of `test/session.test.mjs` (line 5) to also import `SERVE_ORDER_VECTOR`:

```js
import { ROSTER_VECTOR, ROSTER_V2_VECTOR, STATS_V4_AS_V5, POINTS_46, ROSTER_V3_VECTOR, ROSTER_V6_VECTOR, ROSTER_V1_AS_V6, ROSTER_V2_AS_V6, ROSTER_V3_AS_V6, SERVE_ORDER_VECTOR } from '../src/vectors.js';
```

At line 962 the schema-3 migration expectation gains the two new fields:

```js
  assert.deepEqual(g.sets[0], { score: [25, 20], counts: { grace: { serve: { in: 2, out: 0 }, return: { in: 0, out: 0 } } }, servedFirst: null, points: '', pending: null, serveBy: {}, shift: 0, standIns: {} });
```

Append to the end of `test/session.test.mjs`:

```js
// ---- the planned server (docs/superpowers/specs/2026-10-08-server-highlight-design.md) ----
const ORDER6 = ['ana', 'bea', 'cat', 'dee', 'eve', 'fay'];
/** A logged set at the given serve-first answer and log, with no alignment unless `extra` adds one. */
const logged = (servedFirst, points, extra = {}) => ({ score: null, counts: {}, servedFirst, points, pending: null, serveBy: {}, shift: 0, standIns: {}, ...extra });

test('plannedServerAt follows the reading rule: our server while we serve, our next server while they do', () => {
  assert.equal(S.plannedServerAt(logged(true, ''), ORDER6, 0), 'ana', 'we serve first: entry 0');
  assert.equal(S.plannedServerAt(logged(false, ''), ORDER6, 0), 'bea', 'we receive first: our next server is entry 1');
  assert.equal(S.plannedServerAt(logged(false, 'U'), ORDER6, 1), 'bea', 'our first side-out moves to rotation 2');
  assert.equal(S.plannedServerAt(logged(false, 'T'), ORDER6, 1), 'bea', 'they hold serve: still waiting for entry 1');
  assert.equal(S.plannedServerAt(logged(true, 'T'), ORDER6, 1), 'bea', 'we lose our first rally: entry 1 is next');
  assert.equal(S.plannedServerAt(logged(true, 'TU'), ORDER6, 2), 'bea');
  assert.equal(S.plannedServerAt(logged(true, 'UU'), ORDER6, 2), 'ana', 'a run of our rallies is one turn');
});

test('plannedServerAt wraps past entry 5, and a Train-length order wraps at its own length', () => {
  const sixTurns = 'TU'.repeat(6);
  assert.equal(S.plannedServerAt(logged(true, sixTurns), ORDER6, 10), 'fay');
  assert.equal(S.plannedServerAt(logged(true, sixTurns), ORDER6, 12), 'ana', 'turn 6 wraps to entry 0');
  const ORDER7 = [...ORDER6, 'gia'];
  assert.equal(S.plannedServerAt(logged(true, sixTurns), ORDER7, 12), 'gia', 'turn 6 of a 7-long order is entry 6');
  assert.equal(S.plannedServerAt(logged(true, 'TU'.repeat(7)), ORDER7, 14), 'ana');
});

test('plannedServerAt adds the shift, prefers a stand-in, and is null for an empty spot or no prediction', () => {
  assert.equal(S.plannedServerAt(logged(true, '', { shift: 2 }), ORDER6, 0), 'cat');
  assert.equal(S.plannedServerAt(logged(false, '', { shift: 5 }), ORDER6, 0), 'ana', '1 + 5 wraps to 0');
  assert.equal(S.plannedServerAt(logged(true, '', { standIns: { 0: 'gia' } }), ORDER6, 0), 'gia');
  assert.equal(S.plannedServerAt(logged(false, ''), ['ana', null, 'cat', 'dee', 'eve', 'fay'], 0), null, 'an empty spot');
  assert.equal(S.plannedServerAt(logged(true, ''), null, 0), null, 'no plan');
  assert.equal(S.plannedServerAt(null, ORDER6, 0), null, 'an untouched set');
  assert.equal(S.plannedServerAt(logged(null, ''), ORDER6, 0), null, 'serve-first unanswered');
  assert.equal(S.plannedServerAt({ ...logged(null, ''), score: [25, 20] }, ORDER6, 0), null, 'a typed set');
});

test('plannedServer reads at the end of the log: an open rally is predicted either way', () => {
  assert.equal(S.plannedServer(logged(true, 'U', { pending: 'serve' }), ORDER6), 'ana', 'our open rally: its server');
  assert.equal(S.plannedServer(logged(false, '', { pending: 'return' }), ORDER6), 'bea', 'their open rally: our next server');
  assert.equal(S.plannedServer(null, ORDER6), null);
});

test('plannedServerAt agrees with the Planner on all 19 rallies we serve in SERVE_ORDER_VECTOR', () => {
  const v = SERVE_ORDER_VECTOR;
  const set = logged(v.servedFirst, v.points);
  let ours = 0;
  for (let i = 0; i < v.points.length; i += 1) {
    const weServe = i === 0 ? v.servedFirst : v.points[i - 1] === 'U';
    if (!weServe) continue;
    assert.equal(S.plannedServerAt(set, v.order, i), v.servers[i], `rally ${i}`);
    ours += 1;
  }
  assert.equal(ours, 19, 'receiving first, 36 rallies, 10 serve turns of ours');
});

test('serveOrderVectorFails passes the frozen vector and catches a bent copy, so the self-check leg can fail', () => {
  assert.equal(S.serveOrderVectorFails(SERVE_ORDER_VECTOR), false);
  const servers = [...SERVE_ORDER_VECTOR.servers];
  assert.equal(servers[3], 'lexi');
  servers[3] = 'emily'; // rally 3 is Lexi's, our first serve after the side-out
  assert.equal(S.serveOrderVectorFails({ ...SERVE_ORDER_VECTOR, servers }), true);
  assert.equal(S.serveOrderVectorFails({ ...SERVE_ORDER_VECTOR, order: [...SERVE_ORDER_VECTOR.order].reverse() }), true);
  assert.equal(S.serveOrderVectorFails({ ...SERVE_ORDER_VECTOR, servedFirst: true }), true, 'serving first shifts every turn');
  assert.deepEqual(S.runSelfCheck(), { ok: true });
});

test('a new set carries shift 0 and no stand-ins; a save keeps them, reads missing ones as 0 and {}, and resets bad values', () => {
  const s = S.setServedFirst(open(), 'game-1', 1, true);
  assert.deepEqual([s.games[0].sets[0].shift, s.games[0].sets[0].standIns], [0, {}]);
  const envelope = JSON.parse(S.serialiseSession(s));
  const raw = envelope.session.games[0].sets[0];
  const read = () => S.parseSession(JSON.stringify(envelope)).value.games[0].sets[0];
  raw.shift = 3;
  raw.standIns = { 0: 'zoie', 15: 'grace' };
  assert.deepEqual([read().shift, read().standIns], [3, { 0: 'zoie', 15: 'grace' }]);
  delete raw.shift;
  delete raw.standIns;
  assert.deepEqual([read().shift, read().standIns], [0, {}], 'a 4.5.0 save has neither');
  for (const bad of [-1, 16, 1.5, '2', null]) {
    raw.shift = bad;
    assert.equal(read().shift, 0, JSON.stringify(bad));
  }
  raw.standIns = { 0: 'zoie', 16: 'grace', x: 'grace', 123: 'grace', 2: 'not an id!', 3: 7 };
  assert.deepEqual(read().standIns, { 0: 'zoie' });
  raw.standIns = 'zoie';
  assert.deepEqual(read().standIns, {});
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/session.test.mjs`
Expected: the new tests FAIL (`S.plannedServerAt is not a function`; `S.serveOrderVectorFails is not a function`; `shift` is `undefined`), and the schema-3 migration test fails on the two new fields.

- [ ] **Step 3: Implement in `src/session.js`.**

Replace `emptySet` and its doc comment (lines 28-36):

```js
/** A set nobody has touched yet. `servedFirst` is null until the coach answers the set bar's
 * question (or the first stat tap answers it); `points` is one letter per rally (`U` we won it,
 * `T` they did) and is the set's score once it is non-empty; `pending` is the stat whose In tap
 * opened a rally nobody has won yet. Invariants: `points !== ''` implies `servedFirst !== null`;
 * `pending !== null` implies `servedFirst !== null` and no typed score.
 * `serveBy` maps a rally's index in `points` to the player whose serve tap served it (contract v5's `servers` is built from it).
 * `shift` is a whole number of turns added to the set's planned serve order, and `standIns` maps an
 * order index to the player serving that spot instead of the planned one (spec 2026-10-08 §2). */
function emptySet() {
  return { score: null, counts: {}, servedFirst: null, points: '', pending: null, serveBy: {}, shift: 0, standIns: {} };
}
```

After `setServer` (line 528), add:

```js
/** `a mod m` that stays in 0..m-1 for a negative `a` too. */
function mod(a, m) {
  return ((a % m) + m) % m;
}

/** The order index for rally `at` of a logged set (spec §3 steps 1-4): count our side-outs before
 * `at`; the turn is that count while we serve rally `at`, and the next one while they do. */
function planIndex(set, length, at) {
  let serving = set.servedFirst ? 'U' : 'T';
  let t = 0;
  for (let i = 0; i < at && i < set.points.length; i += 1) {
    if (set.points[i] === 'U' && serving === 'T') t += 1;
    serving = set.points[i];
  }
  const turn = serving === 'U' ? t : t + 1;
  return mod(turn + (set.shift ?? 0), length);
}

/** Who serves rally `at` of a logged set under its plan: our server when we serve it, else our next server.
 * Null without a plan, for a typed set, before serve-first is answered, or on an empty spot. */
export function plannedServerAt(set, order, at) {
  if (!set || !Array.isArray(order) || order.length === 0) return null;
  if (isTypedSet(set) || set.servedFirst === null) return null;
  const idx = planIndex(set, order.length, at);
  return (set.standIns ?? {})[idx] ?? order[idx] ?? null;
}

/** plannedServerAt at the end of the log: the row to highlight. */
export function plannedServer(set, order) {
  return plannedServerAt(set, order, set ? set.points.length : 0);
}
```

Directly above `function parseSetRecord(value) {` (line 775), add:

```js
/** A stored alignment's `shift`: whole turns, below MAX_ROSTER_PLAYERS (the longest order). */
function isShift(x) {
  return Number.isInteger(x) && x >= 0 && x < MAX_ROSTER_PLAYERS;
}

/** A `standIns` key: an order index, written by JSON as one or two digits, below MAX_ROSTER_PLAYERS. */
function isOrderIndexKey(k) {
  return /^\d{1,2}$/.test(k) && Number(k) < MAX_ROSTER_PLAYERS;
}

function isPlayerId(x) {
  return typeof x === 'string' && ID_PATTERN.test(x);
}
```

Replace the end of `parseSetRecord` (lines 798-805, from the `serveBy` comment through the `return`) with:

```js
  // contract v5's who-served map: missing in an older save, and a bad entry is skipped, never fatal.
  const serveBy = {};
  if (isPlainObject(value.serveBy)) {
    for (const [k, id] of Object.entries(value.serveBy)) {
      if (/^\d{1,3}$/.test(k) && Number(k) < MAX_POINTS && typeof id === 'string' && ID_PATTERN.test(id)) serveBy[k] = id;
    }
  }
  // The planned-server alignment (4.6.0): missing in an older save; a bad value is reset, never fatal.
  const shift = isShift(value.shift) ? value.shift : 0;
  const standIns = {};
  if (isPlainObject(value.standIns)) {
    for (const [k, id] of Object.entries(value.standIns)) if (isOrderIndexKey(k) && isPlayerId(id)) standIns[k] = id;
  }
  return { score, counts, servedFirst: value.servedFirst, points: value.points, pending, serveBy, shift, standIns };
```

Add `SERVE_ORDER_VECTOR` to the end of the single-line vectors import on line 4:

```js
import { ROSTER_VECTOR, STATS_VECTOR, ROSTER_V2_VECTOR, STATS_V2_VECTOR, STATS_V4_VECTOR, STATS_V5_VECTOR, STATS_V4_AS_V5, STATS_V2_AS_V5, STATS_V3_VECTOR, STATS_V3_AS_V5, ROSTER_V1_AS_V6, STATS_V1_AS_DAY, ROSTER_V3_VECTOR, ROSTER_V6_VECTOR, ROSTER_V3_AS_V6, ROSTER_V2_AS_V6, SERVE_ORDER_VECTOR } from './vectors.js';
```

Directly above `export function runSelfCheck() {` (line 1236), add:

```js
/** True when the phone's prediction disagrees with the Planner's replay on any rally we served in
 * `vector` (`{ order, servedFirst, points, servers }`, the shape of SERVE_ORDER_VECTOR) — the
 * self-check's contract-6 leg. Which rallies we served is worked out from `points` by the reading
 * rule, not from `servers`. Pure, so a test can hand it a bent copy. */
export function serveOrderVectorFails(vector) {
  const set = { score: null, counts: {}, servedFirst: vector.servedFirst, points: vector.points, pending: null, serveBy: {}, shift: 0, standIns: {} };
  for (let i = 0; i < vector.points.length; i += 1) {
    const weServe = i === 0 ? vector.servedFirst : vector.points[i - 1] === 'U';
    if (weServe && plannedServerAt(set, vector.order, i) !== vector.servers[i]) return true;
  }
  return false;
}
```

In `runSelfCheck`, directly before `return { ok: true };`, add:

```js
    // Contract 6: the phone's prediction agrees with the Planner's replay on every rally we served.
    if (serveOrderVectorFails(SERVE_ORDER_VECTOR)) return { ok: false, error: 'serve order vector' };
```

- [ ] **Step 4: Run the whole unit suite**

Run: `npm test`
Expected: all pass (`ℹ fail 0`), with no skipped tests. List any other existing expectation you had to update and why.

- [ ] **Step 5: Checkpoint — do not commit; leave changes in the working tree.**

---

### Task 3: Store the plan — `serveOrders` at ingest, merge and load

**Files:**
- Modify: `src/session.js` (`newDayFromRoster` :162-188; `mergeDayRoster` :206-293; add `serveOrdersFrom`, `sameOrder`, `serveOrderOf`, `forgetAlignment` near `padSetPlayerIds` :116-122; add `parseServeOrder` and extend `parseGame` :869-916)
- Test: `test/session.test.mjs` (append)

**Interfaces:**
- Consumes: `shift`/`standIns` on set records (Task 2).
- Produces:
  - Game shape gains `serveOrders: ((string|null)[] | null)[]`, `MAX_SETS` long.
  - Internal: `serveOrderOf(game, n) → (string|null)[] | null` (tolerant of a game with no `serveOrders`, e.g. a schema-1 migration); `forgetAlignment(history, n) → history` (drops set n's `align` entries and strips `alignBefore` from its count entries).

- [ ] **Step 1: Write the failing tests** — append to `test/session.test.mjs`:

```js
const NOW = '2026-09-19T09:00:00Z';
/** Eight players; set 1 ticks all eight with a slot order of the first six, set 2 a 7-long Train
 * order, set 3 no plan. Gia and Hal are ticked but in no plan. */
const PLANNED = {
  v: 6, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: ['Ana Lopez', 'Bea', 'Cat', 'Dee', 'Eve', 'Fay', 'Gia', 'Hal'].map((name) => ({ id: name.slice(0, 3).toLowerCase(), name })),
  games: [{ gameId: 'g', opponent: 'Lions', sets: [255, 255, 63], serve: ['012345', '0123456', null] }],
};
const planned = (serve = PLANNED.games[0].serve) => S.newDayFromRoster({ ...PLANNED, games: [{ ...PLANNED.games[0], serve }] }, NOW);
const pset = (s, n = 1) => s.games[0].sets[n - 1];
const order = (s, n = 1) => s.games[0].serveOrders[n - 1];

test('ingest resolves each set’s serve string to player ids: base 32, "-" an empty spot, null no plan', () => {
  assert.deepEqual(planned(['01-345', '0123456', null]).games[0].serveOrders, [
    ['ana', 'bea', null, 'dee', 'eve', 'fay'], ['ana', 'bea', 'cat', 'dee', 'eve', 'fay', 'gia'], null, null, null,
  ]);
  const twelve = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const wide = S.newDayFromRoster({ v: 6, kind: 'roster', date: 'd', team: 't', players: twelve, games: [{ gameId: 'g', opponent: 'o', sets: [4095], serve: ['ab0123'] }] }, NOW);
  assert.deepEqual(wide.games[0].serveOrders[0], ['p10', 'p11', 'p0', 'p1', 'p2', 'p3']);
  assert.deepEqual(S.newDayFromRoster(rosterV3, NOW).games[0].serveOrders, [null, null, null, null, null], 'an older roster has no plan');
});

test('a re-paste takes each covered set’s incoming order; a changed order resets that set’s alignment and its Undo steps, an unchanged one keeps them', () => {
  let s = S.setServedFirst(S.openDayRoster(S.newSession(), PLANNED, NOW).session, 'g', 1, true);
  const align = { kind: 'align', n: 1, at: 0, rule: 'shift', playerId: 'cat', forId: 'ana', shiftBefore: 0, standInsBefore: {} };
  const minus = { kind: 'count', n: 1, playerId: 'cat', stat: 'serve', side: 'in', delta: -1, alignBefore: { shift: 2, standIns: {} } };
  const g = s.games[0];
  s = { ...s, games: [{ ...g, sets: [{ ...g.sets[0], shift: 2, standIns: { 4: 'gia' } }, ...g.sets.slice(1)], history: [align, minus] }] };

  const same = S.openDayRoster(s, PLANNED, NOW);
  assert.equal(same.kind, 'sameDay');
  assert.deepEqual([pset(same.session).shift, pset(same.session).standIns, same.session.games[0].history], [2, { 4: 'gia' }, [align, minus]]);

  const changed = S.openDayRoster(s, { ...PLANNED, games: [{ ...PLANNED.games[0], sets: [255], serve: ['102345'] }] }, NOW).session;
  assert.deepEqual(order(changed), ['bea', 'ana', 'cat', 'dee', 'eve', 'fay']);
  assert.deepEqual([pset(changed).shift, pset(changed).standIns], [0, {}]);
  const { alignBefore, ...plainMinus } = minus;
  assert.deepEqual(changed.games[0].history, [plainMinus], 'no Undo can restore an alignment of the old plan');
  assert.deepEqual(order(changed, 2), ['ana', 'bea', 'cat', 'dee', 'eve', 'fay', 'gia'], 'a slot the roster no longer covers keeps its order');
});

test('a re-paste appends a new game with its own plan, and leaves a game it does not name untouched', () => {
  const s = S.openDayRoster(S.newSession(), PLANNED, NOW).session;
  const merged = S.openDayRoster(s, { ...PLANNED, games: [{ gameId: 'g2', opponent: 'Falcons', sets: [3], serve: ['101010'] }] }, NOW).session;
  assert.deepEqual(merged.games[1].serveOrders, [['bea', 'ana', 'bea', 'ana', 'bea', 'ana'], null, null, null, null]);
  assert.deepEqual(merged.games[0].serveOrders, s.games[0].serveOrders);
});

test('a saved day keeps serveOrders, reads a missing list as five nulls, and nulls a bad entry', () => {
  const day = planned();
  assert.deepEqual(S.parseSession(S.serialiseSession(day)).value.games[0].serveOrders, day.games[0].serveOrders);
  const envelope = JSON.parse(S.serialiseSession(day));
  const read = () => S.parseSession(JSON.stringify(envelope)).value.games[0].serveOrders;
  delete envelope.session.games[0].serveOrders;
  assert.deepEqual(read(), [null, null, null, null, null], 'a 4.5.0 save has none');
  envelope.session.games[0].serveOrders = 'nope';
  assert.deepEqual(read(), [null, null, null, null, null]);
  envelope.session.games[0].serveOrders = [
    ['ana'], // too short
    ['ana', 'bea', 'cat', 'dee', 'eve', 'zed'], // zed is not in the directory
    '012345', // not resolved
    ['ana', null, 'cat', 'dee', 'eve', 'fay'], // an empty spot is fine
    Array(17).fill('ana'), // too long
  ];
  assert.deepEqual(read(), [null, null, null, ['ana', null, 'cat', 'dee', 'eve', 'fay'], null]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/session.test.mjs`
Expected: the four new tests FAIL (`serveOrders` is `undefined`).

- [ ] **Step 3: Implement in `src/session.js`.**

After `padSetPlayerIds` (line 122), add:

```js
/** One game's planned serve orders, MAX_SETS long (contract 6): each set's serve string resolved to
 * player ids once, here at ingest — a character is a base-32 index into the roster's own directory,
 * `-` an empty spot (null) — or null when the roster has no plan for that set. `serve` is missing on
 * a hand-built v3-shaped roster, which is read as no plan at all. */
function serveOrdersFrom(serve, rosterPlayers) {
  const out = [];
  for (let i = 0; i < MAX_SETS; i += 1) {
    const text = Array.isArray(serve) ? serve[i] : undefined;
    out.push(typeof text === 'string' ? [...text].map((c) => (c === '-' ? null : rosterPlayers[parseInt(c, 32)].id)) : null);
  }
  return out;
}

/** Two stored orders name the same servers in the same spots (null and missing are the same). */
function sameOrder(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return (Array.isArray(a) ? a : null) === (Array.isArray(b) ? b : null);
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Set n's planned serve order, or null. Tolerant of a game with no `serveOrders` at all (a schema-1
 * migration builds games without one). */
function serveOrderOf(game, n) {
  return Array.isArray(game.serveOrders) ? game.serveOrders[n - 1] ?? null : null;
}

/** Forgets set n's re-alignment in history: its align entries go and its count entries lose
 * `alignBefore`, so no Undo can bring back an alignment that described another plan. */
function forgetAlignment(history, n) {
  return history
    .filter((h) => !(h.kind === 'align' && h.n === n))
    .map((h) => {
      if (h.kind !== 'count' || h.n !== n || h.alignBefore === undefined) return h;
      const { alignBefore, ...rest } = h;
      return rest;
    });
}
```

In `newDayFromRoster`, the game literal (lines 165-177) gains `serveOrders` after `history: []`:

```js
    sets: Array(MAX_SETS).fill(null),
    activeSet: 1,
    history: [],
    // The plan, resolved to ids once, like the masks above (spec §2).
    serveOrders: serveOrdersFrom(g.serve, roster.players),
  }));
```

In `mergeDayRoster`, replace lines 252-260 (from the "A slot at or beyond the new count" comment through the matched game's `return`) with:

```js
    // A slot at or beyond the new count is provably unplayed (setCount >= highestPlayedSlot + 1,
    // so no i >= setCount can be the highest-played slot), so nulling its record here — same as
    // clearSet — discards no score and no count, only leftover zeroed counts a minus-mode netback
    // may have left behind.
    // The plan (contract 6): each set the roster covers takes the incoming order. An order that
    // changed resets that set's alignment and forgets its re-align Undo steps, because they
    // described the old plan. A slot beyond the incoming sets keeps what it had.
    const incomingOrders = serveOrdersFrom(rg.serve, roster.players);
    const storedOrders = Array.isArray(g.serveOrders) ? g.serveOrders : Array(MAX_SETS).fill(null);
    const changed = (i) => i < rg.sets.length && !sameOrder(storedOrders[i], incomingOrders[i]);
    const serveOrders = Array.from({ length: MAX_SETS }, (_, i) => (i < rg.sets.length ? incomingOrders[i] : storedOrders[i] ?? null));
    const sets = g.sets.map((set, i) => (i >= setCount ? null : set && changed(i) ? { ...set, shift: 0, standIns: {} } : set));
    // Mirror clearSet: a slot the merge just retired must not leave a history entry stamped at
    // it, or undo/export can resurrect a tab the UI no longer shows (see mergeDayRoster's tests).
    let history = g.history.filter((h) => h.n <= setCount);
    for (let i = 0; i < MAX_SETS; i += 1) if (changed(i)) history = forgetAlignment(history, i + 1);
    return { ...g, opponent: rg.opponent, setCount, setPlayerIds, sets, history, serveOrders };
```

The appended-game literal (lines 274-282) gains the same field after `history: []`:

```js
    history: [],
    serveOrders: serveOrdersFrom(rg.serve, roster.players),
  }));
```

Above `parseGame` (line 865), add:

```js
/** One stored serve order: null, or 6 to MAX_ROSTER_PLAYERS entries, each a directory id or null.
 * Anything else becomes null (no plan) — tolerant, never fatal, like serveBy. */
function parseServeOrder(value, directoryIds) {
  if (!Array.isArray(value) || value.length < 6 || value.length > MAX_ROSTER_PLAYERS) return null;
  for (const id of value) if (id !== null && !(typeof id === 'string' && directoryIds.has(id))) return null;
  return [...value];
}
```

In `parseGame`, replace the final `return` (line 915) with:

```js
  // The planned serve orders (4.6.0): missing in an older save; a bad entry is no plan, never fatal.
  const serveOrders = [];
  for (let i = 0; i < MAX_SETS; i += 1) serveOrders.push(parseServeOrder(Array.isArray(value.serveOrders) ? value.serveOrders[i] : null, directoryIds));
  return { gameId: value.gameId, opponent: value.opponent, setCount: value.setCount, setPlayerIds, sets, activeSet: value.activeSet, history, serveOrders };
```

and update the comment above `parseGame` (line 865) to `// v3 game shape: { gameId, opponent, setCount, setPlayerIds, sets, activeSet, history, serveOrders }.`

- [ ] **Step 4: Run the whole unit suite**

Run: `npm test`
Expected: all pass (`ℹ fail 0`). List any existing expectation you had to update and why.

- [ ] **Step 5: Checkpoint — do not commit; leave changes in the working tree.**

---

### Task 4: Re-align on a Serve tap, and everything that undoes it

**Files:**
- Modify: `src/session.js` (add `firstServeOfTurn`, `realign`, `alignOf` above `tap` :425-434; `tap` :436-489; `stripInference` :548-556; `clearPoints` :590-602; `undo` :604-642; `setScore` :644-656; `parseHistoryEntry` :819-863 plus helpers above it)
- Modify: `test/harden-app.test.mjs` (driver after step 12; the steps list)
- Test: `test/session.test.mjs` (codec import line :4; append)

**Interfaces:**
- Consumes: `planIndex`, `mod`, `plannedServerAt`, `plannedServer`, `isShift`, `isOrderIndexKey`, `isPlayerId` (Task 2); `serveOrderOf`, `forgetAlignment` (Task 3).
- Produces (Task 5 reads these):
  - Align history entry, pushed right after the tap's count entry: `{ kind: 'align', n, at, rule: 'back' | 'shift' | 'standIn', playerId, forId /* the planned player Q at that spot, or null */, shiftBefore, standInsBefore }`.
  - A count entry from a minus that cancelled a re-aligned opener carries `alignBefore: { shift, standIns }`.
  - `undo(s, gameId)` returns `{ session, undone }` where `undone.kind` may be `'align'`.

- [ ] **Step 1: Write the failing tests.**

Change `test/session.test.mjs` line 4 to `import { decodeDayRoster, decodeDayStats, encodeDayStats, MAX_SETS, MAX_POINTS } from '../src/codec.js';`. Append:

```js
const pt = (s, pid, stat, side, delta = 1, n = 1) => S.tap(s, 'g', n, pid, stat, side, delta);
const kinds = (s) => s.games[0].history.map((h) => h.kind);

test('a Serve tap for the planned server changes nothing', () => {
  const s = pt(planned(), 'ana', 'serve', 'in');
  assert.deepEqual(kinds(s), ['count']);
  assert.deepEqual([pset(s).shift, pset(s).standIns], [0, {}]);
});

test('a Serve tap for another planned player re-aligns the plan to her (rule 2); later taps in the turn never re-align', () => {
  let s = pt(planned(), 'cat', 'serve', 'in');
  assert.equal(pset(s).shift, 2);
  assert.deepEqual(s.games[0].history.at(-1), { kind: 'align', n: 1, at: 0, rule: 'shift', playerId: 'cat', forId: 'ana', shiftBefore: 0, standInsBefore: {} });
  assert.equal(S.plannedServer(pset(s), order(s)), 'cat');
  s = pt(s, 'cat', 'serve', 'out'); // rally 0 to Us, then her next serve is out
  assert.deepEqual(kinds(s), ['count', 'align', 'count'], 'a later serve tap in the same turn never re-aligns');
  assert.equal(S.plannedServer(pset(s), order(s)), 'dee', 'the plan carries on from her');
});

test('rule 2 picks the nearest spot round the order, forward on a tie', () => {
  const shiftFor = (serve) => pset(pt(planned([serve, null, null]), 'cat', 'serve', 'in')).shift;
  assert.equal(shiftFor('012342'), 5, 'Cat at 2 and 5: one back beats two forward');
  assert.equal(shiftFor('012325'), 2, 'Cat at 2 and 4: a tie, so forward');
});

test('a player outside the plan stands in (rule 3), and the planned player comes back in for her (rule 1)', () => {
  let s = pt(planned(), 'gia', 'serve', 'out');
  assert.deepEqual(pset(s).standIns, { 0: 'gia' });
  assert.deepEqual(s.games[0].history.at(-1), { kind: 'align', n: 1, at: 0, rule: 'standIn', playerId: 'gia', forId: 'ana', shiftBefore: 0, standInsBefore: {} });
  for (const pid of ['bea', 'cat', 'dee', 'eve', 'fay']) s = pt(s, pid, 'serve', 'out'); // side-out, then lost: one turn each
  assert.equal(kinds(s).filter((k) => k === 'align').length, 1, 'the plan held all the way round');
  assert.equal(S.plannedServer(pset(s), order(s)), 'gia', 'her spot comes round again');
  s = pt(s, 'ana', 'serve', 'out');
  assert.deepEqual(pset(s).standIns, {});
  assert.deepEqual(s.games[0].history.at(-1), { kind: 'align', n: 1, at: 12, rule: 'back', playerId: 'ana', forId: 'ana', shiftBefore: 0, standInsBefore: { 0: 'gia' } });
});

test('on an empty spot the tapped player stands in for nobody', () => {
  const s = pt(planned(['-12345', null, null]), 'gia', 'serve', 'in');
  assert.deepEqual(s.games[0].history.at(-1), { kind: 'align', n: 1, at: 0, rule: 'standIn', playerId: 'gia', forId: null, shiftBefore: 0, standInsBefore: {} });
  assert.equal(S.plannedServer(pset(s), order(s)), 'gia');
});

test('the first Serve tap of our turn re-aligns even when it settles their rally; a set with no plan never does', () => {
  let s = pt(planned(), 'bea', 'return', 'in'); // they serve first; rally 0 open
  s = pt(s, 'cat', 'serve', 'in'); // rally 0 to Us; Cat serves our first turn — the plan says Bea
  assert.equal(s.games[0].history.at(-2).points, 'U');
  assert.deepEqual(s.games[0].history.at(-1), { kind: 'align', n: 1, at: 1, rule: 'shift', playerId: 'cat', forId: 'bea', shiftBefore: 0, standInsBefore: {} });
  assert.deepEqual(kinds(pt(planned(), 'cat', 'serve', 'in', 1, 3)), ['count'], 'set 3 has no plan');
});

test('a tap that replaces the rally’s server is still the turn’s first, so it is checked again', () => {
  let s = S.setServedFirst(planned(), 'g', 1, true);
  s = { ...s, games: [{ ...s.games[0], sets: [{ ...pset(s), serveBy: { 0: 'ana' } }, ...s.games[0].sets.slice(1)] }] };
  s = pt(s, 'cat', 'serve', 'in');
  assert.equal(s.games[0].history.at(-2).serveBefore, 'ana');
  assert.equal(s.games[0].history.at(-1).rule, 'shift');
});

test('Undo takes back the re-align first and keeps the stat; a second Undo takes back the tap', () => {
  let u = S.undo(pt(planned(), 'cat', 'serve', 'in'), 'g');
  assert.equal(u.undone.kind, 'align');
  let s = u.session;
  assert.deepEqual([pset(s).shift, pset(s).serveBy, S.getCount(s.games[0], 1, 'cat').serve.in], [0, { 0: 'cat' }, 1]);
  assert.equal(S.plannedServer(pset(s), order(s)), 'ana');
  u = S.undo(s, 'g');
  assert.equal(u.undone.kind, 'count');
  s = u.session;
  assert.deepEqual([pset(s).serveBy, pset(s).servedFirst, S.getCount(s.games[0], 1, 'cat').serve.in], [{}, null, 0]);
  const standIn = S.undo(pt(planned(), 'gia', 'serve', 'in'), 'g').session;
  assert.deepEqual(pset(standIn).standIns, {});
});

test('a minus on the opener reverses its re-align, and Undo of that minus restores it', () => {
  let s = pt(planned(), 'gia', 'serve', 'in'); // Gia stands in; rally 0 open
  s = pt(s, 'gia', 'serve', 'in', -1);
  assert.deepEqual([pset(s).pending, pset(s).serveBy, pset(s).standIns], [null, {}, {}]);
  assert.deepEqual(s.games[0].history.at(-1).alignBefore, { shift: 0, standIns: { 0: 'gia' } });
  s = S.undo(s, 'g').session;
  assert.deepEqual([pset(s).pending, pset(s).serveBy, pset(s).standIns], ['serve', { 0: 'gia' }, { 0: 'gia' }]);
});

test('minus on the opener reverses its re-align even with other entries in between; a minus elsewhere leaves it', () => {
  let s = pt(planned(), 'ana', 'serve', 'out'); // rally 0: Ana served as planned, and lost it
  s = pt(s, 'bea', 'return', 'in'); // they serve rally 1; Bea's return opens it
  s = pt(s, 'cat', 'serve', 'in'); // rally 1 to Us; Cat serves rally 2 — the plan says Bea
  assert.equal(pset(s).shift, 1);
  s = pt(s, 'ana', 'serve', 'out', -1); // an old miscount fixed: not the opener, nothing cancelled
  s = S.tap(s, 'g', 2, 'dee', 'return', 'in', 1); // a tap in set 2 in between
  assert.equal(pset(s).shift, 1);
  s = pt(s, 'cat', 'serve', 'in', -1); // the wrong row: cancels rally 2 and its re-align
  assert.deepEqual([pset(s).pending, pset(s).serveBy[2], pset(s).shift], [null, undefined, 0]);
  assert.deepEqual(s.games[0].history.at(-1).alignBefore, { shift: 1, standIns: {} });
  s = S.undo(s, 'g').session;
  assert.deepEqual([pset(s).pending, pset(s).serveBy[2], pset(s).shift], ['serve', 'cat', 1]);
  const settled = pt(pt(planned(), 'cat', 'serve', 'out'), 'cat', 'serve', 'out', -1); // no open rally
  assert.equal(pset(settled).shift, 2, 'a minus with nothing open leaves the alignment alone');
});

test('clear points, a typed score and replacing the log reset the alignment and drop its Undo steps', () => {
  const plain = (s) => [pset(s).shift, pset(s).standIns, kinds(s)];
  const lostRally = pt(planned(), 'cat', 'serve', 'out'); // shift 2, log 'T'
  assert.deepEqual(plain(S.clearPoints(lostRally, 'g', 1)), [0, {}, ['count']]);
  assert.deepEqual(plain(S.replaceLogWithScore(lostRally, 'g', 1, [25, 20])), [0, {}, ['count']]);
  const openRally = pt(planned(), 'gia', 'serve', 'in'); // stand-in, rally open, no letters yet
  assert.deepEqual(plain(S.setScore(openRally, 'g', 1, [25, 20])), [0, {}, ['count']]);
  const cleared = S.clearPoints(pt(pt(planned(), 'cat', 'serve', 'in'), 'cat', 'serve', 'in', -1), 'g', 1);
  assert.deepEqual(kinds(cleared), ['count', 'count']);
  assert.equal('alignBefore' in cleared.games[0].history[1], false, 'stripInference strips alignBefore');
});

test('flipping serve-first keeps the alignment and works the prediction out again', () => {
  let s = pt(planned(), 'cat', 'serve', 'in'); // shift 2
  s = S.setServedFirst(s, 'g', 1, false);
  assert.equal(pset(s).shift, 2);
  assert.equal(S.plannedServer(pset(s), order(s)), 'dee', 'receiving first: our next server is entry 1 + 2');
});

test('a serve tap that would serve past MAX_POINTS records no server and never re-aligns', () => {
  let s = S.setServedFirst(planned(), 'g', 1, true);
  s = { ...s, games: [{ ...s.games[0], sets: [{ ...pset(s), points: 'T'.repeat(MAX_POINTS - 1) }, ...s.games[0].sets.slice(1)] }] };
  s = pt(s, 'cat', 'serve', 'in'); // the side-out fills the last rally; the one Cat would serve is past the cap
  assert.equal(pset(s).points.length, MAX_POINTS);
  assert.deepEqual([pset(s).serveBy, pset(s).shift, kinds(s)], [{}, 0, ['count']]);
});

test('at the 400-entry history cap a re-align keeps both its entries, and both still undo', () => {
  let s = planned();
  const filler = Array.from({ length: S.UNDO_LIMIT }, () => ({ kind: 'point', n: 2, winner: 'U' }));
  s = { ...s, games: [{ ...s.games[0], history: filler }] };
  s = pt(s, 'cat', 'serve', 'in');
  assert.equal(s.games[0].history.length, S.UNDO_LIMIT);
  assert.deepEqual(kinds(s).slice(-2), ['count', 'align']);
  s = S.undo(s, 'g').session;
  assert.equal(pset(s).shift, 0);
  s = S.undo(s, 'g').session;
  assert.equal(S.getCount(s.games[0], 1, 'cat').serve.in, 0);
});

test('a saved session keeps align entries and alignBefore; a bad one is refused like any bad history entry', () => {
  let s = pt(planned(), 'cat', 'serve', 'in');
  s = pt(s, 'cat', 'serve', 'in', -1); // history: count, align, count with alignBefore
  const round = S.parseSession(S.serialiseSession(s));
  assert.equal(round.ok, true);
  assert.deepEqual(round.value.games[0].history, s.games[0].history);
  // The day's only game is dropped, so the day is unreadable — the same as a bad count entry today.
  for (const bad of [{ rule: 'oops' }, { at: -1 }, { at: MAX_POINTS }, { shiftBefore: 16 }, { standInsBefore: { 0: 7 } }, { standInsBefore: null }, { forId: 'not an id!' }, { playerId: undefined }]) {
    const envelope = JSON.parse(S.serialiseSession(s));
    Object.assign(envelope.session.games[0].history[1], bad);
    assert.equal(S.parseSession(JSON.stringify(envelope)).ok, false, JSON.stringify(bad));
  }
  for (const alignBefore of [{ shift: 2, standIns: { x: 'cat' } }, { shift: -1, standIns: {} }, 'x']) {
    const envelope = JSON.parse(S.serialiseSession(s));
    envelope.session.games[0].history[2].alignBefore = alignBefore;
    assert.equal(S.parseSession(JSON.stringify(envelope)).ok, false, JSON.stringify(alignBefore));
  }
});

test('a 4.5.0 save (no serveOrders, shift or standIns) loads cleanly and records as before', () => {
  const s = S.tap(open(), 'game-1', 1, 'grace', 'serve', 'in', 1);
  const envelope = JSON.parse(S.serialiseSession(s));
  for (const g of envelope.session.games) {
    delete g.serveOrders;
    for (const set of g.sets) if (set) { delete set.shift; delete set.standIns; }
  }
  const loaded = S.parseSession(JSON.stringify(envelope));
  assert.equal(loaded.ok, true);
  const g = loaded.value.games[0];
  assert.deepEqual([g.serveOrders, g.sets[0].shift, g.sets[0].standIns], [[null, null, null, null, null], 0, {}]);
  assert.equal(S.plannedServer(g.sets[0], g.serveOrders[0]), null);
  const next = S.tap(loaded.value, 'game-1', 1, 'zoie', 'serve', 'in', 1);
  assert.deepEqual(next.games[0].history.map((h) => h.kind), ['count', 'count'], 'no plan, no re-align');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/session.test.mjs`
Expected: the new re-align, Undo, minus, clear, persistence tests FAIL (no `align` entries; `shift` stays 0). The "planned server changes nothing", "MAX_POINTS" and "4.5.0 save" tests may already pass; that is fine.

- [ ] **Step 3: Implement in `src/session.js`.**

Above `rallyOpener` (line 425), add:

```js
/** Is rally `at` (one we serve) the first of its serve turn named by a serve tap? True when no
 * earlier rally of the same turn has a serveBy entry — the rule v5's `servers` uses. A tap that
 * replaces serveBy[at] itself is still the first. */
function firstServeOfTurn(set, at) {
  const serveBy = set.serveBy ?? {};
  for (let i = at - 1; i >= 0; i -= 1) {
    const weServed = i === 0 ? set.servedFirst === true : set.points[i - 1] === 'U';
    if (!weServed) break;
    if (serveBy[i] !== undefined) return false;
  }
  return true;
}

/** The re-align a Serve tap causes (spec §4), or null when none. `set` is the set after the tap's
 * letters and serveBy; `at` is the rally the tap served. Fires only for the turn's first serve tap
 * and only when the tapped player is not the one the plan predicts. First rule that applies wins:
 * back (the planned player returns for her stand-in), shift (she is the server at another spot —
 * the nearest round the order, forward on a tie), standIn (anyone else). */
function realign(set, order, at, playerId) {
  if (!Array.isArray(order) || order.length === 0) return null;
  if (!firstServeOfTurn(set, at)) return null;
  if (plannedServerAt(set, order, at) === playerId) return null;
  const length = order.length;
  const shift = set.shift ?? 0;
  const standIns = set.standIns ?? {};
  const idx = planIndex(set, length, at);
  const planned = order[idx] ?? null;
  if (playerId === planned) {
    const rest = { ...standIns };
    delete rest[idx];
    return { set: { ...set, standIns: rest }, rule: 'back', forId: planned };
  }
  let best = -1;
  let bestDistance = Infinity;
  for (let j = 0; j < length; j += 1) {
    if (j === idx || (standIns[j] ?? order[j]) !== playerId) continue;
    const forward = mod(j - idx, length);
    const distance = Math.min(forward, length - forward);
    if (distance < bestDistance || (distance === bestDistance && forward === distance)) {
      best = j;
      bestDistance = distance;
    }
  }
  if (best !== -1) return { set: { ...set, shift: mod(shift + best - idx, length) }, rule: 'shift', forId: planned };
  return { set: { ...set, standIns: { ...standIns, [idx]: playerId } }, rule: 'standIn', forId: planned };
}

/** The re-align the opener's tap caused, or null. tap() pushes it straight after the opener's own
 * entry, so it is the opener's next history entry whatever was recorded since (a minus on another
 * count, a tap in another set). */
function alignOf(history, opener, openAt) {
  const i = history.lastIndexOf(opener);
  if (i === -1) return null;
  const next = history[i + 1];
  return next && next.kind === 'align' && next.n === opener.n && next.at === openAt ? next : null;
}
```

Replace `tap` (lines 436-489) with:

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
    let align = null;
    if (entry.delta > 0 && !isTypedSet(prevSet)) {
      const inferred = inferTap(prevSet, stat, side);
      const room = Math.max(0, MAX_POINTS - prevSet.points.length);
      const appended = inferred.letters.slice(0, room).map((l) => l.letter).join('');
      const pendingBefore = prevSet.pending ?? null;
      const counted = game.sets[n - 1];
      sets = game.sets.slice();
      sets[n - 1] = { ...counted, servedFirst: inferred.servedFirst, points: counted.points + appended, pending: inferred.pending };
      if (stat === 'serve') {
        // The rally this serve tap served: after any rally the tap closed (a side-out or a
        // resolve), and the one its own Out closes. A later tap for the same rally replaces it.
        const at = prevSet.points.length + inferred.letters.filter((l) => l.why !== 'out').length;
        if (at < MAX_POINTS) {
          const serveBy = { ...(sets[n - 1].serveBy ?? {}) };
          entry.serveAt = at;
          if (serveBy[at] !== undefined) entry.serveBefore = serveBy[at];
          serveBy[at] = playerId;
          sets[n - 1] = { ...sets[n - 1], serveBy };
          // The turn's first serve tap for someone other than the planned server re-aligns the
          // plan to her (spec §4). Its own entry follows this one, so the first Undo takes it back.
          const realigned = realign(sets[n - 1], serveOrderOf(g, n), at, playerId);
          if (realigned) {
            const was = sets[n - 1];
            align = { kind: 'align', n, at, rule: realigned.rule, playerId, forId: realigned.forId, shiftBefore: was.shift ?? 0, standInsBefore: { ...(was.standIns ?? {}) } };
            sets[n - 1] = realigned.set;
          }
        }
      }
      if (appended !== '') entry.points = appended;
      if (prevSet.servedFirst === null) entry.servedFirstSet = true;
      if (pendingBefore !== inferred.pending) entry.pendingBefore = pendingBefore;
    } else if (entry.delta < 0 && !isTypedSet(prevSet) && (prevSet.pending ?? null) !== null && side === 'in' && stat === prevSet.pending) {
      // A minus on the tap that opened the open rally — the "wrong row" correction — cancels that
      // rally. Undo of this entry re-opens it through pendingBefore.
      const opener = rallyOpener(g.history, n);
      if (opener && opener.playerId === playerId && opener.stat === stat && opener.side === 'in') {
        sets = game.sets.slice();
        sets[n - 1] = { ...game.sets[n - 1], pending: null };
        const openAt = prevSet.points.length;
        const serveBy = prevSet.serveBy ?? {};
        if (stat === 'serve' && serveBy[openAt] === playerId) {
          const rest = { ...serveBy };
          delete rest[openAt];
          sets[n - 1] = { ...sets[n - 1], serveBy: rest };
          entry.serveCleared = openAt;
          // The opener's re-align goes with it; Undo of this minus puts it back (spec §5).
          const aligned = alignOf(g.history, opener, openAt);
          if (aligned) {
            const cur = sets[n - 1];
            entry.alignBefore = { shift: cur.shift ?? 0, standIns: { ...(cur.standIns ?? {}) } };
            sets[n - 1] = { ...cur, shift: aligned.shiftBefore, standIns: { ...aligned.standInsBefore } };
          }
        }
        entry.pendingBefore = prevSet.pending;
      }
    }
    const history = [...game.history, entry, ...(align ? [align] : [])].slice(-UNDO_LIMIT);
    return { ...game, sets, history };
  });
}
```

Replace `stripInference` (lines 548-556):

```js
/** That set's count entries lose their inference fields (they become plain count entries), so an
 * Undo after the log was cleared or replaced by a typed score reverses only the count. */
function stripInference(history, n) {
  return history.map((h) => {
    if (h.kind !== 'count' || h.n !== n) return h;
    const { points, servedFirstSet, pendingBefore, serveAt, serveBefore, serveCleared, alignBefore, ...plain } = h;
    return plain;
  });
}
```

Replace `clearPoints` (lines 590-602):

```js
/** Empties the set's log, forgets who served first and closes any open rally; the counts stay.
 * Drops that set's point and align entries from history the way clearSet drops by n, resets its
 * alignment to the plan, and strips the inference fields from its count entries, so undo can
 * never resurrect a rally or a re-align. */
export function clearPoints(s, gameId, n) {
  return withGame(s, gameId, (g) => {
    const set = g.sets[n - 1];
    if (!set || (set.points === '' && set.servedFirst === null)) return g;
    const sets = g.sets.slice();
    sets[n - 1] = { ...set, servedFirst: null, points: '', pending: null, serveBy: {}, shift: 0, standIns: {} };
    const history = stripInference(g.history.filter((h) => !((h.kind === 'point' || h.kind === 'align') && h.n === n)), n);
    return { ...g, sets, history };
  });
}
```

In `undo`, after the `if (last.kind === 'point') { … }` block (ends line 619), add:

```js
    if (last.kind === 'align') {
      // A re-align: the plan's alignment goes back; the serve tap before it stays (spec §4).
      const set = g.sets[last.n - 1];
      if (!set) return { ...g, history };
      const sets = g.sets.slice();
      sets[last.n - 1] = { ...set, shift: last.shiftBefore, standIns: { ...last.standInsBefore } };
      return { ...g, sets, history };
    }
```

and directly after the `serveCleared` line (line 634) add:

```js
    if (last.alignBefore !== undefined) next = { ...next, shift: last.alignBefore.shift, standIns: { ...last.alignBefore.standIns } };
```

In `setScore`, replace lines 653-654:

```js
    sets[n - 1] = { ...set, score: [score[0], score[1]], servedFirst: null, pending: null, serveBy: {}, shift: 0, standIns: {} };
    return { ...g, sets, history: stripInference(g.history.filter((h) => !(h.kind === 'align' && h.n === n)), n) };
```

Persistence. Directly above `function parseHistoryEntry(value) {` add:

```js
const ALIGN_RULES = ['back', 'shift', 'standIn'];

function isRallyIndex(x) {
  return Number.isInteger(x) && x >= 0 && x < MAX_POINTS;
}

/** A history entry's `standIns` snapshot, read strictly: any bad entry refuses the whole entry. */
function parseStandInsStrict(value) {
  if (!isPlainObject(value)) return undefined;
  const out = {};
  for (const [k, id] of Object.entries(value)) {
    if (!isOrderIndexKey(k) || !isPlayerId(id)) return undefined;
    out[k] = id;
  }
  return out;
}
```

Replace `parseHistoryEntry` (lines 819-863) with:

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
  if (value.kind === 'align') {
    if (!isRallyIndex(value.at) || !ALIGN_RULES.includes(value.rule) || !isPlayerId(value.playerId)) return undefined;
    if (value.forId !== null && !isPlayerId(value.forId)) return undefined;
    if (!isShift(value.shiftBefore)) return undefined;
    const standInsBefore = parseStandInsStrict(value.standInsBefore);
    if (standInsBefore === undefined) return undefined;
    return { kind: 'align', n: value.n, at: value.at, rule: value.rule, playerId: value.playerId, forId: value.forId, shiftBefore: value.shiftBefore, standInsBefore };
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
  if (value.serveAt !== undefined) {
    if (!isRallyIndex(value.serveAt)) return undefined;
    count.serveAt = value.serveAt;
  }
  if (value.serveBefore !== undefined) {
    if (typeof value.serveBefore !== 'string' || !ID_PATTERN.test(value.serveBefore)) return undefined;
    count.serveBefore = value.serveBefore;
  }
  if (value.serveCleared !== undefined) {
    if (!isRallyIndex(value.serveCleared)) return undefined;
    count.serveCleared = value.serveCleared;
  }
  if (value.alignBefore !== undefined) {
    const a = value.alignBefore;
    if (!isPlainObject(a) || !isShift(a.shift)) return undefined;
    const standIns = parseStandInsStrict(a.standIns);
    if (standIns === undefined) return undefined;
    count.alignBefore = { shift: a.shift, standIns };
  }
  return count;
}
```

- [ ] **Step 4: Pin the computed-key spread under obfuscation** in `test/harden-app.test.mjs`. `{ ...standIns, [idx]: playerId }` is the `transformObjectKeys` hazard this file exists for. In the DRIVER, after the step-12 `rec('undo.history', …)` line, add:

```js
  // 13. A serve tap by a player outside the plan stands her in: \`{ ...standIns, [idx]: playerId }\`
  //     is a computed key inside a spread, the same hazard as applyDelta. GAME2 set 1's plan names p1 only.
  let r = tap(undone.session, GAME2, 1, 'p2', 'serve', 'in', 1);
  rec('realign.set', r.games[1].sets[0]);
  rec('realign.top', r.games[1].history[r.games[1].history.length - 1]);
  rec('realign.planned', plannedServer(r.games[1].sets[0], r.games[1].serveOrders[0]));
  r = undo(r, GAME2).session;
  rec('realign.undone', r.games[1].sets[0].standIns);
```

Add `'realign.top'` to the `for (const step of [...])` list, and after the `undo.entry` assertion add:

```js
  assert.ok(baseline.includes('realign.top => {"kind":"align","n":1,"at":0,"rule":"standIn","playerId":"p2","forId":"p1","shiftBefore":0,"standInsBefore":{}}'), 'a stand-in re-align recorded');
  assert.ok(baseline.includes('realign.planned => "p2"'), 'the stand-in is predicted');
  assert.ok(baseline.includes('realign.undone => {}'), 'Undo took the stand-in back');
```

- [ ] **Step 5: Run the whole unit suite**

Run: `npm test`
Expected: all pass (`ℹ fail 0`), including the harden-app parity test (hardened transcript identical to baseline). List any existing expectation you had to update and why.

- [ ] **Step 6: Checkpoint — do not commit; leave changes in the working tree.**

---

### Task 5: Record screen — highlight, re-align toast, Undo label

**Files:**
- Modify: `src/ui.js` (session import line :6; add `alignText` after `showToast` :60-70; `renderRow` :589-601; `renderRecord` :603-675, at :618-622, :629 and :647-648; `onTapCount` :697-703)
- Modify: `src/styles.css` (after `.row:nth-child(even)` :111)
- Test: `test/ui.test.mjs` (imports :16-20; append)

**Interfaces:**
- Consumes: `plannedServer(set, order)` (Task 2); `game.serveOrders` (Task 3); the align entry `{ kind: 'align', rule, playerId, forId }` pushed right after its count entry (Task 4).
- Produces: markup Task 6's browser tests use — `<div class="row serving" data-serving="1" aria-current="true">`; toast `<div class="toast" role="status" aria-live="polite">…</div>` with the align phrases; Undo button text `↶ Undo re-align`.

- [ ] **Step 1: Write the failing tests.** In `test/ui.test.mjs`, add `import { readFileSync } from 'node:fs';` after line 17, and add `setPlayerTicked` to the session import (line 19):

```js
import { parseSession, STORAGE_KEY, newDayFromRoster, serialiseSession, getCount, tap, setServedFirst, tapPoint, setScore, setPlayerTicked, APP_VERSION, AUTHOR_NAME, COPYRIGHT_YEAR } from '../src/session.js';
```

Append:

```js
// ---- the planned server (docs/superpowers/specs/2026-10-08-server-highlight-design.md) ----
const PLAN = {
  v: 6, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: ['Ana Lopez', 'Bea', 'Cat', 'Dee', 'Eve', 'Fay', 'Gia'].map((name) => ({ id: name.slice(0, 3).toLowerCase(), name })),
  games: [{ gameId: 'g1', opponent: 'Lions', sets: [127, 63], serve: ['012345', null] }], // Gia is in set 1 but not in its plan; set 2 has no plan
};
const planDay = (serve = ['012345', null]) => newDayFromRoster({ ...PLAN, games: [{ ...PLAN.games[0], serve }] }, '2026-09-19T09:00:00Z');
const servingRows = (html) => html.match(/class="row serving"/g) ?? [];
const servingRow = (name) => new RegExp(`<div class="row serving" data-serving="1" aria-current="true">\\s*<div class="name">${name}</div>`);
const serveIn = (pid) => `[data-action="tap-count"][data-pid="${pid}"][data-stat="serve"][data-side="in"]`;
const toastSays = (text) => new RegExp(`<div class="toast" role="status" aria-live="polite">${text.replace(/[+.]/g, '\\$&')}</div>`);

test('the planned server’s row is highlighted while we serve and while we receive', async () => {
  let html = await renderWith(setServedFirst(planDay(), 'g1', 1, true), 'g1');
  assert.match(html, servingRow('Ana Lopez'));
  assert.equal(servingRows(html).length, 1);
  html = await renderWith(setServedFirst(planDay(), 'g1', 1, false), 'g1');
  assert.match(html, servingRow('Bea'), 'receiving: our next server');
  assert.equal(servingRows(html).length, 1);
  assert.match(html, /<div class="row">\s*<div class="name">Ana Lopez<\/div>/, 'every other row keeps the plain class');
});

test('no row is highlighted without a plan, for a typed set, before serve-first, on an empty spot, or when she is not ticked', async () => {
  const none = async (day, n, why) => assert.equal(servingRows(await renderWith(day, 'g1', n)).length, 0, why);
  await none(planDay(), 1, 'serve-first unanswered');
  await none(setServedFirst(planDay(), 'g1', 2, true), 2, 'no plan for set 2');
  await none(setServedFirst(newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z'), 'g1', 1, true), 1, 'an older roster');
  await none(setScore(planDay(), 'g1', 1, [25, 20]), 1, 'a typed set');
  await none(setServedFirst(planDay(['-12345', null]), 'g1', 1, true), 1, 'an empty spot');
  await none(setServedFirst(setPlayerTicked(planDay(), 'g1', 1, 'ana', false).session, 'g1', 1, true), 1, 'the predicted player is not ticked');
});

test('a Serve tap for someone else re-aligns: the toast names her, Undo reads ↶ Undo re-align and keeps the stat', async () => {
  const { document } = await bootWithSession(planDay());
  click(document, serveIn('cat'));
  let html = document.getElementById('app').innerHTML;
  assert.match(html, toastSays('Re-aligned to Cat'));
  assert.match(html, servingRow('Cat'));
  assert.match(html, /data-action="undo"[^>]*>↶ Undo re-align<\/button>/);
  click(document, '[data-action="undo"]');
  html = document.getElementById('app').innerHTML;
  assert.match(html, servingRow('Ana Lopez'));
  assert.match(html, /data-action="undo"[^>]*>↶ Undo Cat S in<\/button>/);
  assert.match(html, /data-pid="cat" data-stat="serve" data-side="in">1<\/button>/);
});

test('a re-align after a side-out keeps the scoring phrase first', async () => {
  const { document } = await bootWithSession(setServedFirst(planDay(), 'g1', 1, false));
  click(document, serveIn('cat')); // side-out to Us; the plan says Bea serves our first turn
  assert.match(document.getElementById('app').innerHTML, toastSays('Us +1 · side-out. Re-aligned to Cat'));
});

test('a player outside the plan stands in: “<P> serving for <Q>”, or “<P> serving” on an empty spot', async () => {
  let env = await bootWithSession(planDay());
  click(env.document, serveIn('gia'));
  assert.match(env.document.getElementById('app').innerHTML, toastSays('Gia serving for Ana'));
  env = await bootWithSession(planDay(['-12345', null]));
  click(env.document, serveIn('gia'));
  assert.match(env.document.getElementById('app').innerHTML, toastSays('Gia serving'));
});

test('the planned player coming back for her stand-in says “<P> back in”', async () => {
  let day = tap(planDay(), 'g1', 1, 'gia', 'serve', 'out', 1); // Gia stands in for Ana and loses the rally
  for (const pid of ['bea', 'cat', 'dee', 'eve', 'fay']) day = tap(day, 'g1', 1, pid, 'serve', 'out', 1); // side-out, then lost
  const { document } = await bootWithSession(day);
  assert.match(document.getElementById('app').innerHTML, servingRow('Gia'), 'the stand-in is due again');
  click(document, '[data-action="tap-count"][data-pid="ana"][data-stat="serve"][data-side="out"]');
  assert.match(document.getElementById('app').innerHTML, toastSays('Us +1 · side-out, then Them +1 · Serve out. Ana back in'));
});

test('the serving row is styled by colour alone: a background and an accent bar, no dot', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.row.serving, .row.serving:nth-child(even) { background:var(--info-bg); box-shadow:inset 4px 0 0 var(--accent); }'));
  assert.doesNotMatch(css, /\.row\.serving[^{]*::before/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/ui.test.mjs`
Expected: the seven new tests FAIL (no `row serving`, no align toast, no CSS rule). The existing strip and toast tests still pass.

- [ ] **Step 3: Implement.**

`src/ui.js` line 6: add `plannedServer` to the single-line session import (after `setServer`):

```js
import { STORAGE_KEY, UNREADABLE_KEY, newSession, gameLabel, dayLabel, formatDate, openDayRoster, replaceDay, hasUnexportedStats, setPlayerTicked, addSub, setActiveGame, deleteGame, setActiveSet, tap, undo, setScore, replaceLogWithScore, clearSet, setServedFirst, tapPoint, clearPoints, setServer, plannedServer, inferTap, pointTally, isSetPlayed, getCount, parseSession, serialiseSession, runSelfCheck, buildDayStatsPayload, gamePlayerIdsUnion, APP_VERSION, AUTHOR_NAME, COPYRIGHT_YEAR, MAX_SCORE, SESSION_SCHEMA } from './session.js';
```

After `showToast` (line 70), add:

```js
/** What a re-align did (spec §4): "<P> back in", "Re-aligned to <P>", "<P> serving for <Q>" or
 * "<P> serving" on an empty spot. First names, like the Undo label. */
function alignText(day, align) {
  const p = firstName(day, align.playerId);
  if (align.rule === 'back') return `${p} back in`;
  if (align.rule === 'shift') return `Re-aligned to ${p}`;
  return align.forId ? `${p} serving for ${firstName(day, align.forId)}` : `${p} serving`;
}
```

Replace `renderRow` (lines 589-601):

```js
function renderRow(game, n, player, idleStat, serverId) {
  const c = getCount(game, n, player.id);
  const subChip = player.sub ? ' <span class="gchip">Sub</span>' : '';
  const idle = (stat) => (stat === idleStat ? ' idle' : '');
  // The planned server (spec §6): our server while we serve, our next server while they do.
  const rowOpen = player.id === serverId ? '<div class="row serving" data-serving="1" aria-current="true">' : '<div class="row">';
  return `
${rowOpen}
  <div class="name">${esc(player.name)}${subChip}</div>
  <button type="button" class="cnt in${idle('serve')}" data-action="tap-count" data-pid="${esc(player.id)}" data-stat="serve" data-side="in">${c.serve.in}</button>
  <button type="button" class="cnt out${idle('serve')}" data-action="tap-count" data-pid="${esc(player.id)}" data-stat="serve" data-side="out">${c.serve.out}</button>
  <button type="button" class="cnt in${idle('return')}" data-action="tap-count" data-pid="${esc(player.id)}" data-stat="return" data-side="in">${c.return.in}</button>
  <button type="button" class="cnt out${idle('return')}" data-action="tap-count" data-pid="${esc(player.id)}" data-stat="return" data-side="out">${c.return.out}</button>
</div>`;
}
```

In `renderRecord`, after the `idleCls` line (line 622) add:

```js
  // The planned server's row: null when there is no plan, the set is typed or untouched, serve-first
  // is unanswered or the spot is empty — and a player who is not ticked has no row to mark.
  const serverId = typed ? null : plannedServer(setRecord, Array.isArray(game.serveOrders) ? game.serveOrders[n - 1] : null);
```

change line 629's `players.map((p) => renderRow(game, n, p, idleStat))` to `players.map((p) => renderRow(game, n, p, idleStat, serverId))`, and replace the `undoLabel` line (648):

```js
  const undoLabel = !top ? '↶ Undo' : top.kind === 'point' ? `↶ Undo point ${top.winner === 'U' ? 'Us' : 'Them'}` : top.kind === 'align' ? '↶ Undo re-align' : `↶ Undo ${firstName(day, top.playerId)} ${statLetter(top.stat)} ${top.side}${top.points ? ` + ${lettersLabel(top.points)}` : ''}`;
```

In `onTapCount`, replace the `if (tapped !== previousSession) { … }` block (lines 697-703):

```js
  if (tapped !== previousSession) {
    const after = tapped.games.find((g) => g.gameId === game.gameId);
    const top = after.history[after.history.length - 1];
    // A re-align pushes its own entry straight after the tap's count entry.
    const align = top && top.kind === 'align' ? top : null;
    const entry = align ? after.history[after.history.length - 2] : top;
    const phrases = [];
    // The letters tap() actually appended (the MAX_POINTS cap can trim them), with inferTap's reasons.
    if (entry && entry.kind === 'count' && entry.points) phrases.push(toastText(inferTap(setBefore, stat, side).letters.slice(0, entry.points.length), stat));
    if (align) phrases.push(alignText(tapped, align));
    if (phrases.length > 0) showToast(phrases.join('. '));
    else if (entry && entry.kind === 'count' && entry.delta < 0 && 'pendingBefore' in entry) showToast('Open rally cancelled');
  }
```

`src/styles.css`, after line 111 (`.row:nth-child(even) { … }`):

```css
/* The planned server's row (docs/superpowers/specs/2026-10-08-server-highlight-design.md §6): a blue
   background and an accent bar, the same whether we serve or receive. Colour only, never height, so
   the 12-row density guard is unaffected. */
.row.serving, .row.serving:nth-child(even) { background:var(--info-bg); box-shadow:inset 4px 0 0 var(--accent); }
```

- [ ] **Step 4: Run the whole unit suite**

Run: `npm test`
Expected: all pass (`ℹ fail 0`), including the existing strip regexes (`/class="pt us serving open" data-action=…/` etc.) and toast tests. List any existing test you had to update and why.

- [ ] **Step 5: Checkpoint — do not commit; leave changes in the working tree.**

---

### Task 6: Browser harnesses and browser tests at contract 6

**Files:**
- Modify: `scripts/verify-build.mjs` (comment :38-56; `ROSTER_TEXT` :62-72), `scripts/verify-density.mjs` (`rosterFor` :31-37), `scripts/verify-golden-vector.mjs` (header :1-21; `GOLDEN_VECTOR` :44-45; helpers after :90; facts :141-161; PASS lines :202-206)
- Modify: `e2e/support/fixtures.mjs` (:16-35), `e2e/record.spec.mjs` (:69; append in the describe), `e2e/paste.spec.mjs` (:1-21, :32-38), `e2e/persist.spec.mjs` (:1; append)

**Interfaces:**
- Consumes: the markup from Task 5; `ROSTER_V6_VECTOR` (Task 1).
- Produces: `rosterPayload()` at v6 (game-1 `serve: [null, null]`), `plannedPayload()`, and `rosterText(payload)` that fills a missing `serve` with one `null` per set.

- [ ] **Step 1: Move the scripts to v6.**

`scripts/verify-build.mjs`: in the comment above `ROSTER_NAMES`, "envelope (CIQR3.<base64url>.<fnv1a32>)" becomes "envelope (CIQR6.<base64url>.<fnv1a32>)" and "A two-game v3 day" becomes "A two-game contract-6 day (game 1 set 1 carries a planned serve order, so the planned-server path runs under both builds)". `ROSTER_TEXT` becomes:

```js
const ROSTER_TEXT = encodeDayRoster({
  v: 6,
  kind: 'roster',
  date: '2026-09-13',
  team: TEAM,
  players: ROSTER_NAMES.map((name, i) => ({ id: `p${i + 1}`, name })),
  games: [
    { gameId: 'verify-1', opponent: OPPONENT, sets: [15, 15, 3], serve: ['012301', null, null] },
    { gameId: SECOND_GAME_ID, opponent: 'Second "FC"', sets: [3, 0], serve: [null, null] },
  ],
});
```

`scripts/verify-density.mjs` `rosterFor`:

```js
/** A one-game day whose single set names every player, so all `n` rows render, with a planned
 *  serve order naming each of them once (contract 6). */
function rosterFor(n) {
  return encodeDayRoster({
    v: 6, kind: 'roster', date: '2026-09-18', team: 'Blizzard',
    players: NAMES.slice(0, n).map((name, i) => ({ id: `p${i + 1}`, name })),
    games: [{ gameId: 'g1', opponent: 'Practice_9_18', sets: [2 ** n - 1], serve: ['0123456789abcdef'.slice(0, n)] }],
  });
}
```

`scripts/verify-golden-vector.mjs`:
- Header: "the contract's fixed cross-app golden vector (guide §8 …; it is quoted byte for byte in reference/stats-contract-v3-client-guide.md …)" becomes "the contract's fixed cross-app contract-6 golden vector (`ROSTER_V6_VECTOR`; never regenerate it -- it is quoted byte for byte in reference/vectors.ts and the planner's own test suite)", and add a fifth fact to the list: ` *   5. The plan reaches the screen: Lions set 1 ("010-10") after "We serve first" highlights Grace's row alone; Lions set 3 (the 7-long Train order "1111111") after "They serve first" highlights Zoë's.`
- Replace `GOLDEN_VECTOR` (lines 44-45) with the frozen `ROSTER_V6_VECTOR.encoded`, as a literal, as before (the script tests the shipped file against the frozen text, not against a runtime import):

```js
// The frozen contract-6 golden vector, ROSTER_V6_VECTOR.encoded in reference/vectors.ts. Never regenerate this string.
const GOLDEN_VECTOR = 'CIQR6.eyJ2Ijo2LCJraW5kIjoicm9zdGVyIiwiZGF0ZSI6IjIwMjYtMDktMTkiLCJ0ZWFtIjoiVGh1bmRlciIsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJuYW1lIjoiR3JhY2UiLCJqZXJzZXkiOjd9LHsiaWQiOiJ6b2llIiwibmFtZSI6Ilpvw6sifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJvcHBvbmVudCI6Ikxpb25zIiwic2V0cyI6WzMsMSwyXSwic2VydmUiOlsiMDEwLTEwIixudWxsLCIxMTExMTExIl19LHsiZ2FtZUlkIjoiZ2FtZS0yIiwib3Bwb25lbnQiOiJGYWxjb25zIiwic2V0cyI6WzIsMF0sInNlcnZlIjpbIjExMTExMSIsbnVsbF19XX0.841c281c';
```
- After `switchGame` (line 90) add:

```js
/** Names on the highlighted (planned server's) rows. */
async function readServingRows(page) {
  return page.evaluate(() => [...document.querySelectorAll('.rows .row.serving .name')].map((el) => el.textContent.trim()));
}

async function clickAction(page, selector) {
  const clicked = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
  if (!clicked) throw new Error(`no element matching ${selector}`);
  await waitSettled(page);
}
```

- After the Fact 1 checks for Lions set 1 (after line 148) add:

```js
    // --- Fact 5a: Lions set 1's plan "010-10" starts with Grace. ---
    await clickAction(page, '[data-action="serve-first"][data-us="1"]');
    let serving = await readServingRows(page);
    if (serving.length !== 1 || serving[0] !== 'Grace') {
      fail(`Lions set 1 after "We serve first" highlights [${serving.join(', ')}] -- expected Grace alone (serve order "010-10")`);
    }
```

- After the Lions set 3 check (after line 161) add:

```js
    // --- Fact 5b: Lions set 3's 7-long Train order "1111111" -- receiving, our next server is entry 1, Zoë. ---
    await clickAction(page, '[data-action="serve-first"][data-us="0"]');
    serving = await readServingRows(page);
    if (serving.length !== 1 || serving[0] !== 'Zoë') {
      fail(`Lions set 3 after "They serve first" highlights [${serving.join(', ')}] -- expected Zoë alone (serve order "1111111")`);
    }
```

- PASS lines: the first becomes `'PASS: golden vector CIQR6… decodes and renders correctly in the shipped dist/ bundle.'` and add `console.log('  Plan: Lions set 1 "We serve first" highlights Grace; set 3 "They serve first" highlights Zoë (7-long order).');`.

- [ ] **Step 2: Move the e2e fixtures to v6.** In `e2e/support/fixtures.mjs` replace lines 16-35:

```js
/** A valid contract-6 day roster: Thunder on 2026-09-19, three players, one game vs Lions with two
 *  sets and no planned serve order. */
export function rosterPayload(overrides = {}) {
  return {
    v: 6,
    kind: 'roster',
    date: '2026-09-19',
    team: 'Thunder',
    players: [
      { id: 'grace', name: 'Grace', jersey: 7 },
      { id: 'zoie', name: 'Zoë' },
      { id: 'lily', name: 'Lily' },
    ],
    games: [{ gameId: 'game-1', opponent: 'Lions', sets: [7, 3], serve: [null, null] }],
    ...overrides,
  };
}

/** The same day with a plan for set 1 — Grace, Zoë, Lily, Grace, Zoë, Lily — and Ava ticked for
 *  set 1 but in no plan, so she can only stand in. Set 2 has no plan. */
export function plannedPayload() {
  return rosterPayload({
    players: [
      { id: 'grace', name: 'Grace', jersey: 7 },
      { id: 'zoie', name: 'Zoë' },
      { id: 'lily', name: 'Lily' },
      { id: 'ava', name: 'Ava' },
    ],
    games: [{ gameId: 'game-1', opponent: 'Lions', sets: [15, 3], serve: ['012012', null] }],
  });
}

/** Encodes a day roster at contract 6. A game given without `serve` gets no plan (one null per set),
 *  so a test that does not care about the serve order need not spell it out. */
export function rosterText(payload = rosterPayload()) {
  return encodeDayRoster({ ...payload, games: payload.games.map((g) => (g.serve === undefined ? { ...g, serve: g.sets.map(() => null) } : g)) });
}
```

`e2e/record.spec.mjs` line 69 becomes:

```js
    await openDay(page, rosterText(rosterPayload({ players: [{ id: 'grace', name: 'Grace' }], games: [{ gameId: 'game-1', opponent: 'Lions', sets: [1, 0] }] })));
```

and line 1 becomes `import { expect, openDay, plannedPayload, rosterPayload, rosterText, test } from './support/fixtures.mjs';`.

- [ ] **Step 3: Add the browser tests.** Inside `test.describe('Recording a set', …)` in `e2e/record.spec.mjs`, append:

```js
  test('the planned server is highlighted while we serve and while we receive', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText(plannedPayload()));
    const serving = page.locator('.rows .row.serving');
    await expect(serving).toHaveCount(0); // serve-first not answered yet
    await press(page.locator('[data-action="serve-first"][data-us="1"]'));
    await expect(serving).toHaveCount(1);
    await expect(serving.locator('.name')).toHaveText('Grace');
    await expect(serving).toHaveAttribute('aria-current', 'true');
    await press(count(page, 'grace', 'serve', 'out')); // rally lost: they serve, and Zoë is our next server
    await expect(serving.locator('.name')).toHaveText('Zoë');
    await press(count(page, 'zoie', 'serve', 'in')); // side-out: Zoë serves, as planned
    await expect(page.locator('.toast')).toHaveText('Us +1 · side-out');
    await expect(serving.locator('.name')).toHaveText('Zoë');
  });

  test('a Serve tap for someone else re-aligns with a toast, and Undo takes it back and keeps the stat', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText(plannedPayload()));
    const serving = page.locator('.rows .row.serving .name');
    const undo = page.locator('[data-action="undo"]');
    await press(count(page, 'lily', 'serve', 'in')); // answers "we serve first"; the plan says Grace
    await expect(page.locator('.toast')).toHaveText('Re-aligned to Lily');
    await expect(serving).toHaveText('Lily');
    await expect(undo).toHaveText('↶ Undo re-align');
    await press(undo);
    await expect(serving).toHaveText('Grace');
    await expect(count(page, 'lily', 'serve', 'in')).toHaveText('1');
    await expect(undo).toHaveText('↶ Undo Lily S in');
  });

  test('a player outside the plan stands in, and the planned player comes back in', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText(plannedPayload()));
    const serving = page.locator('.rows .row.serving .name');
    await press(count(page, 'ava', 'serve', 'out')); // Ava serves for Grace, and the serve is out
    await expect(page.locator('.toast')).toHaveText('Them +1 · Serve out. Ava serving for Grace');
    await expect(serving).toHaveText('Zoë');
    for (const pid of ['zoie', 'lily', 'grace', 'zoie', 'lily']) await press(count(page, pid, 'serve', 'out')); // one turn each
    await expect(serving).toHaveText('Ava'); // her spot comes round again
    await press(count(page, 'grace', 'serve', 'out'));
    await expect(page.locator('.toast')).toHaveText('Us +1 · side-out, then Them +1 · Serve out. Grace back in');
    await expect(serving).toHaveText('Zoë');
  });
```

In `e2e/paste.spec.mjs`, line 1 becomes `import { ROSTER_V3_VECTOR, ROSTER_V6_VECTOR } from '../src/vectors.js';`, replace the first test (lines 14-21) with:

```js
  test('the golden v6 vector opens Lions with three set tabs, and its plan highlights Grace', async ({ page, openApp, press }) => {
    await openApp();
    await expect(page.getByText('CoachIQ Stats')).toBeVisible();
    await openDay(page, ROSTER_V6_VECTOR.encoded);
    await expect(page.locator('[data-action="select-set"]')).toHaveCount(3);
    await expect(page.locator('.title')).toContainText('vs Lions');
    await expect(banner(page)).toHaveCount(0);
    await press(page.locator('[data-action="serve-first"][data-us="1"]'));
    await expect(page.locator('.rows .row.serving .name')).toHaveText('Grace');
  });

  test('the golden v3 vector still opens, with no highlight', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, ROSTER_V3_VECTOR.encoded);
    await expect(page.locator('[data-action="select-set"]')).toHaveCount(3);
    await press(page.locator('[data-action="serve-first"][data-us="1"]'));
    await expect(page.locator('.rows .row.serving')).toHaveCount(0);
  });
```

and add one row to `refusals` (after the "a newer contract" row):

```js
    ['a serve order naming nobody', encodePayload('roster', rosterPayload({ games: [{ gameId: 'game-1', opponent: 'Lions', sets: [7, 3], serve: ['------', null] }] }), 6), 'game "game-1" set 1 serve order names nobody'],
```

In `e2e/persist.spec.mjs`, line 1 becomes `import { expect, openDay, plannedPayload, rosterText, STORAGE_KEY, test } from './support/fixtures.mjs';` and append inside the describe:

```js
  test('a re-alignment survives a reload, and Undo still takes it back', async ({ page, openApp, press }) => {
    await openApp();
    await openDay(page, rosterText(plannedPayload()));
    await press(page.locator('[data-action="tap-count"][data-pid="lily"][data-stat="serve"][data-side="in"]')); // the plan says Grace
    const serving = page.locator('.rows .row.serving .name');
    await expect(serving).toHaveText('Lily');
    await page.reload();
    await expect(serving).toHaveText('Lily');
    await expect(page.locator('[data-action="undo"]')).toHaveText('↶ Undo re-align');
    await press(page.locator('[data-action="undo"]'));
    await expect(serving).toHaveText('Grace');
  });
```

- [ ] **Step 4: Build and run the harnesses — from PowerShell.**

```powershell
npm test
npm run build
npm run verify
npx playwright test e2e/record.spec.mjs e2e/paste.spec.mjs e2e/persist.spec.mjs e2e/density.spec.mjs --grep-invert "@live"
```

Expected: unit `fail 0`; build OK; verify prints `PASS` for the build parity, the golden vector (`CIQR6…` with the Plan line) and density; every Playwright project passes these four files. A failure that is only an expected consequence of contract 6 gets its expectation updated precisely and listed; anything else is a regression to report.

- [ ] **Step 5: Checkpoint — do not commit; leave changes in the working tree.**

---

### Task 7: Release 4.6.0 — version, cache, README, full gates

**Files:**
- Modify: `src/session.js` (`APP_VERSION` :9), `src/sw.js` (`CACHE` :3)
- Modify: `README.md` (:5; :174; the Verify checklist after the `(4.5.0)` item, ~:213-214; the `reference/` paragraph and table :222-245)
- Regenerate: `dist/` via `npm run build`

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: the 4.6.0 build in `dist/`.

- [ ] **Step 1: Release bump.** `src/session.js`: `export const APP_VERSION = '4.6.0';` — `src/sw.js`: `const CACHE = 'ciq-stats-v15';`. Search tests and scripts (not `dist/`, not `node_modules/`, not `package-lock.json`) for pins of `4.5.0` or `ciq-stats-v14`; update any that pin the release and name them in the report.

- [ ] **Step 2: README.**

Line 5 becomes:

```markdown
Records per-player Serve In, Serve Out, Return In, and Return Out counts per set during a game, supporting up to 16 players a game and 32 a day, 5 sets a game, and 8 games a day, all sharing one player directory for the whole day. Exchanges CIQR6… roster payloads (with per-set membership bitmasks and each set's planned serve order) and CIQS5… stats payloads with the planner by copy and paste, with no server or network required. The record screen highlights the player who should be serving.
```

Line 174: "the `CIQR3.` golden vector decoding and rendering correctly in the shipped file" becomes "the `CIQR6.` golden vector decoding and rendering correctly in the shipped file".

After the `(4.5.0)` checklist item and its indented note, add:

```markdown
- [ ] (4.6.0) Paste a `CIQR6.` roster from the planner and tap We serve first → the planned server's row has a blue background and an accent bar on the left; tap Serve Out for her → the highlight moves to our next server while they serve.
- [ ] (4.6.0) At the start of our serve turn tap Serve In for someone other than the highlighted player → the toast says "Re-aligned to <name>" (or "<name> serving for <name>" for a player outside the plan) and the highlight moves to her; Undo reads "↶ Undo re-align": one Undo puts the highlight back and keeps her serve count, a second takes the tap back.
- [ ] (4.6.0) Paste the same `CIQR6.` roster into a phone still on 4.5.0 → it is refused as made by a newer version of the Rotation Planner (contract 6).
```

Replace the `reference/` paragraph's first sentence ("Verbatim copies from the planner repo. `stats-contract.md`, … `stats-contract.md` covers it).") with:

```markdown
Verbatim copies from the planner repo. `stats-contract.md`, `statsContract.ts`, `vectors.ts`,
`stats-contract-v6-client-guide.md`, `stats-contract-v3-client-guide.md` and
`stats-contract-v4-client-guide.md` are current as of contract 6 (the roster's planned serve order,
`games[].serve`; stats unchanged and pinned to 5; contract 5 has no separate client guide:
`stats-contract.md` covers it).
```

In the table, change the `stats-contract.md` row to "The shared payload contract, v1 to v6. Source of truth for both apps.", the `statsContract.ts` row to "The planner's codec and validators, v1 to v6 (zero imports, copyable).", the `vectors.ts` row to "The golden test vectors both apps check against, v1 to v6, and `SERVE_ORDER_VECTOR` for the phone's serve prediction.", and add after the v4 guide row:

```markdown
| `stats-contract-v6-client-guide.md` | The contract-6 guide written for this app's author — the roster's per-set planned serve order (`games[].serve`), its reading rule, refusals and the compatibility matrix. |
```

- [ ] **Step 3: Build and run every gate — from PowerShell**, capturing the tail of each:

```powershell
npm test
npm run build
npm run verify
npm run test:browsers
```

Expected: unit `fail 0`; build OK; verify PASS (build parity, golden vector `CIQR6…`, density); every browser project passes. The ⋯ menu and paste card show `Version 4.6.0`.

- [ ] **Step 4: Checkpoint — do not commit; leave changes in the working tree** (including `dist/`). Report that the Planner's deferred round-trip task (`C:\_src\CoachIQ_Rotation_Planner\e2e\round-trip.spec.ts`, run from PowerShell in the Planner repo) is next: it drives this `dist/` and can only pass now.

---

## Self-review notes

**Spec coverage.**
- §1 codec, pins, refusals, legacy normalisation, self-check vectors: Task 1; `SERVE_ORDER_VECTOR` self-check (`serve order vector`): Task 2; harness rosters to v6: Task 1 (unit-test harnesses, which break the moment the pin moves) and Task 6 (scripts, e2e).
- §2 `serveOrders` at ingest and append, re-paste rules, `emptySet` fields: Tasks 2-3.
- §3 `plannedServerAt`/`plannedServer` and the exact algorithm: Task 2.
- §4 when it fires (logged, untyped, planned, `at < MAX_POINTS`, first naming tap of the turn incl. a replacing tap), the three rules with tie-break, first names, toast joining, align entry, Undo order, both entries under `UNDO_LIMIT`: Tasks 4-5.
- §5 Undo of align, minus on the opener with `alignBefore`, a minus elsewhere, clear points / typed score / replace log reset and drop align entries, `stripInference` strips `alignBefore`, clear set (unchanged: filters by `n`), flipping serve-first keeps the alignment: Task 4.
- §6 `renderRecord`/`renderRow` markup, the one CSS rule with no dot, every no-highlight case, toasts and Undo label: Task 5.
- §7 tolerant `shift`/`standIns` (Task 2) and `serveOrders` (Task 3); strict `align` and `alignBefore` (Task 4); no schema bump.
- Release and README: Task 7. Testing list: unit codec (Task 1), session (Tasks 2-4), ui (Task 5), browser (Task 6), gates (Task 7).

**Placeholders.** None. The frozen `ROSTER_V6_VECTOR.encoded` string, the `SERVE_ORDER_VECTOR` literal and the codec JS are printed in Task 1, taken from the Planner plan (its Task 2 Step 1a and Step 3, and its Task 1 Step 3). Task 1 also says to check them against the re-copied `reference/` files, which win on any difference. Every test runs: none can skip (the self-check leg is tested through the pure `serveOrderVectorFails`).

**Names and types.** `SERVE_ORDER_PATTERN`, `validateDayRosterPayloadV3(value, version = 3)`, `parseServeList(gameId, value, sets, size)`, `normaliseRosterV3` (Task 1, the Planner's names); `plannedServerAt(set, order, at)`, `plannedServer(set, order)`, `serveOrderVectorFails(vector)`, `planIndex`, `mod`, `isShift`, `isOrderIndexKey`, `isPlayerId` (Task 2); `serveOrdersFrom`, `sameOrder`, `serveOrderOf`, `forgetAlignment`, `parseServeOrder` (Task 3); `firstServeOfTurn`, `realign`, `alignOf`, `parseStandInsStrict`, `ALIGN_RULES`, `isRallyIndex` (Task 4); `alignText` (Task 5). The align entry key order is `kind, n, at, rule, playerId, forId, shiftBefore, standInsBefore` in `tap`, `parseHistoryEntry` and the harden-app assertion. Vector names `ROSTER_V6_VECTOR`, `ROSTER_V3_AS_V6`, `ROSTER_V2_AS_V6`, `ROSTER_V1_AS_V6`, `SERVE_ORDER_VECTOR` match the Planner plan and are used the same way in `src/vectors.js`, `src/session.js` and the tests. The vector ids (`grace`, `zoie`, `emily`, `lexi`, `lily`, `brooklyn`, `melanie`, `addison`) all match `ID_PATTERN`. A scratch run of `planIndex` against the real `SERVE_ORDER_VECTOR` matched all 19 rallies we serve.

**Deliberate readings of the spec (flag to Rory if any is wrong).**
- The opener's re-align is found as "the history entry right after the opener" rather than "the most recent entry for that set", so an intervening minus on another count still lets the cancel reverse it (Review Focus 4).
- A re-paste that changes a set's order also drops that set's align entries and `alignBefore`, not only `shift`/`standIns` (Review Focus 1).
- `forId` is the planned player Q for every rule (so for `back` it equals `playerId`).
- Reads of `game.serveOrders` are tolerant of a game without one (the schema-1 migration builds games outside `parseGame`), and a malformed stored `serveOrders` becomes nulls.
- Which rallies we served is worked out from `points` (the reading rule), in the self-check and its test.
- A roster game without `serve` (a hand-built v3-shaped test roster) means no plan.
- A minus that cancels a re-aligned opener still toasts `Open rally cancelled`.
- The Planner's builder writes a directory index of 32 or more as `-`, so the phone never meets one; `ROSTER_V6_VECTOR`'s `"1111111"` is codec coverage only. The Planner's deferred round trip taps "We serve first" and then expects `.row.serving` (with `aria-current="true"`) to hold the set-1 planned server and, after the first Serve tap, the tapped player. Task 5's markup keeps exactly that.
