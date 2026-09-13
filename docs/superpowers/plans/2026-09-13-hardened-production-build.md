# Hardened Production Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate production build that emits a minified, obfuscated, source-map-free `dist/index.html` which behaves identically to the readable dev bundle.

**Architecture:** `scripts/build.mjs` (the existing plain bundler) is left **untouched** and keeps producing the readable single-file bundle. A new pure transform, `scripts/harden.mjs`, takes that HTML string and returns a hardened HTML string (terser-minify → javascript-obfuscator → HTML/CSS minify). `scripts/build-prod.mjs` wires the two together: it bundles into a staging temp dir, hardens, and writes the result to `dist/`. Verification is two-layered — fast `node:vm` unit tests that execute hardened code, plus a headless-Edge functional check that drives the real app and diffs a DOM fingerprint of the plain build against the hardened build.

**Tech Stack:** Node 24 ESM, `terser`, `javascript-obfuscator`, `html-minifier-terser`, `puppeteer-core` (driving the already-installed Microsoft Edge), `node:test`.

**Spec:** The user request in this session, reproduced verbatim in "Requirements Traceability" below. Reference implementation: `C:\_src\CoachIQ_Rotation_Planner\vite.config.prod.ts`.

## Global Constraints

- **Never modify `src/`.** The development sources stay readable by design. All hardening happens downstream of `build()`.
- **Never modify `scripts/build.mjs`.** `test/build.test.mjs` pins its behaviour; the plain bundle must stay byte-identical.
- **No source maps.** Nothing in this pipeline may emit a `.map` file or a `sourceMappingURL` comment. Terser is called without `sourceMap`, which defaults to off; assert this in a test rather than trusting it.
- **Single self-contained output.** `dist/index.html` must reference no external script/link/URL. `dist/sw.js` is the only sibling file.
- **`controlFlowFlattening` and `deadCodeInjection` stay `false`.** See Task 1 for the reasoning; do not "strengthen" the build by turning them on.
- **`renameGlobals: false`.** The bundle assigns nothing to globals but relies on browser globals; renaming them breaks the app.
- **Preserve behaviour exactly.** Obfuscation rewrites identifiers and string storage only. Any DOM-fingerprint difference between the plain and hardened builds is a regression, not an acceptable variation.
- **Node version floor:** Node 24 (`node --test` with ESM, `import` of JSON not required).

## Requirements Traceability

| # | Requirement | Where it is satisfied |
|---|---|---|
| 1 | Minify HTML, CSS, JS | Task 1 (`harden`: terser for JS, html-minifier-terser with `minifyCSS` for HTML+CSS) |
| 2 | Bundle JS into optimized production assets | Task 2 (existing `build()` concatenates modules; terser `passes: 2` optimizes) |
| 3 | Obfuscate variable/function/class names | Task 1 (`identifierNamesGenerator: 'mangled'`, terser `mangle`) |
| 4 | Remove comments, source maps, debug info, dev-only code | Task 1 (`format.comments: false`, `drop_console`, `drop_debugger`, no `sourceMap`); Task 2 asserts no `.map` emitted |
| 5 | No API keys / secrets / credentials / private business logic exposed | Task 3 (automated secret scan). **Pre-verified: the app makes zero network calls and holds zero secrets** — see "Security Posture" below |
| 6 | Move security-sensitive/proprietary logic server-side | **N/A, documented in Task 4.** There is no server and no secret-bearing logic; see "Security Posture" |
| 7 | Disable `.map` generation in production | Task 2 (test asserts `dist/` contains no `*.map` and output has no `sourceMappingURL`) |
| 8 | Hash generated asset filenames where appropriate | **N/A, documented in Task 4.** Everything inlines into one HTML entry point; see "Asset Hashing" |
| 9 | Preserve all application functionality | Task 1 (vm-eval tests), Task 3 (headless functional + fingerprint diff) |
| 10 | Separate production build, dev sources untouched | Global Constraints; Task 2 (`scripts/build-prod.mjs` is additive) |
| 11 | Verify the app works after obfuscation | Task 3 |

### Security Posture (findings from source audit, carry into Task 4's README text)

Audited `src/*.js` before planning:

- **No external endpoint.** No API calls, no analytics, no third-party requests, and no
  external URL in any source file. The one `fetch` in the codebase is `src/sw.js:6`, the
  service worker's cache-passthrough handler, which only re-requests the app's own
  same-origin assets so it works offline. `test/build.test.mjs` asserts the built HTML
  contains no literal `https?://` and no external `<script>`/`<link>` — note that it does
  not check for `fetch` itself.
  (Corrected during execution: the original audit grep excluded `src/sw.js` and this bullet
  wrongly claimed there was no `fetch` anywhere in `src/`.)
- **Zero secrets.** No API key, token, password, or credential literal. The only persistence is `localStorage` under `STORAGE_KEY` / `UNREADABLE_KEY`, holding the coach's own session data on their own device.
- **No server exists.** The app is a local-first, offline-capable PWA. Requirements 5 and 6 are therefore satisfied vacuously — there is nothing to move server-side. Obfuscation here raises the cost of reading the rotation/stats logic; it is **not** a confidentiality boundary, and Task 4 must say so in the README rather than imply the code is now "secure".

### Asset Hashing (carry into Task 4's README text)

`build()` inlines CSS and JS into `index.html`, so no hashable sub-assets are produced. The two emitted files are:

- `index.html` — the entry point. Cannot be hashed; `sw.js` fetches it by name and it is the URL users bookmark.
- `sw.js` — must keep its exact name to stay registrable at the same scope (`ui.js:761` registers `'./sw.js'`).

Cache-busting is handled instead by the service worker's `CACHE` constant (`src/sw.js:1`). Requirement 8 is satisfied by documenting this, not by inventing hashed filenames that would break registration.

### Known obfuscation hazards found in audit (each gets a dedicated test)

1. **`esc()` at `src/ui.js:27`** — `String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', ... }[c]))`. This is an object literal immediately indexed by a **dynamic** key, and it is the app's only XSS guard for user-entered player names. `transformObjectKeys: true` rewrites object-literal keys, so this is the highest-risk construct in the codebase. Task 1 Step 1 tests it by executing hardened code.
2. **`console.assert` at `src/ui.js:600`** — explicitly commented "a dev-only guard, never shown to the coach". `drop_console: true` removes it; this is requirement 4 working as intended, not a regression. Its only consumer is the local `decoded` binding, which is a pure decode with no side effects.
3. **`</script` / `<!--` inside string literals** — `splitStrings` can rejoin literals into these byte sequences, which would close the inline `<script>` element early and break the page non-deterministically. Task 1 handles this with `\x3C` escaping (the same fix Vite/webpack apply).

---

### Task 1: The hardening transform (`scripts/harden.mjs`)

The pure, filesystem-free core: HTML string in, hardened HTML string out. Isolating it this way is what makes the risky constructs testable without a browser or a build.

**Files:**
- Create: `scripts/harden.mjs`
- Create: `test/harden.test.mjs`
- Modify: `package.json` (add devDependencies only)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, for Task 2 and Task 3:
  - `OBFUSCATOR_OPTIONS: object` — the frozen javascript-obfuscator settings.
  - `escapeForInlineScript(js: string): string`
  - `hardenJs(code: string): Promise<string>` — minify + obfuscate + escape one JS source string.
  - `harden(html: string): Promise<string>` — rewrite every inline `<script>` in `html` through `hardenJs`, then minify the document. Returns the hardened HTML.

- [ ] **Step 1: Install the toolchain**

These are the only three runtime-relevant additions; `puppeteer-core` arrives in Task 3.

```bash
npm install --save-dev terser@^5.51.2 javascript-obfuscator@^5.7.0 html-minifier-terser@^7.2.0
```

Expected: `package.json` grows a `devDependencies` block, `package-lock.json` is created, `node_modules/` appears (already covered by `.gitignore`).

- [ ] **Step 2: Write the failing tests**

Create `test/harden.test.mjs`. These execute hardened output rather than pattern-matching it — the only way to prove behaviour survived.

```js
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
  assert.deepEqual(out.totals, [0, 150, 400, 650, 900]);
  assert.deepEqual(out.clamped, [0, 999, 42]);
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
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../scripts/harden.mjs'`.

- [ ] **Step 4: Write `scripts/harden.mjs`**

```js
// harden.mjs — turns the readable single-file bundle from build.mjs into the shipped,
// hardened one. Pure string-in/string-out so it can be unit-tested without a build or a
// browser; scripts/build-prod.mjs owns all filesystem work.
//
// Pipeline, in order:
//   1. terser  — minify, mangle identifiers, drop `console.*`/`debugger`, strip comments.
//   2. javascript-obfuscator — rename what is left and move string literals into an
//      encoded, rotated, shuffled array behind accessor functions.
//   3. escapeForInlineScript — neutralise byte sequences that would end the <script> early.
//   4. html-minifier-terser — collapse the document and its CSS.
//
// No step here emits a source map, and none may be made to.
import { minify as minifyJs } from 'terser';
import { minify as minifyHtml } from 'html-minifier-terser';
import JavaScriptObfuscator from 'javascript-obfuscator';

/**
 * javascript-obfuscator settings: strong enough to defeat casual reading, conservative
 * enough to preserve behaviour on a hand-written vanilla bundle.
 */
export const OBFUSCATOR_OPTIONS = Object.freeze({
  compact: true,
  // OFF, and it must stay off. Control-flow flattening demotes block-scoped
  // `const`/`let` to function-scoped `var`, which breaks legal shadowing that
  // terser's short-name reuse depends on. It is applied to a randomly chosen
  // subset of blocks, so enabling it makes every release a coin flip between a
  // working and a broken build. It is also the heaviest transform for the least
  // secrecy -- the string array below is what actually costs a reader their day.
  controlFlowFlattening: false,
  // Bloats output several-fold for little added secrecy over the string array.
  deadCodeInjection: false,
  // 'mangled' (`qK`) rather than 'hexadecimal' (`_0x3f2a1b`): equally meaningless
  // to a reader, but hexadecimal replaces terser's 1-2 char identifiers with ~9
  // chars each, inflating the bundle for no gain.
  identifierNamesGenerator: 'mangled',
  log: false,
  // Rewrites numeric literals into expressions -- hides scores, caps, thresholds.
  numbersToExpressions: true,
  // The bundle relies on browser globals (document, localStorage, navigator).
  // Renaming them breaks the app.
  renameGlobals: false,
  // selfDefending inserts fragile anti-formatting guards that can wedge after the
  // HTML minification below; off for reliability.
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  // The high-value transform: literal strings (class names, labels, messages)
  // become entries in an encoded, rotated, shuffled array behind accessors.
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: 'variable',
  // 1, not the usual 0.9: a threshold below 1 leaves a random ~10% of string
  // literals in plaintext, which both weakens the result and makes "no readable
  // identifier survives" a flaky assertion. Encoding every string costs a
  // negligible amount on a bundle this size and makes the output deterministic.
  stringArrayThreshold: 1,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
});

/**
 * Neutralize the byte sequences that would prematurely close (or reopen) the inline
 * `<script>` element when the surrounding HTML is parsed.
 *
 * `splitStrings` re-chunks string literals and can rejoin one into the verbatim
 * characters `</script`. Those sit inside a JS string, but an HTML parser cannot know
 * that: it reads raw script text only up to the first `</script`, ends the element
 * early, then chokes on the remaining JavaScript as markup. Because the splitting is
 * randomized, this would strike only some builds -- a non-deterministic failure.
 *
 * The fix is the one Vite/webpack/esbuild apply when inlining any script. These
 * sequences can appear in valid JavaScript only inside string or regex literals, and
 * there `\x3C` is byte-identical to `<` -- so runtime behaviour never changes; the
 * characters merely stop being readable as markup.
 */
export function escapeForInlineScript(js) {
  return js
    .replace(/<\/(script)/gi, '\\x3C/$1')
    .replace(/<!--/g, '\\x3C!--');
}

/** Minify, obfuscate, and inline-escape one JavaScript source string. */
export async function hardenJs(code) {
  const minified = await minifyJs(code, {
    compress: {
      // Requirement: strip development-only code. `ui.js` carries a `console.assert`
      // round-trip guard explicitly commented "dev-only, never shown to the coach".
      drop_console: true,
      drop_debugger: true,
      passes: 2,
    },
    mangle: true,
    format: { comments: false },
    // sourceMap is omitted deliberately -- terser defaults to none, and production
    // must never emit one.
  });
  if (typeof minified.code !== 'string') {
    throw new Error('terser produced no output');
  }
  const obfuscated = JavaScriptObfuscator
    .obfuscate(minified.code, OBFUSCATOR_OPTIONS)
    .getObfuscatedCode();
  return escapeForInlineScript(obfuscated);
}

/** Harden every inline `<script>` in `html`, then minify the document itself. */
export async function harden(html) {
  const scriptRe = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = scriptRe.exec(html)) !== null) {
    const [full, open, code, close] = match;
    parts.push(html.slice(lastIndex, match.index));
    if (code.trim().length === 0) {
      parts.push(full);
    } else {
      parts.push(open + (await hardenJs(code)) + close);
    }
    lastIndex = match.index + full.length;
  }
  parts.push(html.slice(lastIndex));

  // JS is already hardened above -- `minifyJS: false` keeps the minifier from
  // re-parsing and undoing it. CSS is collapsed here.
  return minifyHtml(parts.join(''), {
    collapseWhitespace: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: false,
    removeStyleLinkTypeAttributes: true,
    minifyCSS: true,
    minifyJS: false,
    sortAttributes: true,
    sortClassName: true,
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS — all 8 new tests plus the 25 pre-existing ones (33 total).

If the `esc()` test fails, `transformObjectKeys` is the culprit: set it to `false` in `OBFUSCATOR_OPTIONS`, note why in the comment, and re-run. Do **not** weaken the test.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/harden.mjs test/harden.test.mjs
git commit -m "feat: add hardening transform for production builds"
```

---

### Task 2: The production build entry point (`scripts/build-prod.mjs`)

**Files:**
- Create: `scripts/build-prod.mjs`
- Create: `test/build-prod.test.mjs`

**Interfaces:**
- Consumes: `harden(html)` from `scripts/harden.mjs`; `build(outDir)` from the untouched `scripts/build.mjs`.
- Produces, for Tasks 3 and 4: `buildProd(outDir?: string): Promise<{ html: string, plainBytes: number, hardenedBytes: number }>` — writes `index.html` and `sw.js` into `outDir` (default `dist/`) and returns the hardened HTML plus both sizes for reporting.

- [ ] **Step 1: Write the failing tests**

Create `test/build-prod.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProd } from '../scripts/build-prod.mjs';

const out = mkdtempSync(join(tmpdir(), 'ciq-prod-'));
const result = await buildProd(out);
const html = readFileSync(join(out, 'index.html'), 'utf8');

test('emits a self-contained index.html plus sw.js and nothing else', () => {
  assert.ok(existsSync(join(out, 'index.html')));
  assert.ok(existsSync(join(out, 'sw.js')));
  assert.deepEqual(readdirSync(out).sort(), ['index.html', 'sw.js']);
});

test('emits no source maps', () => {
  assert.equal(readdirSync(out).filter((f) => f.endsWith('.map')).length, 0);
  assert.ok(!/sourceMappingURL/.test(html), 'no sourceMappingURL in html');
  assert.ok(!/sourceMappingURL/.test(readFileSync(join(out, 'sw.js'), 'utf8')));
});

test('leaks no readable identifiers from the sources', () => {
  // Names that exist in src/ and must not survive into the shipped bundle.
  for (const name of ['buildStatsPayload', 'runSelfCheck', 'decodeRoster', 'parseSession', 'minusMode']) {
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test test/build-prod.test.mjs
```

Expected: FAIL — `Cannot find module '../scripts/build-prod.mjs'`.

- [ ] **Step 3: Write `scripts/build-prod.mjs`**

```js
// build-prod.mjs — the production entry point. Bundles with the ordinary readable
// builder into a throwaway staging directory, hardens that output, and writes the
// result to dist/. src/ and scripts/build.mjs are never touched by any of this.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify as minifyJs } from 'terser';
import { build } from './build.mjs';
import { harden } from './harden.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildProd(outDir = join(ROOT, 'dist')) {
  // Stage the readable bundle out of the way so a failed harden can never leave a
  // half-written dist/ behind.
  const staging = mkdtempSync(join(tmpdir(), 'ciq-staging-'));
  try {
    build(staging);
    const plain = readFileSync(join(staging, 'index.html'), 'utf8');
    const html = await harden(plain);

    // The service worker ships as its own file -- it must keep this exact name to
    // stay registrable at the same scope (see ui.js, navigator.serviceWorker.register).
    // Minify it, but do not obfuscate: it is eight lines of standard lifecycle
    // handlers with nothing to conceal, and mangling `self`/event plumbing buys
    // nothing but risk.
    const sw = await minifyJs(readFileSync(join(staging, 'sw.js'), 'utf8'), {
      compress: { drop_console: true, drop_debugger: true },
      mangle: true,
      format: { comments: false },
    });
    if (typeof sw.code !== 'string') throw new Error('terser produced no output for sw.js');

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'index.html'), html);
    writeFileSync(join(outDir, 'sw.js'), sw.code);

    return {
      html,
      plainBytes: Buffer.byteLength(plain),
      hardenedBytes: Buffer.byteLength(html),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  const { plainBytes, hardenedBytes } = await buildProd(target);
  const pct = Math.round((hardenedBytes / plainBytes) * 100);
  console.log(`built hardened ${join(target ?? join(ROOT, 'dist'), 'index.html')}`);
  console.log(`  plain ${plainBytes} bytes -> hardened ${hardenedBytes} bytes (${pct}%)`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test test/build-prod.test.mjs
```

Expected: PASS, 8 tests.

If the "leaks no readable identifiers" test fails, the obfuscator's `stringArray` is likely below threshold for that literal — confirm the name appears only inside a string (not as an identifier), and if so it is a genuine leak to fix, not a test to relax.

- [ ] **Step 5: Confirm the plain build is still untouched**

```bash
npm test
```

Expected: PASS, 41 tests total (25 original + 8 harden + 8 build-prod). `test/build.test.mjs` must still pass unchanged — that is the proof `scripts/build.mjs` was not modified.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-prod.mjs test/build-prod.test.mjs
git commit -m "feat: add production build entry point writing hardened dist/"
```

---

### Task 3: Functional verification in a real browser (`scripts/verify-build.mjs`)

Unit tests prove the transform is sound in isolation. This task proves the *shipped file* actually runs: it boots both builds in headless Edge, drives the UI, and diffs a structural fingerprint. Any difference is a regression.

**Files:**
- Create: `scripts/verify-build.mjs`
- Modify: `package.json` (add `puppeteer-core` devDependency)

**Interfaces:**
- Consumes: `buildProd` from Task 2; `build` from `scripts/build.mjs`.
- Produces: a CLI used by Task 4's `npm run verify`. Exits `0` when the two builds are equivalent, `1` on any mismatch or runtime error, `2` when no browser is available.

- [ ] **Step 1: Install the browser driver**

Edge is already installed at `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` (verified during planning). `puppeteer-core` drives it without downloading a second browser.

```bash
npm install --save-dev puppeteer-core@^25.10.0
```

- [ ] **Step 2: Write `scripts/verify-build.mjs`**

```js
/**
 * Proves the hardened build behaves exactly like the readable one.
 *
 * Builds both, loads each in headless Edge, drives the app through a real
 * session, and prints a structural fingerprint of the resulting DOM. Obfuscation
 * only rewrites identifiers and string storage -- it must never change what the
 * app renders -- so the two fingerprints must be byte-identical.
 *
 * Usage: node scripts/verify-build.mjs
 */
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { build } from './build.mjs';
import { buildProd } from './build-prod.mjs';
import { encodeRoster } from '../src/codec.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const executablePath = BROWSER_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chromium-based browser found; cannot verify.');
  process.exit(2);
}

// A roster the app will accept, carrying characters that exercise the HTML
// escaper -- the construct most at risk from `transformObjectKeys`.
// Built with the app's own encoder so the envelope (CIQR1.<base64url>.<fnv1a32>)
// is always valid; hand-rolling it would silently decay as the codec evolves.
// Shape and limits per validateRosterPayload in src/codec.js: v/kind/gameId/
// team/opponent/date/players, ids matching ID_PATTERN, names <= 64 chars.
const ROSTER_NAMES = ['Ada <&> "Q"', "O'Brien", 'Zoe Muller', 'Sam'];

const ROSTER_TEXT = encodeRoster({
  v: 1,
  kind: 'roster',
  gameId: 'verify-1',
  team: 'Home & Co <b>',
  opponent: 'Away "FC"',
  date: '2026-09-13',
  players: ROSTER_NAMES.map((name, i) => ({ id: `p${i + 1}`, name })),
});

/** Boot one build, drive it, and return a structural fingerprint of the DOM. */
async function fingerprint(browser, htmlPath) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await page.waitForSelector('#app *', { timeout: 10_000 });

  // The paste screen is the boot state with no saved session. Feed it a roster
  // and advance into the record screen so rendering, escaping and state all run.
  // `onOpenRoster` (src/ui.js) reads `#pasteText`.value directly and is reached
  // by a delegated click on [data-action="open-roster"] -- there is no framework
  // in between, so a plain value assignment is what the app actually reads.
  const pasted = await page.evaluate((text) => {
    const area = document.getElementById('pasteText');
    const open = document.querySelector('[data-action="open-roster"]');
    if (!area || !open) return false;
    area.value = text;
    open.click();
    return true;
  }, ROSTER_TEXT);

  // Let the synchronous re-render settle before fingerprinting.
  await page.waitForSelector('#app *', { timeout: 10_000 });

  const fp = await page.evaluate(() => {
    const app = document.getElementById('app');
    const root = app ? app.innerHTML : '';
    const tally = (re) => (root.match(re) ?? []).length;
    const classes = [...root.matchAll(/class="([^"]*)"/g)]
      .flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
    const text = (app ? app.innerText : '')
      .split('\n').map((s) => s.trim()).filter(Boolean).join(' | ');
    return {
      mounted: root.trim().length > 0,
      // Escaping check, on innerHTML rather than innerText: a correctly escaped
      // "<b>" in a player name RENDERS as the literal text `<b>`, so innerText
      // is the wrong place to look. What must be true is that no real <b>
      // element was injected and the entity form is present.
      injectedElement: app ? app.querySelector('b, script, img') !== null : false,
      hasEscapedEntity: /&lt;|&amp;|&quot;|&#39;/.test(root),
      elements: tally(/<[a-zA-Z]/g),
      buttons: tally(/<button/g),
      inputs: tally(/<input/g),
      textareas: tally(/<textarea/g),
      distinctClasses: [...new Set(classes)].sort(),
      classUses: classes.length,
      text,
    };
  });

  await page.close();
  return { ...fp, pasted, errors };
}

function render(label, fp) {
  return [
    `--- ${label} ---`,
    `mounted:        ${fp.mounted ? 'yes' : 'NO'}`,
    `pasted-roster:  ${fp.pasted ? 'yes' : 'no'}`,
    `escaped-names:  ${fp.hasEscapedEntity ? 'yes' : 'no'}${fp.injectedElement ? ' (INJECTED ELEMENT!)' : ''}`,
    `elements:       ${fp.elements}`,
    `buttons:        ${fp.buttons}`,
    `inputs:         ${fp.inputs}`,
    `textareas:      ${fp.textareas}`,
    `class-uses:     ${fp.classUses}`,
    `distinct-class: ${fp.distinctClasses.length}`,
    `classes:        ${fp.distinctClasses.join(' ')}`,
    `text:           ${fp.text}`,
  ].join('\n');
}

const staging = mkdtempSync(join(tmpdir(), 'ciq-verify-'));
const plainDir = join(staging, 'plain');
const prodDir = join(staging, 'prod');
let failed = false;

try {
  build(plainDir);
  const { plainBytes, hardenedBytes } = await buildProd(prodDir);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--allow-file-access-from-files'],
  });

  let plainFp;
  let prodFp;
  try {
    plainFp = await fingerprint(browser, join(plainDir, 'index.html'));
    prodFp = await fingerprint(browser, join(prodDir, 'index.html'));
  } finally {
    await browser.close();
  }

  console.log(render('plain build', plainFp));
  console.log();
  console.log(render('hardened build', prodFp));
  console.log();

  for (const [label, fp] of [['plain', plainFp], ['hardened', prodFp]]) {
    if (!fp.mounted) {
      console.error(`FAIL: ${label} build did not mount -- #app is empty.`);
      failed = true;
    }
    if (!fp.pasted) {
      console.error(`FAIL: ${label} build never reached the paste screen.`);
      failed = true;
    }
    if (fp.errors.length > 0) {
      console.error(`FAIL: ${label} build raised runtime errors:`);
      for (const e of fp.errors) console.error(`  ${e}`);
      failed = true;
    }
  }

  const compare = (fp) => JSON.stringify({ ...fp, errors: undefined });
  if (compare(plainFp) !== compare(prodFp)) {
    console.error('FAIL: hardened build renders differently from the plain build.');
    for (const key of Object.keys(plainFp)) {
      if (key === 'errors') continue;
      const a = JSON.stringify(plainFp[key]);
      const b = JSON.stringify(prodFp[key]);
      if (a !== b) console.error(`  ${key}:\n    plain    ${a}\n    hardened ${b}`);
    }
    failed = true;
  }

  // The escaper must have neutralised the markup in the roster names. This is
  // the `transformObjectKeys` hazard (src/ui.js:27) checked on the real app.
  if (!failed && prodFp.injectedElement) {
    console.error('FAIL: hardened build injected a live element from a player name -- esc() is broken.');
    failed = true;
  }
  if (!failed && !prodFp.hasEscapedEntity) {
    console.error('FAIL: hardened build shows no escaped entities -- esc() did not run.');
    failed = true;
  }

  if (!failed) {
    const pct = Math.round((hardenedBytes / plainBytes) * 100);
    console.log('PASS: hardened build renders identically to the plain build.');
    console.log(`  plain ${plainBytes} bytes -> hardened ${hardenedBytes} bytes (${pct}%)`);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: Run the verification**

```bash
node scripts/verify-build.mjs
```

Expected: both fingerprints print, followed by `PASS: hardened build renders identically to the plain build.`

If the two fingerprints differ, **stop and fix the obfuscator options** — do not adjust the comparison to tolerate the difference. Start by setting `transformObjectKeys: false`, re-running, and narrowing from there.

If `pasted-roster: no` appears for *both* builds, the selectors drifted — re-read
`renderPaste` / `onOpenRoster` in `src/ui.js` and correct them, since a fingerprint
that never leaves the boot screen verifies little. If `pasted-roster: yes` but the
text still shows the paste screen, the payload was rejected: print the app's error
banner text and check it against `validateRosterPayload` in `src/codec.js`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json scripts/verify-build.mjs
git commit -m "test: verify hardened build renders identically in headless Edge"
```

---

### Task 4: Wire up the commands and document the build

Makes the hardened build the default so that, per the standing instruction, `dist/index.html` is obfuscated **any time a new frontend is generated** — while keeping a readable escape hatch for debugging.

**Files:**
- Modify: `package.json` (scripts block)
- Modify: `build.bat`
- Modify: `README.md`

**Interfaces:**
- Consumes: `buildProd` (Task 2), `verify-build.mjs` (Task 3).
- Produces: `npm run build` (hardened → `dist/`), `npm run build:dev` (readable → `dist-dev/`), `npm run verify`.

- [ ] **Step 1: Update the `scripts` block in `package.json`**

Keep `name`, `private`, `type`, `version` and the `devDependencies` added in Tasks 1 and 3 exactly as they are; replace only `scripts`:

```json
  "scripts": {
    "build": "node scripts/build-prod.mjs",
    "build:dev": "node scripts/build.mjs dist-dev",
    "verify": "node scripts/verify-build.mjs",
    "test": "node --test"
  }
```

`build` is the hardened build and writes to `dist/`. `build:dev` writes the readable bundle to `dist-dev/` so it can never overwrite the shipped artifact.

- [ ] **Step 2: Ignore the dev output directory**

Append to `.gitignore`:

```
dist-dev/
```

- [ ] **Step 3: Rebuild and verify end to end**

```bash
npm run build && npm run verify && npm test
```

Expected: the build prints its size line, verification prints `PASS`, and all 41 tests pass.

- [ ] **Step 4: Confirm the shipped file is actually hardened**

```bash
node -e "const h=require('fs').readFileSync('dist/index.html','utf8'); console.log('bytes:',h.length); console.log('readable identifiers:', ['buildStatsPayload','runSelfCheck','parseSession','minusMode'].filter(n=>h.includes(n)).join(', ')||'none'); console.log('newlines:',(h.match(/\n/g)||[]).length); console.log('sourceMappingURL:',/sourceMappingURL/.test(h));"
ls dist/
```

Expected: `readable identifiers: none`, `sourceMappingURL: false`, a very low newline count, and `dist/` containing only `index.html` and `sw.js`.

- [ ] **Step 5: Update `build.bat`**

The current header claims "There is no minification or obfuscation step here" and "no npm dependencies, so no `npm install` is needed" — both are now false and must be corrected. Replace the comment header and add a dependency check plus a verification step:

```bat
@echo off
REM ---------------------------------------------------------------------------
REM Rebuilds dist\index.html -- the single self-contained file the client ships
REM as -- plus dist\sw.js, the service worker that makes it installable offline.
REM Double-click it, or run `build.bat` from any directory.
REM
REM Runs `npm run build`, i.e. scripts\build-prod.mjs: concatenates the src\*.js
REM modules in dependency order, inlines them with styles.css into src\index.html,
REM then hardens the result -- terser minifies and drops console/debugger,
REM javascript-obfuscator renames identifiers and encodes string literals, and
REM the HTML and CSS are minified. No source maps are emitted.
REM
REM The shipped dist\index.html is therefore NOT readable. For a readable build,
REM run `npm run build:dev`, which writes dist-dev\index.html and leaves dist\
REM alone. src\ is never modified by either.
REM
REM This build has npm devDependencies, so `npm install` must have been run once.
REM This script runs it automatically if node_modules\ is missing.
REM
REM Run `npm test` for the unit tests (test\*.test.mjs) and `npm run verify` to
REM confirm in a headless browser that the hardened build renders identically to
REM the readable one.
REM ---------------------------------------------------------------------------
setlocal

REM Work from this script's own folder, whatever directory it was launched from.
pushd "%~dp0"

REM `call` is required throughout: npm is npm.cmd, and without it this batch file
REM would hand over control and never reach the lines below.
if not exist "node_modules" (
  echo Installing build dependencies...
  call npm install
  REM `if errorlevel 1`, NOT `if %ERRORLEVEL% NEQ 0`: cmd.exe parses this whole
  REM parenthesised block and expands every bare %VAR% BEFORE running any line in
  REM it, so %ERRORLEVEL% here would hold its value from before npm install ran --
  REM making this branch dead code. `if errorlevel 1` does no expansion and tests
  REM the live value. Capturing into a variable inside this block has the same bug.
  if errorlevel 1 (
    echo *** npm install FAILED -- cannot build. ***
    popd
    exit /b 1
  )
  echo.
)

echo Building coachiq-stats-client ^(hardened^)...
echo.

call npm run build
set BUILD_EXIT=%ERRORLEVEL%

echo.
if %BUILD_EXIT% NEQ 0 (
  echo *** BUILD FAILED ^(exit code %BUILD_EXIT%^) -- dist\ was NOT updated. ***
) else (
  echo Build OK -- dist\index.html updated ^(minified + obfuscated^).
  for %%F in ("%~dp0dist\index.html") do echo    %%~zF bytes, %%~tF
  for %%F in ("%~dp0dist\sw.js") do echo    sw.js: %%~zF bytes, %%~tF
)

popd

REM Hold the window open when there'd be nobody left to read it -- a double-click
REM from Explorer closes the console the instant this script ends. Pass `nopause`
REM (build.bat nopause) to skip it when calling from another script.
if /i "%~1"=="nopause" goto :done
echo %CMDCMDLINE% | find /i "/c" >nul
if not errorlevel 1 pause

:done

exit /b %BUILD_EXIT%
```

- [ ] **Step 6: Run the batch file to confirm it works**

```bash
cmd //c build.bat nopause
```

Expected: `Build OK -- dist\index.html updated (minified + obfuscated).` and a non-zero byte count, exit code 0.

- [ ] **Step 7: Document the build in `README.md`**

**First, close a trap.** Two lines currently tell the reader to invoke the bundler
directly, which after this change would overwrite the shipped `dist/index.html`
with a *readable* build — exactly what must not happen. Both must be rewritten:

- Line 9, in `## Develop`, currently reads:
  > Run `npm test` to execute tests with Node's built-in test runner (no install step needed). Rebuild with `node scripts/build.mjs` to produce `dist/index.html` and `dist/sw.js`.

  Replace that sentence with:
  > Run `npm install` once, then `npm test` to execute tests with Node's built-in test runner. Rebuild with `npm run build` to produce the hardened `dist/index.html` and `dist/sw.js`; use `npm run build:dev` for a readable bundle in `dist-dev/`. Do not run `node scripts/build.mjs` directly — it writes an unobfuscated bundle.

- Line 36, in `## Update the app`, currently reads:
  > Edit source files, run `npm test`, rebuild with `node scripts/build.mjs`, commit, and push with `git push`. Then update the Pages deployment:

  Replace `node scripts/build.mjs` with `npm run build` so releases are always
  hardened:
  > Edit source files, run `npm test`, rebuild with `npm run build`, commit, and push with `git push`. Then update the Pages deployment:

**Then add a new `## Building` section** immediately after `## Develop`, with the
following content. Keep the rest of the README as is.

````markdown
## Building

```bash
npm install        # once -- the build has devDependencies
npm run build      # hardened -> dist/index.html + dist/sw.js   (what you ship)
npm run build:dev  # readable -> dist-dev/index.html            (for debugging)
npm test           # unit tests
npm run verify     # boots both builds in headless Edge and diffs what they render
```

`npm run build` is the production build. It concatenates `src/*.js` in dependency
order, inlines them with `styles.css` into `src/index.html`, and then hardens the
result:

- **terser** minifies and mangles identifiers, drops every `console.*` and
  `debugger` statement, and strips all comments.
- **javascript-obfuscator** renames what is left and moves string literals into an
  encoded, rotated, shuffled array behind accessor functions.
- **html-minifier-terser** collapses the document and its CSS.
- **No source maps are generated**, and nothing writes a `.map` file.

`src/` is never touched. For a readable build, use `npm run build:dev`, which
writes to `dist-dev/` and leaves `dist/` alone.

### What obfuscation does and does not buy

It raises the cost of reading the rotation and stats logic from minutes to hours.
It is **not** a confidentiality boundary: anything the browser executes can
ultimately be inspected, and a determined reader with a debugger will get there.
Do not treat obfuscation as a reason to put a secret in this bundle.

That is not a live concern today, because there is nothing to protect:

- The app contacts **no external endpoint** — no API calls, no analytics, no
  third-party requests, and no external URL in the shipped bundle. The one `fetch`
  in the codebase is in `src/sw.js`, the service worker's cache-passthrough
  handler, and it only re-requests the app's own same-origin assets so the app
  works offline. `test/build.test.mjs` enforces that the built HTML carries no
  literal `http(s)://` URL and no external `<script>`/`<link>`.
- It holds **no API keys, tokens, or credentials**. The only persistence is
  `localStorage` on the coach's own device.
- There is **no server**, so there is no security-sensitive logic to move behind
  an API. Should one ever be added, put the secrets there — not here.

### Asset filenames

Everything inlines into a single HTML entry point, so there are no sub-assets to
content-hash. The two emitted filenames are both fixed by contract: `index.html`
is what users bookmark and what `sw.js` fetches by name, and `sw.js` must keep its
name to stay registrable at the same scope. Cache-busting is handled instead by
bumping the `CACHE` constant at the top of `src/sw.js`.
````

- [ ] **Step 8: Final full check**

```bash
npm run build && npm test && npm run verify
```

Expected: build succeeds, 41 tests pass, verification prints `PASS`.

- [ ] **Step 9: Commit**

```bash
git add package.json .gitignore build.bat README.md dist/
git commit -m "build: make the hardened build the default and document it"
```

---

## Post-Implementation Report

After Task 4, report to the user:

1. `dist/index.html` size before and after hardening, as a percentage.
2. A short excerpt of the hardened output, to show what a reader now faces.
3. Confirmation that all tests pass and headless verification says `PASS`.
4. The two requirements satisfied as **N/A with justification** (server-side logic
   migration, asset hashing) — stated plainly, not glossed over, so the user can
   overrule if they disagree.
