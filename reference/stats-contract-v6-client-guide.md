# Contract v6 — the Client implementation guide

A change brief for the engineer building the iPhone stats app (the "Client"). It covers everything
that moves between contract version 5 and contract version 6, and it is written to be implementable
on its own. Every constant, every error string and every rule below is quoted from the shipped
module rather than summarised, because the two apps share no build step and this prose is the only
thing keeping them in step.

`docs/stats-contract.md` remains the reference for the format as it ends up: schemas, limits, the
full error catalogue, the versioning policy. Read this document to find out *what changed and why*;
read that one when you need the settled answer to "what is legal". This guide assumes you have
already implemented contract 5 (`docs/stats-contract-v4-client-guide.md` and the v5 `servers` list).
v6 does not touch the stats payload. It adds one field to the roster.

---

## 1. What changed, and why — read this before anything else

**The stats payload has not changed.** The Planner still accepts `CIQS2.` to `CIQS5.`, and the
Client still sends `CIQS5.`: `encodeDayStats` is **pinned to 5** (section 6). A major version bump
makes the opposite assumption look reasonable, and it is wrong here.

**Each roster game gains `serve`.** One entry per set, positional like `sets`. Each entry is either
`null` or a short string naming the **planned server of each of the team's rotation turns**. The
Planner already knows the plan: rotations, pairs, coverage, serve overrides, who is absent, Train
lines. It resolves all of that, so the phone does no rotation work. It reads one character per turn
and follows one counting rule (section 3) to know who should be serving.

**`CONTRACT_VERSION` is now `6`.** The roster goes out as `CIQR6.`, and the body's own `v` is `6`.
`encodeDayRoster` is pinned to 6.

**The version-mismatch message changed.** `NOT_A_KNOWN_VERSION` now reads
`its version is not 1, 2, 3, 4, 5 or 6`. It is the same constant on both the roster and the stats
side, so it changes on both.

**Why a bump, when an added field normally does not earn one.** A v5 Client would validate a v6
roster field by field and drop every order without a word, so the highlight would never appear, and
nothing would say why. "This payload was made by a newer version of the Rotation Planner (contract
6); this app understands 5." is the better failure.

**What it means for your code.**
- Re-copy the codec, which brings the pins, the pattern, the five refusals and the v3 lift.
- Store each set's order when a roster is opened or merged.
- Implement the reading rule.
- Highlight the row (the Client's own design: `docs/superpowers/specs/2026-10-08-server-highlight-design.md`).

---

## 2. v5 → v6, side by side

### Roster payload

| Field | v3 (sent at contracts 3–5) | v6 |
|---|---|---|
| `v` | `3` | `6` |
| `kind`, `date`, `team`, `players`, `games[].gameId`, `games[].opponent` | — | unchanged |
| `games[].sets` | one mask per set | unchanged |
| `games[].serve` | — | **new, required** `(string \| null)[]`, same length as `sets` |

A game whose first set has a plan with one empty spot, a second set with no plan, and a third set
on a Train line of seven (key order as the shipped encoder emits it: `gameId`, `opponent`, `sets`,
`serve`):

```json
{ "gameId": "game-1", "opponent": "Lions", "sets": [3, 1, 2], "serve": ["010-10", null, "1111111"] }
```

### Stats payload

No changes. The Client sends `CIQS5.` before and after.

---

## 3. The rules

**A serve string.** It matches `/^[0-9a-v-]{6,16}$/` (`SERVE_ORDER_PATTERN`). Character `t` names
the server of **rotation turn t**:
- `-` means nobody: an empty spot in the plan.
- Any other character is an index into the payload's `players`, written in base 32:
  `parseInt(c, 32)`, so `0`–`9` are 0–9 and `a`–`v` are 10–31. That covers `MAX_DAY_PLAYERS` (32).
- Lowercase only. `A` is not `a`, and `w` and beyond are not digits at all.

**Its length.**
- A slot set's order is 6 long, one per rotation.
- A Train set's order has one entry per spot in its line, `max(6, N)`: a line of 4 is padded with
  two `-`, and a line of 9 is 9 long.
- 16 at most.

**`null`.** No planned serve order for that set: an empty lineup, or nobody resolvable. Show no
highlight for that set.

**Every named index is in that set's mask**, and an order always names somebody: an all-`-` string
is refused, and the Planner sends `null` instead.

### The reading rule

The same rule the Planner's own replay uses, from rotation 1 and with no as-played changes:

- Set `t = 0`.
- Each time we win a rally they served, `t` goes up by one.
- The server of any rally we serve is `serve[t mod length]`.

So when we serve first, our first server is entry 0 (rotation 1). When we receive first, it is
entry 1, because our first side-out moves us to rotation 2. While they serve, our *next* server is
`serve[(t + 1) mod length]`.

```js
// The entry naming our server for rally `at` (0-based; at === points.length is the next rally):
// the rally's server while we serve it, our next server while they do.
function serveEntryAt(points, servedFirst, at, length) {
  let t = 0;
  let weServe = servedFirst;
  for (let i = 0; i < at; i += 1) {
    const won = points[i] === 'U';
    if (won && !weServe) t += 1;
    weServe = won;
  }
  return (weServe ? t : t + 1) % length;
}
```

### The five refusals, in the order the Planner checks them

All are of the form `The roster payload is malformed: <detail>.` Every string below is produced
verbatim by `src/contract/statsContract.ts`. `<gid>` is a game id, `<n>` the set number, `<i>` a
decoded index and `<N>` the directory's length. They run after **every** other roster check, for
every game, so a game over its cap is reported as `game "<gid>" names <n> players; the limit is 16`
first.

1. `game "<gid>" has no serve list with one entry per set` — `serve` is missing, not an array, or a
   different length from `sets`.
2. `game "<gid>" set <n> has a serve order that is not legal` — wrong type, wrong characters, or
   wrong length.
3. `game "<gid>" set <n> serve order names player <i>, but the payload lists only <N>` — the index
   is outside the directory.
4. `game "<gid>" set <n> serve order names a player who is not in that set` — the index's bit is not
   set in that set's mask.
5. `game "<gid>" set <n> serve order names nobody` — the string is all `-`.

Any one of them rejects the **whole paste**, like every other roster refusal.

### Legacy rosters

`decodeDayRoster` always returns the v6 shape:
- A `CIQR3.` roster lifts through `normaliseRosterV3`, which keeps everything and adds
  `serve: sets.map(() => null)`.
- `CIQR2.` and `CIQR1.` lift through v3 the same way.

A coach opening last week's email gets her tick-lists and no highlight.

### Size

The roster goes by `mailto:`. One character per turn costs about 9 characters a set, and a full
4-game, 12-player day with every lineup filled measures 1727 characters against the 1900 warning
line (1529 at contract 5). See "Payload size" in `docs/stats-contract.md`.

---

## 4. A worked example

This is a golden vector — fixed input, fixed encoded output, generated by running the real encoder —
pasted verbatim alongside its decoded JSON. It is `ROSTER_V6_VECTOR` in
`src/contract/__fixtures__/vectors.ts`, and the Planner's own test suite asserts the same string.

Decoded payload:

```json
{
  "v": 6, "kind": "roster", "date": "2026-09-19", "team": "Thunder",
  "players": [
    { "id": "grace", "name": "Grace", "jersey": 7 },
    { "id": "zoie", "name": "Zoë" }
  ],
  "games": [
    { "gameId": "game-1", "opponent": "Lions", "sets": [3, 1, 2], "serve": ["010-10", null, "1111111"] },
    { "gameId": "game-2", "opponent": "Falcons", "sets": [2, 0], "serve": ["111111", null] }
  ]
}
```

Encoded:

```
CIQR6.eyJ2Ijo2LCJraW5kIjoicm9zdGVyIiwiZGF0ZSI6IjIwMjYtMDktMTkiLCJ0ZWFtIjoiVGh1bmRlciIsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJuYW1lIjoiR3JhY2UiLCJqZXJzZXkiOjd9LHsiaWQiOiJ6b2llIiwibmFtZSI6Ilpvw6sifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJvcHBvbmVudCI6Ikxpb25zIiwic2V0cyI6WzMsMSwyXSwic2VydmUiOlsiMDEwLTEwIixudWxsLCIxMTExMTExIl19LHsiZ2FtZUlkIjoiZ2FtZS0yIiwib3Bwb25lbnQiOiJGYWxjb25zIiwic2V0cyI6WzIsMF0sInNlcnZlIjpbIjExMTExMSIsbnVsbF19XX0.841c281c
```

Reading `game-1` set 1, `"010-10"`, over `[Grace, Zoë]`: turn 0 Grace, 1 Zoë, 2 Grace, 3 nobody,
4 Zoë, 5 Grace.
- Serving first, Grace serves the first rally.
- Receiving first, the first side-out makes Zoë our first server.
- Set 2 is `null`, so it shows no highlight.

**The serve-order vector.** `SERVE_ORDER_VECTOR` (same file) checks the reading rule against the
Planner's own replay of 36 rallies:

```json
{
  "order": ["emily", "lexi", "lily", "brooklyn", "melanie", "addison"],
  "servedFirst": false,
  "points": "TTUUUTTUTUUTTUUTUUTTUUUTUTTUUTUUTUTU",
  "servers": [null, null, null, "lexi", "lexi", "lexi", null, null, "lily", null, "brooklyn", "brooklyn",
              null, null, "melanie", "melanie", null, "addison", "addison", null, null, "emily", "emily", "emily",
              null, "lexi", null, null, "lily", "lily", null, "brooklyn", "brooklyn", null, "melanie", null]
}
```

For every rally `i` with `servers[i]` not `null`,
`order[serveEntryAt(points, servedFirst, i, order.length)]` equals `servers[i]`. Receiving first,
Lexi (entry 1) serves our first turn, and Emily (entry 0) first serves at rally 21 after the order
wraps.

---

## 5. Client change checklist

- [ ] **Re-copy `codec.js` and `vectors.js`** from the Planner's `statsContract.ts` and
      `__fixtures__/vectors.ts`. That brings:
      - `CONTRACT_VERSION = 6` and `SERVE_ORDER_PATTERN`;
      - the five refusals and the new `NOT_A_KNOWN_VERSION` text;
      - `validateDayRosterPayloadV3` and `normaliseRosterV3`;
      - the pins: `encodeDayRoster` to 6 and `encodeDayStats` to 5.
- [ ] **Keep `encodeDayStats` pinned to 5.** The re-copied file already does it
      (`encodePayload('stats', payload, 5)`). Do not "fix" it back to the default, or the phone
      exports `CIQS6.` around a `"v":5` body and refuses itself.
- [ ] **Add the new golden vectors to your self-check:**
      - `encodeDayRoster(ROSTER_V6_VECTOR.payload)` equals `ROSTER_V6_VECTOR.encoded`, and it decodes
        back to the payload;
      - `decodeDayRoster` of the v3, v2 and v1 roster vectors deep-equals `ROSTER_V3_AS_V6`,
        `ROSTER_V2_AS_V6` and `ROSTER_V1_AS_V6`;
      - every served rally of `SERVE_ORDER_VECTOR` reads back its server by the reading rule.
- [ ] **Store each set's order at ingest.** Resolve characters to ids once
      (`players[parseInt(c, 32)].id`, `-` → `null`), so a later merge that reorders the directory
      cannot shift them.
- [ ] **Implement the reading rule exactly.** `t` counts side-outs we win; we serve
      `serve[t mod length]`; while they serve, the next server is entry `t + 1`.
- [ ] **No plan, no highlight:** a `null` entry, a `-`, an older roster, a set whose serve-first is
      unanswered, or a server not ticked for the set.
- [ ] **Never edit the order on the phone.** It is the Planner's plan; what really happened travels
      back in the v5 `servers` list.

---

## 6. Compatibility, from the Client's side

| | Roster (Planner → Client) | Stats (Client → Planner) |
|---|---|---|
| Planner **emits** | `CIQR6` only | — |
| Planner **accepts** | — | `CIQS2`, `CIQS3`, `CIQS4` **and** `CIQS5` |
| Client **should emit** | — | `CIQS5` |
| Client **must accept** | `CIQR6`, and `CIQR3`/`CIQR2`/`CIQR1` for old emails | — |

**A 4.5.0 phone refuses `CIQR6.`** It says
`This payload was made by a newer version of the Rotation Planner (contract 6); this app understands 5.`
Nothing is lost — the coach updates the phone app and opens the email again. **Ship the Planner
and the phone together.**

**A 4.6.0 phone reads v1, v2, v3 and v6 rosters.** Only v6 carries a plan; the others open with no
highlight.

**Why `encodeDayStats` is pinned to 5.** `decodePayload` treats a body `v` that differs from the
prefix as corruption. The stats body still says `"v":5`, so with the default version a sheet would
go out as `CIQS6.` around a `"v":5` body and be refused. A Planner that predates contract 6 reads
`CIQS5.` fine, which is the point: the stats did not change, so they should not become unreadable.

---

## 7. What has **not** changed

Nothing in this list needs a line of Client work; it is here so you do not go looking.

- **The stats payload**, in every field, every rule, every error string, and the `CIQS5.` prefix.
  `servers` is still how the phone tells the Planner who really served.
- **The encoded form.** `<CIQR|CIQS><version>.<base64url of UTF-8 JSON>.<8 hex chars>`, two literal
  dots, three fields.
- **`fnv1a32`, Base64URL, whitespace stripping, the decode order.**
- **`games[].sets`**: one mask per set, read with the arithmetic helpers, never bitwise.
- **The limits.**
  - `MAX_GAMES_PER_DAY` (8), `MAX_DAY_PLAYERS` (32), `MAX_ROSTER_PLAYERS` (16), `MAX_SETS` (5);
  - `MAX_COUNT` (999), `MAX_NAME_LENGTH` (64), `MAX_RECORDED_AT_LENGTH` (32), `MAX_POINTS` (200).
- **The `cx-` namespace** for Client-created players: `CLIENT_ID_PATTERN`,
  `/^cx-[A-Za-z0-9_-]{4,32}$/`, and `ID_PATTERN` `/^[A-Za-z0-9_-]{1,64}$/` for every id.
