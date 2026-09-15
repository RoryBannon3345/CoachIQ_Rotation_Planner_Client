// codec.js — verbatim port of the CoachIQ stats contract codec.
// Source: reference/stats-contract-v2-client-guide.md ("The reference codec", section 7) and
// reference/statsContract.ts (constants, validators, v2 functions), with TypeScript type syntax stripped.
// Do not edit; re-copy from those sources if the contract changes.

export const CONTRACT_VERSION = 3;
export const PREFIX = { roster: 'CIQR', stats: 'CIQS' };

export function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Set-membership bitmasks: how `games[].sets` says who is in a set.
 *
 * Bit `i` of a mask means "the player at `players[i]` is in this set". One integer replaces one
 * index array per set, which is what makes per-set membership affordable in a `mailto:` body.
 *
 * **These use arithmetic, never bitwise operators, and that is load-bearing.** JavaScript's `|`,
 * `&` and `<<` coerce to *signed* 32-bit, so `2 ** 31 | 0` is `-2147483648`. At `MAX_DAY_PLAYERS`
 * of 24 the highest bit is `2 ** 23` and either form would work today — but the arithmetic form
 * keeps working to 2^53, so raising that cap later cannot silently corrupt rosters. Anyone
 * "simplifying" these back to bitwise operators reintroduces a bug that only appears once the
 * directory passes 31 players, and appears as wrong girls on a tick-list, not as an error.
 */
export function maskHas(mask, index) {
  return Math.floor(mask / 2 ** index) % 2 === 1;
}

/** The mask naming exactly `indices`. A repeated index is ignored rather than added twice, which
 *  would set a different, higher bit and name a player nobody chose. */
export function maskOf(indices) {
  let mask = 0;
  for (const index of indices) if (!maskHas(mask, index)) mask += 2 ** index;
  return mask;
}

/** The indices `mask` names, ascending, considering only bits below `size`. */
export function maskMembers(mask, size) {
  const members = [];
  for (let i = 0; i < size; i += 1) if (maskHas(mask, i)) members.push(i);
  return members;
}

/** How many players `mask` names, considering only bits below `size`. */
export function maskCount(mask, size) {
  let count = 0;
  for (let i = 0; i < size; i += 1) if (maskHas(mask, i)) count += 1;
  return count;
}

/** Every player named by either mask. `a` is carried through unfiltered; only `b`'s contribution
 *  is bounded to bits below `size` — safe because every mask reaching this helper has already
 *  been range-checked against the same directory. */
export function maskUnion(a, b, size) {
  let union = a;
  for (let i = 0; i < size; i += 1) if (maskHas(b, i) && !maskHas(union, i)) union += 2 ** i;
  return union;
}

export function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b); // a loop, not spread: spread overflows on big inputs
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Coach-readable name for each kind, used in the kind-mismatch error. */
export const KIND_LABEL = { roster: 'roster payload', stats: 'stats payload' };

/** Which app authors each kind, for the "made by a newer version" message. A roster is made by the
 * Rotation Planner and a stats sheet by the stats app, so naming the stats app for both — what
 * this file used to do — told a coach on the Client side to go and update the wrong app. The kind
 * alone decides it, so the one file both apps run verbatim produces the right words on each side. */
export const AUTHOR_LABEL = { roster: 'the Rotation Planner', stats: 'the stats app' };

/**
 * The one message for every way the body can fail to be trustworthy JSON (bad base64, checksum
 * mismatch, unparsable JSON, or an inner `v`/`kind` that disagrees with the prefix) — a coach
 * cannot act on "unexpected token" but can act on "copy it again".
 *
 * Kind-aware for the same reason the newer-version message is: the instruction is *where to copy
 * it again from*, and a roster comes from the Rotation Planner, not from the stats app. `expected`,
 * not the decoded kind: on a payload this corrupt the prefix may be the only thing worth trusting,
 * and the caller has already told us which app it believes it is reading.
 */
function corrupt(expected) {
  return `This payload is corrupted or incomplete — copy it again from ${AUTHOR_LABEL[expected]}.`;
}

/**
 * Encodes any already-shaped JSON value under the given kind's prefix and a contract version.
 *
 * `version` exists because the prefix version and the body's own `v` must agree — `decodePayload`
 * cross-checks them and calls any disagreement corruption. Once `CONTRACT_VERSION` became 2, a v1
 * body encoded with the default would go out as `CIQS2.` wrapped around `"v":1` and be refused by
 * this very module. So the surviving v1 encoders (`encodeRoster`/`encodeStats`) pass `1`
 * explicitly, which is also what keeps the v1 golden vectors byte-identical. Production v2 callers
 * never pass it.
 */
export function encodePayload(kind, json, version = CONTRACT_VERSION) {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return `${PREFIX[kind]}${version}.${toBase64Url(bytes)}.${fnv1a32(bytes)}`;
}

/**
 * Transport-layer decode: whitespace strip (email line-wrapping) → prefix/kind/version check →
 * full-pattern match → Base64URL decode → checksum → JSON parse → inner `v`/`kind` cross-check.
 * Returns the parsed value on success; `decodeRoster`/`decodeStats`/`decodeDayRoster`/`decodeDayStats`
 * run the shape validators next.
 *
 * Order matters: kind and version are read from the prefix and checked *before* the checksum, so
 * "this is a roster, not stats" and "made by a newer app" are reported even on a payload whose
 * body is otherwise corrupt — those two facts are visible without trusting the body at all.
 */
export function decodePayload(text, expected) {
  const compact = text.replace(/\s+/g, '');
  const head = /^(CIQ[RS])(\d+)\./.exec(compact);
  if (!head) return { ok: false, error: 'This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.' };
  const kind = head[1] === 'CIQR' ? 'roster' : 'stats';
  if (kind !== expected) return { ok: false, error: `This is a ${KIND_LABEL[kind]}, not a ${KIND_LABEL[expected]}.` };
  const version = Number(head[2]);
  if (version > CONTRACT_VERSION) {
    return {
      ok: false,
      error: `This payload was made by a newer version of ${AUTHOR_LABEL[expected]} (contract ${version}); this app understands ${CONTRACT_VERSION}.`,
    };
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
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || parsed.v !== version || parsed.kind !== kind) {
    return { ok: false, error: corrupt(expected) };
  }
  return { ok: true, value: parsed };
}

// ---------------------------------------------------------------------------------------------
// Shape validation — ported from reference/statsContract.ts, TypeScript type syntax removed.
// ---------------------------------------------------------------------------------------------

export const MAX_ROSTER_PLAYERS = 12, MAX_COUNT = 999, MAX_NAME_LENGTH = 64;
export const MAX_GAMES_PER_DAY = 8;
export const MAX_DAY_PLAYERS = 24;
export const MAX_RECORDED_AT_LENGTH = 32;
export const MAX_SETS = 5;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const CLIENT_ID_PATTERN = /^cx-[A-Za-z0-9_-]{4,32}$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformed(kind, detail) {
  return { ok: false, error: `The ${KIND_LABEL[kind]} is malformed: ${detail}.` };
}

function isLegalId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/**
 * A string with something in it — the check both validators apply, at **both** contract versions,
 * to the field that identifies their payload: `date` on a roster and `recordedAt` on a stats
 * sheet. A non-string and an empty string are the same fault and carry the same message
 * (`it has no date` / `it has no recorded time`): neither is a date, and there is nothing to
 * print for either.
 *
 * Requiring this of v1 as well is a tightening, not a widening: without it, `normaliseStatsV1`/
 * `normaliseRosterV1` would be *nearly* total instead of total. This is the property that makes
 * every v1-accepted payload also v2-accepted after normalisation.
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** The malformed-detail tail for a name that is a string but not a legal one, or `null` when it
 * is fine. Called after the `typeof` check in both validators (a non-string name is "has no
 * name"), so a name is bounded identically in a roster and in a stats sheet. An empty name is
 * malformed too: there is nothing to print for her. */
function nameLengthFault(name) {
  if (name.length === 0) return 'has an empty name';
  if (name.length > MAX_NAME_LENGTH) {
    return `has a ${name.length}-character name; the limit is ${MAX_NAME_LENGTH}`;
  }
  return null;
}

function isCount(value) {
  // Whole numbers only — a rally-by-rally fraction is never legal input (see design spec §4).
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
}

function isLegalStatCount(value) {
  return isRecord(value) && isCount(value.in) && isCount(value.out);
}

function buildStatCount(value) {
  return { in: value.in, out: value.out };
}

/** `null` or a 2-tuple of numbers, rebuilt by hand so the caller never carries an array forward.
 * Returns `undefined` (not `null`, which is a legal score) for a malformed score so the caller
 * can tell "no score" from "not a score" with a plain `=== undefined` check.
 *
 * Both entries must be **finite**: `JSON.parse` turns the numeral `1e999` into `Infinity`, so a
 * pasted payload — not just a hand-built object — can carry a non-finite score, and a non-finite
 * score serialises back out as `null` (via `JSON.stringify`), breaking round-trips downstream. */
function parseScore(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [a, b] = value;
  if (typeof a !== 'number' || typeof b !== 'number') return undefined;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return [a, b];
}

export function validateRosterPayload(value) {
  if (!isRecord(value)) return malformed('roster', 'it is not an object');
  if (value.v !== 1) return malformed('roster', 'its version is not 1');
  if (value.kind !== 'roster') return malformed('roster', 'its kind is not "roster"');
  if (typeof value.gameId !== 'string' || value.gameId.length === 0) return malformed('roster', 'it has no game id');
  if (typeof value.team !== 'string') return malformed('roster', 'it has no team name');
  if (typeof value.opponent !== 'string') return malformed('roster', 'it has no opponent name');
  if (!isNonEmptyString(value.date)) return malformed('roster', 'it has no date');
  if (!Array.isArray(value.players)) return malformed('roster', 'it has no player list');
  if (value.players.length === 0) return malformed('roster', 'it names no players');
  if (value.players.length > MAX_ROSTER_PLAYERS) {
    return malformed('roster', `it names ${value.players.length} players; the limit is ${MAX_ROSTER_PLAYERS}`);
  }
  const players = [];
  const seenIds = new Set();
  for (const raw of value.players) {
    if (!isRecord(raw)) return malformed('roster', 'one of its players is malformed');
    if (!isLegalId(raw.id)) return malformed('roster', `player id "${String(raw.id)}" is not legal`);
    if (seenIds.has(raw.id)) return malformed('roster', `player id "${raw.id}" appears twice`);
    seenIds.add(raw.id);
    if (typeof raw.name !== 'string') return malformed('roster', `player "${raw.id}" has no name`);
    const nameFault = nameLengthFault(raw.name);
    if (nameFault !== null) return malformed('roster', `player "${raw.id}" ${nameFault}`);
    if (raw.jersey !== undefined && typeof raw.jersey !== 'number') {
      return malformed('roster', `player "${raw.id}" has a non-number jersey`);
    }
    players.push(raw.jersey === undefined ? { id: raw.id, name: raw.name } : { id: raw.id, name: raw.name, jersey: raw.jersey });
  }
  return {
    ok: true,
    value: {
      v: 1,
      kind: 'roster',
      gameId: value.gameId,
      team: value.team,
      opponent: value.opponent,
      date: value.date,
      players,
    },
  };
}

export function validateStatsPayload(value) {
  if (!isRecord(value)) return malformed('stats', 'it is not an object');
  if (value.v !== 1) return malformed('stats', 'its version is not 1');
  if (value.kind !== 'stats') return malformed('stats', 'its kind is not "stats"');
  if (typeof value.gameId !== 'string' || value.gameId.length === 0) return malformed('stats', 'it has no game id');
  if (!isNonEmptyString(value.recordedAt)) return malformed('stats', 'it has no recorded time');
  if (value.recordedAt.length > MAX_RECORDED_AT_LENGTH) {
    return malformed('stats', `its recorded time is ${value.recordedAt.length} characters; the limit is ${MAX_RECORDED_AT_LENGTH}`);
  }
  if (!Array.isArray(value.players)) return malformed('stats', 'it has no player list');
  // Non-empty, the way `validateRosterPayload` has always required and `parseDayPlayerList`
  // requires on the v2 path. A stats payload naming nobody passed v1 before, and a sheet with no
  // players in it records nothing anyway. Without this, `normaliseStatsV1` would not be total:
  // `{ players: [], sets: [...] }` would pass v1, normalise, and be refused by the v2 validator
  // with `it names no players`, landing mid-import after the coach had already seen a preview.
  if (value.players.length === 0) return malformed('stats', 'it names no players');
  // The list echoes the roster the Client was handed (spec §4). `MAX_ROSTER_PLAYERS` bounds it
  // here unconditionally, not because every sender is assumed to respect the cap — this file is
  // the one thing both apps trust to enforce it regardless of what produced the payload, so a
  // longer list is refused before a payload of any size can reach saved state, whoever sent it.
  if (value.players.length > MAX_ROSTER_PLAYERS) {
    return malformed('stats', `it names ${value.players.length} players; the limit is ${MAX_ROSTER_PLAYERS}`);
  }

  const players = [];
  const playerIds = new Set();
  for (const raw of value.players) {
    if (!isRecord(raw)) return malformed('stats', 'one of its players is malformed');
    if (!isLegalId(raw.id)) return malformed('stats', `player id "${String(raw.id)}" is not legal`);
    if (playerIds.has(raw.id)) return malformed('stats', `player id "${raw.id}" appears twice`);
    if (typeof raw.name !== 'string') return malformed('stats', `player "${raw.id}" has no name`);
    const nameFault = nameLengthFault(raw.name);
    if (nameFault !== null) return malformed('stats', `player "${raw.id}" ${nameFault}`);
    playerIds.add(raw.id);
    players.push({ id: raw.id, name: raw.name });
  }

  if (!Array.isArray(value.sets)) return malformed('stats', 'it has no set list');
  if (value.sets.length === 0) return malformed('stats', 'it records no sets');
  if (value.sets.length > MAX_SETS) return malformed('stats', `it records more than ${MAX_SETS} sets`);

  const sets = [];
  let previousN = 0;
  for (const rawSet of value.sets) {
    if (!isRecord(rawSet)) return malformed('stats', 'one of its sets is malformed');
    const n = rawSet.n;
    // `typeof n !== 'number'` first: `n` is `unknown` here, and `previousN` below must be
    // assigned from a genuine `number`, not merely something the comparison operators permit.
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_SETS) {
      return malformed('stats', `set number "${String(n)}" is not between 1 and ${MAX_SETS}`);
    }
    // Ascending and unique in one check: a set out of order or repeated both fail `n <= previousN`.
    if (n <= previousN) return malformed('stats', `set ${n} appears twice or out of order`);
    previousN = n;

    const rawScore = rawSet.score;
    const score = parseScore(rawScore);
    if (score === undefined) return malformed('stats', `set ${n} has a malformed score`);

    if (!Array.isArray(rawSet.players)) return malformed('stats', `set ${n} has no player list`);
    const lines = [];
    const seenInSet = new Set();
    for (const rawLine of rawSet.players) {
      if (!isRecord(rawLine)) return malformed('stats', `set ${n} has a malformed player line`);
      const id = rawLine.id;
      if (!isLegalId(id)) return malformed('stats', `set ${n} names an illegal player id "${String(id)}"`);
      if (!playerIds.has(id)) return malformed('stats', `player "${id}" has stats but is not in the player list`);
      if (seenInSet.has(id)) return malformed('stats', `player "${id}" appears twice in set ${n}`);
      seenInSet.add(id);
      if (!isLegalStatCount(rawLine.serve)) return malformed('stats', `player "${id}" has a malformed serve count in set ${n}`);
      if (!isLegalStatCount(rawLine.return)) return malformed('stats', `player "${id}" has a malformed return count in set ${n}`);
      lines.push({ id, serve: buildStatCount(rawLine.serve), return: buildStatCount(rawLine.return) });
    }
    sets.push({ n, score, players: lines });
  }

  return {
    ok: true,
    value: {
      v: 1,
      kind: 'stats',
      gameId: value.gameId,
      recordedAt: value.recordedAt,
      players,
      sets,
    },
  };
}

/** Encodes a v1 roster. The explicit `1` is not decoration: `CONTRACT_VERSION` is 2 now, and
 * without it this would emit a `CIQR2.` prefix around a body saying `"v":1`, which
 * `decodePayload`'s own cross-check refuses as corruption. */
export function encodeRoster(payload) {
  return encodePayload('roster', payload, 1);
}

/** Encodes a v1 stats sheet. See `encodeRoster` for why the version is pinned. */
export function encodeStats(payload) {
  return encodePayload('stats', payload, 1);
}

/** Encodes a day roster at the current contract version — no pin, because a v2 payload's `v` and
 * `CONTRACT_VERSION` are the same number by definition. */
export function encodeDayRoster(payload) {
  return encodePayload('roster', payload);
}

/** Encodes a day stats sheet. Pinned to `2`, unlike `encodeDayRoster`: the stats payload shape is
 * unchanged at contract v3, and the Planner accepts a `v: 2` stats body indefinitely, so there is
 * nothing for a v3 stats payload to mean yet. Without this pin, bumping `CONTRACT_VERSION` to 3
 * would silently start stamping stats sheets `CIQS3.` too — the exact "both halves move together"
 * mistake this contract's version split exists to avoid. */
export function encodeDayStats(payload) {
  return encodePayload('stats', payload, 2);
}

export function decodeRoster(text) {
  const decoded = decodePayload(text, 'roster');
  if (!decoded.ok) return decoded;
  return validateRosterPayload(decoded.value);
}

export function decodeStats(text) {
  const decoded = decodePayload(text, 'stats');
  if (!decoded.ok) return decoded;
  return validateStatsPayload(decoded.value);
}

// ---------------------------------------------------------------------------------------------
// Contract v2 — day-scoped payloads. Same transport, same field-by-field validation style, same
// rule that the returned value is rebuilt field by field and never spread; the unit of exchange is
// a whole tournament day rather than a single game.
// ---------------------------------------------------------------------------------------------

/** The one version detail every day validator and both day decoders report. Deliberately names
 * *all three* versions this app reads rather than only the one being validated: a coach who pasted
 * the wrong thing needs to know what is acceptable, not which branch refused her. */
const NOT_A_KNOWN_VERSION = 'its version is not 1, 2 or 3';

/**
 * The day directory shared by both v2 payloads: 1..`MAX_DAY_PLAYERS` entries, unique legal ids,
 * bounded names. One helper rather than two near-identical loops, because a directory that
 * validated differently in a roster than in a stats sheet would let a day the Client accepted come
 * back refused (or the reverse) with nothing pointing at the asymmetry.
 *
 * `withJersey` is the one real difference: a roster carries the optional `jersey` the planner
 * sends, and a stats sheet has no use for one, so it drops the field on the way in exactly as the
 * v1 stats validator does — the returned entries for a stats payload are `{ id, name }` only.
 */
function parseDayPlayerList(kind, value, withJersey) {
  if (!Array.isArray(value)) return malformed(kind, 'it has no player list');
  if (value.length === 0) return malformed(kind, 'it names no players');
  if (value.length > MAX_DAY_PLAYERS) {
    return malformed(kind, `it names ${value.length} players; the day limit is ${MAX_DAY_PLAYERS}`);
  }
  const players = [];
  const seenIds = new Set();
  for (const raw of value) {
    if (!isRecord(raw)) return malformed(kind, 'one of its players is malformed');
    if (!isLegalId(raw.id)) return malformed(kind, `player id "${String(raw.id)}" is not legal`);
    if (seenIds.has(raw.id)) return malformed(kind, `player id "${raw.id}" appears twice`);
    seenIds.add(raw.id);
    if (typeof raw.name !== 'string') return malformed(kind, `player "${raw.id}" has no name`);
    const nameFault = nameLengthFault(raw.name);
    if (nameFault !== null) return malformed(kind, `player "${raw.id}" ${nameFault}`);
    if (!withJersey) {
      players.push({ id: raw.id, name: raw.name });
      continue;
    }
    if (raw.jersey !== undefined && typeof raw.jersey !== 'number') {
      return malformed(kind, `player "${raw.id}" has a non-number jersey`);
    }
    players.push(raw.jersey === undefined ? { id: raw.id, name: raw.name } : { id: raw.id, name: raw.name, jersey: raw.jersey });
  }
  return { ok: true, value: players };
}

function validateDayRosterPayloadV2(value) {
  if (!isRecord(value)) return malformed('roster', 'it is not an object');
  if (value.v !== 2) return malformed('roster', NOT_A_KNOWN_VERSION);
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
    // `opponent` may be empty, the same way `team` may: a game against an unnamed opponent is a
    // real thing a coach plans, and the Client only ever prints this string.
    if (typeof rawGame.opponent !== 'string') return malformed('roster', `game "${gameId}" has no opponent name`);
    if (!Array.isArray(rawGame.roster)) return malformed('roster', `game "${gameId}" has no roster`);
    if (rawGame.roster.length > MAX_ROSTER_PLAYERS) {
      return malformed('roster', `game "${gameId}" names ${rawGame.roster.length} players; the limit is ${MAX_ROSTER_PLAYERS}`);
    }
    const roster = [];
    const seenIndices = new Set();
    for (const rawIndex of rawGame.roster) {
      // Anything that is not a whole number at or above zero is not an index at all, so it is a
      // malformed reference rather than an out-of-range one: "names player -1, but the payload
      // lists only 12" would describe the fault wrongly and send the reader counting players.
      if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex) || rawIndex < 0) {
        return malformed('roster', `game "${gameId}" has a malformed player reference`);
      }
      if (rawIndex >= players.length) {
        return malformed('roster', `game "${gameId}" names player ${rawIndex}, but the payload lists only ${players.length}`);
      }
      if (seenIndices.has(rawIndex)) return malformed('roster', `game "${gameId}" names player ${rawIndex} twice`);
      seenIndices.add(rawIndex);
      roster.push(rawIndex);
    }
    // An empty roster is legal on purpose: a coach can send the day before she has picked who
    // plays the third game, and refusing that would make her choose between sending early and
    // sending at all.
    games.push({ gameId, opponent: rawGame.opponent, roster });
  }

  return { ok: true, value: { v: 2, kind: 'roster', date: value.date, team: value.team, players, games } };
}

/**
 * The v3 roster validator. `games[].roster` (one index array per game) is gone; `games[].sets` is
 * one bitmask per set, positional, and `sets.length` is how many sets the game has.
 *
 * The per-game cap is checked on the **union** across the game's sets, which is the same rule v2
 * enforced — in v2 `roster` *was* that union.
 */
export function validateDayRosterPayload(value) {
  if (!isRecord(value)) return malformed('roster', 'it is not an object');
  if (value.v !== 3) return malformed('roster', NOT_A_KNOWN_VERSION);
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

export function validateDayStatsPayload(value) {
  if (!isRecord(value)) return malformed('stats', 'it is not an object');
  if (value.v !== 2) return malformed('stats', NOT_A_KNOWN_VERSION);
  if (value.kind !== 'stats') return malformed('stats', 'its kind is not "stats"');
  if (!isNonEmptyString(value.recordedAt)) return malformed('stats', 'it has no recorded time');
  if (value.recordedAt.length > MAX_RECORDED_AT_LENGTH) {
    return malformed('stats', `its recorded time is ${value.recordedAt.length} characters; the limit is ${MAX_RECORDED_AT_LENGTH}`);
  }

  const directory = parseDayPlayerList('stats', value.players, false);
  if (!directory.ok) return directory;
  const players = directory.value.map((p) => ({ id: p.id, name: p.name }));
  const playerIds = new Set(players.map((p) => p.id));

  if (!Array.isArray(value.games)) return malformed('stats', 'it has no game list');
  if (value.games.length === 0) return malformed('stats', 'it records no games');
  if (value.games.length > MAX_GAMES_PER_DAY) {
    return malformed('stats', `it records more than ${MAX_GAMES_PER_DAY} games`);
  }

  const games = [];
  const seenGameIds = new Set();
  for (const rawGame of value.games) {
    if (!isRecord(rawGame)) return malformed('stats', 'one of its games is malformed');
    const gid = rawGame.gameId;
    if (typeof gid !== 'string' || gid.length === 0) return malformed('stats', 'one of its games has no id');
    if (seenGameIds.has(gid)) return malformed('stats', `game id "${gid}" appears twice`);
    seenGameIds.add(gid);

    if (!Array.isArray(rawGame.sets)) return malformed('stats', `game "${gid}" has no set list`);
    if (rawGame.sets.length === 0) return malformed('stats', `game "${gid}" records no sets`);
    if (rawGame.sets.length > MAX_SETS) return malformed('stats', `game "${gid}" records more than ${MAX_SETS} sets`);

    const sets = [];
    // Per game, not per day: every game starts again at set 1, so the ascending-and-unique check
    // resets here. A day of three games legitimately carries three set-1 lines.
    let previousN = 0;
    for (const rawSet of rawGame.sets) {
      if (!isRecord(rawSet)) return malformed('stats', `game "${gid}" has a malformed set`);
      const n = rawSet.n;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_SETS) {
        return malformed('stats', `game "${gid}" has a set numbered "${String(n)}"; it must be between 1 and ${MAX_SETS}`);
      }
      if (n <= previousN) return malformed('stats', `game "${gid}" repeats set ${n} or has it out of order`);
      previousN = n;

      const score = parseScore(rawSet.score);
      if (score === undefined) return malformed('stats', `game "${gid}" set ${n} has a malformed score`);

      if (!Array.isArray(rawSet.players)) return malformed('stats', `game "${gid}" set ${n} has no player list`);
      const lines = [];
      const seenInSet = new Set();
      for (const rawLine of rawSet.players) {
        if (!isRecord(rawLine)) return malformed('stats', `game "${gid}" set ${n} has a malformed player line`);
        const id = rawLine.id;
        if (!isLegalId(id)) return malformed('stats', `game "${gid}" set ${n} names an illegal player id "${String(id)}"`);
        if (!playerIds.has(id)) return malformed('stats', `player "${id}" has stats in game "${gid}" but is not in the player list`);
        if (seenInSet.has(id)) return malformed('stats', `player "${id}" appears twice in game "${gid}" set ${n}`);
        seenInSet.add(id);
        if (!isLegalStatCount(rawLine.serve)) return malformed('stats', `player "${id}" has a malformed serve count in game "${gid}" set ${n}`);
        if (!isLegalStatCount(rawLine.return)) return malformed('stats', `player "${id}" has a malformed return count in game "${gid}" set ${n}`);
        lines.push({ id, serve: buildStatCount(rawLine.serve), return: buildStatCount(rawLine.return) });
      }
      sets.push({ n, score, players: lines });
    }
    games.push({ gameId: gid, sets });
  }

  return { ok: true, value: { v: 2, kind: 'stats', recordedAt: value.recordedAt, players, games } };
}

/**
 * Lifts a validated v1 stats payload — one game — into the day shape the rest of the app now
 * speaks, so exactly one shape reaches saved state and nothing downstream has to branch on `v`.
 *
 * **Total**, and that is load-bearing: every payload `validateStatsPayload` accepts normalises into
 * one `validateDayStatsPayload` accepts. `isNonEmptyString` is what closes the last gap (an empty
 * `recordedAt`, which v1 used to accept).
 */
export function normaliseStatsV1(p) {
  return {
    v: 2,
    kind: 'stats',
    recordedAt: p.recordedAt,
    players: p.players,
    games: [{ gameId: p.gameId, sets: p.sets }],
  };
}

/**
 * A v2 roster lifted into the v3 shape.
 *
 * A v2 payload carried no set structure at all, so there is nothing to recover: each game
 * normalises to **one set** holding that game's whole roster. This is lossy and deliberately so —
 * inventing three sets because three is the usual number would put a fabricated set count in front
 * of a coach and call it data. A coach who wants real per-set membership re-sends from the Planner.
 */
function normaliseRosterV2(p) {
  return {
    v: 3,
    kind: 'roster',
    date: p.date,
    team: p.team,
    players: p.players,
    games: p.games.map((g) => ({ gameId: g.gameId, opponent: g.opponent, sets: [maskOf(g.roster)] })),
  };
}

/**
 * A v1 roster lifted into the v3 shape, via v2 so that "what a legacy payload's single set means"
 * has exactly one definition.
 *
 * A v1 roster is a one-game day whose directory is that game's players, so every index `0..n-1` is
 * on its tick-list, and `date`/`team` lift to the top. v1's own 12-player cap lands exactly on
 * `MAX_ROSTER_PLAYERS`, so even a full v1 roster normalises to a legal game.
 */
export function normaliseRosterV1(p) {
  return normaliseRosterV2({
    v: 2,
    kind: 'roster',
    date: p.date,
    team: p.team,
    players: p.players,
    games: [{ gameId: p.gameId, opponent: p.opponent, roster: p.players.map((_, i) => i) }],
  });
}

/** The decoded body's own `v`, which `decodePayload` has already proved equals the prefix version. */
function bodyVersion(value) {
  return isRecord(value) ? value.v : undefined;
}

/**
 * Decodes either contract version and always returns the day shape.
 *
 * `decodePayload` needs no change to make this work: it refuses a prefix version above
 * `CONTRACT_VERSION` before touching the body, accepts anything at or below it, and has already
 * cross-checked the body's own `v` against the prefix by the time it returns — so dispatching on
 * that `v` here is dispatching on a number the transport layer already vouched for.
 */
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
    return { ok: true, value: normaliseRosterV2(v2.value) };
  }
  if (version === 3) return validateDayRosterPayload(decoded.value);
  return malformed('roster', NOT_A_KNOWN_VERSION);
}

/** The stats half of `decodeDayRoster` — see there for why dispatching on the body's `v` is safe. */
export function decodeDayStats(text) {
  const decoded = decodePayload(text, 'stats');
  if (!decoded.ok) return decoded;
  const version = bodyVersion(decoded.value);
  if (version === 1) {
    const v1 = validateStatsPayload(decoded.value);
    if (!v1.ok) return v1;
    return { ok: true, value: normaliseStatsV1(v1.value) };
  }
  if (version === 2) return validateDayStatsPayload(decoded.value);
  return malformed('stats', NOT_A_KNOWN_VERSION);
}
