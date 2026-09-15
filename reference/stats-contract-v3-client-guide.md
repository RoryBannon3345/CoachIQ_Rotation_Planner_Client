# Contract v3 — the Client implementation guide

A change brief for the engineer building the iPhone stats app (the "Client"). It covers everything
that moves between contract version 2 and contract version 3, and it is written to be implementable
on its own: every constant, every error string and every rule below is quoted from the shipped
module rather than summarised, because the two apps share no build step and this prose is the only
thing keeping them in step.

`docs/stats-contract.md` remains the reference for the format as it ends up — schemas, limits, the
full error catalogue, the versioning policy. Read this document to find out *what changed and why*;
read that one when you need the settled answer to "what is legal". This guide assumes you have
already implemented the v2 day-payload contract (`docs/stats-contract-v2-client-guide.md`) — a
single roster load for a whole tournament day, one stats paste covering every game. v3 does not
touch that shape. It touches one field.

---

## 1. What changed, and why — read this before anything else

**The stats payload has not changed.** Say that twice, because a major version bump makes the
opposite assumption look reasonable and it is wrong here. Every stat line, every score, every
`recordedAt` rule from v2 is untouched at v3 — only the version digit moved. Your stats-sending
code needs **no changes** to keep working, and in fact does not strictly need to change at all: the
Planner's stats validator accepts a body whose `v` is `2` **or** `3`, with no plan to stop, because
stats flow Client → Planner only — an older Client sending `v: 2` can never break anything on the
Planner's side. You can ship the roster-side change in this guide on its own schedule and your
existing stats paste keeps working before, during and after.

**The roster payload changed in exactly one field.** Under v2, each game in the day carried
`games[].roster`: one flat list of directory indices, naming everyone who played *somewhere* in
that game, with no way to say which set. Under v3, `games[].roster` is gone, replaced by
`games[].sets`: one integer **bitmask** per set. Bit `i` of a mask means the player at this
payload's `players[i]` is in that set. `sets` is **positional** — `sets[0]` is set 1, `sets[1]` is
set 2, and so on — and `sets.length` is how many sets the game has.

That single field replacement is doing two jobs at once: it says **who** is in each set, which v2
could not express at all, and it says **how many sets** the game has, which your Client has so far
had to assume was always three. Section 5 below is why that second part matters more than it looks.

**The prefix is now `CIQR3.`.** A v3 roster payload will simply not decode in a Client still running
the v2 module — `decodePayload` refuses any prefix version above its own `CONTRACT_VERSION`, before
it even looks at the body, with `This payload was made by a newer version of the Rotation Planner
(contract 3); this app understands 2.` That is deliberate, not a bug to route around: a v2 decoder
handed a v3 body would find no top-level `roster` array on any game and would have to guess, and
guessing wrong here means silently pre-ticking the wrong girls. Ship the Client update before (or
together with) the day you start sending `CIQR3.` roster emails.

---

## 2. v2 → v3, side by side

### Roster payload

| Field | v2 | v3 |
|---|---|---|
| `v` | `2` | `3` |
| `kind` | `"roster"` | `"roster"` — unchanged |
| `date`, `team`, `players` | top level, day-scoped | unchanged |
| `games[].gameId`, `games[].opponent` | unchanged | unchanged |
| `games[].roster` | `number[]` — indices into `players`, the **union** of everyone in the game, 0–12 entries | **gone** |
| `games[].sets` | — | **new**, `number[]` — one bitmask per set, 1–5 entries (`MAX_SETS`), positional. Bit `i` set means `players[i]` is in that set. |

Two things worth reading twice:

- **`roster` did not become `sets` by renaming — it changed shape.** A v2 `roster` was one array
  naming the union of a game's players; a v3 `sets` is *several* numbers, one per set, each a
  bitmask rather than an index list. There is no field-for-field rename here to lean on.
- **The union rule survives, just recomputed.** `MAX_ROSTER_PLAYERS` (12) still bounds "how many
  different players may this game name across all its sets" — the tick-list size is unchanged, only
  now it is the union of the bits set across `sets` rather than the length of one array. Section 3
  has the exact check.

### Stats payload

No changes. `games[].sets[].n/.score/.players` are byte-identical to v2. The only difference you
may ever see is the version digit — a Client that has moved to `CIQS3.` and one still sending
`CIQS2.` produce a body with the same shape, differing only in `"v":2` vs `"v":3`, and the Planner
accepts both. You do not need to change your encoder to move to `v: 3`; if you never do, nothing
breaks.

---

## 3. The `games[].sets` field, in full

| Field | Type | Rule |
|---|---|---|
| `games[].sets` | `number[]` | 1–5 entries (`MAX_SETS`), **one bitmask per set, positional** — `sets[0]` is set 1, `sets[1]` is set 2, and `sets.length` **is** how many sets this game has. Each entry is a whole number, `0 ≤ mask < 2 ** players.length`. A set nobody has been picked for yet is `0` — legal on purpose (section 6). The **union** of bits set across all of a game's masks may name at most 12 players (`MAX_ROSTER_PLAYERS`) — the same cap v2 applied to the whole `roster` array, because in v2 that array *was* the union. |

If a game names more players across its sets than the 12-player cap allows, the whole roster
payload is refused — not just that game — with `game "<gid>" names <n> players; the limit is 12`.
That refusal reaches you as a roster email that never decodes; there is nothing to catch or work
around on the Client side, only something to know so you are not surprised by it.

The full field-by-field schema (`date`, `team`, `players`, `games[].gameId`/`.opponent`, all the
caps) is unchanged from v2 apart from this one field — see `docs/stats-contract.md`'s "Roster
payload schema (contract v3)" for the complete table if you want it in one place.

---

## 4. How to read a mask

Copy these two functions verbatim. They are the same functions the Planner uses internally
(`maskHas`/`maskMembers` in `statsContract.ts`), quoted here exactly:

```js
// Bit i of a mask means players[i] is in that set.
function maskHas(mask, index) {
  return Math.floor(mask / 2 ** index) % 2 === 1;
}

function maskMembers(mask, size) {
  const members = [];
  for (let i = 0; i < size; i += 1) if (maskHas(mask, i)) members.push(i);
  return members;
}
```

**Do not read a mask with `|` or `&`, and do not "simplify" these back into bitwise operators.**
JavaScript's bitwise operators coerce their operands to *signed 32-bit integers* — `2 ** 31 | 0` is
`-2147483648`, not a large positive number. `maskHas`'s division-and-modulo form stays correct up to
`2 ** 53`, so it keeps working even if the day directory's cap (`MAX_DAY_PLAYERS`, currently 24)
were ever raised. At 24 players the highest possible bit is `2 ** 23`, comfortably inside signed
32-bit range, so a bitwise version would happen to work today — which is exactly what makes it a
trap: it produces no error, no crash, nothing that shows up in testing. It produces a tick-list with
the wrong girls checked, and nobody finds out until a coach notices in the gym. Use the arithmetic
form even though the bitwise one looks like it would pass every test you are likely to write against
it now.

(The same file also exports `maskOf` and `maskCount`, which build and count masks. You will not need
either — the roster travels Planner → Client only, so you only ever read masks, never construct
them.)

---

## 5. `sets.length` is the set count, and it is authoritative

Build exactly as many set tabs as `sets.length` says, for every game, every time. Do not hardcode
three.

This is the change that actually matters to a coach, not just to your code. A team can play 1 to 5
sets in a game (`MAX_SETS` = 5), and the Planner has been able to *record* up to five sets' worth of
stats on its own side for a while — the gap has always been that your Client had no way to *learn*
a game needed more than three tabs, because the v2 roster never said. A coach who planned a 4- or
5-set game got a Client that showed three tabs regardless, and everything she recorded past set 3
had nowhere to go. It was not rejected or dropped loudly; it simply had no tab to be entered into.
`sets.length` closes that gap completely — it is now the one and only source of truth for how many
sets a game has, per game, because different games in the same day can legitimately have different
set counts.

---

## 6. The per-set tick-list

For **each set** of a game, show the coach the **whole day directory** — every player in `players`,
not just the ones in that set's mask — with that set's bits pre-ticked. This is the same
"pre-selection, not a whitelist" rule your v2 Client already implements for `roster`; it now applies
once per set instead of once per game.

A coach must still be able to tick someone the morning's plan did not include, on a per-set basis: a
sub who only comes on for set 3, or a girl who wasn't picked for set 1 but ends up playing it anyway.
If you hide players outside a set's mask, the coach's only way to add her is to create a new player,
minting a `cx-` id for somebody who is already sitting in the directory under her real id — and her
stats then import as a stranger rather than attaching to the player the Planner already knows.

A mask of `0` is a legal, ordinary state, not an error: it means the coach sent the day's roster
before deciding who plays that particular set. Show the full directory with nothing ticked. Do not
refuse it, and do not treat an all-zero mask as "this set doesn't exist" — `sets.length` already told
you it exists; the mask only says nobody is pre-picked for it yet.

---

## 7. Legacy roster emails — `CIQR1.` and `CIQR2.`

An updated, v3-reading Client must still be able to open an old roster email. Both `CIQR1.` and
`CIQR2.` payloads still decode — the Planner normalises them on the way in — but neither carries any
set structure at all, so both normalise to **a single set holding the game's whole roster**. If a
`CIQR2.` game named four players in its `roster` array, your Client should show **one set tab**, with
those four players pre-ticked, not three (and not zero).

This is a deliberate, lossy normalisation, not a bug to patch around: inventing three sets because
three used to be the usual number would put a fabricated set count in front of a coach and present it
as data the Planner sent her, when it did not. If she wants real per-set membership, the fix is not
on your side — she re-sends the roster from the Planner, which will go out as `CIQR3.` with real
per-set masks.

---

## 8. A worked example — a two-game day

This is a golden vector — fixed input, fixed encoded output, generated by running the real encoder —
pasted verbatim alongside its decoded JSON. The Planner's own test suite asserts the same string, so
check your own decoder against it: same input bytes in, same encoded string out (or, if you are only
decoding, same decoded object out).

Decoded payload:

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

### Walking through `game-1`'s `sets: [3, 1, 2]`

The directory has two players: `grace` at index 0, `zoie` at index 1. `game-1` has three sets
(`sets.length` is 3), so build three tabs, and apply `maskHas` to each mask in turn:

- **Set 1, mask `3`.** `3` in binary is `11` — bit 0 and bit 1 both set. `maskHas(3, 0)` is `true`
  (Grace) and `maskHas(3, 1)` is `true` (Zoë). Both players ticked.
- **Set 2, mask `1`.** `1` in binary is `01` — only bit 0. `maskHas(1, 0)` is `true`, `maskHas(1, 1)`
  is `false`. Only Grace ticked.
- **Set 3, mask `2`.** `2` in binary is `10` — only bit 1. `maskHas(2, 0)` is `false`, `maskHas(2, 1)`
  is `true`. Only Zoë ticked.

So `game-1` is: both girls in set 1, Grace alone in set 2, Zoë alone in set 3 — three different
tick-lists from three plain integers.

`game-2`'s `sets: [2, 0]` is two sets: mask `2` again means "Zoë only" for set 1, and mask `0` means
nobody is pre-ticked for set 2 — a coach who sent the day's roster before deciding who plays that
game's second set. Show the whole two-player directory for set 2, with nothing checked; do not treat
the `0` as an error or as "this set doesn't exist" — `sets.length` (2) already told you it exists.

---

## 9. Client change checklist

- [ ] **Stop reading `games[].roster`.** It no longer exists at v3. Read `games[].sets` instead.
- [ ] **Build `sets.length` tabs per game, not three.** Different games in the same day may have
      different set counts.
- [ ] **Read every mask with `maskHas`/`maskMembers` (arithmetic), never `|` or `&`.** Copy the two
      functions in section 4 verbatim.
- [ ] **Show the whole day directory on every set's tick-list**, pre-ticked from that set's own
      mask — not the game's union, and not the previous set's ticks carried over.
- [ ] **Treat a mask of `0` as "nothing pre-ticked", never as an error or a missing set.**
- [ ] **Normalise `CIQR1.`/`CIQR2.` roster emails to one set per game**, holding that game's whole
      legacy roster, exactly as the Planner's own `normaliseRosterV2` does.
- [ ] **No changes required to your stats encoder.** `CIQS2.` keeps working indefinitely; move to
      `CIQS3.` only if and when you want to, and only the version digit will differ.
- [ ] **Accept `CIQR3.`**, and continue to accept `CIQR2.` and `CIQR1.` for old emails still sitting
      in a coach's inbox (section 7).

---

## 10. Compatibility, from the Client's side

| | Roster (Planner → Client) | Stats (Client → Planner) |
|---|---|---|
| Planner **emits** | `CIQR3` only | — |
| Planner **accepts** | — | `CIQS2` **and** `CIQS3` |
| Client **should emit** | — | either; no change required |
| Client **must accept** | `CIQR3`, and `CIQR2`/`CIQR1` for old emails | — |

The roster direction has no grace period, the same as the v1 → v2 jump before it: a Client still
running the v2 module, handed a `CIQR3.` roster, refuses it outright with the "made by a newer
version" message from section 1. There is no rollout order where the Planner starts sending
`CIQR3.` before the Client can read it. Ship the Client update first, or at worst the same day.

The stats direction has no such constraint in either direction, which is exactly the reassurance
section 1 opens with: an un-updated Client's `CIQS2.` paste keeps importing on the Planner
indefinitely, because the Planner's stats validator was written to accept `v: 2` or `v: 3` bodies of
the identical shape.

---

## 11. Error catalogue — the v3 roster additions, verbatim

Every string below is produced verbatim by the shipped module. `<n>` and `<gid>` mark values
interpolated at the point of failure. All are of the form
`The roster payload is malformed: <detail>.`

New at v3, replacing the v2 per-game `roster` errors:

- `game "<gid>" set <n> is not a legal roster mask` — the value at that position is not a whole
  number ≥ 0 (or is too large to be represented exactly as one). It is not "a mask that's wrong", it
  is not a mask at all.
- `game "<gid>" set <n> names a player outside the directory` — the value *is* a legal integer, but
  it sets a bit at or beyond `players.length`. `5` over a 2-player directory is a perfectly good
  32-bit integer, just not one that payload's `players` array can support.
- `game "<gid>" names <n> players; the limit is 12` — unchanged wording and unchanged limit from v2,
  now measured as the union of bits set across the game's `sets` rather than the length of a
  `roster` array.

Also changed: the version-mismatch message now names all three versions the Planner reads —
`its version is not 1, 2 or 3` — where a v2-only build said `its version is not 1 or 2`. A coach who
pasted something unreadable needs to know what *is* acceptable, not which specific check refused
her.

Everything else in the roster catalogue (date/team/player/game-id/opponent checks) is byte-identical
to v2. The stats catalogue is entirely unchanged. The full, current catalogue for both payloads lives
in `docs/stats-contract.md`'s "Error catalogue" section — this list is only the delta.

---

## 12. What has **not** changed

Nothing in this list needs a line of Client work; it is here so you do not go looking.

- **The stats payload**, in every field, every rule, every error string. Only its version digit may
  now read `3` instead of `2`, and the Planner accepts both.
- **The encoded form.** `<CIQR|CIQS><version>.<base64url of UTF-8 JSON>.<8 hex chars>`, two literal
  dots, three fields.
- **`fnv1a32`, Base64URL, whitespace stripping, the decode order.** Identical to v2 — kind and
  version read from the prefix first, checksum after, JSON last, then the body's own `v`/`kind`
  cross-checked against the prefix.
- **`date`, `team`, `games[].gameId`, `games[].opponent`** on the roster payload, and every limit
  around them.
- **`MAX_GAMES_PER_DAY` (8), `MAX_DAY_PLAYERS` (24), `MAX_ROSTER_PLAYERS` (12), `MAX_SETS` (5),
  `MAX_COUNT` (999), `MAX_NAME_LENGTH` (64), `MAX_RECORDED_AT_LENGTH` (32).** None of these numbers
  moved.
- **The `cx-` namespace** for Client-created players: `CLIENT_ID_PATTERN`,
  `/^cx-[A-Za-z0-9_-]{4,32}$/`, and `ID_PATTERN` `/^[A-Za-z0-9_-]{1,64}$/` for every id — unchanged,
  and the rule that `cx-` is only for a player not in the day directory at all is unchanged too, just
  now scoped per set rather than per game (section 6).
- **Stat lines.** `{ id, serve: { in, out }, return: { in, out } }`, whole numbers 0–999, totals
  still never transmitted.
