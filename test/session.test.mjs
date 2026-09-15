import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/session.js';
import { decodeDayRoster, decodeDayStats, MAX_SETS } from '../src/codec.js';
import { ROSTER_VECTOR, ROSTER_V2_VECTOR, STATS_V2_VECTOR, ROSTER_V3_VECTOR, ROSTER_V1_AS_DAY, ROSTER_V2_AS_V3 } from '../src/vectors.js';

// The v2 golden day re-expressed at contract v3, which is the only roster shape the session model
// reads now. game-1 gets FIVE set masks (mask 3 = maskOf([0, 1]) = both players) and game-2 two
// (mask 2 = maskOf([1]) = Zoë). The counts are deliberate, not minimal: several tests below visit
// set 3 or tap set 5 on game-1, and a faithful one-set conversion would make those assertions
// vacuous the moment setActiveSet is clamped to the game's set count.
const rosterV2AsV3 = {
  v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: ROSTER_V2_VECTOR.payload.players,
  games: [
    { gameId: 'game-1', opponent: 'Lions', sets: [3, 3, 3, 3, 3] },
    { gameId: 'game-2', opponent: 'Falcons', sets: [2, 2] },
  ],
};
const rosterV3 = ROSTER_V3_VECTOR.payload;

// Single-game fixture, rebuilt via decodeDayRoster so v1->day normalisation is exercised for free.
const open = () => S.openDayRoster(S.newSession(), decodeDayRoster(ROSTER_VECTOR.encoded).value, '2026-09-19T20:00:00Z').session;
// Two-game fixture, straight from the v2 golden payload's v3 restatement.
const openV2 = () => S.openDayRoster(S.newSession(), rosterV2AsV3, '2026-09-19T20:00:00Z').session;

test('openDayRoster creates the day and makes the first game active', () => {
  const s = open();
  assert.equal(s.date, '2026-09-19');
  assert.equal(s.team, 'Thunder');
  assert.equal(s.activeGameId, 'game-1');
  assert.deepEqual(s.players, [
    { id: 'grace', name: 'Grace', sub: false },
    { id: 'zoie', name: 'Zoë', sub: false },
  ]);
  assert.deepEqual(s.games[0].setPlayerIds[0], ['grace', 'zoie']);
  assert.deepEqual(s.games[0].sets, [null, null, null, null, null]);
});

test('mask -> id resolution uses the payload masks, not "everyone"', () => {
  const s = openV2();
  assert.deepEqual(s.games[0].setPlayerIds[0], ['grace', 'zoie']);
  assert.deepEqual(s.games[1].setPlayerIds[0], ['zoie']);
});

test('an empty game roster is legal and never filters the directory', () => {
  // maskOf([]) === 0: one set, nobody picked for it.
  const roster = { ...rosterV2AsV3, games: [{ gameId: 'game-1', opponent: 'Lions', sets: [0] }, rosterV2AsV3.games[1]] };
  const s = S.newDayFromRoster(roster, 'x');
  assert.deepEqual(s.games[0].setPlayerIds[0], []);
  assert.deepEqual(S.gamePlayerIdsUnion(s.games[0]), []);
  assert.deepEqual(s.players, [
    { id: 'grace', name: 'Grace', sub: false },
    { id: 'zoie', name: 'Zoë', sub: false },
  ]);
});

test('ingest gives each game its own set count and each set its own membership', () => {
  const day = S.newDayFromRoster(rosterV3, '2026-09-19T09:00:00Z');
  const [g1, g2] = day.games;
  assert.equal(g1.setCount, 3, 'sets.length is authoritative, per game');
  assert.equal(g2.setCount, 2, 'games in one day may differ');
  assert.equal(S.gameSetCount(g1), 3);
  assert.deepEqual(g1.setPlayerIds[0], ['grace', 'zoie']);
  assert.deepEqual(g1.setPlayerIds[1], ['grace']);
  assert.deepEqual(g1.setPlayerIds[2], ['zoie']);
  assert.deepEqual(g2.setPlayerIds[0], ['zoie']);
  assert.deepEqual(g2.setPlayerIds[1], [], 'mask 0 is nobody pre-ticked');
  assert.equal(g1.setPlayerIds.length, MAX_SETS, 'always MAX_SETS slots, whatever setCount says');
  assert.equal(g1.sets.length, MAX_SETS);
  assert.deepEqual(S.gamePlayerIdsUnion(g1), ['grace', 'zoie']);
  assert.deepEqual(S.gamePlayerIdsUnion(g2), ['zoie']);
});

test('a legacy roster ingests as exactly one set', () => {
  const legacy = decodeDayRoster(ROSTER_V2_VECTOR.encoded);
  const day = S.newDayFromRoster(legacy.value, '2026-09-19T09:00:00Z');
  assert.equal(day.games[0].setCount, 1, 'one set, not three and not five');
  assert.deepEqual(day.games[0].setPlayerIds[0], ['grace', 'zoie']);
});

test('ticking is per set and does not leak between sets', () => {
  const day = S.newDayFromRoster(rosterV3, '2026-09-19T09:00:00Z');
  const r = S.setPlayerTicked(day, 'game-1', 2, 'zoie', true);
  assert.equal(r.ok, true);
  const g1 = r.session.games[0];
  assert.deepEqual(g1.setPlayerIds[1], ['grace', 'zoie'], 'added to set 2');
  assert.deepEqual(g1.setPlayerIds[0], ['grace', 'zoie'], 'set 1 untouched');
  assert.deepEqual(g1.setPlayerIds[2], ['zoie'], 'set 3 untouched');
});

test('un-ticking is guarded by counts in THAT set, not anywhere in the game', () => {
  let day = S.newDayFromRoster(rosterV3, '2026-09-19T09:00:00Z');
  day = S.tap(day, 'game-1', 1, 'grace', 'serve', 'in', 1);
  // Grace has counts in set 1, so set 1 refuses.
  const refused = S.setPlayerTicked(day, 'game-1', 1, 'grace', false);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Grace has counts in Set 1/);
  // She has none in set 2, so set 2 allows it even though set 1 has counts.
  const allowed = S.setPlayerTicked(day, 'game-1', 2, 'grace', false);
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.session.games[0].setPlayerIds[1], []);
});

test("the 12-player cap is the union across a game's sets", () => {
  const players = Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const roster = {
    v: 3, kind: 'roster', date: '2026-09-19', team: 'T', players,
    games: [{ gameId: 'g', opponent: 'o', sets: [2 ** 12 - 1, 0] }],
  };
  const day = S.newDayFromRoster(roster, '2026-09-19T09:00:00Z');
  assert.equal(S.gamePlayerIdsUnion(day.games[0]).length, 12);
  // The 13th distinct girl, ticked into a DIFFERENT set, still trips the cap.
  const r = S.setPlayerTicked(day, 'g', 2, 'p12', true);
  assert.equal(r.ok, false);
  assert.match(r.error, /12 players/);
  // But re-ticking somebody already in the union into another set is fine.
  assert.equal(S.setPlayerTicked(day, 'g', 2, 'p0', true).ok, true);
});

test('a sub joins only the set she was added to', () => {
  const day = S.newDayFromRoster(rosterV3, '2026-09-19T09:00:00Z');
  const r = S.addSub(day, 'game-1', 3, 'Ava', 'cx-testtest');
  assert.equal(r.ok, true);
  assert.equal(r.session.players.at(-1).id, 'cx-testtest');
  assert.deepEqual(r.session.games[0].setPlayerIds[2], ['zoie', 'cx-testtest']);
  assert.deepEqual(r.session.games[0].setPlayerIds[0], ['grace', 'zoie'], 'set 1 untouched');
});

test('a merge never shrinks a set count below recorded data', () => {
  let day = S.newDayFromRoster(rosterV3, '2026-09-19T09:00:00Z');
  day = S.tap(day, 'game-1', 3, 'zoie', 'serve', 'in', 1);
  const shrunk = { ...rosterV3, games: [{ gameId: 'game-1', opponent: 'Lions', sets: [3] }, rosterV3.games[1]] };
  const res = S.openDayRoster(day, shrunk, '2026-09-19T12:00:00Z');
  assert.equal(res.kind, 'sameDay');
  assert.equal(res.session.games[0].setCount, 3, 'set 3 has counts, so the game keeps three tabs');
});

test("a merge refreshes each set's ticks and keeps players who have counts there", () => {
  let day = S.newDayFromRoster(rosterV3, '2026-09-19T09:00:00Z');
  day = S.tap(day, 'game-1', 1, 'zoie', 'serve', 'in', 1);
  // The re-sent roster drops Zoë from set 1, but she has counts in it.
  const resent = { ...rosterV3, games: [{ gameId: 'game-1', opponent: 'Lions', sets: [1, 1, 2] }, rosterV3.games[1]] };
  const res = S.openDayRoster(day, resent, '2026-09-19T12:00:00Z');
  assert.equal(res.kind, 'sameDay');
  assert.deepEqual(res.session.games[0].setPlayerIds[0], ['grace', 'zoie'], 'kept: she has counts in set 1');
  assert.deepEqual(res.session.games[0].setPlayerIds[1], ['grace'], 'set 2 takes the incoming mask');
});

// A day built the way a coach actually gets here: a roster whose later sets name girls the first
// set does not, one count recorded, then a re-sent roster naming fewer sets. `maskOf([0..5])` is
// 63 and `maskOf([6..11])` is 4032 over a twelve-player directory.
const shrinkFixture = () => {
  const players = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const full = {
    v: 3, kind: 'roster', date: '2026-09-19', team: 'T', players,
    games: [{ gameId: 'g', opponent: 'Lions', sets: [63, 0, 0, 0, 4032] }],
  };
  const oneSet = { ...full, games: [{ gameId: 'g', opponent: 'Lions', sets: [63] }] };
  let day = S.newDayFromRoster(full, 'now');
  day = S.tap(day, 'g', 1, 'p0', 'serve', 'in', 1);
  return { full, oneSet, day: S.openDayRoster(day, oneSet, 'now').session };
};

test('a merge drops count-free ticks from tabs it puts beyond the set count', () => {
  const { day } = shrinkFixture();
  const g = day.games[0];
  assert.equal(g.setCount, 1, 'the re-sent roster names one set and set 1 holds the only counts');
  assert.deepEqual(g.setPlayerIds.slice(1).flat(), [], 'nothing parked in tabs the UI will not draw');
  assert.equal(S.getCount(g, 1, 'p0').serve.in, 1, 'the recorded count is untouched');
});

test('a merge retiring a set slot prunes that slot out of history too, so undo cannot resurrect it', () => {
  // She records set 1, then mis-taps in set 4 and corrects it with minus mode -- net zero, so
  // set 4 is NOT "played" (isSetPlayed sums raw counts to 0) even though history holds both the
  // +1 and the -1. A re-sent two-set roster is a legal same-day merge: setCount drops to
  // Math.max(2, highestPlayedSlot + 1) = 2. Before the fix, `history` rode through untouched at
  // n = [1, 4, 4]; Undo (which always reverses the LAST entry, unclamped by design) would replay
  // the n=4 entry invisibly and reactivate a phantom set 4 that buildDayStatsPayload -- which
  // walks `game.sets` directly, not `setCount` -- would then export.
  const players = [{ id: 'p0', name: 'P0' }, { id: 'p1', name: 'P1' }];
  const full = {
    v: 3, kind: 'roster', date: '2026-09-19', team: 'T', players,
    games: [{ gameId: 'g', opponent: 'Lions', sets: [3, 3, 3, 3] }],
  };
  let day = S.newDayFromRoster(full, 'now');
  day = S.tap(day, 'g', 1, 'p0', 'serve', 'in', 1); // set 1: recorded and played
  day = S.tap(day, 'g', 4, 'p0', 'serve', 'in', 1); // set 4: taps to 1...
  day = S.tap(day, 'g', 4, 'p0', 'serve', 'in', -1); // ...then back to 0 -- net zero, not "played"
  assert.equal(S.isSetPlayed(day.games[0].sets[3]), false, 'net-zero counts do not count as played');
  assert.deepEqual(day.games[0].history.map((h) => h.n), [1, 4, 4], 'before merge: history at n = 1,4,4');

  const resent = { ...full, games: [{ gameId: 'g', opponent: 'Lions', sets: [3, 3] }] };
  const res = S.openDayRoster(day, resent, 'now');
  assert.equal(res.kind, 'sameDay');
  const g = res.session.games[0];
  assert.equal(g.setCount, 2, 'setCount = max(incoming 2, highestPlayedSlot(0) + 1)');
  assert.deepEqual(g.history.map((h) => h.n), [1], 'the n=4 history entries do not survive the retired slot');
  assert.equal(g.sets[2], null, 'slot 3 (index 2), beyond the new count, is nulled');
  assert.equal(g.sets[3], null, 'slot 4 (index 3), beyond the new count, is nulled -- it held only a net-zero count');

  // The export the coach sends right after the merge carries only the real set 1 -- no phantom set 4.
  const built = S.buildDayStatsPayload(res.session, 'now');
  assert.equal(built.ok, true);
  assert.deepEqual(built.value.payload.games[0].sets.map((s) => s.n), [1], 'only set 1 was ever played; set 4 never appears');

  // Undo now reverses the last SURVIVING entry (set 1), not a phantom set-4 replay.
  const u = S.undo(res.session, 'g');
  assert.deepEqual(u.undone, { n: 1, playerId: 'p0', stat: 'serve', side: 'in', delta: 1 });
  assert.equal(S.getCount(u.session.games[0], 4, 'p0').serve.in, 0, 'set 4 stays at zero -- no phantom reactivation');
});

test('the parser is never stricter than the runtime: a day at the cap survives save and reload', () => {
  // THE regression. The cap the app enforces (`gamePlayerIdsUnion`, live slots) and the cap
  // `parseGame` enforces must measure the same thing. When they diverged, this day saved and
  // then refused to load: parseDay drops the game, and a one-game day with no games left is
  // MALFORMED — every count she recorded, gone on the next boot.
  let { day } = shrinkFixture();
  for (let i = 0; i < 6; i += 1) day = S.addSub(day, 'g', 1, `Sub ${i}`, `cx-sub0000${i}`).session;
  assert.equal(S.gamePlayerIdsUnion(day.games[0]).length, 12, 'the app allowed her right up to the cap');
  const reloaded = S.parseSession(S.serialiseSession(day));
  assert.equal(reloaded.ok, true, 'a day the app let her build must read back');
  assert.deepEqual(reloaded.value, day);
  assert.equal(S.getCount(reloaded.value.games[0], 1, 'p0').serve.in, 1);
});

test('shrink then grow: parked ticks do not resurrect into a refusal she cannot act on', () => {
  // She has six subs ticked into set 5. A re-sent roster naming one set hides set 5; six more
  // subs go into set 1. When the parked six were kept, the next roster paste resurrected them
  // and every paste for that date failed with "would make 18 players" — names sitting in tabs
  // the UI does not render, so there was no action available to her that could clear it.
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, name: `Q${i}` }));
  const full = { v: 3, kind: 'roster', date: '2026-09-19', team: 'T', players: six, games: [{ gameId: 'g', opponent: 'Lions', sets: [63, 0, 0, 0, 0] }] };
  let day = S.newDayFromRoster(full, 'now');
  for (let i = 0; i < 6; i += 1) day = S.addSub(day, 'g', 5, `Sub ${i}`, `cx-park000${i}`).session;
  assert.equal(S.gamePlayerIdsUnion(day.games[0]).length, 12);
  day = S.tap(day, 'g', 1, 'q0', 'serve', 'in', 1);

  day = S.openDayRoster(day, { ...full, games: [{ gameId: 'g', opponent: 'Lions', sets: [63] }] }, 'now').session;
  assert.equal(day.games[0].setCount, 1);
  assert.deepEqual(day.games[0].setPlayerIds[4], [], 'set 5 is no longer drawn, so its ticks do not ride along');
  for (let i = 0; i < 6; i += 1) day = S.addSub(day, 'g', 1, `New ${i}`, `cx-new0000${i}`).session;
  assert.equal(S.parseSession(S.serialiseSession(day)).ok, true);

  const grown = S.openDayRoster(day, full, 'now');
  assert.equal(grown.kind, 'sameDay', 'the roster re-import must not wedge');
  assert.equal(grown.session.games[0].setCount, 5);
  assert.equal(S.gamePlayerIdsUnion(grown.session.games[0]).length, 12);
  assert.equal(S.getCount(grown.session.games[0], 1, 'q0').serve.in, 1, 'no count was ever at risk');
});

test('a merge still refuses a genuine over-cap, and every name in the refusal is one she can reach', () => {
  let { full, day } = shrinkFixture();
  for (let i = 0; i < 6; i += 1) day = S.addSub(day, 'g', 1, `Sub ${i}`, `cx-sub0000${i}`).session;
  const refused = S.openDayRoster(day, full, 'now');
  assert.equal(refused.kind, 'error', '12 roster girls across five sets plus six subs really is 18');
  assert.match(refused.error, /the game limit is 12/);
  // Escapable: the only names not in the roster she just pasted are her own six subs, and they
  // are all in set 1 — the tab the game is showing. Taking them off lets the paste through.
  for (let i = 0; i < 6; i += 1) day = S.setPlayerTicked(day, 'g', 1, `cx-sub0000${i}`, false).session;
  const retry = S.openDayRoster(day, full, 'now');
  assert.equal(retry.kind, 'sameDay');
  assert.equal(retry.session.games[0].setCount, 5);
  assert.equal(S.getCount(retry.session.games[0], 1, 'p0').serve.in, 1);
});

test('setPlayerTicked and addSub refuse an out-of-range set instead of throwing', () => {
  const s = openV2();
  for (const n of [0, 6, 1.5, undefined]) {
    assert.deepEqual(S.setPlayerTicked(s, 'game-1', n, 'grace', true), { ok: false, error: 'That set does not exist.' });
    assert.deepEqual(S.addSub(s, 'game-1', n, 'Ava'), { ok: false, error: 'That set does not exist.' });
  }
  // A bad gameId still reports the game, not the set.
  assert.equal(S.setPlayerTicked(s, 'nope', 9, 'grace', true).error, 'That game does not exist.');
  assert.equal(S.addSub(s, 'nope', 9, 'Ava').error, 'That game does not exist.');
});

test('schema 3 round-trips, and a schema 2 save migrates to five tabs', () => {
  const day = S.newDayFromRoster(rosterV3, '2026-09-19T09:00:00Z');
  const parsed = S.parseSession(S.serialiseSession(day));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, day);

  const schema2 = JSON.stringify({
    schema: 2, savedAt: '2026-09-19T20:00:00Z',
    session: {
      date: '2026-09-19', team: 'Thunder',
      players: [{ id: 'grace', name: 'Grace', sub: false }, { id: 'zoie', name: 'Zoë', sub: false }],
      games: [{
        gameId: 'game-1', opponent: 'Lions', playerIds: ['grace', 'zoie'],
        sets: [null, null, null, null, null], activeSet: 1, history: [],
      }],
      activeGameId: 'game-1', importedAt: '2026-09-19T09:00:00Z', lastExportedAt: null, lastChangedAt: null,
    },
  });
  const migrated = S.parseSession(schema2);
  assert.equal(migrated.ok, true);
  const g = migrated.value.games[0];
  assert.equal(g.setCount, MAX_SETS, 'a schema-2 day was recorded under a five-tab UI; keep five');
  assert.equal(g.playerIds, undefined, 'the flat list is gone');
  for (let i = 0; i < MAX_SETS; i += 1) assert.deepEqual(g.setPlayerIds[i], ['grace', 'zoie']);
});

test('tap clamps to 0..999 and records history; undo reverses', () => {
  let s = open();
  s = S.tap(s, 'game-1', 1, 'grace', 'serve', 'in', -1);
  assert.equal(S.getCount(s.games[0], 1, 'grace').serve.in, 0);
  for (let i = 0; i < 1005; i++) s = S.tap(s, 'game-1', 1, 'grace', 'serve', 'in', +1);
  assert.equal(S.getCount(s.games[0], 1, 'grace').serve.in, 999);
  assert.ok(s.games[0].history.length <= S.UNDO_LIMIT);
  const u = S.undo(s, 'game-1');
  assert.equal(S.getCount(u.session.games[0], 1, 'grace').serve.in, 998);
  assert.deepEqual(u.undone, { n: 1, playerId: 'grace', stat: 'serve', side: 'in', delta: 1 });
});

test('a no-op tap (subtract at 0) pushes no history', () => {
  const s = S.tap(open(), 'game-1', 1, 'grace', 'return', 'out', -1);
  assert.equal(s.games[0].history.length, 0);
});

test('undo pops exactly one history entry each time', () => {
  let s = open();
  s = S.tap(s, 'game-1', 1, 'grace', 'serve', 'in', 1);
  s = S.tap(s, 'game-1', 1, 'zoie', 'serve', 'in', 1);
  assert.equal(s.games[0].history.length, 2);
  let u = S.undo(s, 'game-1');
  s = u.session;
  assert.equal(s.games[0].history.length, 1);
  assert.equal(S.getCount(s.games[0], 1, 'zoie').serve.in, 0);
  u = S.undo(s, 'game-1');
  s = u.session;
  assert.equal(s.games[0].history.length, 0);
  assert.equal(S.getCount(s.games[0], 1, 'grace').serve.in, 0);
  assert.equal(S.getCount(s.games[0], 1, 'zoie').serve.in, 0);
  u = S.undo(s, 'game-1');
  assert.equal(u.undone, null);
  assert.equal(u.session, s);
});

test('undo of a clamped tap reverses only the recorded delta', () => {
  let s = open();
  for (let i = 0; i < 995; i++) s = S.tap(s, 'game-1', 1, 'grace', 'serve', 'in', 1);
  s = S.tap(s, 'game-1', 1, 'grace', 'serve', 'in', 10); // clamps 995+10=1005 down to 999 (actual delta 4)
  assert.equal(S.getCount(s.games[0], 1, 'grace').serve.in, 999);
  const lastEntry = s.games[0].history[s.games[0].history.length - 1];
  assert.equal(lastEntry.delta, 4);
  const u = S.undo(s, 'game-1');
  assert.equal(S.getCount(u.session.games[0], 1, 'grace').serve.in, 995);
});

test('setActiveSet(3) does not itself start set 3, and 5 slots/history range are honoured', () => {
  // openV2, not open: this asserts on sets 3 and 5, so the game must really have five of them.
  let s = openV2();
  s = S.setActiveSet(s, 'game-1', 3);
  assert.equal(S.isSetPlayed(s.games[0].sets[2]), false);
  s = S.tap(s, 'game-1', 5, 'grace', 'serve', 'in', 1);
  assert.equal(S.getCount(s.games[0], 5, 'grace').serve.in, 1);
});

test('buildDayStatsPayload reproduces the golden v2 stats vector', () => {
  let s = S.newDayFromRoster(rosterV2AsV3, '2026-09-19T20:00:00Z');
  s = S.addSub(s, 'game-1', 1, 'Ava', 'cx-8f2k1q').session;
  s = S.setPlayerTicked(s, 'game-2', 1, 'cx-8f2k1q', true).session;
  const t = (gameId, n, id, stat, side, k) => {
    for (let i = 0; i < k; i++) s = S.tap(s, gameId, n, id, stat, side, 1);
  };
  t('game-1', 1, 'grace', 'serve', 'in', 8);
  t('game-1', 1, 'grace', 'serve', 'out', 2);
  t('game-1', 1, 'grace', 'return', 'in', 5);
  t('game-1', 1, 'grace', 'return', 'out', 1);
  t('game-1', 1, 'cx-8f2k1q', 'return', 'in', 3);
  s = S.setScore(s, 'game-1', 1, [25, 21]);
  t('game-1', 2, 'grace', 'serve', 'in', 4);
  t('game-1', 2, 'grace', 'serve', 'out', 1);
  t('game-1', 2, 'grace', 'return', 'in', 2);
  t('game-1', 2, 'grace', 'return', 'out', 2);
  t('game-2', 1, 'cx-8f2k1q', 'serve', 'in', 6);
  t('game-2', 1, 'cx-8f2k1q', 'serve', 'out', 1);
  t('game-2', 1, 'cx-8f2k1q', 'return', 'in', 2);
  s = S.setScore(s, 'game-2', 1, [25, 18]);

  const out = S.buildDayStatsPayload(s, '2026-09-19T21:04:00Z');
  assert.equal(out.ok, true);
  assert.equal(out.value.text, STATS_V2_VECTOR.encoded);
  assert.deepEqual(decodeDayStats(out.value.text).value, STATS_V2_VECTOR.payload);
  // Zoie is never tapped: no stat line, filtered from the sent directory.
  assert.deepEqual(out.value.payload.players.map((p) => p.id), ['grace', 'cx-8f2k1q']);
});

test('sets with no score and no counts are omitted, per game', () => {
  let s = openV2();
  s = S.setActiveSet(s, 'game-1', 3); // visiting set 3 does not start it
  s = S.tap(s, 'game-2', 1, 'zoie', 'serve', 'in', 1);
  const out = S.buildDayStatsPayload(s, 'now');
  assert.equal(out.ok, true);
  assert.ok(!out.value.payload.games.some((g) => g.gameId === 'game-1'));
  const g2 = out.value.payload.games.find((g) => g.gameId === 'game-2');
  assert.deepEqual(g2.sets.map((x) => x.n), [1]);
  assert.deepEqual(g2.sets[0].players.map((x) => x.id), ['zoie']);
});

test('export refuses a day with nothing recorded', () => {
  const s = openV2();
  assert.equal(S.buildDayStatsPayload(s, 'now').error, 'Nothing recorded yet — tap a count or enter a score first.');
});

test('a score-only day (no counts anywhere) falls back to the whole directory, not an empty player list', () => {
  let s = openV2();
  // Score set, no taps at all — isSetPlayed() is true via the score alone, but usedIds stays empty.
  s = S.setScore(s, 'game-1', 1, [25, 21]);
  const out = S.buildDayStatsPayload(s, '2026-09-19T21:04:00Z');
  assert.equal(out.ok, true);
  assert.deepEqual(out.value.payload.players.map((p) => p.id), s.players.map((p) => p.id));
  assert.ok(out.value.payload.players.length > 0);
  const game1 = out.value.payload.games.find((g) => g.gameId === 'game-1');
  assert.deepEqual(game1.sets, [{ n: 1, score: [25, 21], players: [] }]);
  // Must survive the validator (payload key order, non-empty players) and round-trip.
  const decoded = decodeDayStats(out.value.text);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.value, out.value.payload);
});

test('setPlayerTicked adds, caps at 12, refuses to untick a counted player, and leaves the directory whole', () => {
  let s = openV2();
  for (let i = 0; i < 10; i++) s = S.addSub(s, 'game-1', 1, `Sub ${i}`).session;
  assert.equal(S.gamePlayerIdsUnion(s.games[0]).length, 12);
  // a directory member added through game-2, not yet ticked into the (full) game-1
  s = S.addSub(s, 'game-2', 1, 'Ava', 'cx-8f2k1q').session;

  const full = S.setPlayerTicked(s, 'game-1', 1, 'cx-8f2k1q', true);
  assert.equal(full.ok, false);
  assert.equal(full.error, 'This game already has 12 players; the stats app limit is 12.');

  s = S.tap(s, 'game-1', 1, 'grace', 'serve', 'in', 1);
  const blocked = S.setPlayerTicked(s, 'game-1', 1, 'grace', false);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'Grace has counts in Set 1 — clear the set first to take her off.');

  const untick = S.setPlayerTicked(s, 'game-1', 1, 'zoie', false); // zoie has no counts in set 1
  assert.equal(untick.ok, true);
  assert.ok(!untick.session.games[0].setPlayerIds[0].includes('zoie'));
  assert.ok(untick.session.games[0].setPlayerIds[1].includes('zoie')); // set 2's list is its own
  assert.ok(untick.session.players.some((p) => p.id === 'zoie')); // stays in the directory
});

test('addSub mints a cx- id, trims the name, sets sub:true, and ticks into this game only', () => {
  const s = openV2();
  const r = S.addSub(s, 'game-1', 1, '  Ava  ', undefined);
  assert.equal(r.ok, true);
  const added = r.session.players.find((p) => p.name === 'Ava');
  assert.ok(added);
  assert.match(added.id, /^cx-[A-Za-z0-9]{8}$/);
  assert.equal(added.sub, true);
  assert.ok(r.session.games.find((g) => g.gameId === 'game-1').setPlayerIds[0].includes(added.id));
  assert.ok(!S.gamePlayerIdsUnion(r.session.games.find((g) => g.gameId === 'game-2')).includes(added.id));
});

test('addSub refuses a duplicate name case-insensitively', () => {
  const s = openV2();
  const r = S.addSub(s, 'game-1', 1, 'grace', undefined);
  assert.equal(r.ok, false);
  assert.equal(r.error, "Someone called grace is already in today's players — tick her instead.");
});

test('addSub validates the name and reports the game-not-found case', () => {
  const s = openV2();
  assert.equal(S.addSub(s, 'game-1', 1, '   ').error, 'Enter a name.');
  assert.equal(S.addSub(s, 'game-1', 1, 'x'.repeat(65)).error, 'That name is 65 characters; the limit is 64.');
  assert.equal(S.addSub(s, 'no-such-game', 1, 'Ava').error, 'That game does not exist.');
});

test('addSub caps per-game at 12 and per-day at 24, with distinct messages', () => {
  let s = openV2();
  for (let i = 0; i < 10; i++) s = S.addSub(s, 'game-1', 1, `Sub ${i}`).session;
  assert.equal(S.addSub(s, 'game-1', 1, 'One more').error, 'This game already has 12 players; the stats app limit is 12.');

  // Day cap: spread additions across three fresh games so no single game's 12-cap is hit first.
  let s2 = openV2();
  const extraGames = {
    v: 3, kind: 'roster', date: s2.date, team: s2.team, players: rosterV2AsV3.players,
    games: [
      // sets: [0] — one set, nobody picked. `sets: []` is not a legal game at v3.
      { gameId: 'game-3', opponent: 'Hawks', sets: [0] },
      { gameId: 'game-4', opponent: 'Eagles', sets: [0] },
    ],
  };
  s2 = S.openDayRoster(s2, extraGames, 'x').session;
  for (let i = 0; i < 10; i++) s2 = S.addSub(s2, 'game-1', 1, `G1 Sub ${i}`).session; // game-1: 2 -> 12
  for (let i = 0; i < 11; i++) s2 = S.addSub(s2, 'game-2', 1, `G2 Sub ${i}`).session; // game-2: 1 -> 12
  s2 = S.addSub(s2, 'game-3', 1, 'G3 Sub').session; // one more, via an otherwise-empty game
  assert.equal(s2.players.length, 24);
  assert.equal(S.addSub(s2, 'game-3', 1, 'Overflow').error, 'Today already has 24 players; the day limit is 24.');
});

test('openDayRoster merges a same-date roster in place: refreshes names, keeps counted players, adds games, never deletes a local-only game', () => {
  let s = openV2();
  s = S.addSub(s, 'game-1', 1, 'Ava', 'cx-8f2k1q').session;
  s = S.tap(s, 'game-1', 1, 'cx-8f2k1q', 'serve', 'in', 1);
  // simulate a locally-recorded game the incoming roster will not mention
  s = { ...s, games: [...s.games, { gameId: 'local-only', opponent: 'Pumas', setCount: 1, setPlayerIds: [['grace'], [], [], [], []], sets: Array(5).fill(null), activeSet: 1, history: [] }] };

  const incoming = {
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder FC',
    players: [{ id: 'grace', name: 'Grace S.' }, { id: 'zoie', name: 'Zoë' }, { id: 'new1', name: 'New Girl' }],
    games: [
      { gameId: 'game-1', opponent: 'Lions', sets: [1] }, // maskOf([0]): drops zoie from set 1's tick list
      { gameId: 'game-2', opponent: 'Falcons', sets: [6] }, // maskOf([1, 2])
      { gameId: 'game-3', opponent: 'Sharks', sets: [4] }, // maskOf([2])
    ],
  };
  const r = S.openDayRoster(s, incoming, 'x');
  assert.equal(r.kind, 'sameDay');
  const merged = r.session;
  assert.equal(merged.team, 'Thunder FC');
  assert.equal(merged.players.find((p) => p.id === 'grace').name, 'Grace S.'); // name refreshed
  assert.ok(merged.players.some((p) => p.id === 'new1')); // new directory entry
  assert.deepEqual(r.added, { games: 1, players: 1 });
  // game-1 set 1: incoming [grace], zoie dropped (no counts there), cx-8f2k1q kept (has counts there)
  assert.deepEqual(merged.games.find((g) => g.gameId === 'game-1').setPlayerIds[0], ['grace', 'cx-8f2k1q']);
  assert.deepEqual(merged.games.find((g) => g.gameId === 'game-2').setPlayerIds[0], ['zoie', 'new1']);
  assert.deepEqual(merged.games.find((g) => g.gameId === 'game-3').setPlayerIds[0], ['new1']);
  assert.ok(merged.games.some((g) => g.gameId === 'local-only')); // never deleted
  assert.equal(merged.lastChangedAt, s.lastChangedAt); // a roster merge adds no stats
});

test('openDayRoster refuses a same-date merge that would push a game over its player cap', () => {
  let s = openV2();
  for (let i = 0; i < 10; i++) s = S.addSub(s, 'game-1', 1, `Sub ${i}`).session;
  assert.equal(S.gamePlayerIdsUnion(s.games[0]).length, 12);
  const incoming = {
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }, { id: 'zoie', name: 'Zoë' }, { id: 'new1', name: 'New' }],
    // maskOf([0, 1, 2]) === 7, maskOf([1]) === 2
    games: [{ gameId: 'game-1', opponent: 'Lions', sets: [7] }, { gameId: 'game-2', opponent: 'Falcons', sets: [2] }],
  };
  const r = S.openDayRoster(s, incoming, 'x');
  assert.equal(r.kind, 'error');
  assert.match(r.error, /the game limit is 12/);
});

test('openDayRoster refuses a same-date merge that would push the day over its player cap', () => {
  const s = openV2();
  const incoming = {
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }, ...Array.from({ length: 23 }, (_, i) => ({ id: `n${i}`, name: `N${i}` }))],
    games: [{ gameId: 'game-1', opponent: 'Lions', sets: [1] }], // maskOf([0])
  };
  const r = S.openDayRoster(s, incoming, 'x');
  assert.equal(r.kind, 'error');
  assert.equal(r.error, 'Updating would make 25 players; the day limit is 24.');
});

test('openDayRoster refuses a same-date merge that would push the day over its game cap', () => {
  const s = openV2(); // game-1, game-2
  const manyGames = Array.from({ length: 7 }, (_, i) => ({ gameId: `extra-${i}`, opponent: `Team ${i}`, sets: [0] }));
  const incoming = {
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }, { id: 'zoie', name: 'Zoë' }],
    games: [{ gameId: 'game-1', opponent: 'Lions', sets: [3] }, ...manyGames], // maskOf([0, 1]); game-2 left local-only
  };
  const r = S.openDayRoster(s, incoming, 'x');
  assert.equal(r.kind, 'error');
  assert.match(r.error, /the day limit is 8/);
});

test('openDayRoster on a different date reports otherDay without touching state; replaceDay confirms', () => {
  let s = openV2();
  s = S.tap(s, 'game-1', 1, 'grace', 'serve', 'in', 1);
  const otherRoster = { ...rosterV2AsV3, date: '2026-09-20' };
  const r = S.openDayRoster(s, otherRoster, 'x');
  assert.equal(r.kind, 'otherDay');
  assert.equal(r.unexported, true);
  assert.equal(r.roster, otherRoster);
  assert.equal(S.getCount(s.games[0], 1, 'grace').serve.in, 1); // untouched

  const replaced = S.replaceDay(s, otherRoster, 'y');
  assert.equal(replaced.date, '2026-09-20');
  assert.equal(replaced.activeGameId, 'game-1');
  assert.equal(S.getCount(replaced.games[0], 1, 'grace').serve.in, 0); // a fresh day
});

test('games are isolated; deleteGame moves activeGameId and clears the day when the last game goes', () => {
  let s = openV2();
  s = S.tap(s, 'game-2', 1, 'zoie', 'serve', 'in', 1);
  assert.equal(S.getCount(s.games[0], 1, 'zoie').serve.in, 0);
  s = S.deleteGame(s, 'game-2');
  assert.equal(s.activeGameId, 'game-1');
  assert.equal(s.games.length, 1);
  s = S.deleteGame(s, 'game-1');
  assert.deepEqual(s, S.newSession());
});

test('envelope round-trips and rejects junk; schema 1 is accepted and migrated', () => {
  const s = openV2();
  const parsed = S.parseSession(S.serialiseSession(s));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, s);
  assert.equal(S.parseSession('{"schema":99}').ok, false);
  assert.equal(S.parseSession('not json').ok, false);

  const v1Envelope = {
    schema: 1, savedAt: 'x',
    session: {
      activeGameId: 'g1',
      games: [{
        gameId: 'g1', team: 'Thunder', opponent: 'Lions', date: '2026-09-19', importedAt: 'a',
        players: [{ id: 'grace', name: 'Grace', sub: false }], sets: [null, null, null], activeSet: 1, history: [], lastExportedAt: null,
      }],
    },
  };
  const v1Result = S.parseSession(JSON.stringify(v1Envelope));
  assert.equal(v1Result.ok, true);
  assert.equal(v1Result.value.date, '2026-09-19');
  assert.equal(v1Result.value.games[0].sets.length, 5);
});

test('self-check passes', () => { assert.deepEqual(S.runSelfCheck(), { ok: true }); });

test('decodeDayRoster normalises all three roster versions (v1, v2, v3) to the current day shape', () => {
  const v1 = decodeDayRoster(ROSTER_VECTOR.encoded);
  assert.equal(v1.ok, true);
  assert.deepEqual(v1.value, ROSTER_V1_AS_DAY);

  const v2 = decodeDayRoster(ROSTER_V2_VECTOR.encoded);
  assert.equal(v2.ok, true);
  assert.deepEqual(v2.value, ROSTER_V2_AS_V3);

  const v3 = decodeDayRoster(ROSTER_V3_VECTOR.encoded);
  assert.equal(v3.ok, true);
  assert.deepEqual(v3.value, ROSTER_V3_VECTOR.payload);
});

test('gameLabel prefers the opponent and falls back to an ordinal', () => {
  assert.equal(S.gameLabel({ opponent: 'Lions' }, 0), 'vs Lions');
  assert.equal(S.gameLabel({ opponent: '' }, 2), 'Game 3');
});

test('dayLabel leads with the team when present, date alone when it is empty', () => {
  assert.equal(S.dayLabel({ date: '2026-09-19', team: 'Thunder' }), 'Thunder · 19 Sep');
  assert.equal(S.dayLabel({ date: '2026-09-19', team: '' }), '19 Sep');
});

test('parseSession rejects malformed saved data field by field', () => {
  // Single-game fixture: corrupting the day's only game must fail the whole parse rather than
  // merely being salvaged away (see the dedicated salvage test below for the multi-game case).
  const base = JSON.parse(S.serialiseSession(open()));
  const rejects = (fn) => {
    const mutated = structuredClone(base);
    fn(mutated);
    return S.parseSession(JSON.stringify(mutated)).ok === false;
  };
  assert.ok(rejects((m) => { m.session.games[0].sets[0] = { score: null, counts: { grace: { serve: { in: 1000, out: 0 }, return: { in: 0, out: 0 } } } }; }));
  assert.ok(rejects((m) => { m.session.games[0].sets[0] = { score: [25], counts: {} }; }));
  assert.ok(rejects((m) => { m.session.players[0].id = 'a b'; }));
  assert.ok(rejects((m) => { while (m.session.players.length < 25) m.session.players.push({ id: `p${m.session.players.length}`, name: 'P', sub: true }); }));
  assert.ok(rejects((m) => { m.session.games[0].sets = m.session.games[0].sets.slice(0, 4); }));
  assert.ok(rejects((m) => { m.session.games[0].activeSet = 6; }));
  assert.ok(rejects((m) => { m.session.games[0].setCount = 0; }));
  assert.ok(rejects((m) => { m.session.games[0].setCount = 6; }));
  assert.ok(rejects((m) => { m.session.games[0].setPlayerIds = m.session.games[0].setPlayerIds.slice(0, 4); }));
  assert.ok(rejects((m) => { m.session.games[0].setPlayerIds[0] = ['grace', 'grace']; }));
  assert.ok(rejects((m) => { m.session.games[0].setPlayerIds[0] = ['nobody']; }));
  assert.ok(rejects((m) => { m.session.games = {}; }));
});

test('parseSession salvages good games and reports dropped ones', () => {
  const s = openV2();
  const envelope = JSON.parse(S.serialiseSession(s));
  const g2 = envelope.session.games.find((g) => g.gameId === 'game-2');
  g2.sets[0] = { score: null, counts: { zoie: { serve: { in: 1000, out: 0 }, return: { in: 0, out: 0 } } } };
  const result = S.parseSession(JSON.stringify(envelope));
  assert.equal(result.ok, true);
  assert.equal(result.value.games.length, 1);
  assert.equal(result.dropped, 1);
  assert.equal(result.value.activeGameId, 'game-1');
  assert.deepEqual(result.value.games[0], s.games.find((g) => g.gameId === 'game-1'));
});

test('migration from schema 1: single date pads sets, unions the directory, preserves per-game setPlayerIds and counts', () => {
  const g1 = {
    gameId: 'g1', team: 'Thunder', opponent: 'Lions', date: '2026-09-19', importedAt: '2026-09-19T09:00:00Z',
    players: [{ id: 'grace', name: 'Grace', sub: false }, { id: 'zoie', name: 'Zoë', sub: false }],
    sets: [{ score: [25, 20], counts: { grace: { serve: { in: 3, out: 1 }, return: { in: 0, out: 0 } } } }, null, null],
    activeSet: 1,
    history: [{ n: 1, playerId: 'grace', stat: 'serve', side: 'in', delta: 3 }],
    lastExportedAt: null,
  };
  const g2 = {
    gameId: 'g2', team: 'Thunder', opponent: 'Bears', date: '2026-09-19', importedAt: '2026-09-19T11:00:00Z',
    players: [{ id: 'zoie', name: 'Zoë', sub: false }, { id: 'cx-abc12345', name: 'Ava', sub: true }],
    sets: [null, null, null],
    activeSet: 1,
    history: [],
    lastExportedAt: '2026-09-19T12:00:00Z',
  };
  const envelope = { schema: 1, savedAt: 'x', session: { activeGameId: 'g2', games: [g1, g2] } };
  const result = S.parseSession(JSON.stringify(envelope));
  assert.equal(result.ok, true);
  assert.equal(result.droppedDays, 0);
  assert.equal(result.value.date, '2026-09-19');
  assert.equal(result.value.team, 'Thunder');
  assert.deepEqual(result.value.players.map((p) => p.id), ['grace', 'zoie', 'cx-abc12345']);
  assert.equal(result.value.players.find((p) => p.id === 'cx-abc12345').sub, true);
  // A schema-1 save had no per-set membership, so every slot inherits the game's whole list.
  assert.equal(result.value.games[0].setCount, 5);
  for (let i = 0; i < 5; i += 1) assert.deepEqual(result.value.games[0].setPlayerIds[i], ['grace', 'zoie']);
  assert.deepEqual(result.value.games[1].setPlayerIds[0], ['zoie', 'cx-abc12345']);
  assert.equal(result.value.games[0].sets.length, 5);
  assert.deepEqual(result.value.games[0].sets[0].counts.grace.serve, { in: 3, out: 1 });
  assert.deepEqual(result.value.games[0].sets.slice(3), [null, null]);
  assert.equal(result.value.importedAt, '2026-09-19T09:00:00Z');
  // Finding 2: a day is exported only if EVERY played game went out. g1 has a played set (a
  // score, and counts) and lastExportedAt: null; g2's own lastExportedAt is non-null but that
  // must NOT leak onto the day — a `max` reduce here would wrongly mark the whole day exported
  // and suppress the replace-day/new-day warning while g1's counts were never sent anywhere.
  assert.equal(result.value.lastExportedAt, null);
  assert.equal(result.value.lastChangedAt, null);
  assert.equal(result.value.activeGameId, 'g2');
});

test('migration from schema 1: lastExportedAt is the max of kept games only once every played game has been exported', () => {
  const g1 = {
    gameId: 'g1', team: 'Thunder', opponent: 'Lions', date: '2026-09-19', importedAt: '2026-09-19T09:00:00Z',
    players: [{ id: 'grace', name: 'Grace', sub: false }],
    sets: [{ score: [25, 20], counts: { grace: { serve: { in: 3, out: 1 }, return: { in: 0, out: 0 } } } }, null, null],
    activeSet: 1, history: [], lastExportedAt: '2026-09-19T10:00:00Z',
  };
  const g2 = {
    gameId: 'g2', team: 'Thunder', opponent: 'Bears', date: '2026-09-19', importedAt: '2026-09-19T11:00:00Z',
    players: [{ id: 'grace', name: 'Grace', sub: false }],
    sets: [{ score: [25, 18], counts: { grace: { serve: { in: 2, out: 0 }, return: { in: 0, out: 0 } } } }, null, null],
    activeSet: 1, history: [], lastExportedAt: '2026-09-19T12:00:00Z',
  };
  const envelope = { schema: 1, savedAt: 'x', session: { activeGameId: 'g2', games: [g1, g2] } };
  const result = S.parseSession(JSON.stringify(envelope));
  assert.equal(result.ok, true);
  // Both played games were exported — the max of the two timestamps is meaningful here, and the
  // day is correctly treated as fully exported.
  assert.equal(result.value.lastExportedAt, '2026-09-19T12:00:00Z');
});

test('migration from schema 1: an unplayed kept game with a stale lastExportedAt does not force the day to null', () => {
  const g1 = {
    gameId: 'g1', team: 'Thunder', opponent: 'Lions', date: '2026-09-19', importedAt: '2026-09-19T09:00:00Z',
    players: [{ id: 'grace', name: 'Grace', sub: false }],
    sets: [{ score: [25, 20], counts: { grace: { serve: { in: 3, out: 1 }, return: { in: 0, out: 0 } } } }, null, null],
    activeSet: 1, history: [], lastExportedAt: '2026-09-19T10:00:00Z',
  };
  // g2 was never played (no score, no counts) but still carries a null lastExportedAt from before
  // it was cleared -- it must not count against the "every played game exported" rule.
  const g2 = {
    gameId: 'g2', team: 'Thunder', opponent: 'Bears', date: '2026-09-19', importedAt: '2026-09-19T11:00:00Z',
    players: [{ id: 'grace', name: 'Grace', sub: false }],
    sets: [null, null, null],
    activeSet: 1, history: [], lastExportedAt: null,
  };
  const envelope = { schema: 1, savedAt: 'x', session: { activeGameId: 'g1', games: [g1, g2] } };
  const result = S.parseSession(JSON.stringify(envelope));
  assert.equal(result.ok, true);
  assert.equal(result.value.lastExportedAt, '2026-09-19T10:00:00Z');
});

test('parseGameV1 refuses an empty date (finding 3): the only game names date "" and is salvage-dropped, leaving the whole schema-1 session malformed rather than migrating to an unreadable day', () => {
  const gEmpty = {
    gameId: 'gEmpty', team: 'Thunder', opponent: 'Lions', date: '', importedAt: '2026-09-19T09:00:00Z',
    players: [{ id: 'grace', name: 'Grace', sub: false }],
    sets: [null, null, null], activeSet: 1, history: [], lastExportedAt: null,
  };
  const envelope = { schema: 1, savedAt: 'x', session: { activeGameId: 'gEmpty', games: [gEmpty] } };
  const result = S.parseSession(JSON.stringify(envelope));
  // Before the fix, parseGameV1 accepted `date: ''`, migrateSchema1 lifted it to `day.date = ''`,
  // and parseDay's own non-empty check would only reject it on the NEXT boot -- by which point
  // ui.js's re-commit had already overwritten the original schema-1 save. Rejecting the game here,
  // during the legacy parse itself, means the schema-1 raw save is what survives untouched.
  assert.equal(result.ok, false);
});

test('parseGameV1 salvage-drops an empty-date game but migrates cleanly when another kept game has a real date, and the result round-trips as a valid schema-3 save', () => {
  const gEmpty = {
    gameId: 'gEmpty', team: 'Thunder', opponent: 'Lions', date: '', importedAt: '2026-09-19T09:00:00Z',
    players: [{ id: 'grace', name: 'Grace', sub: false }],
    sets: [null, null, null], activeSet: 1, history: [], lastExportedAt: null,
  };
  const gGood = {
    gameId: 'gGood', team: 'Thunder', opponent: 'Bears', date: '2026-09-19', importedAt: '2026-09-19T09:00:00Z',
    players: [{ id: 'grace', name: 'Grace', sub: false }],
    sets: [null, null, null], activeSet: 1, history: [], lastExportedAt: null,
  };
  const envelope = { schema: 1, savedAt: 'x', session: { activeGameId: 'gGood', games: [gEmpty, gGood] } };
  const result = S.parseSession(JSON.stringify(envelope));
  assert.equal(result.ok, true);
  assert.equal(result.dropped, 1);
  assert.equal(result.value.date, '2026-09-19');
  // This is exactly what ui.js's load() re-commits to STORAGE_KEY immediately after a migration —
  // it must itself parse back as a valid schema-3 save, not be rejected on the very next boot.
  const saved = S.serialiseSession(result.value);
  const reparsed = S.parseSession(saved);
  assert.equal(reparsed.ok, true);
  assert.deepEqual(reparsed.value, result.value);
});

test("migration from schema 1: multiple dates keeps the active game's date and reports droppedDays", () => {
  const gOld = {
    gameId: 'gOld', team: 'Thunder', opponent: 'Hawks', date: '2026-09-12', importedAt: '2026-09-12T09:00:00Z',
    players: [{ id: 'p1', name: 'P1', sub: false }], sets: [null, null, null], activeSet: 1, history: [], lastExportedAt: null,
  };
  const gActive = {
    gameId: 'gActive', team: 'Thunder', opponent: 'Lions', date: '2026-09-19', importedAt: '2026-09-19T09:00:00Z',
    players: [{ id: 'grace', name: 'Grace', sub: false }], sets: [null, null, null], activeSet: 1, history: [], lastExportedAt: null,
  };
  const envelope = { schema: 1, savedAt: 'x', session: { activeGameId: 'gActive', games: [gOld, gActive] } };
  const result = S.parseSession(JSON.stringify(envelope));
  assert.equal(result.ok, true);
  assert.equal(result.value.date, '2026-09-19');
  assert.equal(result.value.games.length, 1);
  assert.equal(result.value.games[0].gameId, 'gActive');
  assert.equal(result.droppedDays, 1);
});

test('a schema-1 union over 24 players is refused, not truncated', () => {
  const mk = (id, opponent, importedAt, players) => ({
    gameId: id, team: 'T', opponent, date: '2026-09-19', importedAt,
    players, sets: [null, null, null], activeSet: 1, history: [], lastExportedAt: null,
  });
  const p = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix}${i}`, sub: false }));
  const g1 = mk('g1', 'A', 'a', p('a', 12));
  const g2 = mk('g2', 'B', 'b', p('b', 12));
  const g3 = mk('g3', 'C', 'c', p('c', 3));
  const envelope = { schema: 1, savedAt: 'x', session: { activeGameId: 'g1', games: [g1, g2, g3] } };
  assert.equal(S.parseSession(JSON.stringify(envelope)).ok, false);
});
