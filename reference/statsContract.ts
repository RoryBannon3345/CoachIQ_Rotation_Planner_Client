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
 * (see `docs/stats-contract.md`'s versioning policy); adding an optional field does not bump it.
 *
 * Version 2 moves the unit of exchange from one game to a whole **day**: both payloads now carry a
 * `games` list, because the team plays several games in a tournament day and the coach sends one
 * roster and pastes back one stats sheet for all of them. That is a rename-and-restructure of
 * existing fields, not an added optional one, so it earns the bump. Version 1 payloads are still
 * read (`decodeDayRoster`/`decodeDayStats` normalise them — a coach reaching for last week's email
 * is a realistic path); they are no longer produced except by the surviving v1 encoders, which now
 * pin their version explicitly (see `encodePayload`). */
export const CONTRACT_VERSION = 2;

/** The largest pre-selection one game inside a day payload may name — `DayRosterGame.roster`.
 * A day directory can list more players than any one game plays (`MAX_DAY_PLAYERS`); this is the
 * cap on the tick-list the Client shows for a single game, which is what it was always about. In
 * v1, when a payload *was* one game, it bounded the whole payload's `players` instead. */
export const MAX_ROSTER_PLAYERS = 12;

/** The most games one day payload may carry. A tournament day is a handful of games; eight is
 * generously above any real one, and bounds how much a single paste can push into saved state. */
export const MAX_GAMES_PER_DAY = 8;

/** The most players one day payload's directory may name. A day's directory spans every game of
 * the day, so it is legitimately larger than any one game's tick-list (`MAX_ROSTER_PLAYERS`):
 * squads rotate across games and a tournament day can field two teams' worth of names. */
export const MAX_DAY_PLAYERS = 24;

/** The largest legal serve/return count. Three digits is generously above any real set. */
export const MAX_COUNT = 999;

/** The longest legal player name, in both payloads. A name is a label a coach typed on a phone,
 * never a document, so the cap is generous; its job is to stop a buggy or hostile Client from
 * smuggling a megabyte string into saved state, where `persist` swallows a localStorage quota
 * failure and every later save would be lost with it. */
export const MAX_NAME_LENGTH = 64;

/**
 * The longest legal `StatsPayload.recordedAt`.
 *
 * The same threat `MAX_NAME_LENGTH` guards against, on the one other contract string this app
 * copies into saved state: `recordedAt` is an ISO timestamp from the Client's clock, not
 * player-typed text, so it needs far less room than a name — a timestamp with milliseconds and a
 * timezone offset (`2026-09-19T21:04:00.000+01:00`) is under 32 characters, and this leaves real
 * headroom above that. Left uncapped, a buggy or hostile Client smuggling a multi-megabyte
 * `recordedAt` through would balloon the saved file past its `localStorage` quota; `persist`
 * (`useAppStore.ts`) swallows that failure, so every save *after* the oversized one would be
 * silently lost — no `parsePersisted` refusal, no error the coach ever sees, just every edit from
 * then on failing to reach disk.
 */
export const MAX_RECORDED_AT_LENGTH = 32;

/**
 * The most sets one stats payload may record.
 *
 * Deliberately a second declaration of `MAX_SETS` from `src/domain/setCount.ts`, not an import:
 * this module has zero imports because the Client copies it verbatim (see the module docblock),
 * and importing even a constant would make this file differ from the copy the Client runs.
 * `statsContract.test.ts` asserts the two stay equal.
 *
 * Widening this from a literal 3 is **receive-side only**, which is why it needed no
 * `CONTRACT_VERSION` bump: the stats payload flows Client -> planner, so a planner that accepts
 * five sets cannot break a Client that only ever sends three. The Client needs its own change
 * before a four- or five-set payload can exist at all — see `docs/stats-contract.md`.
 */
export const MAX_SETS = 5;

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
  /** 1-based, at most `MAX_SETS`. */
  n: number;
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

/** One game inside a day roster: which of the day's players are on its tick-list. */
export interface DayRosterGame {
  gameId: string;
  opponent: string;
  /**
   * Indices into the payload's own `players`, **not** player ids — the single most likely thing
   * for a later reader (or the Client's author) to "simplify" back into id strings. Do not.
   *
   * This app's ids are **24–25** characters — `generateId` (`src/store/useAppStore.ts`) builds them
   * as `` `${prefix}-${Date.now().toString(36)}-${counter}-${6 random}` `` and the caller passes the
   * full word `player`, so a real one is `player-mu2strf8-7-a8c3d9`; the counter is session-global,
   * so it takes a second digit past the ninth id. Game ids are 22–23 the same way.
   * Re-listing twelve of those per game is by far the roster payload's largest cost, and the roster
   * travels as a `mailto:` body, which several mail clients cut off near 2000 characters. Measured
   * full composed-href lengths for a 12-player day: with id strings, **2123 at two games** — already
   * over — and 2661 at three; with indices, 1321 at two and 1457 at three.
   *
   * **The break point is two games**, which is the most ordinary tournament day there is. That is
   * what makes the index encoding necessary rather than merely prudent: there is no version of a day
   * roster built from id strings that survives an ordinary Saturday. See "Payload size" in
   * `docs/stats-contract.md` for the full table, the per-game costs and the eight-game cap.
   *
   * The stats payload deliberately does **not** do this: it keeps id strings, because it travels
   * by clipboard into a textarea with no length limit, and an off-by-one index there would
   * silently attribute one player's serves to another with nothing able to detect it, whereas a
   * wrong id is caught by the unknown-id refusal in `src/store/importStats.ts`.
   */
  roster: number[];
}

/** The v2 roster payload: one day, the day's player directory, and every game of that day. */
export interface DayRosterPayload {
  v: 2;
  kind: 'roster';
  date: string;
  team: string;
  players: RosterPayloadPlayer[];
  games: DayRosterGame[];
}

/** One game's stats inside a day sheet. Sets are per game: each game starts again at set 1. */
export interface DayStatsGame {
  gameId: string;
  sets: StatsPayloadSet[];
}

/**
 * The v2 stats payload: one day's recording across every game the Client tracked.
 *
 * No `date`, `team` or `opponent`: the import matches each game on `gameId` and the planner
 * already knows the rest, so re-sending them would only create a second source of truth for facts
 * the planner owns.
 */
export interface DayStatsPayload {
  v: 2;
  kind: 'stats';
  recordedAt: string;
  players: { id: string; name: string }[];
  games: DayStatsGame[];
}

/** The encoded-form prefix per kind — also how `decodePayload` tells the two apart before
 * touching the body. */
const PREFIX: Record<PayloadKind, string> = { roster: 'CIQR', stats: 'CIQS' };

/** Coach-readable name for each kind, used in the kind-mismatch error. */
const KIND_LABEL: Record<PayloadKind, string> = { roster: 'roster payload', stats: 'stats payload' };

/** Which app authors each kind, for the "made by a newer version" message. A roster is made by the
 * Rotation Planner and a stats sheet by the stats app, so naming the stats app for both — what
 * this file used to do — told a coach on the Client side to go and update the wrong app. The kind
 * alone decides it, so the one file both apps run verbatim produces the right words on each side. */
const AUTHOR_LABEL: Record<PayloadKind, string> = { roster: 'the Rotation Planner', stats: 'the stats app' };

/**
 * The one message for every way the body can fail to be trustworthy JSON (bad base64, checksum
 * mismatch, unparsable JSON, or an inner `v`/`kind` that disagrees with the prefix) — a coach
 * cannot act on "unexpected token" but can act on "copy it again".
 *
 * Kind-aware for the same reason the newer-version message two branches below is: the instruction
 * is *where to copy it again from*, and a roster comes from the Rotation Planner, not from the
 * stats app. Naming the stats app for both — what this used to do — sent a coach on the Client
 * side back to the wrong app, which is worse than saying nothing. `expected`, not the decoded
 * kind: on a payload this corrupt the prefix may be the only thing worth trusting, and the caller
 * has already told us which app it believes it is reading.
 */
function corrupt(expected: PayloadKind): string {
  return `This payload is corrupted or incomplete — copy it again from ${AUTHOR_LABEL[expected]}.`;
}

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
 * a few thousand bytes, and a day sheet is an order of magnitude past that — a 3-game, 3-set,
 * 12-player day encodes to roughly 13,200 characters. The loop matters more at v2, not less. */
function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns `null` (never throws) on anything that is not valid Base64URL, so callers can fold it
 * into the single `corrupt` message rather than a JSON/base64-specific one. */
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

/**
 * Encodes any already-shaped JSON value under the given kind's prefix and a contract version.
 * `encodeDayRoster`/`encodeDayStats` are the typed v2 callers; this one is also what the tests use
 * to construct deliberately-invalid payloads (e.g. a body whose `v` disagrees with the prefix).
 *
 * `version` exists because the prefix version and the body's own `v` must agree — `decodePayload`
 * cross-checks them and calls any disagreement corruption. Once `CONTRACT_VERSION` became 2, a v1
 * body encoded with the default would go out as `CIQS2.` wrapped around `"v":1` and be refused by
 * this very module. So the surviving v1 encoders (`encodeRoster`/`encodeStats`) pass `1`
 * explicitly, which is also what keeps the v1 golden vectors in `__fixtures__/vectors.ts`
 * byte-identical. Production v2 callers never pass it.
 */
export function encodePayload(kind: PayloadKind, json: unknown, version: number = CONTRACT_VERSION): string {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return `${PREFIX[kind]}${version}.${toBase64Url(bytes)}.${fnv1a32(bytes)}`;
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
  if (prefixLetter === undefined || versionText === undefined) return { ok: false, error: corrupt(expected) };
  const kind: PayloadKind = prefixLetter === 'CIQR' ? 'roster' : 'stats';
  if (kind !== expected) {
    return { ok: false, error: `This is a ${KIND_LABEL[kind]}, not a ${KIND_LABEL[expected]}.` };
  }
  const version = Number(versionText);
  if (version > CONTRACT_VERSION) {
    return {
      ok: false,
      error: `This payload was made by a newer version of ${AUTHOR_LABEL[expected]} (contract ${version}); this app understands ${CONTRACT_VERSION}.`,
    };
  }
  const m = /^(CIQ[RS])(\d+)\.([A-Za-z0-9_-]*)\.([0-9a-f]{8})$/.exec(compact);
  if (m === null) return { ok: false, error: corrupt(expected) };
  const body = m[3];
  const digest = m[4];
  if (body === undefined || digest === undefined) return { ok: false, error: corrupt(expected) };
  const bytes = fromBase64Url(body);
  if (bytes === null || fnv1a32(bytes) !== digest) return { ok: false, error: corrupt(expected) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, error: corrupt(expected) };
  }
  // The body's own `v`/`kind` must agree with what the prefix already promised — a hand-edited
  // or mismatched body is corruption, not a different, valid payload.
  if (!isRecord(parsed) || parsed.v !== version || parsed.kind !== kind) return { ok: false, error: corrupt(expected) };
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

/**
 * A string with something in it — the check both validators apply, at **both** contract versions,
 * to the field that identifies their payload: `date` on a roster and `recordedAt` on a stats
 * sheet. A non-string and an empty string are the same fault and carry the same message
 * (`it has no date` / `it has no recorded time`): neither is a date, and there is nothing to
 * print for either.
 *
 * Requiring this of **v1** as well is a tightening, not a widening, and needed no
 * `CONTRACT_VERSION` bump of its own — the same shape of change as `parseScore`'s finiteness rule
 * and `MAX_RECORDED_AT_LENGTH` (`docs/stats-contract.md`, "Finite set scores" and "Bounded
 * `recordedAt`"). Every payload a real sender has ever produced already carries both: a roster's
 * date is a `Game.date`, which is an ISO `yyyy-mm-dd` the app itself wrote, and `recordedAt` is
 * the Client's clock. So nothing legal before is refused now.
 *
 * Why it matters enough to change v1 at all: without it, `normaliseStatsV1`/`normaliseRosterV1`
 * would be *nearly* total instead of total. v1 would accept `date: ''`, normalisation would lift
 * it into the day shape, and the v2 validator — which cannot accept a blank date, because the date
 * is the identity of a day payload — would refuse it. Both `src/store/importStats.ts` and
 * `src/store/useAppStore.ts` re-validate a payload they were already handed, so that refusal would
 * land *mid-import*, after the coach had already been shown a preview of the very payload the app
 * then rejected: the worst place to discover it and the one failure the normalisation path exists
 * to make impossible. Closing it on the v1 side keeps every accepted v1 payload normalisable,
 * which is the property `statsContract.test.ts` asserts directly.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
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
 * caller can tell "no score" from "not a score" with a plain `=== undefined` check.
 *
 * Both entries must be **finite**: `typeof NaN === 'number'` and `typeof Infinity === 'number'`,
 * so a bare `typeof` check (what this used to be) lets both through. That is not a harmless
 * looseness — `JSON.parse` turns the numeral `1e999` into `Infinity`, so a *paste* can carry a
 * score this loose, not just a hand-built object, and a non-finite score does real damage later:
 * it survives fine in memory and can be written straight into a game's own `MatchSet.score`
 * (`useAppStore.ts`'s `importDayStats`), but `JSON.stringify` serialises `Infinity`/`NaN` as
 * `null`, so the *next* `parsePersisted` sees `[null, 21]`, which `isLegalScore`
 * (`persistence.ts`) refuses — the same fresh-seed-overwrites-the-coach's-save failure as every
 * other gap this app works to close on the stats-import path. Not required to be an integer:
 * `isLegalScore` on the load side doesn't require one either (a fractional score like `[25.5,
 * 21]` is meaningless for volleyball but round-trips harmlessly), so adding that requirement only
 * here would be an asymmetric tightening this module has no way to enforce on the other side. */
function parseScore(value: unknown): [number, number] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [a, b] = value;
  if (typeof a !== 'number' || typeof b !== 'number') return undefined;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return [a, b];
}

export function validateRosterPayload(value: unknown): ContractResult<RosterPayload> {
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
  if (!isNonEmptyString(value.recordedAt)) return malformed('stats', 'it has no recorded time');
  if (value.recordedAt.length > MAX_RECORDED_AT_LENGTH) {
    return malformed('stats', `its recorded time is ${value.recordedAt.length} characters; the limit is ${MAX_RECORDED_AT_LENGTH}`);
  }
  if (!Array.isArray(value.players)) return malformed('stats', 'it has no player list');
  // Non-empty, the way `validateRosterPayload` has always required and `parseDayPlayerList`
  // requires on the v2 path. This check was simply absent here: a stats payload naming nobody
  // passed v1, and a sheet with no players in it records nothing anyway.
  //
  // Added as a tightening for the same reason as `isNonEmptyString` — it is the last thing
  // standing between `normaliseStatsV1` and totality. Without it, `{ players: [], sets: [...] }`
  // is accepted by v1, normalises, and is then refused by the v2 validator with
  // `it names no players`, landing mid-import after the coach has already seen a preview.
  //
  // Worth recording that this was a real collision between the two specs, not a slip in one
  // implementation: `docs/stats-contract.md` listed `it names no players` in the roster catalogue
  // and deliberately omitted it from the stats one. The doc now carries it in the stats catalogue
  // too, marked "added 2026-09-15", with the reasoning in the dated entry "`it names no players`
  // for stats (2026-09-15)" under Versioning policy. The string itself is not new wording, only
  // newly reachable for a stats payload.
  if (value.players.length === 0) return malformed('stats', 'it names no players');
  // The list echoes the roster the Client was handed (spec §4). `MAX_ROSTER_PLAYERS` bounds it
  // here unconditionally, not because every sender is assumed to respect the cap — this file is
  // the one thing both apps trust to enforce it regardless of what produced the payload, so a
  // longer list is refused before a payload of any size can reach saved state, whoever sent it
  // (see `docs/stats-contract.md`'s Planner-side exception for a sender that now knowingly
  // exceeds it on purpose).
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
  if (value.sets.length > MAX_SETS) return malformed('stats', `it records more than ${MAX_SETS} sets`);

  const sets: StatsPayloadSet[] = [];
  let previousN = 0;
  for (const rawSet of value.sets) {
    if (!isRecord(rawSet)) return malformed('stats', 'one of its sets is malformed');
    const n = rawSet.n;
    // `typeof n !== 'number'` first: `n` is `unknown` here (the old `n !== 1 && n !== 2 && n !==
    // 3` membership test narrowed it for free; a range check does not), and `previousN` below must
    // be assigned from a genuine `number`, not an `unknown` the comparison operators merely permit.
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

/** Encodes a v1 roster. The explicit `1` is not decoration: `CONTRACT_VERSION` is 2 now, and
 * without it this would emit a `CIQR2.` prefix around a body saying `"v":1`, which
 * `decodePayload`'s own cross-check refuses as corruption. */
export function encodeRoster(payload: RosterPayload): string {
  return encodePayload('roster', payload, 1);
}

/** Encodes a v1 stats sheet. See `encodeRoster` for why the version is pinned. */
export function encodeStats(payload: StatsPayload): string {
  return encodePayload('stats', payload, 1);
}

/** Encodes a day roster at the current contract version — no pin, because a v2 payload's `v` and
 * `CONTRACT_VERSION` are the same number by definition. */
export function encodeDayRoster(payload: DayRosterPayload): string {
  return encodePayload('roster', payload);
}

/** Encodes a day stats sheet at the current contract version. See `encodeDayRoster`. */
export function encodeDayStats(payload: DayStatsPayload): string {
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

// ---------------------------------------------------------------------------------------------
// Contract v2 — day-scoped payloads. Same transport, same field-by-field validation style, same
// rule that the returned value is rebuilt field by field and never spread; the unit of exchange is
// a whole tournament day rather than a single game.
// ---------------------------------------------------------------------------------------------

/** The one version detail both v2 validators and both day decoders report. Deliberately names
 * *both* versions this app reads rather than only the one being validated: a coach who pasted the
 * wrong thing needs to know what is acceptable, not which branch refused her. */
const NOT_A_KNOWN_VERSION = 'its version is not 1 or 2';

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
function parseDayPlayerList(
  kind: PayloadKind,
  value: unknown,
  withJersey: boolean,
): ContractResult<RosterPayloadPlayer[]> {
  if (!Array.isArray(value)) return malformed(kind, 'it has no player list');
  if (value.length === 0) return malformed(kind, 'it names no players');
  if (value.length > MAX_DAY_PLAYERS) {
    return malformed(kind, `it names ${value.length} players; the day limit is ${MAX_DAY_PLAYERS}`);
  }
  const players: RosterPayloadPlayer[] = [];
  const seenIds = new Set<string>();
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

export function validateDayRosterPayload(value: unknown): ContractResult<DayRosterPayload> {
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

  const games: DayRosterGame[] = [];
  const seenGameIds = new Set<string>();
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
    const roster: number[] = [];
    const seenIndices = new Set<number>();
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

export function validateDayStatsPayload(value: unknown): ContractResult<DayStatsPayload> {
  if (!isRecord(value)) return malformed('stats', 'it is not an object');
  if (value.v !== 2) return malformed('stats', NOT_A_KNOWN_VERSION);
  if (value.kind !== 'stats') return malformed('stats', 'its kind is not "stats"');
  if (!isNonEmptyString(value.recordedAt)) return malformed('stats', 'it has no recorded time');
  if (value.recordedAt.length > MAX_RECORDED_AT_LENGTH) {
    return malformed('stats', `its recorded time is ${value.recordedAt.length} characters; the limit is ${MAX_RECORDED_AT_LENGTH}`);
  }

  const directory = parseDayPlayerList('stats', value.players, false);
  if (!directory.ok) return directory;
  const players: { id: string; name: string }[] = directory.value.map((p) => ({ id: p.id, name: p.name }));
  const playerIds = new Set(players.map((p) => p.id));

  if (!Array.isArray(value.games)) return malformed('stats', 'it has no game list');
  if (value.games.length === 0) return malformed('stats', 'it records no games');
  if (value.games.length > MAX_GAMES_PER_DAY) {
    return malformed('stats', `it records more than ${MAX_GAMES_PER_DAY} games`);
  }

  const games: DayStatsGame[] = [];
  const seenGameIds = new Set<string>();
  for (const rawGame of value.games) {
    if (!isRecord(rawGame)) return malformed('stats', 'one of its games is malformed');
    const gid = rawGame.gameId;
    if (typeof gid !== 'string' || gid.length === 0) return malformed('stats', 'one of its games has no id');
    if (seenGameIds.has(gid)) return malformed('stats', `game id "${gid}" appears twice`);
    seenGameIds.add(gid);

    if (!Array.isArray(rawGame.sets)) return malformed('stats', `game "${gid}" has no set list`);
    if (rawGame.sets.length === 0) return malformed('stats', `game "${gid}" records no sets`);
    if (rawGame.sets.length > MAX_SETS) return malformed('stats', `game "${gid}" records more than ${MAX_SETS} sets`);

    const sets: StatsPayloadSet[] = [];
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
      const lines: StatsPayloadLine[] = [];
      const seenInSet = new Set<string>();
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
 * one `validateDayStatsPayload` accepts. `importStats.ts` and `useAppStore.ts` both re-validate a
 * payload they were already handed, so a normalised v1 goes back through the v2 validator on the
 * way in; if this could emit something that validator refuses, the app would reject the very
 * payload the dialog had just previewed as importable. `isNonEmptyString` is what closes the last
 * gap (an empty `recordedAt`, which v1 used to accept), and `statsContract.test.ts` asserts the
 * property directly rather than trusting it.
 */
export function normaliseStatsV1(p: StatsPayload): DayStatsPayload {
  return {
    v: 2,
    kind: 'stats',
    recordedAt: p.recordedAt,
    players: p.players,
    games: [{ gameId: p.gameId, sets: p.sets }],
  };
}

/**
 * The roster equivalent of `normaliseStatsV1`, and total for the same reason: a v1 roster is a
 * one-game day whose directory is that game's players, so every index `0..n-1` is on its
 * tick-list, and `date`/`team` lift to the top. v1's own 12-player cap lands exactly on
 * `MAX_ROSTER_PLAYERS` as the v2 per-game cap, so even a full v1 roster normalises to a legal
 * game. The planner does not call `decodeRoster` outside tests, but the Client does, and a coach
 * reaching for last week's roster email is a realistic path worth keeping open.
 */
export function normaliseRosterV1(p: RosterPayload): DayRosterPayload {
  return {
    v: 2,
    kind: 'roster',
    date: p.date,
    team: p.team,
    players: p.players,
    games: [{ gameId: p.gameId, opponent: p.opponent, roster: p.players.map((_, i) => i) }],
  };
}

/** The decoded body's own `v`, which `decodePayload` has already proved equals the prefix version.
 * Read as `unknown` because a hand-edited body can carry anything a JSON number can. */
function bodyVersion(value: unknown): unknown {
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
export function decodeDayRoster(text: string): ContractResult<DayRosterPayload> {
  const decoded = decodePayload(text, 'roster');
  if (!decoded.ok) return decoded;
  const version = bodyVersion(decoded.value);
  if (version === 1) {
    const v1 = validateRosterPayload(decoded.value);
    if (!v1.ok) return v1;
    return { ok: true, value: normaliseRosterV1(v1.value) };
  }
  if (version === 2) return validateDayRosterPayload(decoded.value);
  return malformed('roster', NOT_A_KNOWN_VERSION);
}

/** The stats half of `decodeDayRoster` — see there for why dispatching on the body's `v` is safe. */
export function decodeDayStats(text: string): ContractResult<DayStatsPayload> {
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
