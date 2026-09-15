import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/session.js';
import { decodeDayRoster, decodeDayStats } from '../src/codec.js';
import { ROSTER_VECTOR, ROSTER_V2_VECTOR, STATS_V2_VECTOR } from '../src/vectors.js';

const rosterV2 = ROSTER_V2_VECTOR.payload;

// Single-game fixture, rebuilt via decodeDayRoster so v1->day normalisation is exercised for free.
const open = () => S.openDayRoster(S.newSession(), decodeDayRoster(ROSTER_VECTOR.encoded).value, '2026-09-19T20:00:00Z').session;
// Two-game fixture, straight from the v2 golden payload.
const openV2 = () => S.openDayRoster(S.newSession(), rosterV2, '2026-09-19T20:00:00Z').session;

test('openDayRoster creates the day and makes the first game active', () => {
  const s = open();
  assert.equal(s.date, '2026-09-19');
  assert.equal(s.team, 'Thunder');
  assert.equal(s.activeGameId, 'game-1');
  assert.deepEqual(s.players, [
    { id: 'grace', name: 'Grace', sub: false },
    { id: 'zoie', name: 'Zoë', sub: false },
  ]);
  assert.deepEqual(s.games[0].playerIds, ['grace', 'zoie']);
  assert.deepEqual(s.games[0].sets, [null, null, null, null, null]);
});

test('index -> id resolution uses the payload indices, not "everyone"', () => {
  const s = openV2();
  assert.deepEqual(s.games[0].playerIds, ['grace', 'zoie']);
  assert.deepEqual(s.games[1].playerIds, ['zoie']);
});

test('an empty game roster is legal and never filters the directory', () => {
  const roster = { ...rosterV2, games: [{ gameId: 'game-1', opponent: 'Lions', roster: [] }, rosterV2.games[1]] };
  const s = S.newDayFromRoster(roster, 'x');
  assert.deepEqual(s.games[0].playerIds, []);
  assert.deepEqual(s.players, [
    { id: 'grace', name: 'Grace', sub: false },
    { id: 'zoie', name: 'Zoë', sub: false },
  ]);
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
  let s = open();
  s = S.setActiveSet(s, 'game-1', 3);
  assert.equal(S.isSetPlayed(s.games[0].sets[2]), false);
  s = S.tap(s, 'game-1', 5, 'grace', 'serve', 'in', 1);
  assert.equal(S.getCount(s.games[0], 5, 'grace').serve.in, 1);
});

test('buildDayStatsPayload reproduces the golden v2 stats vector', () => {
  let s = S.newDayFromRoster(rosterV2, '2026-09-19T20:00:00Z');
  s = S.addSub(s, 'game-1', 'Ava', 'cx-8f2k1q').session;
  s = S.setPlayerTicked(s, 'game-2', 'cx-8f2k1q', true).session;
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
  for (let i = 0; i < 10; i++) s = S.addSub(s, 'game-1', `Sub ${i}`).session;
  assert.equal(s.games[0].playerIds.length, 12);
  // a directory member added through game-2, not yet ticked into the (full) game-1
  s = S.addSub(s, 'game-2', 'Ava', 'cx-8f2k1q').session;

  const full = S.setPlayerTicked(s, 'game-1', 'cx-8f2k1q', true);
  assert.equal(full.ok, false);
  assert.equal(full.error, 'This game already has 12 players; the stats app limit is 12.');

  s = S.tap(s, 'game-1', 1, 'grace', 'serve', 'in', 1);
  const blocked = S.setPlayerTicked(s, 'game-1', 'grace', false);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'Grace has counts in this game — clear the set first to take her off.');

  const untick = S.setPlayerTicked(s, 'game-1', 'zoie', false); // zoie has no counts
  assert.equal(untick.ok, true);
  assert.ok(!untick.session.games[0].playerIds.includes('zoie'));
  assert.ok(untick.session.players.some((p) => p.id === 'zoie')); // stays in the directory
});

test('addSub mints a cx- id, trims the name, sets sub:true, and ticks into this game only', () => {
  const s = openV2();
  const r = S.addSub(s, 'game-1', '  Ava  ', undefined);
  assert.equal(r.ok, true);
  const added = r.session.players.find((p) => p.name === 'Ava');
  assert.ok(added);
  assert.match(added.id, /^cx-[A-Za-z0-9]{8}$/);
  assert.equal(added.sub, true);
  assert.ok(r.session.games.find((g) => g.gameId === 'game-1').playerIds.includes(added.id));
  assert.ok(!r.session.games.find((g) => g.gameId === 'game-2').playerIds.includes(added.id));
});

test('addSub refuses a duplicate name case-insensitively', () => {
  const s = openV2();
  const r = S.addSub(s, 'game-1', 'grace', undefined);
  assert.equal(r.ok, false);
  assert.equal(r.error, "Someone called grace is already in today's players — tick her instead.");
});

test('addSub validates the name and reports the game-not-found case', () => {
  const s = openV2();
  assert.equal(S.addSub(s, 'game-1', '   ').error, 'Enter a name.');
  assert.equal(S.addSub(s, 'game-1', 'x'.repeat(65)).error, 'That name is 65 characters; the limit is 64.');
  assert.equal(S.addSub(s, 'no-such-game', 'Ava').error, 'That game does not exist.');
});

test('addSub caps per-game at 12 and per-day at 24, with distinct messages', () => {
  let s = openV2();
  for (let i = 0; i < 10; i++) s = S.addSub(s, 'game-1', `Sub ${i}`).session;
  assert.equal(S.addSub(s, 'game-1', 'One more').error, 'This game already has 12 players; the stats app limit is 12.');

  // Day cap: spread additions across three fresh games so no single game's 12-cap is hit first.
  let s2 = openV2();
  const extraGames = {
    v: 2, kind: 'roster', date: s2.date, team: s2.team, players: rosterV2.players,
    games: [
      { gameId: 'game-3', opponent: 'Hawks', roster: [] },
      { gameId: 'game-4', opponent: 'Eagles', roster: [] },
    ],
  };
  s2 = S.openDayRoster(s2, extraGames, 'x').session;
  for (let i = 0; i < 10; i++) s2 = S.addSub(s2, 'game-1', `G1 Sub ${i}`).session; // game-1: 2 -> 12
  for (let i = 0; i < 11; i++) s2 = S.addSub(s2, 'game-2', `G2 Sub ${i}`).session; // game-2: 1 -> 12
  s2 = S.addSub(s2, 'game-3', 'G3 Sub').session; // one more, via an otherwise-empty game
  assert.equal(s2.players.length, 24);
  assert.equal(S.addSub(s2, 'game-3', 'Overflow').error, 'Today already has 24 players; the day limit is 24.');
});

test('openDayRoster merges a same-date roster in place: refreshes names, keeps counted players, adds games, never deletes a local-only game', () => {
  let s = openV2();
  s = S.addSub(s, 'game-1', 'Ava', 'cx-8f2k1q').session;
  s = S.tap(s, 'game-1', 1, 'cx-8f2k1q', 'serve', 'in', 1);
  // simulate a locally-recorded game the incoming roster will not mention
  s = { ...s, games: [...s.games, { gameId: 'local-only', opponent: 'Pumas', playerIds: ['grace'], sets: Array(5).fill(null), activeSet: 1, history: [] }] };

  const incoming = {
    v: 2, kind: 'roster', date: '2026-09-19', team: 'Thunder FC',
    players: [{ id: 'grace', name: 'Grace S.' }, { id: 'zoie', name: 'Zoë' }, { id: 'new1', name: 'New Girl' }],
    games: [
      { gameId: 'game-1', opponent: 'Lions', roster: [0] }, // drops zoie's index from game-1's tick list
      { gameId: 'game-2', opponent: 'Falcons', roster: [1, 2] },
      { gameId: 'game-3', opponent: 'Sharks', roster: [2] },
    ],
  };
  const r = S.openDayRoster(s, incoming, 'x');
  assert.equal(r.kind, 'sameDay');
  const merged = r.session;
  assert.equal(merged.team, 'Thunder FC');
  assert.equal(merged.players.find((p) => p.id === 'grace').name, 'Grace S.'); // name refreshed
  assert.ok(merged.players.some((p) => p.id === 'new1')); // new directory entry
  assert.deepEqual(r.added, { games: 1, players: 1 });
  // game-1: incoming [grace], zoie dropped (no counts), cx-8f2k1q kept (has counts)
  assert.deepEqual(merged.games.find((g) => g.gameId === 'game-1').playerIds, ['grace', 'cx-8f2k1q']);
  assert.deepEqual(merged.games.find((g) => g.gameId === 'game-2').playerIds, ['zoie', 'new1']);
  assert.deepEqual(merged.games.find((g) => g.gameId === 'game-3').playerIds, ['new1']);
  assert.ok(merged.games.some((g) => g.gameId === 'local-only')); // never deleted
  assert.equal(merged.lastChangedAt, s.lastChangedAt); // a roster merge adds no stats
});

test('openDayRoster refuses a same-date merge that would push a game over its player cap', () => {
  let s = openV2();
  for (let i = 0; i < 10; i++) s = S.addSub(s, 'game-1', `Sub ${i}`).session;
  assert.equal(s.games[0].playerIds.length, 12);
  const incoming = {
    v: 2, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }, { id: 'zoie', name: 'Zoë' }, { id: 'new1', name: 'New' }],
    games: [{ gameId: 'game-1', opponent: 'Lions', roster: [0, 1, 2] }, { gameId: 'game-2', opponent: 'Falcons', roster: [1] }],
  };
  const r = S.openDayRoster(s, incoming, 'x');
  assert.equal(r.kind, 'error');
  assert.match(r.error, /the game limit is 12/);
});

test('openDayRoster refuses a same-date merge that would push the day over its player cap', () => {
  const s = openV2();
  const incoming = {
    v: 2, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }, ...Array.from({ length: 23 }, (_, i) => ({ id: `n${i}`, name: `N${i}` }))],
    games: [{ gameId: 'game-1', opponent: 'Lions', roster: [0] }],
  };
  const r = S.openDayRoster(s, incoming, 'x');
  assert.equal(r.kind, 'error');
  assert.equal(r.error, 'Updating would make 25 players; the day limit is 24.');
});

test('openDayRoster refuses a same-date merge that would push the day over its game cap', () => {
  const s = openV2(); // game-1, game-2
  const manyGames = Array.from({ length: 7 }, (_, i) => ({ gameId: `extra-${i}`, opponent: `Team ${i}`, roster: [] }));
  const incoming = {
    v: 2, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }, { id: 'zoie', name: 'Zoë' }],
    games: [{ gameId: 'game-1', opponent: 'Lions', roster: [0, 1] }, ...manyGames], // game-2 left local-only
  };
  const r = S.openDayRoster(s, incoming, 'x');
  assert.equal(r.kind, 'error');
  assert.match(r.error, /the day limit is 8/);
});

test('openDayRoster on a different date reports otherDay without touching state; replaceDay confirms', () => {
  let s = openV2();
  s = S.tap(s, 'game-1', 1, 'grace', 'serve', 'in', 1);
  const otherRoster = { ...rosterV2, date: '2026-09-20' };
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

test('migration from schema 1: single date pads sets, unions the directory, preserves per-game playerIds and counts', () => {
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
  assert.deepEqual(result.value.games[0].playerIds, ['grace', 'zoie']);
  assert.deepEqual(result.value.games[1].playerIds, ['zoie', 'cx-abc12345']);
  assert.equal(result.value.games[0].sets.length, 5);
  assert.deepEqual(result.value.games[0].sets[0].counts.grace.serve, { in: 3, out: 1 });
  assert.deepEqual(result.value.games[0].sets.slice(3), [null, null]);
  assert.equal(result.value.importedAt, '2026-09-19T09:00:00Z');
  assert.equal(result.value.lastExportedAt, '2026-09-19T12:00:00Z');
  assert.equal(result.value.lastChangedAt, null);
  assert.equal(result.value.activeGameId, 'g2');
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
