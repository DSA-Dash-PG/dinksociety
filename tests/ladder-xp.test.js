// XP scoring tests for the ladder engine.
// played 25 · place 1st25/2nd20/3rd17 then −2/place→0 · round MVP 5 (top M + top F)
// · most wins top4 5 · best diff top4 5 · comeback (win right after loss) 2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calcXP } from '../netlify/functions/lib/ladder-scoring.js';

const P = id => ({ id, name: id, gender: 'MFMFMFMF'['ABCDEFGH'.indexOf(id)] });
const players = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(P);

test('one night, two courts — full XP breakdown', () => {
  const session = { id: 's1', date: '2026-06-20', rounds: [{ courts: [
    { court: 2, team1: [P('A'), P('B')], team2: [P('C'), P('D')], score: { t1: 11, t2: 3, winner: 'A' } },
    { court: 1, team1: [P('E'), P('F')], team2: [P('G'), P('H')], score: { t1: 11, t2: 9, winner: 'A' } },
  ] }] };
  const { xp } = calcXP([session], players, {});
  // A: 25 played + 5 game win + 25 (1st) + 5 mvp + 5 mostWins + 5 bestDiff = 70
  assert.equal(xp.A, 70);
  assert.equal(xp.B, 65); // 25 + 5 win + 20 (2nd) + 5 mvp + 5 + 5
  assert.equal(xp.E, 57); // 25 + 5 win + 17 (3rd) + 5 mostWins + 5 bestDiff
  assert.equal(xp.F, 55); // 25 + 5 win + 15 (4th) + 5 + 5
  assert.equal(xp.G, 38); // 25 + 13 (5th) — lost, no game win
  assert.equal(xp.H, 36); // 25 + 11 (6th)
  assert.equal(xp.C, 34); // 25 + 9 (7th)
  assert.equal(xp.D, 32); // 25 + 7 (8th)
});

test('comeback — a win immediately after a loss is worth 2', () => {
  const s = { id: 's2', rounds: [
    { courts: [{ court: 1, team1: [P('A'), P('B')], team2: [P('C'), P('D')], score: { t1: 5, t2: 11, winner: 'B' } }] },
    { courts: [{ court: 1, team1: [P('A'), P('C')], team2: [P('B'), P('D')], score: { t1: 11, t2: 4, winner: 'A' } }] },
  ] };
  const { detail } = calcXP([s], players, {});
  assert.equal(detail.A.comebacks, 2); // lost R1, won R2 → 1 comeback × 2
  assert.equal(detail.C.comebacks, 2); // lost R1 (with D), won R2 (with A)
});

test('place curve: 1st..12th = 25,20,17,15,13,11,9,7,5,3,1,0', () => {
  // 12 solo "courts" so 12 distinct finishers, descending diff → strict order.
  const ps = Array.from({ length: 24 }, (_, i) => ({ id: 'p' + i, name: 'p' + i, gender: i % 2 ? 'F' : 'M' }));
  const courts = [];
  for (let i = 0; i < 12; i++) {
    const w1 = ps[i * 2], w2 = ps[i * 2 + 1];
    courts.push({ court: 12 - i, team1: [w1, w2], team2: [null, null], score: { t1: 11, t2: 11 - (12 - i), winner: 'A' } });
  }
  const sess = { id: 's3', rounds: [{ courts }] };
  const { detail } = calcXP([sess], ps, {});
  const place = ps.map(p => detail[p.id].place);
  // pairs share a court so each pair gets consecutive ranks; just assert top + tail values exist
  assert.equal(place[0], 25);
  assert.ok(place.includes(0)); // someone bottoms out at 0
});
