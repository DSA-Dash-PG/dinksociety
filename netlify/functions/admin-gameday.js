// netlify/functions/admin-gameday.js
// Admin-only league-wide game-day snapshot for one week, across all divisions.
// GET ?circuit=I[&week=N]   (week optional → auto-picks the current week:
//                            the lowest week that still has a non-final match,
//                            else the highest week that has any matches)
//
// Returns live status, live match points, per-team lineup-lock state, KPIs and
// alerts — everything the mobile admin "Tonight" command center needs.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { isRevealTime } from './lib/lineup-helpers.js';

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);

  const url = new URL(req.url);
  const circuit = url.searchParams.get('circuit') || 'I';
  const weekParam = url.searchParams.get('week');

  const scheduleStore = getStore('schedule');
  const lineupStore = getStore('lineups');
  const scoresStore = getStore('scores');
  const teamsStore = getStore('teams');
  const standingsStore = getStore('standings');

  // When the standings/leaderboard aggregate was last rebuilt (Overview health card).
  const standingsBlob = await standingsStore.get(`standings/${circuit}.json`, { type: 'json' }).catch(() => null);
  const standingsUpdatedAt = standingsBlob?.lastUpdated || null;

  // Discover every division/week file for this circuit.
  const { blobs } = await scheduleStore.list({ prefix: `schedule/${circuit}/` });
  const weekFiles = {}; // week -> [ {division, data} ]
  for (const b of blobs) {
    const m = b.key.match(/schedule\/[^/]+\/([^/]+)\/week-(\d+)\.json$/);
    if (!m) continue;
    const division = m[1], week = parseInt(m[2], 10);
    const data = await scheduleStore.get(b.key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    (weekFiles[week] = weekFiles[week] || []).push({ division, data });
  }

  const allWeeks = Object.keys(weekFiles).map(Number).sort((a, b) => a - b);
  if (!allWeeks.length) {
    return json({ circuit, week: null, matches: [], kpis: emptyKpis(), lineupLocks: { lockedTeams: 0, totalTeams: 0, notLocked: [] }, alerts: { notLockedCount: 0, liveCount: 0, pendingApprovalCount: 0, priorIncompleteCount: 0 }, pendingApproval: [], priorIncomplete: [], standingsUpdatedAt });
  }

  // Pick the week.
  let week = weekParam ? parseInt(weekParam, 10) : null;
  if (!week || !weekFiles[week]) {
    week = allWeeks.find(w => weekFiles[w].some(f => (f.data.matches || []).some(mt => !mt.finalizedAt)))
      || allWeeks[allWeeks.length - 1];
  }

  // Team emoji lookup (one pass).
  const emojiById = new Map();
  const { blobs: teamBlobs } = await teamsStore.list({ prefix: 'team/' });
  for (const tb of teamBlobs) {
    const t = await teamsStore.get(tb.key, { type: 'json' }).catch(() => null);
    if (t?.id) emojiById.set(t.id, t.emoji || null);
  }

  const matches = [];
  const notLocked = [];
  const lockedTeamIds = new Set();
  const allTeamIds = new Set();
  const pendingApproval = [];

  // Matches in EARLIER weeks that never got finalized — stale scoresheets that
  // silently corrupt standings. Derived from the schedule blobs already loaded.
  const priorIncomplete = [];
  for (const w of allWeeks) {
    if (w >= week) continue;
    for (const { division, data } of weekFiles[w]) {
      for (const mt of data.matches || []) {
        if (mt.finalizedAt) continue;
        priorIncomplete.push({
          week: w, division, matchId: mt.id,
          name: `${mt.teamA?.name || '?'} vs ${mt.teamB?.name || '?'}`,
        });
      }
    }
  }

  for (const { division, data } of weekFiles[week]) {
    for (const mt of data.matches || []) {
      const aId = mt.teamA?.id, bId = mt.teamB?.id;
      const [la, lb, sc] = await Promise.all([
        aId ? lineupStore.get(`lineup/${mt.id}/${aId}.json`, { type: 'json' }).catch(() => null) : null,
        bId ? lineupStore.get(`lineup/${mt.id}/${bId}.json`, { type: 'json' }).catch(() => null) : null,
        scoresStore.get(`score/${mt.id}.json`, { type: 'json' }).catch(() => null),
      ]);
      const aLocked = !!la?.lockedAt, bLocked = !!lb?.lockedAt;
      const bothLocked = aLocked && bLocked;
      // A match is only "live" once it has REVEALED — both lineups locked AND
      // we're inside the reveal window (15 min before start). Before that a
      // both-locked match is just "ready", not live. (Without the time gate the
      // admin showed matches as live hours early the moment captains locked.)
      const revealed = bothLocked && isRevealTime(mt.scheduledAt);
      const final = !!mt.finalizedAt;

      // Match points: finalized → stored; otherwise compute live from the sheet.
      let mpHome, mpAway;
      if (final) { mpHome = mt.scoreA ?? 0; mpAway = mt.scoreB ?? 0; }
      else { const lp = liveMatchPoints(sc?.games); mpHome = lp.home; mpAway = lp.away; }

      const status = final ? 'final' : revealed ? 'live' : 'awaiting';

      // One captain has signed off but the other hasn't → sheet is stuck
      // waiting on dual approval.
      if (!final && sc && (sc.homeSubmittedAt || sc.awaySubmittedAt)) {
        const waitingOn = !sc.homeSubmittedAt ? (mt.teamA?.name || 'home')
          : !sc.awaySubmittedAt ? (mt.teamB?.name || 'away') : null;
        if (waitingOn) {
          pendingApproval.push({
            matchId: mt.id, division,
            name: `${mt.teamA?.name || '?'} vs ${mt.teamB?.name || '?'}`,
            waitingOn,
          });
        }
      }

      if (aId) { allTeamIds.add(aId); (aLocked ? lockedTeamIds : null)?.add(aId); }
      if (bId) { allTeamIds.add(bId); (bLocked ? lockedTeamIds : null)?.add(bId); }
      if (!final) {
        if (aId && !aLocked) notLocked.push({ matchId: mt.id, division, team: { id: aId, name: mt.teamA?.name || '' }, side: 'home' });
        if (bId && !bLocked) notLocked.push({ matchId: mt.id, division, team: { id: bId, name: mt.teamB?.name || '' }, side: 'away' });
      }

      matches.push({
        id: mt.id, division,
        teamA: { id: aId, name: mt.teamA?.name || '', emoji: emojiById.get(aId) || null },
        teamB: { id: bId, name: mt.teamB?.name || '', emoji: emojiById.get(bId) || null },
        courtA: mt.courtA ?? null, courtB: mt.courtB ?? null, court: mt.court || null,
        championship: !!mt.championship,
        scheduledAt: mt.scheduledAt || null,
        final, revealed, aLocked, bLocked, status,
        mpHome, mpAway,
      });
    }
  }

  // Order: live → awaiting → final, then by court.
  const rank = { live: 0, awaiting: 1, final: 2 };
  matches.sort((a, b) => (rank[a.status] - rank[b.status]) || ((a.courtA ?? 99) - (b.courtA ?? 99)));

  const kpis = {
    total: matches.length,
    live: matches.filter(m => m.status === 'live').length,
    final: matches.filter(m => m.status === 'final').length,
    toStart: matches.filter(m => m.status === 'awaiting').length,
  };

  return json({
    circuit, week,
    matches,
    kpis,
    lineupLocks: { lockedTeams: lockedTeamIds.size, totalTeams: allTeamIds.size, notLocked },
    alerts: {
      notLockedCount: notLocked.length,
      liveCount: kpis.live,
      pendingApprovalCount: pendingApproval.length,
      priorIncompleteCount: priorIncomplete.length,
    },
    pendingApproval,
    priorIncomplete,
    standingsUpdatedAt,
  });
};

/** League round rule: 6 games/round, round win = 2 pts, tie = 1 each, awarded only when all 6 have a winner. */
function liveMatchPoints(games) {
  if (!games) return { home: 0, away: 0 };
  let hp = 0, ap = 0;
  for (let r = 1; r <= 2; r++) {
    let hg = 0, ag = 0, scored = 0;
    for (let g = 1; g <= 6; g++) {
      const gs = games[`r${r}g${g}`];
      if (!gs) continue;
      const h = gs.home, a = gs.away;
      if (!Number.isInteger(h) || !Number.isInteger(a) || h === a) continue;
      scored++; if (h > a) hg++; else ag++;
    }
    if (scored === 6) { if (hg > ag) hp += 2; else if (ag > hg) ap += 2; else { hp += 1; ap += 1; } }
  }
  return { home: hp, away: ap };
}

function emptyKpis() { return { total: 0, live: 0, final: 0, toStart: 0 }; }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/admin-gameday' };
