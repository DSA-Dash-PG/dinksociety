// netlify/functions/lib/drop-stats.js
//
// PURE "story fodder" math for The Drop — no I/O, no dependencies, so it can be
// unit-tested directly (the sandbox has no node_modules). drop-insights.js
// imports these and adds the blob-backed loaders on top.
//
// Match shape (flattened by loadFinalizedMatches in drop-insights.js):
//   { week, division, a:{id,name}, b:{id,name}, pa, pb, gamesA, gamesB, sweep }

/** The latest week that has at least one finalized match. 0 if none. */
export function latestPlayedWeek(matches) {
  return matches.reduce((mx, m) => Math.max(mx, m.week || 0), 0);
}

/**
 * teamId → { id, name, division, games: [ ordered by week ] } where each game is
 * { week, won, tie, oppId, oppName, pointsFor, pointsAgainst, gamesFor, gamesAgainst, sweep }
 */
export function buildTimelines(matches) {
  const t = new Map();
  const push = (id, name, division, entry) => {
    if (!id) return;
    if (!t.has(id)) t.set(id, { id, name, division, games: [] });
    const rec = t.get(id);
    rec.name = name || rec.name;
    rec.games.push(entry);
  };
  for (const m of matches) {
    const aWon = m.pa > m.pb, bWon = m.pb > m.pa, tie = m.pa === m.pb;
    push(m.a.id, m.a.name, m.division, { week: m.week, won: aWon, tie, oppId: m.b.id, oppName: m.b.name, pointsFor: m.pa, pointsAgainst: m.pb, gamesFor: m.gamesA, gamesAgainst: m.gamesB, sweep: m.pa === 4 && m.pb === 0 });
    push(m.b.id, m.b.name, m.division, { week: m.week, won: bWon, tie, oppId: m.a.id, oppName: m.a.name, pointsFor: m.pb, pointsAgainst: m.pa, gamesFor: m.gamesB, gamesAgainst: m.gamesA, sweep: m.pb === 4 && m.pa === 0 });
  }
  for (const rec of t.values()) rec.games.sort((x, y) => x.week - y.week);
  return t;
}

/** Active win streaks (consecutive wins ending at a team's latest game), longest first. */
export function computeStreaks(timelines) {
  const out = [];
  for (const rec of timelines.values()) {
    let streak = 0;
    for (const g of rec.games) streak = g.won ? streak + 1 : 0;
    if (streak >= 2) out.push({ teamId: rec.id, name: rec.name, division: rec.division, streak });
  }
  return out.sort((a, b) => b.streak - a.streak);
}

// Cumulative match points + W/L for a team STRICTLY BEFORE a week.
function recordBefore(rec, week) {
  let points = 0, wins = 0, losses = 0, ties = 0, played = 0;
  for (const g of (rec?.games || [])) {
    if (g.week >= week) continue;
    points += g.pointsFor; played++;
    if (g.tie) ties++; else if (g.won) wins++; else losses++;
  }
  return { points, wins, losses, ties, played };
}

/**
 * Upsets in `targetWeek`: the winner came in with a worse record than the team
 * they beat — most dramatic when the loser was previously unbeaten.
 */
export function detectUpsets(matches, timelines, targetWeek) {
  const out = [];
  for (const m of matches) {
    if (m.week !== targetWeek || m.pa === m.pb) continue;
    const winner = m.pa > m.pb ? m.a : m.b;
    const loser = m.pa > m.pb ? m.b : m.a;
    const wRec = recordBefore(timelines.get(winner.id), targetWeek);
    const lRec = recordBefore(timelines.get(loser.id), targetWeek);
    const loserWasUnbeaten = lRec.played > 0 && lRec.losses === 0;
    const gap = lRec.points - wRec.points;
    if ((loserWasUnbeaten && lRec.played >= 1) || gap >= 3) {
      out.push({
        week: targetWeek, division: m.division,
        winner: winner.name, loser: loser.name,
        score: `${Math.max(m.pa, m.pb)}–${Math.min(m.pa, m.pb)}`,
        loserWasUnbeaten, priorGap: gap,
        loserPriorRecord: `${lRec.wins}–${lRec.losses}`,
        winnerPriorRecord: `${wRec.wins}–${wRec.losses}`,
      });
    }
  }
  return out.sort((a, b) => (b.loserWasUnbeaten - a.loserWasUnbeaten) || (b.priorGap - a.priorGap));
}

/** Sweeps / blowouts (4–0 match results) in `targetWeek`. */
export function detectBlowouts(matches, targetWeek) {
  return matches
    .filter(m => m.week === targetWeek && m.sweep)
    .map(m => {
      const winner = m.pa > m.pb ? m.a : m.b;
      const loser = m.pa > m.pb ? m.b : m.a;
      return { week: targetWeek, division: m.division, winner: winner.name, loser: loser.name, score: '4–0' };
    });
}
