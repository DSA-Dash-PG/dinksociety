// netlify/functions/lib/bracket.js
//
// The back half of a season: Rivalry Week + Playoffs + Championship.
//
// For a 6-team division the round-robin fills weeks 1–5 (every team plays each
// other once). The three weeks AFTER that are seeded off results:
//
//   Week 6  RIVALRY       — counts toward the regular season. Matchups seed off
//                           standings THROUGH the round-robin:  1v2, 3v4, 5v6.
//   Week 7  PLAYOFFS       — seeds off FINAL regular standings (through Wk 6):
//                           Semifinals 1v4 (Game A) & 2v3 (Game B); 5v6 plays a
//                           consolation match for 5th place.
//   Week 8  CHAMPIONSHIP   — built from Week 7 results. Gold/Silver = the two
//                           semifinal WINNERS; Bronze = the two semifinal LOSERS.
//
// This module is pure (no I/O) so it can be unit-tested and reused by:
//   - public-schedule.js  (resolve seed previews for the public page)
//   - admin-matches.js    (resolve seed previews for the admin schedule tab)
//   - admin-generate-schedule.js (write the Wk6–8 placeholder blobs)
//   - lib/standings.js    (lock concrete teams into the blobs once a phase ends)
//
// Seeds are resolved with a WEEK CUTOFF computed from the schedule itself, so a
// rivalry/playoff matchup never re-shuffles retroactively once later weeks are
// played — it is always "rank as of week N", frozen by the cutoff.

import { COURT_SETS } from './courts.js';

export const PHASE = { RIVALRY: 'rivalry', PLAYOFF: 'playoff', CHAMPIONSHIP: 'championship' };

// Round-robin rounds for an even team count (each team plays each other once).
export function regularRounds(numTeams) {
  return Math.max(0, (numTeams | 0) - 1);
}

// Bracket support is defined for a 6-team division (Season 1). Other even counts
// still get a Rivalry week (generic pairing 1v2, 3v4, …); playoffs/championship
// are only emitted for exactly 6 teams.
export function bracketSupported(numTeams) {
  return numTeams === 6;
}

// Slot definitions, relative to the round-robin. `weekOffset` is added to the
// number of round-robin rounds (5 for 6 teams) → Wk6/7/8. `seedA`/`seedB`
// describe where each side comes from:
//   { rank: n }              → the n-th seed by standings at this phase's cutoff
//   { winnerOf: 'semi-A' }   → winner of an earlier bracket slot
//   { loserOf:  'semi-A' }   → loser of an earlier bracket slot
export function bracketSlots(numTeams) {
  if (!bracketSupported(numTeams)) {
    // Generic rivalry only: pair adjacent seeds.
    const ms = [];
    for (let i = 0; i < numTeams; i += 2) {
      ms.push({
        phase: PHASE.RIVALRY, weekOffset: 1, slot: `rivalry-${i / 2 + 1}`,
        group: 'Rivalry', seedA: { rank: i + 1 }, seedB: { rank: i + 2 },
      });
    }
    return ms;
  }
  return [
    // ── Week 6 · Rivalry (regular season) ──
    { phase: PHASE.RIVALRY, weekOffset: 1, slot: 'rivalry-1', group: 'Rivalry', seedA: { rank: 1 }, seedB: { rank: 2 } },
    { phase: PHASE.RIVALRY, weekOffset: 1, slot: 'rivalry-2', group: 'Rivalry', seedA: { rank: 3 }, seedB: { rank: 4 } },
    { phase: PHASE.RIVALRY, weekOffset: 1, slot: 'rivalry-3', group: 'Rivalry', seedA: { rank: 5 }, seedB: { rank: 6 } },
    // ── Week 7 · Playoffs ──
    { phase: PHASE.PLAYOFF, weekOffset: 2, slot: 'semi-A', group: 'Semifinals', gameLabel: 'Game A', championship: true, seedA: { rank: 1 }, seedB: { rank: 4 } },
    { phase: PHASE.PLAYOFF, weekOffset: 2, slot: 'semi-B', group: 'Semifinals', gameLabel: 'Game B', championship: true, seedA: { rank: 2 }, seedB: { rank: 3 } },
    { phase: PHASE.PLAYOFF, weekOffset: 2, slot: 'consolation', group: 'Consolation', placeLabel: '5th place', seedA: { rank: 5 }, seedB: { rank: 6 } },
    // ── Week 8 · Championship ──
    { phase: PHASE.CHAMPIONSHIP, weekOffset: 3, slot: 'gold', group: 'Gold / Silver', medal: '🥇', championship: true, seedA: { winnerOf: 'semi-A' }, seedB: { winnerOf: 'semi-B' } },
    { phase: PHASE.CHAMPIONSHIP, weekOffset: 3, slot: 'bronze', group: 'Bronze', medal: '🥉', championship: true, seedA: { loserOf: 'semi-A' }, seedB: { loserOf: 'semi-B' } },
  ];
}

// Stable id for a bracket placeholder match.
export function bracketMatchId(circuit, division, week, slot) {
  return `m_${circuit}_${String(division).toLowerCase()}_w${week}_${slot}`;
}

// Phase metadata for a week number (given the round-robin size), or null.
export function phaseForWeek(week, numTeams) {
  const R = regularRounds(numTeams);
  if (week === R + 1) return { phase: PHASE.RIVALRY, label: 'Rivalry Week' };
  if (week === R + 2) return { phase: PHASE.PLAYOFF, label: 'Playoffs' };
  if (week === R + 3) return { phase: PHASE.CHAMPIONSHIP, label: 'Championship' };
  return null;
}

// Human seed label for an unresolved side, e.g. "#1 Seed" / "Winner · Game A".
function seedLabel(seed, slotLabels) {
  if (!seed) return 'TBD';
  if (seed.rank) return `#${seed.rank} Seed`;
  if (seed.winnerOf) return `Winner · ${slotLabels[seed.winnerOf] || seed.winnerOf}`;
  if (seed.loserOf) return `Loser · ${slotLabels[seed.loserOf] || seed.loserOf}`;
  return 'TBD';
}

// ── Build the placeholder match objects for the bracket weeks ───────────────
// Returns { [weekNumber]: [match, …] }. Each match carries phase/slot/seed
// metadata plus a rotating court set and empty score fields. teamA/teamB start
// null and are filled in later (resolution preview, or persisted lock).
export function buildBracketWeeks({ circuit, division, numTeams, startWeek }) {
  const R = regularRounds(numTeams);
  const base = startWeek != null ? startWeek - 1 : R; // bracket weeks follow the RR
  const slots = bracketSlots(numTeams);
  const byWeek = {};
  // Court-set assignment per week: distinct sets within a week (A, B, C…).
  const weekCourtCursor = {};
  for (const s of slots) {
    const week = base + s.weekOffset;
    if (!byWeek[week]) byWeek[week] = [];
    const idx = (weekCourtCursor[week] = (weekCourtCursor[week] ?? -1) + 1);
    const set = COURT_SETS[idx % COURT_SETS.length];
    byWeek[week].push({
      id: bracketMatchId(circuit, division, week, s.slot),
      teamA: null, teamB: null,
      phase: s.phase, bracketSlot: s.slot, bracketGroup: s.group,
      gameLabel: s.gameLabel || null, placeLabel: s.placeLabel || null,
      medal: s.medal || null,
      seedA: s.seedA, seedB: s.seedB,
      championship: !!s.championship,
      courtSet: set.id, courtA: set.courtA, courtB: set.courtB,
      court: `Courts ${set.courtA} & ${set.courtB}`,
      scheduledAt: null, startTime: null,
      scoreA: null, scoreB: null, playedAt: null,
    });
  }
  return byWeek;
}

// ── Ranking ─────────────────────────────────────────────────────────────────
// Rank a division's teams from finalized matches with week ≤ cutoffWeek.
// Mirrors lib/standings.js standingsComparator:
//   1. match points for (desc)  2. games won (desc)
//   3. head-to-head match points (desc)  4. rally-point differential (desc)
// Falls back to alphabetical for teams that are still even / unplayed, matching
// the standings page's "no games yet → alphabetical" behaviour.
export function rankTeams({ matches, teamList, cutoffWeek }) {
  const rows = new Map();
  const ensure = (t) => {
    if (!t?.id) return null;
    if (!rows.has(t.id)) {
      rows.set(t.id, {
        id: t.id, name: t.name || '',
        mp: 0, gw: 0, ps: 0, pa: 0, h2h: {},
      });
    }
    const r = rows.get(t.id);
    if (t.name && !r.name) r.name = t.name;
    return r;
  };
  for (const t of (teamList || [])) ensure(t);

  let anyPlayed = false;
  for (const m of (matches || [])) {
    if (!m?.finalizedAt) continue;
    if (cutoffWeek != null && (m.week == null || m.week > cutoffWeek)) continue;
    const a = ensure(m.teamA), b = ensure(m.teamB);
    if (!a || !b) continue;
    anyPlayed = true;
    const mpA = m.scoreA ?? 0, mpB = m.scoreB ?? 0;
    a.mp += mpA; b.mp += mpB;
    const r1 = m.round1 || {}, r2 = m.round2 || {};
    a.gw += (r1.homeGames || 0) + (r2.homeGames || 0);
    b.gw += (r1.awayGames || 0) + (r2.awayGames || 0);
    // Rally points: prefer per-match totals, else derive from round games.
    const psA = m.pointsA, psB = m.pointsB;
    if (psA != null && psB != null) { a.ps += psA; a.pa += psB; b.ps += psB; b.pa += psA; }
    a.h2h[b.id] = (a.h2h[b.id] || 0) + mpA;
    b.h2h[a.id] = (b.h2h[a.id] || 0) + mpB;
  }

  const list = [...rows.values()];
  if (!anyPlayed) {
    return list.sort((x, y) => String(x.name).localeCompare(String(y.name)))
      .map(r => ({ id: r.id, name: r.name }));
  }
  list.sort((x, y) => {
    if (y.mp !== x.mp) return y.mp - x.mp;
    if (y.gw !== x.gw) return y.gw - x.gw;
    const xy = x.h2h[y.id], yx = y.h2h[x.id];
    if (xy != null && yx != null && xy !== yx) return yx - xy;
    const xd = x.ps - x.pa, yd = y.ps - y.pa;
    if (yd !== xd) return yd - xd;
    return String(x.name).localeCompare(String(y.name));
  });
  return list.map(r => ({ id: r.id, name: r.name }));
}

// Winner/loser of a finalized match (by match points, then games). null if not
// finalized or tied with no separator.
export function matchResult(m) {
  if (!m || !m.finalizedAt || !m.teamA?.id || !m.teamB?.id) return null;
  const mpA = m.scoreA ?? 0, mpB = m.scoreB ?? 0;
  let aWins = mpA > mpB;
  if (mpA === mpB) {
    const r1 = m.round1 || {}, r2 = m.round2 || {};
    const gwA = (r1.homeGames || 0) + (r2.homeGames || 0);
    const gwB = (r1.awayGames || 0) + (r2.awayGames || 0);
    if (gwA === gwB) return null; // genuine tie — no winner to advance
    aWins = gwA > gwB;
  }
  const w = aWins ? m.teamA : m.teamB;
  const l = aWins ? m.teamB : m.teamA;
  return { winner: { id: w.id, name: w.name }, loser: { id: l.id, name: l.name } };
}

// Count finalized matches in weeks [1..cutoff].
function countFinalizedThrough(matches, cutoff) {
  let n = 0;
  for (const m of (matches || [])) {
    if (m?.finalizedAt && m.week != null && m.week <= cutoff) n++;
  }
  return n;
}

// ── Resolve seed previews for the bracket weeks ─────────────────────────────
// Inputs:
//   realMatches   – every non-bracket (round-robin) match, each with .week,
//                   .teamA/.teamB {id,name}, .scoreA/.scoreB, .round1/.round2,
//                   .pointsA/.pointsB, .finalizedAt
//   bracketMatches – the placeholder matches (from blobs or buildBracketWeeks),
//                    each with phase/bracketSlot/seedA/seedB/.week and possibly
//                    already-locked teamA/teamB + scores
//   teamList      – [{id,name}] every team in the division (for a baseline order)
//   numTeams      – team count (defines the round-robin size / phase weeks)
//
// Returns the bracket matches enriched with resolved teamA/teamB (when known),
// seedLabelA/seedLabelB, and seedLocked (true once the source phase is complete
// so the matchup can no longer change). Does NOT mutate inputs.
export function resolveBracketDisplay({ realMatches, bracketMatches, teamList, numTeams }) {
  const R = regularRounds(numTeams);
  const perWin = numTeams / 2;            // matches per round-robin week
  const expectedRR = R * perWin;          // full round-robin match count

  const slotLabels = {};
  for (const s of bracketSlots(numTeams)) slotLabels[s.slot] = s.gameLabel || s.group;

  // Phase-completion gates (how many regular matches are in the books).
  const rrFinal = countFinalizedThrough(realMatches, R);
  const rivalryLocked = expectedRR > 0 && rrFinal >= expectedRR;

  // Resolve in dependency order: rivalry → playoff → championship.
  const bySlot = {};
  const out = [];

  const order = { [PHASE.RIVALRY]: 0, [PHASE.PLAYOFF]: 1, [PHASE.CHAMPIONSHIP]: 2 };
  const sorted = [...bracketMatches].sort(
    (a, b) => (order[a.phase] ?? 9) - (order[b.phase] ?? 9)
  );

  // Rank snapshots, computed lazily.
  let ranksThruRR = null, ranksThruRivalry = null;
  const getRanksRR = () => (ranksThruRR ||= rankTeams({ matches: realMatches, teamList, cutoffWeek: R }));
  const getRanksRivalry = () => {
    if (ranksThruRivalry) return ranksThruRivalry;
    // Rivalry counts toward the regular season, so include locked+finalized
    // rivalry matches at week R+1 in the standings used to seed the playoffs.
    const rivalryFinals = sorted
      .filter(m => m.phase === PHASE.RIVALRY)
      .map(m => bySlot[m.bracketSlot])
      .filter(m => m && m.finalizedAt);
    ranksThruRivalry = rankTeams({
      matches: [...realMatches, ...rivalryFinals], teamList, cutoffWeek: R + 1,
    });
    return ranksThruRivalry;
  };

  for (const m of sorted) {
    const phaseObj = phaseForWeek(m.week, numTeams) || { phase: m.phase };
    let teamA = m.teamA || null, teamB = m.teamB || null; // honour a persisted lock
    let locked = false;
    let labelA = seedLabel(m.seedA, slotLabels);
    let labelB = seedLabel(m.seedB, slotLabels);

    if (m.phase === PHASE.RIVALRY) {
      const ranks = getRanksRR();
      teamA = teamA || pickRank(ranks, m.seedA);
      teamB = teamB || pickRank(ranks, m.seedB);
      locked = rivalryLocked;
    } else if (m.phase === PHASE.PLAYOFF) {
      const ranks = getRanksRivalry();
      teamA = teamA || pickRank(ranks, m.seedA);
      teamB = teamB || pickRank(ranks, m.seedB);
      // Playoffs lock once the full regular season (RR + rivalry) is final.
      const rivFinal = sorted.filter(x => x.phase === PHASE.RIVALRY)
        .every(x => bySlot[x.bracketSlot]?.finalizedAt);
      locked = rivalryLocked && rivFinal;
    } else if (m.phase === PHASE.CHAMPIONSHIP) {
      teamA = teamA || pickFromSlot(bySlot, m.seedA);
      teamB = teamB || pickFromSlot(bySlot, m.seedB);
      const semiA = bySlot['semi-A'], semiB = bySlot['semi-B'];
      locked = !!(semiA?.finalizedAt && semiB?.finalizedAt);
    }

    const resolved = {
      ...m,
      teamA: teamA || null,
      teamB: teamB || null,
      seedLabelA: labelA,
      seedLabelB: labelB,
      seedLocked: locked,
      phase: m.phase,
      phaseLabel: phaseObj.label || null,
    };
    bySlot[m.bracketSlot] = resolved;
    out.push(resolved);
  }
  return out;
}

function pickRank(ranks, seed) {
  if (!seed?.rank || !Array.isArray(ranks)) return null;
  const t = ranks[seed.rank - 1];
  return t ? { id: t.id, name: t.name } : null;
}

function pickFromSlot(bySlot, seed) {
  if (!seed) return null;
  const slot = seed.winnerOf || seed.loserOf;
  if (!slot) return null;
  const src = bySlot[slot];
  if (!src) return null;
  const res = matchResult(src);
  if (!res) return null;
  return seed.winnerOf ? res.winner : res.loser;
}
