# CoachIQ Rotation Planner — Stats Client

## What it is

Records per-player Serve In, Serve Out, Return In, and Return Out counts per set during a game, supporting up to 12 players and 3 sets. Plays several games a day. Exchanges CIQR1… roster payloads and CIQS1… stats payloads with the planner by copy and paste, with no server or network required.

## Develop

Run `npm install` once, then `npm test` to execute tests with Node's built-in test runner. Rebuild with `npm run build` to produce the hardened `dist/CoachIQ_Rotation_Planner_Client.html` and `dist/sw.js`; use `npm run build:dev` for a readable bundle in `dist-dev/`. Do not run `node scripts/build.mjs` directly — it writes an unobfuscated bundle.

Source code layout: `src/codec.js` contains the contract codec copied verbatim from the planner; `src/session.js` is the pure state model; `src/ui.js` contains the screen rendering logic; `src/styles.css` holds styles; `src/index.html` is the template; `src/sw.js` is the service worker. Note: imports must be single-line because the build inliner removes only full-line import statements.

## Building

```bash
npm install        # once -- the build has devDependencies
npm run build      # hardened -> dist/CoachIQ_Rotation_Planner_Client.html + dist/sw.js  (what you ship)
npm run build:dev  # readable -> dist-dev/CoachIQ_Rotation_Planner_Client.html           (for debugging)
npm test           # unit tests
npm run verify     # boots both builds in headless Edge and diffs what they render
```

`npm run build` is the production build. It concatenates `src/*.js` in dependency
order, inlines them with `styles.css` into `src/index.html`, and then hardens the
result:

- **terser** minifies and mangles identifiers, drops every `console.*` and
  `debugger` statement, and strips all comments.
- **javascript-obfuscator** renames what is left and moves string literals into an
  encoded, rotated, shuffled array behind accessor functions.
- **html-minifier-terser** collapses the document and its CSS.
- **No source maps are generated**, and nothing writes a `.map` file.

`src/` is never touched. For a readable build, use `npm run build:dev`, which
writes to `dist-dev/` and leaves `dist/` alone.

### What obfuscation does and does not buy

It raises the cost of reading the rotation and stats logic from minutes to hours.
It is **not** a confidentiality boundary: anything the browser executes can
ultimately be inspected, and a determined reader with a debugger will get there.
Do not treat obfuscation as a reason to put a secret in this bundle.

That is not a live concern today, because there is nothing to protect:

- The app contacts **no external endpoint** — no API calls, no analytics, no
  third-party requests, and no external URL in the shipped bundle. The one
  `fetch` in the codebase is in `src/sw.js`, the service worker's
  cache-passthrough handler, and it only re-requests the app's own same-origin
  assets so the app keeps working offline. `test/build.test.mjs` enforces that
  the built HTML contains no literal `http(s)://` URL and no external
  `<script>`/`<link>`.
- It holds **no API keys, tokens, or credentials**. The only persistence is
  `localStorage` on the coach's own device.
- There is **no server**, so there is no security-sensitive logic to move behind
  an API. Should one ever be added, put the secrets there — not here.

### Asset filenames

Everything inlines into a single HTML entry point, so there are no sub-assets to
content-hash. The two emitted filenames are both fixed by contract: `CoachIQ_Rotation_Planner_Client.html`
is what users bookmark and what `sw.js` fetches by name. That name is written down
once, as `APP_HTML` in `scripts/build.mjs`, and substituted into the `__APP_HTML__`
placeholder in `src/sw.js` at build time: a worker that precaches a filename the
server does not serve fails to install, silently costing the app its offline launch.
`sw.js` must keep its own name to stay registrable at the same scope. Cache-busting is handled instead by
bumping the `CACHE` constant at the top of `src/sw.js`.

### Why `dist/` has two files and not one

`sw.js` cannot be folded into the HTML file, and this is a browser rule rather than
a limit of the build. `navigator.serviceWorker.register()` refuses any script URL
whose scheme is not `http`/`https`, so a `blob:` or `data:` URL built from an
inlined string is rejected outright; a service worker's scope is derived from its
URL path as well, so it has to exist as a real file at a real path.

Dropping it to get a single file would cost the app its offline launch — the
home-screen app would need a network connection every time it opened — and would
remove the only cache-busting lever this app has. So `dist/` ships as two files
deliberately. This costs nothing in practice: users only ever visit the Pages URL,
and `git subtree push --prefix dist` deploys the folder as a unit.

## Install on iPhone

The HTML file cannot be opened directly from the iPhone Files app because iOS Quick Look previews HTML with JavaScript disabled, and Safari cannot open local files. Deploy to GitHub Pages and add the app to the home screen, where it runs with full JavaScript support, its own storage, and offline access via the service worker. Nothing about your players or stats ever leaves the phone: the hosted file is static and the app makes no network requests.

1. Create an empty GitHub repository at github.com (e.g., `CoachIQ_Rotation_Planner_Client`; public is simplest).
2. From this folder, run:
   ```
   git init
   git add -A
   git commit -m "Initial import"
   git branch -M main
   git remote add origin <url>
   git push -u origin main
   git subtree push --prefix dist origin gh-pages
   ```
3. On GitHub, go to Settings → Pages → Source, select "Deploy from a branch", choose branch `gh-pages` and folder `/ (root)`.
4. Wait for the green deployment check. The URL is `https://<user>.github.io/<repo>/CoachIQ_Rotation_Planner_Client.html` — note the filename: `dist/` contains no `index.html`, so the bare `/` URL will not serve the app.
5. On the iPhone, open the URL in Safari. Tap Share → Add to Home Screen. Launch from the home screen icon.

The home screen app is exempt from Safari's 7-day storage cleanup and keeps its own app storage. After the first online launch, `sw.js` caches the app, so it opens offline without the network.

## Update the app

Edit source files, run `npm test`, rebuild with `npm run build`, commit, and push with `git push`. Then update the Pages deployment:

```
git subtree push --prefix dist origin gh-pages
```

If subtree push is rejected, use:

```
git push origin `git subtree split --prefix dist main`:gh-pages --force
```

Open the app on the phone once while online; the service worker fetches the latest version. The version line in the ⋯ menu shows the current build.

Two constants must be bumped for every release, and both are easy to forget:

1. `APP_VERSION` in `src/session.js` — what the ⋯ menu reports, so you can tell which build a phone is running.
2. `CACHE` in `src/sw.js` (e.g. `ciq-stats-v2` → `ciq-stats-v3`) — the only cache-busting mechanism this app has. Nothing is content-hashed (see "Asset filenames"), so a phone that already cached the old build keeps serving it until the cache name changes.

## Verify on the phone

- [ ] Paste roster from the planner (copy in the planner's Stats dialog, Messages it to the phone, paste) → team/opponent/date/players shown.
- [ ] 12-row roster: every button hit reliably with a thumb; no double-tap zoom; no rubber-band scroll of the whole page.
- [ ] Tap, lock the phone 60 s, unlock → counts intact. Background the app, open five other apps, return → intact. Kill the app, relaunch → intact and on the same game/set.
- [ ] "−" mode subtracts exactly once then turns off; Undo reverses the last tap and shows what it undid.
- [ ] Second game in the same session; switch back and forth; counts never bleed.
- [ ] Export → Share → Mail to self → paste into the planner's Stats dialog → import preview shows the right sets/scores/guests. Re-export after editing → planner shows "This replaces the stats already stored".
- [ ] Paste the stats string into the roster box → "This is a stats payload, not a roster payload."
- [ ] Airplane mode → launch from Home Screen → app opens (worker cache).

## Contract

The payload format is frozen in `reference/stats-contract.md` and is the source of truth for both apps. Both carry the same codec (`reference/statsContract.ts`) and golden test vectors (`reference/vectors.ts`). The app runs a codec self-check at launch and in the ⋯ menu to verify implementation correctness.

## `reference/`

Verbatim copies from the planner repo at commit `2c57064` (merge of the game-statistics feature). Read-only; if the planner's contract changes, re-copy these.

| File | What it is |
|---|---|
| `stats-contract.md` | The shared payload contract. Source of truth for both apps. |
| `statsContract.ts` | The planner's codec and validators (zero imports, copyable). |
| `vectors.ts` | The golden test vectors both apps check against. |
| `stats-mockup.html` | The planner's Stats dialog mockup, for matching look and vocabulary. |
| `StatsDialog.tsx` | How the planner produces the roster payload and imports the stats payload. |
