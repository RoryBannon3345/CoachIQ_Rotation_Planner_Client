import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fnv1a32, encodePayload, decodePayload, decodeRoster, decodeStats, encodeStats, validateStatsPayload } from '../src/codec.js';
import { ROSTER_VECTOR, STATS_VECTOR } from '../src/vectors.js';

test('fnv1a32 reference values', () => {
  assert.equal(fnv1a32(new Uint8Array()), '811c9dc5');
  assert.equal(fnv1a32(new TextEncoder().encode('a')), 'e40c292c');
});
test('golden roster vector round-trips byte-exact', () => {
  assert.equal(encodePayload('roster', ROSTER_VECTOR.payload), ROSTER_VECTOR.encoded);
  assert.deepEqual(decodeRoster(ROSTER_VECTOR.encoded), { ok: true, value: ROSTER_VECTOR.payload });
});
test('golden stats vector round-trips byte-exact', () => {
  assert.equal(encodeStats(STATS_VECTOR.payload), STATS_VECTOR.encoded);
  assert.deepEqual(decodeStats(STATS_VECTOR.encoded), { ok: true, value: STATS_VECTOR.payload });
});
test('whitespace and line-wrapping are harmless', () => {
  const wrapped = ROSTER_VECTOR.encoded.replace(/(.{40})/g, '$1\n  ');
  assert.equal(decodeRoster(wrapped).ok, true);
});
test('transport error catalogue', () => {
  assert.equal(decodeRoster('hello').error, 'This is not a CoachIQ payload — copy the whole text from the stats app and paste it again.');
  assert.equal(decodeRoster(STATS_VECTOR.encoded).error, 'This is a stats payload, not a roster payload.');
  assert.equal(decodeStats(ROSTER_VECTOR.encoded).error, 'This is a roster payload, not a stats payload.');
  assert.equal(decodeRoster('CIQR2.abc.00000000').error, 'This payload was made by a newer version of the stats app (contract 2); this app understands 1.');
  const CORRUPT = 'This payload is corrupted or incomplete — copy it again from the stats app.';
  assert.equal(decodeRoster(ROSTER_VECTOR.encoded.slice(0, -12)).error, CORRUPT);
  assert.equal(decodeRoster(ROSTER_VECTOR.encoded.replace('.95c9f4c5', '.95c9f4c6')).error, CORRUPT);
  assert.equal(decodeRoster(encodePayload('roster', { v: 1, kind: 'stats' })).error, CORRUPT);
});
test('roster shape errors use contract wording', () => {
  const p = (players) => encodePayload('roster', { v: 1, kind: 'roster', gameId: 'g', team: 't', opponent: 'o', date: 'd', players });
  assert.equal(decodeRoster(p([])).error, 'The roster payload is malformed: it names no players.');
  assert.equal(decodeRoster(p(Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, name: 'x' })))).error, 'The roster payload is malformed: it names 13 players; the limit is 12.');
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
