# Auto-scoring Us / Them from serve and return taps (side-out inference) — design

Date: 2026-10-07 · Status: approved option D of `docs/auto-score-options.pdf` · Mockup: `docs/auto-score-mockup.html`

## Goal

On the record screen, a coach's Serve In / Serve Out / Return In / Return Out taps now write the
set's rally log (`set.points`) automatically, so the Us / Them pills are only needed for the last
rally of a set and for points nobody tapped. The coach taps a stat for every one of our serves and
every one of our receptions (confirmed by Rory).

The rule it rests on: in rally scoring, whoever wins a rally serves the next one.

## Non-goals

- No change to the export contract (still v4; `points` and `servedFirst` exported exactly as now).
  An open rally is never exported.
- No on/off setting for the inference.
- No tracking of the opposing team.
- No session schema bump (see Ruling 2).

## Rulings made without Rory's explicit answer

1. **A Return Out ends the rally and gives Them the point**, like a Serve Out. Rory was asked and
   did not answer. It lives in one exported constant, `RETURN_OUT_ENDS_RALLY = true` in
   `src/session.js`; setting it `false` makes a Return Out behave like a Return In for scoring
   (rally stays open). Cost if wrong: flip one constant and two tests.
2. **No schema bump.** `pending` and the new history fields are optional on read (missing means
   "none"). An older cached build reading a newer save then ignores them instead of refusing the
   save and setting the day aside. Cost if wrong: one migration later. Consequence: if an older
   cached build re-saves the day, it drops the new history fields, so an Undo of those entries
   afterwards reverses only the count. The service worker is network-first and deletes old caches
   on activate, so the window is one launch.
3. **The score stays visible while a rally is open.** The PDF's "Won? / Lost?" pill labels would
   hide the score for most of the match under D, since a rally is open after every In tap. Instead
   both pills get a dashed border while a rally is open.
4. **No separate "serving" chip.** The set bar has no width to spare at 320px
   (`verify-density.mjs`). The serving side's pill shows a small dot instead.
5. **Pill aria-labels stay exactly as today** ("Us scored, 3"). Serving and open-rally state are
   exposed as `data-serving="1"` / `data-open="1"` attributes plus classes.
6. **Minus mode never touches the log or the open rally, even as a "wrong row" correction.**
   Raised by the final review. If the coach taps Grace Serve In, then corrects it with − on
   Grace and taps Zoie Serve In, the rally Grace opened is still open, so Zoie's tap settles it
   as a won rally: a phantom `U`. The toast names it ("Us +1 · we serve") and Undo or a pill tap
   repairs it. The right correction for the last tap is Undo, which reverses the tap and its open
   rally together. Options for Rory: keep this and teach "use Undo for the last tap"; show a
   warning toast on a minus tap while a rally is open; or make a minus tap on the counter that
   opened the rally reverse that rally too. Cost if wrong: an occasional extra point after a
   minus correction.

## Definitions

- **Typed set**: `set.points === '' && set.score !== null` (as today). No inference ever runs in
  a typed set.
- **Logged set**: any set that is not typed.
- **`setServer(set)`** (new, exported, pure): `'U'` or `'T'` for who serves the next rally, or
  `null` when unknown. If `set.points !== ''` it is the last letter of `set.points`; otherwise
  `true → 'U'`, `false → 'T'`, `null → null` from `set.servedFirst`.
- **Open rally** (`set.pending`): `null | 'serve' | 'return'`. Non-null means an In tap started a
  rally whose winner is not yet known.

## Data model (`src/session.js`)

- `emptySet()` gains `pending: null`. Every set written by the app carries `pending`.
- Set invariants (enforced by the parser): `pending` is `null`, `'serve'` or `'return'`;
  `pending !== null` requires `servedFirst !== null` and a logged set. A missing `pending` key
  reads as `null`. An invalid value makes the set unreadable (same strictness as other fields).
- Count history entries gain three optional fields, written only when they carry information:
  - `points`: the letters this tap appended, `/^[UT]{1,2}$/`.
  - `servedFirstSet: true`: this tap answered serve-first.
  - `pendingBefore`: `null | 'serve' | 'return'`, present only when the tap changed `pending`;
    the value before the tap.
- Point history entries gain optional `pendingBefore` (`'serve' | 'return'`), present only when
  the point closed an open rally.
- The parser accepts and preserves these fields, rejects malformed values, and accepts entries
  without them. `SESSION_SCHEMA` stays 4.

## Inference (`inferTap`, new, exported, pure)

`inferTap(set, stat, side)` returns `{ servedFirst, letters, pending }` where `letters` is an
ordered array of `{ letter: 'U' | 'T', why: 'resolve' | 'sideout' | 'out' }`. It is only called
for a logged set and a tap that actually raised a count. Steps, in order:

1. `servedFirst = set.servedFirst`. If it is `null`, set `servedFirst = (stat === 'serve')`
   (the first stat tap answers serve-first).
2. If `set.pending !== null`: push `{ letter: stat === 'serve' ? 'U' : 'T', why: 'resolve' }`.
   Otherwise let `srv` be the server computed with the updated `servedFirst`; if
   `srv === 'U' && stat === 'return'` push `{ 'T', 'sideout' }`; if `srv === 'T' && stat === 'serve'`
   push `{ 'U', 'sideout' }`.
3. If `side === 'out'` and (`stat === 'serve'` or `RETURN_OUT_ENDS_RALLY`): push `{ 'T', 'out' }`.
4. `pending = side === 'in' ? stat : (stat === 'return' && !RETURN_OUT_ENDS_RALLY ? 'return' : null)`.

## State functions

- **`tap(s, gameId, n, playerId, stat, side, delta)`**: applies the clamped count change exactly
  as today. If the change is a no-op, return `s` (same reference) and infer nothing. If
  `delta < 0` or the set is typed, push the plain entry as today. Otherwise run `inferTap` on the
  set as it was before the tap, append as many letters as fit under `MAX_POINTS` (from the front
  of the list), set `servedFirst` and `pending`, and push the entry with the optional fields
  defined above. History stays capped at `UNDO_LIMIT`.
- **`tapPoint`**: as today; additionally, when `set.pending !== null`, the entry records
  `pendingBefore` and the set's `pending` becomes `null`.
- **`undo`**:
  - Point entry: as today. Then, if the entry has `pendingBefore` and the set is logged with
    `servedFirst !== null`, restore `pending`.
  - Count entry: reverse the count as today. If it has `points` and `set.points` ends with them,
    remove them (otherwise leave the log alone). If it has `pendingBefore`, restore `pending`.
    If it has `servedFirstSet` and `set.points` is now `''`, set `servedFirst = null`. Finally, if
    the set is typed or `servedFirst === null`, force `pending = null`.
  - Returns `{ session, undone }` as today.
- **`clearPoints`**: as today, and also sets `pending: null` and strips `points`,
  `servedFirstSet` and `pendingBefore` from that set's count entries (they stay as plain count
  entries).
- **`setScore(non-null score)`**: as today, and also sets `pending: null` and strips the same three
  fields from that set's count entries. `setScore(null)` unchanged.
- **`setServedFirst`, `clearSet`, `buildDayStatsPayload`**: unchanged.

## Record screen (`src/ui.js`, `src/styles.css`)

- **Serve-first strip**: unchanged while `servedFirst === null`; it is replaced by the Us / Them
  pills as soon as the first stat tap answers it.
- **Serving dot**: in a logged set with a known server, the serving side's pill gets class
  `serving` and `data-serving="1"`, rendering a 7px dot in `currentColor` before its label.
- **Open rally**: while `pending !== null`, both pills get class `open` and `data-open="1"`;
  CSS makes their border dashed. Pill height, width and labels unchanged.
- **Idle columns**: in a logged set with a known server, the counter buttons and column headers of
  the stat the serving side is not using get class `idle` (opacity 0.5): Return when `'U'` serves,
  Serve when `'T'` serves. Idle buttons stay fully tappable (a tap there is the side-out signal).
- **Toast**: after a count tap that appended letters, a toast reads one phrase per appended letter,
  joined by `", then "`:
  - resolve `U`: `Us +1 · we serve` — resolve `T`: `Them +1 · they serve`
  - side-out `U`: `Us +1 · side-out` — side-out `T`: `Them +1 · side-out`
  - out: `Them +1 · Serve out` or `Them +1 · Return out`

  It is an absolutely positioned element above the bottom bar (`role="status"`,
  `aria-live="polite"`, `pointer-events:none`), so it never moves the rows. It clears on the next
  action of any kind or after 2500 ms.
- **Undo label**: a count entry with `points` reads
  `↶ Undo <first name> <S|R> <in|out> + <Us|Them>[, <Us|Them>]`, e.g. `↶ Undo Emily S out + Us, Them`.
  All other labels unchanged.
- **Minus mode**: unchanged; never touches `points` or `pending`.

## Release

`APP_VERSION` 4.3.0, service worker cache `ciq-stats-v12`, rebuilt `dist/`. No deploy, no commit.

## Testing

- Unit (`test/session.test.mjs`): `inferTap` cases for every row of the serving-side rule; the
  worked example (taps of `docs/auto-score-options.pdf` section 6) ends on `UTTTUUTUUT`; one Undo
  of a two-letter tap restores counts, log and `pending`; Undo of the first tap restores
  `servedFirst: null`; minus and typed sets infer nothing; `MAX_POINTS` cap; `clearPoints` and
  `setScore` strip fields; parser accepts a schema-4 save without the new fields and round-trips one
  with them; `RETURN_OUT_ENDS_RALLY` behaviour.
- Unit (`test/ui.test.mjs`): toast text, Undo label, `idle` / `serving` / `open` markup.
- Browser (`e2e/record.spec.mjs`): a tap sequence drives the score; Undo reverses tap and point.
- Existing tests whose expectations change because inference now runs are updated deliberately,
  each listed in the implementer's report.
- `npm test`, `npm run verify`, `npm run test:browsers` all pass.
