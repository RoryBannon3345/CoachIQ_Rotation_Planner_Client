// vectors.js — golden vectors for the stats contract, ported from reference/vectors.ts.
// Pure data: no imports. Do not edit; re-copy from reference/vectors.ts if the contract changes.

const ROSTER_PAYLOAD = {
  v: 1, kind: 'roster', gameId: 'game-1', team: 'Thunder', opponent: 'Lions', date: '2026-09-19',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
};

const STATS_PAYLOAD = {
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
 * The v2 vectors: a two-game tournament day, which is the shape the whole contract moved to and
 * the smallest one that can go wrong in a v2-specific way (a second game, a per-game set list that
 * starts again at 1, and a `roster` of indices that is not simply every player).
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
 * The v3 vectors: the same two-game day, with `games[].roster` replaced by `games[].sets`.
 * `game-1` runs three sets with different membership each time (both players, then Grace alone,
 * then Zoe alone) — the shape that could not be expressed at all before v3. `game-2` runs two
 * sets and has nobody picked for the second: a mask of `0`, legal on purpose.
 */
const ROSTER_V3_PAYLOAD = {
  v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
  games: [
    { gameId: 'game-1', opponent: 'Lions', sets: [3, 1, 2] },
    { gameId: 'game-2', opponent: 'Falcons', sets: [2, 0] },
  ],
};

export const ROSTER_V3_VECTOR = {
  payload: ROSTER_V3_PAYLOAD,
  encoded: 'CIQR3.eyJ2IjozLCJraW5kIjoicm9zdGVyIiwiZGF0ZSI6IjIwMjYtMDktMTkiLCJ0ZWFtIjoiVGh1bmRlciIsInBsYXllcnMiOlt7ImlkIjoiZ3JhY2UiLCJuYW1lIjoiR3JhY2UiLCJqZXJzZXkiOjd9LHsiaWQiOiJ6b2llIiwibmFtZSI6Ilpvw6sifV0sImdhbWVzIjpbeyJnYW1lSWQiOiJnYW1lLTEiLCJvcHBvbmVudCI6Ikxpb25zIiwic2V0cyI6WzMsMSwyXX0seyJnYW1lSWQiOiJnYW1lLTIiLCJvcHBvbmVudCI6IkZhbGNvbnMiLCJzZXRzIjpbMiwwXX1dfQ.e9e26391',
};

/**
 * `ROSTER_V1_AS_DAY` — the day shape `normaliseRosterV1`/`decodeDayRoster` must produce from
 * `ROSTER_VECTOR.payload` at v3. A v1 roster is a one-game day whose directory is that game's
 * players, so its single set names every one of them: two players, indices 0 and 1, mask 3.
 */
export const ROSTER_V1_AS_DAY = {
  v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
  games: [{ gameId: 'game-1', opponent: 'Lions', sets: [3] }],
};

/**
 * `ROSTER_V2_AS_V3` — the day shape `decodeDayRoster` must produce from `ROSTER_V2_VECTOR.payload`.
 * A v2 game carried no set structure, so each normalises to ONE set holding its whole roster:
 * `game-1`'s `roster: [0, 1]` becomes mask 3, `game-2`'s `roster: [1]` becomes mask 2.
 */
export const ROSTER_V2_AS_V3 = {
  v: 3, kind: 'roster', date: '2026-09-19', team: 'Thunder',
  players: [{ id: 'grace', name: 'Grace', jersey: 7 }, { id: 'zoie', name: 'Zoë' }],
  games: [
    { gameId: 'game-1', opponent: 'Lions', sets: [3] },
    { gameId: 'game-2', opponent: 'Falcons', sets: [2] },
  ],
};

/**
 * `STATS_V1_AS_DAY` — the day shape `normaliseStatsV1`/`decodeDayStats` must produce from
 * `STATS_VECTOR.payload`. Written by hand for the same reason as `ROSTER_V1_AS_DAY`. Key order
 * matches `normaliseStatsV1`'s own literal order (v, kind, recordedAt, players, games).
 */
export const STATS_V1_AS_DAY = {
  v: 2, kind: 'stats', recordedAt: '2026-09-19T21:04:00Z',
  players: [{ id: 'grace', name: 'Grace' }, { id: 'cx-8f2k1q', name: 'Ava' }],
  games: [{ gameId: 'game-1', sets: [
    { n: 1, score: [25, 21], players: [
      { id: 'grace', serve: { in: 8, out: 2 }, return: { in: 5, out: 1 } },
      { id: 'cx-8f2k1q', serve: { in: 0, out: 0 }, return: { in: 3, out: 0 } },
    ] },
    { n: 2, score: null, players: [{ id: 'grace', serve: { in: 4, out: 1 }, return: { in: 2, out: 2 } }] },
  ] }],
};

/**
 * `STATS_V2_AS_V3` — the day shape `decodeDayStats` must produce from `STATS_V2_VECTOR.payload`.
 * Byte-for-byte the v2 sheet with its version digit moved: the stats payload shape did not change
 * at contract v3, so normalising a v2 body is nothing more than reporting it at the current
 * version. Key order matches `STATS_V2_PAYLOAD`'s: `v` first, then `kind`, `recordedAt`,
 * `players`, `games`.
 */
export const STATS_V2_AS_V3 = { ...STATS_V2_PAYLOAD, v: 3 };
