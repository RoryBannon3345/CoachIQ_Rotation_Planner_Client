# Contract v4 — the Client implementation guide

A change brief for the engineer building the iPhone stats app (the "Client"). It covers everything
that moves between contract version 3 and contract version 4, and it is written to be implementable
on its own: every constant, every error string and every rule below is quoted from the shipped
module rather than summarised, because the two apps share no build step and this prose is the only
thing keeping them in step.

`docs/stats-contract.md` remains the reference for the format as it ends up — schemas, limits, the
full error catalogue, the versioning policy. Read this document to find out *what changed and why*;
read that one when you need the settled answer to "what is legal". This guide assumes you have
already implemented the v3 contract (`docs/stats-contract-v3-client-guide.md`) — per-set roster
masks in, a day of stats out. v4 does not touch the roster. It touches the stats set.

---

## 1. What changed, and why — read this before anything else

**The roster payload has not changed.** Say that twice, because a major version bump makes the
opposite assumption look reasonable and it is wrong here. `games[].sets` masks, `MAX_SETS`, the
tick-lists, the legacy `CIQR1.`/`CIQR2.` normalisation: all untouched. The Planner still sends
`CIQR3.`, and `encodeDayRoster` is **pinned to 3** so that it keeps doing so (section 6).

**A stats set gains two optional fields.** `servedFirst` (a boolean) and `points` (a string), both
or neither. `points` is the set's **point log**: one character per rally, in the order they were
played, `U` when your team won the rally and `T` when the opponent did. `servedFirst` says whether
your team served the first rally. With those two facts and the Planner's own planned lineup, the
Planner can replay the set rally by rally and work out who was on court for each point. The Client
never sends a lineup: it records what happened, the Planner supplies who was where.

**`CONTRACT_VERSION` is now `4`.** A logged day goes out as `CIQS4.`, and the body's own `v` is `4`.
The Planner's stats validator accepts a body whose `v` is `2`, `3` **or** `4`, and returns `v: 4`
for all three.

**The version-mismatch message changed.** `NOT_A_KNOWN_VERSION` now reads
`its version is not 1, 2, 3 or 4`, where v3 said `its version is not 1, 2 or 3`. It is the same
constant on both the roster and the stats side, so it changes on both.

**Why a bump, when an optional field normally does not earn one.** A v3 Planner handed a logged day
would validate it field by field and drop every log without a word; the coach would find out after
"New day" on the phone, when the rally record she had been keeping was already gone. "Made by a newer
version of the stats app (contract 4); this app understands 3" is the better failure, so this
bumps on purpose. The exception is recorded in `docs/stats-contract.md`'s versioning policy.

**What it means for your code.** Four things: `encodeDayStats` encodes at 4 (and the Client's own
earlier pin of it to 2 goes away when you re-copy the Planner's file — the Planner's file never had
that pin); `encodeDayRoster` is pinned to 3; `buildDayStatsPayload` sends `v: 4`; and for a set
with a point log it also sends `score` equal to the tally plus the two new fields.

---

## 2. v3 → v4, side by side

### Stats payload

| Field | v3 | v4 |
|---|---|---|
| `v` | `3` (or `2`) | `4` |
| `kind`, `recordedAt`, `players`, `games[].gameId` | — | unchanged |
| `games[].sets[].n` | `number`, 1–5 | unchanged |
| `games[].sets[].score` | `[us, them] \| null`, key required | unchanged — but **must equal the tally** when a log is present |
| `games[].sets[].players` | stat lines | unchanged |
| `games[].sets[].servedFirst` | — | **new, optional** `boolean`; present with `points` or not at all |
| `games[].sets[].points` | — | **new, optional** `string`, `/^[UT]{1,200}$/`; present with `servedFirst` or not at all |

A set **with** a log, and one **without**, in one game (the key order is the one the shipped
encoder emits, and the one the golden vector below is built in — `n`, `score`, `players`,
`servedFirst`, `points`):

```json
{ "n": 1, "score": [25, 21], "players": [ … ], "servedFirst": true, "points": "UUTUTTUUUTTUTTUUTUTTTUUUTUTTUUTUTTUUUTTUTUUTUU" }
{ "n": 2, "score": null, "players": [ … ] }
```

The second set has no log, so it carries **neither** field — not `"points": ""`, not
`"servedFirst": false`. A set the Client recorded no rallies for is a v3 set, exactly as it was.

Key order is not part of the contract: a body whose fields come in another order is valid. It only
matters for matching the golden vector byte for byte (section 4).

### Roster payload

No changes. The roster is `CIQR3.` before and after.

---

## 3. The rules

**`points`.** One character per rally, in play order. `U` means *your* team won the rally (**U**s),
`T` means the opponent did (**T**hem). Nothing else is legal: no spaces, no lowercase, no other
letter. At most `MAX_POINTS` = **200** characters. A 25-point set that goes to deuce is under 60;
200 is far above any real set and is a sanity cap, not a fit to any medium.

**`servedFirst`.** `true` when your team served the set's first rally, `false` when the opponent
did. Present exactly when `points` is.

**`score` is required and is the tally.** When a set carries a log, its `score` must be the
two-entry array `[us, them]` where `us` is the number of `U` characters in `points` and `them` is
the number of `T` characters — and the two always sum to `points.length`. A `null` score on a logged
set is refused. The Client therefore derives `score` from the log it just recorded; it must not
let the two drift apart (a coach correcting a score by hand after the fact would need to correct
the log, or drop it).

**An empty log is omitted, not sent as `''`.** A set with no rallies logged has no `servedFirst`
and no `points`. `points: ''` is refused.

**All-or-nothing.** `servedFirst` without `points`, or `points` without `servedFirst`, is refused.

### The seven refusals, in the order the Planner checks them

All are of the form `The stats payload is malformed: <detail>.` Every string below is produced
verbatim by `src/contract/statsContract.ts`; `<gid>` is a game id and `<n>` the set number. They run
per set, after the set's number and score have been checked and before its player list is read. A
set with neither field skips all seven.

1. `game "<gid>" set <n> has a malformed point log` — `points` is present and not a string, or
   `servedFirst` is present and not a boolean.
2. `game "<gid>" set <n> has half a point log` — one of the two is present without the other.
3. `game "<gid>" set <n> has an empty point log; leave it out instead` — `points` is `''`.
4. `game "<gid>" set <n> records more than 200 rallies` — longer than `MAX_POINTS`.
5. `game "<gid>" set <n> has a point log with a character other than U or T`
6. `game "<gid>" set <n> has a point log but no score` — `score` is `null`.
7. `game "<gid>" set <n> has a score that disagrees with its point log` — `score` is not exactly
   `[count of U, count of T]`.

Any one of them rejects the **whole paste**, not just that set, the same as every other stats
refusal. There is nothing to catch on the Client; the point is to produce a payload that never
trips them.

### Size is not a ceiling

Stats travel by clipboard into a textarea, **never by `mailto:`**, so a point log does not run into
any length limit. The roster is the one that goes by `mailto:`, and it is unchanged.

---

## 4. A worked example

This is a golden vector — fixed input, fixed encoded output, generated by running the real encoder —
pasted verbatim alongside its decoded JSON. It is `STATS_V4_VECTOR` in
`src/contract/__fixtures__/vectors.ts`, and the Planner's own test suite asserts the same string.

It is the v3 vector with its version digit moved to `4` and one log added: `game-1` set 1, served
first by the Client's team, 46 rallies (`POINTS_46` — 25 `U` and 21 `T`), so `score` is `[25, 21]`.
`game-1` set 2 and `game-2` have no log and are byte-identical to v3 apart from the digit.

Decoded payload:

```json
{
  "v": 4, "kind": "stats", "recordedAt": "2026-09-19T21:04:00Z",
  "players": [
    { "id": "grace", "name": "Grace" },
    { "id": "cx-8f2k1q", "name": "Ava" }
  ],
  "games": [
    { "gameId": "game-1", "sets": [
      { "n": 1, "score": [25, 21], "players": [
        { "id": "grace", "serve": { "in": 8, "out": 2 }, "return": { "in": 5, "out": 1 } },
        { "id": "cx-8f2k1q", "serve": { "in": 0, "out": 0 }, "return": { "in": 3, "out": 0 } }
      ], "servedFirst": true, "points": "UUTUTTUUUTTUTTUUTUTTTUUUTUTTUUTUTTUUUTTUTUUTUU" },
      { "n": 2, "score": null, "players": [
        { "id": "grace", "serve": { "in": 4, "out": 1 }, "return": { "in": 2, "out": 2 } }
      ] }
    ] },
    { "gameId": "game-2", "sets": [
      { "n": 1, "score": [25, 18], "players": [
        { "id": "cx-8f2k1q", "serve": { "in": 6, "out": 1 }, "return": { "in": 2, "out": 0 } }
      ] }
    ] }
  ]
}
```

Encoded:

```
CIQS4.eyJ2Ijo0LCJraW5kIjoic3RhdHMiLCJyZWNvcmRlZEF0IjoiMjAyNi0wOS0xOVQyMTowNDowMFoiLCJwbGF5ZXJzIjpbeyJpZCI6ImdyYWNlIiwibmFtZSI6IkdyYWNlIn0seyJpZCI6ImN4LThmMmsxcSIsIm5hbWUiOiJBdmEifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJzZXRzIjpbeyJuIjoxLCJzY29yZSI6WzI1LDIxXSwicGxheWVycyI6W3siaWQiOiJncmFjZSIsInNlcnZlIjp7ImluIjo4LCJvdXQiOjJ9LCJyZXR1cm4iOnsiaW4iOjUsIm91dCI6MX19LHsiaWQiOiJjeC04ZjJrMXEiLCJzZXJ2ZSI6eyJpbiI6MCwib3V0IjowfSwicmV0dXJuIjp7ImluIjozLCJvdXQiOjB9fV0sInNlcnZlZEZpcnN0Ijp0cnVlLCJwb2ludHMiOiJVVVRVVFRVVVVUVFVUVFVVVFVUVFRVVVVUVVRUVVVUVVRUVVVVVFRVVFVVVFVVIn0seyJuIjoyLCJzY29yZSI6bnVsbCwicGxheWVycyI6W3siaWQiOiJncmFjZSIsInNlcnZlIjp7ImluIjo0LCJvdXQiOjF9LCJyZXR1cm4iOnsiaW4iOjIsIm91dCI6Mn19XX1dfSx7ImdhbWVJZCI6ImdhbWUtMiIsInNldHMiOlt7Im4iOjEsInNjb3JlIjpbMjUsMThdLCJwbGF5ZXJzIjpbeyJpZCI6ImN4LThmMmsxcSIsInNlcnZlIjp7ImluIjo2LCJvdXQiOjF9LCJyZXR1cm4iOnsiaW4iOjIsIm91dCI6MH19XX1dfV19.876bfbe7
```

Check your own encoder against it: same input object in (keys in the order shown, no whitespace),
same encoded string out. If you are only decoding, same decoded object out.

---

## 5. Client change checklist

- [ ] **Re-copy `codec.js` and `vectors.js`** from the Planner's `statsContract.ts` and
      `__fixtures__/vectors.ts`. That brings `CONTRACT_VERSION = 4`, `MAX_POINTS`, the seven
      refusals and the new `NOT_A_KNOWN_VERSION` text, and removes the Client's own pin of
      `encodeDayStats` to 2 (the Planner's file never had it).
- [ ] **Keep `encodeDayRoster` pinned to 3** — the re-copied file already does it
      (`encodePayload('roster', payload, 3)`). Do not "fix" it back to the default.
- [ ] **Add the new golden vectors to your self-check:** `STATS_V4_VECTOR` (section 4), plus
      `STATS_V2_AS_V4` and `STATS_V3_AS_V4` — the expected result of decoding the existing v2 and v3
      stats vectors, which is each vector's payload with `v` replaced by `4`. (The Planner's tests
      assert exactly that, spelled `{ ...STATS_V2_VECTOR.payload, v: 4 }`.)
- [ ] **The self-check must encode v4 and decode v2 and v3 as v4:** `encodeDayStats(STATS_V4_VECTOR.payload)`
      equals `STATS_V4_VECTOR.encoded`; `decodeDayStats` of the v2 and v3 vector strings succeeds and
      returns the same payloads with `v: 4`.
- [ ] **`buildDayStatsPayload` sends `v: 4`.** For a set with a point log it sends `score` equal to
      the tally of `points` (`U` count, then `T` count) plus `servedFirst` and `points`, with the
      keys in the order `n`, `score`, `players`, `servedFirst`, `points`.
- [ ] **A set with no rallies logged sends neither field.** Never `points: ''`, never a lone
      `servedFirst`.
- [ ] **Never send more than 200 characters in `points`.** If the Client's own log can grow past
      that, stop accepting taps (or drop the log for that set) rather than send a payload the
      Planner will refuse whole.
- [ ] **Never send a `null` score with a log.**

---

## 6. Compatibility, from the Client's side

| | Roster (Planner → Client) | Stats (Client → Planner) |
|---|---|---|
| Planner **emits** | `CIQR3` only | — |
| Planner **accepts** | — | `CIQS2`, `CIQS3` **and** `CIQS4` |
| Client **should emit** | — | `CIQS4` |
| Client **must accept** | `CIQR3`, and `CIQR2`/`CIQR1` for old emails | — |

**Why `encodeDayRoster` is pinned to 3.** `decodePayload` treats a body `v` that differs from the
prefix as corruption. The roster body still says `"v":3`, so with the default version a roster would
go out as `CIQR4.` around a `"v":3` body and be refused by the Client's own decoder. An
un-updated Client reading `CIQR3.` keeps working, which is the point: the roster did not change, so
it should not be unreadable.

**An un-updated Client's stats still import.** Its `CIQS2.` strings are accepted, with no log, and
import exactly as before.

**An un-updated Planner refuses `CIQS4.`.** It says
`This payload was made by a newer version of the stats app (contract 4); this app understands 3.`
Nothing is lost — the coach copies it again once the Planner is updated — but she will see an
error where she used to see a preview. **Ship the Planner first**, then the Client.

---

## 7. What has **not** changed

Nothing in this list needs a line of Client work; it is here so you do not go looking.

- **The roster payload**, in every field, every rule, every error string, and the `CIQR3.` prefix.
- **The encoded form.** `<CIQR|CIQS><version>.<base64url of UTF-8 JSON>.<8 hex chars>`, two literal
  dots, three fields.
- **`fnv1a32`, Base64URL, whitespace stripping, the decode order.** Identical to v3.
- **Stat lines.** `{ id, serve: { in, out }, return: { in, out } }`, whole numbers 0–999, totals
  still never transmitted. Per-game set numbering, omitted unplayed sets, `score` as a required key.
- **`MAX_GAMES_PER_DAY` (8), `MAX_DAY_PLAYERS` (24), `MAX_ROSTER_PLAYERS` (12), `MAX_SETS` (5),
  `MAX_COUNT` (999), `MAX_NAME_LENGTH` (64), `MAX_RECORDED_AT_LENGTH` (32).** None of these numbers
  moved. `MAX_POINTS` (200) is the only new one.
- **The `cx-` namespace** for Client-created players: `CLIENT_ID_PATTERN`,
  `/^cx-[A-Za-z0-9_-]{4,32}$/`, and `ID_PATTERN` `/^[A-Za-z0-9_-]{1,64}$/` for every id.
- **How the stats travel.** By clipboard, never `mailto:`; the `mailto:` rules for the roster are
  untouched.
