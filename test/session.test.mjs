import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/session.js';
import { decodeStats } from '../src/codec.js';
import { ROSTER_VECTOR, STATS_VECTOR } from '../src/vectors.js';

const roster = ROSTER_VECTOR.payload;
const open = () => S.openRoster(S.newSession(), roster, '2026-09-19T20:00:00Z').session;

test('openRoster creates the game and makes it active', () => {
  const s = open();
  assert.equal(s.activeGameId, 'game-1');
  assert.deepEqual(s.games[0].players, [{ id: 'grace', name: 'Grace', sub: false }, { id: 'zoie', name: 'Zoë', sub: false }]);
  assert.deepEqual(s.games[0].sets, [null, null, null]);
});
test('re-opening the same gameId reports exists and changes nothing', () => {
  const s = open();
  const r = S.openRoster(s, roster, 'x');
  assert.equal(r.kind, 'exists');
  assert.equal(r.game.gameId, 'game-1');
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
test('buildStatsPayload reproduces the golden stats vector', () => {
  let s = open();
  s = S.addSub(s, 'game-1', 'Ava', 'cx-8f2k1q').session;
  // remove zoie from the fixture roster by updating to a roster without her (she has no counts)
  s = S.updateRoster(s, 'game-1', { ...roster, players: [roster.players[0]] }).session;
  const t = (n, id, stat, side, k) => { for (let i = 0; i < k; i++) s = S.tap(s, 'game-1', n, id, stat, side, 1); };
  t(1, 'grace', 'serve', 'in', 8); t(1, 'grace', 'serve', 'out', 2); t(1, 'grace', 'return', 'in', 5); t(1, 'grace', 'return', 'out', 1);
  t(1, 'cx-8f2k1q', 'return', 'in', 3);
  s = S.setScore(s, 'game-1', 1, [25, 21]);
  t(2, 'grace', 'serve', 'in', 4); t(2, 'grace', 'serve', 'out', 1); t(2, 'grace', 'return', 'in', 2); t(2, 'grace', 'return', 'out', 2);
  const out = S.buildStatsPayload(s.games[0], '2026-09-19T21:04:00Z');
  assert.equal(out.ok, true);
  assert.equal(out.value.text, STATS_VECTOR.encoded);
  assert.deepEqual(decodeStats(out.value.text).value, STATS_VECTOR.payload);
});
test('sets with no score and no counts are omitted; all-zero players omitted per set', () => {
  let s = open();
  s = S.setActiveSet(s, 'game-1', 3); // visiting set 3 does not start it
  s = S.tap(s, 'game-1', 2, 'zoie', 'serve', 'in', 1);
  const p = S.buildStatsPayload(s.games[0], 'now').value.payload;
  assert.deepEqual(p.sets.map((x) => x.n), [2]);
  assert.deepEqual(p.sets[0].players.map((x) => x.id), ['zoie']);
});
test('export refuses a game with nothing recorded', () => {
  assert.equal(S.buildStatsPayload(open().games[0], 'now').error, 'Nothing recorded yet — tap a count or enter a score first.');
});
test('addSub caps at 12 and validates the name', () => {
  let s = open();
  for (let i = 0; i < 10; i++) s = S.addSub(s, 'game-1', `Sub ${i}`).session;
  assert.equal(S.addSub(s, 'game-1', 'One more').error, 'This game already has 12 players; the stats app limit is 12.');
  assert.equal(S.addSub(s, 'game-1', '   ').error, 'Enter a name.');
  assert.equal(S.addSub(s, 'game-1', 'x'.repeat(65)).error, 'That name is 65 characters; the limit is 64.');
  assert.match(S.newClientId(), /^cx-[A-Za-z0-9]{8}$/);
});
test('updateRoster keeps players with counts, drops zero-count ones, refuses over 12', () => {
  let s = S.tap(open(), 'game-1', 1, 'zoie', 'serve', 'in', 1);
  const r = S.updateRoster(s, 'game-1', { ...roster, players: [{ id: 'new1', name: 'New' }] });
  assert.deepEqual(r.session.games[0].players.map((p) => p.id), ['new1', 'zoie']);
  const big = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, name: 'N' }));
  assert.equal(S.updateRoster(r.session, 'game-1', { ...roster, players: big }).error, 'Updating would make 13 players; the stats app limit is 12.');
});
test('games are isolated; deleteGame moves activeGameId', () => {
  let s = open();
  s = S.openRoster(s, { ...roster, gameId: 'game-2', opponent: 'Bears' }, 'x').session;
  s = S.tap(s, 'game-2', 1, 'grace', 'serve', 'in', 1);
  assert.equal(S.getCount(s.games[0], 1, 'grace').serve.in, 0);
  s = S.deleteGame(s, 'game-2');
  assert.equal(s.activeGameId, 'game-1');
});
test('envelope round-trips and rejects junk', () => {
  const s = open();
  assert.deepEqual(S.parseSession(S.serialiseSession(s)).value, s);
  assert.equal(S.parseSession('{"schema":99}').ok, false);
  assert.equal(S.parseSession('not json').ok, false);
});
test('self-check passes', () => { assert.deepEqual(S.runSelfCheck(), { ok: true }); });
test('gameLabel formats YYYY-MM-DD and passes other text through', () => {
  assert.equal(S.gameLabel({ opponent: 'Lions', date: '2026-09-19' }), 'vs Lions · 19 Sep');
  assert.equal(S.gameLabel({ opponent: 'Lions', date: 'Saturday' }), 'vs Lions · Saturday');
});
test('parseSession rejects malformed saved data field by field', () => {
  const base = JSON.parse(S.serialiseSession(open()));
  const rejects = (fn) => {
    const mutated = structuredClone(base);
    fn(mutated);
    return S.parseSession(JSON.stringify(mutated)).ok === false;
  };
  assert.ok(rejects((m) => { m.session.games[0].sets[0] = { score: null, counts: { grace: { serve: { in: 1000, out: 0 }, return: { in: 0, out: 0 } } } }; }));
  assert.ok(rejects((m) => { m.session.games[0].sets[0] = { score: [25], counts: {} }; }));
  assert.ok(rejects((m) => { m.session.games[0].players[0].id = 'a b'; }));
  assert.ok(rejects((m) => { while (m.session.games[0].players.length < 13) m.session.games[0].players.push({ id: `p${m.session.games[0].players.length}`, name: 'P', sub: true }); }));
  assert.ok(rejects((m) => { m.session.games[0].sets = m.session.games[0].sets.slice(0, 2); }));
  assert.ok(rejects((m) => { m.session.games[0].activeSet = 4; }));
  assert.ok(rejects((m) => { m.session.games = {}; }));
});
test('parseSession salvages good games and reports dropped ones', () => {
  let s = open();
  s = S.openRoster(s, { ...roster, gameId: 'game-2', opponent: 'Bears' }, 'x').session;
  const envelope = JSON.parse(S.serialiseSession(s));
  const g2 = envelope.session.games.find((g) => g.gameId === 'game-2');
  g2.sets[0] = { score: null, counts: { grace: { serve: { in: 1000, out: 0 }, return: { in: 0, out: 0 } } } };
  const result = S.parseSession(JSON.stringify(envelope));
  assert.equal(result.ok, true);
  assert.equal(result.value.games.length, 1);
  assert.equal(result.dropped, 1);
  assert.equal(result.value.activeGameId, 'game-1');
  assert.deepEqual(result.value.games[0], s.games.find((g) => g.gameId === 'game-1'));
});
