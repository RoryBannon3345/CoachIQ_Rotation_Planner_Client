# The stats contract

The copy/paste payload format shared between CoachIQ Rotation Planner (this app) and the
separate iPhone stats app (the "Client"). Both apps implement the same codec independently —
this document is the shared source of truth, including test vectors either implementation can be
checked against.

## Purpose

The coach plans lineups here, then sends a roster to the Client so it knows who is playing.
During the game the Client records serve and service-return counts per set. Afterwards the coach
copies the Client's stats payload back here and pastes it in. There is no network between the two
apps: everything travels as plain text, by copy/paste (typically through email or Messages), so
the format has to survive a mail client's line-wrapping and quoting.

This app's implementation lives in `src/contract/statsContract.ts`, deliberately with **zero
imports** — the Client is plain HTML/JS on iOS Safari and copies that file's logic verbatim
rather than sharing a build step with it. Keep this document and that file in sync by hand.

## The encoded form

```
CIQR1.<base64url of UTF-8 JSON>.<8 hex chars>      roster payload
CIQS1.<base64url of UTF-8 JSON>.<8 hex chars>      stats payload
```

- `CIQR` / `CIQS` name the payload **kind** (roster / stats). A decoder reads this before
  touching the body, so it can say "this is a roster, not stats" without attempting to parse
  anything.
- The digit immediately after the kind letters (`1` today) is the **contract major version**
  (`CONTRACT_VERSION`). A decoder refuses a payload whose version is higher than the one it
  understands, before attempting to decode the body.
- The two literal `.` characters separate three fields: `<prefix+version>.<body>.<checksum>`.

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
5. Join: `${prefixForKind}${CONTRACT_VERSION}.${base64url}.${checksum}`.

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
8. Return the parsed (but not yet shape-validated) JSON value. `decodeRoster` / `decodeStats`
   then run the shape validators below.

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

## Roster payload schema (contract v1)

| Field | Type | Rule |
|---|---|---|
| `v` | `1` | Must equal the version named in the prefix. |
| `kind` | `"roster"` | Fixed. |
| `gameId` | `string` | Non-empty. Echoed back in the stats payload to match the game. |
| `team` | `string` | Display-only; the import never reads it back. |
| `opponent` | `string` | Display-only. |
| `date` | `string` | Display-only. |
| `players` | array | 1–12 entries (`MAX_ROSTER_PLAYERS`), unique ids, directory order. |
| `players[].id` | `string` | Matches `ID_PATTERN` (see below). |
| `players[].name` | `string` | Required, 1–64 characters (`MAX_NAME_LENGTH`). |
| `players[].jersey` | `number` | Optional — this app's roster panel does not collect jerseys today, so it is usually absent. |

## Stats payload schema (contract v1)

| Field | Type | Rule |
|---|---|---|
| `v` | `1` | Must equal the version named in the prefix. |
| `kind` | `"stats"` | Fixed. |
| `gameId` | `string` | Non-empty. Matched against a saved game's id on import. |
| `recordedAt` | `string` | ISO timestamp, from the Client's clock. |
| `players` | array | The roster the Client actually used: 1–12 entries (`MAX_ROSTER_PLAYERS`), unique ids, each name 1–64 characters (`MAX_NAME_LENGTH`). A Client-added player (id in the `cx-` namespace) arrives with a name and becomes a guest on import. |
| `sets` | array | 1–3 entries, `n` ascending and unique. A set the team did not play is simply omitted, not sent with empty stats. |
| `sets[].n` | `1 \| 2 \| 3` | The set number. |
| `sets[].score` | `[number, number] \| null` | `[us, them]`, or `null` if not recorded. |
| `sets[].players` | array | Stat lines for that set. Every `id` here must appear in the top-level `players`. A player with no line in a set is 0/0 there — not an error. |
| `sets[].players[].serve` / `.return` | `{ in: number; out: number }` | Both integers, `0`–`999` (`MAX_COUNT`). **Totals are never transmitted** — both apps derive `in + out`. |

## Id rules

- **Player id** (`ID_PATTERN`): `/^[A-Za-z0-9_-]{1,64}$/` — opaque, 1–64 characters, no spaces.
  This app's own ids (`domain/id.ts`) already match this shape.
- **Client-created id** (`CLIENT_ID_PATTERN`): `/^cx-[A-Za-z0-9_-]{4,32}$/`. The Client must use
  this namespace for any player it adds itself (e.g. a sub the coach never entered here), so it
  can never collide with an id this app generates. This app treats an unrecognised id in the
  stats payload's top-level `players` as a new guest of that game.

## Limits

| Constant | Value | Meaning |
|---|---|---|
| `CONTRACT_VERSION` | `1` | The contract's major version. |
| `MAX_ROSTER_PLAYERS` | `12` | Largest roster the Client's tick-list (and this schema) accepts. |
| `MAX_COUNT` | `999` | Largest legal serve/return count. |
| `MAX_NAME_LENGTH` | `64` | Longest legal `players[].name`, in **both** payloads. An empty name is malformed too. |

`MAX_ROSTER_PLAYERS` bounds the stats payload's top-level `players` as well: that list echoes the
roster the Client was handed, which this app never lets exceed 12, so a longer one is a broken
Client rather than a big team. Both caps are refusals, not truncations — nothing over-long is
allowed to reach saved state.

## Error catalogue

Every string below is produced verbatim by `src/contract/statsContract.ts`; `<n>` marks a value
interpolated at the point of failure.

**Transport (`decodePayload`):**

- `This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.`
- `This is a roster payload, not a stats payload.` (and the reverse)
- `This payload was made by a newer version of the stats app (contract <n>); this app understands <n>.`
- `This payload is corrupted or incomplete — copy it again from the stats app.` — covers a
  truncated payload, a checksum mismatch, invalid Base64URL, unparsable JSON, and a body whose
  own `v`/`kind` disagrees with the prefix.

**Shape (`validateRosterPayload` / `validateStatsPayload`)** — all of the form
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
- `it has no player list`
- `it names <n> players; the limit is 12`
- `one of its players is malformed`
- `player id "<id>" is not legal`
- `player id "<id>" appears twice`
- `player "<id>" has no name`
- `player "<id>" has an empty name`
- `player "<id>" has a <n>-character name; the limit is 64`
- `it has no set list`
- `it records no sets`
- `it records more than 3 sets`
- `one of its sets is malformed`
- `set number "<n>" is not 1, 2 or 3`
- `set <n> appears twice or out of order`
- `set <n> has a malformed score`
- `set <n> has no player list`
- `set <n> has a malformed player line`
- `set <n> names an illegal player id "<id>"`
- `player "<id>" has stats but is not in the player list`
- `player "<id>" appears twice in set <n>`
- `player "<id>" has a malformed serve count in set <n>`
- `player "<id>" has a malformed return count in set <n>`

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

## Plain-JS reference codec

The same logic as `src/contract/statsContract.ts`, without types, for an implementer who is not
using TypeScript (e.g. the Client). Shape validation is intentionally omitted here — only the
transport codec needs to be identical between the two apps.

```js
const CONTRACT_VERSION = 1;
const PREFIX = { roster: 'CIQR', stats: 'CIQS' };

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

function encodePayload(kind, json) {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return `${PREFIX[kind]}${CONTRACT_VERSION}.${toBase64Url(bytes)}.${fnv1a32(bytes)}`;
}

function decodePayload(text, expected) {
  const compact = text.replace(/\s+/g, '');
  const head = /^(CIQ[RS])(\d+)\./.exec(compact);
  if (!head) return { ok: false, error: 'This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.' };
  const kind = head[1] === 'CIQR' ? 'roster' : 'stats';
  const kindLabel = { roster: 'roster payload', stats: 'stats payload' };
  if (kind !== expected) return { ok: false, error: `This is a ${kindLabel[kind]}, not a ${kindLabel[expected]}.` };
  const version = Number(head[2]);
  if (version > CONTRACT_VERSION) {
    return { ok: false, error: `This payload was made by a newer version of the stats app (contract ${version}); this app understands ${CONTRACT_VERSION}.` };
  }
  const CORRUPT = 'This payload is corrupted or incomplete — copy it again from the stats app.';
  const m = /^(CIQ[RS])(\d+)\.([A-Za-z0-9_-]*)\.([0-9a-f]{8})$/.exec(compact);
  if (!m) return { ok: false, error: CORRUPT };
  const bytes = fromBase64Url(m[3]);
  if (!bytes || fnv1a32(bytes) !== m[4]) return { ok: false, error: CORRUPT };
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, error: CORRUPT };
  }
  if (typeof parsed !== 'object' || parsed === null || parsed.v !== version || parsed.kind !== kind) {
    return { ok: false, error: CORRUPT };
  }
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

### Roster vector

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

### Stats vector

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
