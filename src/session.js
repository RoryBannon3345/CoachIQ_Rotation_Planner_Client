// session.js — pure, DOM-free day/session state model, storage envelope and stats payload builder.
// build note: import lines below are for node tests; the inliner strips single-line imports only, so each must stay on one line
import { MAX_ROSTER_PLAYERS, MAX_COUNT, MAX_NAME_LENGTH, MAX_SETS, MAX_DAY_PLAYERS, MAX_GAMES_PER_DAY, ID_PATTERN, CLIENT_ID_PATTERN, fnv1a32, encodeRoster, encodeStats, encodeDayRoster, encodeDayStats, validateDayStatsPayload, decodeDayRoster, decodeDayStats, maskMembers, MAX_POINTS } from './codec.js';
import { ROSTER_VECTOR, STATS_VECTOR, ROSTER_V2_VECTOR, STATS_V2_VECTOR, STATS_V4_VECTOR, STATS_V5_VECTOR, STATS_V4_AS_V5, STATS_V2_AS_V5, STATS_V3_VECTOR, STATS_V3_AS_V5, ROSTER_V1_AS_DAY, STATS_V1_AS_DAY, ROSTER_V3_VECTOR, ROSTER_V2_AS_V3 } from './vectors.js';

export const STORAGE_KEY = 'coachiq-stats-client';
export const UNREADABLE_KEY = 'coachiq-stats-client.unreadable';
export const SESSION_SCHEMA = 4;
export const APP_VERSION = '4.5.0';
export const AUTHOR_NAME = 'Rory Bannon';
export const COPYRIGHT_YEAR = 2026;
export const MAX_SCORE = 99;
export const UNDO_LIMIT = 400;

/** Does a Return Out end the rally with the point to Them, like a Serve Out? Ruling 1 of
 * docs/superpowers/specs/2026-10-07-auto-score-side-out-design.md; `false` makes a Return Out
 * leave the rally open, like a Return In. */
export const RETURN_OUT_ENDS_RALLY = true;
const PENDING_VALUES = [null, 'serve', 'return'];

const STATS = ['serve', 'return'];
const SIDES = ['in', 'out'];

function zeroCount() {
  return { serve: { in: 0, out: 0 }, return: { in: 0, out: 0 } };
}

/** A set nobody has touched yet. `servedFirst` is null until the coach answers the set bar's
 * question (or the first stat tap answers it); `points` is one letter per rally (`U` we won it,
 * `T` they did) and is the set's score once it is non-empty; `pending` is the stat whose In tap
 * opened a rally nobody has won yet. Invariants: `points !== ''` implies `servedFirst !== null`;
 * `pending !== null` implies `servedFirst !== null` and no typed score.
 * `serveBy` maps a rally's index in `points` to the player whose serve tap served it (contract v5's `servers` is built from it). */
function emptySet() {
  return { score: null, counts: {}, servedFirst: null, points: '', pending: null, serveBy: {} };
}

function isTypedSet(set) {
  return set.points === '' && set.score !== null;
}

function clampCount(n) {
  return Math.max(0, Math.min(MAX_COUNT, n));
}

// The session IS the day: one or more roster pastes in the morning (the Planner sends at most
// three games an email, and `mergeDayRoster` folds each same-date paste into the day), one stats
// payload back at night. `date` is the identity of the day — null only for the empty, pre-paste
// state.
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
 * returns first-seen order, which is what the 16-player cap counts. The cap is the union across
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
  const set = game.sets[n - 1] ?? emptySet();
  const cur = set.counts[playerId] ?? zeroCount();
  const before = cur[stat][side];
  const after = clampCount(before + delta);
  if (after === before) return game;
  const counts = { ...set.counts, [playerId]: { ...cur, [stat]: { ...cur[stat], [side]: after } } };
  const sets = game.sets.slice();
  sets[n - 1] = { ...set, counts };
  return { ...game, sets };
}

/** The tap that opened set n's open rally: the most recent count entry for that set that raised
 * a count. While a rally is open no later raising tap or pill tap can exist for that set (each
 * would have moved or closed `pending`), so this is the opener. Null if the 400-entry cap dropped it. */
function rallyOpener(history, n) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i];
    if (h.kind === 'count' && h.n === n && h.delta > 0) return h;
  }
  return null;
}

export function tap(s, gameId, n, playerId, stat, side, delta) {
  return withGame(s, gameId, (g) => {
    const before = getCount(g, n, playerId)[stat][side];
    const game = applyDelta(g, n, playerId, stat, side, delta);
    if (game === g) return g;
    const after = getCount(game, n, playerId)[stat][side];
    const entry = { kind: 'count', n, playerId, stat, side, delta: after - before };
    const prevSet = g.sets[n - 1] ?? emptySet();
    let sets = game.sets;
    if (entry.delta > 0 && !isTypedSet(prevSet)) {
      const inferred = inferTap(prevSet, stat, side);
      const room = Math.max(0, MAX_POINTS - prevSet.points.length);
      const appended = inferred.letters.slice(0, room).map((l) => l.letter).join('');
      const pendingBefore = prevSet.pending ?? null;
      const counted = game.sets[n - 1];
      sets = game.sets.slice();
      sets[n - 1] = { ...counted, servedFirst: inferred.servedFirst, points: counted.points + appended, pending: inferred.pending };
      if (stat === 'serve') {
        // The rally this serve tap served: after any rally the tap closed (a side-out or a
        // resolve), and the one its own Out closes. A later tap for the same rally replaces it.
        const at = prevSet.points.length + inferred.letters.filter((l) => l.why !== 'out').length;
        if (at < MAX_POINTS) {
          const serveBy = { ...(sets[n - 1].serveBy ?? {}) };
          entry.serveAt = at;
          if (serveBy[at] !== undefined) entry.serveBefore = serveBy[at];
          serveBy[at] = playerId;
          sets[n - 1] = { ...sets[n - 1], serveBy };
        }
      }
      if (appended !== '') entry.points = appended;
      if (prevSet.servedFirst === null) entry.servedFirstSet = true;
      if (pendingBefore !== inferred.pending) entry.pendingBefore = pendingBefore;
    } else if (entry.delta < 0 && !isTypedSet(prevSet) && (prevSet.pending ?? null) !== null && side === 'in' && stat === prevSet.pending) {
      // A minus on the tap that opened the open rally — the "wrong row" correction — cancels that
      // rally. Undo of this entry re-opens it through pendingBefore.
      const opener = rallyOpener(g.history, n);
      if (opener && opener.playerId === playerId && opener.stat === stat && opener.side === 'in') {
        sets = game.sets.slice();
        sets[n - 1] = { ...game.sets[n - 1], pending: null };
        const openAt = prevSet.points.length;
        const serveBy = prevSet.serveBy ?? {};
        if (stat === 'serve' && serveBy[openAt] === playerId) {
          const rest = { ...serveBy };
          delete rest[openAt];
          sets[n - 1] = { ...sets[n - 1], serveBy: rest };
          entry.serveCleared = openAt;
        }
        entry.pendingBefore = prevSet.pending;
      }
    }
    const history = [...game.history, entry].slice(-UNDO_LIMIT);
    return { ...game, sets, history };
  });
}

/** `[us, them]` from a point log: `U` is a rally we won, `T` one they did. */
export function pointTally(points) {
  let us = 0;
  for (const c of points) if (c === 'U') us += 1;
  return [us, points.length - us];
}

/** Who served each of our serve turns in a set's log (contract v5's `servers`): the first rally
 * of the turn a serve tap names, or null when none does or she is not in `knownIds`. One entry per
 * turn, in order, so the list's length is the contract's `serveTurnCount`. */
export function serveTurnServers(set, knownIds) {
  const out = [];
  let weServe = set.servedFirst === true;
  let current = -1;
  for (let i = 0; i < set.points.length; i += 1) {
    if (weServe) {
      if (current === -1) {
        out.push(null);
        current = out.length - 1;
      }
      const id = (set.serveBy ?? {})[i];
      if (out[current] === null && id !== undefined && knownIds.has(id)) out[current] = id;
    } else {
      current = -1;
    }
    weServe = set.points[i] === 'U';
  }
  return out;
}

/** Who serves the next rally: the winner of the last one, else the serve-first answer, else
 * null (not known yet). `setRecord` may be null for a set nobody has touched. */
export function setServer(setRecord) {
  if (!setRecord) return null;
  if (setRecord.points !== '') return setRecord.points[setRecord.points.length - 1];
  if (setRecord.servedFirst === null) return null;
  return setRecord.servedFirst ? 'U' : 'T';
}

/** What one stat tap says about the score, from the rule that the winner of a rally serves the
 * next one. Pure; `tap` applies it. Only meaningful for a logged set and a tap that raised a count. */
export function inferTap(setRecord, stat, side) {
  const set = setRecord ?? { servedFirst: null, points: '', pending: null };
  const servedFirst = set.servedFirst === null ? stat === 'serve' : set.servedFirst;
  const letters = [];
  if ((set.pending ?? null) !== null) {
    letters.push({ letter: stat === 'serve' ? 'U' : 'T', why: 'resolve' });
  } else {
    const server = setServer({ ...set, servedFirst });
    if (server === 'U' && stat === 'return') letters.push({ letter: 'T', why: 'sideout' });
    if (server === 'T' && stat === 'serve') letters.push({ letter: 'U', why: 'sideout' });
  }
  const endsRally = side === 'out' && (stat === 'serve' || RETURN_OUT_ENDS_RALLY);
  if (endsRally) letters.push({ letter: 'T', why: 'out' });
  return { servedFirst, letters, pending: endsRally ? null : stat };
}

/** That set's count entries lose their inference fields (they become plain count entries), so an
 * Undo after the log was cleared or replaced by a typed score reverses only the count. */
function stripInference(history, n) {
  return history.map((h) => {
    if (h.kind !== 'count' || h.n !== n) return h;
    const { points, servedFirstSet, pendingBefore, serveAt, serveBefore, serveCleared, ...plain } = h;
    return plain;
  });
}

/** Records who served the set's first rally. Answering again with the same value is a no-op. */
export function setServedFirst(s, gameId, n, servedFirst) {
  return withGame(s, gameId, (g) => {
    const set = g.sets[n - 1] ?? emptySet();
    if (typeof servedFirst !== 'boolean') return g;
    if (set.servedFirst === servedFirst) return g;
    if (set.points === '' && set.score !== null) return g; // typed and logged stay exclusive from every writer
    const sets = g.sets.slice();
    sets[n - 1] = { ...set, servedFirst };
    return { ...g, sets };
  });
}

/** One rally: `winner` is 'U' or 'T'. Refused (same reference) until servedFirst is answered or
 * once the set carries a typed score, or once the log is at MAX_POINTS — the planner would refuse a longer one. Not touched by minus mode.
 * Closes an open rally; the entry remembers it so Undo re-opens it. */
export function tapPoint(s, gameId, n, winner) {
  if (winner !== 'U' && winner !== 'T') return s;
  return withGame(s, gameId, (g) => {
    const set = g.sets[n - 1] ?? emptySet();
    if (set.servedFirst === null || set.points.length >= MAX_POINTS) return g;
    if (set.points === '' && set.score !== null) return g; // typed and logged are exclusive
    const closed = set.pending ?? null;
    const sets = g.sets.slice();
    sets[n - 1] = { ...set, points: set.points + winner, pending: null };
    const entry = { kind: 'point', n, winner };
    if (closed !== null) entry.pendingBefore = closed;
    const history = [...g.history, entry].slice(-UNDO_LIMIT);
    return { ...g, sets, history };
  });
}

/** Empties the set's log, forgets who served first and closes any open rally; the counts stay.
 * Drops that set's point entries from history the way clearSet drops by n, and strips the
 * inference fields from its count entries, so undo can never resurrect a rally. */
export function clearPoints(s, gameId, n) {
  return withGame(s, gameId, (g) => {
    const set = g.sets[n - 1];
    if (!set || (set.points === '' && set.servedFirst === null)) return g;
    const sets = g.sets.slice();
    sets[n - 1] = { ...set, servedFirst: null, points: '', pending: null, serveBy: {} };
    const history = stripInference(g.history.filter((h) => !(h.kind === 'point' && h.n === n)), n);
    return { ...g, sets, history };
  });
}

export function undo(s, gameId) {
  const game = findGame(s, gameId);
  if (!game || game.history.length === 0) return { session: s, undone: null };
  const last = game.history[game.history.length - 1];
  const session = withGame(s, gameId, (g) => {
    const history = g.history.slice(0, -1);
    if (last.kind === 'point') {
      const set = g.sets[last.n - 1];
      // A letter that does not match the log's last one can only come from corrupt storage: drop the entry, leave the log alone.
      if (!set || set.points.length === 0 || set.points[set.points.length - 1] !== last.winner) return { ...g, history };
      let next = { ...set, points: set.points.slice(0, -1) };
      if ('pendingBefore' in last && !isTypedSet(next) && next.servedFirst !== null) next = { ...next, pending: last.pendingBefore };
      const sets = g.sets.slice();
      sets[last.n - 1] = next;
      return { ...g, sets, history };
    }
    const reverted = applyDelta(g, last.n, last.playerId, last.stat, last.side, -last.delta);
    const set = reverted.sets[last.n - 1];
    if (!set) return { ...reverted, history };
    let next = set;
    // Letters are removed only when the log still ends with them; anything else is corrupt storage.
    if (last.points && next.points.endsWith(last.points)) next = { ...next, points: next.points.slice(0, -last.points.length) };
    if ('pendingBefore' in last) next = { ...next, pending: last.pendingBefore };
    if (last.servedFirstSet && next.points === '' && next.servedFirst === (last.stat === 'serve')) next = { ...next, servedFirst: null };
    if (last.serveAt !== undefined && (next.serveBy ?? {})[last.serveAt] === last.playerId) {
      const serveBy = { ...next.serveBy };
      if (last.serveBefore !== undefined) serveBy[last.serveAt] = last.serveBefore;
      else delete serveBy[last.serveAt];
      next = { ...next, serveBy };
    }
    if (last.serveCleared !== undefined) next = { ...next, serveBy: { ...(next.serveBy ?? {}), [last.serveCleared]: last.playerId } };
    if ((isTypedSet(next) || next.servedFirst === null) && next.pending !== null) next = { ...next, pending: null };
    if (next === set) return { ...reverted, history };
    const sets = reverted.sets.slice();
    sets[last.n - 1] = next;
    return { ...reverted, sets, history };
  });
  return { session, undone: last };
}

export function setScore(s, gameId, n, score) {
  return withGame(s, gameId, (g) => {
    const set = g.sets[n - 1] ?? emptySet();
    if (set.points !== '') return g;
    const sets = g.sets.slice();
    if (score === null) {
      sets[n - 1] = { ...set, score: null };
      return { ...g, sets };
    }
    sets[n - 1] = { ...set, score: [score[0], score[1]], servedFirst: null, pending: null, serveBy: {} };
    return { ...g, sets, history: stripInference(g.history, n) };
  });
}

/** Swaps a set's rally log for a typed final score in one step: the log, the serve-first answer
 * and any open rally go (clearPoints), then the score is typed (setScore). Counts stay. Like
 * clearPoints it cannot be undone — the score sheet says so before it runs. */
export function replaceLogWithScore(s, gameId, n, score) {
  return setScore(clearPoints(s, gameId, n), gameId, n, score);
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
  if (setRecord.points !== '') return true;
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
      const score = set.points !== '' ? pointTally(set.points) : set.score === null ? null : [set.score[0], set.score[1]];
      const out = { n: i + 1, score, players: lines };
      if (set.points !== '') {
        out.servedFirst = set.servedFirst;
        out.points = set.points;
        // Contract v5: who served each of our serve turns, only those with a line in this set (the
        // planner refuses a server it cannot put on the set's roster). Sent only when it names one.
        const lined = new Set(lines.map((line) => line.id));
        const servers = serveTurnServers(set, lined);
        if (servers.some((id) => id !== null)) out.servers = servers;
      }
      sets.push(out);
    });
    if (sets.length === 0) continue; // games with no played set are omitted entirely
    gamesOut.push({ gameId: game.gameId, sets });
  }
  if (gamesOut.length === 0) {
    return { ok: false, error: 'Nothing recorded yet — tap a count, tap a point or enter a score first.' };
  }
  // The directory sent = entries named by at least one emitted line. Fall back to the whole
  // directory for a day of score-only sets (legal): players must never be empty.
  const playersOut =
    usedIds.size > 0
      ? day.players.filter((p) => usedIds.has(p.id)).map((p) => ({ id: p.id, name: p.name }))
      : day.players.map((p) => ({ id: p.id, name: p.name }));
  const payload = { v: 5, kind: 'stats', recordedAt: nowIso, players: playersOut, games: gamesOut };
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
  if (value.servedFirst !== null && typeof value.servedFirst !== 'boolean') return undefined;
  if (typeof value.points !== 'string' || !/^[UT]{0,200}$/.test(value.points)) return undefined;
  if (value.points !== '' && value.servedFirst === null) return undefined;
  const pending = value.pending === undefined ? null : value.pending;
  if (!PENDING_VALUES.includes(pending)) return undefined;
  if (pending !== null && (value.servedFirst === null || (value.points === '' && score !== null))) return undefined;
  // contract v5's who-served map: missing in an older save, and a bad entry is skipped, never fatal.
  const serveBy = {};
  if (isPlainObject(value.serveBy)) {
    for (const [k, id] of Object.entries(value.serveBy)) {
      if (/^\d{1,3}$/.test(k) && Number(k) < MAX_POINTS && typeof id === 'string' && ID_PATTERN.test(id)) serveBy[k] = id;
    }
  }
  return { score, counts, servedFirst: value.servedFirst, points: value.points, pending, serveBy };
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
  if (value.kind === 'point') {
    if (value.winner !== 'U' && value.winner !== 'T') return undefined;
    const point = { kind: 'point', n: value.n, winner: value.winner };
    if (value.pendingBefore !== undefined) {
      if (value.pendingBefore !== 'serve' && value.pendingBefore !== 'return') return undefined;
      point.pendingBefore = value.pendingBefore;
    }
    return point;
  }
  if (value.kind !== 'count') return undefined;
  if (typeof value.playerId !== 'string') return undefined;
  if (value.stat !== 'serve' && value.stat !== 'return') return undefined;
  if (value.side !== 'in' && value.side !== 'out') return undefined;
  if (typeof value.delta !== 'number' || !Number.isInteger(value.delta)) return undefined;
  const count = { kind: 'count', n: value.n, playerId: value.playerId, stat: value.stat, side: value.side, delta: value.delta };
  if (value.points !== undefined) {
    if (typeof value.points !== 'string' || !/^[UT]{1,2}$/.test(value.points)) return undefined;
    count.points = value.points;
  }
  if (value.servedFirstSet !== undefined) {
    if (value.servedFirstSet !== true) return undefined;
    count.servedFirstSet = true;
  }
  if (value.pendingBefore !== undefined) {
    if (!PENDING_VALUES.includes(value.pendingBefore)) return undefined;
    count.pendingBefore = value.pendingBefore;
  }
  const isRallyIndex = (x) => Number.isInteger(x) && x >= 0 && x < MAX_POINTS;
  if (value.serveAt !== undefined) {
    if (!isRallyIndex(value.serveAt)) return undefined;
    count.serveAt = value.serveAt;
  }
  if (value.serveBefore !== undefined) {
    if (typeof value.serveBefore !== 'string' || !ID_PATTERN.test(value.serveBefore)) return undefined;
    count.serveBefore = value.serveBefore;
  }
  if (value.serveCleared !== undefined) {
    if (!isRallyIndex(value.serveCleared)) return undefined;
    count.serveCleared = value.serveCleared;
  }
  return count;
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
    // A schema-1 set predates the point log, so it is read at "nothing recorded" like a lifted one.
    const set = parseSetRecord(isPlainObject(raw) ? { servedFirst: null, points: '', ...raw } : raw);
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

/** One game lifted from schema 3 to 4: every non-null set gains the log fields at their
 * "nothing recorded" values and every history entry becomes a count entry (a schema-3 save can
 * hold no other kind). Tolerant of malformed input — parseDay rejects, this only lifts. */
function liftGameToSchema4(g) {
  if (!isPlainObject(g)) return g;
  const sets = Array.isArray(g.sets) ? g.sets.map((set) => (isPlainObject(set) ? { servedFirst: null, points: '', pending: null, ...set } : set)) : g.sets;
  const history = Array.isArray(g.history) ? g.history.map((h) => (isPlainObject(h) && h.kind === undefined ? { kind: 'count', ...h } : h)) : g.history;
  return { ...g, sets, history };
}

/** A schema-3 saved day lifted to schema 4, in the raw, before `parseDay` — the same shape of
 * lift as `migrateSchema2`. */
function migrateSchema3(session) {
  if (!isPlainObject(session) || !Array.isArray(session.games)) return session;
  return { ...session, games: session.games.map(liftGameToSchema4) };
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
  if (envelope.schema !== 1 && envelope.schema !== 2 && envelope.schema !== 3 && envelope.schema !== 4) return MALFORMED;
  const session = envelope.session;
  if (!isPlainObject(session)) return MALFORMED;

  if (envelope.schema === 4) {
    const result = parseDay(session);
    if (result === undefined) return MALFORMED;
    return { ok: true, value: result.day, dropped: result.dropped, schema: envelope.schema };
  }

  if (envelope.schema === 3) {
    // Wrapped like the schema-2 leg: this ships to phones holding a schema-3 save; boot must never throw.
    try {
      const result = parseDay(migrateSchema3(session));
      if (result === undefined) return MALFORMED;
      return { ok: true, value: result.day, dropped: result.dropped, schema: envelope.schema };
    } catch {
      return MALFORMED;
    }
  }

  if (envelope.schema === 2) {
    // Wrapped because this ships to phones holding a schema-2 save; boot must never throw.
    try {
      const result = parseDay(migrateSchema3(migrateSchema2(session)));
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
    // migrateSchema1 hands back an already-parsed day, so lift its games with the per-game helper.
    const day = { ...migrated.day, games: migrated.day.games.map(liftGameToSchema4) };
    return { ok: true, value: day, dropped: legacy.dropped, droppedDays: migrated.droppedDays, schema: envelope.schema };
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
    if (encodeDayStats(STATS_V5_VECTOR.payload) !== STATS_V5_VECTOR.encoded) return { ok: false, error: 'day stats vector encode' };
    if (encodeRoster(ROSTER_VECTOR.payload) !== ROSTER_VECTOR.encoded) return { ok: false, error: 'roster vector encode' };
    if (encodeStats(STATS_VECTOR.payload) !== STATS_VECTOR.encoded) return { ok: false, error: 'stats vector encode' };
    const r3 = decodeDayRoster(ROSTER_V3_VECTOR.encoded);
    if (!r3.ok || JSON.stringify(r3.value) !== JSON.stringify(ROSTER_V3_VECTOR.payload)) return { ok: false, error: 'day roster vector decode' };
    const t5 = decodeDayStats(STATS_V5_VECTOR.encoded);
    if (!t5.ok || JSON.stringify(t5.value) !== JSON.stringify(STATS_V5_VECTOR.payload)) return { ok: false, error: 'day stats vector decode' };
    const t4 = decodeDayStats(STATS_V4_VECTOR.encoded);
    if (!t4.ok || JSON.stringify(t4.value) !== JSON.stringify(STATS_V4_AS_V5)) return { ok: false, error: 'legacy v4 stats vector decode' };
    const t2 = decodeDayStats(STATS_V2_VECTOR.encoded);
    if (!t2.ok || JSON.stringify(t2.value) !== JSON.stringify(STATS_V2_AS_V5)) return { ok: false, error: 'legacy v2 stats vector decode' };
    const t3 = decodeDayStats(STATS_V3_VECTOR.encoded);
    if (!t3.ok || JSON.stringify(t3.value) !== JSON.stringify(STATS_V3_AS_V5)) return { ok: false, error: 'legacy v3 stats vector decode' };
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
