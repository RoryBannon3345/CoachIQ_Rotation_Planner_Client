// codec.js — verbatim port of the CoachIQ stats contract codec.
// Source: reference/stats-contract.md ("Plain-JS reference codec", commit 2c57064) and
// reference/statsContract.ts (validators, same commit), with TypeScript type syntax stripped.
// Do not edit; re-copy from those sources if the contract changes.

export const CONTRACT_VERSION = 1;
export const PREFIX = { roster: 'CIQR', stats: 'CIQS' };

export function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
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

export function encodePayload(kind, json) {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return `${PREFIX[kind]}${CONTRACT_VERSION}.${toBase64Url(bytes)}.${fnv1a32(bytes)}`;
}

export function decodePayload(text, expected) {
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

// ---------------------------------------------------------------------------------------------
// Shape validation — ported from reference/statsContract.ts, TypeScript type syntax removed.
// ---------------------------------------------------------------------------------------------

export const MAX_ROSTER_PLAYERS = 12, MAX_COUNT = 999, MAX_NAME_LENGTH = 64;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const CLIENT_ID_PATTERN = /^cx-[A-Za-z0-9_-]{4,32}$/;

/** Coach-readable name for each kind, used in the kind-mismatch error. */
export const KIND_LABEL = { roster: 'roster payload', stats: 'stats payload' };

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformed(kind, detail) {
  return { ok: false, error: `The ${KIND_LABEL[kind]} is malformed: ${detail}.` };
}

function isLegalId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
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
 * can tell "no score" from "not a score" with a plain `=== undefined` check. */
function parseScore(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [a, b] = value;
  if (typeof a !== 'number' || typeof b !== 'number') return undefined;
  return [a, b];
}

export function validateRosterPayload(value) {
  if (!isRecord(value)) return malformed('roster', 'it is not an object');
  if (value.v !== 1) return malformed('roster', 'its version is not 1');
  if (value.kind !== 'roster') return malformed('roster', 'its kind is not "roster"');
  if (typeof value.gameId !== 'string' || value.gameId.length === 0) return malformed('roster', 'it has no game id');
  if (typeof value.team !== 'string') return malformed('roster', 'it has no team name');
  if (typeof value.opponent !== 'string') return malformed('roster', 'it has no opponent name');
  if (typeof value.date !== 'string') return malformed('roster', 'it has no date');
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
  if (typeof value.recordedAt !== 'string') return malformed('stats', 'it has no recorded time');
  if (!Array.isArray(value.players)) return malformed('stats', 'it has no player list');
  // The list echoes the roster the Client was handed (spec §4), which this app caps at
  // `MAX_ROSTER_PLAYERS` — so anything longer is a broken Client, not a big team, and is refused
  // before a payload of any size can reach saved state.
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
  if (value.sets.length > 3) return malformed('stats', 'it records more than 3 sets');

  const sets = [];
  let previousN = 0;
  for (const rawSet of value.sets) {
    if (!isRecord(rawSet)) return malformed('stats', 'one of its sets is malformed');
    const n = rawSet.n;
    if (n !== 1 && n !== 2 && n !== 3) return malformed('stats', `set number "${String(n)}" is not 1, 2 or 3`);
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

export function encodeRoster(payload) {
  return encodePayload('roster', payload);
}

export function encodeStats(payload) {
  return encodePayload('stats', payload);
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
