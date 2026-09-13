# CoachIQ Stats Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single self-contained `index.html` that runs as an iPhone Home Screen web app, records per-player serve/return counts per set for several games a day, and exchanges roster/stats payloads with the planner by copy/paste using the fixed `CIQR1`/`CIQS1` contract.

**Architecture:** Source is split into four plain-JS files (`codec.js`, `session.js`, `ui.js`, `styles.css`) plus an HTML template. A 40-line dependency-free Node script inlines them into `dist/index.html` (the shipped artefact needs no build to *run*; the concat exists only so the pure modules can be unit-tested with `node --test`). `codec.js` is the contract's reference codec and validators copied verbatim. `session.js` is a pure state model (games → sets → counts, undo stack, storage envelope, stats-payload builder) with no DOM. `ui.js` renders screens from state and persists to `localStorage` after every mutation.

**Tech Stack:** Plain HTML/CSS/JS (ES2020, no framework, no deps). Node 24 `node:test` for unit tests. GitHub Pages for delivery to the phone. Optional `sw.js` for offline launch.

**Spec:** `PROMPT.md` + `reference/stats-contract.md` (the contract wins on any disagreement).

**Copy this plan to** `docs/superpowers/plans/2026-09-13-stats-client.md` as the first action of execution (plan mode only allowed writing here).

## Global Constraints

- Contract v1 exactly as `reference/stats-contract.md`: prefixes `CIQR1.`/`CIQS1.`, FNV-1a 32 checksum over UTF-8 JSON bytes, Base64URL body, whitespace-stripped decode, error strings verbatim.
- `MAX_ROSTER_PLAYERS = 12`, `MAX_COUNT = 999`, `MAX_NAME_LENGTH = 64`, `ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/`, `CLIENT_ID_PATTERN = /^cx-[A-Za-z0-9_-]{4,32}$/`.
- Shipped file: one `dist/index.html`, inline CSS/JS, no external resources, no network calls. `dist/sw.js` is an optional sibling that only matters when hosted over https.
- Tap targets ≥ 44×44 pt. Portrait, light theme only (user decision). No jersey numbers (user decision).
- Stats payload keys emitted in the documented order so the golden vector compares byte-exact.
- **Never commit unless the user asks** (global CLAUDE.md). Task steps below therefore have no commit steps.
- **Session budget:** the user's session is at ~64% and must pause at 95%. Claude cannot see the meter. Execute Tasks 1–4 first (mockup, scaffold, codec, session model), then STOP and report; the user resumes after 11:10 am. Every task is independently resumable.

---

## Context

The planner (`C:\_src\CoachIQ_Rotation_Planner`) already ships the Stats dialog: it emits a roster payload and imports a stats payload. This repo builds the other end: the phone app the coach uses courtside. The contract is frozen, so the Client's job is to (1) copy the codec, (2) make recording fast and mis-tap tolerant on a 390-pt screen, (3) never lose counts, and (4) get the string back to the planner via the share sheet.

### Feasibility: yes, with one delivery change

Everything in PROMPT.md is buildable in plain JS. The one thing that does **not** work as written is "opened from Files": on iOS 18.5+ tapping an `.html` in Files gives a Quick Look preview with JavaScript disabled, and Safari can no longer open local files. The user chose the fix: host `dist/` on GitHub Pages and install via Safari's **Add to Home Screen**. That also gives the app its own storage container, exempt from Safari's 7-day storage eviction, and a service worker lets it launch offline at a gym with no signal.

### Decisions confirmed with the user (2026-09-13)

| Question | Decision |
|---|---|
| Delivery to iPhone | GitHub Pages + Add to Home Screen, with optional `sw.js` for offline launch |
| Recording layout | Compact row: name + four 44-pt count buttons; tap = +1; one-shot "−" mode toggle; global Undo |
| Jersey numbers | Not shown |
| Set scores at export | Optional; `null` allowed; export summary says "no score" |
| Sit-out marker | None; all-zero players omitted from a set's lines (contract: 0/0) |
| Roster prompt | Only when no game is open; launch resumes last game/set |
| Landscape / dark | Neither |
| Edit after export | Always editable; export is a snapshot, re-export any time |

### Answers to PROMPT.md §"Please evaluate and recommend"

**1. Screen flow and recording layout.** Screens: Paste roster → Recording → (sheets: Score, Add sub, Game switcher, Menu) → Export. Recording row = 96-pt name column + four 64×48-pt buttons (Serve In, Serve Out, Return In, Return Out) with the count printed inside; 12 rows × 52 pt = 624 pt, which fits without scrolling in standalone mode on an iPhone 13-class screen (≈800 pt usable) and scrolls one row in Safari. Every count is one tap, no mode switch, no expansion. "In" buttons are green-tinted, "Out" orange-tinted, matching the planner's `--ok`/`--warn` tokens. The expandable-row and two-step options were rejected because both make the common action two taps.

**2. Data model.** See `session.js` in Task 4. `Session { schema, activeGameId, games[] }`, `Game { gameId, team, opponent, date, players[], sets[3], activeSet, history[], lastExportedAt }`, `SetRecord { score, counts{playerId → {serve:{in,out}, return:{in,out}}} } | null`. Mapping to the stats payload: `players` = game.players (id, name); `sets` = the set records where `score !== null || any count > 0`, in index order (so ascending by construction); each set's `players` = roster-ordered lines with any non-zero count. Ids come only from the roster payload or the `cx-` generator, players never exceed 12 by construction, counts are clamped 0–999 at mutation time, and `validateStatsPayload` runs on the built object before encoding as a final guard.

**3. Persistence and recovery.** One `localStorage` key `coachiq-stats-client` holding a versioned envelope `{ schema: 1, savedAt, session }`, written synchronously inside the single `commit()` path after every mutation (tap, undo, score, sub, switch). On load an unparsable file is copied to `coachiq-stats-client.unreadable` and a fresh session starts with a warning banner (the planner's own pattern). A quota failure shows a persistent red banner "Could not save — export now". Safari backgrounding, lock, and tab eviction all preserve `localStorage`; the Home Screen container is exempt from the 7-day ITP eviction. Re-pasting a roster whose `gameId` already exists shows a three-way choice: **Open it** (default), **Update roster** (merge: add new players, keep everyone with counts, drop zero-count players missing from the new roster; refused if the result exceeds 12), or **Cancel**. Stats are never discarded by a paste.

**4. Codec sharing and self-check.** `src/codec.js` is the contract doc's plain-JS reference codec verbatim, plus the two validators ported line-for-line from `reference/statsContract.ts` with types removed (error strings identical). `src/vectors.js` holds the golden vectors. The self-check (a) decodes both vectors and deep-compares to the payload objects, (b) re-encodes both payload objects and compares strings byte-exact (possible because we build objects in documented key order), (c) checks `fnv1a32` of `[]` and `"a"`. It runs in `node --test` and at app start (a failure shows a red banner; the Menu also has "Codec self-check" showing OK/FAIL).

**5. Export and sharing.** Export screen shows a human summary line (`vs Lions · 19 Sep · Set 1 25–21 · Set 2 no score · 11 players`), a read-only textarea with the string, **Copy** (`navigator.clipboard.writeText`, inside the tap handler), and **Share** (`navigator.share({ title, text })`, shown only when `navigator.share` exists — it does on iOS Safari over https and in Home Screen apps). Fallback when copy rejects: focus the textarea, select all, and show "Select all and copy". Nothing throws; every path resolves to a status line.

**6. Testing.** Pure modules are unit-tested with `node --test` (Node 24 has `TextEncoder`, `btoa`, `atob`, `crypto` globals): codec golden vectors and error catalogue; session model (clamping, undo, set/line omission, game isolation, roster merge, sub cap, envelope round-trip, unreadable file). A build test asserts `dist/index.html` is one file with no `http`/`src=` externals and no leftover `export` tokens. UI is verified by the mockup review (device toolbar 390×844) and a manual checklist on the phone (Task 9). No puppeteer dependency here.

**7. Concerns and contract feedback (raise with the planner; no divergence here).**
- Set `score` is validated only as two numbers; the Client will only ever send integers 0–99, but the planner might want to bound it too.
- A payload quoted by a mail client (`> CIQS1...`) fails the head regex because `>` is not whitespace. The Client will not pre-clean input (that would silently widen the contract). Suggest the contract strip leading `>` per line in step 1, in both apps.
- Roster `date` is display-only free text; the Client formats it as `19 Sep` when it parses as `YYYY-MM-DD`, otherwise shows it raw.
- A Home Screen app cold-launches from the network. Without `sw.js` there is no app at a gym without signal. `sw.js` is therefore included in `dist/` even though the app itself stays single-file.

### Assumptions
- Node ≥ 18 on the PC for tests and the build; no `npm install` ever needed.
- GitHub repo created by the user on github.com (no `gh` CLI installed); Pages served from the `gh-pages` branch pushed via `git subtree push --prefix dist`.
- `recordedAt` = `new Date().toISOString()` at export time.
- "Set started" is purely a UI notion; the export rule is the objective one in §2.
- The "−" toggle is one-shot: after one subtraction it switches itself off (safest against double mis-taps); Undo covers the rest.
- Undo stack per game, capped at 200 entries, covers taps only (not scores or subs).

---

## File Structure

```
package.json                 {"type":"module","scripts":{"build","test"}}  — no deps
src/index.html               template with <!--STYLES--> and <!--SCRIPT--> markers, apple-mobile-web-app meta tags
src/styles.css               tokens copied from reference/stats-mockup.html (light only) + layout
src/codec.js                 contract codec + validators (verbatim port), constants
src/vectors.js               golden vectors
src/session.js               pure state model + envelope + payload builder + self-check
src/ui.js                    screens, event wiring, persistence, clipboard/share, sw registration
scripts/build.mjs            inlines src/* → dist/index.html, copies src/sw.js → dist/sw.js
src/sw.js                    network-first, cache-fallback worker (copied to dist unchanged)
dist/index.html, dist/sw.js  the shipped artefacts (committed, so Pages can serve them)
test/codec.test.mjs
test/session.test.mjs
test/build.test.mjs
docs/mockup.html             the required screen mockup (Task 1)
docs/superpowers/plans/2026-09-13-stats-client.md   copy of this plan
```

Module concatenation order in the built file: `codec.js`, `vectors.js`, `session.js`, `ui.js`. Each source file uses `export function`/`export const`; the build strips the leading `export ` and wraps everything in one `<script>` inside an IIFE. Names are globally unique across the four files.

---

### Task 1: HTML mockup of every screen (review gate)

**Files:**
- Create: `docs/mockup.html`
- Create: `docs/superpowers/plans/2026-09-13-stats-client.md` (copy of this plan, verbatim)

**Interfaces:** none (static). Establishes the class names `ui.js` will use: `.screen`, `.topbar`, `.setbar`, `.seg`, `.row`, `.name`, `.cnt.in`, `.cnt.out`, `.bottombar`, `.sheet`, `.banner`, `.banner.err`, `.payload`, `.btn`, `.btn.primary`, `.btn.danger`.

- [ ] **Step 1: Write the mockup.** One file, inline CSS only, a small script for the theme-free state toggles. A fixed 390-pt-wide phone frame per state, states laid out down the page, each numbered. Tokens copied from `reference/stats-mockup.html` `:root` (light only). Required states, one frame each:
  1. Paste roster screen (empty textarea, "Open game" primary button, help text "Paste the roster copied from CoachIQ Rotation Planner").
  2. Recording screen: `vs Lions · 19 Sep` top bar with `Games ▾` and `⋯` buttons; set bar `Set 1 [25–21] · Set 2 · Set 3` segmented control with the active set's score chip; column header `Serve In · Serve Out · Return In · Return Out`; **12 rows** (names from the planner mockup fixture, one marked `sub` chip); bottom bar `↶ Undo Grace S in` · `−` · `Export`.
  3. Recording screen in "−" mode (all buttons red-outlined, bottom `−` button filled).
  4. Score sheet: two `inputmode=numeric` fields `Us` / `Them`, `Clear score`, `Done`.
  5. Add-a-sub sheet: name field, `Add`, `Cancel`; and its two errors: empty/too-long name; "This game already has 12 players; the stats app limit is 12."
  6. Export screen: summary line, read-only monospace payload box, `Copy`, `Share…`, `Back`; status line "Copied — paste it into the planner's Stats dialog."; fallback line "The clipboard is not available here — select the text and copy it."
  7. Game switcher sheet: list rows `vs Lions · 19 Sep · 2 sets · exported 14:02`, `vs Bears · 19 Sep · 1 set`, `+ New game (paste roster)`, each row with a `Delete` button; the delete confirmation "Delete vs Bears and its stats? This cannot be undone." with `Delete`/`Cancel`.
  8. Menu sheet (`⋯`): `Add a sub`, `Clear Set 1…`, `Delete game…`, `Codec self-check: OK`, `v1.0.0`; the clear-set confirmation.
  9. Error states on the paste screen, one banner each with the contract's exact wording: not a CoachIQ payload; "This is a stats payload, not a roster payload."; newer version; corrupted; malformed roster ("The roster payload is malformed: it names 13 players; the limit is 12.").
  10. "Game already open" choice: `vs Lions is already open with 2 sets recorded.` `Open it` / `Update roster` / `Cancel`; and the merge refusal "Updating would make 14 players; the stats app limit is 12."
  11. Storage banners: "Could not save — export your stats now." (red, persistent) and "The saved session could not be read and was set aside; starting fresh." (amber).
  12. Codec self-check failure banner (red): "Codec self-check failed — do not export until this build is fixed."
- [ ] **Step 2: Open it for review.** Run `Start-Process docs\mockup.html`. Then run the build test placeholder: none yet. Report to the user which frames to look at at 390×844 in the browser's device toolbar.
- [ ] **Step 3: Stop for feedback** before Task 5 (UI). Tasks 2–4 do not depend on the mockup's look and may proceed.

---

### Task 2: Scaffold, build script, service worker

**Files:**
- Create: `package.json`, `scripts/build.mjs`, `src/index.html`, `src/styles.css` (empty for now), `src/sw.js`, `test/build.test.mjs`
- Create: empty `src/codec.js`, `src/vectors.js`, `src/session.js`, `src/ui.js` (one comment line each)

**Interfaces:**
- Produces: `node scripts/build.mjs [outDir]` → writes `<outDir>/index.html` and `<outDir>/sw.js` (default `dist`). Exports `build(outDir)` for the test.

- [ ] **Step 1: Write the failing build test** `test/build.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../scripts/build.mjs';

test('build produces one self-contained html plus sw.js', () => {
  const out = mkdtempSync(join(tmpdir(), 'ciq-'));
  build(out);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(existsSync(join(out, 'sw.js')));
  assert.ok(!/<!--(STYLES|SCRIPT)-->/.test(html), 'markers replaced');
  assert.ok(!/^\s*export /m.test(html), 'no export keywords left');
  assert.ok(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no external URLs');
  assert.ok(!/<(script|link)[^>]+(src|href)=/.test(html), 'no external script/link');
  assert.ok(html.length < 300_000);
});
```

- [ ] **Step 2: Run** `node --test test/` → FAIL (module not found).
- [ ] **Step 3: Write `scripts/build.mjs`:**

```js
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = ['codec.js', 'vectors.js', 'session.js', 'ui.js'];

export function build(outDir = join(ROOT, 'dist')) {
  const src = (f) => readFileSync(join(ROOT, 'src', f), 'utf8');
  const js = ORDER.map((f) => `// ---- ${f} ----\n` + src(f).replace(/^export /gm, '')).join('\n');
  const html = src('index.html')
    .replace('<!--STYLES-->', () => `<style>\n${src('styles.css')}\n</style>`)
    .replace('<!--SCRIPT-->', () => `<script>\n(function () {\n'use strict';\n${js}\n})();\n</script>`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), html);
  copyFileSync(join(ROOT, 'src', 'sw.js'), join(outDir, 'sw.js'));
  return join(outDir, 'index.html');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('built', build(process.argv[2]));
}
```

- [ ] **Step 4: Write `src/index.html`** (no external refs; `<!--STYLES-->` in head, `<!--SCRIPT-->` at end of body):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="CoachIQ Stats">
<meta name="theme-color" content="#f2f4f7">
<title>CoachIQ Stats</title>
<!--STYLES-->
</head>
<body>
<div id="app"></div>
<!--SCRIPT-->
</body>
</html>
```

- [ ] **Step 5: Write `src/sw.js`** (network-first so updates arrive when online, cache fallback offline):

```js
const CACHE = 'ciq-stats-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html']))); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match('./index.html'))));
});
```

- [ ] **Step 6: `package.json`:** `{ "name": "coachiq-stats-client", "private": true, "type": "module", "version": "1.0.0", "scripts": { "build": "node scripts/build.mjs", "test": "node --test test/" } }`
- [ ] **Step 7: Run** `node --test test/` → PASS. Run `node scripts/build.mjs` → `dist/index.html` exists.

---

### Task 3: Codec and validators (verbatim port) + golden-vector tests

**Files:**
- Modify: `src/codec.js`, `src/vectors.js`
- Test: `test/codec.test.mjs`

**Interfaces:**
- Produces (all `export`ed): `CONTRACT_VERSION`, `MAX_ROSTER_PLAYERS`, `MAX_COUNT`, `MAX_NAME_LENGTH`, `ID_PATTERN`, `CLIENT_ID_PATTERN`, `fnv1a32(bytes)`, `encodePayload(kind, json)`, `decodePayload(text, expected)` → `{ok:true,value}|{ok:false,error}`, `validateRosterPayload(v)`, `validateStatsPayload(v)`, `encodeStats(p)`, `decodeRoster(text)`, `decodeStats(text)`; `ROSTER_VECTOR`, `STATS_VECTOR` = `{ payload, encoded }`.

- [ ] **Step 1: Write failing tests** `test/codec.test.mjs` (Node globals: `TextEncoder`, `btoa`, `atob` exist):

```js
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
```

- [ ] **Step 2: Run** `node --test test/codec.test.mjs` → FAIL.
- [ ] **Step 3: Write `src/codec.js`.** Copy the "Plain-JS reference codec" block from `reference/stats-contract.md` lines 233–293 **character for character**, prefixing each top-level `const`/`function` with `export `. Then port `validateRosterPayload`, `validateStatsPayload`, `encodeStats`, `decodeRoster`, `decodeStats` and the helpers (`isRecord`, `malformed`, `isLegalId`, `nameLengthFault`, `isCount`, `isLegalStatCount`, `buildStatCount`, `parseScore`, `KIND_LABEL`) from `reference/statsContract.ts` lines 109–376 by deleting type annotations only (`: string`, `: unknown`, `<T>`, `as`, `interface` blocks, `value is X`). Keep every error string identical. Add `export const MAX_ROSTER_PLAYERS = 12, MAX_COUNT = 999, MAX_NAME_LENGTH = 64; export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/; export const CLIENT_ID_PATTERN = /^cx-[A-Za-z0-9_-]{4,32}$/;`. Add a header comment naming the source commit `2c57064` and "do not edit; re-copy".
- [ ] **Step 4: Write `src/vectors.js`:** the two objects from `reference/vectors.ts` (drop the type import), `export const ROSTER_VECTOR = { payload: {...}, encoded: '...' }` and `STATS_VECTOR` likewise. Copy the `encoded` strings exactly from `reference/vectors.ts` lines 28 and 33.
- [ ] **Step 5: Run** `node --test test/` → all PASS.

---

### Task 4: Session model (pure), storage envelope, payload builder, self-check

**Files:**
- Modify: `src/session.js`
- Test: `test/session.test.mjs`

**Interfaces:**
- Consumes: `codec.js` exports (Task 3).
- Produces (all pure; every mutator returns a **new** session object, never mutates):
  - `STORAGE_KEY = 'coachiq-stats-client'`, `UNREADABLE_KEY = 'coachiq-stats-client.unreadable'`, `SESSION_SCHEMA = 1`, `APP_VERSION = '1.0.0'`, `MAX_SCORE = 99`, `UNDO_LIMIT = 200`.
  - `newSession()` → `{ activeGameId: null, games: [] }`
  - `serialiseSession(s)` → string; `parseSession(text)` → `{ ok, value } | { ok:false, error }`
  - `newGameFromRoster(roster, nowIso)` → `Game`
  - `openRoster(s, roster, nowIso)` → `{ kind: 'opened', session } | { kind: 'exists', game }`
  - `updateRoster(s, gameId, roster)` → `{ ok, session } | { ok:false, error }`
  - `setActiveGame(s, gameId)`, `deleteGame(s, gameId)`, `setActiveSet(s, gameId, n)`
  - `tap(s, gameId, n, playerId, stat, side, delta)` → session (clamped 0–999; pushes history)
  - `undo(s, gameId)` → `{ session, undone: Tap | null }`
  - `setScore(s, gameId, n, score /* [us,them] | null */)`, `clearSet(s, gameId, n)`
  - `addSub(s, gameId, name, id?)` → `{ ok, session } | { ok:false, error }`; `newClientId()` → `cx-` + 8 random `[A-Za-z0-9]`
  - `isSetPlayed(setRecord)`, `getCount(game, n, playerId)` → `{serve:{in,out},return:{in,out}}` (zeros if absent)
  - `buildStatsPayload(game, nowIso)` → `{ ok, value: { text, summary, payload } } | { ok:false, error }`
  - `gameLabel(game)` → `vs Lions · 19 Sep`; `formatDate(text)`
  - `runSelfCheck()` → `{ ok: true } | { ok: false, error }`

Shapes:

```js
// Game
{ gameId, team, opponent, date, importedAt, players: [{ id, name, sub }], sets: [SetRecord|null, SetRecord|null, SetRecord|null],
  activeSet: 1, history: [ { n, playerId, stat, side, delta } ], lastExportedAt: null }
// SetRecord
{ score: null | [us, them], counts: { [playerId]: { serve: { in, out }, return: { in, out } } } }
// Envelope
{ schema: 1, savedAt, session: { activeGameId, games } }
```

- [ ] **Step 1: Write failing tests** `test/session.test.mjs` covering, with `ROSTER_VECTOR.payload` as the roster:

```js
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
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `src/session.js`.** Key parts (the rest is straightforward immutable updates using spread and `map`):

```js
export const STORAGE_KEY = 'coachiq-stats-client';
export const UNREADABLE_KEY = 'coachiq-stats-client.unreadable';
export const SESSION_SCHEMA = 1;
export const APP_VERSION = '1.0.0';
export const MAX_SCORE = 99;
export const UNDO_LIMIT = 200;

export function newSession() { return { activeGameId: null, games: [] }; }
const zero = () => ({ serve: { in: 0, out: 0 }, return: { in: 0, out: 0 } });
export function getCount(game, n, playerId) { return game.sets[n - 1]?.counts[playerId] ?? zero(); }
export function isSetPlayed(set) {
  return set !== null && (set.score !== null || Object.values(set.counts).some((c) => c.serve.in + c.serve.out + c.return.in + c.return.out > 0));
}
function withGame(s, gameId, fn) { return { ...s, games: s.games.map((g) => (g.gameId === gameId ? fn(g) : g)) }; }

export function tap(s, gameId, n, playerId, stat, side, delta) {
  return withGame(s, gameId, (g) => {
    const set = g.sets[n - 1] ?? { score: null, counts: {} };
    const cur = set.counts[playerId] ?? zero();
    const next = Math.max(0, Math.min(MAX_COUNT, cur[stat][side] + delta));
    if (next === cur[stat][side]) return g;
    const counts = { ...set.counts, [playerId]: { ...cur, [stat]: { ...cur[stat], [side]: next } } };
    const sets = g.sets.slice(); sets[n - 1] = { ...set, counts };
    const history = [...g.history, { n, playerId, stat, side, delta: next - cur[stat][side] }].slice(-UNDO_LIMIT);
    return { ...g, sets, history };
  });
}
export function undo(s, gameId) {
  const g = s.games.find((x) => x.gameId === gameId);
  const last = g?.history[g.history.length - 1];
  if (!last) return { session: s, undone: null };
  let next = tap(s, gameId, last.n, last.playerId, last.stat, last.side, -last.delta);
  next = withGame(next, gameId, (x) => ({ ...x, history: x.history.slice(0, g.history.length - 1) }));
  return { session: next, undone: last };
}
export function buildStatsPayload(game, nowIso) {
  const sets = [];
  game.sets.forEach((set, i) => {
    if (!isSetPlayed(set)) return;
    const players = game.players.flatMap((p) => {
      const c = set.counts[p.id]; if (!c) return [];
      if (c.serve.in + c.serve.out + c.return.in + c.return.out === 0) return [];
      return [{ id: p.id, serve: { in: c.serve.in, out: c.serve.out }, return: { in: c.return.in, out: c.return.out } }];
    });
    sets.push({ n: i + 1, score: set.score === null ? null : [set.score[0], set.score[1]], players });
  });
  if (sets.length === 0) return { ok: false, error: 'Nothing recorded yet — tap a count or enter a score first.' };
  const payload = { v: 1, kind: 'stats', gameId: game.gameId, recordedAt: nowIso, players: game.players.map((p) => ({ id: p.id, name: p.name })), sets };
  const valid = validateStatsPayload(payload);
  if (!valid.ok) return valid;
  const summary = [gameLabel(game), ...sets.map((x) => `Set ${x.n} ${x.score ? `${x.score[0]}–${x.score[1]}` : 'no score'}`), `${payload.players.length} player${payload.players.length === 1 ? '' : 's'}`].join(' · ');
  return { ok: true, value: { text: encodeStats(payload), summary, payload } };
}
export function newClientId() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const r = crypto.getRandomValues(new Uint8Array(8));
  return 'cx-' + Array.from(r, (b) => A[b % A.length]).join('');
}
export function runSelfCheck() {
  try {
    if (fnv1a32(new Uint8Array()) !== '811c9dc5') return { ok: false, error: 'fnv1a32 of empty input' };
    if (encodePayload('roster', ROSTER_VECTOR.payload) !== ROSTER_VECTOR.encoded) return { ok: false, error: 'roster vector encode' };
    if (encodeStats(STATS_VECTOR.payload) !== STATS_VECTOR.encoded) return { ok: false, error: 'stats vector encode' };
    const r = decodeRoster(ROSTER_VECTOR.encoded), t = decodeStats(STATS_VECTOR.encoded);
    if (!r.ok || JSON.stringify(r.value) !== JSON.stringify(ROSTER_VECTOR.payload)) return { ok: false, error: 'roster vector decode' };
    if (!t.ok || JSON.stringify(t.value) !== JSON.stringify(STATS_VECTOR.payload)) return { ok: false, error: 'stats vector decode' };
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
```

  `parseSession` validates field by field (schema === 1, games array, each game's fields, `sets` length 3 of `null|{score,counts}`, counts integers 0–999, score `null|[int,int]`), rebuilding the value (never spreading unknown input), and returns the contract-style result. `openRoster` builds `players` from `roster.players` as `{ id, name, sub: false }` and sets `activeGameId`. `addSub` trims, checks `Enter a name.` / `That name is <n> characters; the limit is 64.` / the 12 cap, uses `id ?? newClientId()`, appends `{ id, name, sub: true }`. `updateRoster`: new list = roster players (in roster order, keeping an existing player's `sub` flag) + existing players not in the roster that have any non-zero count in any set or are subs; refuse `Updating would make <n> players; the stats app limit is 12.` `deleteGame`: remove; if it was active, `activeGameId` = first remaining game's id or `null`. `formatDate`: `/^(\d{4})-(\d{2})-(\d{2})$/` → `19 Sep`, else raw. `gameLabel` = `vs ${opponent} · ${formatDate(date)}`.

- [ ] **Step 4: Run** `node --test test/` → all PASS.

**⏸ CHECKPOINT: stop here and report** (session budget). Tasks 5–9 resume after the user's session resets and after the mockup review.

---

### Task 5: UI — paste screen, persistence wiring, recording screen

**Files:**
- Modify: `src/ui.js`, `src/styles.css`

**Interfaces:**
- Consumes: everything from Tasks 3–4.
- Produces: `boot()` called at the end of `ui.js`; internal `state = { session, screen, sheet, minusMode, banner, lastUndo }`; `commit(nextSession)` persists then renders; `render()` rebuilds `#app` from state (full re-render, innerHTML + delegated events — 12 rows is cheap).

- [ ] **Step 1: Styles.** Copy the `:root` tokens (light) from `reference/stats-mockup.html` lines 19–33 and the `.btn`, `.btn.primary`, `.seg`, `.banner`, `.banner.err`, `.payload`, `.gchip` rules, then the layout from Task 1's mockup: `body { padding: env(safe-area-inset-top) 12px env(safe-area-inset-bottom); -webkit-user-select:none; overscroll-behavior:none }`, `.row { display:grid; grid-template-columns: 96px repeat(4, 1fr); gap:4px; height:52px; align-items:center }`, `.cnt { min-height:48px; font-size:20px; font-variant-numeric:tabular-nums; border-radius:10px; border:1px solid var(--line-2); touch-action:manipulation }`, `.cnt.in { background:var(--ok-bg) } .cnt.out { background:var(--warn-bg) }`, `.minus .cnt { border-color:var(--err); }`, `.bottombar { position:sticky; bottom:0; display:grid; grid-template-columns:1fr 56px 1fr; gap:8px; padding:8px 0 calc(8px + env(safe-area-inset-bottom)); background:var(--bg) }`, `.sheet` as a bottom-anchored fixed panel over a backdrop.
- [ ] **Step 2: Persistence wiring in `ui.js`:**

```js
function load() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { /* storage unavailable */ }
  if (raw === null) return { session: newSession(), banner: null };
  const parsed = parseSession(raw);
  if (parsed.ok) return { session: parsed.value, banner: null };
  try { localStorage.setItem(UNREADABLE_KEY, raw); } catch { /* best effort */ }
  return { session: newSession(), banner: { kind: 'warn', text: 'The saved session could not be read and was set aside; starting fresh.' } };
}
function commit(session) {
  state.session = session;
  try { localStorage.setItem(STORAGE_KEY, serialiseSession(session)); state.saveFailed = false; }
  catch { state.saveFailed = true; }
  render();
}
document.addEventListener('visibilitychange', () => { if (document.hidden) commit(state.session); });
```

  `saveFailed` renders the persistent red banner "Could not save — export your stats now."
- [ ] **Step 3: Paste screen.** Textarea (`autocapitalize=off autocorrect=off spellcheck=false`), "Open game" button, "Cancel" when `session.games.length > 0`. On Open: `decodeRoster(text)`; error → red banner with `error` verbatim; ok → `openRoster`; `kind:'exists'` → sheet with `Open it` / `Update roster` / `Cancel` (Update calls `updateRoster`, error shown in the sheet). Success → `screen = 'record'`.
- [ ] **Step 4: Recording screen.** Top bar: `gameLabel(game)` + `Games ▾` (opens switcher sheet, Task 6) + `⋯` (menu sheet, Task 6). Set bar: segmented `Set 1/2/3`, active set's score chip (`25–21` or `score`) opening the score sheet. Column header. Rows from `game.players` via `getCount`. Each `.cnt` button has `data-pid data-stat data-side`; a delegated `click` handler calls `tap(..., minusMode ? -1 : +1)`, then if `minusMode` sets it false. Bottom bar: `↶ Undo …` (label from `lastUndo`/top of history: `Undo Grace S in`, disabled when history empty) · `−` toggle (`aria-pressed`) · `Export`. Add `touch-action: manipulation` and `-webkit-tap-highlight-color` so double-tap zoom never fires.
- [ ] **Step 5: Boot.** `const s = runSelfCheck(); if (!s.ok) state.banner = { kind:'err', text:'Codec self-check failed — do not export until this build is fixed.' }`; load; `screen = session.activeGameId ? 'record' : 'paste'`; register the worker: `if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});` render.
- [ ] **Step 6: Build and smoke in a desktop browser** (`node scripts/build.mjs; Start-Process dist\index.html`): paste `ROSTER_VECTOR.encoded`, tap counts, reload, confirm counts persist, test each error string by pasting the stats vector and junk. Run `node --test test/` → PASS.

---

### Task 6: Sheets — score, add-sub, game switcher, menu, confirmations

**Files:**
- Modify: `src/ui.js`, `src/styles.css`

- [ ] **Step 1: Score sheet.** Two `<input type="text" inputmode="numeric" pattern="[0-9]*">` `Us`/`Them` (max 99, per `MAX_SCORE`), `Clear score` → `setScore(..., null)`, `Done` → `setScore(..., [us, them])` (both fields required for Done; otherwise inline "Enter both scores or clear the score").
- [ ] **Step 2: Add-sub sheet.** Name input (`maxlength` not set so the 64 error can show), `Add` → `addSub`; error shown inline verbatim.
- [ ] **Step 3: Game switcher sheet.** Rows per game: `gameLabel`, `${playedSets} set(s)`, `exported HH:MM` when `lastExportedAt`; tapping a row → `setActiveGame` + close. `Delete` per row → confirmation `Delete vs Bears and its stats? This cannot be undone.` → `deleteGame`; if no games remain → paste screen. `+ New game (paste roster)` → paste screen.
- [ ] **Step 4: Menu sheet (`⋯`).** `Add a sub…`, `Clear Set N…` (confirm `Clear every count and the score for Set N?` → `clearSet`), `Delete game…` (same confirm as switcher), `Codec self-check: OK|FAILED`, `v${APP_VERSION}`.
- [ ] **Step 5: Smoke in desktop browser**: add 10 subs to a 2-player game, confirm the 12 cap message; clear a set; delete a game; switch games and confirm counts do not bleed. Run `node --test test/` → PASS.

---

### Task 7: Export screen — copy, share, fallback

**Files:**
- Modify: `src/ui.js`

- [ ] **Step 1: Export screen.** On `Export`: `buildStatsPayload(game, new Date().toISOString())`; error → banner on the recording screen. Success → screen shows `summary`, a read-only `.payload` textarea (`readonly`, `rows=6`), buttons `Copy`, `Share…` (only when `typeof navigator.share === 'function'`), `Back`; and commits `lastExportedAt = nowIso` on the game.
- [ ] **Step 2: Copy:**

```js
async function copyPayload(text, textarea) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
  textarea.focus(); textarea.setSelectionRange(0, textarea.value.length); return false;
}
```

  Status line: `Copied — paste it into the planner's Stats dialog.` or `The clipboard is not available here — select the text and copy it.`
- [ ] **Step 3: Share:** `navigator.share({ title: summary, text }).catch(() => {})` (an `AbortError` on cancel is not an error). Status `Shared.` on resolve.
- [ ] **Step 4: Verify** `decodeStats(text)` of what the screen shows equals the built payload (assert in a small `console.assert`, not shown to the coach). Build; smoke on desktop.

---

### Task 8: Deploy to GitHub Pages and install on the iPhone

**Files:**
- Create: `.gitignore` (nothing to ignore except `node_modules/` if it ever appears), `README.md` section "Install on iPhone" and "Update the app".

**Requires the user** (no `gh` CLI; and commits only on request):

- [ ] **Step 1 (user):** create an empty repo on github.com, e.g. `CoachIQ_Rotation_Planner_Client` (public is simplest for free Pages; the app holds no data, all stats stay on the phone).
- [ ] **Step 2 (Claude, when asked to commit):** `git init`, first commit, `git remote add origin <url>`, `git push -u origin main`, then `git subtree push --prefix dist origin gh-pages`.
- [ ] **Step 3 (user):** GitHub → Settings → Pages → Source "Deploy from a branch" → `gh-pages` / `/ (root)`. URL: `https://<user>.github.io/CoachIQ_Rotation_Planner_Client/`.
- [ ] **Step 4 (user, phone):** open the URL in Safari → Share → **Add to Home Screen**. Launch from the icon (runs standalone, own storage, offline after first load via `sw.js`).
- [ ] **Step 5: Updating:** rebuild, commit, `git subtree push --prefix dist origin gh-pages`; on the phone open the app once while online (the worker fetches network-first); the Menu's version line confirms the new build. Document both in README.

---

### Task 9: On-phone verification checklist (manual)

- [ ] Paste roster from the planner (copy in the planner's Stats dialog, Messages it to the phone, paste) → team/opponent/date/players shown.
- [ ] 12-row roster: every button hit reliably with a thumb; no double-tap zoom; no rubber-band scroll of the whole page.
- [ ] Tap, lock the phone 60 s, unlock → counts intact. Background the app, open five other apps, return → intact. Kill the app, relaunch → intact and on the same game/set.
- [ ] "−" mode subtracts exactly once then turns off; Undo reverses the last tap and shows what it undid.
- [ ] Second game in the same session; switch back and forth; counts never bleed.
- [ ] Export → Share → Mail to self → paste into the planner's Stats dialog → import preview shows the right sets/scores/guests. Re-export after editing → planner shows "This replaces the stats already stored".
- [ ] Paste the stats string into the roster box → "This is a stats payload, not a roster payload."
- [ ] Airplane mode → launch from Home Screen → app opens (worker cache).

---

## Verification (end to end)

1. `node --test test/` — all codec, session and build tests pass.
2. `node scripts/build.mjs` — `dist/index.html` + `dist/sw.js`; open `dist/index.html` locally and confirm the Menu says `Codec self-check: OK`.
3. Golden vector: in the built app, open the roster vector, record Grace 8/2 5/1, Ava (sub, id override not available in UI — the unit test covers byte-exactness; in the UI confirm `decodeStats` of the export equals the expected object).
4. Task 9 checklist on the phone.

## Self-review against PROMPT.md requirements

1 single file → Task 2 · 2 paste+decode+errors → Task 5 · 3 four counters 0–999 → Tasks 4–5 · 4 ≤12 and `cx-` subs → Task 4/6 · 5 sets and scores, omitted when not played → Task 4/6 · 6 export, copy, share → Task 7 · 7 multiple games keyed by gameId → Task 4/6 · 8 survives backgrounding/reload/lock → Task 5 + Home Screen delivery · 9 mockup in `docs/` opened for review → Task 1 · 10 golden-vector self-check → Tasks 3–4. Undo and destructive confirmations → Tasks 5–6. Versioned storage envelope → Task 4. Codec copied verbatim, strict roster decode → Task 3.
