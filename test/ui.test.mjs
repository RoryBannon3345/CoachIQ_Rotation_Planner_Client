// ui.test.mjs — drives the real src/ui.js (not a stand-in) through the fake DOM in
// test/helpers/fake-dom.mjs. This is the one place ui.js's own logic is exercised outside a
// real browser (scripts/verify-build.mjs is the other, but that needs Edge/Chrome).
//
// Exists to cover finding 1 of the stats-contract-v2 final review: `lastExportedAt` must be
// stamped only once the export payload genuinely leaves the device (a real clipboard/share
// success), never merely because the export screen was rendered. That field is
// `hasUnexportedStats`'s only safety net for the replace-day/new-day confirmations, so getting
// the stamping point wrong silently disarms the one warning that stops a coach from overwriting
// a day's recorded counts.
//
// Each test imports ui.js fresh with a cache-busting query string, because ui.js keeps its
// `state` as module-scoped, mutable, singleton state and calls `boot()` as a side effect of
// being imported — a second `import '../src/ui.js'` in the same process would resolve to the
// already-booted module instead of a clean one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeDayRoster } from '../src/codec.js';
import { parseSession, STORAGE_KEY, newDayFromRoster, serialiseSession, getCount, tap, setServedFirst, tapPoint, setScore, APP_VERSION, AUTHOR_NAME, COPYRIGHT_YEAR } from '../src/session.js';
import { createFakeDom, flushAsync } from './helpers/fake-dom.mjs';

let caseId = 0;

function freshEnv() {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
  };
  const { document, appEl } = createFakeDom();
  const navigatorObj = {};
  // Node has its own read-only global `navigator` (and, on some versions, `location`) — a plain
  // `globalThis.navigator = ...` throws against that getter, so redefine the property outright.
  for (const [key, value] of [
    ['document', document],
    ['localStorage', localStorage],
    ['navigator', navigatorObj],
    ['location', { protocol: 'file:' }],
  ]) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return { store, document, appEl, navigatorObj };
}

async function bootUi() {
  caseId += 1;
  // The query string busts Node's ES module cache so each test gets a fresh module instance
  // (fresh `state`, a fresh `boot()` run) without a real second copy of the file on disk.
  await import(`../src/ui.js?case=${caseId}`);
}

const ROSTER_TEXT = encodeDayRoster({
  v: 3,
  kind: 'roster',
  date: '2026-09-19',
  team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace' }],
  games: [{ gameId: 'g1', opponent: 'Lions', sets: [1] }], // mask 1 = index 0 = grace, one set
});

function click(document, selector) {
  const [el] = document.querySelectorAll(selector);
  assert.ok(el, `expected an element matching ${selector}`);
  el.click();
  return el;
}

/** Boots a fresh ui.js instance pre-loaded with `session` (already the internal day/session shape —
 * e.g. straight from `newDayFromRoster`, not an encoded payload) written into fake localStorage
 * under STORAGE_KEY, so boot()'s own load() reads it back exactly as given. */
async function bootWithSession(session) {
  const env = freshEnv();
  env.store.set(STORAGE_KEY, serialiseSession(session));
  await bootUi();
  return env;
}

/** Switches to `gameId` and, if given, selects set `n`, entirely through the same clicks a coach
 * would use — ui.js has no exports to reach into, and none are being added for this. */
function switchToGameAndSet(document, gameId, n) {
  click(document, '[data-action="open-switcher"]');
  click(document, `[data-action="switch-game"][data-gid="${gameId}"]`);
  if (n !== undefined) click(document, `[data-action="select-set"][data-n="${n}"]`);
}

/** Drives the record screen for one game (and, optionally, one of its sets) of a pre-built day and
 * returns the rendered HTML. Used by the setCount/tick-list tests, which build `day` directly via
 * `newDayFromRoster` rather than round-tripping through an encoded payload. */
async function renderWith(day, gameId, n) {
  const { document } = await bootWithSession(day);
  switchToGameAndSet(document, gameId, n);
  return document.getElementById('app').innerHTML;
}

/** Same, but also opens the players sheet — via the menu, which (unlike the empty-state's own
 * "Tick players…" button) is reachable whether or not the target set's tick list is empty — and
 * returns the combined record-screen-plus-sheet HTML. */
async function renderPlayersSheetWith(day, gameId, n) {
  const { document } = await bootWithSession(day);
  switchToGameAndSet(document, gameId, n);
  click(document, '[data-action="open-menu"]');
  click(document, '[data-action="open-players"]');
  return document.getElementById('app').innerHTML;
}

/** Pastes ROSTER_TEXT, opens the day, and taps one count so the day has a played (unexported) set. */
function openDayAndRecordACount(document) {
  const pasteText = document.getElementById('pasteText');
  pasteText.value = ROSTER_TEXT;
  click(document, '[data-action="open-roster"]');
  click(document, '[data-action="tap-count"][data-pid="grace"][data-stat="serve"][data-side="in"]');
}

function savedLastExportedAt(store) {
  const raw = store.get(STORAGE_KEY);
  assert.ok(raw, 'a session was committed to STORAGE_KEY');
  const parsed = parseSession(raw);
  assert.equal(parsed.ok, true, 'the committed session parses back cleanly');
  return parsed.value.lastExportedAt;
}

test('opening the export screen does not stamp lastExportedAt', async () => {
  const { store, document } = freshEnv();
  await bootUi();
  openDayAndRecordACount(document);

  click(document, '[data-action="export"]');

  assert.equal(document.querySelectorAll('[data-action="export-copy"]').length, 1, 'reached the export screen');
  assert.equal(savedLastExportedAt(store), null, 'lastExportedAt must stay null until the payload actually leaves the device');
});

test('a failed clipboard copy leaves lastExportedAt unset and shows the fallback banner (finding 1 regression)', async () => {
  const { store, document, navigatorObj } = freshEnv();
  // No navigator.clipboard at all -- copyPayload's real-world fallback path.
  navigatorObj.clipboard = undefined;
  await bootUi();
  openDayAndRecordACount(document);
  click(document, '[data-action="export"]');

  click(document, '[data-action="export-copy"]');
  await flushAsync();

  assert.equal(savedLastExportedAt(store), null, 'a failed copy must not stamp lastExportedAt');
  assert.ok(
    document.getElementById('app').innerHTML.includes('The clipboard is not available here'),
    'the fallback banner is shown'
  );
});

test('a successful clipboard copy stamps lastExportedAt', async () => {
  const { store, document, navigatorObj } = freshEnv();
  navigatorObj.clipboard = { writeText: async () => {} };
  await bootUi();
  openDayAndRecordACount(document);
  click(document, '[data-action="export"]');

  assert.equal(savedLastExportedAt(store), null, 'still unstamped right after opening the export screen');

  click(document, '[data-action="export-copy"]');
  await flushAsync();

  const stamped = savedLastExportedAt(store);
  assert.ok(typeof stamped === 'string' && stamped.length > 0, 'a genuinely successful copy stamps lastExportedAt');
  assert.ok(document.getElementById('app').innerHTML.includes('Copied'), 'the success banner is shown');
});

test('a successful share stamps lastExportedAt', async () => {
  const { store, document, navigatorObj } = freshEnv();
  navigatorObj.share = async () => {};
  await bootUi();
  openDayAndRecordACount(document);
  click(document, '[data-action="export"]');

  click(document, '[data-action="export-share"]');
  await flushAsync();

  const stamped = savedLastExportedAt(store);
  assert.ok(typeof stamped === 'string' && stamped.length > 0, 'a genuinely successful share stamps lastExportedAt');
});

// iOS Mail never fills its subject from a web share -- neither the app url nor a named .txt file
// did it on a real iPhone. So the payload goes as plain text the coach can paste straight into the
// planner, titled for any target that uses a title, and the app URL never rides along.
test('the share sends the payload as text, titled for the day, with no url and no file', async () => {
  const { document, navigatorObj } = freshEnv();
  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'https:', href: 'https://example.test/stats/' },
    configurable: true,
    writable: true,
  });
  let shared = null;
  navigatorObj.canShare = () => true;
  navigatorObj.share = async (data) => {
    shared = data;
  };
  await bootUi();
  openDayAndRecordACount(document);
  click(document, '[data-action="export"]');
  const payloadText = document.getElementById('exportPayload').value;

  click(document, '[data-action="export-share"]');
  await flushAsync();

  assert.ok(shared, 'navigator.share was called');
  assert.deepEqual(Object.keys(shared).sort(), ['text', 'title'], 'only a title and the payload are shared');
  assert.equal(shared.title, 'CoachIQ stats · Thunder · 19 Sep', 'the title names the app, team and day');
  assert.equal(shared.text, payloadText, 'the text is exactly the exported payload');
});

test('the export screen shows the save-failed banner (finding 6)', async () => {
  const { document } = freshEnv();
  await bootUi();
  openDayAndRecordACount(document);

  // Force the next commit() to see a throwing localStorage, so state.saveFailed flips to true --
  // exactly the state that must surface on the export screen (it did not, before finding 6's fix).
  globalThis.localStorage.setItem = () => {
    throw new Error('storage full');
  };
  click(document, '[data-action="tap-count"][data-pid="grace"][data-stat="serve"][data-side="out"]');

  click(document, '[data-action="export"]');

  assert.ok(
    document.getElementById('app').innerHTML.includes('Could not save — export your stats now.'),
    'the save-failed banner reaches the export screen'
  );
});

// ---------------------------------------------------------------------------------------------
// Contract v3 — setCount tabs and per-set tick lists (Task 5)
// ---------------------------------------------------------------------------------------------

test('the set bar shows exactly sets.length tabs, per game', async () => {
  const day = newDayFromRoster({
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }, { id: 'zoie', name: 'Zoë' }],
    games: [
      { gameId: 'game-1', opponent: 'Lions', sets: [3, 1, 2] },
      { gameId: 'game-2', opponent: 'Falcons', sets: [2, 0] },
    ],
  }, '2026-09-19T09:00:00Z');

  const html1 = await renderWith(day, 'game-1');
  assert.equal((html1.match(/data-action="select-set"/g) || []).length, 3);
  assert.match(html1, /data-n="3"/);
  assert.doesNotMatch(html1, /data-n="4"/, 'no phantom fourth tab');

  const html2 = await renderWith(day, 'game-2');
  assert.equal((html2.match(/data-action="select-set"/g) || []).length, 2, 'same day, different count');
});

test('each set shows its own rows, and mask 0 offers the sheet rather than an error', async () => {
  const day = newDayFromRoster({
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }, { id: 'zoie', name: 'Zoë' }],
    games: [{ gameId: 'game-2', opponent: 'Falcons', sets: [2, 0] }],
  }, '2026-09-19T09:00:00Z');

  const set1 = await renderWith(day, 'game-2', 1);
  assert.match(set1, /Zoë/);
  assert.doesNotMatch(set1, /Grace/);

  const set2 = await renderWith(day, 'game-2', 2);
  assert.match(set2, /No players ticked for this set yet/);
  assert.doesNotMatch(set2, /malformed|error|Error/);
});

test('the players sheet shows the whole directory, pre-ticked from that set only', async () => {
  const day = newDayFromRoster({
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }, { id: 'zoie', name: 'Zoë' }],
    games: [{ gameId: 'game-1', opponent: 'Lions', sets: [3, 1, 2] }],
  }, '2026-09-19T09:00:00Z');

  const sheet = await renderPlayersSheetWith(day, 'game-1', 2);
  // Pre-selection, not a whitelist: Zoë is absent from set 2's mask but must still be tickable.
  assert.match(sheet, /Grace/);
  assert.match(sheet, /Zoë/);
  assert.equal((sheet.match(/data-action="toggle-tick"/g) || []).length, 2);
  assert.equal((sheet.match(/checkbox" tabindex="-1" checked/g) || []).length, 1, 'only Grace pre-ticked');
  assert.match(sheet, /Set 2 · tick who is playing this set/);
});

// Regression: a same-day merge (mergeDayRoster) can shrink a game's setCount while leaving
// activeSet parked on a now-hidden later tab — it only ever grows setCount to cover recorded data
// and never touches activeSet. The record screen clamps its own display to the visible set, but a
// tap must write into that SAME clamped set, not into the raw (possibly out-of-range) activeSet
// slot — otherwise the coach sees a set-3 row, taps it, and the count silently lands in set 5's
// hidden data instead, corrupting what buildDayStatsPayload later exports.
test('a tap lands in the set actually shown, not a hidden slot beyond a shrunk setCount', async () => {
  let day = newDayFromRoster({
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }],
    games: [{ gameId: 'game-1', opponent: 'Lions', sets: [1, 1, 1, 1, 1] }], // grace named in all 5
  }, '2026-09-19T09:00:00Z');
  // Simulate exactly what mergeDayRoster can leave behind, without going through the merge itself:
  // setCount shrunk to 3, activeSet still parked on 5.
  day = {
    ...day,
    games: day.games.map((g) => (g.gameId === 'game-1' ? { ...g, setCount: 3, activeSet: 5 } : g)),
  };

  const { store, document } = await bootWithSession(day);

  // The record screen must clamp its display to set 3 — exactly 3 tabs, none of them set 5.
  const html = document.getElementById('app').innerHTML;
  assert.equal((html.match(/data-action="select-set"/g) || []).length, 3);
  assert.doesNotMatch(html, /data-n="5"/);

  click(document, '[data-action="tap-count"][data-pid="grace"][data-stat="serve"][data-side="in"]');

  const saved = parseSession(store.get(STORAGE_KEY));
  assert.equal(saved.ok, true, 'the committed session parses back cleanly');
  const game = saved.value.games.find((g) => g.gameId === 'game-1');
  assert.equal(getCount(game, 3, 'grace').serve.in, 1, 'the tap must land in the set the coach can see');
  assert.equal(getCount(game, 5, 'grace').serve.in, 0, 'and never in the hidden slot beyond setCount');
});

// Regression: parseSession only ever reported `droppedDays` on the schema-1 leg, so `load()`'s old
// `migrated = parsed.droppedDays !== undefined` check missed a schema-2 save that migrated cleanly
// (nothing salvage-dropped). Boot never re-committed it, so every single boot re-ran migrateSchema2
// against the same stale schema-2 envelope on disk until the coach's first tap or tick happened to
// trigger a save. The fix widens the flag to any envelope read below the current SESSION_SCHEMA.
test('a clean schema-2 save (nothing dropped) is still re-committed at schema 4 on the very first boot', async () => {
  const env = freshEnv();
  const schema2 = JSON.stringify({
    schema: 2, savedAt: '2026-09-19T20:00:00Z',
    session: {
      date: '2026-09-19', team: 'Thunder',
      players: [{ id: 'grace', name: 'Grace', sub: false }],
      games: [{
        gameId: 'game-1', opponent: 'Lions', playerIds: ['grace'],
        sets: [null, null, null, null, null], activeSet: 1, history: [],
      }],
      activeGameId: 'game-1', importedAt: '2026-09-19T09:00:00Z', lastExportedAt: null, lastChangedAt: null,
    },
  });
  env.store.set(STORAGE_KEY, schema2);
  await bootUi();

  const raw = env.store.get(STORAGE_KEY);
  assert.ok(raw, 'a session is on disk after boot');
  assert.equal(JSON.parse(raw).schema, 4, 'the schema-2 envelope was re-committed at the current schema on first boot');
  // Nothing was actually unreadable, so no "could not be read" banner should show.
  assert.doesNotMatch(env.document.getElementById('app').innerHTML, /could not be read/);
});

test('the set bar asks who serves first on a fresh set, shows the live score once answered, and the typed score on an unlogged scored set', async () => {
  const roster = { v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder', players: [{ id: 'grace', name: 'Grace' }], games: [{ gameId: 'g1', opponent: 'Lions', sets: [1, 1] }] };
  let day = newDayFromRoster(roster, '2026-09-19T09:00:00Z');
  let html = await renderWith(day, 'g1');
  assert.match(html, /data-action="serve-first" data-us="1"[^>]*>We serve<small>first<\/small>/);
  assert.match(html, /data-action="serve-first" data-us="0"/);
  assert.doesNotMatch(html, /data-action="open-score"/, 'the score button is gone from the bar');

  day = setServedFirst(day, 'g1', 1, true);
  day = tapPoint(day, 'g1', 1, 'U'); day = tapPoint(day, 'g1', 1, 'U'); day = tapPoint(day, 'g1', 1, 'T');
  html = await renderWith(day, 'g1');
  assert.match(html, /data-action="tap-point" data-winner="U"[^>]*>Us <span class="big">2<\/span>/);
  assert.match(html, /data-action="tap-point" data-winner="T"[^>]*><span class="big">1<\/span> Them/);
  assert.match(html, /↶ Undo point Them/);

  day = setScore(newDayFromRoster(roster, '2026-09-19T09:00:00Z'), 'g1', 1, [25, 21]);
  html = await renderWith(day, 'g1');
  assert.match(html, /data-action="open-score"[^>]*>25–21<small>typed<\/small>/);
  assert.doesNotMatch(html, /data-action="tap-point"/);

  // Answered, then a typed score: the typed score shows and Us/Them are not offered.
  day = setScore(setServedFirst(newDayFromRoster(roster, '2026-09-19T09:00:00Z'), 'g1', 1, true), 'g1', 1, [25, 21]);
  html = await renderWith(day, 'g1');
  assert.match(html, /data-action="open-score"[^>]*>25–21<small>typed<\/small>/);
  assert.doesNotMatch(html, /data-action="tap-point"/);
});

test('tapping Us records a rally and stamps lastChangedAt; minus mode is not consumed', async () => {
  const { store, document } = freshEnv();
  const day = setServedFirst(newDayFromRoster({ v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder', players: [{ id: 'grace', name: 'Grace' }], games: [{ gameId: 'g1', opponent: 'Lions', sets: [1] }] }, '2026-09-19T09:00:00Z'), 'g1', 1, true);
  store.set(STORAGE_KEY, serialiseSession(day));
  await bootUi();
  click(document, '[data-action="toggle-minus"]');
  click(document, '[data-action="tap-point"][data-winner="U"]');
  const saved = parseSession(store.get(STORAGE_KEY)).value;
  assert.equal(saved.games[0].sets[0].points, 'U');
  assert.ok(saved.lastChangedAt);
  assert.match(document.getElementById('app').innerHTML, /aria-pressed="true"/, 'minus mode still armed');
});

test('the menu offers the serve-first flip and Clear points only for a logged set, and Set score only for an unlogged one', async () => {
  const roster = { v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder', players: [{ id: 'grace', name: 'Grace' }], games: [{ gameId: 'g1', opponent: 'Lions', sets: [1] }] };
  let day = newDayFromRoster(roster, '2026-09-19T09:00:00Z');
  const { store, document } = freshEnv();
  store.set(STORAGE_KEY, serialiseSession(day));
  await bootUi();
  click(document, '[data-action="open-menu"]');
  let html = document.getElementById('app').innerHTML;
  assert.match(html, /data-action="open-score"[^>]*>Set score…/);
  assert.doesNotMatch(html, /menu-clear-points/);
  assert.doesNotMatch(html, /menu-flip-serve-first/);

  day = tapPoint(setServedFirst(day, 'g1', 1, true), 'g1', 1, 'U');
  const env2 = freshEnv();
  env2.store.set(STORAGE_KEY, serialiseSession(day));
  await bootUi();
  click(env2.document, '[data-action="open-menu"]');
  html = env2.document.getElementById('app').innerHTML;
  assert.match(html, /data-action="menu-flip-serve-first"[^>]*>We served first ✓/);
  assert.match(html, /data-action="menu-clear-points"[^>]*>Clear points for Set 1…/);
  assert.doesNotMatch(html, /Set score…/);
  assert.equal(parseSession(env2.store.get(STORAGE_KEY)).value.lastChangedAt, null, 'seeded with no change stamp');
  click(env2.document, '[data-action="menu-flip-serve-first"]');
  const afterFlip = parseSession(env2.store.get(STORAGE_KEY)).value;
  assert.equal(afterFlip.games[0].sets[0].servedFirst, false);
  assert.match(afterFlip.lastChangedAt, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/, 'the flip stamps lastChangedAt');
  await new Promise((r) => setTimeout(r, 15));
  click(env2.document, '[data-action="open-menu"]');
  click(env2.document, '[data-action="menu-clear-points"]');
  click(env2.document, '[data-action="confirm-clear-points"]');
  const afterClear = parseSession(env2.store.get(STORAGE_KEY)).value;
  assert.equal(afterClear.games[0].sets[0].points, '');
  assert.notEqual(afterClear.lastChangedAt, afterFlip.lastChangedAt, 'clearing the points stamps lastChangedAt again');
});

test('the export screen names the rally count of a logged set', async () => {
  const roster = { v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder', players: [{ id: 'grace', name: 'Grace' }], games: [{ gameId: 'g1', opponent: 'Lions', sets: [1] }] };
  let day = setServedFirst(newDayFromRoster(roster, '2026-09-19T09:00:00Z'), 'g1', 1, true);
  for (const c of 'UUT') day = tapPoint(day, 'g1', 1, c);
  const { store, document } = freshEnv();
  store.set(STORAGE_KEY, serialiseSession(day));
  await bootUi();
  click(document, '[data-action="export"]');
  assert.match(document.getElementById('app').innerHTML, /Set 1 2–1 · 3 rallies/);
});

test('a tap on Us within 300ms of answering serve-first is ignored; a later one counts', async () => {
  const roster = { v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder', players: [{ id: 'grace', name: 'Grace' }], games: [{ gameId: 'g1', opponent: 'Lions', sets: [1] }] };
  const { store, document } = freshEnv();
  store.set(STORAGE_KEY, serialiseSession(newDayFromRoster(roster, '2026-09-19T09:00:00Z')));
  await bootUi();
  click(document, '[data-action="serve-first"][data-us="1"]');
  click(document, '[data-action="tap-point"][data-winner="U"]');
  assert.equal(parseSession(store.get(STORAGE_KEY)).value.games[0].sets[0].points, '', 'swallowed as a double tap');
  await new Promise((r) => setTimeout(r, 350));
  click(document, '[data-action="tap-point"][data-winner="U"]');
  assert.equal(parseSession(store.get(STORAGE_KEY)).value.games[0].sets[0].points, 'U');
});
test('the point buttons announce the running count', async () => {
  let day = setServedFirst(newDayFromRoster({ v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder', players: [{ id: 'grace', name: 'Grace' }], games: [{ gameId: 'g1', opponent: 'Lions', sets: [1] }] }, '2026-09-19T09:00:00Z'), 'g1', 1, true);
  day = tapPoint(day, 'g1', 1, 'U');
  const html = await renderWith(day, 'g1');
  assert.match(html, /aria-label="Us scored, 1"/);
  assert.match(html, /aria-label="Them scored, 0"/);
});
test('a clean schema-3 save is re-committed at schema 4 on the very first boot, nothing dropped', async () => {
  const env = freshEnv();
  const schema3 = JSON.stringify({
    schema: 3, savedAt: '2026-09-19T20:00:00Z',
    session: {
      date: '2026-09-19', team: 'Thunder',
      players: [{ id: 'grace', name: 'Grace', sub: false }],
      games: [{
        gameId: 'game-1', opponent: 'Lions', setCount: 1, setPlayerIds: [['grace'], [], [], [], []],
        sets: [{ score: [25, 20], counts: { grace: { serve: { in: 1, out: 0 }, return: { in: 0, out: 0 } } } }, null, null, null, null],
        activeSet: 1, history: [{ n: 1, playerId: 'grace', stat: 'serve', side: 'in', delta: 1 }],
      }],
      activeGameId: 'game-1', importedAt: '2026-09-19T09:00:00Z', lastExportedAt: null, lastChangedAt: null,
    },
  });
  env.store.set(STORAGE_KEY, schema3);
  await bootUi();

  const raw = env.store.get(STORAGE_KEY);
  assert.ok(raw, 'a session is on disk after boot');
  const saved = JSON.parse(raw);
  assert.equal(saved.schema, 4, 'the schema-3 envelope was re-committed at the current schema on first boot');
  const game = saved.session.games[0];
  assert.equal(game.sets[0].servedFirst, null);
  assert.equal(game.sets[0].points, '');
  assert.deepEqual(game.sets[0].score, [25, 20]);
  assert.equal(game.history[0].kind, 'count');
  assert.equal(game.history.length, 1);
  assert.doesNotMatch(env.document.getElementById('app').innerHTML, /set aside/);
});

// The copyright lives on the paste screen only (docs/copyright-mockup.html, option 6). The record
// screen has no height to spare (scripts/verify-density.mjs), so these pin both halves.
const COPYRIGHT = '© 2026 Rory Bannon. All rights reserved.';

test('the first-launch paste screen shows the brand card: name, live version, copyright', async () => {
  const { document } = freshEnv();
  await bootUi();
  const html = document.getElementById('app').innerHTML;
  assert.match(html, /class="brandcard"/);
  assert.ok(html.includes('CoachIQ Stats'), 'app name');
  assert.ok(html.includes(`Version ${APP_VERSION}`), 'version follows APP_VERSION');
  assert.ok(html.includes(COPYRIGHT), 'exact copyright wording');
  assert.equal(`© ${COPYRIGHT_YEAR} ${AUTHOR_NAME}. All rights reserved.`, COPYRIGHT, 'constants spell the same line');
});

test('the paste-again screen shows the brand card too', async () => {
  const day = newDayFromRoster({
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }],
    games: [{ gameId: 'g1', opponent: 'Lions', sets: [1] }],
  }, '2026-09-19T09:00:00Z');
  const { document } = await bootWithSession(day);
  click(document, '[data-action="open-switcher"]');
  click(document, '[data-action="switcher-paste-new-day"]');
  const html = document.getElementById('app').innerHTML;
  assert.match(html, /data-action="cancel-paste"/, 'this is the mid-day paste screen');
  assert.ok(html.includes(COPYRIGHT));
});

test('the record screen shows no brand card', async () => {
  const day = newDayFromRoster({
    v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
    players: [{ id: 'grace', name: 'Grace' }],
    games: [{ gameId: 'g1', opponent: 'Lions', sets: [1] }],
  }, '2026-09-19T09:00:00Z');
  const { document } = await bootWithSession(day);
  const html = document.getElementById('app').innerHTML;
  assert.match(html, /data-action="tap-count"/, 'this is the record screen');
  assert.doesNotMatch(html, /brandcard/);
  assert.ok(!html.includes('©'), 'no copyright on the record screen');
});

const ONE_SET = { v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder', players: [{ id: 'grace', name: 'Grace' }], games: [{ gameId: 'g1', opponent: 'Lions', sets: [1] }] };

test('a stat tap that scores shows a toast naming why, and Undo names the letters', async () => {
  const { document } = await bootWithSession(newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z'));
  click(document, '[data-action="tap-count"][data-pid="grace"][data-stat="serve"][data-side="in"]');
  let html = document.getElementById('app').innerHTML;
  assert.doesNotMatch(html, /class="toast"/, 'the first tap only answers serve-first');
  click(document, '[data-action="tap-count"][data-pid="grace"][data-stat="serve"][data-side="out"]');
  html = document.getElementById('app').innerHTML;
  assert.match(html, /<div class="toast" role="status" aria-live="polite">Us \+1 · we serve, then Them \+1 · Serve out<\/div>/);
  assert.match(html, /↶ Undo Grace S out \+ Us, Them/);
  click(document, '[data-action="toggle-minus"]');
  assert.doesNotMatch(document.getElementById('app').innerHTML, /class="toast"/, 'the next action of any kind clears it');
});

test('the serving side gets the dot, the other pair of columns goes idle, and an open rally dashes both pills', async () => {
  let day = newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z');
  day = tap(day, 'g1', 1, 'grace', 'serve', 'in', 1); // we serve, rally open
  let html = await renderWith(day, 'g1');
  assert.match(html, /class="pt us serving open" data-action="tap-point" data-winner="U" data-serving="1" data-open="1" aria-label="Us scored, 0"/);
  assert.match(html, /class="pt them open" data-action="tap-point" data-winner="T" data-open="1" aria-label="Them scored, 0"/);
  assert.match(html, /class="cnt in idle"[^>]*data-stat="return" data-side="in"/);
  assert.match(html, /class="cnt in"[^>]*data-stat="serve" data-side="in"/);
  assert.match(html, /<span class="idle">Return In<\/span>/);

  day = tap(day, 'g1', 1, 'grace', 'return', 'out', 1); // rally to Them, then the Out: they serve, nothing open
  html = await renderWith(day, 'g1');
  assert.match(html, /class="pt them serving" data-action="tap-point" data-winner="T" data-serving="1" aria-label="Them scored, 2"/);
  assert.doesNotMatch(html, /data-open="1"/);
  assert.match(html, /class="cnt out idle"[^>]*data-stat="serve" data-side="out"/);
});

test('a typed-score set shows no dot, no idle columns and no toast', async () => {
  let day = setScore(newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z'), 'g1', 1, [25, 21]);
  day = tap(day, 'g1', 1, 'grace', 'serve', 'out', 1);
  const html = await renderWith(day, 'g1');
  assert.doesNotMatch(html, /idle|data-serving|data-open|class="toast"/);
});

test('a minus that cancels the open rally says so, and the pills stop looking open', async () => {
  let day = newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z');
  day = tap(day, 'g1', 1, 'grace', 'serve', 'in', 1); // rally open
  const { document } = await bootWithSession(day);
  click(document, '[data-action="toggle-minus"]');
  click(document, '[data-action="tap-count"][data-pid="grace"][data-stat="serve"][data-side="in"]');
  const html = document.getElementById('app').innerHTML;
  assert.match(html, /<div class="toast" role="status" aria-live="polite">Open rally cancelled<\/div>/);
  assert.doesNotMatch(html, /data-open="1"/);
});

test('a logged set offers Type the final score…; the sheet replaces the log with the typed score', async () => {
  let day = newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z');
  day = tap(day, 'g1', 1, 'grace', 'serve', 'in', 1);
  day = tap(day, 'g1', 1, 'grace', 'serve', 'out', 1); // log UT
  const { store, document } = await bootWithSession(day);
  click(document, '[data-action="open-menu"]');
  let html = document.getElementById('app').innerHTML;
  assert.match(html, /data-action="open-score">Type the final score…<\/button><\/li>\s*<li><button type="button" data-action="menu-clear-points"/);
  click(document, '[data-action="open-score"]');
  html = document.getElementById('app').innerHTML;
  assert.match(html, /Replaces the rally log \(Us 1 – 1 Them, 2 rallies\) with the score you type\. Serve and return counts stay\. Undo can&#39;t bring the log back\./);
  assert.match(html, /id="scoreUs"[^>]*value="1"/);
  assert.match(html, /id="scoreThem"[^>]*value="1"/);
  assert.match(html, /<button type="button" class="btn" data-action="close-sheet">Cancel<\/button>/);
  assert.match(html, /<button type="button" class="btn danger" data-action="score-done">Replace log<\/button>/);
  assert.doesNotMatch(html, /score-clear/);
  click(document, '[data-action="score-done"]');
  const saved = parseSession(store.get(STORAGE_KEY)).value.games[0].sets[0];
  assert.deepEqual([saved.score, saved.points, saved.servedFirst, saved.pending], [[1, 1], '', null, null]);
  assert.equal(saved.counts.grace.serve.out, 1);
});

test('a one-rally log says "1 rally"; an unlogged set keeps the old score sheet', async () => {
  let day = newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z');
  day = tap(day, 'g1', 1, 'grace', 'serve', 'out', 1); // log T
  let env = await bootWithSession(day);
  click(env.document, '[data-action="open-menu"]');
  click(env.document, '[data-action="open-score"]');
  assert.match(env.document.getElementById('app').innerHTML, /\(Us 0 – 1 Them, 1 rally\)/);

  env = await bootWithSession(newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z'));
  click(env.document, '[data-action="open-menu"]');
  click(env.document, '[data-action="open-score"]');
  const html = env.document.getElementById('app').innerHTML;
  assert.match(html, /Enter the final score once the set is over\./);
  assert.match(html, /data-action="score-clear">Clear score<\/button>/);
  assert.match(html, /data-action="score-done">Done<\/button>/);
  assert.doesNotMatch(html, /Replace log/);
});

test('the replace sheet asks for both scores without offering to clear one', async () => {
  let day = newDayFromRoster(ONE_SET, '2026-09-19T09:00:00Z');
  day = tap(day, 'g1', 1, 'grace', 'serve', 'out', 1); // log T
  const { document } = await bootWithSession(day);
  click(document, '[data-action="open-menu"]');
  click(document, '[data-action="open-score"]');
  document.getElementById('scoreUs').value = '';
  click(document, '[data-action="score-done"]');
  const html = document.getElementById('app').innerHTML;
  assert.match(html, /<span>Enter both scores<\/span>/);
  assert.doesNotMatch(html, /or clear the score/);
});
