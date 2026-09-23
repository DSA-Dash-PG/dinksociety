// netlify/functions/admin-season-pulse.js
// Admin-only "what needs me this week" rollup for the Overview tab. One call
// that reads what the other admin endpoints don't expose in aggregate:
//
//   GET ?circuit=II[&week=N]
//   → {
//       week, weekMatches:[{id, division, teamA, teamB, scheduledAt, venue, final}],
//       nextMatchAt, venues:[...],
//       availability:[{teamId, name, division, in, out, none, total, matchId}],
//       waivers:[{id, title, signed, total, missing:[{name, teamName}]}],
//       standings:{ lastUpdated, stale, staleCount,
//                   divisions:[{id, teams:[{teamId, name, rank, prevRank, delta, wins, losses, ties, pointDiff, matchesPlayed}]}] },
//       completedWeeks
//     }
//
// Rank movement: every time the number of fully-finalized weeks grows, the
// current ranks are snapshotted to standings store `snapshot/<circuit>/<n>.json`
// (n = completed weeks). "Since last week" compares against snapshot n-1.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { circuitCode, isTestTeam } from './lib/circuit.js';
import { rosterWaiverGaps } from './lib/waiver.js';
import { getTeamAvailability } from './lib/availability.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);

  const url = new URL(req.url);
  const circuit = circuitCode(url.searchParams.get('circuit') || 'I');
  const weekParam = parseInt(url.searchParams.get('week'), 10);

  const scheduleStore = getStore('schedule');
  const teamsStore = getStore('teams');
  const standingsStore = getStore('standings');

  // ── Teams in this season ──
  const { blobs: teamBlobs } = await teamsStore.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));
  const teams = (await Promise.all(teamBlobs.map(b => teamsStore.get(b.key, { type: 'json' }).catch(() => null))))
    .filter(t => t && !isTestTeam(t) && circuitCode(t.circuit) === circuit);
  const teamById = new Map(teams.map(t => [t.id, t]));

  // ── Schedule: every week's matches ──
  const { blobs: schedBlobs } = await scheduleStore.list({ prefix: `schedule/${circuit}/` }).catch(() => ({ blobs: [] }));
  const weekFiles = {}; // week → [{division, matches}]
  for (const b of schedBlobs) {
    const m = b.key.match(/schedule\/[^/]+\/([^/]+)\/week-(\d+)\.json$/);
    if (!m) continue;
    const data = await scheduleStore.get(b.key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    (weekFiles[+m[2]] ||= []).push({ division: m[1], matches: data.matches });
  }
  const allWeeks = Object.keys(weekFiles).map(Number).sort((a, b) => a - b);

  // Completed weeks = weeks whose every match (that has two teams) is finalized.
  let completedWeeks = 0;
  let latestFinalizedAt = null;
  for (const w of allWeeks) {
    const ms = weekFiles[w].flatMap(f => f.matches).filter(mt => mt.teamA?.id && mt.teamB?.id);
    for (const mt of ms) if (mt.finalizedAt && (!latestFinalizedAt || mt.finalizedAt > latestFinalizedAt)) latestFinalizedAt = mt.finalizedAt;
    if (ms.length && ms.every(mt => mt.finalizedAt)) completedWeeks = w; else break;
  }

  // Current week: same rule as admin-gameday — soonest unfinished dated match.
  let week = Number.isInteger(weekParam) && weekFiles[weekParam] ? weekParam : null;
  if (!week) {
    const now = Date.now(), RECENT = 6 * 3600000;
    let upcoming = null, anyDated = null, lowestUnfinished = null;
    for (const w of allWeeks) for (const f of weekFiles[w]) for (const mt of f.matches) {
      if (mt.finalizedAt) continue;
      if (lowestUnfinished == null) lowestUnfinished = w;
      const t = mt.scheduledAt ? Date.parse(mt.scheduledAt) : NaN;
      if (Number.isNaN(t)) continue;
      if (!anyDated || t < anyDated.t) anyDated = { week: w, t };
      if (t >= now - RECENT && (!upcoming || t < upcoming.t)) upcoming = { week: w, t };
    }
    week = (upcoming || anyDated)?.week ?? lowestUnfinished ?? allWeeks[allWeeks.length - 1] ?? null;
  }

  // ── This week's matches + availability per team ──
  const weekMatches = [];
  const availability = [];
  let nextMatchAt = null;
  const venues = new Set();
  if (week) {
    for (const { division, matches } of weekFiles[week]) {
      for (const mt of matches) {
        weekMatches.push({
          id: mt.id, division,
          teamA: { id: mt.teamA?.id || null, name: mt.teamA?.name || '' },
          teamB: { id: mt.teamB?.id || null, name: mt.teamB?.name || '' },
          scheduledAt: mt.scheduledAt || null, venue: mt.venue || null, final: !!mt.finalizedAt,
        });
        if (mt.venue) venues.add(mt.venue);
        if (mt.scheduledAt && !mt.finalizedAt && (!nextMatchAt || mt.scheduledAt < nextMatchAt)) nextMatchAt = mt.scheduledAt;
        for (const side of [mt.teamA, mt.teamB]) {
          const t = side?.id && teamById.get(side.id);
          if (!t) continue;
          const roster = (t.roster || []).filter(p => p.id && !p.archived && !p.pendingAdd);
          const rec = await getTeamAvailability(mt.id, t.id);
          let inN = 0, outN = 0;
          for (const p of roster) {
            const st = rec.players?.[p.id]?.status;
            if (st === 'in') inN++; else if (st === 'out') outN++;
          }
          availability.push({
            teamId: t.id, name: t.name, division: t.divisionLabel || t.division || division, matchId: mt.id,
            in: inN, out: outN, none: roster.length - inN - outN, total: roster.length, final: !!mt.finalizedAt,
          });
        }
      }
    }
  }

  // ── Waivers: every active waiver, who's missing (same identity-aware rule
  // the captain portal uses, so both agree) ──
  const waivers = [];
  try {
    const byId = new Map(); // waiverId → { id, title, signed, total, missing[] }
    for (const t of teams) {
      const gaps = await rosterWaiverGaps(t, circuit);
      for (const g of gaps) {
        const w = byId.get(g.id) || { id: g.id, title: g.title, signed: 0, total: 0, missing: [] };
        w.signed += g.signed.length; w.total += g.signed.length + g.missing.length;
        for (const p of g.missing) w.missing.push({ playerId: p.id, name: p.name || '', teamName: t.name || '' });
        byId.set(g.id, w);
      }
    }
    for (const w of byId.values()) {
      w.missing.sort((a, b) => a.teamName.localeCompare(b.teamName) || a.name.localeCompare(b.name));
      waivers.push(w);
    }
  } catch (e) { console.error('pulse waivers:', e); }

  // ── Standings snapshot + movement ──
  let standings = { lastUpdated: null, stale: false, staleCount: 0, divisions: [] };
  try {
    const blob = await standingsStore.get(`standings/${circuit}.json`, { type: 'json' }).catch(() => null);
    if (blob) {
      const lastUpdated = blob.lastUpdated || null;
      // A match finalized after the last rebuild means the table is behind.
      let staleCount = 0;
      for (const w of allWeeks) for (const f of weekFiles[w]) for (const mt of f.matches) {
        if (mt.finalizedAt && lastUpdated && mt.finalizedAt > lastUpdated) staleCount++;
      }
      const cur = {}; // teamId → rank
      const divisions = [];
      for (const [id, d] of Object.entries(blob.divisions || {})) {
        const rows = (d.teams || []).map(t => {
          cur[t.teamId] = t.rank;
          return { teamId: t.teamId, name: t.teamName, rank: t.rank, wins: t.wins || 0, losses: t.losses || 0, ties: t.ties || 0,
            pointDiff: t.pointDiff || 0, matchesPlayed: t.matchesPlayed || 0, matchPointsFor: t.matchPointsFor || 0, prevRank: null, delta: null };
        });
        divisions.push({ id, label: teams.find(t => t.division === id)?.divisionLabel || id, teams: rows });
      }
      // Snapshot current ranks under the completed-week count, compare to the one before.
      if (completedWeeks > 0) {
        const key = n => `snapshot/${circuit}/${n}.json`;
        const have = await standingsStore.get(key(completedWeeks), { type: 'json' }).catch(() => null);
        if (!have) await standingsStore.setJSON(key(completedWeeks), { week: completedWeeks, at: new Date().toISOString(), ranks: cur }).catch(() => {});
        const prev = completedWeeks > 1 ? await standingsStore.get(key(completedWeeks - 1), { type: 'json' }).catch(() => null) : null;
        if (prev?.ranks) for (const d of divisions) for (const r of d.teams) {
          if (prev.ranks[r.teamId] != null) { r.prevRank = prev.ranks[r.teamId]; r.delta = r.prevRank - r.rank; }
        }
      }
      standings = { lastUpdated, stale: staleCount > 0, staleCount, divisions };
    }
  } catch (e) { console.error('pulse standings:', e); }

  return json({
    circuit, week, weeks: allWeeks, completedWeeks, latestFinalizedAt,
    weekMatches, nextMatchAt, venues: [...venues],
    availability, waivers, standings,
    teamCount: teams.length,
  });
};

export const config = { path: '/.netlify/functions/admin-season-pulse' };
