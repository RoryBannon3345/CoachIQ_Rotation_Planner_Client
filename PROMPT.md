Please analyze the feasibility of the following and create a concise implementation plan. Do not implement anything yet. Ask clarifying questions before finalising the plan.

## Goal

A single-page HTML application (the "Client") that runs on an iPhone in Safari and records per-player volleyball statistics for each game, broken down by set. It exchanges data with an existing desktop web app, CoachIQ Rotation Planner, by copy/paste only. There is no server and no network between the two apps.

## The contract is already fixed — read it first

The planner side of this feature is built and merged. Both apps must implement the exact same payload format. Before planning anything, read these files in this repo's `reference/` folder (they are verbatim copies from the planner repo at commit 2c57064; treat them as read-only):

- `reference/stats-contract.md` — the shared contract: encoded form, exact encode/decode algorithm, both JSON schemas, id rules, limits, error catalogue, versioning policy, a plain-JS reference codec, and two golden test vectors. This document is the source of truth. Where anything in this prompt disagrees with it, the document wins.
- `reference/statsContract.ts` — the planner's TypeScript implementation (zero imports, written so the Client can copy its logic verbatim).
- `reference/vectors.ts` — the golden vectors as data.
- `reference/stats-mockup.html` — the planner's Stats dialog mockup, so the Client's look and vocabulary match the other end.
- `reference/StatsDialog.tsx` — how the planner produces the roster payload and consumes the stats payload (module docblock and the import preview logic).

The planner repo itself is at `C:\_src\CoachIQ_Rotation_Planner` if you need more context; do not modify it.

Summary of the contract, for orientation only:

- Payloads are single strings: `CIQR1.<base64url of UTF-8 JSON>.<8 hex checksum>` for the roster the planner sends, `CIQS1.<…>.<…>` for the stats the Client sends back. `1` is the contract major version. The checksum is FNV-1a 32-bit over the UTF-8 JSON bytes. The decoder strips all whitespace first so email line-wrapping is harmless.
- Roster payload: `{ v: 1, kind: "roster", gameId, team, opponent, date, players: [{ id, name, jersey? }] }`, 1–12 players.
- Stats payload: `{ v: 1, kind: "stats", gameId, recordedAt (ISO), players: [{ id, name }], sets: [{ n: 1|2|3, score: [us, them] | null, players: [{ id, serve: { in, out }, return: { in, out } }] }] }`. `gameId` is echoed from the roster payload. `players` is the roster the Client actually used, at most 12. `sets` has 1–3 entries, ascending, and a set that was not played is omitted. Counts are integers 0–999. Totals are never transmitted; both apps derive `in + out`.
- A player the Client adds itself (a sub the coach never entered in the planner) must get an id matching `/^cx-[A-Za-z0-9_-]{4,32}$/` and a name of 1–64 characters; the planner imports her as a guest of that game.
- The planner rejects a stats payload whose set list is out of order, whose counts are out of range, whose line ids are not in the top-level `players`, or whose top-level `players` exceeds 12. Generate payloads that can never trip those rules.

## Requirements

1. One self-contained `.html` file (inline CSS and JS, no build step, no external resources, no network). It must work when opened from Files or Safari on an iPhone and should behave well when added to the Home Screen.
2. On launch, prompt for the roster payload string (the coach pastes it from the planner). Decode it with the contract's codec, validate it, and show the team, opponent, date, and players. Reject a bad paste with the contract's own error wording.
3. The recording screen shows, per player: the name, and four counters, each with a "+" and a "−" button: Serves In, Serves Out, Returns In, Returns Out. A counter never goes below 0 or above 999.
4. No more than 12 players in a roster. Support adding a sub who is not in the roster (with a `cx-` id) only while the total stays at or below 12.
5. Statistics are per set. The Client must let the coach switch between Set 1, Set 2 and Set 3, and optionally record each set's score. A set never started is omitted from the export.
6. Export the game's stats for all recorded sets as a single stats payload string, shown in a read-only field with a Copy button, and offered through the iOS share sheet where available, so the coach can email or message it to herself for pasting into the planner.
7. Support multiple games in one day session, each with up to 3 sets, each keyed by its own `gameId` from its own roster payload. Stats must never bleed between games. The coach can switch between the day's games and export any of them again later.
8. State must survive Safari backgrounding, a tab reload, and a phone lock mid-game. Losing a set's counts because Safari evicted the tab is the worst failure this app can have.
9. Create an HTML mockup of the screens in `docs/` before implementation, and open it for review. Show: the roster paste screen, the recording screen with 12 players at iPhone width, the set switcher and score entry, the add-a-sub form, the export screen, the game switcher, and every error state.
10. Include a self-check: the Client's codec must reproduce the two golden vectors from the contract doc exactly (compare the decoded objects, or emit keys in the documented order, as the doc explains).

## Design constraints and suggestions to evaluate

- iPhone-first, portrait. Twelve rows with four stepper pairs each will not fit as a grid at 390px wide. Propose a layout that keeps tap targets at least 44×44 points and keeps the most-used action (an "in" tap) reachable with one thumb. Options to weigh: one expandable row per player; a two-step "tap the player, then tap the stat" mode with a large four-button pad; or a compact row with four small steppers and a long-press to decrement. Recommend one and say why.
- Mis-taps are the main real-world error. Propose an undo for the last tap and a confirmation before anything destructive (clearing a set, deleting a game).
- Use `localStorage` for the day session, written on every tap. Consider a versioned storage envelope so a future Client can migrate.
- Copy the codec from the contract doc's plain-JS reference verbatim rather than rewriting it. Keep the roster decode strict (expected kind `roster`) so a coach who pastes a stats string by mistake sees the contract's "this is a stats payload, not a roster payload" message.
- `recordedAt` comes from the phone clock in ISO 8601. Decide whether the export also shows a short human summary (opponent, sets, scores) above the string so the coach can sanity-check before sending.
- Do not build a stats review or analysis view in the Client; the planner owns that. The Client records and exports.

## Please evaluate and recommend

1. Recommended screen flow and layout for the recording screen, with the tap-target reasoning.
2. Data model for the day session (games, sets, players, counts) and how it maps onto the stats payload.
3. Persistence and recovery strategy on iOS Safari, including what happens if the roster is re-pasted for a game that already has stats.
4. How the codec and validators are shared with the planner without a build step, and how the golden-vector self-check runs.
5. Export and sharing on iOS: clipboard, share sheet, and the fallback when neither is available.
6. Testing approach for a single-file app (what can be unit-tested, how the mockup is verified).
7. Any concerns or improvements, and anything in the contract that the Client would want changed (raise it; do not diverge from the contract on your own).

Keep the plan practical and relatively short. List your assumptions and ask your clarifying questions before finalising. Questions I expect you may need answered: whether jersey numbers should be shown when present; whether per-set scores are required or optional at export; whether a player can be marked as sitting out a set; whether the roster prompt appears on every launch or only when no game is open; whether landscape needs support; whether dark mode matters; and whether the coach ever needs to edit counts after an export.
