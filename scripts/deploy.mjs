// deploy.mjs — the one command that ships a build to GitHub Pages.
//
// Pages serves from the `gh-pages` branch, which holds only the two files in dist/
// at its root. Nothing about `git push` updates it: pushing main publishes the
// SOURCE, and the deployment stays on whatever bytes were last subtree-pushed. That
// gap is not hypothetical — contract v3 went out to main, was verified locally, and
// sat there while every phone kept loading the previous build and refusing the new
// roster payloads. This script closes it by making test -> build -> verify -> push a
// single step that cannot be half-done.
//
// The guard that matters most is `assertDistCommitted`. `git subtree push` publishes
// the COMMITTED dist/, not the working tree, so a rebuild whose output differs from
// the last commit would push stale bytes while the verification you just watched pass
// applied to different ones. Refusing to deploy a dirty dist/ is what keeps the
// verification honest.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_HTML } from './build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = 'gh-pages';
const PREFIX = 'dist';

const DRY_RUN = process.argv.includes('--dry-run');

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** Runs a step for its exit code, streaming its output so the operator sees the same
 *  test and verify output they would from running it by hand. */
function run(label, file, args) {
  console.log(`\n== ${label}`);
  execFileSync(file, args, { cwd: ROOT, stdio: 'inherit' });
}

function fail(message, ...detail) {
  console.error(`\nDEPLOY REFUSED: ${message}`);
  for (const line of detail) console.error(`  ${line}`);
  process.exit(1);
}

/**
 * The whole point of the script. `git subtree push --prefix dist` reads dist/ from the
 * commit at HEAD, so unstaged build output is invisible to it: you would watch the
 * verify pass against bytes that never leave your machine, then publish whatever was
 * committed last time.
 */
function assertDistCommitted() {
  const dirty = git('status', '--porcelain', '--', PREFIX);
  if (dirty.length === 0) return;
  fail(
    `the rebuild changed ${PREFIX}/, and those changes are not committed.`,
    `git subtree push publishes the COMMITTED ${PREFIX}/, so deploying now would ship`,
    'the previous build while the verify you just watched applied to the new one.',
    '',
    ...dirty.split('\n').map((l) => l.trim()),
    '',
    `Commit them, then run deploy again:  git add ${PREFIX} && git commit`,
  );
}

/** Build output whose source is not on GitHub is output nobody can rebuild or bisect. */
function assertSourcePushed() {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  let ahead;
  try {
    ahead = git('rev-list', '--count', `origin/${branch}..${branch}`);
  } catch {
    fail(`branch "${branch}" has no counterpart on origin.`, `Push it first:  git push -u origin ${branch}`);
  }
  if (ahead !== '0') {
    fail(
      `branch "${branch}" is ${ahead} commit(s) ahead of origin/${branch}.`,
      'Deploying now would publish a build whose source is not on GitHub, so nobody',
      'could reproduce or bisect it.',
      '',
      `Push it first:  git push`,
    );
  }
  return branch;
}

/** `https://<user>.github.io/<repo>/<APP_HTML>` from the origin URL, or null if origin
 *  is not a github.com remote — the live check is a courtesy, never a gate. */
function pagesUrl() {
  let origin;
  try {
    origin = git('remote', 'get-url', 'origin');
  } catch {
    return null;
  }
  const m = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(origin);
  if (!m) return null;
  return `https://${m[1].toLowerCase()}.github.io/${m[2]}/${APP_HTML}`;
}

/**
 * Pages rebuilds asynchronously, so a deploy is not done when the push returns. Polls
 * until the served bytes match what we published. Never fails the deploy: the push
 * already succeeded, and a slow Pages build is not a reason to report failure.
 */
async function waitForLive(url, expectedBytes, timeoutMs = 300_000) {
  console.log(`\n== waiting for Pages to serve the new build\n   ${url}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
      const bytes = (await res.arrayBuffer()).byteLength;
      if (bytes === expectedBytes) {
        console.log(`LIVE: serving ${bytes} bytes, matching the build that was just verified.`);
        return true;
      }
      process.stdout.write(`   serving ${bytes} bytes, expecting ${expectedBytes}...\n`);
    } catch (e) {
      process.stdout.write(`   not reachable yet (${e.message})\n`);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  console.warn('\nNOTE: Pages has not served the new bytes yet. The push succeeded, so this is');
  console.warn('      almost certainly just a slow Pages build — check the repo\'s Actions tab.');
  return false;
}

const branch = assertSourcePushed();

run('npm test', process.execPath, ['--test']);
run('npm run build', process.execPath, ['scripts/build-prod.mjs']);

assertDistCommitted();

run('npm run verify (build parity)', process.execPath, ['scripts/verify-build.mjs']);
run('npm run verify (golden vector)', process.execPath, ['scripts/verify-golden-vector.mjs']);

if (DRY_RUN) {
  console.log(`\n--dry-run: every check passed. Re-run without --dry-run to publish ${PREFIX}/ to ${BRANCH}.`);
  process.exit(0);
}

console.log(`\n== git subtree push --prefix ${PREFIX} origin ${BRANCH}`);
try {
  execFileSync('git', ['subtree', 'push', '--prefix', PREFIX, 'origin', BRANCH], { cwd: ROOT, stdio: 'inherit' });
} catch {
  // Deliberately NOT retried with --force. A force-push rewrites the deployment branch
  // and is a decision for a person, not a script — so print the documented recovery
  // and stop. (See "Update the app" in README.md.)
  console.error(`\nDEPLOY FAILED: the subtree push was rejected.`);
  console.error(`  This usually means ${BRANCH} has commits that ${PREFIX}/ on ${branch} does not.`);
  console.error(`  The documented recovery force-pushes the deployment branch:`);
  console.error(``);
  console.error(`    git push origin \`git subtree split --prefix ${PREFIX} ${branch}\`:${BRANCH} --force`);
  console.error(``);
  console.error(`  Run it yourself once you are satisfied nothing on ${BRANCH} needs keeping.`);
  process.exit(1);
}

const { statSync } = await import('node:fs');
const expectedBytes = statSync(resolve(ROOT, PREFIX, APP_HTML)).size;
const url = pagesUrl();
if (url) await waitForLive(url, expectedBytes);
else console.log('\nNOTE: origin is not a github.com remote, so the live check was skipped.');

console.log('\nDEPLOYED. Open the app on the phone once while online — the service worker is');
console.log('network-first, so it fetches the new build rather than serving the cached one.');
