// session.js — pure, DOM-free session/game state model, storage envelope and stats payload builder.
// build note: import lines below are for node tests; the inliner strips single-line imports only, so each must stay on one line
import { MAX_ROSTER_PLAYERS, MAX_COUNT, MAX_NAME_LENGTH, ID_PATTERN, fnv1a32, encodePayload, encodeStats, validateStatsPayload, decodeRoster, decodeStats } from './codec.js';
import { ROSTER_VECTOR, STATS_VECTOR } from './vectors.js';

export const STORAGE_KEY = 'coachiq-stats-client';
export const UNREADABLE_KEY = 'coachiq-stats-client.unreadable';
export const SESSION_SCHEMA = 1;
export const APP_VERSION = '1.0.0';
export const MAX_SCORE = 99;
export const UNDO_LIMIT = 200;

const STATS = ['serve', 'return'];
const SIDES = ['in', 'out'];

function zeroCount() {
  return { serve: { in: 0, out: 0 }, return: { in: 0, out: 0 } };
}

function clampCount(n) {
  return Math.max(0, Math.min(MAX_COUNT, n));
}

export function newSession() {
  return { activeGameId: null, games: [] };
}

export function newClientId() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const r = crypto.getRandomValues(new Uint8Array(8));
  return 'cx-' + Array.from(r, (b) => A[b % A.length]).join('');
}

export function formatDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return text;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = Number(m[3]);
  const month = months[Number(m[2]) - 1];
  if (!month) return text;
  return `${day} ${month}`;
}

export function gameLabel(game) {
  return `vs ${game.opponent} · ${formatDate(game.date)}`;
}

function findGame(s, gameId) {
  return s.games.find((g) => g.gameId === gameId);
}

// Returns `s` unchanged (same reference) when `fn` leaves the matching game untouched, so callers
// (e.g. the UI's tap handler) can detect a true no-op with a simple identity check.
function withGame(s, gameId, fn) {
  let changed = false;
  const games = s.games.map((g) => {
    if (g.gameId !== gameId) return g;
    const next = fn(g);
    if (next !== g) changed = true;
    return next;
  });
  return changed ? { ...s, games } : s;
}

export function newGameFromRoster(roster, nowIso) {
  return {
    gameId: roster.gameId,
    team: roster.team,
    opponent: roster.opponent,
    date: roster.date,
    importedAt: nowIso,
    players: roster.players.map((p) => ({ id: p.id, name: p.name, sub: false })),
    sets: [null, null, null],
    activeSet: 1,
    history: [],
    lastExportedAt: null,
  };
}

export function openRoster(s, roster, nowIso) {
  const existing = findGame(s, roster.gameId);
  if (existing) return { kind: 'exists', game: existing };
  const game = newGameFromRoster(roster, nowIso);
  return { kind: 'opened', session: { activeGameId: game.gameId, games: [...s.games, game] } };
}

function hasAnyCount(game, playerId) {
  return game.sets.some((set) => {
    if (!set) return false;
    const c = set.counts[playerId];
    if (!c) return false;
    return c.serve.in + c.serve.out + c.return.in + c.return.out > 0;
  });
}

export function updateRoster(s, gameId, roster) {
  const game = findGame(s, gameId);
  if (!game) return { ok: false, error: 'That game does not exist.' };
  const existingById = new Map(game.players.map((p) => [p.id, p]));
  const rosterIds = new Set(roster.players.map((p) => p.id));
  const fromRoster = roster.players.map((p) => {
    const prior = existingById.get(p.id);
    return { id: p.id, name: p.name, sub: prior ? prior.sub : false };
  });
  const kept = game.players.filter((p) => !rosterIds.has(p.id) && (p.sub || hasAnyCount(game, p.id)));
  const players = [...fromRoster, ...kept];
  if (players.length > MAX_ROSTER_PLAYERS) {
    return { ok: false, error: `Updating would make ${players.length} players; the stats app limit is ${MAX_ROSTER_PLAYERS}.` };
  }
  const session = withGame(s, gameId, (g) => ({ ...g, players }));
  return { ok: true, session };
}

export function setActiveGame(s, gameId) {
  return { ...s, activeGameId: gameId };
}

export function deleteGame(s, gameId) {
  const games = s.games.filter((g) => g.gameId !== gameId);
  const activeGameId = s.activeGameId === gameId ? (games[0] ? games[0].gameId : null) : s.activeGameId;
  return { activeGameId, games };
}

export function setActiveSet(s, gameId, n) {
  return withGame(s, gameId, (g) => ({ ...g, activeSet: n }));
}

// Applies a clamped count delta to `game` with no history side effect; returns `game` unchanged
// (same reference) when the delta is a no-op after clamping. Shared by tap() (which pushes a
// history entry for the actual, post-clamp delta) and undo() (which must NOT push a new entry —
// it only ever pops the one it is reversing).
function applyDelta(game, n, playerId, stat, side, delta) {
  const set = game.sets[n - 1] ?? { score: null, counts: {} };
  const cur = set.counts[playerId] ?? zeroCount();
  const before = cur[stat][side];
  const after = clampCount(before + delta);
  if (after === before) return game;
  const counts = { ...set.counts, [playerId]: { ...cur, [stat]: { ...cur[stat], [side]: after } } };
  const sets = game.sets.slice();
  sets[n - 1] = { ...set, counts };
  return { ...game, sets };
}

export function tap(s, gameId, n, playerId, stat, side, delta) {
  return withGame(s, gameId, (g) => {
    const before = getCount(g, n, playerId)[stat][side];
    const game = applyDelta(g, n, playerId, stat, side, delta);
    if (game === g) return g;
    const after = getCount(game, n, playerId)[stat][side];
    const history = [...game.history, { n, playerId, stat, side, delta: after - before }].slice(-UNDO_LIMIT);
    return { ...game, history };
  });
}

export function undo(s, gameId) {
  const game = findGame(s, gameId);
  if (!game || game.history.length === 0) return { session: s, undone: null };
  const last = game.history[game.history.length - 1];
  const session = withGame(s, gameId, (g) => {
    const reverted = applyDelta(g, last.n, last.playerId, last.stat, last.side, -last.delta);
    return { ...reverted, history: g.history.slice(0, -1) };
  });
  return { session, undone: last };
}

export function setScore(s, gameId, n, score) {
  return withGame(s, gameId, (g) => {
    const set = g.sets[n - 1] ?? { score: null, counts: {} };
    const sets = g.sets.slice();
    sets[n - 1] = { ...set, score: score === null ? null : [score[0], score[1]] };
    return { ...g, sets };
  });
}

export function clearSet(s, gameId, n) {
  return withGame(s, gameId, (g) => {
    const sets = g.sets.slice();
    sets[n - 1] = null;
    const history = g.history.filter((h) => h.n !== n);
    return { ...g, sets, history };
  });
}

export function addSub(s, gameId, name, id) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0) return { ok: false, error: 'Enter a name.' };
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `That name is ${trimmed.length} characters; the limit is ${MAX_NAME_LENGTH}.` };
  }
  const game = findGame(s, gameId);
  if (!game) return { ok: false, error: 'That game does not exist.' };
  if (game.players.length >= MAX_ROSTER_PLAYERS) {
    return { ok: false, error: `This game already has ${MAX_ROSTER_PLAYERS} players; the stats app limit is ${MAX_ROSTER_PLAYERS}.` };
  }
  const playerId = id ?? newClientId();
  const session = withGame(s, gameId, (g) => ({ ...g, players: [...g.players, { id: playerId, name: trimmed, sub: true }] }));
  return { ok: true, session };
}

export function isSetPlayed(setRecord) {
  if (setRecord === null) return false;
  if (setRecord.score !== null) return true;
  return Object.values(setRecord.counts).some((c) => c.serve.in + c.serve.out + c.return.in + c.return.out > 0);
}

export function getCount(game, n, playerId) {
  const set = game.sets[n - 1];
  const c = set && set.counts[playerId];
  return c ? { serve: { in: c.serve.in, out: c.serve.out }, return: { in: c.return.in, out: c.return.out } } : zeroCount();
}

export function buildStatsPayload(game, nowIso) {
  const sets = [];
  game.sets.forEach((set, i) => {
    if (!isSetPlayed(set)) return;
    const players = [];
    for (const p of game.players) {
      const c = set.counts[p.id];
      if (!c) continue;
      if (c.serve.in + c.serve.out + c.return.in + c.return.out === 0) continue;
      players.push({ id: p.id, serve: { in: c.serve.in, out: c.serve.out }, return: { in: c.return.in, out: c.return.out } });
    }
    sets.push({ n: i + 1, score: set.score === null ? null : [set.score[0], set.score[1]], players });
  });
  if (sets.length === 0) {
    return { ok: false, error: 'Nothing recorded yet — tap a count or enter a score first.' };
  }
  const payload = {
    v: 1,
    kind: 'stats',
    gameId: game.gameId,
    recordedAt: nowIso,
    players: game.players.map((p) => ({ id: p.id, name: p.name })),
    sets,
  };
  const valid = validateStatsPayload(payload);
  if (!valid.ok) return valid;
  const summary = [
    gameLabel(game),
    ...sets.map((x) => `Set ${x.n} ${x.score ? `${x.score[0]}–${x.score[1]}` : 'no score'}`),
    `${payload.players.length} player${payload.players.length === 1 ? '' : 's'}`,
  ].join(' · ');
  return { ok: true, value: { text: encodeStats(payload), summary, payload: valid.value } };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCountsMember(value) {
  if (!isPlainObject(value)) return undefined;
  const out = {};
  for (const stat of STATS) {
    const rawStat = value[stat];
    if (!isPlainObject(rawStat)) return undefined;
    const sides = {};
    for (const side of SIDES) {
      const n = rawStat[side];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_COUNT) return undefined;
      sides[side] = n;
    }
    out[stat] = sides;
  }
  return out;
}

function parseSetRecord(value) {
  if (value === null) return null;
  if (!isPlainObject(value)) return undefined;
  let score = null;
  if (value.score !== null) {
    if (!Array.isArray(value.score) || value.score.length !== 2) return undefined;
    const [a, b] = value.score;
    if (typeof a !== 'number' || !Number.isInteger(a) || typeof b !== 'number' || !Number.isInteger(b)) return undefined;
    score = [a, b];
  }
  if (!isPlainObject(value.counts)) return undefined;
  const counts = {};
  for (const [playerId, raw] of Object.entries(value.counts)) {
    const parsed = parseCountsMember(raw);
    if (parsed === undefined) return undefined;
    counts[playerId] = parsed;
  }
  return { score, counts };
}

function parsePlayer(value, seenIds) {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) return undefined;
  if (seenIds.has(value.id)) return undefined;
  if (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > MAX_NAME_LENGTH) return undefined;
  if (typeof value.sub !== 'boolean') return undefined;
  seenIds.add(value.id);
  return { id: value.id, name: value.name, sub: value.sub };
}

function parseHistoryEntry(value) {
  if (!isPlainObject(value)) return undefined;
  if (value.n !== 1 && value.n !== 2 && value.n !== 3) return undefined;
  if (typeof value.playerId !== 'string') return undefined;
  if (value.stat !== 'serve' && value.stat !== 'return') return undefined;
  if (value.side !== 'in' && value.side !== 'out') return undefined;
  if (typeof value.delta !== 'number' || !Number.isInteger(value.delta)) return undefined;
  return { n: value.n, playerId: value.playerId, stat: value.stat, side: value.side, delta: value.delta };
}

function parseGame(value) {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.gameId !== 'string') return undefined;
  if (typeof value.team !== 'string') return undefined;
  if (typeof value.opponent !== 'string') return undefined;
  if (typeof value.date !== 'string') return undefined;
  if (typeof value.importedAt !== 'string') return undefined;
  if (!Array.isArray(value.players) || value.players.length > MAX_ROSTER_PLAYERS) return undefined;
  const seenIds = new Set();
  const players = [];
  for (const raw of value.players) {
    const p = parsePlayer(raw, seenIds);
    if (p === undefined) return undefined;
    players.push(p);
  }
  if (!Array.isArray(value.sets) || value.sets.length !== 3) return undefined;
  const sets = [];
  for (const raw of value.sets) {
    const set = parseSetRecord(raw);
    if (set === undefined) return undefined;
    sets.push(set);
  }
  if (value.activeSet !== 1 && value.activeSet !== 2 && value.activeSet !== 3) return undefined;
  if (!Array.isArray(value.history)) return undefined;
  const history = [];
  for (const raw of value.history) {
    const h = parseHistoryEntry(raw);
    if (h === undefined) return undefined;
    history.push(h);
  }
  if (value.lastExportedAt !== null && typeof value.lastExportedAt !== 'string') return undefined;
  return {
    gameId: value.gameId,
    team: value.team,
    opponent: value.opponent,
    date: value.date,
    importedAt: value.importedAt,
    players,
    sets,
    activeSet: value.activeSet,
    history,
    lastExportedAt: value.lastExportedAt,
  };
}

export function parseSession(text) {
  const MALFORMED = { ok: false, error: 'saved session is malformed' };
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return MALFORMED;
  }
  if (!isPlainObject(envelope)) return MALFORMED;
  if (envelope.schema !== SESSION_SCHEMA) return MALFORMED;
  const session = envelope.session;
  if (!isPlainObject(session)) return MALFORMED;
  if (!Array.isArray(session.games)) return MALFORMED;
  // Per-game salvage: a game that fails validation (or repeats an earlier gameId) is dropped
  // rather than parking the whole saved session — see load() in ui.js for the amber banner this
  // enables. Envelope-level faults (not JSON, wrong schema, games not an array, activeGameId of
  // the wrong type) still fail the whole parse; only individual games are salvageable.
  const games = [];
  let dropped = 0;
  const seenGameIds = new Set();
  for (const raw of session.games) {
    const g = parseGame(raw);
    if (g === undefined || seenGameIds.has(g.gameId)) { dropped++; continue; }
    seenGameIds.add(g.gameId);
    games.push(g);
  }
  if (session.games.length > 0 && games.length === 0) return MALFORMED;
  let activeGameId = session.activeGameId;
  if (activeGameId !== null && typeof activeGameId !== 'string') return MALFORMED;
  if (typeof activeGameId === 'string' && !games.some((g) => g.gameId === activeGameId)) {
    activeGameId = games[0] ? games[0].gameId : null;
  }
  return { ok: true, value: { activeGameId, games }, dropped };
}

export function serialiseSession(s) {
  return JSON.stringify({ schema: SESSION_SCHEMA, savedAt: new Date().toISOString(), session: s });
}

export function runSelfCheck() {
  try {
    if (fnv1a32(new Uint8Array()) !== '811c9dc5') return { ok: false, error: 'fnv1a32 of empty input' };
    if (encodePayload('roster', ROSTER_VECTOR.payload) !== ROSTER_VECTOR.encoded) return { ok: false, error: 'roster vector encode' };
    if (encodeStats(STATS_VECTOR.payload) !== STATS_VECTOR.encoded) return { ok: false, error: 'stats vector encode' };
    const r = decodeRoster(ROSTER_VECTOR.encoded);
    const t = decodeStats(STATS_VECTOR.encoded);
    if (!r.ok || JSON.stringify(r.value) !== JSON.stringify(ROSTER_VECTOR.payload)) return { ok: false, error: 'roster vector decode' };
    if (!t.ok || JSON.stringify(t.value) !== JSON.stringify(STATS_VECTOR.payload)) return { ok: false, error: 'stats vector decode' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
