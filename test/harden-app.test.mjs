// harden-app.test.mjs — does obfuscation change what the REAL app computes?
//
// Why this exists, given test/harden.test.mjs already runs hardened code:
// those tests harden synthetic snippets written to resemble the app. A snippet that
// survives `transformObjectKeys` proves nothing about `src/session.js`, which the
// obfuscator sees as one much larger program and transforms as a whole. The hazardous
// constructs in this codebase are real and specific:
//
//   * applyDelta (src/session.js) builds a nested spread-with-computed-keys literal,
//     `{ ...set.counts, [playerId]: { ...cur, [stat]: { ...cur[stat], [side]: after } } }`
//     -- three levels of spread, two computed keys, all of it in `transformObjectKeys`'
//     line of fire. Nothing else in the suite reaches it.
//   * the codec checksums every payload it emits, so any key-order change, any numeric
//     drift from `numbersToExpressions`, any string mangled by the string array shows up
//     as a different eight-hex-digit FNV-1a tail rather than as a silent near-miss.
//
// The method: concatenate the app's real sources exactly as the bundler does, append a
// driver that walks the whole data path, and run that program twice -- once hardened,
// once not. The unhardened run is the baseline; hardening is only correct if the two
// transcripts are character-for-character identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hardenJs } from '../scripts/harden.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ui.js is excluded: it needs a DOM. These three are the whole pure data path.
const ORDER = ['codec.js', 'vectors.js', 'session.js'];

/**
 * Concatenate src/ the way scripts/build.mjs does.
 *
 * build.mjs does not export this step (it only exports `build(outDir)`, which writes
 * files), so the two `.replace` calls below are copied from it verbatim -- same
 * patterns, same flags, same order. If build.mjs's inlining ever changes, this must be
 * re-copied, or this test stops testing the bundle that actually ships.
 */
function concatSources() {
  const src = (f) => readFileSync(join(ROOT, 'src', f), 'utf8');
  return ORDER.map((f) => `// ---- ${f} ----\n` + src(f)
    .replace(/^export (?=(const|let|function|async function|class)\b)/gm, '')
    .replace(/^import\s[^\n]*?from\s+['"][^'"]+['"];?[ \t]*$\n?/gm, '')).join('\n');
}

/**
 * The driver, appended INSIDE the bundle so it calls the app's functions by their real
 * names -- after obfuscation those names no longer exist from the outside.
 *
 * Everything it records is stringified in-realm, so the transcript that crosses the vm
 * boundary is one plain string: no cross-realm prototype comparisons, and JSON key order
 * is part of what gets compared rather than something the assertion smooths over.
 */
const DRIVER = `
out.transcript = (function () {
  const log = [];
  const rec = (label, value) => log.push(label + ' => ' + JSON.stringify(value));
  const NOW = '2026-09-13T10:00:00.000Z';
  const GAME = 'harden-app-1';

  // 1. runSelfCheck — the codec's own golden-vector check, encode AND decode.
  rec('runSelfCheck', runSelfCheck());

  // 2. decodeRoster — names carry the characters most likely to be disturbed by the
  //    string array (markup, quotes, ampersand, non-ASCII).
  const rosterText = encodeRoster({
    v: 1, kind: 'roster', gameId: GAME, team: 'Home & Co <b>', opponent: 'Away "FC"',
    date: '2026-09-19',
    players: [
      { id: 'p1', name: 'Ada <&> "Q"', jersey: 7 },
      { id: 'p2', name: "Zo\\u00eb O'Brien" },
    ],
  });
  rec('encodeRoster', rosterText);
  const roster = decodeRoster(rosterText);
  rec('decodeRoster', roster);

  // 3. openRoster
  const opened = openRoster(newSession(), roster.value, NOW);
  rec('openRoster.kind', opened.kind);
  let s = opened.session;
  rec('openRoster.session', s);

  // 4. tap, twice — this is the applyDelta nested-spread hazard.
  //    Tap one creates set 1 from nothing, so it exercises the outer
  //    \`{ ...set.counts, [playerId]: ... }\` on an empty object.
  s = tap(s, GAME, 1, 'p1', 'serve', 'in', 1);
  rec('tap1.count', getCount(s.games[0], 1, 'p1'));
  //    Tap two writes a DIFFERENT side of the SAME stat, so the innermost
  //    \`{ ...cur[stat], [side]: after }\` must carry serve.in=1 forward. If
  //    transformObjectKeys broke that spread, serve.in would silently reset to 0.
  s = tap(s, GAME, 1, 'p1', 'serve', 'out', 2);
  rec('tap2.count', getCount(s.games[0], 1, 'p1'));
  rec('tap2.history', s.games[0].history);

  // 5. setScore
  s = setScore(s, GAME, 1, [25, 21]);
  rec('setScore', s.games[0].sets[0].score);

  // 6/7. serialiseSession -> parseSession round trip. \`savedAt\` is wall-clock, so it
  //      is masked in the transcript only; parseSession still gets the real text.
  const saved = serialiseSession(s);
  rec('serialiseSession', saved.replace(/"savedAt":"[^"]*"/, '"savedAt":"<masked>"'));
  const reloaded = parseSession(saved);
  rec('parseSession', reloaded);
  //      The reloaded session must be usable, not merely parseable.
  s = reloaded.value;

  // 8/9. buildStatsPayload -> encodeStats. The encoded string ends in an FNV-1a
  //      checksum over the exact JSON bytes, so this one line catches key reordering
  //      and numeric drift at once.
  const stats = buildStatsPayload(s.games[0], NOW);
  rec('buildStatsPayload', stats);
  const encoded = encodeStats(stats.value.payload);
  rec('encodeStats', encoded);
  rec('encodeStats.matchesBuilt', encoded === stats.value.text);

  // 10. decodeStats — back through validation to a structurally rebuilt object.
  rec('decodeStats', decodeStats(encoded));

  // Saturation at both ends of the 0..999 clamp, to pin numbersToExpressions at the
  // boundaries rather than on mid-range values it is easy to get right by accident.
  s = tap(s, GAME, 1, 'p2', 'return', 'in', 999);
  rec('clamp.atMax', getCount(s.games[0], 1, 'p2'));
  const before = s;
  s = tap(s, GAME, 1, 'p2', 'return', 'in', 5);           // already 999: a true no-op
  rec('clamp.overMaxIsNoop', s === before);
  rec('clamp.stillMax', getCount(s.games[0], 1, 'p2'));
  s = tap(s, GAME, 1, 'p2', 'return', 'in', -2000);       // clamps at 0, records -999
  rec('clamp.atMin', getCount(s.games[0], 1, 'p2'));
  //    p1's counts must be untouched by every p2 tap above: that is the OUTER
  //    \`{ ...set.counts, [playerId]: ... }\` spread doing its job.
  rec('clamp.p1Untouched', getCount(s.games[0], 1, 'p1'));
  rec('clamp.history', s.games[0].history);

  // 11. undo — replays applyDelta with the negated, post-clamp delta.
  const undone = undo(s, GAME);
  rec('undo.entry', undone.undone);
  rec('undo.count', getCount(undone.session.games[0], 1, 'p2'));
  rec('undo.history', undone.session.games[0].history);

  return log.join('\\n');
})();
`;

/** Run one program in a throwaway context carrying the browser globals codec.js needs. */
function run(code) {
  const context = vm.createContext({
    out: {},
    btoa, atob, TextEncoder, TextDecoder,
  });
  vm.runInContext(code, context);
  return context.out.transcript;
}

const bundle = `(function () {\n'use strict';\n${concatSources()}\n${DRIVER}\n})();`;

test('the real codec/session data path survives hardening unchanged', async () => {
  const baseline = run(bundle);
  const hardened = run(await hardenJs(bundle));

  // Sanity: the driver actually ran the whole sequence, so an empty-transcript bug
  // cannot pass as "identical".
  assert.ok(typeof baseline === 'string' && baseline.length > 0, 'baseline transcript produced');
  for (const step of ['runSelfCheck', 'decodeRoster', 'openRoster.session', 'tap2.count',
    'setScore', 'parseSession', 'buildStatsPayload', 'encodeStats', 'decodeStats',
    'clamp.atMax', 'clamp.atMin', 'undo.entry']) {
    assert.ok(baseline.includes(step + ' =>'), `baseline reached ${step}`);
  }

  // The baseline must be a HEALTHY run, not an identically-broken one: parity with a
  // failing baseline would otherwise pass. These are the load-bearing outcomes.
  assert.ok(baseline.includes('runSelfCheck => {"ok":true}'), 'codec self-check passed');
  assert.ok(baseline.includes('decodeRoster => {"ok":true'), 'roster decoded');
  assert.ok(baseline.includes('openRoster.kind => "opened"'), 'roster opened');
  // tap two must have preserved serve.in from tap one through the nested spread.
  assert.ok(
    baseline.includes('tap2.count => {"serve":{"in":1,"out":2},"return":{"in":0,"out":0}}'),
    'applyDelta nested spread preserved the sibling side'
  );
  assert.ok(baseline.includes('clamp.atMax => {"serve":{"in":0,"out":0},"return":{"in":999,"out":0}}'), 'clamped at 999');
  assert.ok(baseline.includes('clamp.overMaxIsNoop => true'), 'a fully-clamped tap is a no-op');
  assert.ok(baseline.includes('clamp.atMin => {"serve":{"in":0,"out":0},"return":{"in":0,"out":0}}'), 'clamped at 0');
  assert.ok(
    baseline.includes('clamp.p1Untouched => {"serve":{"in":1,"out":2},"return":{"in":0,"out":0}}'),
    'the outer counts spread left the other player alone'
  );
  assert.ok(baseline.includes('encodeStats.matchesBuilt => true'), 'encodeStats agrees with buildStatsPayload');
  assert.ok(baseline.includes('decodeStats => {"ok":true'), 'stats payload decoded back');
  assert.ok(baseline.includes('undo.entry => {"n":1,"playerId":"p2","stat":"return","side":"in","delta":-999}'), 'undo popped the clamped delta');

  // The whole point. Any divergence -- a key renamed, a number rewritten wrong, a
  // string mangled -- lands here, and the checksum inside the encoded payloads means
  // even a one-byte drift in the JSON shows up.
  assert.equal(hardened, baseline, 'hardened build computes exactly what the plain build computes');
});

test('the hardened bundle really was obfuscated (the comparison above is not vacuous)', async () => {
  // If hardenJs ever silently became a pass-through, the parity assertion would still
  // pass while proving nothing. Pin that it did not.
  const code = await hardenJs(bundle);
  for (const name of ['buildStatsPayload', 'runSelfCheck', 'decodeRoster', 'parseSession', 'applyDelta', 'clampCount']) {
    assert.ok(!code.includes(name), `identifier "${name}" was mangled away`);
  }
  assert.ok(!code.includes('CIQR'), 'even the payload prefixes moved into the string array');
});
