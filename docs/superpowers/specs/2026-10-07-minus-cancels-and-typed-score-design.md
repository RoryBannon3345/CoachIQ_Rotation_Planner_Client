# Minus cancels an open rally, and typing a final score over a rally log — design

Date: 2026-10-07 · Status: both approved by Rory ("yes to both") · Mockup: `docs/minus-and-typed-score-mockup.html`
Follows: `docs/superpowers/specs/2026-10-07-auto-score-side-out-design.md` (4.3.0). This resolves that spec's ruling 6 and its parked "Set score… replaced by Clear points" finding.

## 1. A minus on the tap that opened the rally cancels that rally

**Problem.** Coach taps Grace Serve In, but Brynn served. She presses − and taps Grace Serve In (count back),
then taps Brynn Serve In. Grace's tap left a rally open, so Brynn's tap settles it as a won rally: a phantom `U`.

**Rule.** In a logged set (not typed) with an open rally (`pending !== null`), a minus tap that actually lowers a
count cancels the open rally when it targets the **opener**: the same player, the same stat as `pending`, side `in`.
The opener is the most recent count entry in the game history with that set's `n` and `delta > 0`. (While a rally
is open, that entry is necessarily the tap that opened it: every later positive tap or pill tap would have changed
or closed `pending`.) If no such entry is found (history capped at 400), nothing is cancelled.

Cancelling sets `pending = null` and leaves everything else alone: the count change as today, the log (letters
the opener appended, e.g. settling the previous rally, stay — Brynn's correct tap implies the same thing), and
`servedFirst`. The history entry is the existing minus entry plus `pendingBefore: <the pending it cleared>`, so the
existing Undo code re-opens the rally when the minus is undone. No new stored fields.

A minus anywhere else (another player, the Out side, the other stat, no open rally, a typed set, a no-op at 0)
behaves exactly as today.

**Known trade-off (final review).** The rule cannot tell a wrong-row correction from a minus that fixes an older
miscount on the player who is serving now: both cancel her open rally, and the next tap then settles nothing, so
one point goes unrecorded. The toast names it, and Undo of the minus or a pill tap repairs it. The README states the
rule: to fix an older miscount on the serving player, wait until the rally is settled.

**Screen.** When a minus tap cancels a rally, the toast reads `Open rally cancelled`. The pills lose their dashed
border on the re-render as they already do when `pending` is null. Undo label unchanged.

**Out of scope.** A wrong-*stat* first tap (Serve In when they served first) also answered serve-first wrongly; Undo
remains the fix for that, and the menu's flip.

## 2. Typing a final score on a set that already has a rally log

**Problem.** Since 4.3.0 almost every set has a log after its second tap, so the menu offers only Clear points; a
coach who wants to type the real final score must clear points first, in two sheets.

**Rule.** New pure function `replaceLogWithScore(s, gameId, n, score)` in `src/session.js`: the composition of
`clearPoints` then `setScore(score)`. Result: `points ''`, `servedFirst null`, `pending null`, `score` typed, point
entries for set `n` dropped from history and its count entries stripped of inference fields (both existing
behaviours of those two functions), counts untouched. Like Clear points, it cannot be undone; the sheet says so.

**Screen.**
- Menu, logged set (`points !== ''`): add `Type the final score…` (data-action `open-score`) directly above
  `Clear points for Set n…`. Unlogged sets keep `Set score…` as today.
- Score sheet opened on a logged set ("replace mode"): title `Set n score`; helper text
  `Replaces the rally log (Us A – B Them, R rallies) with the score you type. Serve and return counts stay. Undo can't bring the log back.`
  where A–B is the tally and R the rally count (`1 rally` when R is 1); the inputs are prefilled with the tally;
  buttons `Cancel` (data-action `close-sheet`, class `btn`) and `Replace log` (data-action `score-done`, class
  `btn danger`). Validation is unchanged; its error reads `Enter both scores` in replace mode (that sheet has no
  Clear button) and `Enter both scores or clear the score` otherwise.
- `score-done` on a logged set calls `replaceLogWithScore`; on an unlogged set it calls `setScore` as today.
- The sheet decides replace mode when it opens and keeps it (`sheet.replace = true`), so Done does what the sheet said.

## Release

`APP_VERSION` 4.4.0, service worker cache `ciq-stats-v13`, rebuilt `dist/`. README checklist gains one line per
feature. No deploy. Commits only when Rory asks.

## Testing

- Unit (session): the wrong-row sequence ends with no phantom letter; Undo of the cancelling minus re-opens the
  rally; minus on another player / Out side / other stat / at 0 / typed set does not cancel; `replaceLogWithScore`
  result and history; save round-trips after both.
- Unit (ui): the toast text; the menu item appears only for a logged set; the sheet's replace-mode copy, prefill and
  buttons; Done replaces the log.
- Browser (`e2e/record.spec.mjs`, `e2e/sheets.spec.mjs`): the wrong-row correction leaves the score unchanged and the
  next tap opens a fresh rally; typing a final score over a log shows the typed score.
