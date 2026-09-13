/**
 * Proves the hardened build behaves exactly like the readable one.
 *
 * Builds both, loads each in headless Edge, drives the app through a real
 * session, and prints a structural fingerprint of the resulting DOM. Obfuscation
 * only rewrites identifiers and string storage -- it must never change what the
 * app renders -- so the two fingerprints must be byte-identical.
 *
 * It also boots the SHIPPED dist/ HTML file when one is present. The two builds
 * above are made fresh into a temp directory, so on their own they certify a
 * sibling of the deliverable rather than the deliverable itself. Driving dist/
 * through the same fingerprint and the same absolute expectations is what makes
 * "the application works correctly after obfuscation" a statement about the file
 * that actually goes to the phone. If dist/ is absent (a clean checkout, CI before
 * the build step) that leg is skipped with a printed note rather than failing.
 *
 * Usage: node scripts/verify-build.mjs
 */
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { build, APP_HTML } from './build.mjs';
import { buildProd } from './build-prod.mjs';
import { encodeRoster } from '../src/codec.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_HTML = join(ROOT, 'dist', APP_HTML);

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
const TEAM = 'Home & Co <b>';
const OPPONENT = 'Away "FC"';

const ROSTER_TEXT = encodeRoster({
  v: 1,
  kind: 'roster',
  gameId: 'verify-1',
  team: TEAM,
  opponent: OPPONENT,
  date: '2026-09-13',
  players: ROSTER_NAMES.map((name, i) => ({ id: `p${i + 1}`, name })),
});

/**
 * Boot one build, drive it, and return a structural fingerprint of the DOM.
 *
 * Runs in its own incognito browser context, not just a new page/tab. Chromium
 * (and Edge) assign every `file://` URL the same bare `file://` origin regardless
 * of directory, so plain `browser.newPage()` calls share one `localStorage` --
 * the session the plain build commits would otherwise still be there when the
 * hardened build's page loads, skipping the paste screen entirely and making
 * the "no regression" comparison below vacuous rather than a real check.
 */
async function fingerprint(browser, htmlPath) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
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
        // The app renders error banners (a bad payload, a failed self-check) with
        // class `err`. A build stuck on one of those still "mounts" and throws
        // nothing, so this is the only fingerprint field that catches it.
        hasErrorBanner: app ? app.querySelector('.err') !== null : false,
        elements: tally(/<[a-zA-Z]/g),
        buttons: tally(/<button/g),
        inputs: tally(/<input/g),
        textareas: tally(/<textarea/g),
        distinctClasses: [...new Set(classes)].sort(),
        classUses: classes.length,
        text,
      };
    });

    return { ...fp, pasted, errors };
  } finally {
    await context.close();
  }
}

function render(label, fp) {
  return [
    `--- ${label} ---`,
    `mounted:        ${fp.mounted ? 'yes' : 'NO'}`,
    `pasted-roster:  ${fp.pasted ? 'yes' : 'no'}`,
    `escaped-names:  ${fp.hasEscapedEntity ? 'yes' : 'no'}${fp.injectedElement ? ' (INJECTED ELEMENT!)' : ''}`,
    `error-banner:   ${fp.hasErrorBanner ? 'YES' : 'no'}`,
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

/**
 * Parity (the diff below) proves the two builds agree with each other -- it can
 * never prove either one is actually *right*. A shared regression -- a codec
 * self-check that starts failing, a rejected payload, a render that crashes the
 * same way in both -- would leave both builds on the same degraded screen, still
 * comparing equal, and this script would print PASS while verifying nothing. This
 * check runs independently per build and asserts it actually reached the
 * populated record screen, so a both-sides-degraded regression fails loudly
 * instead of parity papering over it.
 */
function checkExpectations(label, fp) {
  const problems = [];
  if (fp.textareas !== 0) {
    problems.push('still shows the paste textarea -- it never left the paste screen');
  }
  if (fp.elements < 30) {
    problems.push(`renders only ${fp.elements} elements -- too few to be the populated record screen`);
  }
  if (fp.hasErrorBanner) {
    problems.push('shows an error banner (.err) -- the payload was likely rejected or a self-check failed');
  }
  for (const name of ROSTER_NAMES) {
    if (!fp.text.includes(name)) {
      problems.push(`player name "${name}" is missing from the rendered text -- the roster did not load`);
    }
  }
  if (!fp.text.includes(TEAM)) {
    problems.push(`team name "${TEAM}" is missing from the rendered text -- the payload was not decoded`);
  }
  if (!fp.text.includes(OPPONENT)) {
    problems.push(`opponent name "${OPPONENT}" is missing from the rendered text -- the payload was not decoded`);
  }
  for (const problem of problems) {
    console.error(`FAIL: ${label} build ${problem}.`);
  }
  return problems.length === 0;
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

  // The shipped artifact is only a verification target if it is actually there.
  const shippedPresent = existsSync(SHIPPED_HTML);

  let plainFp;
  let prodFp;
  let shippedFp = null;
  try {
    plainFp = await fingerprint(browser, join(plainDir, APP_HTML));
    prodFp = await fingerprint(browser, join(prodDir, APP_HTML));
    if (shippedPresent) shippedFp = await fingerprint(browser, SHIPPED_HTML);
  } finally {
    await browser.close();
  }

  // Every fingerprint that exists gets the identical treatment below: mount/paste/
  // runtime-error checks, absolute expectations, and the parity diff against plain.
  const builds = [['plain', plainFp], ['hardened', prodFp]];
  if (shippedFp) builds.push([`shipped (${SHIPPED_HTML})`, shippedFp]);

  console.log(render('plain build', plainFp));
  console.log();
  console.log(render('hardened build', prodFp));
  console.log();
  if (shippedFp) {
    console.log(render(`shipped build (dist/${APP_HTML})`, shippedFp));
    console.log();
  } else {
    console.log(`NOTE: ${SHIPPED_HTML} does not exist -- skipping the shipped-artifact check.`);
    console.log('      Run `npm run build` first to certify the file you actually ship.');
    console.log();
  }

  for (const [label, fp] of builds) {
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

  for (const [label, fp] of builds) {
    if (!checkExpectations(label, fp)) failed = true;
  }

  const compare = (fp) => JSON.stringify({ ...fp, errors: undefined });
  for (const [label, fp] of builds.slice(1)) {
    if (compare(plainFp) === compare(fp)) continue;
    console.error(`FAIL: ${label} build renders differently from the plain build.`);
    for (const key of Object.keys(plainFp)) {
      if (key === 'errors') continue;
      const a = JSON.stringify(plainFp[key]);
      const b = JSON.stringify(fp[key]);
      if (a !== b) console.error(`  ${key}:\n    plain  ${a}\n    ${label}  ${b}`);
    }
    failed = true;
  }

  // The escaper must have neutralised the markup in the roster names. This is
  // the `transformObjectKeys` hazard (src/ui.js:27) checked on the real app --
  // and on the shipped file too, where it is the one that actually matters.
  for (const [label, fp] of builds.slice(1)) {
    if (failed) break;
    if (fp.injectedElement) {
      console.error(`FAIL: ${label} build injected a live element from a player name -- esc() is broken.`);
      failed = true;
    }
    if (!fp.hasEscapedEntity) {
      console.error(`FAIL: ${label} build shows no escaped entities -- esc() did not run.`);
      failed = true;
    }
  }

  console.log(`artifacts checked: ${builds.map(([label]) => label).join(', ')}`);
  if (!shippedFp) {
    console.log(`  shipped dist/${APP_HTML}: NOT CHECKED (no dist/ present)`);
  } else {
    console.log(`  shipped dist/${APP_HTML}: CHECKED (${SHIPPED_HTML})`);
  }

  if (!failed) {
    const pct = Math.round((hardenedBytes / plainBytes) * 100);
    const what = shippedFp
      ? 'hardened and shipped builds render identically to the plain build'
      : 'hardened build renders identically to the plain build';
    console.log(`PASS: ${what}.`);
    console.log(`  plain ${plainBytes} bytes -> hardened ${hardenedBytes} bytes (${pct}%)`);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
