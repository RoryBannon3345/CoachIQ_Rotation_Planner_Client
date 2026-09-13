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
  // Pinned, not left at the default 0 (= "reseed randomly on every run"). Several
  // transforms below -- stringArrayRotate, stringArrayShuffle, splitStrings, and the
  // wrapper placement -- draw from the obfuscator's PRNG, so an unseeded build emits
  // different bytes every time from byte-identical inputs. Three things break when
  // that happens:
  //   * builds are not reproducible -- the shipped file cannot be re-derived from src/;
  //   * a diff between two releases is pure noise, so a real change cannot be reviewed;
  //   * `npm run verify` certifies whatever randomisation IT happened to produce, not
  //     the artifact in dist/ (see scripts/verify-build.mjs, which now also fingerprints
  //     the shipped file -- a check that is only meaningful because this seed exists).
  // Any fixed integer does; this one is the date the seed was pinned. Change it only
  // deliberately, and expect the whole bundle to re-randomise when you do.
  seed: 20260913,
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
  // 1, not the usual 0.9: a threshold below 1 rolls the dice per string literal and
  // leaves a random ~10% of them in plaintext, so which strings stay readable changes
  // from build to build -- that both weakens the result and makes "no readable
  // identifier survives" a flaky assertion. At 1 the choice is no longer a roll:
  // every string is encoded. That removes the plaintext-leak flakiness only; it says
  // nothing about the ORDER or layout of the resulting string array, which
  // stringArrayRotate/stringArrayShuffle/splitStrings still randomise. Byte-for-byte
  // determinism comes from `seed` above, not from this.
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

/**
 * The single definition of the minification policy, shared by every JavaScript the
 * build emits -- the inline bundle below and `sw.js` in build-prod.mjs. It lives here
 * so a change to `drop_console` (a stated requirement: strip development-only code --
 * `ui.js` carries a `console.assert` round-trip guard explicitly commented "dev-only,
 * never shown to the coach") cannot apply to one output and silently miss the other.
 *
 * `sourceMap` is omitted deliberately -- terser defaults to none, and production must
 * never emit one.
 */
export const TERSER_OPTIONS = Object.freeze({
  compress: Object.freeze({ drop_console: true, drop_debugger: true }),
  mangle: true,
  format: Object.freeze({ comments: false }),
});

/**
 * Minify the service worker: same policy as the bundle, and NOTHING else.
 *
 * `sw.js` is deliberately not obfuscated. It is eight lines of standard lifecycle
 * handlers with nothing to conceal, and mangling `self`/event plumbing buys nothing
 * but risk. Keeping it a named export here (rather than a second terser call in
 * build-prod.mjs) is what makes that "minified, never obfuscated" split explicit.
 */
export async function minifySw(code) {
  const result = await minifyJs(code, TERSER_OPTIONS);
  if (typeof result.code !== 'string') {
    throw new Error('terser produced no output for sw.js');
  }
  return result.code;
}

/** Minify, obfuscate, and inline-escape one JavaScript source string. */
export async function hardenJs(code) {
  const minified = await minifyJs(code, {
    ...TERSER_OPTIONS,
    // A second compress pass on the bundle only: it is orders of magnitude larger
    // than sw.js, so the extra pass pays for itself there and is noise on eight lines.
    compress: { ...TERSER_OPTIONS.compress, passes: 2 },
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
