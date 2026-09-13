// build-prod.mjs — the production entry point. Bundles with the ordinary readable
// builder into a throwaway staging directory, hardens that output, and writes the
// result to dist/. src/ and scripts/build.mjs are never touched by any of this.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, APP_HTML } from './build.mjs';
import { harden, minifySw } from './harden.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Write `content` so the final path either shows the old contents or the fully-written
// new contents, never a partial file: write to a sibling temp name in the same
// directory, then rename it over the target. A same-directory rename is atomic on both
// POSIX and Windows, and `renameSync` replaces an existing destination file on Windows
// (POSIX renames always replace).
function writeAtomic(path, content) {
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, path);
}

export async function buildProd(outDir = join(ROOT, 'dist')) {
  // Stage the readable bundle out of the way so a failed harden can never leave a
  // half-written dist/ behind.
  const staging = mkdtempSync(join(tmpdir(), 'ciq-staging-'));
  try {
    build(staging);
    const plain = readFileSync(join(staging, APP_HTML), 'utf8');
    const html = await harden(plain);

    // The service worker ships as its own file -- it must keep this exact name to
    // stay registrable at the same scope (see ui.js, navigator.serviceWorker.register).
    // `minifySw` (harden.mjs) minifies it under the same shared terser policy as the
    // bundle and deliberately does not obfuscate it; the reasoning lives there so the
    // drop_console policy has exactly one definition.
    const swCode = await minifySw(readFileSync(join(staging, 'sw.js'), 'utf8'));

    // buildProd owns exactly these two files. It replaces each of them in place
    // (atomically, via writeAtomic below) and deliberately leaves anything else
    // already present in outDir alone -- it never deletes files it did not create.
    mkdirSync(outDir, { recursive: true });
    // Both outputs are fully computed above before either write below, and each
    // write is swapped into place atomically -- a crash mid-build touches neither
    // file, and a crash between the two writes leaves one fully replaced and the
    // other exactly as it was. The one residual gap: the two swaps are not a single
    // transaction, so that in-between moment is not itself atomic across both files.
    writeAtomic(join(outDir, APP_HTML), html);
    writeAtomic(join(outDir, 'sw.js'), swCode);

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
  console.log(`built hardened ${join(target ?? join(ROOT, 'dist'), APP_HTML)}`);
  console.log(`  plain ${plainBytes} bytes -> hardened ${hardenedBytes} bytes (${pct}%)`);
}
