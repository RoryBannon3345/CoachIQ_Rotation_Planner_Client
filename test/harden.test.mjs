import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { harden, hardenJs, escapeForInlineScript } from '../scripts/harden.mjs';

/** Run hardened JS in a throwaway context and hand back whatever it exported on `out`. */
async function runHardened(source) {
  const code = await hardenJs(source);
  const context = vm.createContext({ out: {} });
  vm.runInContext(code, context);
  return context.out;
}

test('hardened code still escapes HTML — the esc() pattern from ui.js:27', async () => {
  // The exact high-risk construct: an object literal indexed by a dynamic key,
  // which `transformObjectKeys` rewrites. This is the app's only XSS guard.
  const out = await runHardened(`
    (function () {
      'use strict';
      function esc(value) {
        return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      }
      out.esc = esc;
    })();
  `);
  assert.equal(out.esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(out.esc(`A & B "C" 'D'`), 'A &amp; B &quot;C&quot; &#39;D&#39;');
  assert.equal(out.esc('plain'), 'plain');
});

test('hardened code preserves object round-trips through JSON', async () => {
  // Guards `transformObjectKeys` against renaming the persisted session shape.
  const out = await runHardened(`
    (function () {
      'use strict';
      const player = { id: 'p1', name: 'Ada', jersey: 7 };
      out.json = JSON.stringify({ players: [player], activeGameId: 'g1' });
    })();
  `);
  assert.equal(out.json, '{"players":[{"id":"p1","name":"Ada","jersey":7}],"activeGameId":"g1"}');
});

test('hardened code preserves arithmetic and control flow', async () => {
  // `numbersToExpressions` rewrites every numeric literal; prove the values hold.
  const out = await runHardened(`
    (function () {
      'use strict';
      function clamp(n) { return n < 0 ? 0 : n > 999 ? 999 : n; }
      const totals = [];
      for (let i = 0; i < 5; i += 1) totals.push(clamp(i * 250 - 100));
      out.totals = totals;
      out.clamped = [clamp(-5), clamp(1000), clamp(42)];
    })();
  `);
  // `out.totals`/`out.clamped` are arrays constructed inside the vm context, so they
  // carry that realm's `Array.prototype`, not this one's. `node:assert/strict`'s
  // deepEqual is realm-sensitive for object identity and fails on that prototype
  // mismatch alone, even when every element matches -- unrelated to hardening.
  // `Array.from` copies the values into a same-realm array so the comparison tests
  // what it's meant to: the numbers survived `numbersToExpressions` intact.
  assert.deepEqual(Array.from(out.totals), [0, 150, 400, 650, 900]);
  assert.deepEqual(Array.from(out.clamped), [0, 999, 42]);
});

test('dev-only console and debugger statements are dropped', async () => {
  const code = await hardenJs(`
    (function () {
      'use strict';
      console.assert(1 === 2, 'dev-only guard');
      console.log('chatter');
      debugger;
      out.kept = 'yes';
    })();
  `);
  assert.ok(!/console/.test(code), 'no console calls survive');
  assert.ok(!/debugger/.test(code), 'no debugger statements survive');
});

test('identifiers and comments are gone', async () => {
  const code = await hardenJs(`
    (function () {
      'use strict';
      // a revealing comment about rotation scoring
      function calculateRotationScore(playerRoster) { return playerRoster.length; }
      out.n = calculateRotationScore([1, 2, 3]);
    })();
  `);
  assert.ok(!/calculateRotationScore/.test(code), 'function name mangled');
  assert.ok(!/playerRoster/.test(code), 'parameter name mangled');
  assert.ok(!/revealing comment/.test(code), 'comments stripped');
  assert.ok(!/sourceMappingURL/.test(code), 'no source map reference');
});

test('escapeForInlineScript neutralises markup-terminating sequences', () => {
  assert.equal(escapeForInlineScript(`a='</script>'`), `a='\\x3C/script>'`);
  assert.equal(escapeForInlineScript(`a='</SCRIPT'`), `a='\\x3C/SCRIPT'`);
  assert.equal(escapeForInlineScript(`a='<!--'`), `a='\\x3C!--'`);
  // \x3C is byte-identical to '<' inside a string literal, so values are unchanged.
  assert.equal(eval(escapeForInlineScript(`'</script>'`)), '</script>');
});

test('harden() rewrites inline scripts, minifies CSS, and drops comments', async () => {
  const html = [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<!-- a build comment -->',
    '<style>  .rows  {  color :  #ff0000 ;  }  </style>',
    '</head><body><div id="app"></div>',
    `<script>(function () { 'use strict'; function revealingName() { return 1; } window.x = revealingName(); })();</script>`,
    '</body></html>',
  ].join('\n');

  const result = await harden(html);

  assert.ok(!/a build comment/.test(result), 'HTML comments removed');
  assert.ok(!/revealingName/.test(result), 'inline script obfuscated');
  assert.ok(/<div id="app">/.test(result), 'markup structure preserved');
  assert.ok(/red|#f00/.test(result), 'CSS minified');
  assert.ok(!/sourceMappingURL/.test(result), 'no source map reference');
  assert.ok(result.length < html.length * 60, 'output is not pathologically bloated');
});

test('harden() leaves an empty script element alone', async () => {
  const result = await harden('<html><body><script></script></body></html>');
  assert.ok(/<script><\/script>/.test(result));
});
