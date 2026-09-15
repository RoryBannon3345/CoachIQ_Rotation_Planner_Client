// browser-candidates.mjs — the one list of Chromium-based browser install paths every headless
// verify script probes, so verify-build.mjs and verify-golden-vector.mjs cannot drift apart on
// what counts as "a browser found" vs "no browser found; cannot verify".
export const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
