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
import { parseSession, STORAGE_KEY } from '../src/session.js';
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
  v: 2,
  kind: 'roster',
  date: '2026-09-19',
  team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace' }],
  games: [{ gameId: 'g1', opponent: 'Lions', roster: [0] }],
});

function click(document, selector) {
  const [el] = document.querySelectorAll(selector);
  assert.ok(el, `expected an element matching ${selector}`);
  el.click();
  return el;
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
