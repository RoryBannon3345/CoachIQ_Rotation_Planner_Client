import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, APP_HTML } from '../scripts/build.mjs';

test('build produces one self-contained html plus sw.js', () => {
  const out = mkdtempSync(join(tmpdir(), 'ciq-'));
  build(out);
  const html = readFileSync(join(out, APP_HTML), 'utf8');
  assert.ok(existsSync(join(out, 'sw.js')));
  assert.ok(!/<!--(STYLES|SCRIPT)-->/.test(html), 'markers replaced');
  assert.ok(!/^\s*export /m.test(html), 'no export keywords left');
  assert.ok(!/^\s*import\s/m.test(html), 'no import statements left');
  assert.ok(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no external URLs');
  assert.ok(!/<(script|link)[^>]+(src|href)=/.test(html), 'no external script/link');
  assert.ok(html.length < 300_000);
});

test('sw.js precaches the emitted html by its real name', () => {
  const out = mkdtempSync(join(tmpdir(), 'ciq-sw-'));
  build(out);
  const sw = readFileSync(join(out, 'sw.js'), 'utf8');
  assert.ok(!sw.includes('__APP_HTML__'), 'placeholder substituted');
  assert.ok(sw.includes(`./${APP_HTML}`), 'service worker names the emitted html');
  // The worker precaches with addAll, which is all-or-nothing: a name it cannot
  // fetch fails the install and silently costs the app its offline support.
  assert.ok(!/index\.html/.test(sw), 'no stale index.html reference left behind');
});
