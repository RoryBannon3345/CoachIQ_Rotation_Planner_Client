# The stats contract

The copy/paste payload format shared between CoachIQ Rotation Planner (this app) and the
separate iPhone stats app (the "Client"). Both apps implement the same codec independently —
this document is the shared source of truth, including test vectors either implementation can be
checked against.

## Purpose

The coach plans lineups here, then sends the Client a roster for a **day** of games so it knows who
is playing in each of them. During each game the Client records serve and service-return counts per
set, and the coach switches between the day's games without reloading anything. At the end of the
day she copies the Client's stats payload back here — one payload covering every game it holds — and pastes
it in. There is no network between the two apps: everything travels as plain text, by copy/paste
(the roster typically through email, the stats sheet by clipboard — see "Payload size"), so the
format has to survive a mail client's line-wrapping and quoting.

This app's implementation lives in `src/contract/statsContract.ts`, deliberately with **zero
imports** — the Client is plain HTML/JS on iOS Safari and copies that file's logic verbatim
rather than sharing a build step with it. Keep this document and that file in sync by hand.

The current contract is **version 6**, which gives each roster game a `serve` list — one compact
string per set naming the planned server of each of the team's rotation turns — so the phone can
highlight who should be serving. The stats half is unchanged from **version 5**, which lets each
logged stats set say who served each of the team's serve turns — `servers`, one id or `null` per
serve turn. Version 4 added the point log — `servedFirst` and `points`, one `U` or `T` per rally —
so the Planner can replay who was on court. Version 3 replaced `games[].roster` — one index array
per game, naming everyone who played anywhere in it — with `games[].sets`, one bitmask per set, so
a roster can say how many sets a game has and who is in each one.
`docs/stats-contract-v3-client-guide.md`, `docs/stats-contract-v4-client-guide.md` and
`docs/stats-contract-v6-client-guide.md` are the companion change briefs written for the Client's
author: what moved, why, and what the Client has to do about it. This document is the reference
for the format as it ends up, and it keeps the v1, v2 and v3 roster schemas, because v1 stats
payloads are still accepted and every legacy roster shape still decodes.

## The encoded form

```
CIQR6.<base64url of UTF-8 JSON>.<8 hex chars>      roster payload, contract 6 (what the Planner sends)
CIQS5.<base64url of UTF-8 JSON>.<8 hex chars>      stats payload, contract 5 (what the Client sends; stats did not change at 6)
CIQS4.<base64url of UTF-8 JSON>.<8 hex chars>      stats payload, contract 4 (accepted)
CIQR3.<base64url of UTF-8 JSON>.<8 hex chars>      roster payload, contract 3 (legacy: what the Planner sent at contracts 3–5)
CIQS3.<base64url of UTF-8 JSON>.<8 hex chars>      stats payload, contract 3 (accepted)
CIQR2.<base64url of UTF-8 JSON>.<8 hex chars>      roster payload, contract 2 (legacy)
CIQS2.<base64url of UTF-8 JSON>.<8 hex chars>      stats payload, contract 2 (legacy)
CIQR1.<base64url of UTF-8 JSON>.<8 hex chars>      roster payload, contract 1 (legacy)
CIQS1.<base64url of UTF-8 JSON>.<8 hex chars>      stats payload, contract 1 (legacy)
```

- `CIQR` / `CIQS` name the payload **kind** (roster / stats). A decoder reads this before
  touching the body, so it can say "this is a roster, not stats" without attempting to parse
  anything.
- The digit immediately after the kind letters (`6` today) is the **contract major version**
  (`CONTRACT_VERSION`). Each kind is pinned to the contract that last changed it:
  `encodeDayRoster` sends `6`, and `encodeDayStats` sends `5`, because the stats half did not
  change at contract 6 and an un-updated Planner must keep reading `CIQS5.`. A decoder refuses a
  payload whose version is higher than the one it understands, before attempting to decode the
  body.
- The two literal `.` characters separate three fields: `<prefix+version>.<body>.<checksum>`.

**The algorithm itself is unchanged by the version 2, 3, 4, 5 or 6 bump.** Same Base64URL, same FNV-1a over the
same UTF-8 bytes, same whitespace stripping, same order of checks. Only the JSON inside the
envelope is different — which is precisely why it earned a major bump rather than passing as a
widening: fields moved and were renamed, so an older decoder would not merely ignore something new,
it would be wrong about what it had.

### The exact algorithm

**Encoding** (`encodePayload`):

1. `JSON.stringify` the payload object → a JSON string.
2. UTF-8 encode it with `TextEncoder` → bytes. (Plain `btoa` throws on any character outside
   Latin-1, and player names are not guaranteed to be Latin-1 — e.g. "Zoë".)
3. Base64-encode the bytes with `btoa`, then make it URL-safe: `+` → `-`, `/` → `_`, and strip
   trailing `=` padding. Base64URL survives email untouched: no quotes for a mail client to
   smart-quote, no `+`/`/` for a URL-rewriter to mangle.
4. Compute `fnv1a32` (below) over the same UTF-8 bytes from step 2 (**not** over the Base64URL
   text) → 8 lowercase hex characters.
5. Join: `${prefixForKind}${version}.${base64url}.${checksum}`.

`encodePayload` takes that `version` as a third argument, defaulting to `CONTRACT_VERSION`. It is
not decoration: the prefix version and the body's own `v` must agree, and `decodePayload` calls any
disagreement corruption. Now that `CONTRACT_VERSION` is 6, a v1 body encoded with the default would
go out as `CIQS6.` wrapped around `"v":1` and be refused by this very module. So the surviving v1
encoders pass `1` explicitly — which is also what keeps the v1 golden vectors below byte-identical.
The day encoders pin theirs for the same reason: `encodeDayRoster` passes `6`, and `encodeDayStats`
passes `5`, because the stats body still says `"v":5` and a `CIQS6.` prefix around it would be
refused as corruption.

**Decoding** (`decodePayload`), in this exact order:

1. **Strip all whitespace** (`text.replace(/\s+/g, '')`) — an email client line-wraps and may
   indent continuation lines; every one of those characters is discarded before anything else
   happens, so wrapping is always harmless.
2. Match the head `^(CIQ[RS])(\d+)\.` to read the kind and the version. No match at all →
   "not a CoachIQ payload". A kind that doesn't match what the caller expected → the
   kind-mismatch error. A version higher than `CONTRACT_VERSION` → the newer-app error. These
   three checks happen **before** the checksum is verified, so they are reported even on an
   otherwise-corrupt payload — the caller doesn't need a trustworthy body to learn "wrong kind"
   or "too new".
3. Match the full pattern `^(CIQ[RS])(\d+)\.([A-Za-z0-9_-]*)\.([0-9a-f]{8})$`. No match (e.g. the
   payload was truncated mid-field) → the corruption error.
4. Base64URL-decode the body: re-add `-`→`+`, `_`→`/`, pad with `=` to a multiple of 4, then
   `atob`. Any failure → the corruption error.
5. Recompute `fnv1a32` over the decoded bytes and compare to the trailing hex checksum. A
   mismatch (truncation, a flipped character, a dropped line) → the corruption error, **not** a
   JSON parse error — a coach can act on "corrupted, copy it again" but not on "unexpected token".
6. UTF-8 decode the bytes (`TextDecoder`) and `JSON.parse`. A parse failure → the corruption
   error.
7. Confirm the **parsed body's own** `v` and `kind` fields agree with the ones already read from
   the prefix. A hand-edited or mismatched body is treated as corruption, not as a differently
   valid payload.
8. Return the parsed (but not yet shape-validated) JSON value. `decodeDayRoster` /
   `decodeDayStats` then dispatch on the body's own `v`, and always hand back a day payload, so
   nothing downstream has to branch on a version:
   - **Roster:** `1` runs the v1 validator and lifts the result through v2 and v3 to v6
     (`normaliseRosterV1`). `2` runs the v2 validator and lifts it the same way (a per-game
     `roster` index array becomes a single set mask). `3` runs the v3 checks
     (`validateDayRosterPayloadV3`) and lifts the result to v6 with every `serve` entry `null`
     (`normaliseRosterV3`). `6` runs the current roster validator directly. Anything else is
     `its version is not 1, 2, 3, 4, 5 or 6`.
   - **Stats:** `1` runs the v1 validator and normalises the result into the day shape. `2`,
     `3`, `4` and `5` run the current stats validator, which accepts all four (see "Stats payload
     schema"). Anything else, `6` included, is `its version is not 1, 2, 3, 4, 5 or 6`.

   Dispatching on that `v` is safe because step 7 has already proved it equals the prefix version
   the transport layer vouched for.

### `fnv1a32`

FNV-1a, 32-bit, computed over raw bytes and rendered as 8 lowercase hex characters:

```js
function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
```

Reference values: `fnv1a32([])` = `811c9dc5`; `fnv1a32(utf8("a"))` = `e40c292c`.

## Roster payload schema (contract v6)

One day, the player directory of the games it carries, and those games — every game of the day,
or the ones the coach ticked (at most three an email, a Planner rule, not a contract limit). A day
may arrive as several roster payloads with the same `date`; the Client merges each into the day it
holds. Validated by `validateDayRosterPayload`.

| Field | Type | Rule |
|---|---|---|
| `v` | `6` | Must equal the version named in the prefix. |
| `kind` | `"roster"` | Fixed. |
| `date` | `string` | Non-empty. The day this payload is about — the identity of a day payload, so a blank one is refused. |
| `team` | `string` | Display-only. May be empty: `createTeam` does not trim, so a coach who never named her team has a blank one, and refusing it would refuse a real save. |
| `players` | array | The day's **directory**: 1–32 entries (`MAX_DAY_PLAYERS`), unique ids. A day's directory spans every game of the day, so it is legitimately larger than any one game's tick-list (`MAX_ROSTER_PLAYERS`) — squads rotate across games and a tournament day can field two teams' worth of names. |
| `players[].id` | `string` | Matches `ID_PATTERN` (see below). |
| `players[].name` | `string` | Required, 1–64 characters (`MAX_NAME_LENGTH`). The **day display name**: her first name, or `First L.` when two players on the day share a first name (`src/domain/displayName.ts`). It is what the Planner's own Set roster shows, so the phone and the rail agree. The Client displays it verbatim and never parses it. |
| `players[].jersey` | `number` | Optional — this app's roster panel does not collect jerseys today, so it is usually absent. |
| `games` | array | 1–8 entries (`MAX_GAMES_PER_DAY`), at least one. |
| `games[].gameId` | `string` | Non-empty, unique within the payload. Echoed back in the stats payload to match the game. |
| `games[].opponent` | `string` | Display-only. May be empty, the same way `team` may: a game against an unnamed opponent is a real thing a coach plans, and the Client only ever prints this string. |
| `games[].sets` | `number[]` | 1–5 entries (`MAX_SETS`), **one bitmask per set, positional** — `sets[0]` is set 1, and `sets.length` is how many sets the game has. Bit `i` set means `players[i]` is in that set. Each entry is a whole number `0 ≤ mask < 2 ** players.length`. A set nobody is picked for is `0`. The **union** across a game's sets may name at most 16 players (`MAX_ROSTER_PLAYERS`). |
| `games[].serve` | `(string \| null)[]` | **Required, contract 6.** Same length as that game's `sets`, positional: `serve[0]` is set 1. `null`: no planned serve order for that set (an empty lineup, nobody resolvable). |
| `games[].serve[k]` | `string` | Matches `/^[0-9a-v-]{6,16}$/` (`SERVE_ORDER_PATTERN`). Character `t` names the server of **rotation turn t**: `-` means nobody (an empty spot); any other character is a directory index in base 32 (`parseInt(c, 32)`, 0–31, which covers `MAX_DAY_PLAYERS`). Every index is in that set's mask, and at least one character is not `-`. A slot set's order is always 6 long; a Train set's has one entry per spot in its line, `max(6, N)`. 16 is the most, since a line of 17 names more players than a game may. |

### Reading a set mask

```js
// Bit i of a set mask means players[i] is in that set. Arithmetic, never bitwise:
// JavaScript's | and & coerce to signed 32-bit, so 2**31 | 0 is negative.
function maskHas(mask, index) { return Math.floor(mask / 2 ** index) % 2 === 1; }
function maskMembers(mask, size) {
  const out = [];
  for (let i = 0; i < size; i += 1) if (maskHas(mask, i)) out.push(i);
  return out;
}
// sets: [3, 1, 2] over a 2-player directory ->
//   set 1: players 0 and 1   set 2: player 0   set 3: player 1
```

This is not a precaution. With the day directory at 32 players (`MAX_DAY_PLAYERS`), the top bit
(player index 31) is `2 ** 31`, which is exactly the bit JavaScript's bitwise operators turn
negative, and a full 32-player mask is `2 ** 32 - 1` = `4294967295`. A reader built on `|`, `&`,
`<<`, `>>`, `>>>`, `~` or `^` would read player 32 as absent or negative and tick the wrong girls
with no error. Use only the arithmetic helpers (`maskHas`, `maskOf`, `maskMembers`, `maskCount`,
`maskUnion`); they stay exact to 2^53, so the hard ceiling on the directory size is 53.

### The four rules about `games[].sets`

None of these can be enforced by a validator — a payload that gets them wrong is perfectly legal and
merely behaves badly in a gym — so they are stated here, where both implementations read them.

- **Each set's mask is a pre-selection, not a whitelist.** The Client's tick-list for any set of any
  game shows the **whole directory**, with that set's bits pre-ticked. That is what lets a coach
  record an unplanned set, or add a girl the morning's plan did not include, without minting a `cx-`
  duplicate of someone already sitting in the directory under her real id.
- **An empty set mask (`0`) is legal.** A coach can send the day before she has picked who plays a
  game's later sets; refusing that would make her choose between sending early and sending at all.
  Show the full directory with nothing ticked for that set.
- **`cx-` is only for someone not in the day directory at all.** It is never the right answer for a
  player who is in `players` but simply has no bit set in one of this game's sets. Once the payload
  reaches this app a `cx-` id is indistinguishable from a genuine new guest, so the distinction is
  entirely the Client's to keep.
- **`sets.length` is the set count, and it is authoritative.** The Client must build that many set
  tabs rather than assuming three. This is what closes the gap described under "Set count".

### Reading a serve order

`serve[k]` is the Planner's plan for set `k + 1`: who serves each of the team's rotation turns,
starting from rotation 1. The Planner does all the resolving — rotations, pairs, coverage, serve
overrides, availability, Train lines — so the Client does no rotation work. It reads the string
with one rule, the same rule the Planner's own replay (`replaySet`) uses with no as-played changes:

- Set `t = 0`.
- Each time we win a rally they served, `t` goes up by one.
- The server of any rally we serve is `serve[t mod length]`.

So when we serve first, our first server is entry 0 (rotation 1). When we receive first, it is
entry 1, because our first side-out moves us to rotation 2. While they serve, our *next* server
is `serve[(t + 1) mod length]`.

```js
// The entry of a serve string of `length` characters that names our server for rally `at`
// (0-based; `at === points.length` is the next rally). While we serve that rally, it is the
// rally's server; while they do, it is our next server.
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

**Worked example.** In the v6 golden vector below, `game-1`'s directory is
`[Grace, Zoë]` and its set 1 order is `"010-10"`: rotation turn 0 Grace, 1 Zoë, 2 Grace,
3 nobody, 4 Zoë, 5 Grace. Receiving first, a log of `TU` leaves `t = 1`, so our first server is
entry 1, Zoë. After `TUUT` she has lost the serve, so they serve and our next server is entry 2,
Grace. Once we have won six of their serves, `t = 6` and the order wraps back to entry 0. An entry of `-` is a
turn the plan has nobody at 1 for: show no server. `SERVE_ORDER_VECTOR` under "Golden vectors"
is a longer check of the same rule against the Planner's replay.

## Roster payload schema (contract v3, legacy)

A `CIQR3.` roster — what the Planner sent at contracts 3, 4 and 5 — is the v6 shape without
`serve`, with `v` = `3`. `decodeDayRoster` runs the same checks over it
(`validateDayRosterPayloadV3`, internal to `statsContract.ts`) and lifts the result with
`normaliseRosterV3`, which adds `serve: sets.map(() => null)`. A v3 roster carried no serve
order, and inventing one would put a plan in front of the coach that nobody made. Every error
message is the v6 one, apart from the five serve-order refusals, which a v3 body cannot reach.

## Stats payload schema (contract v2, v3, v4 or v5)

One day's recording across every game the Client tracked. Validated by `validateDayStatsPayload`.
No `date`, `team` or `opponent`: the import matches each game on `gameId` and this app already knows
the rest, so re-sending them would only create a second source of truth for facts this app owns.

**This shape hasn't changed since contract 2 except for the optional point log added at contract
4 and its optional `servers` added at contract 5** — only the roster half moved at contract 3 — so
`validateDayStatsPayload` accepts a body whose `v` is `2`, `3`, `4` **or** `5`, and always returns
`v: 5`. An un-updated Client still producing `v: 2`, `v: 3` or `v: 4` stats bodies can keep sending
a whole day of stats even though it cannot read a newer roster.

| Field | Type | Rule |
|---|---|---|
| `v` | `2`, `3`, `4` or `5` | Must equal the version named in the prefix. Any of the four is accepted here, unlike the roster half — see above. |
| `kind` | `"stats"` | Fixed. |
| `recordedAt` | `string` | Non-empty ISO timestamp, from the Client's clock. At most 32 characters (`MAX_RECORDED_AT_LENGTH`). |
| `players` | array | The day's directory, of `{ id, name }` entries — 1–32 of them (`MAX_DAY_PLAYERS`), unique ids, each `id` matching `ID_PATTERN` and each `name` 1–64 characters (`MAX_NAME_LENGTH`). The `name` is the day display name — see the roster payload's field table for full semantics. The set lines refer to it **by id string**, not by bit position the way a roster's `games[].sets` masks do — but the directory itself is objects either way. No `jersey`: a stats sheet has no use for one, so the field is dropped on the way in. A Client-added player (id in the `cx-` namespace) arrives with a name and becomes a guest on import. |
| `games` | array | 1–8 entries (`MAX_GAMES_PER_DAY`), at least one. |
| `games[].gameId` | `string` | Non-empty, unique within the payload. Matched against a saved game's id on import. |
| `games[].sets` | array | 1–5 entries (`MAX_SETS`) **per game**, `n` ascending and unique **within that game**. A set the team did not play is simply omitted, not sent with empty stats. |
| `games[].sets[].n` | `number`, 1–5 (`MAX_SETS`) | The set number. Sets are per game: **every game starts again at set 1**, so a day of three games legitimately carries three set-1 lines. |
| `games[].sets[].score` | `[number, number] \| null` | `[us, them]`, or `null` if not recorded. **The key is required**: send it as `null`, never omit it — an absent `score` is refused as `game "<gid>" set <n> has a malformed score`, which rejects the whole paste. Both entries must be finite. |
| `games[].sets[].players` | array | Stat lines for that set. Every `id` here must appear in the top-level `players`. A player with no line in a set is 0/0 there — not an error. |
| `…players[].serve` / `.return` | `{ in: number; out: number }` | Both integers, `0`–`999` (`MAX_COUNT`). **Totals are never transmitted** — both apps derive `in + out`. |
| `games[].sets[].servedFirst` | `boolean` | **Optional, v4.** Present together with `points` or not at all. `true` when the Client's team served the set's first rally. |
| `games[].sets[].points` | `string` | **Optional, v4.** Present together with `servedFirst` or not at all. Matches `/^[UT]{1,200}$/` (`MAX_POINTS`): one character per rally in order, `U` when the Client's team won it, `T` when the opponent did. |
| `games[].sets[].servers` | `(string \| null)[]` | **Optional, v5, only with `points`.** One entry per serve turn of ours (`serveTurnCount`): the id of who served it, or `null`. Each id has a stat line in that set. |

**Point log (v4).** A set may carry `servedFirst: boolean` and `points: string`, both or neither. `points` is one character per rally in order, `U` when the Client's team won it, `T` when the opponent did; 1 to `MAX_POINTS` characters. When present, `score` is required and must equal the tally of `points` (`U`s, then `T`s). The Planner replays the string against the planned lineup; the Client never sends a lineup. A v2 or v3 body has no log and imports exactly as before.

**Who served (v5).** A logged set may also carry `servers`: one entry per serve turn of the Client's team in `points`, in order, where a serve turn is a run of rallies the team served (the winner of each rally serves the next; `serveTurnCount` in the reference codec). Each entry is the id of who served that turn, or `null` where the phone does not know. Every named id has a stat line in that set. A set with no log never carries `servers`; a v4 body has none and imports exactly as before.

A logged set's keys go in the order `n`, `score`, `players`, `servedFirst`, `points`, then `servers` when present. Key order is not part of the contract (see "Golden vectors"), but the frozen vector below is emitted in that order. A set with no log omits both fields entirely; an empty log is never sent as `''` (it is refused — see the v4 additions to the error catalogue).

## Roster payload schema (contract v1)

Legacy. No longer produced, still decoded: a coach reaching for last week's roster email is a
realistic path, and `normaliseRosterV1` lifts what she pastes into the day shape — a one-game day
whose directory is that game's players, so every index `0..n-1` is on its tick-list.

| Field | Type | Rule |
|---|---|---|
| `v` | `1` | Must equal the version named in the prefix. |
| `kind` | `"roster"` | Fixed. |
| `gameId` | `string` | Non-empty. Echoed back in the stats payload to match the game. |
| `team` | `string` | Display-only; the import never reads it back. |
| `opponent` | `string` | Display-only. |
| `date` | `string` | Display-only, and **non-empty** — see "Non-empty `date` and `recordedAt`" under Versioning policy. |
| `players` | array | 1–16 entries (`MAX_ROSTER_PLAYERS`), unique ids (the Planner's own encoder no longer enforces the 1–16 bound — see the exception under Limits below). Alphabetical by name is a **send-side convention, not a rule**: `rosterPayload.ts` sorts that way (tied on id) but `validateRosterPayload` has no ordering check, so a payload in any order is legal and must be accepted. |
| `players[].id` | `string` | Matches `ID_PATTERN` (see below). |
| `players[].name` | `string` | Required, 1–64 characters (`MAX_NAME_LENGTH`). |
| `players[].jersey` | `number` | Optional — this app's roster panel does not collect jerseys today, so it is usually absent. |

## Stats payload schema (contract v1)

Legacy, and **still accepted**: stats flow Client → planner, so an un-updated Client keeps working
for single-game days. `normaliseStatsV1` lifts an accepted v1 sheet into the day shape — a one-game
day — so exactly one shape reaches saved state and nothing downstream branches on `v`.

| Field | Type | Rule |
|---|---|---|
| `v` | `1` | Must equal the version named in the prefix. |
| `kind` | `"stats"` | Fixed. |
| `gameId` | `string` | Non-empty. Matched against a saved game's id on import. |
| `recordedAt` | `string` | ISO timestamp, from the Client's clock. **Non-empty**, and at most 32 characters (`MAX_RECORDED_AT_LENGTH`). |
| `players` | array | The roster the Client actually used: 1–16 entries (`MAX_ROSTER_PLAYERS`), unique ids, each name 1–64 characters (`MAX_NAME_LENGTH`). **At least one** — see "`it names no players` for stats" under Versioning policy. A Client-added player (id in the `cx-` namespace) arrives with a name and becomes a guest on import. |
| `sets` | array | 1–5 entries (`MAX_SETS`), `n` ascending and unique. A set the team did not play is simply omitted, not sent with empty stats. |
| `sets[].n` | `number`, 1–5 (`MAX_SETS`) | The set number. |
| `sets[].score` | `[number, number] \| null` | `[us, them]`, or `null` if not recorded. **The key is required**: send it as `null`, never omit it — an absent `score` is refused as `set <n> has a malformed score`, which rejects the whole paste. Both entries must be finite — see "Finite set scores" under Versioning policy. |
| `sets[].players` | array | Stat lines for that set. Every `id` here must appear in the top-level `players`. A player with no line in a set is 0/0 there — not an error. |
| `sets[].players[].serve` / `.return` | `{ in: number; out: number }` | Both integers, `0`–`999` (`MAX_COUNT`). **Totals are never transmitted** — both apps derive `in + out`. |

## Id rules

- **Player id** (`ID_PATTERN`): `/^[A-Za-z0-9_-]{1,64}$/` — opaque, 1–64 characters, no spaces.
  This app's own ids (`generateId` in `src/store/useAppStore.ts`) already match this shape.
- **Client-created id** (`CLIENT_ID_PATTERN`): `/^cx-[A-Za-z0-9_-]{4,32}$/`. The Client must use
  this namespace for any player it adds itself (e.g. a sub the coach never entered here), so it
  can never collide with an id this app generates. This app treats an unrecognised id **in the
  `cx-` namespace** as a new guest of that game; an unrecognised id outside it is refused —
  `The stats payload names "<id>", a player this app does not know and the stats app did not
  create.` — and blocks the row it appears in. So a walk-up must be minted as `cx-…`: any other
  shape of made-up id blocks every game that names her. Only the ids a game's **own set lines**
  name are checked, filtered out of the day directory rather than read from it wholesale, so an
  unrecognised id sitting in `players` that no set line references blocks nothing.

## Payload size

Size is a contract concern, not an implementation detail, because the two payloads travel by
different routes with different ceilings — and one of those ceilings is what decided the shape of
`games[].sets`.

The **roster** travels as a `mailto:` URL body, which several mail clients cut off somewhere near
2000 characters — `openMailto.ts` puts the practical figure at about 2048, and the measurements
below are marked against that. This app's ids are **24–25 characters** — `generateId` (`src/store/useAppStore.ts`)
builds them as `` `${prefix}-${Date.now().toString(36)}-${counter}-${6 random}` `` and the prefix is
the full word `player`, so a real one is `player-mu2strf8-7-a8c3d9`; the counter is session-global,
so it takes a second digit past the ninth id. Game ids are 22–23 the same way. That is why
`games[].sets` never carries ids or names, only numbers: id strings break the `mailto:` ceiling by
the second game of an ordinary tournament day, well before per-set membership was ever on the table.

Contract 2 carried this as `games[].roster`, one array of directory indices per game — the union of
everyone who played anywhere in it, with the per-set breakdown thrown away before encoding. Contract
3 carries the same information *and* per-set membership, as one bitmask per set. The three encodings
compose, for a 12-player squad with all twelve in all three sets, a 20-character address and a
realistic subject, to:

| games | v2 `roster` union | per-set index arrays | per-set **masks** (v3) |
|---|---|---|---|
| 1 | 1262 | 1336 | **1244** |
| 2 | 1390 | 1539 | **1355** |
| 3 | 1516 | 1740 | **1464** |
| 4 | 1640 | 1939 ⚠ | **1571** |
| 5 | 1768 | 2142 ❌ | **1682** |
| 6 | 1894 | 2342 ❌ | **1790** |
| 7 | 2022 ⚠ | 2544 ❌ | **1900** |
| 8 (the cap) | 2150 ❌ | 2747 ❌ | **2011 ⚠** |

(⚠ crosses `MAILTO_WARN_LENGTH`, 1900; ❌ crosses the practical ~2048 ceiling.)

That table is the 12-player measurement and stays as it was taken. Since `MAX_ROSTER_PLAYERS` rose
to 16, the same encoding was measured again for a full 16-player squad (all sixteen in all three
sets), against a 12-player squad measured the same day with the same fixture, so the two rows can
be compared with each other. The fixture is the one `StatsToolbar.interaction.test.tsx` builds
(`seedTournamentDay`): player ids of 24 characters, game ids of 22, the eight opponent names that
test uses, a team called `Thunder 14U Gold`, an 18-character address and a subject of the form
`Roster · <team> · <date>`. It is not the fixture of the table above, whose exact opponent names
and subject were not recorded; the two 12-player series therefore differ by up to 80 characters
(1164 against 1244 at one game, 2021 against 2011 at eight). Compare a 16-player figure with the
12-player row beside it, not with the table above.

**16-player squad, measured 2026-10-03:**

| games | 12-player squad (same fixture) | 16-player squad |
|---|---|---|
| 1 | 1164 | **1430** |
| 2 | 1292 | **1562** |
| 3 | 1410 | **1685** |
| 4 | 1530 | **1809** |
| 5 | 1656 | **1938 ⚠** |
| 6 | 1776 | **2062 ❌** |
| 7 | 1896 | **2186 ❌** |
| 8 (the cap) | 2021 ⚠ | **2316 ❌** |

A full 16-player squad reaches the 1,900-character warning at 5 games, and the practical ~2048
ceiling at 6, so a full-squad Saturday of five or more games now warns where a 12-player one does
not until the eighth.

**The mask encoding is smaller than the v2 union at every game count, while carrying strictly more
information** — which one girl played which set, not just which game. That is why per-set
membership cost no cap changes: naively encoding a per-set breakdown as one index array per set
(the middle column) is already over the warning length at four games and over the ceiling at five,
but masks, for a 12-player squad, stay under the ceiling through the full eight-game cap and only
cross the warning line at that cap (a 16-player squad crosses the warning line at five games and the
ceiling at six, per the 16-player table above). One integer per set, not one array, is what makes per-set membership affordable in a
`mailto:` body at all.

The absolute worst case the schema permitted when it was measured — 8 games against the then-full
24-player directory — was 3206 with three sets per game and 3398 with five, against 3600 for the v2
union that carried no set data at all. The directory limit is 32 now, so the worst case is larger
than those figures; it was not re-measured, because it was already well past any `mailto:` limit.
All three are already well past what any `mailto:` client honours; `MAX_GAMES_PER_DAY` and
`MAX_DAY_PLAYERS` were never sized to make the worst case fit, only the realistic one.

The `mailto:` overhead on top of the payload is **flat with respect to the body**, so it shifts
every row of that table by the same amount rather than scaling with it: `mailto:` + `?subject=` +
`&body=` is 22 characters, plus the escaped address and the escaped subject, and correspondingly
more or less for a longer or shorter one. The payload itself contributes nothing: Base64URL's
alphabet plus the two dots the codec adds is entirely unreserved to `encodeURIComponent`, so the
body does not expand under escaping at all. That flatness is load-bearing rather than incidental —
it is what lets `composeMailto` (`src/components/openMailto.ts`) be measured directly as an exact
length rather than estimated with padding for escaping that never happens.

`MAILTO_WARN_LENGTH` is **1900**, and it is measured against the composed href, not against the
payload: above it the Stats workspace warns that the receiving mail client may cut the email off
before it is ever sent. With masks and a full **12-player** squad it fires only at the **eight-game cap** (2011), so the
warning line no longer falls inside an ordinary tournament day the way it did under per-set index
arrays, which would already have warned at four games (1939) and broken the practical ceiling at
five (2142). A full **16-player** squad reaches the warning sooner, at five games (1938), and passes
the ~2048 ceiling at six (2062) — see the 16-player table above. For a 12-player squad even the
eight-game cap sits under the ~2048 ceiling, though narrowly (2011 vs. ~2048)
— a longer address or opponent name could still close that gap, which is exactly what the warning
exists to catch before the mail client does.

**Contract 6's serve orders, measured 2026-10-08.** One character per rotation turn, base 32,
costs about 9 JSON characters a set (`"3a0712",`) on top of a per-game `"serve":[…]` key. On
`rosterPayload.test.ts`'s realistic day (twelve players with 24-character ids, all twelve in all
three sets, four games, a 17-character address and the subject `Roster · Thunder 14U Gold · Fri,
Sep 11`):

| the day's lineups | composed href |
|---|---|
| contract 5 (no `serve`) | 1529 |
| contract 6, no lineups (every entry `null`) | **1663** |
| contract 6, every lineup filled (every entry six characters) | **1727** |

A full lineup costs about 200 characters a 4-game day over contract 5 and still sits well under
`MAILTO_WARN_LENGTH`. Id strings in place of the base-32 characters would cost several hundred a
set, which is why `DayRosterGame.serve`'s docblock carries the same "do not simplify into arrays"
warning as `games[].sets`.

The tables above predate `serve`: they were measured at contract 3, so the "through the full
eight-game cap" figures hold for a roster without serve orders. With `serve` (about 34 characters a
game with no lineups, more with lineups) an eight-game roster no longer fits under ~2048. The
Planner sends at most three games an email.

**Stats must never go by `mailto:`.** A 3-game, 3-set, 12-player day sheet encodes to roughly
**13 KB**, about six times anything a `mailto:` URL can be relied on to carry. The stats payload
travels by clipboard into a textarea, which has no length limit, and that is also why it keeps id
strings where the roster uses bitmasks: a wrong bit in a roster mask is invisible to the receiving
app (it just changes who is pre-ticked), but a wrong id in a stats payload is not — it would
silently attribute one player's serves to another and every validator on both sides would pass it,
whereas an unrecognised id is caught by the unknown-id refusal in `src/store/importStats.ts`.

A v4 point log changes none of that: stats still travel by clipboard, never `mailto:`, so size is
not a ceiling for them. `MAX_POINTS` (200) is a sanity cap on one string, not a fit to any medium —
a log of 46 rallies is 46 characters before Base64URL, about 62 after.

## Limits

| Constant | Value | Meaning |
|---|---|---|
| `CONTRACT_VERSION` | `6` | The contract's major version. The roster is sent at 6 and stats at 5 (see "The encoded form"). |
| `MAX_GAMES_PER_DAY` | `8` | The most games one day payload may carry, in either kind. A tournament day is a handful of games; eight is generously above any real one, and bounds how much a single paste can push into saved state. It sits near what a `mailto:` roster can carry for a 12-player squad without serve orders (a 16-player squad reaches that limit sooner, and `serve` lowers it further) — see "Payload size" above. |
| `MAX_DAY_PLAYERS` | `32` | The most players one day payload's directory may name. A day's directory spans every game of the day, so it is legitimately larger than any one game's tick-list — squads rotate across games and a tournament day can field two teams' worth of names: two squads of sixteen. Must never exceed 53, and at 32 it already depends on the arithmetic mask helpers — see `DayRosterGame.sets`: at 32 the highest bit is `2 ** 31`, exactly the bit JS's `\|`/`&` coerce to a negative number, so a reader who reached for a bitwise operator on a mask would silently get wrong girls on a tick-list instead of an error. Use only the arithmetic helpers (see "Reading a set mask"); the largest legal mask is `2 ** 32 - 1` = `4294967295`. |
| `MAX_ROSTER_PLAYERS` | `16` | The largest **union** across a game's sets (`games[].sets`) may name — the size of the tick-list the Client shows for the game as a whole, not any single set and not the sum of all of them. In v2, when a game carried one `roster` array, that array *was* this union, so the rule is unchanged, only its expression moved. In v1, when a payload *was* one game, it bounded the whole payload's `players` instead, and it still does on the v1 path. |
| `MAX_COUNT` | `999` | Largest legal serve/return count. |
| `MAX_NAME_LENGTH` | `64` | Longest legal `players[].name`, in **both** payloads. An empty name is malformed too. |
| `MAX_RECORDED_AT_LENGTH` | `32` | Longest legal `recordedAt`. An ISO timestamp with milliseconds and a timezone offset is under 32 characters. |
| `MAX_SETS` | `5` | Largest legal `sets` length in either payload (a roster's `games[].sets`, a stats sheet's `games[].sets`), and largest legal `sets[].n` on the stats side — **per game** at v2/v3, per payload at v1. The stats-side widening from 3 to 5 was receive-side only — see "Set count" under Versioning policy below. |
| `MAX_POINTS` | `200` | The most rallies one set's point log may record. A 25-point set that goes to deuce is under 60. A refusal, like every cap here. |
| `SERVE_ORDER_PATTERN` | `/^[0-9a-v-]{6,16}$/` | A legal `games[].serve[k]` string (contract 6). 6 for a slot set; one per spot in a Train line, never fewer than 6 and at most 16 (`MAX_ROSTER_PLAYERS`). Base 32 reaches index 31, which covers `MAX_DAY_PLAYERS`. |

On the v1 path `MAX_ROSTER_PLAYERS` bounds the stats payload's top-level `players` as well: that
list echoes the roster the Client was handed. `validateRosterPayload` refuses a v1 roster payload
longer than 16 outright, so the Client can never successfully import one — see the Planner-side
exception below for the one case that produces a roster payload longer than 16 in the first place.
Every cap on this page is a refusal, not a truncation — nothing over-long is allowed to reach saved
state.

> **Planner-side exception (2026-09-14, escalated 2026-09-15).** The Rotation Planner's roster email
> encodes every player each game names, without enforcing `MAX_ROSTER_PLAYERS` — the coach asked for
> the whole game in the email, because that is what she asked for. The validators are unchanged and
> still refuse a game naming more than sixteen, so a seventeen-player game produces an email the stats
> app will refuse on import.
>
> **The blast radius grew with the day payload.** Under v1 an over-cap game spoiled its own email and
> nothing else: one game, one payload. Under v2 a day is one payload, and
> `validateDayRosterPayload` refuses **the whole thing** — so a single seventeen-player game takes the
> day's other games down with it, and the coach loses a Saturday's roster rather than a match's.
>
> The remedy is unchanged and still the only one. The payload cannot be hand-edited to fix it
> afterwards: the body is a single opaque Base64URL token with an FNV-1a checksum appended
> (`encodePayload`), so any edit — trimming one game back under 16, say — invalidates the checksum
> and the whole payload is refused, not just the edit. Fix the roster in the Rotation Planner and
> send again. Raising the limit here would not help on its own either: the stats app ships its own
> verbatim copy of `statsContract.ts` and would have to be rebuilt too.

## Error catalogue

Every string below is produced verbatim by `src/contract/statsContract.ts`; `<n>` marks a value
interpolated at the point of failure, `<id>` a player id and `<gid>` a game id.

**Transport (`decodePayload`):**

- `This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.`
- `This is a roster payload, not a stats payload.` (and the reverse)
- **Newer version, two variants** — the first `<n>` is the version read off the payload's prefix;
  the second is the reader's own `CONTRACT_VERSION`, which is **6** today, so these render as
  `(contract 7); this app understands 6.`:
  - `This payload was made by a newer version of the Rotation Planner (contract <n>); this app understands 6.`
  - `This payload was made by a newer version of the stats app (contract <n>); this app understands 6.`
- **Corrupted, two variants** — each covers a truncated payload, a checksum mismatch, invalid
  Base64URL, unparsable JSON, and a body whose own `v`/`kind` disagrees with the prefix:
  - `This payload is corrupted or incomplete — copy it again from the Rotation Planner.`
  - `This payload is corrupted or incomplete — copy it again from the stats app.`

### Why two of the transport messages have two variants

Both of those messages tell a coach **which app to go to** — to update, or to copy from again. But
the two apps run *one file*, copied verbatim, and the right answer differs by side: a roster payload
is authored by the Rotation Planner, a stats payload by the stats app. A single literal naming "the
stats app" is therefore correct on this side and wrong on the Client's — it sends a coach whose
roster email arrived mangled back to the app that did not write it, which is worse than saying
nothing at all.

So the author's name is a lookup on the payload **kind** (`AUTHOR_LABEL`: `roster` → `the Rotation
Planner`, `stats` → `the stats app`), keyed on the kind the caller said it expected. `expected`
rather than the decoded kind, because on a payload this corrupt the prefix may be the only thing
worth trusting, and the caller has already told the decoder which app it believes it is reading.
One file, the right words on both sides.

The other two transport messages keep a single form each. `This is a roster payload, not a stats
payload.` already names both kinds by construction. And `This is not a CoachIQ payload` is the one
message emitted *before* the kind is known at all — there is no `CIQ[RS]` head to read, so there is
nothing to key an author label off; it names the stats app for both kinds, and that is the shipped
wording.

### Contract v1 (`validateRosterPayload` / `validateStatsPayload`)

Retained verbatim: the v1 validators still exist on the normalisation path and still emit these
exact strings. All of the form
`The roster payload is malformed: <detail>.` or `The stats payload is malformed: <detail>.`,
where `<detail>` is one of:

Roster:
- `it is not an object`
- `its version is not 1`
- `its kind is not "roster"`
- `it has no game id`
- `it has no team name`
- `it has no opponent name`
- `it has no date`
- `it has no player list`
- `it names no players`
- `it names <n> players; the limit is 16`
- `one of its players is malformed`
- `player id "<id>" is not legal`
- `player id "<id>" appears twice`
- `player "<id>" has no name`
- `player "<id>" has an empty name`
- `player "<id>" has a <n>-character name; the limit is 64`
- `player "<id>" has a non-number jersey`

Stats:
- `it is not an object`
- `its version is not 1`
- `its kind is not "stats"`
- `it has no game id`
- `it has no recorded time`
- `its recorded time is <n> characters; the limit is 32`
- `it has no player list`
- `it names no players` — **added 2026-09-15**; see the dated entry under Versioning policy for why
  this string was in the roster catalogue and not this one
- `it names <n> players; the limit is 16`
- `one of its players is malformed`
- `player id "<id>" is not legal`
- `player id "<id>" appears twice`
- `player "<id>" has no name`
- `player "<id>" has an empty name`
- `player "<id>" has a <n>-character name; the limit is 64`
- `it has no set list`
- `it records no sets`
- `it records more than 5 sets`
- `one of its sets is malformed`
- `set number "<n>" is not between 1 and 5`
- `set <n> appears twice or out of order`
- `set <n> has a malformed score`
- `set <n> has no player list`
- `set <n> has a malformed player line`
- `set <n> names an illegal player id "<id>"`
- `player "<id>" has stats but is not in the player list`
- `player "<id>" appears twice in set <n>`
- `player "<id>" has a malformed serve count in set <n>`
- `player "<id>" has a malformed return count in set <n>`

### Contract v6 roster and v5 stats (`validateDayRosterPayload` / `validateDayStatsPayload`)

Same two forms — `The roster payload is malformed: <detail>.` and
`The stats payload is malformed: <detail>.` — where `<detail>` is one of. The roster validator
accepts `v: 6`; a legacy `v: 3` body runs the same checks (`validateDayRosterPayloadV3`) before
it is lifted, and only a v6 body reaches the five serve-order messages under "Contract v6 roster
additions". The stats validator accepts `v: 2`, `v: 3`, `v: 4` or `v: 5` — see "Stats payload
schema (contract v2, v3, v4 or v5)" above. The stats list below is the whole of it apart from the
seven point-log messages under "Contract v4 stats additions" and the four server-list messages
under "Contract v5 stats additions".

Roster:
- `it is not an object`
- `its version is not 1, 2, 3, 4, 5 or 6`
- `its kind is not "roster"`
- `it has no date`
- `it has no team name`
- `it has no player list`
- `it names no players`
- `it names <n> players; the day limit is 32`
- `one of its players is malformed`
- `player id "<id>" is not legal`
- `player id "<id>" appears twice`
- `player "<id>" has no name`
- `player "<id>" has an empty name`
- `player "<id>" has a <n>-character name; the limit is 64`
- `player "<id>" has a non-number jersey`
- `it has no game list`
- `it names no games`
- `it names <n> games; the limit is 8`
- `one of its games is malformed`
- `one of its games has no id`
- `game id "<gid>" appears twice`
- `game "<gid>" has no opponent name`
- `game "<gid>" has no set list`
- `game "<gid>" records no sets`
- `game "<gid>" records more than 5 sets`
- `game "<gid>" set <n> is not a legal roster mask`
- `game "<gid>" set <n> names a player outside the directory`
- `game "<gid>" names <n> players; the limit is 16`

Stats:
- `it is not an object`
- `its version is not 1, 2, 3, 4, 5 or 6`
- `its kind is not "stats"`
- `it has no recorded time`
- `its recorded time is <n> characters; the limit is 32`
- `it has no player list`
- `it names no players`
- `it names <n> players; the day limit is 32`
- `one of its players is malformed`
- `player id "<id>" is not legal`
- `player id "<id>" appears twice`
- `player "<id>" has no name`
- `player "<id>" has an empty name`
- `player "<id>" has a <n>-character name; the limit is 64`
- `it has no game list`
- `it records no games`
- `it records more than 8 games`
- `one of its games is malformed`
- `one of its games has no id`
- `game id "<gid>" appears twice`
- `game "<gid>" has no set list`
- `game "<gid>" records no sets`
- `game "<gid>" records more than 5 sets`
- `game "<gid>" has a malformed set`
- `game "<gid>" has a set numbered "<n>"; it must be between 1 and 5`
- `game "<gid>" repeats set <n> or has it out of order`
- `game "<gid>" set <n> has a malformed score`
- `game "<gid>" set <n> has no player list`
- `game "<gid>" set <n> has a malformed player line`
- `game "<gid>" set <n> names an illegal player id "<id>"`
- `player "<id>" has stats in game "<gid>" but is not in the player list`
- `player "<id>" appears twice in game "<gid>" set <n>`
- `player "<id>" has a malformed serve count in game "<gid>" set <n>`
- `player "<id>" has a malformed return count in game "<gid>" set <n>`

Four wording facts worth stating rather than leaving to be discovered by diff, since a Client
reproducing these by hand will be tempted to regularise all four:

- The **day directory** over-cap says `the day limit is 32`; a **game's** over-cap says
  `the limit is 16`. Different phrase, different limit, on purpose.
- A roster `names <n> games; the limit is 8`, while a stats sheet `records more than 8 games`. A
  roster names games it plans; a sheet records games that happened.
- `its version is not 1, 2, 3, 4, 5 or 6` names **all six** versions this app reads rather than only the
  one that refused, because a coach who pasted the wrong thing needs to know what is acceptable, not
  which branch said no. The v1 validators still say `its version is not 1`; they are only reachable
  through the day decoders, which have already dispatched on the body's `v`.
- A set entry that is not a whole number ≥ 0 (or is too large to represent exactly) is `set <n> is
  not a legal roster mask` — it isn't a mask at all, the same distinction v2's index check drew for
  a value that wasn't an index. A value that *is* a legal integer but sets a bit beyond the
  directory's length is `set <n> names a player outside the directory` instead: `5` over a 2-player
  directory is syntactically a fine mask, just not one this payload's `players` can support.

### Contract v4 stats additions

Same form, `The stats payload is malformed: <detail>.`, and the checks run in the order below, inside
the per-set loop, after the score is parsed and before the set's player list is read. A set with no
`points` and no `servedFirst` skips all seven. `<gid>` is a game id, `<n>` the set number or the cap.

- `game "<gid>" set <n> has a malformed point log` — `points` is present and not a string, or
  `servedFirst` is present and not a boolean.
- `game "<gid>" set <n> has half a point log` — one of the two fields is present without the other.
- `game "<gid>" set <n> has an empty point log; leave it out instead` — `points` is `''`.
- `game "<gid>" set <n> records more than 200 rallies` — `points` is longer than `MAX_POINTS`.
- `game "<gid>" set <n> has a point log with a character other than U or T`
- `game "<gid>" set <n> has a point log but no score` — `score` is `null`.
- `game "<gid>" set <n> has a score that disagrees with its point log` — `score` is not exactly
  `[count of U, count of T]`.

### Contract v5 stats additions

Same form, `The stats payload is malformed: <detail>.`, and the checks run in the order below, inside
the per-set loop, after the set's player list is read. A set with no `servers` skips all four.

- `game "<gid>" set <n> names servers but has no point log` — `servers` is present on a set with no
  `points`/`servedFirst`.
- `game "<gid>" set <n> has a malformed server list` — `servers` is not an array.
- `game "<gid>" set <n> names <k> servers for <t> serve turns` — the list's length is not
  `serveTurnCount(points, servedFirst)`.
- `game "<gid>" set <n> names server "<id>", who has no stat line in that set` — an entry that is
  not `null` is not a legal id, or has no line in that set's `players`.

### Contract v6 roster additions

Same form, `The roster payload is malformed: <detail>.`. These run after **every** other roster
check, over the whole day, so a game over its cap is reported as `game "<gid>" names <n> players;
the limit is 16` rather than as a 17-character serve order. Within a game they run in the order
below, set by set. `<gid>` is the game id, `<n>` the set number, `<i>` a decoded index and `<N>` the
directory's length.

- `game "<gid>" has no serve list with one entry per set` — `serve` is missing, not an array, or
  a different length from `sets`.
- `game "<gid>" set <n> has a serve order that is not legal` — the entry is neither `null` nor a
  string matching `/^[0-9a-v-]{6,16}$/`: the wrong type, a character outside `0`–`9`, `a`–`v`
  and `-` (uppercase included), or fewer than 6 or more than 16 characters.
- `game "<gid>" set <n> serve order names player <i>, but the payload lists only <N>` — a
  character's index is not in the directory. This follows the v2 wording.
- `game "<gid>" set <n> serve order names a player who is not in that set` — the index's bit is
  not set in that set's mask.
- `game "<gid>" set <n> serve order names nobody` — every character is `-`. The sender sends
  `null` instead.

The validator cannot tell a slot set from a Train set, so it does not check that a slot set's
order is exactly 6 long. The Planner only ever sends 6 for a slot set.

### Contract v2 roster (legacy)

Still reachable, and worth its own entry rather than a footnote: `decodeDayRoster` sends a body
whose `v` is `2` through `validateDayRosterPayloadV2` (not exported — internal to
`statsContract.ts`) before `normaliseRosterV2` lifts the result into the v3 day shape. A coach who
opens an old `CIQR2.` roster email in an already-updated Client still runs it through this
validator, so a malformed one still produces these strings, not the ones listed under "Contract v6 roster and v5 stats" above.

Its `it is not an object` / `its version is not 1, 2, 3, 4, 5 or 6` / `its kind is not "roster"` / `it has no
date` / `it has no team name` / player-list / `it has no game list` / `it names no games` / `it
names <n> games; the limit is 8` / `one of its games is malformed` / `one of its games has no id` /
`game id "<gid>" appears twice` / `game "<gid>" has no opponent name` checks are worded identically
to the "Contract v6 roster and v5 stats" catalogue above — same helpers, same strings. Only the per-game roster check differs,
since this validator reads an index array rather than a set-mask array:

- `game "<gid>" has no roster`
- `game "<gid>" has a malformed player reference`
- `game "<gid>" names player <n>, but the payload lists only <n>`
- `game "<gid>" names player <n> twice`

`game "<gid>" names <n> players; the limit is 16` is **not** repeated here: v2 and v3 share that
exact string (both check the same `MAX_ROSTER_PLAYERS` cap on the same kind of count), so it already
appears once, in the "Contract v6 roster and v5 stats" Roster list above.

## Versioning policy

- `CONTRACT_VERSION` is the contract's **major** version. Adding an optional field is **not** a
  version bump — an older decoder that has never heard of the field simply ignores it (the shape
  validators only look for fields they know about and rebuild the value field by field). Exception,
  recorded under contract 4: an optional field whose silent loss would discard data the sender may
  already have cleared earns a bump. Renaming or removing a field **is** a breaking change: bump
  `CONTRACT_VERSION` and ship both apps together.
- A decoder refuses a payload whose prefix version is higher than its own `CONTRACT_VERSION`,
  before attempting to decode the body — "made by a newer version of the stats app" rather than a
  confusing parse failure.
- `SCHEMA_VERSION` (in `src/store/persistence.ts`) and `CONTRACT_VERSION` (here) are **separate
  numbers with separate lifetimes**. `SCHEMA_VERSION` versions the file this app saves to its own
  `localStorage`; `CONTRACT_VERSION` versions the payload the two apps exchange by copy/paste.
  Bumping one never implies bumping the other.

### Planned serve order (contract 6) — 2026-10-08

`CONTRACT_VERSION` goes to **6**. Each roster game gains `serve`: one compact string per set naming
the planned server of each of the team's rotation turns, or `null`
(docs/superpowers/specs/2026-10-08-roster-serve-order-design.md). The Planner resolves rotations,
pairs, coverage, serve overrides, availability and Train lines (`plannedServeOrder`), so the phone
does no rotation work. It bumps for the reason v4 and v5 did: a v5 Client would validate a v6 roster
field by field and drop every order without a word. "Made by a newer version of the Rotation
Planner (contract 6); this app understands 5" is the better failure.

The roster is now sent as `CIQR6.` (`encodeDayRoster` pinned to 6). **Stats are unchanged and
`encodeDayStats` is pinned to 5**, so a phone at 4.6.0 still exports `CIQS5.`, which a Planner that
predates contract 6 still reads. The Planner's stats validator still accepts body `v` 2–5; a stats
body at 6 is "not a known version". Legacy rosters still decode: v3 lifts to v6 with `serve` all
`null` (`normaliseRosterV3`), and v2 and v1 lift through v3. `docs/stats-contract-v6-client-guide.md`
is the brief.

### Several roster emails a day (2026-10-04)

No contract change and no version bump. The Planner's Email Roster card lets the coach tick which
of a day's games one email carries, at most three, so a busy day goes out as two or three roster
payloads with the same `date`. Each is a well-formed v3 roster on its own, naming only its games
and the players they name. The Client already merges a same-date roster into the day it holds:
games it already has keep their sets and stats, new games are added, and nothing is deleted
(`openDayRoster`/`mergeDayRoster` in the Client's `session.js`). The merged day is still held to
`MAX_GAMES_PER_DAY` and `MAX_DAY_PLAYERS`. A stats payload covers every game the Client holds for
the day, and the Planner imports it game by game on `gameId`, so nothing on the way back changes.

### Larger limits: 16 a game, 32 a day (2026-10-03)

`MAX_ROSTER_PLAYERS` rose from 12 to 16 and `MAX_DAY_PLAYERS` from 24 to 32. No field changed,
so `CONTRACT_VERSION` stays 4 and the prefixes stay `CIQR3.`/`CIQS4.`: a limit is a refusal on
receive, never carried on the wire. The cost is a mixed pair. A stats app still at 12 refuses a
13–16 player game from this planner with its existing "names N players; the limit is 12", so
both apps ship together. At 32 the highest mask bit is `2 ** 31`, which is why every mask reader
must use the arithmetic helpers.

### Who served (contract 5) — 2026-10-08

Version 5 adds an optional `servers` list to each logged stats set: who the phone says served
each of our serve turns, or `null` where it does not know (docs/superpowers/specs/2026-10-08-as-played-design.md).
It bumps for the reason v4 did: a v4 planner would validate a v5 day field by field and drop
every server without a word. The roster half is unchanged and stays pinned to 3.

### Point logs (contract 4) — 2026-10-01

`CONTRACT_VERSION` goes to **4**. Each stats set may carry `servedFirst` and `points` (see "Stats payload schema"). Optional fields do not normally bump, but a v3 planner handed a logged day would validate it field by field and drop every log without a word; the coach would find out after "New day" on the phone. "Made by a newer version of the stats app (contract 4); this app understands 3" is the better failure, so this bumps on purpose. The roster half is unchanged and `encodeDayRoster` is now pinned to **3**, so an un-updated Client keeps reading `CIQR3.`. The planner accepts stats bodies at `v` 2, 3 or 4. The Client encodes stats at 4. `docs/stats-contract-v4-client-guide.md` is the brief.

The pin is not decoration. `decodePayload` treats a body `v` that differs from the prefix as corruption, and the roster body still says `"v":3`, so a `CIQR4.` prefix around it would refuse itself. The Client's own `encodeDayStats` carried a matching pin to 2; re-copying the Planner's file removes it (the Planner's copy never had one).

### Per-set rosters (contract 3) — 2026-09-15

`CONTRACT_VERSION` goes to **3**. `DayRosterGame.roster` — one index array per game — is replaced
by `DayRosterGame.sets`, one bitmask per set. The payload now carries **how many sets a game has**
and **who is in each one**, neither of which v2 could express: `rosterCandidates` unioned the set
rosters and the set structure was discarded before encoding.

This is a **breaking change to the roster half** and was taken deliberately over the additive
alternative. Ship both apps together: a deployed Client refuses `CIQR3.` with "made by a newer
version" until it ships a matching change. `docs/stats-contract-v3-client-guide.md` is the brief.

**The stats half is unchanged apart from its version digit**, and the planner accepts `v` of 2 or 3
on that path. That is deliberate and not an oversight: stats flow Client → planner, so an
un-updated Client can still send a whole day of stats back even while it cannot read a v3 roster.

Legacy rosters still decode. A v1 or v2 payload carries no set structure, so it normalises to **one
set** holding the game's whole roster rather than an invented three — see `normaliseRosterV2`.

### Day payloads (contract 2) — 2026-09-15

`CONTRACT_VERSION` goes to **2**. The unit of exchange moves from one game to a whole tournament
day, because the team plays several games in a day and the coach wants to send one roster in the
morning and paste back one stats sheet at the end — not hand the Client a fresh roster between
matches, in a gym, on a phone.

**What moved or was renamed.** In both payloads, `gameId` leaves the top level and becomes
`games[].gameId`. On the roster, `opponent` leaves the top level and becomes `games[].opponent`,
while `date` and `team` stay at the top and now describe the day. On the stats sheet, `sets` leaves
the top level and becomes `games[].sets`, scoped and numbered **per game** — every game starts again
at set 1. `players` survives in both, but its meaning widens: it is now the **day's directory**,
bounded by the new `MAX_DAY_PLAYERS` rather than by `MAX_ROSTER_PLAYERS`. Two new limits appear,
`MAX_GAMES_PER_DAY` and `MAX_DAY_PLAYERS`; `MAX_ROSTER_PLAYERS` keeps its value and changes scope,
now bounding one game's pre-selection inside a day payload rather than the whole payload.

That is a rename-and-restructure of existing fields, not an added optional one, so by the rule at
the top of this section it earns the bump: an older decoder handed a v2 body would not ignore
something it had never heard of, it would find no top-level `gameId` and be wrong about what it was
holding.

**Why the roster references the directory by index.** See "Payload size" above for the measurements.
In short: this app's ids are 24 characters, the roster travels as a `mailto:` body that mail clients
cut off near 2000, and re-listing twelve ids per game breaks that ceiling at **two** games — 2123
characters at two, 2661 at three. With indices it is 1321 and 1457, growing 132 per game, and the
eight-game cap lands at 2122, right at the medium's limit. There is no version of a day roster built
from id strings that survives an ordinary tournament Saturday.

**Why the stats sheet keeps id strings.** It travels by clipboard into a textarea with no length
limit — a 3-game, 3-set, 12-player day sheet is roughly 13 KB — so indices would buy nothing there.
And they would cost something real: an off-by-one index would silently attribute one player's serves
to another, with every validator on both sides passing it, because an in-range index is always a
legal index. A wrong id is caught instead, by the unknown-id refusal in `src/store/importStats.ts`.
Indices where the cost is real and the failure is loud; id strings where the cost is nil and the
failure would be silent.

**`SCHEMA_VERSION` did not move for this change.** It stood at 11 on the day, and this change left
it there; it has moved on since, for reasons of its own. That is the live demonstration of the **last bullet** of this
section's opening list — the one immediately before the dated entries begin — that `SCHEMA_VERSION`
and `CONTRACT_VERSION` are separate numbers with separate lifetimes. The day
payload changes what the two apps hand each other across a clipboard; it changes nothing about the
file this app writes to its own `localStorage`, because a v1 stats sheet is normalised into the day
shape before anything reaches saved state, so exactly one shape was ever persisted and it did not
move. The contract's major version went up and the persistence schema did not — which is the whole
point of keeping them apart.

**Compatibility.** This app emits **v2 rosters only** and accepts **v1 and v2 stats**, normalising a
v1 sheet into a one-game day. So the stats direction degrades gracefully: an un-updated Client keeps
working for single-game days. The roster direction does not, and cannot — a Client still on contract
1 refuses a `CIQR2` roster with `This payload was made by a newer version of the stats app (contract
2); this app understands 1.` Note the label: `AUTHOR_LABEL` arrived with this contract, so the
contract-1 build doing the refusing still says "the stats app" for both kinds and points the coach
at the wrong app. A Client on the v2 module says "the Rotation Planner" for a roster — but that
build does not refuse a `CIQR2` roster at all, so the mislabelling and the refusal end together.
That is the designed behaviour rather than a bug to work around, and the consequence is the rule
this section has always stated: **ship both apps together**.

### Set count (2026-09-14)

The planner now accepts a stats payload of up to **5 sets**, numbered 1–5, raised from 3. This is a
**receive-side widening only** and `CONTRACT_VERSION` stays at `1`.

Stats flow Client → planner, so a planner that accepts five sets cannot break a Client that only
ever sends three: every payload that was legal before is still legal, byte for byte, and the golden
vectors are unchanged.

**The Client has not been changed.** It still produces at most three sets, so a 4- or 5-set game
planned in the app has no way to receive stats for its later sets until the Client's own tick-list
and payload builder are widened to match. That is a separate change to the iPhone app; this entry
exists so the asymmetry is not mistaken for a finished rollout.

**Finished by contract 3 (2026-09-15).** The gap this entry describes was that the Client had no way
to *learn* a game had more than three sets, even once the planner could receive stats for them.
`DayRosterGame.sets`'s length is now the authoritative set count carried in the roster payload — see
"The four rules about `games[].sets`" above — so a v3-reading Client can build the right number of
set tabs instead of assuming three. That is what completes this rollout.

### Finite set scores (2026-09-14)

`parseScore` now requires both numbers of `sets[].score` to be **finite**
(`Number.isFinite`) — `NaN` and `±Infinity` are refused as a malformed score, where they used to
pass a bare `typeof … === 'number'` check. This is a **tightening**, not a widening, and
`CONTRACT_VERSION` stays at `1`: every payload a real Client has ever produced already carries
finite scores, so nothing legal before is refused now.

Why it matters enough to record: `JSON.parse` turns the numeral `1e999` into `Infinity`, so a
pasted payload — not just a hand-built object bypassing this module — could carry a non-finite
score. Such a score survived fine in memory and could be written straight into this app's own
saved state, but `JSON.stringify` serialises `Infinity`/`NaN` as `null`; the *next* load would then
see a score of `[null, 21]`, which this app's own file-shape check refuses, falling back to a fresh
seed over the coach's real save. Requiring finiteness on the way in closes that off. Both entries
are still not required to be integers — a fractional score like `[25.5, 21]` is meaningless for
volleyball but harmless, and this app's saved-file check doesn't require an integer either, so
requiring one only here would be a tightening this module has no way to enforce symmetrically.

### Bounded `recordedAt` (2026-09-14)

`validateStatsPayload` now caps `recordedAt` at 32 characters (`MAX_RECORDED_AT_LENGTH`), refusing
anything longer as malformed. This is a **tightening**, not a widening, and `CONTRACT_VERSION`
stays at `1`: `recordedAt` is an ISO timestamp from the Client's clock, and every real Client
timestamp is well under 32 characters, so nothing legal before is refused now.

Why it matters: `recordedAt` was the only contract string this app copies into saved state with no
length cap at all — every other one (`players[].name`, both payloads) is bounded by
`MAX_NAME_LENGTH`, for exactly this reason. A buggy or hostile Client smuggling a multi-megabyte
`recordedAt` through would balloon the saved file past its `localStorage` quota; `persist`
(`src/store/useAppStore.ts`) swallows that quota failure, so every save *after* the oversized one
would be silently lost — no `parsePersisted` refusal and no error the coach ever sees, unlike the
other tightenings on this page, which surface as a refused load. Capping `recordedAt` closes that
off the same way `MAX_NAME_LENGTH` already closes it for a name.

### Non-empty `date` and `recordedAt` (2026-09-15)

`validateRosterPayload` now requires `date` to be a **non-empty** string, and
`validateStatsPayload` requires the same of `recordedAt` (`isNonEmptyString`). Both used to accept
`''` on a bare `typeof … === 'string'` check, where the v2 validators never did. This is a
**tightening**, not a widening, and `CONTRACT_VERSION` stays where the day bump left it: a roster's
date is a `Game.date`, an ISO `yyyy-mm-dd` this app wrote itself, and `recordedAt` is the Client's
clock, so every payload a real sender has ever produced already carries both. Nothing legal before
is refused now.

A non-string and an empty string are deliberately the *same fault* with the *same message* —
`it has no date`, `it has no recorded time`. Neither is a date, and there is nothing to print for
either.

Why it matters enough to change **v1** at all: it is what makes normalisation **total**. Without it,
`normaliseRosterV1` / `normaliseStatsV1` would be *nearly* total instead of total — v1 would accept
`date: ''`, normalisation would lift it into the day shape, and the v2 validator would refuse it,
because the date is the identity of a day payload and cannot be blank there. Both
`src/store/importStats.ts` and `src/store/useAppStore.ts` re-validate a payload they were already
handed, so that refusal would land **mid-import**, after the coach had been shown a preview of the
very payload the app then rejected: the worst place to discover it, and precisely the failure the
normalisation path exists to make impossible. Closing it on the v1 side keeps every accepted v1
payload normalisable, which is a property `statsContract.test.ts` asserts directly rather than
trusting.

Recorded alongside it, because it is the same property seen from the other end: **v1's 12-player cap
lands exactly on `MAX_ROSTER_PLAYERS` as the v2 per-game cap**, so even a full v1 roster normalises
to the boundary rather than past it. The two caps agreeing is not a coincidence to be tidied away —
it is why a v1 roster can be lifted into a day at all.

### `it names no players` for stats (2026-09-15)

`validateStatsPayload` now refuses a v1 stats payload whose `players` list is empty, with the
existing string `it names no players`. This is a **tightening**, not a widening, and no
`CONTRACT_VERSION` bump: a sheet naming nobody records nothing, and no real Client emits one.

**This entry also settles a genuine contradiction between the two published catalogues, and that is
the main reason it exists.** `it names no players` was listed in this document's *roster* catalogue
and deliberately absent from its *stats* one. That was not a slip in one implementation — the code
matched the doc on both sides. It meant that, **by published spec**, a v1 stats payload was allowed
an empty player directory while a v1 roster payload was not, and while the v2 path (`parseDayPlayerList`,
which serves both kinds from one helper) forbade it for both. Two specs, published on the same page,
disagreeing about the same list. This entry resolves that in favour of refusing it everywhere.

The mechanics are the same as the previous entry's, and it was found by the same question. It was
the last thing standing between `normaliseStatsV1` and totality: `{ players: [], sets: [...] }` was
accepted by v1, normalised, and then refused by the v2 validator with this very string — landing
mid-import, after the coach had already seen a preview. The wording is not new; only its reachability
for a stats payload is. Both apps must now produce it for both kinds.

## Plain-JS reference codec

The same logic as `src/contract/statsContract.ts`, without types, for an implementer who is not
using TypeScript (e.g. the Client). Shape validation is intentionally omitted here — only the
transport codec needs to be identical between the two apps — apart from `serveTurnCount` and the
v5 `servers` check, and the v6 serve-order check and reading rule, whose rules both apps must agree on exactly.

```js
const CONTRACT_VERSION = 6;
const PREFIX = { roster: 'CIQR', stats: 'CIQS' };

/** Coach-readable name for each kind, used in the kind-mismatch error. */
const KIND_LABEL = { roster: 'roster payload', stats: 'stats payload' };

/** Which app authors each kind. A roster is made by the Rotation Planner and a stats sheet by the
 *  stats app, so naming the stats app for both — which this file used to do — tells a coach on the
 *  Client side to re-copy from, or update, the wrong app. The kind alone decides it, so the one
 *  file both apps run verbatim produces the right words on each side. */
const AUTHOR_LABEL = { roster: 'the Rotation Planner', stats: 'the stats app' };

/** The one message for every way the body can fail to be trustworthy JSON. `expected`, not the
 *  decoded kind: on a payload this corrupt the prefix may be the only thing worth trusting, and
 *  the caller has already said which app it believes it is reading. */
function corrupt(expected) {
  return `This payload is corrupted or incomplete — copy it again from ${AUTHOR_LABEL[expected]}.`;
}

function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function toBase64Url(bytes) {
  let bin = '';
  // A loop, not spread: `String.fromCharCode(...bytes)` overflows the call stack on a payload of a
  // few thousand bytes. That was written when a 12-player stats sheet was the worst case; a day
  // sheet reaches ~13 KB, so this is now a requirement rather than a precaution.
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** `version` defaults to `CONTRACT_VERSION`, and exists because the prefix version and the body's
 *  own `v` must agree — `decodePayload` cross-checks them and calls any disagreement corruption.
 *  A v1 encoder must pass `1` explicitly; the roster encoder passes `6` and the stats encoder
 *  `5`. */
function encodePayload(kind, json, version = CONTRACT_VERSION) {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return `${PREFIX[kind]}${version}.${toBase64Url(bytes)}.${fnv1a32(bytes)}`;
}

// The two day encoders, each pinned to the contract that last changed its kind: the roster gained
// `serve` at 6, and stats have not changed since 5. decodePayload calls a body `v` that differs
// from the prefix corruption, so each pin moves with its body's `v` or not at all.
function encodeDayRoster(payload) { return encodePayload('roster', payload, 6); }
function encodeDayStats(payload) { return encodePayload('stats', payload, 5); }

// The two surviving v1 encoders. The explicit `1` is not decoration — see above.
function encodeRoster(payload) { return encodePayload('roster', payload, 1); }
function encodeStats(payload) { return encodePayload('stats', payload, 1); }

function decodePayload(text, expected) {
  const compact = text.replace(/\s+/g, '');
  const head = /^(CIQ[RS])(\d+)\./.exec(compact);
  if (!head) return { ok: false, error: 'This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.' };
  const kind = head[1] === 'CIQR' ? 'roster' : 'stats';
  if (kind !== expected) return { ok: false, error: `This is a ${KIND_LABEL[kind]}, not a ${KIND_LABEL[expected]}.` };
  const version = Number(head[2]);
  if (version > CONTRACT_VERSION) {
    return { ok: false, error: `This payload was made by a newer version of ${AUTHOR_LABEL[expected]} (contract ${version}); this app understands ${CONTRACT_VERSION}.` };
  }
  const m = /^(CIQ[RS])(\d+)\.([A-Za-z0-9_-]*)\.([0-9a-f]{8})$/.exec(compact);
  if (!m) return { ok: false, error: corrupt(expected) };
  const bytes = fromBase64Url(m[3]);
  if (!bytes || fnv1a32(bytes) !== m[4]) return { ok: false, error: corrupt(expected) };
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, error: corrupt(expected) };
  }
  // `Array.isArray` is part of the test: `typeof [] === 'object'`, and an array is not a payload.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || parsed.v !== version || parsed.kind !== kind) {
    return { ok: false, error: corrupt(expected) };
  }
  // Not yet shape-validated. Dispatch on `parsed.v` next. A roster: 1, 2 and 3 are legacy payloads
  // to validate and lift to v6 (a v2 roster's per-game index array becomes one set mask; every
  // legacy game gets `serve` all null), and 6 is the current day roster. Stats: 1 is legacy, and
  // 2, 3, 4 and 5 are read by the current stats validator. Anything else is
  // `its version is not 1, 2, 3, 4, 5 or 6`.
  return { ok: true, value: parsed };
}

/** How many serve turns of ours a point log holds: runs of rallies we served, the winner of each
 *  rally serving the next. `servers` has exactly this many entries. */
function serveTurnCount(points, servedFirst) {
  let turns = 0;
  let weServe = servedFirst;
  let inTurn = false;
  for (const c of points) {
    if (weServe && !inTurn) {
      turns += 1;
      inTurn = true;
    }
    if (!weServe) inTurn = false;
    weServe = c === 'U';
  }
  return turns;
}

/** The one piece of shape validation repeated here, because its count rule is easy to get wrong:
 *  a v5 set's `servers`. `log` is the set's validated `{ servedFirst, points }` or `null`;
 *  `idsInSet` is the Set of ids with a stat line in that set. Returns the detail for
 *  `The stats payload is malformed: <detail>.`, or `null` when the list is fine (or absent). */
function serversFault(gid, n, rawServers, log, idsInSet) {
  if (rawServers === undefined) return null;
  if (log === null) return `game "${gid}" set ${n} names servers but has no point log`;
  if (!Array.isArray(rawServers)) return `game "${gid}" set ${n} has a malformed server list`;
  const turns = serveTurnCount(log.points, log.servedFirst);
  if (rawServers.length !== turns) return `game "${gid}" set ${n} names ${rawServers.length} servers for ${turns} serve turns`;
  for (const id of rawServers) {
    if (id === null) continue;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !idsInSet.has(id)) {
      return `game "${gid}" set ${n} names server "${String(id)}", who has no stat line in that set`;
    }
  }
  return null;
}

/** Bit `index` of a set mask, by arithmetic: `|` and `&` coerce to signed 32-bit. */
function maskHas(mask, index) { return Math.floor(mask / 2 ** index) % 2 === 1; }

/** Contract 6: one roster game's `serve` list, checked against that game's validated `sets` masks
 *  and the directory size. Returns the detail for `The roster payload is malformed: <detail>.`, or
 *  `null` when the list is fine. Run it after every other roster check, for every game, so a game
 *  over its cap is reported as that. */
function serveListFault(gid, rawServe, sets, size) {
  if (!Array.isArray(rawServe) || rawServe.length !== sets.length) return `game "${gid}" has no serve list with one entry per set`;
  for (let i = 0; i < rawServe.length; i += 1) {
    const order = rawServe[i];
    const n = i + 1;
    if (order === null) continue;
    if (typeof order !== 'string' || !/^[0-9a-v-]{6,16}$/.test(order)) return `game "${gid}" set ${n} has a serve order that is not legal`;
    let named = false;
    for (const c of order) {
      if (c === '-') continue;
      const index = parseInt(c, 32);
      if (index >= size) return `game "${gid}" set ${n} serve order names player ${index}, but the payload lists only ${size}`;
      if (!maskHas(sets[i], index)) return `game "${gid}" set ${n} serve order names a player who is not in that set`;
      named = true;
    }
    if (!named) return `game "${gid}" set ${n} serve order names nobody`;
  }
  return null;
}

/** Contract 6's reading rule: the entry of a serve string of `length` characters that names our
 *  server for rally `at` (0-based; `at === points.length` is the next rally) — the rally's server
 *  while we serve it, our next server while they do. */
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

## Golden vectors

Fixed input → fixed encoded output. Both apps can check their own codec against these; this
app's `src/contract/statsContract.test.ts` asserts against the same values, sourced from
`src/contract/__fixtures__/vectors.ts`.

These strings are byte-exact only when the JSON is emitted with its fields in the order shown in
the payload below and with no whitespace — `JSON.stringify` on an object literal built in that
order, which is what both apps do. Key order is **not** part of the contract: a payload whose
fields come in another order is perfectly valid and decodes fine, it simply will not equal the
vector. So a Client checking itself against these should either compare the *decoded* object, or
emit its keys in the documented order before comparing the strings.

### Roster vector (contract v6)

The v3 day below plus `serve`, one entry per set. Between them the two games cover:
- a dash (`game-1` set 1, `"010-10"`: Grace, Zoë, Grace, nobody, Zoë, Grace);
- `null` (`game-1` set 2, and `game-2` set 2, which has nobody in it);
- a Train-length entry of 7 (`game-1` set 3);
- one server for every turn (`game-2` set 1).

Every index is in its set's mask. Key order on a game: `gameId`, `opponent`, `sets`, `serve`.
Frozen: never regenerate this string.

Payload:

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

Decoding the v3, v2 and v1 roster vectors below gives the same day at `v: 6` with every `serve`
entry `null` (`ROSTER_V3_AS_V6`, `ROSTER_V2_AS_V6`, `ROSTER_V1_AS_V6` in
`src/contract/__fixtures__/vectors.ts`).

### Serve order vector (contract v6)

Pure data, not an encoded payload, so the Client can check its reading of a `serve` string
against the Planner's replay. `SERVE_ORDER_VECTOR` in `src/contract/__fixtures__/vectors.ts`,
built from `replaySet` on a slot set with one front/back pair and one usable serve override, then
frozen. We receive first, and the 36 rallies hold 10 serve turns of ours, so the order wraps past
entry 5. For every `i` where `servers[i]` is not `null`,
`order[serveEntryAt(points, servedFirst, i, order.length)]` must equal `servers[i]`; where it is
`null`, they served rally `i`.

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

### Roster vector (contract v3, legacy)

The same two-game day as the v2 vector below, so the diff between the two shows exactly what
changed: `roster` index arrays become one bitmask per set. `game-1` runs three sets with different
membership each time — both players, then Grace alone, then Zoë alone — which a v2 payload could
not express at all, since v2 only ever carried the union across a game's sets. `game-2` runs two
sets and has nobody picked for the second, a mask of `0`, legal on purpose. A Client that ignores
the masks and ticks everybody for every set still decodes this vector and is still wrong. Since contract 6 it is decode-only: it decodes to this day at `v: 6` with `serve` all `null`.

Payload:

```json
{
  "v": 3, "kind": "roster", "date": "2026-09-19", "team": "Thunder",
  "players": [
    { "id": "grace", "name": "Grace", "jersey": 7 },
    { "id": "zoie", "name": "Zoë" }
  ],
  "games": [
    { "gameId": "game-1", "opponent": "Lions", "sets": [3, 1, 2] },
    { "gameId": "game-2", "opponent": "Falcons", "sets": [2, 0] }
  ]
}
```

Encoded:

```
CIQR3.eyJ2IjozLCJraW5kIjoicm9zdGVyIiwiZGF0ZSI6IjIwMjYtMDktMTkiLCJ0ZWFtIjoiVGh1bmRlciIsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJuYW1lIjoiR3JhY2UiLCJqZXJzZXkiOjd9LHsiaWQiOiJ6b2llIiwibmFtZSI6Ilpvw6sifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJvcHBvbmVudCI6Ikxpb25zIiwic2V0cyI6WzMsMSwyXX0seyJnYW1lSWQiOiJnYW1lLTIiLCJvcHBvbmVudCI6IkZhbGNvbnMiLCJzZXRzIjpbMiwwXX1dfQ.e9e26391
```

### Stats vector (contract v5)

The v4 sheet below with its version digit moved to `5`, and one `servers` list added on the logged
set: `game-1` set 1's `POINTS_46`, served first, holds 14 serve turns of ours; the phone knew Grace
served the first and Ava (`cx-8f2k1q`) the third, and nobody else, so the list is
`["grace", null, "cx-8f2k1q", null, null, null, null, null, null, null, null, null, null, null]`.
Both named ids have a stat line in that set. Set 2 and `game-2` are unchanged. Note the key order on
the logged set: `n`, `score`, `players`, `servedFirst`, `points`, `servers`. Frozen: never regenerate
this string.

Payload:

```json
{
  "v": 5, "kind": "stats", "recordedAt": "2026-09-19T21:04:00Z",
  "players": [
    { "id": "grace", "name": "Grace" },
    { "id": "cx-8f2k1q", "name": "Ava" }
  ],
  "games": [
    { "gameId": "game-1", "sets": [
      { "n": 1, "score": [25, 21], "players": [
        { "id": "grace", "serve": { "in": 8, "out": 2 }, "return": { "in": 5, "out": 1 } },
        { "id": "cx-8f2k1q", "serve": { "in": 0, "out": 0 }, "return": { "in": 3, "out": 0 } }
      ], "servedFirst": true, "points": "UUTUTTUUUTTUTTUUTUTTTUUUTUTTUUTUTTUUUTTUTUUTUU",
      "servers": ["grace", null, "cx-8f2k1q", null, null, null, null, null, null, null, null, null, null, null] },
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
CIQS5.eyJ2Ijo1LCJraW5kIjoic3RhdHMiLCJyZWNvcmRlZEF0IjoiMjAyNi0wOS0xOVQyMTowNDowMFoiLCJwbGF5ZXJzIjpbeyJpZCI6ImdyYWNlIiwibmFtZSI6IkdyYWNlIn0seyJpZCI6ImN4LThmMmsxcSIsIm5hbWUiOiJBdmEifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJzZXRzIjpbeyJuIjoxLCJzY29yZSI6WzI1LDIxXSwicGxheWVycyI6W3siaWQiOiJncmFjZSIsInNlcnZlIjp7ImluIjo4LCJvdXQiOjJ9LCJyZXR1cm4iOnsiaW4iOjUsIm91dCI6MX19LHsiaWQiOiJjeC04ZjJrMXEiLCJzZXJ2ZSI6eyJpbiI6MCwib3V0IjowfSwicmV0dXJuIjp7ImluIjozLCJvdXQiOjB9fV0sInNlcnZlZEZpcnN0Ijp0cnVlLCJwb2ludHMiOiJVVVRVVFRVVVVUVFVUVFVVVFVUVFRVVVVUVVRUVVVUVVRUVVVVVFRVVFVVVFVVIiwic2VydmVycyI6WyJncmFjZSIsbnVsbCwiY3gtOGYyazFxIixudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCxudWxsLG51bGxdfSx7Im4iOjIsInNjb3JlIjpudWxsLCJwbGF5ZXJzIjpbeyJpZCI6ImdyYWNlIiwic2VydmUiOnsiaW4iOjQsIm91dCI6MX0sInJldHVybiI6eyJpbiI6Miwib3V0IjoyfX1dfV19LHsiZ2FtZUlkIjoiZ2FtZS0yIiwic2V0cyI6W3sibiI6MSwic2NvcmUiOlsyNSwxOF0sInBsYXllcnMiOlt7ImlkIjoiY3gtOGYyazFxIiwic2VydmUiOnsiaW4iOjYsIm91dCI6MX0sInJldHVybiI6eyJpbiI6Miwib3V0IjowfX1dfV19XX0.2ded0a1d
```

### Stats vector (contract v4)

The v3 sheet below with its version digit moved to `4`, and one point log added: `game-1` set 1 was
served first by the Client's team, 46 rallies (`POINTS_46` in `vectors.ts`), 25 won and 21 lost —
so `score` is `[25, 21]`, the tally. Set 2 and `game-2` carry no log. Note the key order on the
logged set: `n`, `score`, `players`, `servedFirst`, `points`.

Payload:

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

### Stats vector (contract v3)

Byte-for-byte the v2 vector below with its version digit moved from `2` to `3` — which is the whole
of what contract 3 does to the stats half of the payload.

Payload:

```json
{
  "v": 3, "kind": "stats", "recordedAt": "2026-09-19T21:04:00Z",
  "players": [
    { "id": "grace", "name": "Grace" },
    { "id": "cx-8f2k1q", "name": "Ava" }
  ],
  "games": [
    { "gameId": "game-1", "sets": [
      { "n": 1, "score": [25, 21], "players": [
        { "id": "grace", "serve": { "in": 8, "out": 2 }, "return": { "in": 5, "out": 1 } },
        { "id": "cx-8f2k1q", "serve": { "in": 0, "out": 0 }, "return": { "in": 3, "out": 0 } }
      ] },
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
CIQS3.eyJ2IjozLCJraW5kIjoic3RhdHMiLCJyZWNvcmRlZEF0IjoiMjAyNi0wOS0xOVQyMTowNDowMFoiLCJwbGF5ZXJzIjpbeyJpZCI6ImdyYWNlIiwibmFtZSI6IkdyYWNlIn0seyJpZCI6ImN4LThmMmsxcSIsIm5hbWUiOiJBdmEifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJzZXRzIjpbeyJuIjoxLCJzY29yZSI6WzI1LDIxXSwicGxheWVycyI6W3siaWQiOiJncmFjZSIsInNlcnZlIjp7ImluIjo4LCJvdXQiOjJ9LCJyZXR1cm4iOnsiaW4iOjUsIm91dCI6MX19LHsiaWQiOiJjeC04ZjJrMXEiLCJzZXJ2ZSI6eyJpbiI6MCwib3V0IjowfSwicmV0dXJuIjp7ImluIjozLCJvdXQiOjB9fV19LHsibiI6Miwic2NvcmUiOm51bGwsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJzZXJ2ZSI6eyJpbiI6NCwib3V0IjoxfSwicmV0dXJuIjp7ImluIjoyLCJvdXQiOjJ9fV19XX0seyJnYW1lSWQiOiJnYW1lLTIiLCJzZXRzIjpbeyJuIjoxLCJzY29yZSI6WzI1LDE4XSwicGxheWVycyI6W3siaWQiOiJjeC04ZjJrMXEiLCJzZXJ2ZSI6eyJpbiI6Niwib3V0IjoxfSwicmV0dXJuIjp7ImluIjoyLCJvdXQiOjB9fV19XX1dfQ.89cc6a1f
```

### Roster vector (contract v2)

A two-game day: the shape the whole contract moved to, and the smallest one that can go wrong in a
v2-specific way — a second game, and a `roster` of indices that is **not** simply every player.
A Client that ignores the indices and ticks everybody still decodes this vector and is still wrong.

Payload:

```json
{
  "v": 2, "kind": "roster", "date": "2026-09-19", "team": "Thunder",
  "players": [
    { "id": "grace", "name": "Grace", "jersey": 7 },
    { "id": "zoie", "name": "Zoë" }
  ],
  "games": [
    { "gameId": "game-1", "opponent": "Lions", "roster": [0, 1] },
    { "gameId": "game-2", "opponent": "Falcons", "roster": [1] }
  ]
}
```

Encoded:

```
CIQR2.eyJ2IjoyLCJraW5kIjoicm9zdGVyIiwiZGF0ZSI6IjIwMjYtMDktMTkiLCJ0ZWFtIjoiVGh1bmRlciIsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJuYW1lIjoiR3JhY2UiLCJqZXJzZXkiOjd9LHsiaWQiOiJ6b2llIiwibmFtZSI6Ilpvw6sifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJvcHBvbmVudCI6Ikxpb25zIiwicm9zdGVyIjpbMCwxXX0seyJnYW1lSWQiOiJnYW1lLTIiLCJvcHBvbmVudCI6IkZhbGNvbnMiLCJyb3N0ZXIiOlsxXX1dfQ.7b1e1d96
```

### Stats vector (contract v2)

The same two-game day. Note `game-2`'s sets starting again at `n: 1` — set numbers are scoped to a
game, never to a day, which is the thing most likely to be got wrong on the stats side.

Payload:

```json
{
  "v": 2, "kind": "stats", "recordedAt": "2026-09-19T21:04:00Z",
  "players": [
    { "id": "grace", "name": "Grace" },
    { "id": "cx-8f2k1q", "name": "Ava" }
  ],
  "games": [
    { "gameId": "game-1", "sets": [
      { "n": 1, "score": [25, 21], "players": [
        { "id": "grace", "serve": { "in": 8, "out": 2 }, "return": { "in": 5, "out": 1 } },
        { "id": "cx-8f2k1q", "serve": { "in": 0, "out": 0 }, "return": { "in": 3, "out": 0 } }
      ] },
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
CIQS2.eyJ2IjoyLCJraW5kIjoic3RhdHMiLCJyZWNvcmRlZEF0IjoiMjAyNi0wOS0xOVQyMTowNDowMFoiLCJwbGF5ZXJzIjpbeyJpZCI6ImdyYWNlIiwibmFtZSI6IkdyYWNlIn0seyJpZCI6ImN4LThmMmsxcSIsIm5hbWUiOiJBdmEifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJzZXRzIjpbeyJuIjoxLCJzY29yZSI6WzI1LDIxXSwicGxheWVycyI6W3siaWQiOiJncmFjZSIsInNlcnZlIjp7ImluIjo4LCJvdXQiOjJ9LCJyZXR1cm4iOnsiaW4iOjUsIm91dCI6MX19LHsiaWQiOiJjeC04ZjJrMXEiLCJzZXJ2ZSI6eyJpbiI6MCwib3V0IjowfSwicmV0dXJuIjp7ImluIjozLCJvdXQiOjB9fV19LHsibiI6Miwic2NvcmUiOm51bGwsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJzZXJ2ZSI6eyJpbiI6NCwib3V0IjoxfSwicmV0dXJuIjp7ImluIjoyLCJvdXQiOjJ9fV19XX0seyJnYW1lSWQiOiJnYW1lLTIiLCJzZXRzIjpbeyJuIjoxLCJzY29yZSI6WzI1LDE4XSwicGxheWVycyI6W3siaWQiOiJjeC04ZjJrMXEiLCJzZXJ2ZSI6eyJpbiI6Niwib3V0IjoxfSwicmV0dXJuIjp7ImluIjoyLCJvdXQiOjB9fV19XX1dfQ.0342dd9e
```

### Roster vector (contract v1)

The v1 vectors are **retained**, and they still decode: a v1 payload is read and normalised into the
day shape. They are also frozen — both apps quote them byte for byte, so nothing either app does to
the codec may change them, which is why the surviving v1 encoders pin their version explicitly.

Payload:

```json
{
  "v": 1, "kind": "roster", "gameId": "game-1", "team": "Thunder", "opponent": "Lions",
  "date": "2026-09-19",
  "players": [
    { "id": "grace", "name": "Grace", "jersey": 7 },
    { "id": "zoie", "name": "Zoë" }
  ]
}
```

Encoded:

```
CIQR1.eyJ2IjoxLCJraW5kIjoicm9zdGVyIiwiZ2FtZUlkIjoiZ2FtZS0xIiwidGVhbSI6IlRodW5kZXIiLCJvcHBvbmVudCI6Ikxpb25zIiwiZGF0ZSI6IjIwMjYtMDktMTkiLCJwbGF5ZXJzIjpbeyJpZCI6ImdyYWNlIiwibmFtZSI6IkdyYWNlIiwiamVyc2V5Ijo3fSx7ImlkIjoiem9pZSIsIm5hbWUiOiJab8OrIn1dfQ.95c9f4c5
```

### Stats vector (contract v1)

Payload:

```json
{
  "v": 1, "kind": "stats", "gameId": "game-1", "recordedAt": "2026-09-19T21:04:00Z",
  "players": [
    { "id": "grace", "name": "Grace" },
    { "id": "cx-8f2k1q", "name": "Ava" }
  ],
  "sets": [
    { "n": 1, "score": [25, 21], "players": [
      { "id": "grace", "serve": { "in": 8, "out": 2 }, "return": { "in": 5, "out": 1 } },
      { "id": "cx-8f2k1q", "serve": { "in": 0, "out": 0 }, "return": { "in": 3, "out": 0 } }
    ] },
    { "n": 2, "score": null, "players": [
      { "id": "grace", "serve": { "in": 4, "out": 1 }, "return": { "in": 2, "out": 2 } }
    ] }
  ]
}
```

Encoded:

```
CIQS1.eyJ2IjoxLCJraW5kIjoic3RhdHMiLCJnYW1lSWQiOiJnYW1lLTEiLCJyZWNvcmRlZEF0IjoiMjAyNi0wOS0xOVQyMTowNDowMFoiLCJwbGF5ZXJzIjpbeyJpZCI6ImdyYWNlIiwibmFtZSI6IkdyYWNlIn0seyJpZCI6ImN4LThmMmsxcSIsIm5hbWUiOiJBdmEifV0sInNldHMiOlt7Im4iOjEsInNjb3JlIjpbMjUsMjFdLCJwbGF5ZXJzIjpbeyJpZCI6ImdyYWNlIiwic2VydmUiOnsiaW4iOjgsIm91dCI6Mn0sInJldHVybiI6eyJpbiI6NSwib3V0IjoxfX0seyJpZCI6ImN4LThmMmsxcSIsInNlcnZlIjp7ImluIjowLCJvdXQiOjB9LCJyZXR1cm4iOnsiaW4iOjMsIm91dCI6MH19XX0seyJuIjoyLCJzY29yZSI6bnVsbCwicGxheWVycyI6W3siaWQiOiJncmFjZSIsInNlcnZlIjp7ImluIjo0LCJvdXQiOjF9LCJyZXR1cm4iOnsiaW4iOjIsIm91dCI6Mn19XX1dfQ.27119bc0
```
