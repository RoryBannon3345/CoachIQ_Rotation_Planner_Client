/**
 * The Client's browser-test fixtures: the shipped file over `file://`, localStorage seeded before the
 * app runs, any page error or `console.error` a failure, and `press` that taps on touch devices.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { encodeDayRoster } from '../../src/codec.js';

export { expect };

export const APP_PATH = fileURLToPath(new URL('../../dist/CoachIQ_Rotation_Planner_Client.html', import.meta.url));
export const APP_URL = pathToFileURL(APP_PATH).href;
export const STORAGE_KEY = 'coachiq-stats-client';

/** A valid contract-6 day roster: Thunder on 2026-09-19, three players, one game vs Lions with two
 *  sets and no planned serve order. */
export function rosterPayload(overrides = {}) {
  return {
    v: 6,
    kind: 'roster',
    date: '2026-09-19',
    team: 'Thunder',
    players: [
      { id: 'grace', name: 'Grace', jersey: 7 },
      { id: 'zoie', name: 'Zoë' },
      { id: 'lily', name: 'Lily' },
    ],
    games: [{ gameId: 'game-1', opponent: 'Lions', sets: [7, 3], serve: [null, null] }],
    ...overrides,
  };
}

/** The same day with a plan for set 1 — Grace, Zoë, Lily, Grace, Zoë, Lily — and Ava ticked for
 *  set 1 but in no plan, so she can only stand in. Set 2 has no plan. */
export function plannedPayload() {
  return rosterPayload({
    players: [
      { id: 'grace', name: 'Grace', jersey: 7 },
      { id: 'zoie', name: 'Zoë' },
      { id: 'lily', name: 'Lily' },
      { id: 'ava', name: 'Ava' },
    ],
    games: [{ gameId: 'game-1', opponent: 'Lions', sets: [15, 3], serve: ['012012', null] }],
  });
}

/** Encodes a day roster at contract 6. A game given without `serve` gets no plan (one null per set),
 *  so a test that does not care about the serve order need not spell it out. */
export function rosterText(payload = rosterPayload()) {
  return encodeDayRoster({ ...payload, games: payload.games.map((g) => (g.serve === undefined ? { ...g, serve: g.sets.map(() => null) } : g)) });
}

export async function openDay(page, text) {
  await page.locator('#pasteText').fill(text);
  await page.locator('[data-action="open-roster"]').click();
}

function installPageHooks(storage) {
  if (sessionStorage.getItem('__e2eSeeded') === null) {
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
    sessionStorage.setItem('__e2eSeeded', '1');
  }
}

export function guardPage(page, allowed) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  return () => errors.filter((e) => !allowed.some((pattern) => pattern.test(e)));
}

export const test = base.extend({
  consoleAllowed: async ({}, use) => {
    await use([]);
  },
  consoleGuard: [
    async ({ page, consoleAllowed }, use) => {
      const unexpected = guardPage(page, consoleAllowed);
      await use();
      expect(unexpected(), 'errors logged by the page').toEqual([]);
    },
    { auto: true },
  ],
  allowConsoleError: async ({ consoleAllowed }, use) => {
    await use((pattern) => consoleAllowed.push(pattern));
  },
  openApp: async ({ page }, use) => {
    await use(async ({ storage = {} } = {}) => {
      if (!existsSync(APP_PATH)) throw new Error(`No build at ${APP_PATH} — run \`npm run build\` first.`);
      await page.addInitScript(installPageHooks, storage);
      await page.goto(APP_URL);
      await expect(page.locator('#app')).not.toBeEmpty();
    });
  },
  press: async ({}, use, testInfo) => {
    const touch = Boolean(testInfo.project.use.hasTouch);
    await use((locator) => (touch ? locator.tap() : locator.click()));
  },
});
