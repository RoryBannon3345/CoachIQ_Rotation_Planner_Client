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
