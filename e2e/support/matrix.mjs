/**
 * Turns Playwright's JSON results (`test-results/results.json`) into `playwright-report/matrix.html`:
 * one row per feature area (spec file), one column per browser/device project, each cell the count of
 * passed, failed, known-failing (`test.fail`) and not-run tests. Usage: `node e2e/support/matrix.mjs`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const AREAS = {
  'paste.spec.mjs': 'Opening a day',
  'record.spec.mjs': 'Recording',
  'sheets.spec.mjs': 'Sheets and menus',
  'export.spec.mjs': 'Export',
  'persist.spec.mjs': 'Saving',
  'density.spec.mjs': 'Fits a phone',
  'offline.live.spec.mjs': 'Offline (live site)',
};

const results = JSON.parse(readFileSync('test-results/results.json', 'utf8'));
const projects = results.config.projects.map((p) => p.name);
const grid = new Map();

function visit(suite, file) {
  const here = suite.file ?? file;
  for (const child of suite.suites ?? []) visit(child, here);
  for (const spec of suite.specs ?? []) {
    const area = AREAS[basename(spec.file ?? here)] ?? basename(spec.file ?? here);
    for (const t of spec.tests) {
      const cell = grid.get(area)?.get(t.projectName) ?? { passed: 0, failed: 0, known: 0, notRun: 0 };
      if (t.status === 'skipped') cell.notRun += 1;
      else if (t.status === 'expected' && t.expectedStatus === 'failed') cell.known += 1;
      else if (t.status === 'expected') cell.passed += 1;
      else cell.failed += 1;
      if (!grid.has(area)) grid.set(area, new Map());
      grid.get(area).set(t.projectName, cell);
    }
  }
}
for (const suite of results.suites) visit(suite, suite.file);

const cellHtml = (c) => {
  if (c === undefined) return '<td class="none">—</td>';
  if (c.failed > 0) return `<td class="fail">✗ ${c.failed} failed${c.passed ? ` · ${c.passed} passed` : ''}</td>`;
  if (c.known > 0) return `<td class="known">⚠ ${c.passed} passed · ${c.known} known</td>`;
  if (c.passed === 0) return '<td class="none">not run</td>';
  return `<td class="pass">✓ ${c.passed}${c.notRun ? ` · ${c.notRun} not run` : ''}</td>`;
};

const rows = [...grid.entries()]
  .map(([area, cells]) => `<tr><th>${area}</th>${projects.map((p) => cellHtml(cells.get(p))).join('')}</tr>`)
  .join('\n');
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser test grid</title>
<style>
:root{--bg:#fff;--fg:#1c2430;--pass:#e3f4e6;--fail:#fbe3e1;--known:#fdf3d8;--none:#f1f3f6;--line:#d8dde4}
@media (prefers-color-scheme:dark){:root{--bg:#14181f;--fg:#e6e9ee;--pass:#1d3a25;--fail:#4a2320;--known:#45391a;--none:#20262f;--line:#333b47}}
body{background:var(--bg);color:var(--fg);font:14px system-ui;margin:16px}.wrap{overflow-x:auto}table{border-collapse:collapse}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;white-space:nowrap}td.pass{background:var(--pass)}td.fail{background:var(--fail)}
td.known{background:var(--known)}td.none{background:var(--none)}a{color:inherit}</style>
<h1>Browser test grid</h1><p>${new Date(results.stats.startTime).toLocaleString()} · <a href="index.html">full report</a></p>
<div class="wrap"><table><tr><th>Area</th>${projects.map((p) => `<th>${p}</th>`).join('')}</tr>
${rows}</table></div>
<p>known = a test marked <code>test.fail</code> for an engine limitation (it fails there, as expected); not run = skipped on that project.</p>`;
mkdirSync('playwright-report', { recursive: true });
writeFileSync('playwright-report/matrix.html', html);
const failed = [...grid.values()].some((cells) => [...cells.values()].some((c) => c.failed > 0));
console.log(`matrix: playwright-report/matrix.html (${failed ? 'FAILURES' : 'all green'})`);
