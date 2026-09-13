import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = ['codec.js', 'vectors.js', 'session.js', 'ui.js'];

// The name of the single self-contained HTML file every build emits. Defined once here
// and imported by build-prod.mjs, verify-build.mjs and the tests; it is also substituted
// into sw.js's `__APP_HTML__` placeholder below, because the service worker precaches and
// falls back to the page BY NAME -- if the two ever drift, `addAll` rejects, the worker
// never installs, and the app silently loses offline support.
export const APP_HTML = 'CoachIQ_Rotation_Planner_Client.html';

// Default is dist-dev, NOT dist: dist/ belongs to the hardened build (scripts/build-prod.mjs),
// and this builder emits a fully readable bundle. Defaulting to dist/ meant a bare
// `node scripts/build.mjs` silently overwrote the shipped, obfuscated file with readable
// source. Every real caller passes an explicit directory, so this default only ever governs
// an unargued invocation -- which is exactly the one that must not clobber dist/.
export function build(outDir = join(ROOT, 'dist-dev')) {
  const src = (f) => readFileSync(join(ROOT, 'src', f), 'utf8');
  // Import statements must be single-line for removal during bundling
  const js = ORDER.map((f) => `// ---- ${f} ----\n` + src(f)
    .replace(/^export (?=(const|let|function|async function|class)\b)/gm, '')
    .replace(/^import\s[^\n]*?from\s+['"][^'"]+['"];?[ \t]*$\n?/gm, '')).join('\n');
  const html = src('index.html')
    .replace('<!--STYLES-->', () => `<style>\n${src('styles.css')}\n</style>`)
    .replace('<!--SCRIPT-->', () => `<script>\n(function () {\n'use strict';\n${js}\n})();\n</script>`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, APP_HTML), html);
  // sw.js is templated rather than copied verbatim: it names the app file, and APP_HTML
  // above is the only place that name is written down.
  writeFileSync(join(outDir, 'sw.js'), src('sw.js').replaceAll('__APP_HTML__', APP_HTML));
  return join(outDir, APP_HTML);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('built', build(process.argv[2]));
}
