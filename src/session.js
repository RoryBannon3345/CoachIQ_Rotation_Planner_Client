// session.js — pure, DOM-free day/session state model, storage envelope and stats payload builder.
// build note: import lines below are for node tests; the inliner strips single-line imports only, so each must stay on one line
import { MAX_ROSTER_PLAYERS, MAX_COUNT, MAX_NAME_LENGTH, MAX_SETS, MAX_DAY_PLAYERS, MAX_GAMES_PER_DAY, ID_PATTERN, CLIENT_ID_PATTERN, fnv1a32, encodeRoster, encodeStats, encodeDayRoster, encodeDayStats, validateDayStatsPayload, decodeDayRoster, decodeDayStats, maskMembers } from './codec.js';
import { ROSTER_VECTOR, STATS_VECTOR, ROSTER_V2_VECTOR, STATS_V2_VECTOR, ROSTER_V1_AS_DAY, STATS_V1_AS_DAY, ROSTER_V3_VECTOR, ROSTER_V2_AS_V3 } from './vectors.js';

export const STORAGE_KEY = 'coachiq-stats-client';
export const UNREADABLE_KEY = 'coachiq-stats-client.unreadable';
export const SESSION_SCHEMA = 3;
export const APP_VERSION = '3.0.0';
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

// The session IS the day: one roster paste in the morning, one stats payload back at night.
// `date` is the identity of the day — null only for the empty, pre-paste state.
export function newSession() {
  return {
    date: null,
    team: '',
    players: [],
    games: [],
    activeGameId: null,
    importedAt: null,
    lastExportedAt: null,
    lastChangedAt: null,
  };
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

// Both `opponent` and `team` may legally be empty, so this must never print `vs  · 19 Sep`.
export function gameLabel(game, i) {
  return game.opponent ? `vs ${game.opponent}` : `Game ${i + 1}`;
}

/** How many set tabs this game has. `sets.length` from the roster is authoritative, but a game
 * whose count was later reduced by a re-sent roster keeps whatever it needs to show recorded
 * data — see `mergeDayRoster`. */
export function gameSetCount(game) {
  return game.setCount;
}

/** Everyone this game names across its live sets, in directory order is the caller's job — this
 * returns first-seen order, which is what the 12-player cap counts. The cap is the union across
 * sets, exactly as `validateDayRosterPayload` measures it with `maskCount(union, …)`; a per-set
 * cap would let us build a day the planner then refuses. */
export function gamePlayerIdsUnion(game) {
  const seen = [];
  for (let i = 0; i < game.setCount; i += 1) {
    for (const id of game.setPlayerIds[i]) if (!seen.includes(id)) seen.push(id);
  }
  return seen;
}

/** Is `n` a 1-based set number naming a real slot? Bounded by MAX_SETS, the storage shape, not by
 * the game's own `setCount` — clamping to what a game currently shows is `setActiveSet`'s job. */
function isSetSlot(n) {
  return Number.isInteger(n) && n >= 1 && n <= MAX_SETS;
}

/** The highest slot index holding a played set, or -1 when nothing is recorded. */
function highestPlayedSlot(game) {
  let highest = -1;
  game.sets.forEach((set, i) => { if (isSetPlayed(set)) highest = i; });
  return highest;
}

/** `setPlayerIds` padded to MAX_SETS. Slots beyond `setCount` are retained rather than dropped,
 * so a count that later grows back does not lose ticks the coach already made. */
function padSetPlayerIds(lists) {
  const out = [];
  for (let i = 0; i < MAX_SETS; i += 1) out.push(lists[i] ? [...lists[i]] : []);
  return out;
}

export function dayLabel(day) {
  return `${day.team ? day.team + ' · ' : ''}${formatDate(day.date)}`;
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

/** Counts in one specific set. Un-ticking is guarded per set now: a girl who played set 1 may
 * legitimately be taken off set 2's list, and refusing that would make the per-set tick-list
 * unusable after the first tap. */
function hasCountInSet(game, n, playerId) {
  const set = game.sets[n - 1];
  if (!set) return false;
  const c = set.counts[playerId];
  if (!c) return false;
  return c.serve.in + c.serve.out + c.return.in + c.return.out > 0;
}

// ---------------------------------------------------------------------------------------------
// Step 1 — ingest
// ---------------------------------------------------------------------------------------------

/** `roster` is always a v3 day roster payload — `decodeDayRoster` normalises v1 and v2 before it
 * ever reaches here, so nothing below branches on a version. */
export function newDayFromRoster(roster, nowIso) {
  const directory = roster.players.map((p) => ({ id: p.id, name: p.name, sub: false }));
  const size = directory.length;
  const games = roster.games.map((g) => ({
    gameId: g.gameId,
    opponent: g.opponent,
    // sets.length is the one and only source of truth for how many sets this game has, and
    // different games in the same day legitimately differ.
    setCount: g.sets.length,
    // Mask -> ids, resolved exactly once, here at ingest. validateDayRosterPayload has already
    // proved every mask is in range, so maskMembers cannot name a player outside the directory.
    setPlayerIds: padSetPlayerIds(g.sets.map((mask) => maskMembers(mask, size).map((i) => directory[i].id))),
    sets: Array(MAX_SETS).fill(null),
    activeSet: 1,
    history: [],
  }));
  return {
    date: roster.date,
    team: roster.team,
    players: directory,
    games,
    activeGameId: games[0] ? games[0].gameId : null,
    importedAt: nowIso,
    lastExportedAt: null,
    lastChangedAt: null,
  };
}

// === newDayFromRoster, named for the call site (`openDayRoster`'s `otherDay` confirmation).
export function replaceDay(s, roster, nowIso) {
  return newDayFromRoster(roster, nowIso);
}

export function hasUnexportedStats(day) {
  return (
    day.games.some((g) => g.sets.some(isSetPlayed)) &&
    (day.lastExportedAt === null || day.lastChangedAt > day.lastExportedAt)
  );
}

/**
 * Same-date merge, non-destructive by construction: never removes a directory player or a game,
 * only refreshes/adds. Returns `{ ok: false, error }` when a cap the merge would break is hit.
 */
function mergeDayRoster(s, roster) {
  // Directory: refresh name on an existing id (the planner owns names), append ids that are new.
  // Never remove anyone — a local cx- sub, or a girl the planner has since dropped, stays.
  const directory = s.players.map((p) => ({ ...p }));
  const indexById = new Map(directory.map((p, i) => [p.id, i]));
  let addedPlayers = 0;
  for (const rp of roster.players) {
    const idx = indexById.get(rp.id);
    if (idx === undefined) {
      indexById.set(rp.id, directory.length);
      directory.push({ id: rp.id, name: rp.name, sub: false });
      addedPlayers++;
    } else {
      directory[idx] = { ...directory[idx], name: rp.name };
    }
  }
  if (directory.length > MAX_DAY_PLAYERS) {
    return { ok: false, error: `Updating would make ${directory.length} players; the day limit is ${MAX_DAY_PLAYERS}.` };
  }
  const subLookup = new Map(directory.map((p) => [p.id, p.sub]));

  // Games already present (matched on gameId): keep sets/history/activeSet, take the new opponent.
  // Each set's new tick list = that set's incoming ids, plus anyone already ticked there who has
  // counts in THAT set or is a sub.
  const matchedGames = s.games.map((g) => {
    const rg = roster.games.find((x) => x.gameId === g.gameId);
    if (!rg) return g; // a local game the roster no longer names: keep it, untouched.
    const incoming = rg.sets.map((mask) => maskMembers(mask, roster.players.length).map((i) => roster.players[i].id));
    // Never below what is already recorded: mergeDayRoster is non-destructive by construction,
    // and dropping a tab would hide counts that buildDayStatsPayload still exports.
    const setCount = Math.max(incoming.length, highestPlayedSlot(g) + 1);
    const setPlayerIds = padSetPlayerIds(
      g.setPlayerIds.map((existing, i) => {
        const merged =
          i >= incoming.length // a set the new roster does not describe
            ? existing
            : [...incoming[i], ...existing.filter((id) => !incoming[i].includes(id) && (hasCountInSet(g, i + 1, id) || subLookup.get(id)))];
        // A slot at or beyond the new count is a tab the UI does not render, so a tick parked
        // there is one the coach can neither see nor take off. Letting it ride would give the
        // game invisible names that `gamePlayerIdsUnion` ignores but that a later re-grow
        // resurrects into a cap refusal she has no action available to satisfy. Only recorded
        // counts survive up here — and by construction (setCount >= highestPlayedSlot + 1)
        // there are none, so this drops ticks and never a count.
        return i >= setCount ? merged.filter((id) => hasCountInSet(g, i + 1, id)) : merged;
      }),
    );
    // A slot at or beyond the new count is provably unplayed (setCount >= highestPlayedSlot + 1,
    // so no i >= setCount can be the highest-played slot), so nulling its record here — same as
    // clearSet — discards no score and no count, only leftover zeroed counts a minus-mode netback
    // may have left behind.
    const sets = g.sets.map((set, i) => (i >= setCount ? null : set));
    // Mirror clearSet: a slot the merge just retired must not leave a history entry stamped at
    // it, or undo/export can resurrect a tab the UI no longer shows (see mergeDayRoster's tests).
    const history = g.history.filter((h) => h.n <= setCount);
    return { ...g, opponent: rg.opponent, setCount, setPlayerIds, sets, history };
  });
  for (const g of matchedGames) {
    const named = gamePlayerIdsUnion(g).length;
    if (named > MAX_ROSTER_PLAYERS) {
      return {
        ok: false,
        error: `Updating "${g.opponent || g.gameId}" would make ${named} players; the game limit is ${MAX_ROSTER_PLAYERS}.`,
      };
    }
  }

  // A new game: appended.
  const newRosterGames = roster.games.filter((rg) => !s.games.some((g) => g.gameId === rg.gameId));
  const appendedGames = newRosterGames.map((rg) => ({
    gameId: rg.gameId,
    opponent: rg.opponent,
    setCount: rg.sets.length,
    setPlayerIds: padSetPlayerIds(rg.sets.map((mask) => maskMembers(mask, roster.players.length).map((i) => roster.players[i].id))),
    sets: Array(MAX_SETS).fill(null),
    activeSet: 1,
    history: [],
  }));
  const games = [...matchedGames, ...appendedGames];
  if (games.length > MAX_GAMES_PER_DAY) {
    return { ok: false, error: `Updating would make ${games.length} games; the day limit is ${MAX_GAMES_PER_DAY}.` };
  }

  const activeGameId = games.some((g) => g.gameId === s.activeGameId) ? s.activeGameId : games[0] ? games[0].gameId : null;

  // team takes the incoming value; lastChangedAt untouched — a roster merge adds no stats.
  const session = { ...s, team: roster.team, players: directory, games, activeGameId };
  return { ok: true, session, added: { games: appendedGames.length, players: addedPlayers } };
}

export function openDayRoster(s, roster, nowIso) {
  if (s.date === null) {
    return { kind: 'opened', session: newDayFromRoster(roster, nowIso) };
  }
  // Deliberate edge: a roster with the same date but a different team still merges — the spec
  // makes `date` the identity of a day payload, not `team`.
  if (roster.date === s.date) {
    const merged = mergeDayRoster(s, roster);
    if (!merged.ok) return { kind: 'error', error: merged.error };
    return { kind: 'sameDay', session: merged.session, added: merged.added };
  }
  return { kind: 'otherDay', roster, unexported: hasUnexportedStats(s) };
}

// ---------------------------------------------------------------------------------------------
// Step 2 — the tick list and subs
// ---------------------------------------------------------------------------------------------

export function setPlayerTicked(s, gameId, n, playerId, ticked) {
  const game = findGame(s, gameId);
  if (!game) return { ok: false, error: 'That game does not exist.' };
  // Total, like every other failure path here: an out-of-range set must come back as a refusal,
  // not a TypeError off the end of `setPlayerIds`.
  if (!isSetSlot(n)) return { ok: false, error: 'That set does not exist.' };
  const current = game.setPlayerIds[n - 1];
  if (ticked) {
    if (current.includes(playerId)) return { ok: true, session: s };
    // The cap is the union across sets, matching validateDayRosterPayload's maskCount(union, …).
    // Somebody already named by another set costs nothing to add here.
    const union = gamePlayerIdsUnion(game);
    if (!union.includes(playerId) && union.length >= MAX_ROSTER_PLAYERS) {
      return { ok: false, error: `This game already has ${MAX_ROSTER_PLAYERS} players; the stats app limit is ${MAX_ROSTER_PLAYERS}.` };
    }
    const session = withGame(s, gameId, (g) => {
      const setPlayerIds = g.setPlayerIds.slice();
      setPlayerIds[n - 1] = [...current, playerId];
      return { ...g, setPlayerIds };
    });
    return { ok: true, session };
  }
  if (!current.includes(playerId)) return { ok: true, session: s };
  // The refusal is the safeguard: buildDayStatsPayload derives lines from what is recorded, and a
  // player hidden from the record screen while her counts sat in sets[n].counts would be a silent
  // inconsistency the coach could not see. Scoped to this set — she may still be off set 2's list.
  if (hasCountInSet(game, n, playerId)) {
    const player = s.players.find((p) => p.id === playerId);
    const name = player ? player.name : playerId;
    return { ok: false, error: `${name} has counts in Set ${n} — clear the set first to take her off.` };
  }
  const session = withGame(s, gameId, (g) => {
    const setPlayerIds = g.setPlayerIds.slice();
    setPlayerIds[n - 1] = current.filter((id) => id !== playerId);
    return { ...g, setPlayerIds };
  });
  return { ok: true, session };
}

export function addSub(s, gameId, n, name, id) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0) return { ok: false, error: 'Enter a name.' };
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `That name is ${trimmed.length} characters; the limit is ${MAX_NAME_LENGTH}.` };
  }
  const game = findGame(s, gameId);
  if (!game) return { ok: false, error: 'That game does not exist.' };
  if (!isSetSlot(n)) return { ok: false, error: 'That set does not exist.' };
  // Section 5 rule 3 made enforceable: a cx- id minted for somebody already in the directory
  // under her real id imports at the planner as a stranger, and by then the two are indistinguishable.
  const lower = trimmed.toLowerCase();
  if (s.players.some((p) => p.name.toLowerCase() === lower)) {
    return { ok: false, error: `Someone called ${trimmed} is already in today's players — tick her instead.` };
  }
  if (s.players.length >= MAX_DAY_PLAYERS) {
    return { ok: false, error: `Today already has ${MAX_DAY_PLAYERS} players; the day limit is ${MAX_DAY_PLAYERS}.` };
  }
  if (gamePlayerIdsUnion(game).length >= MAX_ROSTER_PLAYERS) {
    return { ok: false, error: `This game already has ${MAX_ROSTER_PLAYERS} players; the stats app limit is ${MAX_ROSTER_PLAYERS}.` };
  }
  const playerId = id ?? newClientId();
  // She joins the set she was added to, and only that one — a sub who comes on for set 3 is not
  // in sets 1 and 2, and assuming otherwise would pre-tick her into sets she never played.
  const session = {
    ...s,
    players: [...s.players, { id: playerId, name: trimmed, sub: true }],
    games: s.games.map((g) => {
      if (g.gameId !== gameId) return g;
      const setPlayerIds = g.setPlayerIds.slice();
      setPlayerIds[n - 1] = [...setPlayerIds[n - 1], playerId];
      return { ...g, setPlayerIds };
    }),
  };
  return { ok: true, session };
}

// ---------------------------------------------------------------------------------------------
// Step 3 — five sets, tap/undo/score machinery (unchanged except the slot count), deletion
// ---------------------------------------------------------------------------------------------

export function setActiveGame(s, gameId) {
  return { ...s, activeGameId: gameId };
}

export function deleteGame(s, gameId) {
  const games = s.games.filter((g) => g.gameId !== gameId);
  // A day with no games is not a day — the paste screen needs a coherent empty state to return to.
  if (games.length === 0) return newSession();
  const activeGameId = s.activeGameId === gameId ? games[0].gameId : s.activeGameId;
  return { ...s, activeGameId, games };
}

export function setActiveSet(s, gameId, n) {
  return withGame(s, gameId, (g) => (n < 1 || n > g.setCount ? g : { ...g, activeSet: n }));
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

// ---------------------------------------------------------------------------------------------
// Step 4 — buildDayStatsPayload
// ---------------------------------------------------------------------------------------------

export function buildDayStatsPayload(day, nowIso) {
  const gamesOut = [];
  const usedIds = new Set();
  for (const game of day.games) {
    const sets = [];
    // i + 1 per game — set numbers are scoped to a game, never to a day; every game restarts at 1.
    game.sets.forEach((set, i) => {
      if (!isSetPlayed(set)) return;
      const lines = [];
      // Lines iterate day directory order, deriving from `counts` (not the tick lists), so no
      // recorded stat can ever be lost to a tick-list edit.
      for (const p of day.players) {
        const c = set.counts[p.id];
        if (!c) continue;
        if (c.serve.in + c.serve.out + c.return.in + c.return.out === 0) continue;
        lines.push({ id: p.id, serve: { in: c.serve.in, out: c.serve.out }, return: { in: c.return.in, out: c.return.out } });
        usedIds.add(p.id);
      }
      sets.push({ n: i + 1, score: set.score === null ? null : [set.score[0], set.score[1]], players: lines });
    });
    if (sets.length === 0) continue; // games with no played set are omitted entirely
    gamesOut.push({ gameId: game.gameId, sets });
  }
  if (gamesOut.length === 0) {
    return { ok: false, error: 'Nothing recorded yet — tap a count or enter a score first.' };
  }
  // The directory sent = entries named by at least one emitted line. Fall back to the whole
  // directory for a day of score-only sets (legal): players must never be empty.
  const playersOut =
    usedIds.size > 0
      ? day.players.filter((p) => usedIds.has(p.id)).map((p) => ({ id: p.id, name: p.name }))
      : day.players.map((p) => ({ id: p.id, name: p.name }));
  const payload = { v: 2, kind: 'stats', recordedAt: nowIso, players: playersOut, games: gamesOut };
  const valid = validateDayStatsPayload(payload);
  if (!valid.ok) return valid;
  const totalSets = gamesOut.reduce((sum, g) => sum + g.sets.length, 0);
  const summary = [
    dayLabel(day),
    `${gamesOut.length} game${gamesOut.length === 1 ? '' : 's'}`,
    `${totalSets} set${totalSets === 1 ? '' : 's'}`,
    `${playersOut.length} player${playersOut.length === 1 ? '' : 's'}`,
  ].join(' · ');
  // Encode the validated, rebuilt object — not the pre-validation `payload` — so the returned
  // `.text` and `.payload` can never diverge even if a future validator change stops rebuilding
  // in the same key order.
  return { ok: true, value: { text: encodeDayStats(valid.value), summary, payload: valid.value } };
}

// ---------------------------------------------------------------------------------------------
// Step 5 — persistence, parsing, migration
// ---------------------------------------------------------------------------------------------

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

// Contract unchanged: { id, name, sub }.
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
  if (!Number.isInteger(value.n) || value.n < 1 || value.n > MAX_SETS) return undefined;
  if (typeof value.playerId !== 'string') return undefined;
  if (value.stat !== 'serve' && value.stat !== 'return') return undefined;
  if (value.side !== 'in' && value.side !== 'out') return undefined;
  if (typeof value.delta !== 'number' || !Number.isInteger(value.delta)) return undefined;
  return { n: value.n, playerId: value.playerId, stat: value.stat, side: value.side, delta: value.delta };
}

// v3 game shape: { gameId, opponent, setCount, setPlayerIds, sets, activeSet, history }.
// team/date/importedAt/players are no longer read — the parser rebuilds field by field, so a
// stale game carrying extras is silently cleaned (including a schema-2 `playerIds`). A game
// naming an unknown directory id is dropped (salvage).
function parseGame(value, directoryIds) {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.gameId !== 'string') return undefined;
  if (typeof value.opponent !== 'string') return undefined;
  if (!Number.isInteger(value.setCount) || value.setCount < 1 || value.setCount > MAX_SETS) return undefined;
  if (!Array.isArray(value.setPlayerIds) || value.setPlayerIds.length !== MAX_SETS) return undefined;
  const setPlayerIds = [];
  const union = new Set();
  for (let i = 0; i < value.setPlayerIds.length; i += 1) {
    const rawList = value.setPlayerIds[i];
    if (!Array.isArray(rawList)) return undefined;
    const seenInSet = new Set();
    const list = [];
    for (const id of rawList) {
      if (typeof id !== 'string') return undefined;
      if (seenInSet.has(id)) return undefined;
      if (!directoryIds.has(id)) return undefined;
      seenInSet.add(id);
      // The cap counts exactly what `gamePlayerIdsUnion` counts — the live slots. THE PARSER
      // MUST NEVER BE STRICTER THAN THE RUNTIME: `setPlayerTicked` and `addSub` measure the cap
      // over `0..setCount-1`, so counting parked slots here would refuse to read back a day the
      // app itself let her build, and `parseDay` turns a refused game into a dropped game — or,
      // for a one-game day, a malformed day. Every count she recorded, gone on the next boot.
      // Parked ids never leave this client either: buildDayStatsPayload derives its lines from
      // `counts`, never from the tick lists, so nothing downstream sees them.
      if (i < value.setCount) union.add(id);
      list.push(id);
    }
    setPlayerIds.push(list);
  }
  if (union.size > MAX_ROSTER_PLAYERS) return undefined;
  if (!Array.isArray(value.sets) || value.sets.length !== MAX_SETS) return undefined;
  const sets = [];
  for (const raw of value.sets) {
    const set = parseSetRecord(raw);
    if (set === undefined) return undefined;
    sets.push(set);
  }
  if (!Number.isInteger(value.activeSet) || value.activeSet < 1 || value.activeSet > MAX_SETS) return undefined;
  if (!Array.isArray(value.history)) return undefined;
  const history = [];
  for (const raw of value.history) {
    const h = parseHistoryEntry(raw);
    if (h === undefined) return undefined;
    history.push(h);
  }
  return { gameId: value.gameId, opponent: value.opponent, setCount: value.setCount, setPlayerIds, sets, activeSet: value.activeSet, history };
}

// The day envelope (schema 3). `date` a non-empty string, or null only when games and players
// are both empty.
function parseDay(value) {
  if (!isPlainObject(value)) return undefined;
  if (value.date !== null && !(typeof value.date === 'string' && value.date.length > 0)) return undefined;
  if (typeof value.team !== 'string') return undefined;
  if (!Array.isArray(value.players) || value.players.length > MAX_DAY_PLAYERS) return undefined;
  const seenIds = new Set();
  const players = [];
  for (const raw of value.players) {
    const p = parsePlayer(raw, seenIds);
    if (p === undefined) return undefined;
    players.push(p);
  }
  if (!Array.isArray(value.games) || value.games.length > MAX_GAMES_PER_DAY) return undefined;
  const directoryIds = new Set(players.map((p) => p.id));
  // Per-game salvage: a game that fails validation (or repeats an earlier gameId) is dropped
  // rather than parking the whole saved day.
  const games = [];
  let dropped = 0;
  const seenGameIds = new Set();
  for (const raw of value.games) {
    const g = parseGame(raw, directoryIds);
    if (g === undefined || seenGameIds.has(g.gameId)) {
      dropped++;
      continue;
    }
    seenGameIds.add(g.gameId);
    games.push(g);
  }
  if (value.games.length > 0 && games.length === 0) return undefined;
  if (value.date === null && (players.length > 0 || games.length > 0)) return undefined;
  for (const key of ['importedAt', 'lastExportedAt', 'lastChangedAt']) {
    if (value[key] !== null && typeof value[key] !== 'string') return undefined;
  }
  let activeGameId = value.activeGameId;
  if (activeGameId !== null && typeof activeGameId !== 'string') return undefined;
  if (typeof activeGameId === 'string' && !games.some((g) => g.gameId === activeGameId)) {
    activeGameId = games[0] ? games[0].gameId : null;
  }
  const day = {
    date: value.date,
    team: value.team,
    players,
    games,
    activeGameId,
    importedAt: value.importedAt,
    lastExportedAt: value.lastExportedAt,
    lastChangedAt: value.lastChangedAt,
  };
  return { day, dropped };
}

// -- schema-1 legacy parser, retained verbatim (3-slot sets, one game = one day's worth of
// fields) purely so `migrateSchema1` has a faithful v1 session to lift from, with one deliberate
// exception: parseGameV1's `date` check mirrors the codec's own v1 tightening (isNonEmptyString),
// because a real phone can hold a save from before that tightening shipped, and letting `date: ''`
// through here would hand `migrateSchema1` a day `parseDay` refuses to read back. --

function parseHistoryEntryV1(value) {
  if (!isPlainObject(value)) return undefined;
  if (value.n !== 1 && value.n !== 2 && value.n !== 3) return undefined;
  if (typeof value.playerId !== 'string') return undefined;
  if (value.stat !== 'serve' && value.stat !== 'return') return undefined;
  if (value.side !== 'in' && value.side !== 'out') return undefined;
  if (typeof value.delta !== 'number' || !Number.isInteger(value.delta)) return undefined;
  return { n: value.n, playerId: value.playerId, stat: value.stat, side: value.side, delta: value.delta };
}

function parseGameV1(value) {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.gameId !== 'string') return undefined;
  if (typeof value.team !== 'string') return undefined;
  if (typeof value.opponent !== 'string') return undefined;
  // Non-string OR empty: matches the codec's isNonEmptyString tightening for `date`. Without this,
  // a genuine pre-tightening phone save with `date: ''` would migrate to a day `parseDay` rejects.
  if (typeof value.date !== 'string' || value.date.length === 0) return undefined;
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
    const h = parseHistoryEntryV1(raw);
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

function parseLegacySession(session) {
  if (!Array.isArray(session.games)) return undefined;
  const games = [];
  let dropped = 0;
  const seenGameIds = new Set();
  for (const raw of session.games) {
    const g = parseGameV1(raw);
    if (g === undefined || seenGameIds.has(g.gameId)) {
      dropped++;
      continue;
    }
    seenGameIds.add(g.gameId);
    games.push(g);
  }
  if (session.games.length > 0 && games.length === 0) return undefined;
  let activeGameId = session.activeGameId;
  if (activeGameId !== null && typeof activeGameId !== 'string') return undefined;
  if (typeof activeGameId === 'string' && !games.some((g) => g.gameId === activeGameId)) {
    activeGameId = games[0] ? games[0].gameId : null;
  }
  return { session: { activeGameId, games }, dropped };
}

/**
 * Migration, schema 1 -> 2. Rule: keep the day containing the active game; set the other days
 * aside. If activeGameId is null or unresolvable, keep the date whose games have the most recent
 * importedAt. Games on other dates are dropped and counted in `droppedDays`.
 */
function migrateSchema1(v1session) {
  const games = v1session.games;
  if (games.length === 0) return { day: newSession(), droppedDays: 0 };

  const active = v1session.activeGameId ? games.find((g) => g.gameId === v1session.activeGameId) : undefined;
  let keptDate;
  if (active) {
    keptDate = active.date;
  } else {
    let best; // most recent importedAt seen per date, tracked as we scan
    for (const g of games) {
      if (best === undefined || g.importedAt > best.importedAt) best = { date: g.date, importedAt: g.importedAt };
    }
    keptDate = best.date;
  }
  const keptGames = games.filter((g) => g.date === keptDate);
  const droppedDays = new Set(games.filter((g) => g.date !== keptDate).map((g) => g.date)).size;

  // A v1 day of three games could hold up to 36 distinct girls; refusing beats truncating.
  if (keptGames.length > MAX_GAMES_PER_DAY) return undefined;

  // Directory = the union of the kept games' players, in game order, de-duped by id.
  const directory = [];
  const indexById = new Map();
  for (const g of keptGames) {
    for (const p of g.players) {
      const isSub = p.sub || CLIENT_ID_PATTERN.test(p.id);
      const idx = indexById.get(p.id);
      if (idx === undefined) {
        indexById.set(p.id, directory.length);
        directory.push({ id: p.id, name: p.name, sub: isSub });
      } else if (isSub) {
        directory[idx].sub = true;
      }
    }
  }
  if (directory.length > MAX_DAY_PLAYERS) return undefined;

  const day = {
    date: keptDate,
    team: active ? active.team : keptGames[0].team,
    players: directory,
    // Per-set lists = that game's own players, in every slot: a schema-1 save has no per-set
    // membership either, so the tick lists reproduce exactly what she was recording.
    games: keptGames.map((g) => ({
      gameId: g.gameId,
      opponent: g.opponent,
      setCount: MAX_SETS,
      setPlayerIds: padSetPlayerIds(Array(MAX_SETS).fill(g.players.map((p) => p.id))),
      sets: [...g.sets, null, null], // pad 3 to 5
      activeSet: g.activeSet,
      history: g.history,
    })),
    activeGameId:
      v1session.activeGameId && keptGames.some((g) => g.gameId === v1session.activeGameId)
        ? v1session.activeGameId
        : keptGames[0]
          ? keptGames[0].gameId
          : null,
    importedAt: keptGames.reduce((min, g) => (min === null || g.importedAt < min ? g.importedAt : min), null),
    // A day is only safe to discard if EVERY played game went out — the opposite of what a plain
    // `max` gives you. If any kept game with a played set still has `lastExportedAt === null`, the
    // day's must be null too, so hasUnexportedStats keeps warning until the rest are actually
    // exported. Only once every played game has a timestamp does the max of those become meaningful.
    lastExportedAt: keptGames.some((g) => g.lastExportedAt === null && g.sets.some(isSetPlayed))
      ? null
      : keptGames.reduce((max, g) => (g.lastExportedAt !== null && (max === null || g.lastExportedAt > max) ? g.lastExportedAt : max), null),
    lastChangedAt: null,
  };
  return { day, droppedDays };
}

/**
 * A schema-2 saved day lifted to schema 3, in the raw — `parseDay` validates the schema-3 shape,
 * so the lift has to happen before it, on untrusted JSON. Anything malformed is passed through
 * untouched for `parseDay` to reject in the one place that does rejection.
 *
 * A schema-2 save carries no set count and one flat tick list per game, because the UI that wrote
 * it showed five tabs unconditionally and had no per-set membership to record. So it keeps five
 * tabs, and every set inherits that game's whole list. Deliberately NOT derived from what she
 * happened to have played: shrinking an in-progress day's tabs under her while she is recording is
 * a worse failure than showing two tabs she will not use. A CIQR3. paste for the same date merges
 * real per-set masks in.
 */
function migrateSchema2(session) {
  if (!isPlainObject(session) || !Array.isArray(session.games)) return session;
  return {
    ...session,
    games: session.games.map((g) => {
      if (!isPlainObject(g) || !Array.isArray(g.playerIds)) return g;
      const { playerIds, ...rest } = g;
      return { ...rest, setCount: MAX_SETS, setPlayerIds: Array.from({ length: MAX_SETS }, () => [...playerIds]) };
    }),
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
  if (envelope.schema !== 1 && envelope.schema !== 2 && envelope.schema !== 3) return MALFORMED;
  const session = envelope.session;
  if (!isPlainObject(session)) return MALFORMED;

  if (envelope.schema === 3) {
    const result = parseDay(session);
    if (result === undefined) return MALFORMED;
    return { ok: true, value: result.day, dropped: result.dropped, schema: envelope.schema };
  }

  if (envelope.schema === 2) {
    // Wrapped because this ships to phones holding a schema-2 save; boot must never throw.
    try {
      const result = parseDay(migrateSchema2(session));
      if (result === undefined) return MALFORMED;
      return { ok: true, value: result.day, dropped: result.dropped, schema: envelope.schema };
    } catch {
      return MALFORMED;
    }
  }

  // schema === 1: this code ships to phones that already hold a schema-1 save; it must never
  // throw during boot, so the whole legacy leg — parse then migrate — is one try/catch.
  try {
    const legacy = parseLegacySession(session);
    if (legacy === undefined) return MALFORMED;
    const migrated = migrateSchema1(legacy.session);
    if (migrated === undefined) return MALFORMED;
    return { ok: true, value: migrated.day, dropped: legacy.dropped, droppedDays: migrated.droppedDays, schema: envelope.schema };
  } catch {
    return MALFORMED;
  }
}

export function serialiseSession(s) {
  return JSON.stringify({ schema: SESSION_SCHEMA, savedAt: new Date().toISOString(), session: s });
}

export function runSelfCheck() {
  try {
    if (fnv1a32(new Uint8Array()) !== '811c9dc5') return { ok: false, error: 'fnv1a32 of empty input' };
    if (fnv1a32(new TextEncoder().encode('a')) !== 'e40c292c') return { ok: false, error: 'fnv1a32 of "a"' };
    if (encodeDayRoster(ROSTER_V3_VECTOR.payload) !== ROSTER_V3_VECTOR.encoded) return { ok: false, error: 'day roster vector encode' };
    if (encodeDayStats(STATS_V2_VECTOR.payload) !== STATS_V2_VECTOR.encoded) return { ok: false, error: 'day stats vector encode' };
    if (encodeRoster(ROSTER_VECTOR.payload) !== ROSTER_VECTOR.encoded) return { ok: false, error: 'roster vector encode' };
    if (encodeStats(STATS_VECTOR.payload) !== STATS_VECTOR.encoded) return { ok: false, error: 'stats vector encode' };
    const r3 = decodeDayRoster(ROSTER_V3_VECTOR.encoded);
    if (!r3.ok || JSON.stringify(r3.value) !== JSON.stringify(ROSTER_V3_VECTOR.payload)) return { ok: false, error: 'day roster vector decode' };
    const t2 = decodeDayStats(STATS_V2_VECTOR.encoded);
    if (!t2.ok || JSON.stringify(t2.value) !== JSON.stringify(STATS_V2_VECTOR.payload)) return { ok: false, error: 'day stats vector decode' };
    const r2 = decodeDayRoster(ROSTER_V2_VECTOR.encoded);
    if (!r2.ok || JSON.stringify(r2.value) !== JSON.stringify(ROSTER_V2_AS_V3)) return { ok: false, error: 'legacy v2 roster vector decode' };
    const r1 = decodeDayRoster(ROSTER_VECTOR.encoded);
    if (!r1.ok || JSON.stringify(r1.value) !== JSON.stringify(ROSTER_V1_AS_DAY)) return { ok: false, error: 'legacy roster vector decode' };
    const t1 = decodeDayStats(STATS_VECTOR.encoded);
    if (!t1.ok || JSON.stringify(t1.value) !== JSON.stringify(STATS_V1_AS_DAY)) return { ok: false, error: 'legacy stats vector decode' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
