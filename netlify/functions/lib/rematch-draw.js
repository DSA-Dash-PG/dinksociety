// netlify/functions/lib/rematch-draw.js
//
// The draw for the SECOND round-robin of a double-format season (pure, no I/O).
//
// Works for an even OR odd number of teams. With an odd count (a team left the
// league mid-season) one team sits out each week — every team gets exactly one
// bye and still plays every other team once.
//
//   drawRounds(ids, { rng, avoidFirst })  → [{ bye, pairs: [[a, b], …] }, …]
//   checkRounds(rounds, ids)              → null when valid, else a message
//   seededRng(seed)                       → repeatable rng, so a dry run and the
//                                           live run produce the same draw

// mulberry32 — tiny, repeatable PRNG. Same seed → same sequence.
export function seededRng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pairKey(a, b) {
  return [String(a), String(b)].sort().join('|');
}

function shuffled(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// One full round-robin by the circle method, off a shuffled seating.
function circle(ids, rng) {
  const seats = shuffled(ids, rng);
  if (seats.length % 2) seats.push(null);          // null = the bye seat
  const n = seats.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    let bye = null;
    for (let i = 0; i < n / 2; i++) {
      const a = seats[i], b = seats[n - 1 - i];
      if (a === null) bye = b;
      else if (b === null) bye = a;
      else pairs.push([a, b]);
    }
    rounds.push({ bye, pairs });
    seats.splice(1, 0, seats.pop());               // rotate all but seat 0
  }
  return rounds;
}

/**
 * Random round-robin: every team plays every other team once, in a random
 * week order. `avoidFirst` is a list of [a, b] pairings that should not land in
 * the FIRST round (last week's matchups — no back-to-back rematch). Best effort:
 * if no draw satisfies it, the last attempt is returned anyway.
 */
export function drawRounds(ids, { rng = Math.random, avoidFirst = [] } = {}) {
  const list = [...new Set((ids || []).map(String))];
  if (list.length < 2) return [];
  const avoid = new Set(avoidFirst.map(([a, b]) => pairKey(a, b)));
  let rounds = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    rounds = shuffled(circle(list, rng), rng);
    if (!avoid.size || !rounds[0].pairs.some(([a, b]) => avoid.has(pairKey(a, b)))) break;
  }
  return rounds;
}

/**
 * Validate a set of rounds against the teams that must play. Returns null when
 * it is a complete single round-robin (each pair exactly once, nobody twice in
 * a week, one bye per week when the count is odd), else a readable message.
 */
export function checkRounds(rounds, ids) {
  const list = [...new Set((ids || []).map(String))];
  const odd = list.length % 2 === 1;
  const want = odd ? list.length : list.length - 1;
  if (!Array.isArray(rounds) || rounds.length !== want) {
    return `expected ${want} weeks for ${list.length} teams, got ${Array.isArray(rounds) ? rounds.length : 0}`;
  }
  const known = new Set(list);
  const met = new Set();
  for (let r = 0; r < rounds.length; r++) {
    const round = rounds[r] || {};
    const seen = new Set();
    const use = (id) => {
      const k = String(id);
      if (!known.has(k)) return `week ${r + 1}: unknown team ${k}`;
      if (seen.has(k)) return `week ${r + 1}: ${k} appears twice`;
      seen.add(k);
      return null;
    };
    for (const p of (round.pairs || [])) {
      if (!Array.isArray(p) || p.length !== 2) return `week ${r + 1}: a match needs exactly two teams`;
      const err = use(p[0]) || use(p[1]);
      if (err) return err;
      const key = pairKey(p[0], p[1]);
      if (met.has(key)) return `week ${r + 1}: ${p[0]} and ${p[1]} already play each other`;
      met.add(key);
    }
    if (odd) {
      if (round.bye == null) return `week ${r + 1}: no bye team set`;
      const err = use(round.bye);
      if (err) return err;
    } else if (round.bye != null) {
      return `week ${r + 1}: a bye is set but the team count is even`;
    }
    if (seen.size !== list.length) return `week ${r + 1}: not every team is placed`;
  }
  const pairsWanted = (list.length * (list.length - 1)) / 2;
  if (met.size !== pairsWanted) return `expected ${pairsWanted} matchups, got ${met.size}`;
  return null;
}
