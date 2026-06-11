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
        const t = (div.teams || []).find(x => x.teamId === ids[0]);
        if (t) teamOfWeek = { name: t.teamName, emoji: t.teamEmoji || null, record: `${t.wins || 0}–${t.losses || 0}`, note: null };
        break;
      }
    }
    if (teamOfWeek) break;
  }

  let risers = [];
  const ps = await getStore('player-stats').get(`player-stats/${code}.json`, { type: 'json' }).catch(() => null);
  if (ps && ps.players) {
    risers = Object.values(ps.players)
      .filter(p => Number.isFinite(p.rankDelta) && p.rankDelta !== 0)
      .sort((a, b) => b.rankDelta - a.rankDelta)
      .slice(0, 4)
      .map(p => ({ name: p.name, teamName: p.teamName || null, delta: Math.abs(p.rankDelta), dir: p.rankDelta >= 0 ? 'up' : 'dn' }));
  }

  return normPerformers({
    potw: {
      men: pm && { name: pm.name, teamName: pm.teamName, w: pm.w, l: pm.l, dsr: pm.dsr, diff: pm.diff },
      women: pf && { name: pf.name, teamName: pf.teamName, w: pf.w, l: pf.l, dsr: pf.dsr, diff: pf.diff },
    },
    teamOfWeek, risers,
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
