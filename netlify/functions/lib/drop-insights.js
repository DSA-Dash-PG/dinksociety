// netlify/functions/lib/drop-insights.js
//
// Reads a circuit's finalized results + aggregates and distills the raw
// "story fodder" for The Drop: win streaks, upsets, blowouts, risers, and the
// week's performers. The weekly scheduled generator (drop-generate.js) feeds
// this brief to the model; the pure helpers live in drop-stats.js (no
// @netlify/blobs import) so they stay unit-testable.

import { getStore } from '@netlify/blobs';
import { circuitCode } from './circuit.js';
import { normPerformers } from './drop.js';
import {
  latestPlayedWeek, buildTimelines, computeStreaks, detectUpsets, detectBlowouts,
} from './drop-stats.js';

// Re-export the pure helpers so existing importers keep working.
export { latestPlayedWeek, buildTimelines, computeStreaks, detectUpsets, detectBlowouts };

/** Load every FINALIZED match for a circuit, flattened + normalized. */
export async function loadFinalizedMatches(circuit) {
  const code = circuitCode(circuit);
  const store = getStore({ name: 'schedule', consistency: 'strong' });
  const { blobs } = await store.list({ prefix: `schedule/${code}/` }).catch(() => ({ blobs: [] }));
  const out = [];
  for (const b of blobs) {
    const data = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    for (const m of data.matches) {
      if (!m.finalizedAt) continue;
      const r1 = m.round1 || { homeGames: 0, awayGames: 0 };
      const r2 = m.round2 || { homeGames: 0, awayGames: 0 };
      const gamesA = (r1.homeGames || 0) + (r2.homeGames || 0);
      const gamesB = (r1.awayGames || 0) + (r2.awayGames || 0);
      const pa = m.scoreA ?? 0, pb = m.scoreB ?? 0;
      out.push({
        week: data.week, division: data.division,
        a: { id: m.teamA?.id, name: m.teamA?.name }, b: { id: m.teamB?.id, name: m.teamB?.name },
        pa, pb, gamesA, gamesB,
        sweep: (pa === 4 && pb === 0) || (pb === 4 && pa === 0),
        finalizedAt: m.finalizedAt, scheduledAt: m.scheduledAt || null,
      });
    }
  }
  return out;
}

/**
 * Pull the freshest performers (POTW M/F, Team of the Week, DSR risers) for a
 * circuit from the standings + player-stats aggregates, normalized for storage.
 * Shared by admin-drop (publish snapshot) and the generator brief.
 */
export async function livePerformers(circuit) {
  const code = circuitCode(circuit);
  const standings = await getStore('standings').get(`standings/${code}.json`, { type: 'json' }).catch(() => null);
  if (!standings) return normPerformers();

  const perf = Array.isArray(standings.weeklyTopPerformers) ? standings.weeklyTopPerformers : [];
  const latest = perf.length ? perf[0] : null;
  const top = (arr) => (Array.isArray(arr) && arr[0]) ? arr[0] : null;
  const pm = latest ? top(latest.men) : null;
  const pf = latest ? top(latest.women) : null;

  let teamOfWeek = null;
  for (const div of Object.values(standings.divisions || {})) {
    const wt = div.weeklyTopTeams || {};
    const wks = Object.keys(wt).map(Number).sort((a, b) => b - a);
    for (const w of wks) {
      const ids = wt[w];
      if (ids && ids.length) {
        // Several teams can tie on weekly match points (e.g. two 4–0 sweeps both
        // earn 4). Don't take the arbitrary first entry — break the tie by the
        // genuinely better week: game differential, then games won, then overall
        // Circuit rank, then total points.
        const tied = ids.map(id => (div.teams || []).find(x => x.teamId === id)).filter(Boolean);
        const gd = t => (t.totalGamesWon || 0) - (t.totalGamesLost || 0);
        tied.sort((a, b) =>
          gd(b) - gd(a) ||
          (b.totalGamesWon || 0) - (a.totalGamesWon || 0) ||
          (a.rank || 99) - (b.rank || 99) ||
          (b.societyCircuitPoints || 0) - (a.societyCircuitPoints || 0)
        );
        const t = tied[0];
        // Show the match-point score (the recognizable "4–0" sweep on the
        // scoreboard/standings) rather than the per-round W–L tally, which reads
        // as a confusing "2–0" for a team that swept both rounds.
        if (t) teamOfWeek = { name: t.teamName, emoji: t.teamEmoji || null, record: `${t.matchPointsFor || 0}–${t.matchPointsAgainst || 0}`, note: null };
        break;
      }
    }
    if (teamOfWeek) break;
  }

  let risers = [], climbers = [];
  const ps = await getStore('player-stats').get(`player-stats/${code}.json`, { type: 'json' }).catch(() => null);
  if (ps && ps.players) {
    const all = Object.values(ps.players);
    risers = all
      .filter(p => Number.isFinite(p.rankDelta) && p.rankDelta !== 0)
      .sort((a, b) => b.rankDelta - a.rankDelta)
      .slice(0, 4)
      .map(p => ({ name: p.name, teamName: p.teamName || null, delta: Math.abs(p.rankDelta), dir: p.rankDelta >= 0 ? 'up' : 'dn' }));

    // Top Climbers — players who GAINED the most DSR rank spots this week.
    // Current overall rank from season DSR; fromRank = current + spots gained.
    // Season rating lives on p.composite (p.dsr is only on per-week snapshots).
    const ranked = all.filter(p => Number.isFinite(p.composite))
      .sort((a, b) => b.composite - a.composite);
    const rankOf = new Map();
    ranked.forEach((p, i) => rankOf.set(p.playerId ?? p.name, i + 1));
    climbers = all
      .filter(p => Number.isFinite(p.rankDelta) && p.rankDelta > 0)
      .sort((a, b) => b.rankDelta - a.rankDelta)
      .slice(0, 6)
      .map(p => {
        const rank = rankOf.get(p.playerId ?? p.name) ?? null;
        return {
          name: p.name, teamName: p.teamName || null, delta: p.rankDelta,
          rank, fromRank: rank != null ? rank + p.rankDelta : null,
        };
      });
  }

  // Tabbed Top Performers (top 6 × dsr/diff/pts × M/F) from the week's leaders.
  const topPerformers = (latest && latest.leaders) ? latest.leaders : null;

  return normPerformers({
    potw: {
      men: pm && { name: pm.name, teamName: pm.teamName, w: pm.w, l: pm.l, dsr: pm.dsr, diff: pm.diff, ps: pm.ps },
      women: pf && { name: pf.name, teamName: pf.teamName, w: pf.w, l: pf.l, dsr: pf.dsr, diff: pf.diff, ps: pf.ps },
    },
    teamOfWeek, risers, climbers, topPerformers,
  });
}

/** Assemble the full weekly brief the model writes from. Defaults to the latest
 *  played week; pass `weekOverride` to brief a specific earlier week. */
export async function buildWeeklyBrief(circuit, weekOverride = null) {
  const code = circuitCode(circuit);
  const matches = await loadFinalizedMatches(code);
  const latest = latestPlayedWeek(matches);
  const week = weekOverride ? Number(weekOverride) : latest;
  if (!week || !matches.some(m => m.week === week)) return { circuit: code, week: week || 0, empty: true };

  const timelines = buildTimelines(matches);
  const weekMatches = matches.filter(m => m.week === week).map(m => {
    const winner = m.pa > m.pb ? m.a.name : (m.pb > m.pa ? m.b.name : null);
    return { division: m.division, teamA: m.a.name, teamB: m.b.name, score: `${m.pa}–${m.pb}`, winner, sweep: m.sweep };
  });

  let date = null;
  for (const m of matches) {
    if (m.week === week && m.scheduledAt && (!date || new Date(m.scheduledAt) < new Date(date))) date = m.scheduledAt;
  }

  const performers = await livePerformers(code);

  return {
    circuit: code,
    week,
    date,
    results: weekMatches,
    streaks: computeStreaks(timelines).slice(0, 5),
    upsets: detectUpsets(matches, timelines, week).slice(0, 4),
    blowouts: detectBlowouts(matches, week).slice(0, 4),
    performers,
  };
}
