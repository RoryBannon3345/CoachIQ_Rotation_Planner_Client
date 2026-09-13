/**
 * The CoachIQ ⇄ stats-app payload contract: encode/decode/validate for the roster and stats
 * payloads copy-pasted between this app and the separate iPhone stats app (the "Client").
 *
 * Zero imports, by design: the Client is plain HTML/JS on iOS Safari and copies this file's
 * logic verbatim (see `docs/stats-contract.md`'s reference codec) rather than sharing a build
 * step with it. Importing anything here — even a local type — would make this file inconsistent
 * with the copy the Client actually runs, so nothing may be imported, including from
 * `../domain/types`; every type this module needs is declared locally.
 *
 * Encoded form: `<CIQR|CIQS><contract version>.<base64url of UTF-8 JSON>.<8 hex FNV-1a32>`.
 * See `docs/stats-contract.md` for the full algorithm and golden vectors.
 */

/** The contract's major version. Bumping it is a breaking change shipped in both apps together
 * (see `docs/stats-contract.md`'s versioning policy); adding an optional field does not bump it. */
export const CONTRACT_VERSION = 1;

/** The roster payload's player cap — the stats app's tick-list enforces the same limit. */
export const MAX_ROSTER_PLAYERS = 12;

/** The largest legal serve/return count. Three digits is generously above any real set. */
export const MAX_COUNT = 999;

/** The longest legal player name, in both payloads. A name is a label a coach typed on a phone,
 * never a document, so the cap is generous; its job is to stop a buggy or hostile Client from
 * smuggling a megabyte string into saved state, where `persist` swallows a localStorage quota
 * failure and every later save would be lost with it. */
export const MAX_NAME_LENGTH = 64;

/** Every player id in this app: opaque, non-empty, printable ASCII, capped so a corrupt payload
 * cannot smuggle in a huge string. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The namespace a Client-created player id must use, so it can never collide with an id this
 * app generates (`domain/id.ts`'s ids never start with `cx-`). */
export const CLIENT_ID_PATTERN = /^cx-[A-Za-z0-9_-]{4,32}$/;

export type PayloadKind = 'roster' | 'stats';

export type ContractResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface RosterPayloadPlayer {
  id: string;
  name: string;
  jersey?: number;
}

export interface RosterPayload {
  v: 1;
  kind: 'roster';
  gameId: string;
  team: string;
  opponent: string;
  date: string;
  players: RosterPayloadPlayer[];
}

export interface StatCountPayload {
  in: number;
  out: number;
}

export interface StatsPayloadLine {
  id: string;
  serve: StatCountPayload;
  return: StatCountPayload;
}

export interface StatsPayloadSet {
  n: 1 | 2 | 3;
  score: [number, number] | null;
  players: StatsPayloadLine[];
}

export interface StatsPayload {
  v: 1;
  kind: 'stats';
  gameId: string;
  recordedAt: string;
  players: { id: string; name: string }[];
  sets: StatsPayloadSet[];
}

/** The encoded-form prefix per kind — also how `decodePayload` tells the two apart before
 * touching the body. */
const PREFIX: Record<PayloadKind, string> = { roster: 'CIQR', stats: 'CIQS' };

/** Coach-readable name for each kind, used in the kind-mismatch error. */
const KIND_LABEL: Record<PayloadKind, string> = { roster: 'roster payload', stats: 'stats payload' };

/** The one message for every way the body can fail to be trustworthy JSON (bad base64, checksum
 * mismatch, unparsable JSON, or an inner `v`/`kind` that disagrees with the prefix) — a coach
 * cannot act on "unexpected token" but can act on "copy it again". */
const CORRUPT = 'This payload is corrupted or incomplete — copy it again from the stats app.';

/** FNV-1a, 32-bit, returned as 8 lowercase hex chars. Used as the transport checksum so a
 * truncated or mangled paste is reported as "corrupted", not as a JSON parse error. `Math.imul`
 * keeps the multiply inside 32 bits the way the reference C algorithm does. */
export function fnv1a32(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A loop, not spread: `String.fromCharCode(...bytes)` overflows the call stack on a payload of
 * a few thousand bytes, which a full 12-player stats sheet can reach. */
function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns `null` (never throws) on anything that is not valid Base64URL, so callers can fold it
 * into the single `CORRUPT` message rather than a JSON/base64-specific one. */
function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Encodes any already-shaped JSON value under the given kind's prefix and current contract
 * version. `encodeRoster`/`encodeStats` are the typed callers; this one is also what the tests
 * use to construct deliberately-invalid payloads (e.g. a body whose `v` disagrees with the
 * prefix). */
export function encodePayload(kind: PayloadKind, json: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return `${PREFIX[kind]}${CONTRACT_VERSION}.${toBase64Url(bytes)}.${fnv1a32(bytes)}`;
}

/**
 * Transport-layer decode: whitespace strip (email line-wrapping) → prefix/kind/version check →
 * Base64URL decode → checksum → JSON parse → inner `v`/`kind` cross-check. Returns the parsed
 * `unknown` JSON value on success; `decodeRoster`/`decodeStats` run the shape validators next.
 *
 * Order matters: kind and version are read from the prefix and checked *before* the checksum, so
 * "this is a roster, not stats" and "made by a newer app" are reported even on a payload whose
 * body is otherwise corrupt — those two facts are visible without trusting the body at all.
 */
export function decodePayload(text: string, expected: PayloadKind): ContractResult<unknown> {
  const compact = text.replace(/\s+/g, '');
  const head = /^(CIQ[RS])(\d+)\./.exec(compact);
  if (head === null) {
    return { ok: false, error: 'This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.' };
  }
  const prefixLetter = head[1]; // guaranteed by the regex; narrowed for noUncheckedIndexedAccess
  const versionText = head[2];
  if (prefixLetter === undefined || versionText === undefined) return { ok: false, error: CORRUPT };
  const kind: PayloadKind = prefixLetter === 'CIQR' ? 'roster' : 'stats';
  if (kind !== expected) {
    return { ok: false, error: `This is a ${KIND_LABEL[kind]}, not a ${KIND_LABEL[expected]}.` };
  }
  const version = Number(versionText);
  if (version > CONTRACT_VERSION) {
    return {
      ok: false,
      error: `This payload was made by a newer version of the stats app (contract ${version}); this app understands ${CONTRACT_VERSION}.`,
    };
  }
  const m = /^(CIQ[RS])(\d+)\.([A-Za-z0-9_-]*)\.([0-9a-f]{8})$/.exec(compact);
  if (m === null) return { ok: false, error: CORRUPT };
  const body = m[3];
  const digest = m[4];
  if (body === undefined || digest === undefined) return { ok: false, error: CORRUPT };
  const bytes = fromBase64Url(body);
  if (bytes === null || fnv1a32(bytes) !== digest) return { ok: false, error: CORRUPT };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, error: CORRUPT };
  }
  // The body's own `v`/`kind` must agree with what the prefix already promised — a hand-edited
  // or mismatched body is corruption, not a different, valid payload.
  if (!isRecord(parsed) || parsed.v !== version || parsed.kind !== kind) return { ok: false, error: CORRUPT };
  return { ok: true, value: parsed };
}

// ---------------------------------------------------------------------------------------------
// Shape validation — field-by-field predicates in the `persistence.ts` style. Every validator
// rebuilds the value it returns field by field (never spreads the parsed object), so unknown
// fields on a hand-edited or future payload do not silently travel into this app's state.
// ---------------------------------------------------------------------------------------------

function malformed(kind: PayloadKind, detail: string): ContractResult<never> {
  return { ok: false, error: `The ${KIND_LABEL[kind]} is malformed: ${detail}.` };
}

function isLegalId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** The malformed-detail tail for a name that is a string but not a legal one, or `null` when it
 * is fine. Called after the `typeof` check in both validators (a non-string name is "has no
 * name"), so a name is bounded identically in a roster and in a stats sheet. An empty name is
 * malformed too: there is nothing to print for her. */
function nameLengthFault(name: string): string | null {
  if (name.length === 0) return 'has an empty name';
  if (name.length > MAX_NAME_LENGTH) {
    return `has a ${name.length}-character name; the limit is ${MAX_NAME_LENGTH}`;
  }
  return null;
}

function isCount(value: unknown): value is number {
  // Whole numbers only — a rally-by-rally fraction is never legal input (see design spec §4).
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
}

function isLegalStatCount(value: unknown): value is StatCountPayload {
  return isRecord(value) && isCount(value.in) && isCount(value.out);
}

function buildStatCount(value: StatCountPayload): StatCountPayload {
  return { in: value.in, out: value.out };
}

/** `null` or a 2-tuple of numbers, rebuilt by hand so the caller never carries an `unknown[]`
 * forward. Returns `undefined` (not `null`, which is a legal score) for a malformed score so the
 * caller can tell "no score" from "not a score" with a plain `=== undefined` check. */
function parseScore(value: unknown): [number, number] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [a, b] = value;
  if (typeof a !== 'number' || typeof b !== 'number') return undefined;
  return [a, b];
}

export function validateRosterPayload(value: unknown): ContractResult<RosterPayload> {
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
  const players: RosterPayloadPlayer[] = [];
  const seenIds = new Set<string>();
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

export function validateStatsPayload(value: unknown): ContractResult<StatsPayload> {
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

  const players: { id: string; name: string }[] = [];
  const playerIds = new Set<string>();
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

  const sets: StatsPayloadSet[] = [];
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
    const lines: StatsPayloadLine[] = [];
    const seenInSet = new Set<string>();
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

export function encodeRoster(payload: RosterPayload): string {
  return encodePayload('roster', payload);
}

export function encodeStats(payload: StatsPayload): string {
  return encodePayload('stats', payload);
}

export function decodeRoster(text: string): ContractResult<RosterPayload> {
  const decoded = decodePayload(text, 'roster');
  if (!decoded.ok) return decoded;
  return validateRosterPayload(decoded.value);
}

export function decodeStats(text: string): ContractResult<StatsPayload> {
  const decoded = decodePayload(text, 'stats');
  if (!decoded.ok) return decoded;
  return validateStatsPayload(decoded.value);
}
