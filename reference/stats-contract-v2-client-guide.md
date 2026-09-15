# Contract v2 — the Client implementation guide

A change brief for the engineer building the iPhone stats app (the "Client"). It covers everything
that moves between contract version 1 and contract version 2, and it is written to be implementable
on its own: every constant, every error string and every rule below is quoted from the shipped
module rather than summarised, because the two apps share no build step and this prose is the only
thing keeping them in step.

`docs/stats-contract.md` remains the reference for the format as it ends up — schemas, limits, the
full error catalogue, the versioning policy. Read this document to find out *what changed and why*;
read that one when you need the settled answer to "what is legal".

---

## 1. What changed, and why

The unit of exchange moves from **one game** to **a whole day**.

The team plays tournaments. On a Saturday the coach plans three or four games against three or four
opponents, all the same day, mostly the same girls. Under v1 that meant one roster email per game and
one pasted stats payload per game — and, worse, the Client had to be handed a new roster in between
games, in a gym, on a phone, while a match was starting.

Under v2 there is one roster out in the morning and one stats payload back at the end of the day:

- A **`CIQR2` roster payload** carries the day's date, the team, one shared **player directory** for
  the whole day, and a list of that day's **games** — each with its opponent and its own
  pre-selection of players.
- A **`CIQS2` stats payload** carries one recording timestamp, the same kind of player directory, and
  a list of **games**, each with its own sets.

Nothing about the transport changed. Same prefix-body-checksum shape, same Base64URL, same FNV-1a,
same whitespace stripping. Only the JSON inside the envelope is different — which is exactly why this
is a `CONTRACT_VERSION` bump and not a silent widening: fields moved and were renamed, so an old
decoder handed a new payload would not merely ignore something it had never heard of, it would be
wrong about the payload's identity.

---

## 2. v1 → v2, side by side

### Roster payload

| Field | v1 | v2 |
|---|---|---|
| `v` | `1` | `2` |
| `kind` | `"roster"` | `"roster"` — unchanged |
| `gameId` | top level, non-empty | **moved** into `games[].gameId` |
| `team` | top level, display-only | top level, unchanged |
| `opponent` | top level, display-only | **moved** into `games[].opponent` |
| `date` | top level, display-only (and, since 2026-09-15, non-empty at v1 too) | top level, and now **the identity of the payload** — non-empty |
| `players` | the game's roster, 1–12 | the **day's directory**, 1–24 (`MAX_DAY_PLAYERS`) |
| `games` | — | **new**, 1–8 entries (`MAX_GAMES_PER_DAY`) |
| `games[].gameId` | — | **new**, non-empty, unique within the payload |
| `games[].opponent` | — | **new**, a string; may be empty |
| `games[].roster` | — | **new**, **indices into the payload's own `players`** — 0–12 of them (`MAX_ROSTER_PLAYERS`), each a whole number in range, no duplicates. May be empty. |

Two things to read twice, because they are the two most likely to be implemented from memory of v1:

- **`gameId` is no longer a top-level field.** It lives once per game, inside `games[]`.
- **`games[].roster` is a list of numbers, not a list of ids.** `[0, 1]` means "the first and second
  entries of this payload's own `players` array". Section 4 explains why, with the measurements; do
  not substitute id strings back in.

### Stats payload

| Field | v1 | v2 |
|---|---|---|
| `v` | `1` | `2` |
| `kind` | `"stats"` | `"stats"` — unchanged |
| `gameId` | top level, non-empty | **moved** into `games[].gameId` |
| `recordedAt` | top level, ≤ 32 chars (and, since 2026-09-15, non-empty at v1 too) | top level, unchanged |
| `players` | the roster used, 1–12 (the lower bound newly enforced at v1 since 2026-09-15) | the **day's directory**, 1–24 (`MAX_DAY_PLAYERS`) — still `{ id, name }` objects, still reached **by id string** from the set lines |
| `sets` | top level, 1–5 | **moved** into `games[].sets`, 1–5 **per game** |
| `games` | — | **new**, 1–8 entries (`MAX_GAMES_PER_DAY`) |
| `games[].gameId` | — | **new**, non-empty, unique within the payload |
| `games[].sets` | — | **new**, the v1 `sets` array verbatim, one per game |
| `sets[].n`, `.score`, `.players[]` | unchanged | unchanged — including the shape of a stat line |
| `date` / `team` / `opponent` | never present | still never present |

The stats payload has no `date`, `team` or `opponent` on purpose. The planner matches each game on
`gameId` and already knows the rest; re-sending those facts would create a second source of truth for
things the planner owns.

**Set numbering is per game, not per day.** Each game starts again at set 1, so a day of three games
legitimately carries three set-1 lines. The ascending-and-unique rule applies *within* one game's
`sets`, and the 5-set cap is likewise per game.

---

## 3. The full v2 schemas

### Roster payload schema (contract v2) — `CIQR2`

| Field | Type | Rule |
|---|---|---|
| `v` | `2` | Must equal the version named in the prefix. |
| `kind` | `"roster"` | Fixed. |
| `date` | `string` | **Non-empty.** The day this payload is about — the identity of the payload, so a blank one is refused. |
| `team` | `string` | Display-only. **May be empty**: the Planner does not trim a team name, so a coach who never named her team has a blank one, and refusing it would refuse a real save. |
| `players` | array | The **day directory**: 1–24 entries (`MAX_DAY_PLAYERS`), unique ids. A day's directory spans every game of the day, so it is legitimately larger than any one game's tick-list. |
| `players[].id` | `string` | Matches `ID_PATTERN` — `/^[A-Za-z0-9_-]{1,64}$/`. |
| `players[].name` | `string` | Required, 1–64 characters (`MAX_NAME_LENGTH`). An empty name is malformed. |
| `players[].jersey` | `number` | Optional. If present it must be a number; the Planner's roster panel does not collect jerseys today, so it is usually absent. |
| `games` | array | 1–8 entries (`MAX_GAMES_PER_DAY`). At least one — a day with no games is not a day. |
| `games[].gameId` | `string` | Non-empty, and unique across the payload's games. Echoed back in the stats payload to match the game. |
| `games[].opponent` | `string` | Display-only. **May be empty**: a game against an unnamed opponent is a real thing a coach plans, and the Client only ever prints this string. |
| `games[].roster` | `number[]` | **Indices into this payload's own `players`**, not ids. 0–12 entries (`MAX_ROSTER_PLAYERS`). Each must be a whole number ≥ 0 and < `players.length`; no index may appear twice. **May be empty** — see section 5. |

### Stats payload schema (contract v2) — `CIQS2`

| Field | Type | Rule |
|---|---|---|
| `v` | `2` | Must equal the version named in the prefix. |
| `kind` | `"stats"` | Fixed. |
| `recordedAt` | `string` | **Non-empty** ISO timestamp from the Client's clock, at most 32 characters (`MAX_RECORDED_AT_LENGTH`). |
| `players` | array | The **day directory**: 1–24 `{ id, name }` entries (`MAX_DAY_PLAYERS`), unique ids — the same objects a roster directory carries, minus `jersey`. What differs is how a game reaches them: the set lines below name **id strings, not indices**. A Client-added player (id in the `cx-` namespace) arrives with a name and becomes a guest on import. No `jersey` — a stats sheet has no use for one, and the field is dropped on the way in. |
| `players[].id` | `string` | Matches `ID_PATTERN`. |
| `players[].name` | `string` | Required, 1–64 characters (`MAX_NAME_LENGTH`). |
| `games` | array | 1–8 entries (`MAX_GAMES_PER_DAY`). At least one. |
| `games[].gameId` | `string` | Non-empty, unique across the payload's games. Matched against a saved game's id on import. |
| `games[].sets` | array | 1–5 entries (`MAX_SETS`) **per game**, `n` ascending and unique **within this game**. A set the team did not play is simply omitted, not sent with empty stats. |
| `games[].sets[].n` | `number`, 1–5 | The set number, a whole number. Restarts at 1 in every game. |
| `games[].sets[].score` | `[number, number] \| null` | `[us, them]`, or `null` if not recorded. **The key is required** — encode it as `null`, never omit it. A Swift `Optional` written with `encodeIfPresent` drops the key, and an absent `score` is refused as `game "<gid>" set <n> has a malformed score`, which rejects the whole paste. Both entries must be **finite** — `NaN` and `±Infinity` are refused. They need not be integers. |
| `games[].sets[].players` | array | Stat lines for that set. Every `id` here must appear in the top-level `players`. A player with no line in a set is 0/0 there — not an error. No id may appear twice in one set. |
| `…players[].serve` / `.return` | `{ in: number; out: number }` | Both whole numbers, `0`–`999` (`MAX_COUNT`). **Totals are never transmitted** — both apps derive `in + out`. |

### Limits

| Constant | Value | Meaning |
|---|---|---|
| `CONTRACT_VERSION` | `2` | The contract's major version. |
| `MAX_GAMES_PER_DAY` | `8` | **New.** The most games one day payload may carry, in either kind. A tournament day is a handful of games; eight is generously above any real one, and bounds how much a single paste can push into saved state. It also lands almost exactly on what a `mailto:` roster can carry — see section 4. |
| `MAX_DAY_PLAYERS` | `24` | **New.** The most players one day payload's directory may name. Squads rotate across games and a tournament day can field two teams' worth of names. |
| `MAX_ROSTER_PLAYERS` | `12` | **Changed scope.** In v1 it bounded the whole payload's `players`. In v2 it bounds **one game's pre-selection** — `games[].roster` in a roster payload — which is what it was always about: the size of the tick-list the Client shows for a single game. It still bounds a **v1** payload's `players` on the legacy path. |
| `MAX_COUNT` | `999` | Unchanged. Largest legal serve/return count. |
| `MAX_NAME_LENGTH` | `64` | Unchanged. Longest legal `players[].name`, in both payloads. An empty name is malformed too. |
| `MAX_RECORDED_AT_LENGTH` | `32` | Unchanged. Longest legal `recordedAt`. |
| `MAX_SETS` | `5` | Unchanged in value; **now per game** rather than per payload. |

---

## 4. The shared player directory — and why the two payloads reference it differently

Both v2 payloads carry one `players` directory for the whole day. That is the saving: twelve girls
who play four games are listed once, not four times.

The roster payload then refers to that directory **by index**, and the stats payload refers to it
**by id string**. That asymmetry is deliberate, it is the single thing most likely to be "simplified"
by a reader who has not seen the numbers, and the numbers are these.

This app's player ids are **24–25 characters** — `generateId` builds them as
`` `${prefix}-${Date.now().toString(36)}-${counter}-${6 random}` `` with the full word `player` as
the prefix, so a real one looks like `player-mu2strf8-7-a8c3d9`; the counter is session-global, so it
takes a second digit past the ninth id. Game ids are 22–23 the same way.
Re-listing twelve of those per game is by far the roster payload's largest cost, and the roster
travels as a `mailto:` URL body, which several mail clients cut off somewhere near 2000 characters
— the practical figure the Planner works to is about 2048, and the "over" marks below are against
that.

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

Read the second row first. **Id strings break the ceiling at two games** — the most ordinary
tournament day there is, and the one every coach has. Not an edge case, not a big day: two. There is
no version of the roster payload built from id strings that survives an ordinary Saturday, which is
why the indices are not an optimisation to be weighed but the reason the roster payload can exist at
all.

Three further things the table settles:

- **Each additional game costs 132 characters** with the index encoding, against roughly 535 with id
  strings. That is the whole difference: one grows a day at a time, the other grows a squad at a
  time.
- **`MAX_GAMES_PER_DAY` = 8 sits exactly at the medium's limit.** A full eight-game day with a
  12-player squad composes to 2122 — just over. The cap and the transport genuinely agree rather than
  the cap being a round number someone picked: the schema stops permitting days at almost precisely
  the point the email stops carrying them. The absolute worst case the schema permits — 8 games
  against the full 24-player directory — is **3313**, so the ceiling is real at the extreme and the
  caps are what keep it out of reach.
- **The 1900 warning threshold fires at seven games** with a full squad (1990). In other words it
  only speaks up in the region the caps already call extreme, which is what a warning should do.

The stats payload keeps id strings for the opposite reason, and it is worth understanding rather than
copying:

- It travels **by clipboard into a textarea**, not through a URL, so it has no length limit to
  respect. A full tournament day sheet — 3 games × 3 sets × 12 players — encodes to roughly **13 KB**,
  which the clipboard carries without complaint and no `mailto:` URL could survive.
- An **off-by-one index in a stats payload would be undetectable**. It would silently attribute one
  player's serves to another and every validator on both sides would pass it, because an in-range
  index is always a legal index. A wrong *id*, by contrast, is caught: the Planner's importer refuses
  a stats payload naming a player it does not know and the stats app could not have created, rather
  than guessing.

So: indices where the cost is real and the failure is loud, id strings where the cost is nil and the
failure would be silent.

---

## 5. Three rules about `games[].roster`

These are prose rules, not shape rules — no validator can enforce them, and getting them wrong
produces a legal payload that behaves badly in the gym.

**1. It is a pre-selection, not a whitelist.** The tick-list the Client shows for any game of the day
must list **the whole day directory**, with that game's `roster` entries pre-ticked. It must not hide
the players a game did not name. A coach who ends up playing an unplanned fourth game, or who needs a
girl the morning's plan did not include, has to be able to tick her straight from the list she is
already looking at. If the Client treated `roster` as a whitelist she could not, and her only way
forward would be to add that girl again as a new player — minting a `cx-` duplicate of somebody
already sitting in the directory under her real id, whose stats would then import as a stranger.

**2. An empty `roster` is legal.** `games[].roster: []` is a valid game and must not be refused or
treated as an error state. A coach can legitimately send the day's roster before she has picked who
plays the third game; refusing an empty pre-selection would make her choose between sending early and
sending at all. Show the full directory with nothing ticked.

**3. `cx-` is only for someone not in the day directory at all.** The Client-created id namespace
(`CLIENT_ID_PATTERN`, `/^cx-[A-Za-z0-9_-]{4,32}$/`) exists for a player the Planner has never heard
of — a sub who turned up on the day. It is never the right answer for somebody who is in `players`
but not in this game's `roster`. That distinction is entirely the Client's to get right, because by
the time the payload reaches the Planner a `cx-` id is indistinguishable from a genuine new guest.

---

## 6. Client change checklist

- [ ] **Hold a day of games**, not a single game. One roster load populates the whole day.
- [ ] **Let the coach switch game between sets without reloading a roster.** This is the point of the
      change: she finishes game 1, taps across to game 2, and keeps recording. No paste, no email, no
      leaving the app.
- [ ] **Emit one `CIQS2` covering the day** — every game she recorded, each with its own sets,
      numbered from 1.
- [ ] **Accept `CIQR2`** and, on the legacy path, still accept `CIQR1` (see section 9).
- [ ] **Show the whole directory on every game's tick-list**, pre-ticked from that game's `roster`.
- [ ] **Never use `mailto:` for stats.** A 3-game, 3-set, 12-player day sheet is roughly **13 KB** —
      about six times the ceiling a `mailto:` URL can be relied on to carry. Stats go to the
      clipboard and nowhere else. (The roster, which the Planner sends the other way, is the only
      payload in this contract that travels by `mailto:` at all.)
- [ ] **Copy the reference codec below verbatim**, including both kind-aware messages. The whole
      reason the codec is one file with no imports is that both apps run the same logic; a reworded
      message is a defect, not a style choice.

---

## 7. The reference codec (plain JS, contract v2)

The same transport codec `docs/stats-contract.md` now carries, with the version dispatch and the two
normalisers alongside it. Shape validation itself is omitted: only the transport codec has to be
byte-identical between the two apps, and the schemas in section 3 and the catalogue in section 10
are what you validate against.

Copy it whole. The comments explain the choices that look arbitrary and are not.

```js
const CONTRACT_VERSION = 2;
const PREFIX = { roster: 'CIQR', stats: 'CIQS' };

/** Coach-readable name for each kind, used in the kind-mismatch error. */
const KIND_LABEL = { roster: 'roster payload', stats: 'stats payload' };

/** Which app authors each kind. A roster is made by the Rotation Planner and a stats sheet by the
 *  stats app, so naming the stats app for both — which this file used to do — tells a coach on the
 *  Client side to go and re-copy from, or update, the wrong app. The kind alone decides it, so the
 *  one file both apps run verbatim produces the right words on each side. */
const AUTHOR_LABEL = { roster: 'the Rotation Planner', stats: 'the stats app' };

/** The one message for every way the body can fail to be trustworthy JSON. `expected`, not the
 *  decoded kind: on a payload this corrupt the prefix may be the only thing worth trusting, and the
 *  caller has already said which app it believes it is reading. */
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
  for (const b of bytes) bin += String.fromCharCode(b); // a loop, not spread: spread overflows on big inputs
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

/** `version` exists because the prefix version and the body's own `v` must agree — `decodePayload`
 *  cross-checks them and calls any disagreement corruption. Now that `CONTRACT_VERSION` is 2, a v1
 *  body encoded with the default would go out as `CIQS2.` wrapped around `"v":1` and be refused by
 *  this very module. So a v1 encoder passes `1` explicitly; a v2 encoder never passes it at all. */
function encodePayload(kind, json, version = CONTRACT_VERSION) {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return `${PREFIX[kind]}${version}.${toBase64Url(bytes)}.${fnv1a32(bytes)}`;
}

// The two encoders a v2 Client actually calls.
function encodeDayRoster(payload) { return encodePayload('roster', payload); }
function encodeDayStats(payload) { return encodePayload('stats', payload); }

// The two legacy encoders, if you keep them. The explicit `1` is not decoration — see above.
function encodeRoster(payload) { return encodePayload('roster', payload, 1); }
function encodeStats(payload) { return encodePayload('stats', payload, 1); }

function decodePayload(text, expected) {
  // 1. Strip all whitespace: a mail client line-wraps and may indent continuation lines.
  const compact = text.replace(/\s+/g, '');

  // 2. Read the kind and version from the head, and check both *before* the checksum — those two
  //    facts are visible without trusting the body at all, so they are reported even on a payload
  //    that is otherwise corrupt.
  const head = /^(CIQ[RS])(\d+)\./.exec(compact);
  if (head === null) {
    return { ok: false, error: 'This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.' };
  }
  const kind = head[1] === 'CIQR' ? 'roster' : 'stats';
  if (kind !== expected) {
    return { ok: false, error: `This is a ${KIND_LABEL[kind]}, not a ${KIND_LABEL[expected]}.` };
  }
  const version = Number(head[2]);
  if (version > CONTRACT_VERSION) {
    return {
      ok: false,
      error: `This payload was made by a newer version of ${AUTHOR_LABEL[expected]} (contract ${version}); this app understands ${CONTRACT_VERSION}.`,
    };
  }

  // 3. Full-pattern match. A payload truncated mid-field fails here.
  const m = /^(CIQ[RS])(\d+)\.([A-Za-z0-9_-]*)\.([0-9a-f]{8})$/.exec(compact);
  if (m === null) return { ok: false, error: corrupt(expected) };

  // 4-5. Base64URL-decode, then verify the checksum over the *decoded bytes*, not the text.
  const bytes = fromBase64Url(m[3]);
  if (bytes === null || fnv1a32(bytes) !== m[4]) return { ok: false, error: corrupt(expected) };

  // 6. UTF-8 decode and parse. A parse failure is corruption, not a JSON error a coach can act on.
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, error: corrupt(expected) };
  }

  // 7. The body's own `v`/`kind` must agree with what the prefix already promised. `Array.isArray`
  //    is part of the test: `typeof [] === 'object'`, and an array is not a payload.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || parsed.v !== version || parsed.kind !== kind) {
    return { ok: false, error: corrupt(expected) };
  }

  // 8. The parsed, but not yet shape-validated, JSON value.
  return { ok: true, value: parsed };
}

/**
 * The two decoders a v2 Client calls. They always hand back a **day** payload, whichever version
 * arrived, so nothing downstream branches on `v`. Dispatching on the body's own `v` is safe: step 7
 * has already proved it equals the prefix version the transport layer vouched for.
 *
 * `validateDayRosterPayload` / `validateRosterPayload` (and their stats twins) are the section 3
 * schemas, and `normaliseRosterV1` / `normaliseStatsV1` lift a validated v1 payload into the day
 * shape. The normalisers must be **total** — every payload the v1 validator accepts has to produce
 * one the v2 validator accepts — or a payload you have already previewed to the coach gets refused
 * halfway through the import. Section 10's note on the two 2026-09-15 tightenings is what closed
 * the last two holes in that property on this side; close them on yours too.
 */
function decodeDayRoster(text) {
  const decoded = decodePayload(text, 'roster');
  if (!decoded.ok) return decoded;
  if (decoded.value.v === 1) {
    const v1 = validateRosterPayload(decoded.value);
    return v1.ok ? { ok: true, value: normaliseRosterV1(v1.value) } : v1;
  }
  if (decoded.value.v === 2) return validateDayRosterPayload(decoded.value);
  return { ok: false, error: 'The roster payload is malformed: its version is not 1 or 2.' };
}

function decodeDayStats(text) {
  const decoded = decodePayload(text, 'stats');
  if (!decoded.ok) return decoded;
  if (decoded.value.v === 1) {
    const v1 = validateStatsPayload(decoded.value);
    return v1.ok ? { ok: true, value: normaliseStatsV1(v1.value) } : v1;
  }
  if (decoded.value.v === 2) return validateDayStatsPayload(decoded.value);
  return { ok: false, error: 'The stats payload is malformed: its version is not 1 or 2.' };
}

/** A v1 roster is a one-game day whose directory is that game's players, so every index `0..n-1`
 *  is on its tick-list. v1's own 12-player cap lands exactly on `MAX_ROSTER_PLAYERS` as the v2
 *  per-game cap, so even a full v1 roster normalises to the boundary rather than past it. */
function normaliseRosterV1(p) {
  return {
    v: 2, kind: 'roster', date: p.date, team: p.team, players: p.players,
    games: [{ gameId: p.gameId, opponent: p.opponent, roster: p.players.map((_, i) => i) }],
  };
}

function normaliseStatsV1(p) {
  return {
    v: 2, kind: 'stats', recordedAt: p.recordedAt, players: p.players,
    games: [{ gameId: p.gameId, sets: p.sets }],
  };
}
```

Two notes on the code above:

- **`String.fromCharCode` in a loop, not spread.** `String.fromCharCode(...bytes)` overflows the call
  stack on a payload of a few thousand bytes. That comment was written when "a few thousand bytes"
  described the worst case; under v2 it understates reality by an order of magnitude, because a full
  day sheet reaches roughly 13 KB. The loop is now not a precaution but a requirement.
- **`'This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.'`
  names the stats app for both kinds**, unlike the two kind-aware messages above it in the codec
  (and catalogued in §10). That is the shipped wording; copy it exactly. It is the one message
  emitted before the kind is known at all — there is no `CIQ[RS]` head to read, so there is nothing
  to key an author label off.

---

## 8. Golden vectors — a two-game day

Fixed input → fixed encoded output, generated by running the real encoders. Check your codec against
these; the Planner's own test suite asserts the same strings.

These strings are byte-exact only when the JSON is emitted with its fields in the order shown in the
payload below and with no whitespace — `JSON.stringify` on an object literal built in that order,
which is what both apps do. Key order is **not** part of the contract: a payload whose fields come in
another order is perfectly valid and decodes fine, it simply will not equal the vector. So a Client
checking itself against these should either compare the *decoded* object, or emit its keys in the
documented order before comparing the strings.

### Roster vector (v2)

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

Note what this vector exercises deliberately: a second game, and a `roster` that is **not** simply
every player — `game-2` names index `1` only. A Client that ignores the indices and ticks everybody
still decodes this vector correctly and is still wrong.

### Stats vector (v2)

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

This one exercises the thing most likely to be got wrong on the stats side: `game-2`'s sets **start
again at `n: 1`**. Set numbers are scoped to a game, never to a day.

The v1 vectors in `docs/stats-contract.md` are retained and still decode — they are frozen, and
nothing either app does to the codec may change them.

---

## 9. Compatibility, from the Client's side

| | Roster (Planner → Client) | Stats (Client → Planner) |
|---|---|---|
| Planner **emits** | `CIQR2` only | — |
| Planner **accepts** | — | `CIQS1` **and** `CIQS2` |
| Client **should emit** | — | `CIQS2` |
| Client **must accept** | `CIQR2`, and `CIQR1` for old emails | — |

The Planner accepts both stats versions, and normalises a v1 payload into the day shape on the way
in — a v1 sheet is read as a one-game day. So an un-updated Client keeps working for single-game
days, and nobody loses data during a staggered rollout of the *stats* direction.

**The roster direction has no such grace.** A Client still on contract 1 handed a `CIQR2` roster will
refuse it with:

```
This payload was made by a newer version of the stats app (contract 2); this app understands 1.
```

Note which app that names. `AUTHOR_LABEL` arrived **with contract 2**, so the contract-1 module you
are running today says "the stats app" for every kind, including a roster — it points the coach at
the wrong app, and there is nothing to be done about it from this side, because the build that would
say otherwise is the one this refusal proves she has not got. The v2 module you are about to copy in
says "the Rotation Planner" for a roster and "the stats app" for a stats sheet (§10 lists all four
variants), so the mislabelling ends the moment the Client is updated — which is the same moment the
refusal stops happening.

That is the designed behaviour, not a bug to work around — a v1 decoder handed a v2 body would find
no top-level `gameId` and no `opponent`, and guessing would be worse than refusing. **The fix is to
ship both apps together.** There is no version of this rollout where the Planner goes out first and
the old Client keeps working.

Note also that a v1 roster normalises cleanly: a v1 roster is a one-game day whose directory is that
game's players, so every index `0..n-1` is on its tick-list. v1's own 12-player cap lands exactly on
`MAX_ROSTER_PLAYERS` as the v2 per-game cap, so even a full v1 roster normalises to the boundary
rather than past it.

---

## 10. Error catalogue — the v2 additions, verbatim

Every string below is produced verbatim by the shipped module, so both apps say the same words for
the same fault. `<n>`, `<id>` (a player id) and `<gid>` (a game id) mark values interpolated at the
point of failure.

### Transport (`decodePayload`) — two messages now have two variants each

The author label is keyed on the **kind being read**, because a roster is authored by the Rotation
Planner and a stats payload by the stats app. One verbatim-copied file therefore has to produce
different words depending on which side is running it — which is the whole reason the label is a
lookup rather than a literal.

- `This payload was made by a newer version of the Rotation Planner (contract <n>); this app understands 2.`
- `This payload was made by a newer version of the stats app (contract <n>); this app understands 2.`
- `This payload is corrupted or incomplete — copy it again from the Rotation Planner.`
- `This payload is corrupted or incomplete — copy it again from the stats app.`

The other two transport messages are unchanged and have one form each:

- `This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.`
- `This is a roster payload, not a stats payload.` (and the reverse)

### Shape — `validateDayRosterPayload`

All of the form `The roster payload is malformed: <detail>.`

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

### Shape — `validateDayStatsPayload`

All of the form `The stats payload is malformed: <detail>.`

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

Three wording traps, all of them real in the shipped module and none of them worth "tidying":

- The **day** directory over-cap says `the day limit is 24`; the **per-game** over-cap says
  `the limit is 12`. Different phrases, different limits, both deliberate.
- The roster payload says `it names <n> games; the limit is 8`; the stats payload says
  `it records more than 8 games`. A roster *names* games it plans; a sheet *records* games it
  happened.
- The v1 validators still say `its version is not 1`, while the v2 validators and both day decoders
  say `its version is not 1 or 2` — the latter names both versions this app reads, because a coach
  who pasted the wrong thing needs to know what is acceptable, not which branch refused her.

The **v1 catalogue is still live** — `docs/stats-contract.md` keeps its wording verbatim, because
the v1 validators still exist on the normalisation path and still emit those strings. Two v1 rules
did tighten on 2026-09-15, and both are described there under their own dated entries:

- `date` (roster) and `recordedAt` (stats) must now be **non-empty** at v1 as well as v2. The
  message is unchanged — `it has no date`, `it has no recorded time` — because a non-string and an
  empty string are the same fault: neither is a date, and there is nothing to print for either.
- A v1 stats payload with an empty `players` is now refused with `it names no players`. That string
  is not new wording; it was in the roster catalogue and absent from the stats one, so the two
  published catalogues genuinely disagreed about whether a stats payload could name nobody. It
  cannot, in either version, in either kind.

Both are tightenings, not widenings, and neither is a further version bump. If your v1 code path is
still live, match them — otherwise a payload this app refuses is one your Client would happily
build.

---

## 11. What has **not** changed

Nothing in this list needs a line of Client work; it is here so you do not go looking.

- **The encoded form.** `<CIQR|CIQS><version>.<base64url of UTF-8 JSON>.<8 hex chars>`, two literal
  dots, three fields.
- **`fnv1a32`.** Same constants (`0x811c9dc5`, `0x01000193`), same `Math.imul`, same 8 lowercase hex
  characters, still computed over the **UTF-8 bytes**, never over the Base64URL text. Reference
  values: `fnv1a32([])` = `811c9dc5`; `fnv1a32(utf8("a"))` = `e40c292c`.
- **Base64URL.** `+` → `-`, `/` → `_`, trailing `=` stripped; reversed on the way back with padding
  re-added to a multiple of 4.
- **Whitespace stripping** as the very first step of decoding, so a mail client's line wrapping and
  quote indentation are always harmless.
- **The decode order**: kind and version from the prefix first, checksum after, JSON last, then the
  body's own `v`/`kind` cross-checked against the prefix.
- **The `cx-` namespace** for Client-created players: `CLIENT_ID_PATTERN`,
  `/^cx-[A-Za-z0-9_-]{4,32}$/`, and `ID_PATTERN` `/^[A-Za-z0-9_-]{1,64}$/` for every id.
- **`MAX_COUNT` = 999**, **`MAX_NAME_LENGTH` = 64**, **`MAX_RECORDED_AT_LENGTH` = 32**.
- **The 5-set cap** (`MAX_SETS`) — now counted per game, but the number and the rules around it
  (ascending, unique, omit a set that was not played) are the same.
- **Stat lines.** `{ id, serve: { in, out }, return: { in, out } }`, whole numbers 0–999, and totals
  are still never transmitted — both apps derive `in + out`.
