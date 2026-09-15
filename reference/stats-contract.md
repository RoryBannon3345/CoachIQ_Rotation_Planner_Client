# The stats contract

The copy/paste payload format shared between CoachIQ Rotation Planner (this app) and the
separate iPhone stats app (the "Client"). Both apps implement the same codec independently —
this document is the shared source of truth, including test vectors either implementation can be
checked against.

## Purpose

The coach plans lineups here, then sends the Client a roster for a **day** of games so it knows who
is playing in each of them. During each game the Client records serve and service-return counts per
set, and the coach switches between the day's games without reloading anything. At the end of the
day she copies the Client's stats payload back here — one payload covering every game — and pastes
it in. There is no network between the two apps: everything travels as plain text, by copy/paste
(the roster typically through email, the stats sheet by clipboard — see "Payload size"), so the
format has to survive a mail client's line-wrapping and quoting.

This app's implementation lives in `src/contract/statsContract.ts`, deliberately with **zero
imports** — the Client is plain HTML/JS on iOS Safari and copies that file's logic verbatim
rather than sharing a build step with it. Keep this document and that file in sync by hand.

The current contract is **version 2**, which moved the unit of exchange from one game to a whole
day. `docs/stats-contract-v2-client-guide.md` is the companion change brief written for the
Client's author: what moved, why, and what the Client has to do about it. This document is the
reference for the format as it ends up, and it keeps the v1 schemas, because v1 stats payloads
are still accepted.

## The encoded form

```
CIQR2.<base64url of UTF-8 JSON>.<8 hex chars>      roster payload, contract 2
CIQS2.<base64url of UTF-8 JSON>.<8 hex chars>      stats payload, contract 2
CIQR1.<base64url of UTF-8 JSON>.<8 hex chars>      roster payload, contract 1 (legacy)
CIQS1.<base64url of UTF-8 JSON>.<8 hex chars>      stats payload, contract 1 (legacy)
```

- `CIQR` / `CIQS` name the payload **kind** (roster / stats). A decoder reads this before
  touching the body, so it can say "this is a roster, not stats" without attempting to parse
  anything.
- The digit immediately after the kind letters (`2` today) is the **contract major version**
  (`CONTRACT_VERSION`). A decoder refuses a payload whose version is higher than the one it
  understands, before attempting to decode the body.
- The two literal `.` characters separate three fields: `<prefix+version>.<body>.<checksum>`.

**The algorithm itself is unchanged by the version 2 bump.** Same Base64URL, same FNV-1a over the
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
disagreement corruption. Now that `CONTRACT_VERSION` is 2, a v1 body encoded with the default would
go out as `CIQS2.` wrapped around `"v":1` and be refused by this very module. So the surviving v1
encoders pass `1` explicitly — which is also what keeps the v1 golden vectors below byte-identical.
A v2 encoder never passes it.

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
   `decodeDayStats` then dispatch on the body's own `v` — `1` runs the v1 validator and normalises
   the result into the day shape, `2` runs the v2 validator — and always hand back a day payload,
   so nothing downstream has to branch on a version. Dispatching on that `v` is safe because step 7
   has already proved it equals the prefix version the transport layer vouched for.

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

## Roster payload schema (contract v2)

One day, the day's player directory, and every game of that day. Validated by
`validateDayRosterPayload`.

| Field | Type | Rule |
|---|---|---|
| `v` | `2` | Must equal the version named in the prefix. |
| `kind` | `"roster"` | Fixed. |
| `date` | `string` | Non-empty. The day this payload is about — the identity of a day payload, so a blank one is refused. |
| `team` | `string` | Display-only. May be empty: `createTeam` does not trim, so a coach who never named her team has a blank one, and refusing it would refuse a real save. |
| `players` | array | The day's **directory**: 1–24 entries (`MAX_DAY_PLAYERS`), unique ids. A day's directory spans every game of the day, so it is legitimately larger than any one game's tick-list (`MAX_ROSTER_PLAYERS`) — squads rotate across games and a tournament day can field two teams' worth of names. |
| `players[].id` | `string` | Matches `ID_PATTERN` (see below). |
| `players[].name` | `string` | Required, 1–64 characters (`MAX_NAME_LENGTH`). |
| `players[].jersey` | `number` | Optional — this app's roster panel does not collect jerseys today, so it is usually absent. |
| `games` | array | 1–8 entries (`MAX_GAMES_PER_DAY`), at least one. |
| `games[].gameId` | `string` | Non-empty, unique within the payload. Echoed back in the stats payload to match the game. |
| `games[].opponent` | `string` | Display-only. May be empty, the same way `team` may: a game against an unnamed opponent is a real thing a coach plans, and the Client only ever prints this string. |
| `games[].roster` | `number[]` | **Indices into this payload's own `players`, not ids.** 0–12 entries (`MAX_ROSTER_PLAYERS`), each a whole number ≥ 0 and below `players.length`, none repeated. May be empty. |

### The three rules about `games[].roster`

None of these can be enforced by a validator — a payload that gets them wrong is perfectly legal and
merely behaves badly in a gym — so they are stated here, where both implementations read them.

- **It is a pre-selection, not a whitelist.** The Client's tick-list for any game of the day shows
  the **whole directory**, with that game's entries pre-ticked. That is what lets a coach record an
  unplanned game, or a girl the morning's plan did not include, without minting a `cx-` duplicate of
  someone already sitting in the directory under her real id.
- **An empty `roster` is legal.** A coach can send the day before she has picked who plays the third
  game; refusing that would make her choose between sending early and sending at all. Show the full
  directory with nothing ticked.
- **`cx-` is only for someone not in the day directory at all.** It is never the right answer for a
  player who is in `players` but not in this game's `roster`. Once the payload reaches this app a
  `cx-` id is indistinguishable from a genuine new guest, so the distinction is entirely the
  Client's to keep.

## Stats payload schema (contract v2)

One day's recording across every game the Client tracked. Validated by `validateDayStatsPayload`.
No `date`, `team` or `opponent`: the import matches each game on `gameId` and this app already knows
the rest, so re-sending them would only create a second source of truth for facts this app owns.

| Field | Type | Rule |
|---|---|---|
| `v` | `2` | Must equal the version named in the prefix. |
| `kind` | `"stats"` | Fixed. |
| `recordedAt` | `string` | Non-empty ISO timestamp, from the Client's clock. At most 32 characters (`MAX_RECORDED_AT_LENGTH`). |
| `players` | array | The day's directory, of `{ id, name }` entries — 1–24 of them (`MAX_DAY_PLAYERS`), unique ids, each `id` matching `ID_PATTERN` and each `name` 1–64 characters (`MAX_NAME_LENGTH`). The set lines refer to it **by id string**, not by index the way a roster's `games[].roster` does — but the directory itself is objects either way. No `jersey`: a stats sheet has no use for one, so the field is dropped on the way in. A Client-added player (id in the `cx-` namespace) arrives with a name and becomes a guest on import. |
| `games` | array | 1–8 entries (`MAX_GAMES_PER_DAY`), at least one. |
| `games[].gameId` | `string` | Non-empty, unique within the payload. Matched against a saved game's id on import. |
| `games[].sets` | array | 1–5 entries (`MAX_SETS`) **per game**, `n` ascending and unique **within that game**. A set the team did not play is simply omitted, not sent with empty stats. |
| `games[].sets[].n` | `number`, 1–5 (`MAX_SETS`) | The set number. Sets are per game: **every game starts again at set 1**, so a day of three games legitimately carries three set-1 lines. |
| `games[].sets[].score` | `[number, number] \| null` | `[us, them]`, or `null` if not recorded. **The key is required**: send it as `null`, never omit it — an absent `score` is refused as `game "<gid>" set <n> has a malformed score`, which rejects the whole paste. Both entries must be finite. |
| `games[].sets[].players` | array | Stat lines for that set. Every `id` here must appear in the top-level `players`. A player with no line in a set is 0/0 there — not an error. |
| `…players[].serve` / `.return` | `{ in: number; out: number }` | Both integers, `0`–`999` (`MAX_COUNT`). **Totals are never transmitted** — both apps derive `in + out`. |

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
| `players` | array | 1–12 entries (`MAX_ROSTER_PLAYERS`), unique ids (the Planner's own encoder no longer enforces the 1–12 bound — see the exception under Limits below). Alphabetical by name is a **send-side convention, not a rule**: `rosterPayload.ts` sorts that way (tied on id) but `validateRosterPayload` has no ordering check, so a payload in any order is legal and must be accepted. |
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
| `players` | array | The roster the Client actually used: 1–12 entries (`MAX_ROSTER_PLAYERS`), unique ids, each name 1–64 characters (`MAX_NAME_LENGTH`). **At least one** — see "`it names no players` for stats" under Versioning policy. A Client-added player (id in the `cx-` namespace) arrives with a name and becomes a guest on import. |
| `sets` | array | 1–5 entries (`MAX_SETS`), `n` ascending and unique. A set the team did not play is simply omitted, not sent with empty stats. |
| `sets[].n` | `number`, 1–5 (`MAX_SETS`) | The set number. |
| `sets[].score` | `[number, number] \| null` | `[us, them]`, or `null` if not recorded. **The key is required**: send it as `null`, never omit it — an absent `score` is refused as `set <n> has a malformed score`, which rejects the whole paste. Both entries must be finite — see "Finite set scores" under Versioning policy. |
| `sets[].players` | array | Stat lines for that set. Every `id` here must appear in the top-level `players`. A player with no line in a set is 0/0 there — not an error. |
| `sets[].players[].serve` / `.return` | `{ in: number; out: number }` | Both integers, `0`–`999` (`MAX_COUNT`). **Totals are never transmitted** — both apps derive `in + out`. |

## Id rules

- **Player id** (`ID_PATTERN`): `/^[A-Za-z0-9_-]{1,64}$/` — opaque, 1–64 characters, no spaces.
  This app's own ids (`domain/id.ts`) already match this shape.
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
`games[].roster`.

The **roster** travels as a `mailto:` URL body, which several mail clients cut off somewhere near
2000 characters — `openMailto.ts` puts the practical figure at about 2048, and the measurements
below are marked against that. This app's ids are **24–25 characters** — `generateId` (`src/store/useAppStore.ts`)
builds them as `` `${prefix}-${Date.now().toString(36)}-${counter}-${6 random}` `` and the prefix is
the full word `player`, so a real one is `player-mu2strf8-7-a8c3d9`; the counter is session-global,
so it takes a second digit past the ninth id. Game ids are 22–23 the same way.
Re-listing twelve of those for every game of the day is by far the roster payload's largest cost.

Measured full composed-href lengths for a 12-player squad, a 23-character address, the subject
`Roster · Thunder 14U Gold · Fri, Sep 11`, a 16-character team name and opponents of realistic
length:

| games | id strings | indices |
|---|---|---|
| 1 | 1582 | 1181 |
| 2 | **2123 — over** | 1321 |
| 3 | **2661 — over** | 1457 |
| 4 | **3194 — over** | 1589 |
| 7 | **4799 — over** | 1990 |
| 8 (the cap) | **5333 — over** | **2122 — over** |

**Id strings break the ceiling at two games** — the most ordinary tournament day there is. That is
why `games[].roster` carries numbers: not as an optimisation weighed against readability, but
because there is no version of a day roster built from id strings that survives an ordinary
Saturday.

Each additional game costs **132 characters** with the index encoding, against roughly 535 with id
strings — one grows a day at a time, the other a squad at a time. And the cap lines up with the
medium rather than being a round number: a full **eight**-game day with a 12-player squad composes
to 2122, just over, so `MAX_GAMES_PER_DAY` stops permitting days at almost exactly the point the
email stops carrying them. The absolute worst case the schema permits — 8 games against the full
24-player directory — is 3313.

The `mailto:` overhead on top of the payload is **flat with respect to the body**, so it shifts
every row of that table by the same amount rather than scaling with it: `mailto:` + `?subject=` +
`&body=` is 22 characters, plus the escaped address and the escaped subject — **112** for the
address and subject the table above uses, and correspondingly less or more for a shorter or longer
one. The payload itself contributes nothing: Base64URL's alphabet plus the two dots the codec adds
is entirely unreserved to `encodeURIComponent`, so the body does not expand under escaping at all.
That flatness is load-bearing rather than incidental — it is what lets `composeMailto`
(`src/components/openMailto.ts`) be measured directly as an exact length rather than estimated with
padding for escaping that never happens.

`MAILTO_WARN_LENGTH` is **1900**, and it is measured against the composed href, not against the
payload: above it the Stats dialog warns that the receiving mail client may cut the email off before
it is ever sent. With a full squad it fires at **seven** games (1990) — only in the region the caps
already call extreme, which is what a warning should do. It sits below the practical ceiling with
roughly 100 characters of slack for a longer address or a longer opponent name in the subject —
both of which grow the URL by more than the payload does, since the payload is the one part
`encodeURIComponent` cannot expand.

**Stats must never go by `mailto:`.** A 3-game, 3-set, 12-player day sheet encodes to roughly
**13 KB**, about six times anything a `mailto:` URL can be relied on to carry. The stats payload
travels by clipboard into a textarea, which has no length limit, and that is also why it keeps id
strings where the roster uses indices: an off-by-one index in a stats payload would silently
attribute one player's serves to another and every validator on both sides would pass it, because an
in-range index is always a legal index, whereas a wrong id is caught by the unknown-id refusal in
`src/store/importStats.ts`.

## Limits

| Constant | Value | Meaning |
|---|---|---|
| `CONTRACT_VERSION` | `2` | The contract's major version. |
| `MAX_GAMES_PER_DAY` | `8` | The most games one day payload may carry, in either kind. A tournament day is a handful of games; eight is generously above any real one, and bounds how much a single paste can push into saved state. It also lands almost exactly on what a `mailto:` roster can carry — see "Payload size" above. |
| `MAX_DAY_PLAYERS` | `24` | The most players one day payload's directory may name. A day's directory spans every game of the day, so it is legitimately larger than any one game's tick-list — squads rotate across games and a tournament day can field two teams' worth of names. |
| `MAX_ROSTER_PLAYERS` | `12` | The largest pre-selection **one game inside a day payload** may name (`games[].roster`) — the size of the tick-list the Client shows for a single game, which is what it was always about. In v1, when a payload *was* one game, it bounded the whole payload's `players` instead, and it still does on the v1 path. |
| `MAX_COUNT` | `999` | Largest legal serve/return count. |
| `MAX_NAME_LENGTH` | `64` | Longest legal `players[].name`, in **both** payloads. An empty name is malformed too. |
| `MAX_RECORDED_AT_LENGTH` | `32` | Longest legal `recordedAt`. An ISO timestamp with milliseconds and a timezone offset is under 32 characters. |
| `MAX_SETS` | `5` | Largest legal `sets` length and `sets[].n` — **per game** at v2, per payload at v1. Receive-side only — see "Set count" under Versioning policy below. |

On the v1 path `MAX_ROSTER_PLAYERS` bounds the stats payload's top-level `players` as well: that
list echoes the roster the Client was handed. `validateRosterPayload` refuses a v1 roster payload
longer than 12 outright, so the Client can never successfully import one — see the Planner-side
exception below for the one case that produces a roster payload longer than 12 in the first place.
Every cap on this page is a refusal, not a truncation — nothing over-long is allowed to reach saved
state.

> **Planner-side exception (2026-09-14, escalated 2026-09-15).** The Rotation Planner's roster email
> encodes every player each game names, without enforcing `MAX_ROSTER_PLAYERS` — the coach asked for
> the whole game in the email, because that is what she asked for. The validators are unchanged and
> still refuse a game naming more than twelve, so a thirteen-player game produces an email the stats
> app will refuse on import.
>
> **The blast radius grew with the day payload.** Under v1 an over-cap game spoiled its own email and
> nothing else: one game, one payload. Under v2 a day is one payload, and
> `validateDayRosterPayload` refuses **the whole thing** — so a single thirteen-player game takes the
> day's other games down with it, and the coach loses a Saturday's roster rather than a match's.
>
> The remedy is unchanged and still the only one. The payload cannot be hand-edited to fix it
> afterwards: the body is a single opaque Base64URL token with an FNV-1a checksum appended
> (`encodePayload`), so any edit — trimming one game back under 12, say — invalidates the checksum
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
  the second is the reader's own `CONTRACT_VERSION`, which is **2** today, so these render as
  `(contract 3); this app understands 2.` (this is the rendering
  `docs/stats-contract-v2-client-guide.md` reproduces):
  - `This payload was made by a newer version of the Rotation Planner (contract <n>); this app understands 2.`
  - `This payload was made by a newer version of the stats app (contract <n>); this app understands 2.`
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
- `it names <n> players; the limit is 12`
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
- `it names <n> players; the limit is 12`
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

### Contract v2 (`validateDayRosterPayload` / `validateDayStatsPayload`)

Same two forms — `The roster payload is malformed: <detail>.` and
`The stats payload is malformed: <detail>.` — where `<detail>` is one of:

Roster:
- `it is not an object`
- `its version is not 1 or 2`
- `its kind is not "roster"`
- `it has no date`
- `it has no team name`
- `it has no player list`
- `it names no players`
- `it names <n> players; the day limit is 24`
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
- `game "<gid>" has no roster`
- `game "<gid>" names <n> players; the limit is 12`
- `game "<gid>" has a malformed player reference`
- `game "<gid>" names player <n>, but the payload lists only <n>`
- `game "<gid>" names player <n> twice`

Stats:
- `it is not an object`
- `its version is not 1 or 2`
- `its kind is not "stats"`
- `it has no recorded time`
- `its recorded time is <n> characters; the limit is 32`
- `it has no player list`
- `it names no players`
- `it names <n> players; the day limit is 24`
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

- The **day directory** over-cap says `the day limit is 24`; a **game's** over-cap says
  `the limit is 12`. Different phrase, different limit, on purpose.
- A roster `names <n> games; the limit is 8`, while a stats sheet `records more than 8 games`. A
  roster names games it plans; a sheet records games that happened.
- `its version is not 1 or 2` names **both** versions this app reads rather than only the one that
  refused, because a coach who pasted the wrong thing needs to know what is acceptable, not which
  branch said no. The v1 validators still say `its version is not 1`; they are only reachable
  through the day decoders, which have already dispatched on the body's `v`.
- An out-of-range index is `names player <n>, but the payload lists only <n>`, but anything that is
  not a whole number ≥ 0 is `has a malformed player reference` instead. `-1` is not an index at all,
  and "names player -1, but the payload lists only 12" would describe the fault wrongly and send the
  reader counting players.

## Versioning policy

- `CONTRACT_VERSION` is the contract's **major** version. Adding an optional field is **not** a
  version bump — an older decoder that has never heard of the field simply ignores it (the shape
  validators only look for fields they know about and rebuild the value field by field). Renaming
  or removing a field **is** a breaking change: bump `CONTRACT_VERSION` and ship both apps
  together.
- A decoder refuses a payload whose prefix version is higher than its own `CONTRACT_VERSION`,
  before attempting to decode the body — "made by a newer version of the stats app" rather than a
  confusing parse failure.
- `SCHEMA_VERSION` (in `src/store/persistence.ts`) and `CONTRACT_VERSION` (here) are **separate
  numbers with separate lifetimes**. `SCHEMA_VERSION` versions the file this app saves to its own
  `localStorage`; `CONTRACT_VERSION` versions the payload the two apps exchange by copy/paste.
  Bumping one never implies bumping the other.

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

**`SCHEMA_VERSION` stayed at 11.** This is the live demonstration of the **last bullet** of this
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
transport codec needs to be identical between the two apps.

```js
const CONTRACT_VERSION = 2;
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
 *  A v1 encoder must pass `1` explicitly; a v2 encoder never passes it. */
function encodePayload(kind, json, version = CONTRACT_VERSION) {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return `${PREFIX[kind]}${version}.${toBase64Url(bytes)}.${fnv1a32(bytes)}`;
}

// The two encoders a v2 sender calls.
function encodeDayRoster(payload) { return encodePayload('roster', payload); }
function encodeDayStats(payload) { return encodePayload('stats', payload); }

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
  // Not yet shape-validated. Dispatch on `parsed.v` next: 1 is a legacy payload to validate and
  // normalise into the day shape, 2 is a day payload. Anything else is `its version is not 1 or 2`.
  return { ok: true, value: parsed };
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
