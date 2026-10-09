# The rotation number, and a plain Undo — design

Date: 2026-10-08 · Status: bounded design approved by Rory in chat (option C of `docs/rotation-number-mockup.html`) · Builds on: `docs/superpowers/specs/2026-10-08-server-highlight-design.md` (4.6.0)

## Goal

The record screen shows the rotation the phone thinks we are in, as a small "R3" pill beside the **Player** column header, and the bottom-bar Undo button reads plain `↶ Undo` whatever the last entry was.

## 1. The rotation

The number is worked out from the same count that drives the server highlight. For rally `at` of a logged set:

- `t` = the number of rallies before `at` that we won while they were serving (our side-outs), from `servedFirst` and `points` by the contract-6 reading rule.
- `rotation = mod(t + shift, 6) + 1`, where `shift` is the set's re-align offset from 4.6.0.

It is the rotation we are **standing in**, whether we serve or receive. While they serve, the highlighted row is our *next* server, who is one rotation ahead of this number, because we rotate only when we win the ball back. The two never disagree: while we serve, the highlighted row is the server of this rotation.

No plan is needed. An older roster (no `serveOrders`, or `null` for the set) still shows the number, from serve-first and the rally log alone; `shift` stays 0 there, because re-align only fires with a plan.

**Null** (no pill) when:
- the set is untouched, or serve-first is unanswered;
- the set has a typed score;
- the set's plan is longer than six (a Train line: the plan walks spots in the line, not rotations 1–6).

New pure, exported helpers in `src/session.js`, beside `plannedServerAt`:

```js
/** The rotation we are standing in for rally `at` of a logged set, 1–6, or null (see above). */
export function rotationAt(set, order, at)
/** rotationAt at the end of the log: the number to show. */
export function rotation(set, order)
```

The side-out walk is shared with `planIndex` (one loop, two readers), so the number and the highlight cannot drift apart.

## 2. Screen

- `renderRecord` computes `rot = typed ? null : rotation(setRecord, order)` with the same `order` it hands `plannedServer`.
- The Player column header becomes `<span>Player<span class="rot" data-rotation="3">R3</span></span>` when `rot` is a number, and stays `<span>Player</span>` otherwise.
- CSS, one rule: `.colhead .rot { display:inline-block; margin-left:6px; padding:0 5px; border-radius:999px; background:var(--accent); color:#fff; font-size:8px; line-height:1.2; letter-spacing:.04em; vertical-align:top; }`. The pill must not raise `.colhead`; the density guard measures it.
- The Undo button reads `↶ Undo` always. It stays disabled when the game has no history. The toast still says what the tap did, and the re-align toasts are unchanged.

## 3. Out of scope

- The stats payload. Nothing new goes to the Planner.
- Their rotation.
- A rotation for Train sets.
- Any change to the highlight rules, the re-align rules or persistence. `rotationAt` reads `shift` and never writes it.

## Release

- `APP_VERSION` 4.7.0, service worker cache `ciq-stats-v16`, rebuilt `dist/`.
- README: line 5 mentions the rotation number; Verify checklist lines `(4.7.0)` for the pill (serve, receive, side-out, re-align), the older-roster case and the plain Undo label.
- Rory asked for this release to be committed to `main`, pushed, and deployed with `buildAndDeploy.bat` once the work is done. The controller does that; implementers never commit.

## Testing

- **Unit, session:** `rotationAt` against the hand cases (serve first, receive first, a lost rally does not advance, a side-out does, wrap past 6, shift, Train-length order is null, no order still counts, typed and unanswered and untouched are null) and against `SERVE_ORDER_VECTOR` (while we serve, `order[rotationAt − 1]` is the vector's server).
- **Unit, ui:** the pill's markup and value in each state; no pill in each null case; the pill moves with a re-align and back with Undo; the plain Undo label with and without history.
- **Browser:** `e2e/record.spec.mjs` shows the pill through a serve, a lost rally and a side-out, and the plain Undo label; label assertions elsewhere become effect assertions.
- **Gates:** `npm test`, `npm run build`, `npm run verify` (density included), `npm run test:browsers`, from PowerShell.
