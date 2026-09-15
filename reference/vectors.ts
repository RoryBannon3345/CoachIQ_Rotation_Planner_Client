/**
 * Golden vectors for the stats contract: known payload → known encoded string, generated once by
 * running the real encoders on the exact samples below (see `statsContract.test.ts`'s
 * `roster`/`stats`). Shared verbatim in `docs/stats-contract.md` so the Client's author can check
 * an independent implementation against the same fixed output.
 *
 * The v1 strings are **frozen**: the Client's own self-check and the contract doc both quote them
 * byte for byte, so nothing this app does to the codec may change them. That is why
 * `encodeRoster`/`encodeStats` pin `version: 1` now that `CONTRACT_VERSION` is 2 — see
 * `encodePayload`'s docblock.
 */
import type { DayRosterPayload, DayStatsPayload, RosterPayload, StatsPayload } from '../statsContract';

const ROSTER_PAYLOAD: RosterPayload = {
  v: 1, kind: 'roster', gameId: 'game-1', team: 'Thunder', opponent: 'Lions', date: '2026-09-19',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
};

const STATS_PAYLOAD: StatsPayload = {
  v: 1, kind: 'stats', gameId: 'game-1', recordedAt: '2026-09-19T21:04:00Z',
  players: [{ id: 'grace', name: 'Grace' }, { id: 'cx-8f2k1q', name: 'Ava' }],
  sets: [
    { n: 1, score: [25, 21], players: [
      { id: 'grace', serve: { in: 8, out: 2 }, return: { in: 5, out: 1 } },
      { id: 'cx-8f2k1q', serve: { in: 0, out: 0 }, return: { in: 3, out: 0 } },
    ] },
    { n: 2, score: null, players: [{ id: 'grace', serve: { in: 4, out: 1 }, return: { in: 2, out: 2 } }] },
  ],
};

export const ROSTER_VECTOR = {
  payload: ROSTER_PAYLOAD,
  encoded: 'CIQR1.eyJ2IjoxLCJraW5kIjoicm9zdGVyIiwiZ2FtZUlkIjoiZ2FtZS0xIiwidGVhbSI6IlRodW5kZXIiLCJvcHBvbmVudCI6Ikxpb25zIiwiZGF0ZSI6IjIwMjYtMDktMTkiLCJwbGF5ZXJzIjpbeyJpZCI6ImdyYWNlIiwibmFtZSI6IkdyYWNlIiwiamVyc2V5Ijo3fSx7ImlkIjoiem9pZSIsIm5hbWUiOiJab8OrIn1dfQ.95c9f4c5',
};

export const STATS_VECTOR = {
  payload: STATS_PAYLOAD,
  encoded: 'CIQS1.eyJ2IjoxLCJraW5kIjoic3RhdHMiLCJnYW1lSWQiOiJnYW1lLTEiLCJyZWNvcmRlZEF0IjoiMjAyNi0wOS0xOVQyMTowNDowMFoiLCJwbGF5ZXJzIjpbeyJpZCI6ImdyYWNlIiwibmFtZSI6IkdyYWNlIn0seyJpZCI6ImN4LThmMmsxcSIsIm5hbWUiOiJBdmEifV0sInNldHMiOlt7Im4iOjEsInNjb3JlIjpbMjUsMjFdLCJwbGF5ZXJzIjpbeyJpZCI6ImdyYWNlIiwic2VydmUiOnsiaW4iOjgsIm91dCI6Mn0sInJldHVybiI6eyJpbiI6NSwib3V0IjoxfX0seyJpZCI6ImN4LThmMmsxcSIsInNlcnZlIjp7ImluIjowLCJvdXQiOjB9LCJyZXR1cm4iOnsiaW4iOjMsIm91dCI6MH19XX0seyJuIjoyLCJzY29yZSI6bnVsbCwicGxheWVycyI6W3siaWQiOiJncmFjZSIsInNlcnZlIjp7ImluIjo0LCJvdXQiOjF9LCJyZXR1cm4iOnsiaW4iOjIsIm91dCI6Mn19XX1dfQ.27119bc0',
};

/**
 * The v2 vectors: a two-game tournament day, which is the shape the contract moved to at v2 and
 * the smallest one that can go wrong in a v2-specific way (a second game, a per-game set list that
 * starts again at 1, and a `roster` of indices that is not simply every player).
 *
 * Frozen, and no longer expressible through `DayRosterPayload`/`DayStatsPayload` now that those
 * name the v3 shape: `statsContract.ts`'s v2 roster types are deliberately not exported (see
 * `DayRosterGameV2`'s docblock), so these stay untyped object literals, checked structurally by
 * `encodePayload`'s `unknown` parameter the same way a hand-edited legacy payload would be.
 */
const ROSTER_V2_PAYLOAD = {
  v: 2, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
  games: [
    { gameId: 'game-1', opponent: 'Lions', roster: [0, 1] },
    { gameId: 'game-2', opponent: 'Falcons', roster: [1] },
  ],
};

const STATS_V2_PAYLOAD = {
  v: 2, kind: 'stats', recordedAt: '2026-09-19T21:04:00Z',
  players: [{ id: 'grace', name: 'Grace' }, { id: 'cx-8f2k1q', name: 'Ava' }],
  games: [
    { gameId: 'game-1', sets: [
      { n: 1, score: [25, 21], players: [
        { id: 'grace', serve: { in: 8, out: 2 }, return: { in: 5, out: 1 } },
        { id: 'cx-8f2k1q', serve: { in: 0, out: 0 }, return: { in: 3, out: 0 } },
      ] },
      { n: 2, score: null, players: [{ id: 'grace', serve: { in: 4, out: 1 }, return: { in: 2, out: 2 } }] },
    ] },
    { gameId: 'game-2', sets: [
      { n: 1, score: [25, 18], players: [{ id: 'cx-8f2k1q', serve: { in: 6, out: 1 }, return: { in: 2, out: 0 } }] },
    ] },
  ],
};

export const ROSTER_V2_VECTOR = {
  payload: ROSTER_V2_PAYLOAD,
  encoded: 'CIQR2.eyJ2IjoyLCJraW5kIjoicm9zdGVyIiwiZGF0ZSI6IjIwMjYtMDktMTkiLCJ0ZWFtIjoiVGh1bmRlciIsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJuYW1lIjoiR3JhY2UiLCJqZXJzZXkiOjd9LHsiaWQiOiJ6b2llIiwibmFtZSI6Ilpvw6sifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJvcHBvbmVudCI6Ikxpb25zIiwicm9zdGVyIjpbMCwxXX0seyJnYW1lSWQiOiJnYW1lLTIiLCJvcHBvbmVudCI6IkZhbGNvbnMiLCJyb3N0ZXIiOlsxXX1dfQ.7b1e1d96',
};

export const STATS_V2_VECTOR = {
  payload: STATS_V2_PAYLOAD,
  encoded: 'CIQS2.eyJ2IjoyLCJraW5kIjoic3RhdHMiLCJyZWNvcmRlZEF0IjoiMjAyNi0wOS0xOVQyMTowNDowMFoiLCJwbGF5ZXJzIjpbeyJpZCI6ImdyYWNlIiwibmFtZSI6IkdyYWNlIn0seyJpZCI6ImN4LThmMmsxcSIsIm5hbWUiOiJBdmEifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJzZXRzIjpbeyJuIjoxLCJzY29yZSI6WzI1LDIxXSwicGxheWVycyI6W3siaWQiOiJncmFjZSIsInNlcnZlIjp7ImluIjo4LCJvdXQiOjJ9LCJyZXR1cm4iOnsiaW4iOjUsIm91dCI6MX19LHsiaWQiOiJjeC04ZjJrMXEiLCJzZXJ2ZSI6eyJpbiI6MCwib3V0IjowfSwicmV0dXJuIjp7ImluIjozLCJvdXQiOjB9fV19LHsibiI6Miwic2NvcmUiOm51bGwsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJzZXJ2ZSI6eyJpbiI6NCwib3V0IjoxfSwicmV0dXJuIjp7ImluIjoyLCJvdXQiOjJ9fV19XX0seyJnYW1lSWQiOiJnYW1lLTIiLCJzZXRzIjpbeyJuIjoxLCJzY29yZSI6WzI1LDE4XSwicGxheWVycyI6W3siaWQiOiJjeC04ZjJrMXEiLCJzZXJ2ZSI6eyJpbiI6Niwib3V0IjoxfSwicmV0dXJuIjp7ImluIjoyLCJvdXQiOjB9fV19XX1dfQ.0342dd9e',
};

/**
 * The v3 vectors: the same two-game day as the v2 pair, so the diff between them shows exactly
 * what the version changed — `roster` index arrays becoming one bitmask per set.
 *
 * `game-1` runs three sets with different membership each time (both players, then Grace alone,
 * then Zoë alone), which is the shape that could not be expressed at all before v3. `game-2` runs
 * two sets and has nobody picked for the second — a mask of `0`, legal on purpose.
 */
const ROSTER_V3_PAYLOAD: DayRosterPayload = {
  v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
  games: [
    { gameId: 'game-1', opponent: 'Lions', sets: [3, 1, 2] },
    { gameId: 'game-2', opponent: 'Falcons', sets: [2, 0] },
  ],
};

/**
 * The v3 stats vector: byte-for-byte the v2 sheet with its version digit moved, which is the
 * whole of what v3 does to the stats half of the contract.
 *
 * `STATS_V2_PAYLOAD` is untyped (see the block comment above it), so its `kind` widens to
 * `string` and its `score` tuples widen to `number[]` — neither matches `DayStatsPayload`. `kind`
 * is narrowed inline; `games` is narrowed by casting it back to its own already-correct shape
 * rather than retyping `STATS_V2_PAYLOAD` itself (which would risk moving the frozen v2 vector's
 * JSON key order) or retyping `DayStatsPayload` (which would loosen the contract for everyone
 * else). Both overrides land on keys the spread already carries, so the key order stays exactly
 * `STATS_V2_PAYLOAD`'s: `v` first, then `kind`, `recordedAt`, `players`, `games`.
 */
const STATS_V3_PAYLOAD: DayStatsPayload = {
  ...STATS_V2_PAYLOAD,
  kind: 'stats' as const,
  v: 3,
  games: STATS_V2_PAYLOAD.games as DayStatsPayload['games'],
};

export const ROSTER_V3_VECTOR = {
  payload: ROSTER_V3_PAYLOAD,
  encoded: 'CIQR3.eyJ2IjozLCJraW5kIjoicm9zdGVyIiwiZGF0ZSI6IjIwMjYtMDktMTkiLCJ0ZWFtIjoiVGh1bmRlciIsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJuYW1lIjoiR3JhY2UiLCJqZXJzZXkiOjd9LHsiaWQiOiJ6b2llIiwibmFtZSI6Ilpvw6sifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJvcHBvbmVudCI6Ikxpb25zIiwic2V0cyI6WzMsMSwyXX0seyJnYW1lSWQiOiJnYW1lLTIiLCJvcHBvbmVudCI6IkZhbGNvbnMiLCJzZXRzIjpbMiwwXX1dfQ.e9e26391',
};

export const STATS_V3_VECTOR = {
  payload: STATS_V3_PAYLOAD,
  encoded: 'CIQS3.eyJ2IjozLCJraW5kIjoic3RhdHMiLCJyZWNvcmRlZEF0IjoiMjAyNi0wOS0xOVQyMTowNDowMFoiLCJwbGF5ZXJzIjpbeyJpZCI6ImdyYWNlIiwibmFtZSI6IkdyYWNlIn0seyJpZCI6ImN4LThmMmsxcSIsIm5hbWUiOiJBdmEifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJzZXRzIjpbeyJuIjoxLCJzY29yZSI6WzI1LDIxXSwicGxheWVycyI6W3siaWQiOiJncmFjZSIsInNlcnZlIjp7ImluIjo4LCJvdXQiOjJ9LCJyZXR1cm4iOnsiaW4iOjUsIm91dCI6MX19LHsiaWQiOiJjeC04ZjJrMXEiLCJzZXJ2ZSI6eyJpbiI6MCwib3V0IjowfSwicmV0dXJuIjp7ImluIjozLCJvdXQiOjB9fV19LHsibiI6Miwic2NvcmUiOm51bGwsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJzZXJ2ZSI6eyJpbiI6NCwib3V0IjoxfSwicmV0dXJuIjp7ImluIjoyLCJvdXQiOjJ9fV19XX0seyJnYW1lSWQiOiJnYW1lLTIiLCJzZXRzIjpbeyJuIjoxLCJzY29yZSI6WzI1LDE4XSwicGxheWVycyI6W3siaWQiOiJjeC04ZjJrMXEiLCJzZXJ2ZSI6eyJpbiI6Niwib3V0IjoxfSwicmV0dXJuIjp7ImluIjoyLCJvdXQiOjB9fV19XX1dfQ.89cc6a1f',
};
