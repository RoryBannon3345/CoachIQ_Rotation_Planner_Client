import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_VERSION, MAX_POINTS, MAX_SETS, MAX_ROSTER_PLAYERS, MAX_DAY_PLAYERS, MAX_GAMES_PER_DAY, MAX_RECORDED_AT_LENGTH,
  fnv1a32, encodePayload, decodePayload, decodeRoster, decodeStats, encodeRoster, encodeStats,
  encodeDayRoster, encodeDayStats, decodeDayRoster, decodeDayStats,
  validateRosterPayload, validateStatsPayload, validateDayRosterPayload, validateDayStatsPayload,
  normaliseRosterV1, normaliseStatsV1, maskHas, maskOf, maskMembers, maskCount, maskUnion, serveTurnCount, SERVE_ORDER_PATTERN,
} from '../src/codec.js';
import { ROSTER_VECTOR, STATS_VECTOR, ROSTER_V2_VECTOR, STATS_V2_VECTOR, ROSTER_V3_VECTOR, ROSTER_V6_VECTOR, ROSTER_V3_AS_V6, ROSTER_V2_AS_V6, ROSTER_V1_AS_V6, STATS_V1_AS_DAY, STATS_V4_VECTOR, STATS_V5_VECTOR, STATS_V4_AS_V5, STATS_V2_AS_V5, STATS_V3_AS_V5, STATS_V3_VECTOR } from '../src/vectors.js';

test('fnv1a32 reference values', () => {
  assert.equal(fnv1a32(new Uint8Array()), '811c9dc5');
  assert.equal(fnv1a32(new TextEncoder().encode('a')), 'e40c292c');
});
test('golden roster vector round-trips byte-exact', () => {
  assert.equal(encodeRoster(ROSTER_VECTOR.payload), ROSTER_VECTOR.encoded);
  assert.deepEqual(decodeRoster(ROSTER_VECTOR.encoded), { ok: true, value: ROSTER_VECTOR.payload });
});
test('golden stats vector round-trips byte-exact', () => {
  assert.equal(encodeStats(STATS_VECTOR.payload), STATS_VECTOR.encoded);
  assert.deepEqual(decodeStats(STATS_VECTOR.encoded), { ok: true, value: STATS_VECTOR.payload });
});
test('golden v2 roster vector still encodes and decodes, normalising to one set per game at v6', () => {
  assert.equal(encodePayload('roster', ROSTER_V2_VECTOR.payload, 2), ROSTER_V2_VECTOR.encoded);
  assert.deepEqual(decodeDayRoster(ROSTER_V2_VECTOR.encoded), { ok: true, value: ROSTER_V2_AS_V6 });
});
test('golden v3 roster vector still encodes at 3, and decodes to v6 with no plan', () => {
  assert.equal(encodePayload('roster', ROSTER_V3_VECTOR.payload, 3), ROSTER_V3_VECTOR.encoded);
  assert.deepEqual(decodeDayRoster(ROSTER_V3_VECTOR.encoded), { ok: true, value: ROSTER_V3_AS_V6 });
});
test('golden v6 roster vector round-trips byte-exact', () => {
  assert.equal(encodeDayRoster(ROSTER_V6_VECTOR.payload), ROSTER_V6_VECTOR.encoded);
  assert.ok(ROSTER_V6_VECTOR.encoded.startsWith('CIQR6.'));
  assert.deepEqual(decodeDayRoster(ROSTER_V6_VECTOR.encoded), { ok: true, value: ROSTER_V6_VECTOR.payload });
});
test('mask helpers use arithmetic and survive past bit 30', () => {
  assert.equal(maskHas(3, 0), true);
  assert.equal(maskHas(3, 1), true);
  assert.equal(maskHas(1, 0), true);
  assert.equal(maskHas(1, 1), false);
  assert.equal(maskHas(2, 0), false);
  assert.equal(maskHas(2, 1), true);
  assert.equal(maskHas(0, 0), false);
  assert.deepEqual(maskMembers(3, 2), [0, 1]);
  assert.deepEqual(maskMembers(1, 2), [0]);
  assert.deepEqual(maskMembers(2, 2), [1]);
  assert.deepEqual(maskMembers(0, 2), []);
  assert.equal(maskOf([0, 1]), 3);
  assert.equal(maskOf([1]), 2);
  assert.equal(maskOf([]), 0);
  assert.equal(maskOf([1, 1]), 2, 'a repeated index must not set a second, higher bit');
  assert.equal(maskCount(3, 2), 2);
  assert.equal(maskCount(0, 2), 0);
  assert.equal(maskUnion(1, 2, 2), 3);
  assert.equal(maskUnion(3, 2, 2), 3);
  // The bug the arithmetic form exists to prevent: `1 << 31` is negative, `2 ** 31` is not.
  assert.equal(maskHas(2 ** 31, 31), true);
  assert.equal(maskHas(2 ** 40, 40), true);
  assert.deepEqual(maskMembers(2 ** 35 + 1, 36), [0, 35]);
});

test('the guide§8 worked example decodes to the documented tick lists', () => {
  const r = decodeDayRoster(ROSTER_V3_VECTOR.encoded);
  assert.equal(r.ok, true);
  const names = r.value.players.map((p) => p.name);
  const membersOf = (game, i) => maskMembers(game.sets[i], names.length).map((x) => names[x]);
  const [g1, g2] = r.value.games;
  assert.equal(g1.sets.length, 3, 'sets.length is the set count');
  assert.deepEqual(membersOf(g1, 0), ['Grace', 'Zoë']);
  assert.deepEqual(membersOf(g1, 1), ['Grace']);
  assert.deepEqual(membersOf(g1, 2), ['Zoë']);
  assert.equal(g2.sets.length, 2);
  assert.deepEqual(membersOf(g2, 0), ['Zoë']);
  assert.deepEqual(membersOf(g2, 1), [], 'mask 0 is nobody pre-ticked, not a missing set');
});

test('legacy rosters normalise to v6: v1 and v2 to exactly one set holding the whole roster, and no plan anywhere', () => {
  assert.deepEqual(decodeDayRoster(ROSTER_VECTOR.encoded), { ok: true, value: ROSTER_V1_AS_V6 });
  assert.deepEqual(decodeDayRoster(ROSTER_V2_VECTOR.encoded), { ok: true, value: ROSTER_V2_AS_V6 });
  // One set, not three and not five — inventing a set count would present a fabrication as data.
  for (const g of decodeDayRoster(ROSTER_V2_VECTOR.encoded).value.games) assert.equal(g.sets.length, 1);
  for (const encoded of [ROSTER_VECTOR.encoded, ROSTER_V2_VECTOR.encoded, ROSTER_V3_VECTOR.encoded]) {
    for (const g of decodeDayRoster(encoded).value.games) {
      assert.deepEqual(g.serve, g.sets.map(() => null), 'one null per set: an older roster carries no plan');
    }
  }
});
test('a CIQR7 roster is refused as newer, naming the Rotation Planner', () => {
  // 7, not 6: version 6 is this app's own contract now, so only a 7 is genuinely "newer".
  const future = ROSTER_V6_VECTOR.encoded.replace('CIQR6.', 'CIQR7.');
  assert.deepEqual(decodeDayRoster(future), {
    ok: false,
    error: 'This payload was made by a newer version of the Rotation Planner (contract 7); this app understands 6.',
  });
});

test('roster catalogue: the v3 set rules, read at contract 6', () => {
  const manyPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: 'x' }));
  const base = { v: 6, kind: 'roster', date: 'd', team: 't', players: manyPlayers(2) };
  const nulls = (sets) => (Array.isArray(sets) ? sets.map(() => null) : []);
  const game = (sets) => ({ ...base, games: [{ gameId: 'g', opponent: 'o', sets, serve: nulls(sets) }] });
  // Not a mask at all: negative, fractional, a string, or past the safe-integer range.
  for (const bad of [-1, 1.5, '0', 2 ** 53]) {
    assert.equal(
      validateDayRosterPayload(game([bad])).error,
      'The roster payload is malformed: game "g" set 1 is not a legal roster mask.',
    );
  }
  // A legal integer that sets a bit the directory cannot support. 5 is 101b over 2 players.
  assert.equal(
    validateDayRosterPayload(game([5])).error,
    'The roster payload is malformed: game "g" set 1 names a player outside the directory.',
  );
  // The set number in the message is positional: the second entry reports as set 2.
  assert.equal(
    validateDayRosterPayload(game([3, 4])).error,
    'The roster payload is malformed: game "g" set 2 names a player outside the directory.',
  );
  assert.equal(validateDayRosterPayload(game([])).error, 'The roster payload is malformed: game "g" records no sets.');
  assert.equal(validateDayRosterPayload(game('x')).error, 'The roster payload is malformed: game "g" has no set list.');
  assert.equal(
    validateDayRosterPayload(game([1, 1, 1, 1, 1, 1])).error,
    'The roster payload is malformed: game "g" records more than 5 sets.',
  );
  // The 16-cap is the UNION across sets, not any one set's count.
  const seventeen = { v: 6, kind: 'roster', date: 'd', team: 't', players: manyPlayers(17) };
  assert.equal(
    validateDayRosterPayload({ ...seventeen, games: [{ gameId: 'g', opponent: 'o', sets: [2 ** 17 - 1], serve: [null] }] }).error,
    'The roster payload is malformed: game "g" names 17 players; the limit is 16.',
  );
  // The same 17 players spread across two sets still trip the union cap.
  assert.equal(
    validateDayRosterPayload({ ...seventeen, games: [{ gameId: 'g', opponent: 'o', sets: [2 ** 16 - 1, 2 ** 16], serve: [null, null] }] }).error,
    'The roster payload is malformed: game "g" names 17 players; the limit is 16.',
  );
  // Exactly 16 is legal.
  assert.equal(
    validateDayRosterPayload({ ...seventeen, games: [{ gameId: 'g', opponent: 'o', sets: [2 ** 16 - 1], serve: [null] }] }).ok,
    true,
  );
  // A mask of 0 is legal: the coach sent the day before picking that set.
  assert.equal(validateDayRosterPayload(game([0])).ok, true);
  assert.equal(validateDayRosterPayload(game([3, 0, 1])).ok, true);
  // A v2 or v3 body reaching the v6 validator directly is a version fault, named with all six.
  for (const v of [2, 3]) {
    assert.equal(
      validateDayRosterPayload({ v, kind: 'roster', date: 'd', team: 't', players: manyPlayers(2), games: [] }).error,
      'The roster payload is malformed: its version is not 1, 2, 3, 4, 5 or 6.',
    );
  }
});

test('the serve-order pattern is the Planner’s: 6 to 16 base-32 characters or dashes', () => {
  assert.equal(SERVE_ORDER_PATTERN.source, '^[0-9a-v-]{6,16}$');
});

test('base 32 reaches the 32nd directory player: 0–9, then a for index 10, up to v', () => {
  const players = Array.from({ length: MAX_DAY_PLAYERS }, (_, i) => ({ id: `p${i}`, name: 'x' }));
  const game = { gameId: 'g1', opponent: 'Lions', sets: [maskOf([0, 9, 10, 31])], serve: ['09av--'] };
  const day = { ...ROSTER_V6_VECTOR.payload, players, games: [game] };
  assert.deepEqual(validateDayRosterPayload(day), { ok: true, value: day });
});

test('a game over its cap is reported as that, not as its 17-spot order: every v3 check runs first', () => {
  const players = Array.from({ length: 17 }, (_, i) => ({ id: `p${i}`, name: 'x' }));
  const seventeen = [...Array(17).keys()];
  const order = seventeen.map((i) => i.toString(32)).join('');
  assert.equal(order, '0123456789abcdefg');
  assert.equal(
    validateDayRosterPayload({ ...ROSTER_V6_VECTOR.payload, players, games: [{ gameId: 'g1', opponent: 'Lions', sets: [maskOf(seventeen)], serve: [order] }] }).error,
    'The roster payload is malformed: game "g1" names 17 players; the limit is 16.',
  );
});

test('each v6 game is rebuilt field by field, dropping unknown fields, in a fixed key order', () => {
  const base = ROSTER_V6_VECTOR.payload;
  const decoded = validateDayRosterPayload({ ...base, games: [{ ...base.games[0], ghost: 1 }, base.games[1]] });
  assert.deepEqual(decoded, { ok: true, value: base });
  assert.deepEqual(Object.keys(decoded.value.games[0]), ['gameId', 'opponent', 'sets', 'serve']);
});

test('contract 6 serve-order refusals match the Planner catalogue', () => {
  const players = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  // Set 1 is mask 3 (a, b); set 2 is mask 7 (a, b, c).
  const day = (extra) => ({ v: 6, kind: 'roster', date: 'd', team: 't', players, games: [{ gameId: 'g', opponent: 'o', sets: [3, 7], ...extra }] });
  const fault = (extra) => validateDayRosterPayload(day(extra)).error;
  const M = 'The roster payload is malformed: ';
  const noList = `${M}game "g" has no serve list with one entry per set.`;
  assert.equal(fault({}), noList, 'missing');
  assert.equal(fault({ serve: 'x' }), noList, 'not an array');
  assert.equal(fault({ serve: [null] }), noList, 'one entry for two sets');
  assert.equal(fault({ serve: [null, null, null] }), noList, 'three entries for two sets');
  assert.equal(fault({ serve: [null, 7] }), `${M}game "g" set 2 has a serve order that is not legal.`, 'wrong type');
  for (const bad of ['01010', '0'.repeat(17), '01010W', '01010z', '010 10']) {
    assert.equal(fault({ serve: [bad, null] }), `${M}game "g" set 1 has a serve order that is not legal.`, JSON.stringify(bad));
  }
  assert.equal(fault({ serve: [null, '012v12'] }), `${M}game "g" set 2 serve order names player 31, but the payload lists only 3.`);
  assert.equal(fault({ serve: ['012012', null] }), `${M}game "g" set 1 serve order names a player who is not in that set.`);
  assert.equal(fault({ serve: ['------', null] }), `${M}game "g" set 1 serve order names nobody.`);
  assert.equal(validateDayRosterPayload(day({ serve: ['01-01-', '0120120'] })).ok, true, 'a dash is an empty spot; 7 long is a Train set');
  assert.equal(validateDayRosterPayload(day({ serve: [null, '0123456789abcdef'.replace(/[3-9a-f]/g, '2')] })).ok, true, '16 long is the maximum');
});

test('a stats body at 6 is not a known version: the stats half stays at 5', () => {
  const six = { ...STATS_V5_VECTOR.payload, v: 6 };
  assert.equal(validateDayStatsPayload(six).error, 'The stats payload is malformed: its version is not 1, 2, 3, 4, 5 or 6.');
  assert.equal(decodeDayStats(encodePayload('stats', six, 6)).error, 'The stats payload is malformed: its version is not 1, 2, 3, 4, 5 or 6.');
});
test('golden v5 stats vector round-trips byte-exact; the encode side is at v5 now', () => {
  assert.equal(encodeDayStats(STATS_V5_VECTOR.payload), STATS_V5_VECTOR.encoded);
  assert.ok(STATS_V5_VECTOR.encoded.startsWith('CIQS5.'));
  assert.deepEqual(decodeDayStats(STATS_V5_VECTOR.encoded), { ok: true, value: STATS_V5_VECTOR.payload });
});
test('the golden v4 stats vector still encodes at 4, and decodes with no servers at v5', () => {
  assert.equal(encodePayload('stats', STATS_V4_VECTOR.payload, 4), STATS_V4_VECTOR.encoded);
  assert.ok(STATS_V4_VECTOR.encoded.startsWith('CIQS4.'));
  assert.deepEqual(decodeDayStats(STATS_V4_VECTOR.encoded), { ok: true, value: STATS_V4_AS_V5 });
});
test('v2 and v3 stats bodies still decode, reported at v5 with no log', () => {
  assert.deepEqual(decodeDayStats(STATS_V2_VECTOR.encoded), { ok: true, value: STATS_V2_AS_V5 });
  assert.deepEqual(decodeDayStats(STATS_V3_VECTOR.encoded), { ok: true, value: STATS_V3_AS_V5 });
});
test('serveTurnCount counts our serve turns: a run of rallies we served, the winner serving the next', () => {
  assert.equal(serveTurnCount('UUTTUU', true), 2);
  assert.equal(serveTurnCount('UUTTUU', false), 2);
  assert.equal(serveTurnCount('TTT', false), 0);
  assert.equal(serveTurnCount('', true), 0);
  assert.equal(serveTurnCount(STATS_V5_VECTOR.payload.games[0].sets[0].points, true), 14);
});
test('server-list refusals match the planner catalogue (contract v5)', () => {
  const base = STATS_V5_VECTOR.payload;
  const withSet = (o) => ({ ...base, games: [{ gameId: 'game-1', sets: [{ ...base.games[0].sets[0], ...o }, base.games[0].sets[1]] }, base.games[1]] });
  const fault = (o) => validateDayStatsPayload(withSet(o)).error;
  const fourteen = (id) => Array.from({ length: 14 }, () => id);
  assert.equal(fault({ servers: 'grace' }), 'The stats payload is malformed: game "game-1" set 1 has a malformed server list.');
  assert.equal(fault({ servers: ['grace'] }), 'The stats payload is malformed: game "game-1" set 1 names 1 servers for 14 serve turns.');
  assert.equal(fault({ servers: fourteen('lily') }), 'The stats payload is malformed: game "game-1" set 1 names server "lily", who has no stat line in that set.');
  assert.equal(fault({ servers: fourteen(7) }), 'The stats payload is malformed: game "game-1" set 1 names server "7", who has no stat line in that set.');
  assert.equal(fault({ servedFirst: undefined, points: undefined, servers: [] }), 'The stats payload is malformed: game "game-1" set 1 names servers but has no point log.');
  assert.equal(validateDayStatsPayload(withSet({ servers: fourteen(null) })).ok, true, 'a list that knows nobody is legal');
});
test('the roster is pinned to 6 and the stats sheet to 5', () => {
  assert.ok(encodeDayRoster(ROSTER_V6_VECTOR.payload).startsWith('CIQR6.'));
  assert.equal(encodeDayStats(STATS_V5_VECTOR.payload), STATS_V5_VECTOR.encoded);
  assert.ok(encodeDayStats(STATS_V5_VECTOR.payload).startsWith('CIQS5.'));
});
test('point-log refusals match the planner catalogue', () => {
  const base = STATS_V4_VECTOR.payload;
  const withSet = (o) => ({ ...base, games: [{ gameId: 'game-1', sets: [{ ...base.games[0].sets[0], ...o }] }, base.games[1]] });
  const fault = (o) => validateDayStatsPayload(withSet(o)).error;
  assert.equal(fault({ servedFirst: 'yes' }), 'The stats payload is malformed: game "game-1" set 1 has a malformed point log.');
  assert.equal(fault({ servedFirst: undefined }), 'The stats payload is malformed: game "game-1" set 1 has half a point log.');
  assert.equal(fault({ points: '', score: [0, 0] }), 'The stats payload is malformed: game "game-1" set 1 has an empty point log; leave it out instead.');
  assert.equal(fault({ points: 'U'.repeat(201), score: [201, 0] }), 'The stats payload is malformed: game "game-1" set 1 records more than 200 rallies.');
  assert.equal(fault({ points: 'UUX', score: [2, 1] }), 'The stats payload is malformed: game "game-1" set 1 has a point log with a character other than U or T.');
  assert.equal(fault({ score: null }), 'The stats payload is malformed: game "game-1" set 1 has a point log but no score.');
  assert.equal(fault({ score: [25, 20] }), 'The stats payload is malformed: game "game-1" set 1 has a score that disagrees with its point log.');
});
test('whitespace and line-wrapping are harmless', () => {
  const wrapped = ROSTER_VECTOR.encoded.replace(/(.{40})/g, '$1\n  ');
  assert.equal(decodeRoster(wrapped).ok, true);
});
test('contract constants', () => {
  assert.equal(CONTRACT_VERSION, 6);
  assert.equal(MAX_POINTS, 200);
  assert.equal(MAX_SETS, 5);
  assert.equal(MAX_ROSTER_PLAYERS, 16);
  assert.equal(MAX_DAY_PLAYERS, 32);
  assert.equal(MAX_GAMES_PER_DAY, 8);
  assert.equal(MAX_RECORDED_AT_LENGTH, 32);
});
test('masks reach the 32nd directory player without bitwise operators', () => {
  const last = maskOf([31]);
  assert.equal(last, 2147483648);
  assert.equal(maskHas(last, 31), true);
  assert.deepEqual(maskMembers(last, 32), [31]);
  const all = maskOf([...Array(32).keys()]);
  assert.equal(all, 4294967295);
  assert.equal(maskCount(all, 32), 32);
});
test('transport error catalogue', () => {
  assert.equal(decodeRoster('hello').error, 'This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.');
  assert.equal(decodeRoster(STATS_VECTOR.encoded).error, 'This is a stats payload, not a roster payload.');
  assert.equal(decodeStats(ROSTER_VECTOR.encoded).error, 'This is a roster payload, not a stats payload.');
  assert.equal(decodeRoster('CIQR7.abc.00000000').error, 'This payload was made by a newer version of the Rotation Planner (contract 7); this app understands 6.');
  assert.equal(decodeStats('CIQS7.abc.00000000').error, 'This payload was made by a newer version of the stats app (contract 7); this app understands 6.');
  const ROSTER_CORRUPT = 'This payload is corrupted or incomplete — copy it again from the Rotation Planner.';
  const STATS_CORRUPT = 'This payload is corrupted or incomplete — copy it again from the stats app.';
  assert.equal(decodeRoster(ROSTER_VECTOR.encoded.slice(0, -12)).error, ROSTER_CORRUPT);
  assert.equal(decodeRoster(ROSTER_VECTOR.encoded.replace('.95c9f4c5', '.95c9f4c6')).error, ROSTER_CORRUPT);
  assert.equal(decodeRoster(encodePayload('roster', { v: 1, kind: 'stats' }, 1)).error, ROSTER_CORRUPT);
  assert.equal(decodeStats(STATS_VECTOR.encoded.slice(0, -12)).error, STATS_CORRUPT);
});
test('kind-aware transport messages, verbatim', () => {
  assert.equal(decodeRoster('CIQR7.abc.00000000').error, 'This payload was made by a newer version of the Rotation Planner (contract 7); this app understands 6.');
  assert.equal(decodeStats('CIQS7.abc.00000000').error, 'This payload was made by a newer version of the stats app (contract 7); this app understands 6.');
  assert.equal(decodeRoster(ROSTER_VECTOR.encoded.slice(0, -12)).error, 'This payload is corrupted or incomplete — copy it again from the Rotation Planner.');
  assert.equal(decodeStats(STATS_VECTOR.encoded.slice(0, -12)).error, 'This payload is corrupted or incomplete — copy it again from the stats app.');
  // the not-a-CoachIQ-payload message names the stats app for BOTH kinds — it fires before the
  // kind is known at all, so there is nothing to key an author label off.
  assert.equal(decodeRoster('hello').error, 'This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.');
  assert.equal(decodeStats('hello').error, 'This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.');
});
test('roster shape errors use contract wording', () => {
  const p = (players) => encodePayload('roster', { v: 1, kind: 'roster', gameId: 'g', team: 't', opponent: 'o', date: 'd', players }, 1);
  assert.equal(decodeRoster(p([])).error, 'The roster payload is malformed: it names no players.');
  assert.equal(decodeRoster(p(Array.from({ length: 17 }, (_, i) => ({ id: `p${i}`, name: 'x' })))).error, 'The roster payload is malformed: it names 17 players; the limit is 16.');
  assert.equal(decodeRoster(p([{ id: 'a b', name: 'x' }])).error, 'The roster payload is malformed: player id "a b" is not legal.');
  assert.equal(decodeRoster(p([{ id: 'a', name: '' }])).error, 'The roster payload is malformed: player "a" has an empty name.');
});
test('stats validator rejects what the planner rejects', () => {
  const base = { v: 1, kind: 'stats', gameId: 'g', recordedAt: 'now', players: [{ id: 'a', name: 'A' }], sets: [] };
  assert.equal(validateStatsPayload(base).error, 'The stats payload is malformed: it records no sets.');
  const line = (id, n = 1) => ({ id, serve: { in: n, out: 0 }, return: { in: 0, out: 0 } });
  assert.equal(validateStatsPayload({ ...base, sets: [{ n: 2, score: null, players: [] }, { n: 1, score: null, players: [] }] }).error, 'The stats payload is malformed: set 1 appears twice or out of order.');
  assert.equal(validateStatsPayload({ ...base, sets: [{ n: 1, score: null, players: [line('zz')] }] }).error, 'The stats payload is malformed: player "zz" has stats but is not in the player list.');
  assert.equal(validateStatsPayload({ ...base, sets: [{ n: 1, score: null, players: [line('a', 1000)] }] }).error, 'The stats payload is malformed: player "a" has a malformed serve count in set 1.');
  assert.equal(validateStatsPayload({ ...base, sets: [{ n: 1, score: [25, 21], players: [line('a')] }] }).ok, true);
});

test('real planner roster payload decodes to a one-game day', () => {
  const text = 'CIQR2.eyJ2IjoyLCJraW5kIjoicm9zdGVyIiwiZGF0ZSI6IjIwMjYtMDktMTgiLCJ0ZWFtIjoiQmxpenphcmQiLCJwbGF5ZXJzIjpbeyJpZCI6ImFkZGlzb24iLCJuYW1lIjoiQWRkaXNvbiJ9LHsiaWQiOiJicm9va2x5biIsIm5hbWUiOiJCcm9va2x5biJ9LHsiaWQiOiJicnlubiIsIm5hbWUiOiJCcnlubiJ9LHsiaWQiOiJlbWlseSIsIm5hbWUiOiJFbWlseSJ9LHsiaWQiOiJncmFjZSIsIm5hbWUiOiJHcmFjZSJ9LHsiaWQiOiJoYWlsZXkiLCJuYW1lIjoiSGFpbGV5In0seyJpZCI6ImxleGkiLCJuYW1lIjoiTGV4aSJ9LHsiaWQiOiJsaWx5IiwibmFtZSI6IkxpbHkifSx7ImlkIjoibWVsYW5pZSIsIm5hbWUiOiJNZWxhbmllIn0seyJpZCI6InpvaWUiLCJuYW1lIjoiWm9pZSJ9XSwiZ2FtZXMiOlt7ImdhbWVJZCI6ImdhbWUtbXR5ZzZxdWItMS1tbGNxa3UiLCJvcHBvbmVudCI6IlByYWN0aWNlXzlfMTgiLCJyb3N0ZXIiOlswLDEsMiwzLDQsNSw2LDcsOCw5XX1dfQ.fa5639cd';
  const result = decodeDayRoster(text);
  assert.equal(result.ok, true);
  assert.equal(result.value.date, '2026-09-18');
  assert.equal(result.value.team, 'Blizzard');
  assert.equal(result.value.players.length, 10);
  assert.deepEqual(result.value.games[0].sets, [1023], 'ten players, indices 0-9, normalised to one set');
});

test('legacy path: decodeDayRoster/decodeDayStats normalise v1 vectors to the hand-written day shape', () => {
  assert.deepEqual(decodeDayRoster(ROSTER_VECTOR.encoded), { ok: true, value: ROSTER_V1_AS_V6 });
  assert.deepEqual(decodeDayStats(STATS_VECTOR.encoded), { ok: true, value: STATS_V1_AS_DAY });
});

test('v2 roster catalogue, reached through the legacy decode path', () => {
  const manyPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: 'x' }));
  const decodeV2 = (body) => decodeDayRoster(encodePayload('roster', { v: 2, kind: 'roster', date: 'd', team: 't', ...body }, 2));
  assert.equal(
    decodeV2({ players: manyPlayers(33), games: [{ gameId: 'g', opponent: 'o', roster: [] }] }).error,
    'The roster payload is malformed: it names 33 players; the day limit is 32.',
  );
  const manyGames = (n) => Array.from({ length: n }, (_, i) => ({ gameId: `g${i}`, opponent: 'o', roster: [] }));
  assert.equal(
    decodeV2({ players: manyPlayers(2), games: manyGames(9) }).error,
    'The roster payload is malformed: it names 9 games; the limit is 8.',
  );
  assert.equal(
    decodeV2({ players: manyPlayers(2), games: [{ gameId: 'g', opponent: 'o', roster: Array(17).fill(0) }] }).error,
    'The roster payload is malformed: game "g" names 17 players; the limit is 16.',
  );
  for (const bad of [-1, 1.5, '0']) {
    assert.equal(
      decodeV2({ players: manyPlayers(2), games: [{ gameId: 'g', opponent: 'o', roster: [bad] }] }).error,
      'The roster payload is malformed: game "g" has a malformed player reference.',
    );
  }
  assert.equal(
    decodeV2({ players: manyPlayers(2), games: [{ gameId: 'g', opponent: 'o', roster: [5] }] }).error,
    'The roster payload is malformed: game "g" names player 5, but the payload lists only 2.',
  );
  assert.equal(
    decodeV2({ players: manyPlayers(2), games: [{ gameId: 'g', opponent: 'o', roster: [0, 0] }] }).error,
    'The roster payload is malformed: game "g" names player 0 twice.',
  );
  // An empty v2 roster normalises to one set with a mask of 0 — a set that exists, nobody picked.
  const empty = decodeV2({ players: manyPlayers(2), games: [{ gameId: 'g', opponent: 'o', roster: [] }] });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.value.games[0].sets, [0]);
});

test('v2 stats catalogue', () => {
  const statsBase = (overrides = {}) => ({
    v: 2, kind: 'stats', recordedAt: 'r',
    players: [{ id: 'x', name: 'X' }],
    games: [{ gameId: 'g', sets: [{ n: 1, score: null, players: [] }] }],
    ...overrides,
  });
  const manyGames = (n) => Array.from({ length: n }, (_, i) => ({ gameId: `g${i}`, sets: [{ n: 1, score: null, players: [] }] }));
  assert.equal(
    validateDayStatsPayload(statsBase({ games: manyGames(9) })).error,
    'The stats payload is malformed: it records more than 8 games.',
  );
  const manySets = Array.from({ length: 6 }, (_, i) => ({ n: i + 1, score: null, players: [] }));
  assert.equal(
    validateDayStatsPayload(statsBase({ games: [{ gameId: 'g', sets: manySets }] })).error,
    'The stats payload is malformed: game "g" records more than 5 sets.',
  );
  // missing `score` key
  assert.equal(
    validateDayStatsPayload(statsBase({ games: [{ gameId: 'g', sets: [{ n: 1, players: [] }] }] })).error,
    'The stats payload is malformed: game "g" set 1 has a malformed score.',
  );
  // JSON.parse turns the numeral 1e999 into Infinity, which is not finite
  assert.equal(
    validateDayStatsPayload(statsBase({ games: [{ gameId: 'g', sets: [{ n: 1, score: [1e999, 2], players: [] }] }] })).error,
    'The stats payload is malformed: game "g" set 1 has a malformed score.',
  );
  assert.equal(
    validateDayStatsPayload(statsBase({ games: [{ gameId: 'g', sets: [{ n: 1, score: null, players: [{ id: 'zz', serve: { in: 0, out: 0 }, return: { in: 0, out: 0 } }] }] }] })).error,
    'The stats payload is malformed: player "zz" has stats in game "g" but is not in the player list.',
  );
  // a second game legitimately restarts at n: 1
  assert.equal(
    validateDayStatsPayload(statsBase({
      games: [
        { gameId: 'g1', sets: [{ n: 1, score: null, players: [] }] },
        { gameId: 'g2', sets: [{ n: 1, score: null, players: [] }] },
      ],
    })).ok,
    true,
  );
});

test('v1 tightenings', () => {
  const rosterBase = { v: 1, kind: 'roster', gameId: 'g', team: 't', opponent: 'o', players: [{ id: 'a', name: 'A' }] };
  assert.equal(validateRosterPayload({ ...rosterBase, date: '' }).error, 'The roster payload is malformed: it has no date.');

  const statsBase = { v: 1, kind: 'stats', gameId: 'g', players: [{ id: 'a', name: 'A' }], sets: [{ n: 1, score: null, players: [] }] };
  assert.equal(validateStatsPayload({ ...statsBase, recordedAt: '' }).error, 'The stats payload is malformed: it has no recorded time.');
  const longTime = 'x'.repeat(33);
  assert.equal(validateStatsPayload({ ...statsBase, recordedAt: longTime }).error, 'The stats payload is malformed: its recorded time is 33 characters; the limit is 32.');
  assert.equal(validateStatsPayload({ ...statsBase, recordedAt: 'now', players: [] }).error, 'The stats payload is malformed: it names no players.');

  const sixSets = Array.from({ length: 6 }, (_, i) => ({ n: i + 1, score: null, players: [] }));
  assert.equal(validateStatsPayload({ ...statsBase, recordedAt: 'now', sets: sixSets }).error, 'The stats payload is malformed: it records more than 5 sets.');
  const fiveSets = Array.from({ length: 5 }, (_, i) => ({ n: i + 1, score: null, players: [] }));
  assert.equal(validateStatsPayload({ ...statsBase, recordedAt: 'now', sets: fiveSets }).ok, true);
  assert.equal(
    validateStatsPayload({ ...statsBase, recordedAt: 'now', sets: [{ n: 6, score: null, players: [] }] }).error,
    'The stats payload is malformed: set number "6" is not between 1 and 5.',
  );
});

test('totality: every v1-accepted payload normalises into a v2-accepted one', () => {
  const rosterCandidates = [
    { v: 1, kind: 'roster', gameId: 'g', team: 't', opponent: 'o', date: 'd', players: [{ id: 'a', name: 'A' }] },
    { v: 1, kind: 'roster', gameId: 'g2', team: '', opponent: '', date: 'd2', players: Array.from({ length: 16 }, (_, i) => ({ id: `p${i}`, name: 'x' })) },
    ROSTER_VECTOR.payload,
  ];
  for (const candidate of rosterCandidates) {
    const v1 = validateRosterPayload(candidate);
    assert.equal(v1.ok, true, `expected v1 roster to validate: ${JSON.stringify(candidate)}`);
    const day = normaliseRosterV1(v1.value);
    assert.equal(validateDayRosterPayload(day).ok, true, `expected normalised roster to validate: ${JSON.stringify(day)}`);
  }

  const statsCandidates = [
    { v: 1, kind: 'stats', gameId: 'g', recordedAt: 'now', players: [{ id: 'a', name: 'A' }], sets: [{ n: 1, score: null, players: [] }] },
    STATS_VECTOR.payload,
  ];
  for (const candidate of statsCandidates) {
    const v1 = validateStatsPayload(candidate);
    assert.equal(v1.ok, true, `expected v1 stats to validate: ${JSON.stringify(candidate)}`);
    const day = normaliseStatsV1(v1.value);
    assert.equal(validateDayStatsPayload(day).ok, true, `expected normalised stats to validate: ${JSON.stringify(day)}`);
  }
});
