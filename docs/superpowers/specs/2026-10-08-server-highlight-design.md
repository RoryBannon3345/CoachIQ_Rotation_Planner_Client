# Highlight the planned server — design

Date: 2026-10-08 · Status: design approved by Rory in chat (contract 6; re-align silently with a toast; highlight while receiving too; a different player may serve) · Mockup: `docs/server-highlight-mockup.html`
Depends on: `C:\_src\CoachIQ_Rotation_Planner\docs\superpowers\specs\2026-10-08-roster-serve-order-design.md` (roster contract 6), which defines the `serve` field, its reading rule and the golden vectors. **The Planner side is built first.**

## Goal

On the record screen, the player who should serve is highlighted:
- **while we serve:** the server of the current rally;
- **while they serve:** our next server, the one who serves when we win the ball back.

The highlight follows the set's planned rotation from the roster plus the rallies logged so far. When the coach taps Serve
for someone else (an unplanned rotation change or a substitution), the phone re-aligns to that player, says so in a toast, and
Undo takes it back.

## 1. Contract 6 (codec)

- Port the Planner's contract 6 verbatim, as before. Copy into `reference/`: `statsContract.ts`, `vectors.ts`,
  `stats-contract.md`, and the new `stats-contract-v6-client-guide.md`.
- `src/codec.js` is the type-stripped port with the same error strings. `src/vectors.js` gets `ROSTER_V6_VECTOR`,
  `ROSTER_V3_AS_V6` (and the `…_AS_V6` forms of v2/v1) and `SERVE_ORDER_VECTOR`.
- `CONTRACT_VERSION` 6. `encodeDayRoster` is pinned to 6 and `encodeDayStats` to **5**, so the phone still exports `CIQS5.`.
- **Self-check (`runSelfCheck`):** the roster vectors decode to v6. Add one new check: for every rally of
  `SERVE_ORDER_VECTOR` that we served (worked out from `points` by the reading rule, not from `servers[i] !== null`), `plannedServerAt` (§3) returns the vector's `servers[i]`. A failure says
  `serve order vector`.
- **Harness rosters move to v6:** `scripts/verify-build.mjs`, `scripts/verify-density.mjs`, `test/harden-app.test.mjs` and
  `e2e/support/fixtures.mjs`. `scripts/verify-golden-vector.mjs` pastes the frozen `CIQR6.` vector, and v3 is still covered by
  unit tests.

## 2. Storing the plan (session)

- **Game:** a new `serveOrders` array, `MAX_SETS` long. Each entry is `null` or an array of player ids (or `null` for an
  empty spot), resolved from the roster's characters at ingest (`directory[parseInt(c, 32)].id`; `-` → `null`). It is built in
  `newDayFromRoster` and for appended games in `mergeDayRoster`.
- **Re-paste (`mergeDayRoster`, matched game):**
  - For each set slot the incoming roster covers, take the incoming order.
  - If it differs from the stored one, reset that set's `shift` and `standIns` (below), because they described the old plan.
    Also drop that set's align entries and `alignBefore` from history, as Clear points does, so Undo can't bring back an
    alignment to the old plan.
  - A roster object with no `serve` (raw v3-shaped test fixtures) means "no plan".
  - Set slots beyond the incoming `sets.length` keep what they had. Unmatched local games are untouched.
- **Set record:** two new fields, `shift: 0` and `standIns: {}`.
  - `shift` is a whole number of turns added to the plan.
  - `standIns` maps an order index to the player id serving in that spot instead of the planned player.
  - `emptySet()` gains both.

## 3. Who serves (prediction)

New pure, exported helpers in `src/session.js`:

```js
/** Who serves rally `at` of a logged set under its plan: our server when we serve it, else our next server.
 * Null without a plan, for a typed set, before serve-first is answered, or on an empty spot. */
export function plannedServerAt(set, order, at)
/** plannedServerAt at the end of the log: the row to highlight. */
export function plannedServer(set, order)
```

`plannedServerAt` follows the contract's reading rule:
1. Start with `serving = servedFirst ? 'U' : 'T'` and `t = 0`.
2. For each rally `i < at`: if `points[i] === 'U'` and `serving === 'T'`, add one to `t`. Then set `serving = points[i]`.
3. `turn = serving === 'U' ? t : t + 1`.
4. `idx = mod(turn + shift, order.length)`.
5. Return `standIns[idx] ?? order[idx]`.

`plannedServer(set, order)` = `plannedServerAt(set, order, set.points.length)`. With an open rally, that is the open rally's
server when we serve it, and our next server while they do.

## 4. A different player serves (re-align)

**When it fires.** A Serve tap that raises a count in a logged, untyped set with a plan, where all of the following hold:
- the tap records `serveBy[at]` (existing code, `at < MAX_POINTS`);
- no earlier rally of the same serve turn has a `serveBy` entry, so this is the first tap naming the turn's server, which
  is the same rule as v5 `servers`;
- the tapped player `P` differs from `E = plannedServerAt(set, order, at)`, worked out on the set after the tap's letters.

A later tap that replaces `serveBy[at]` is still the first naming that turn, so it is checked again. Serve taps later in
the turn never re-align.

**What happens** (`idx` is the order index for rally `at`, and `Q = order[idx]` is the planned player). The first rule
that applies wins:
1. **Back in:** `P === Q` (her stand-in is in `standIns[idx]`). Delete `standIns[idx]`. Toast: `<P> back in`.
2. **Re-align:** `P` is the server at another index `j`, counting stand-ins (`standIns[j] ?? order[j]`).
   - Set `shift = mod(shift + j − idx, L)`.
   - If `P` is at more than one index, pick the `j` with the smallest circular distance from `idx`; on a tie, go forward.
   - Toast: `Re-aligned to <P>`.
3. **Stand-in:** otherwise, set `standIns[idx] = P`. Toast: `<P> serving for <Q>`, or `<P> serving` when `Q` is null.

Names are first names (`firstName`). When the tap also scored, the toast keeps today's phrase first:
`Us +1 · side-out. Re-aligned to Bea`.

**History.** The tap pushes its count entry as today, then a separate align entry:

```js
{ kind: 'align', n, at, rule: 'back' | 'shift' | 'standIn', playerId, forId /* always Q (the planned player at idx), or null for an empty spot */, shiftBefore, standInsBefore }
```

The first Undo reverses only the re-align and keeps the stat. The Undo label for an align entry is `↶ Undo re-align`.
A second Undo reverses the tap as today. Both entries count toward `UNDO_LIMIT`.

## 5. Undo, minus, clear

- **Undo of an align entry:** restores `shift` and `standIns` from the `…Before` values.
- **Minus that cancels the opener** (the 4.4.0 "wrong row" fix):
  - When it clears `serveBy[openAt]` and the history entry straight after the opener is an align entry with
    `at === openAt`, the re-align is reversed too.
  - That is the entry `tap` always pushes there. "The most recent entry for the set" would miss it whenever a minus on another
    player's count came in between.
  - The minus entry records `alignBefore: { shift, standIns }` (the values it replaced), so Undo of the minus puts them back.
  - The toast stays `Open rally cancelled`.
  - A minus anywhere else leaves the alignment alone. The Undo button is the fix there.
- **Clear points, typing a score, replacing the log with a score:** reset `shift` to 0 and `standIns` to `{}`. The set's
  align entries are dropped from history, and `stripInference` also strips `alignBefore`.
- **Clear set:** already removes everything.
- **Flipping serve-first:** keeps `shift` and `standIns`. The prediction is worked out again from the flipped answer.

## 6. Screen

- **`renderRecord`:** `serverId = typed ? null : plannedServer(setRecord, game.serveOrders?.[n - 1] ?? null)`. It's read
  defensively, because games migrated from a schema-1 save and hand-built test games have no `serveOrders`. It's `null` when the set
  is untouched or serve-first is unanswered. It is passed to `renderRow`.
- **The server's row:** `class="row serving"`, `data-serving="1"`, `aria-current="true"`. It gets a blue background and an
  accent bar on the left, with no dot (Rory's call). The look is the same whether we serve or receive; see the mockup.
- **CSS:**

  ```css
  .row.serving, .row.serving:nth-child(even) { background:var(--info-bg); box-shadow:inset 4px 0 0 var(--accent); }
  ```

  No height changes, so the 12-row density guard is unaffected.
- **No highlight** when:
  - there's no plan (an older roster, or `null` for that set);
  - the set has a typed score;
  - serve-first is unanswered;
  - the spot is empty;
  - the predicted player isn't ticked for the set.
- **Toasts and Undo:** `onTapCount` reads the count entry, and the align entry when there is one. It builds the toast as in
  §4. The Undo label is in §4.

## 7. Persistence

- No `SESSION_SCHEMA` bump. As with `serveBy` in 4.5.0, the new fields are optional and never fatal.
- **`parseSetRecord`:**
  - `shift` must be a whole number from 0 to 15; anything else becomes 0.
  - `standIns` keys must be `/^\d{1,2}$/` and below 16, with legal ids; a bad entry is skipped.
- **`parseGame`:** keeps `serveOrders`.
  - Missing, or not an array, becomes five nulls. Positions 0–4 are read and any gap is filled with null.
  - Each entry must be `null` or an array 6–16 long of ids in the directory, or nulls; a bad entry becomes `null`.
  - `parseGame` rebuilds field by field, so the field must be added to its return.
- **`parseHistoryEntry`:**
  - reads `align` entries strictly, like the other kinds (a bad one drops the game, as today);
  - reads the count entry's optional `alignBefore`.

## Out of scope

- Any change to the stats payload. v5 `servers` already reports who served, and the Planner fits it.
- Editing the serve order on the phone.
- Highlighting their server.
- Typed sets.
- A tappable Undo inside the toast. The bottom-bar Undo is the way back.

## Release

- `APP_VERSION` 4.6.0, service worker cache `ciq-stats-v15`, rebuilt `dist/`.
- **README:**
  - line 5 says `CIQR6.`;
  - the `reference/` table is current as of contract 6;
  - Verify checklist lines `(4.6.0)`: the server row is highlighted while we serve and while we receive; a Serve tap for
    someone else re-aligns with a toast and Undo; a 4.5.0 phone refuses a `CIQR6.` roster as "newer".
- No deploy. **Nothing is committed unless Rory asks.**

## Testing

- **Unit, codec:**
  - v6 vector round trip;
  - v3, v2 and v1 normalise to v6;
  - every new refusal message;
  - roster pin 6, stats pin 5, `CONTRACT_VERSION` 6;
  - a `CIQR7` roster is refused as newer.
- **Unit, session:**
  - `plannedServerAt` against `SERVE_ORDER_VECTOR`, plus hand cases: we serve first, we receive first, wrap past entry 5,
    a Train-length order, an empty spot, an open rally either way;
  - each re-align rule and its toast data;
  - only the first serve tap of a turn fires;
  - Undo order (re-align, then the tap);
  - minus on the opener reverses the re-align, and Undo of that minus restores it;
  - clear points, typed score and replace-log reset;
  - re-paste with a changed order resets, and with the same order keeps;
  - save and load round trip, including bad stored values.
- **Unit, ui:**
  - the row class, dot and attributes;
  - no highlight in each no-highlight case;
  - toast text for each rule, and with a scoring phrase;
  - the `↶ Undo re-align` label;
  - the existing strip regexes still match.
- **Browser:**
  - `e2e/record.spec.mjs`: highlight while serving and receiving, re-align, stand-in, back in, Undo;
  - `e2e/paste.spec.mjs`: golden `CIQR6.` pastes, and the refusal rows;
  - `e2e/persist.spec.mjs`: alignment survives a reload.
  - Run from PowerShell.
- **Gates:** `npm test`, `npm run build`, `npm run verify`, `npm run test:browsers`. After that, the Planner's
  `e2e/round-trip.spec.ts`.
