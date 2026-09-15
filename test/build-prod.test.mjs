import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProd } from '../scripts/build-prod.mjs';
import { APP_HTML } from '../scripts/build.mjs';

const out = mkdtempSync(join(tmpdir(), 'ciq-prod-'));
const result = await buildProd(out);
const html = readFileSync(join(out, APP_HTML), 'utf8');

test('emits a self-contained app html plus sw.js and nothing else', () => {
  assert.ok(existsSync(join(out, APP_HTML)));
  assert.ok(existsSync(join(out, 'sw.js')));
  assert.deepEqual(readdirSync(out).sort(), [APP_HTML, 'sw.js'].sort());
});

test('emits no source maps', () => {
  assert.equal(readdirSync(out).filter((f) => f.endsWith('.map')).length, 0);
  assert.ok(!/sourceMappingURL/.test(html), 'no sourceMappingURL in html');
  assert.ok(!/sourceMappingURL/.test(readFileSync(join(out, 'sw.js'), 'utf8')));
});

test('leaks no readable identifiers from the sources', () => {
  // Names that exist in src/ and must not survive into the shipped bundle.
  for (const name of ['buildDayStatsPayload', 'runSelfCheck', 'decodeDayRoster', 'parseSession', 'minusMode']) {
    assert.ok(!html.includes(name), `identifier "${name}" leaked into production html`);
  }
});

test('strips comments and dev-only code', () => {
  assert.ok(!html.includes('build note'), 'source comments stripped');
  assert.ok(!html.includes('dev-only guard'), 'dev-only comment stripped');
  assert.ok(!/console\.assert/.test(html), 'console.assert dropped');
});

test('stays self-contained: no external urls, scripts, or links', () => {
  assert.ok(!/https?:\/\//.test(html), 'no external URLs');
  assert.ok(!/<(script|link)[^>]+(src|href)=/.test(html), 'no external script/link');
});

test('exposes no secret-shaped literals', () => {
  assert.ok(!/api[_-]?key|secret|passwd|password|credential|bearer /i.test(html));
});

test('keeps the markup contract the app boots against', () => {
  assert.ok(/id="app"/.test(html), '#app mount point present');
  assert.ok(/<title>CoachIQ Stats<\/title>/.test(html), 'title preserved');
});

test('reports plausible sizes', () => {
  assert.ok(result.hardenedBytes > 10_000, 'output is not truncated');
  assert.ok(result.hardenedBytes < 600_000, 'output is not pathologically bloated');
  assert.equal(result.hardenedBytes, Buffer.byteLength(html));
});

test('leaves an unrelated pre-existing file in outDir alone', async () => {
  // buildProd owns exactly the app html and sw.js. A stray file some other process
  // left in outDir is not this build's to delete -- assert that intent explicitly,
  // in both directions: the decoy survives untouched, and the two owned files are
  // still written correctly alongside it.
  const decoyOut = mkdtempSync(join(tmpdir(), 'ciq-prod-decoy-'));
  const decoyPath = join(decoyOut, 'leftover.txt');
  writeFileSync(decoyPath, 'do not touch me');

  await buildProd(decoyOut);

  assert.equal(readFileSync(decoyPath, 'utf8'), 'do not touch me', 'decoy file survives untouched');
  assert.ok(existsSync(join(decoyOut, APP_HTML)), `${APP_HTML} still written`);
  assert.ok(existsSync(join(decoyOut, 'sw.js')), 'sw.js still written');
  assert.deepEqual(
    readdirSync(decoyOut).sort(),
    [APP_HTML, 'leftover.txt', 'sw.js'].sort(),
    'decoy is neither deleted nor duplicated, and both owned files are present'
  );
});
