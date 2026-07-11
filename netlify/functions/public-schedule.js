// netlify/functions/public-schedule.js
//
// PUBLIC endpoint — no auth. Returns the match schedule for a season,
// grouped by week. Reads from the 'schedule' blob store first (generated
// by admin-generate-schedule), then falls back to the 'matches' store
// (populated by seed-demo-data).
//
// GET /.netlify/functions/public-schedule?season=circuit-i[&division=3-0-mixed]
//   → { weeks: [ { week, matches: [...] } ] }

import { getStore } from '@netlify/blobs';
import { shouldHideTestRecord } from './lib/test-data.js';
import { buildBracketWeeks, resolveBracketDisplay } from './lib/bracket.js';

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const seasonId = url.searchParams.get('season') || 'circuit-i';
  const divisionFilter = url.searchParams.get('division') || '';

  try {
    // Derive the circuit letter for this season (circuit-i → I, circuit-test → TEST)
    const circuitLetter = seasonId.replace('circuit-', '').toUpperCase();

    // Team emoji lookup so the schedule can show team logos.
    const { byId: emojiById, byName: emojiByName } = await loadTeamEmojis(seasonId);

    // Try the schedule store first (admin-generated round-robin)
    const schedStore = getStore('schedule');
    const { blobs: schedBlobs } = await schedStore.list({ prefix: `schedule/${circuitLetter}/` });

    if (schedBlobs.length > 0) {
      const weekMap = {};
      // Per-division raw data so we can seed the Wk6–8 bracket (Rivalry /
      // Playoffs / Championship) off round-robin results.
      const realByDiv = {};        // division → [round-robin match (raw, with .week)]
      const bracketByDiv = {};     // division → [bracket placeholder match (raw, with .week)]
      const teamsByDiv = {};       // division → Map(id → {id,name})

      for (const b of schedBlobs) {
        const data = await schedStore.get(b.key, { type: 'json' }).catch(() => null);
        if (!data?.matches) continue;
        if (data.circuit && data.circuit !== circuitLetter) continue; // season isolation
        if (divisionFilter && data.division !== divisionFilter) continue;

        const div = data.division;
        const w = data.week || 1;
        for (const m of data.matches) {
          const raw = { ...m, week: w, division: div };
          if (m.phase) {
            (bracketByDiv[div] ||= []).push(raw);    // persisted bracket placeholder/locked
          } else {
            (realByDiv[div] ||= []).push(raw);
            const tm = (teamsByDiv[div] ||= new Map());
            if (m.teamA?.id) tm.set(m.teamA.id, { id: m.teamA.id, name: m.teamA.name });
            if (m.teamB?.id) tm.set(m.teamB.id, { id: m.teamB.id, name: m.teamB.name });
            pushPublicMatch(weekMap, w, div, m, emojiById);
          }
        }
      }

      // ── Resolve the bracket weeks per division and merge them in ──
      for (const div of Object.keys(realByDiv)) {
        const teamList = [...(teamsByDiv[div]?.values() || [])];
        const numTeams = teamList.length;
        if (numTeams < 2 || numTeams % 2 !== 0) continue;

        // Use persisted bracket blobs if the admin generated them; otherwise
        // synthesize the placeholders on the fly so the bracket always shows.
        let bracketMatches = bracketByDiv[div];
        if (!bracketMatches || !bracketMatches.length) {
          const built = buildBracketWeeks({ circuit: circuitLetter, division: div, numTeams });
          bracketMatches = Object.entries(built).flatMap(([wk, arr]) =>
            arr.map(m => ({ ...m, week: Number(wk), division: div }))
          );
        }

        const resolved = resolveBracketDisplay({
          realMatches: realByDiv[div], bracketMatches, teamList, numTeams,
        });
        for (const m of resolved) {
          pushPublicMatch(weekMap, m.week, div, m, emojiById, m);
        }
      }

      const weeks = Object.values(weekMap).sort((a, b) => a.week - b.week);
      if (weeks.length > 0) {
        return json({ weeks });
      }
    }

    // Fallback: read individual match records from 'matches' store (seed-demo-data format)
    const matchStore = getStore('matches');
    const { blobs: matchBlobs } = await matchStore.list();
    const weekMap = {};

    for (const b of matchBlobs) {
      const raw = await matchStore.get(b.key);
      if (!raw) continue;
      try {
        const m = JSON.parse(raw);
        // Hide test/demo matches unless this request explicitly targets that season.
        if (shouldHideTestRecord(m, seasonId)) continue;
        if (m.seasonId && m.seasonId !== seasonId) continue;
        if (divisionFilter && m.division !== divisionFilter) continue;

        const w = m.week || 1;
        if (!weekMap[w]) weekMap[w] = { week: w, matches: [] };
        weekMap[w].matches.push({
          id: m.id,
          teamA: m.homeTeamName || 'TBD',
          teamB: m.awayTeamName || 'TBD',
          emojiA: emojiByName[(m.homeTeamName || '').toLowerCase()] || '',
          emojiB: emojiByName[(m.awayTeamName || '').toLowerCase()] || '',
          court: m.court || null,
          venue: m.venue || null,
          courtSet: m.courtSet ?? null,
          date: m.date || null,
          scheduledAt: m.scheduledAt || null,
          startTime: m.startTime || null,
    endTime: m.endTime || null,
          status: m.status || 'scheduled',
          division: m.division,
          divisionLabel: m.divisionLabel || '',
          // Include scores for finalized matches
          homeRoundPts: m.homeRoundPts ?? null,
          awayRoundPts: m.awayRoundPts ?? null,
          gamesA: m.homeGameWins ?? null,
          gamesB: m.awayGameWins ?? null,
          finalizedAt: m.finalizedAt || (m.status === 'final' ? true : null),
        });
      } catch {}
    }

    const weeks = Object.values(weekMap).sort((a, b) => a.week - b.week);

    if (!weeks.length) {
      return json({
        empty: true,
        message: 'Schedule not yet published. Check back closer to game time.',
      });
    }

    return json({ weeks });
  } catch (err) {
    console.error('public-schedule error:', err);
    return json({
      empty: true,
      message: 'Schedule unavailable.',
    });
  }
};

// Build emoji lookups (by team id and by lowercased name) for a season.
// Best-effort: never throws — an empty map just means no logos.
async function loadTeamEmojis(seasonId) {
  const byId = {};
  const byName = {};
  try {
    const store = getStore('teams');
    const { blobs } = await store.list();
    for (const blob of blobs) {
      const raw = await store.get(blob.key).catch(() => null);
      if (!raw) continue;
      try {
        const team = JSON.parse(raw);
        if (shouldHideTestRecord(team, seasonId)) continue;
        if (team.seasonId && team.seasonId !== seasonId) continue;
        if (!team.seasonId && seasonId !== 'circuit-i') continue;
        if (!team.emoji) continue;
        if (team.id) byId[team.id] = team.emoji;
        if (team.name) byName[team.name.toLowerCase()] = team.emoji;
      } catch {}
    }
  } catch {}
  return { byId, byName };
}

// Map a raw schedule match (round-robin OR resolved bracket) into the public
// shape and push it onto weekMap[w]. When `br` (the resolved bracket match) is
// passed, phase/seed metadata is attached and the week is tagged with its phase.
function pushPublicMatch(weekMap, w, division, m, emojiById, br) {
  if (!weekMap[w]) weekMap[w] = { week: w, division, matches: [] };
  if (br) {
    weekMap[w].phase = br.phase || weekMap[w].phase || null;
    weekMap[w].phaseLabel = br.phaseLabel || weekMap[w].phaseLabel || null;
  }
  const gamesA = (m.round1?.homeGames ?? 0) + (m.round2?.homeGames ?? 0);
  const gamesB = (m.round1?.awayGames ?? 0) + (m.round2?.awayGames ?? 0);
  const tbd = br ? null : 'TBD';
  // Bracket slots stay as SEED PLACEHOLDERS (#1 Seed, …) until the phase locks.
  // The projection still drives lock logic server-side; we just don't reveal the
  // teams on the schedule until the matchup is final.
  const locked = br ? !!br.seedLocked : true;
  const tA = locked ? m.teamA : null;
  const tB = locked ? m.teamB : null;
  weekMap[w].matches.push({
    id: m.id,
    teamA: tA?.name || tbd,
    teamB: tB?.name || tbd,
    teamAId: tA?.id || null,
    teamBId: tB?.id || null,
    emojiA: (tA?.id && emojiById[tA.id]) || '',
    emojiB: (tB?.id && emojiById[tB.id]) || '',
    court: m.court || null,
    venue: m.venue || null,
    courtA: m.courtA ?? null,
    courtB: m.courtB ?? null,
    courtSet: m.courtSet ?? null,
    scheduledAt: m.scheduledAt || null,
    startTime: m.startTime || null,
    endTime: m.endTime || null,
    scoreA: m.scoreA ?? null,
    scoreB: m.scoreB ?? null,
    homeRoundPts: m.scoreA ?? null,
    awayRoundPts: m.scoreB ?? null,
    gamesA: m.finalizedAt ? gamesA : null,
    gamesB: m.finalizedAt ? gamesB : null,
    round1: m.finalizedAt && m.round1 ? {
      homeGames: m.round1.homeGames ?? 0, awayGames: m.round1.awayGames ?? 0,
      homePoints: m.round1.homePoints ?? null, awayPoints: m.round1.awayPoints ?? null,
    } : null,
    round2: m.finalizedAt && m.round2 ? {
      homeGames: m.round2.homeGames ?? 0, awayGames: m.round2.awayGames ?? 0,
      homePoints: m.round2.homePoints ?? null, awayPoints: m.round2.awayPoints ?? null,
    } : null,
    pointsA: m.finalizedAt ? (m.pointsA ?? null) : null,
    pointsB: m.finalizedAt ? (m.pointsB ?? null) : null,
    finalizedAt: m.finalizedAt || null,
    status: m.finalizedAt ? 'final' : 'scheduled',
    division,
    // ── Bracket fields (null for ordinary round-robin matches) ──
    phase: br ? (br.phase || null) : null,
    bracketSlot: br ? (br.bracketSlot || null) : null,
    bracketGroup: br ? (br.bracketGroup || null) : null,
    gameLabel: br ? (br.gameLabel || null) : null,
    placeLabel: br ? (br.placeLabel || null) : null,
    medal: br ? (br.medal || null) : null,
    seedLabelA: br ? (br.seedLabelA || null) : null,
    seedLabelB: br ? (br.seedLabelB || null) : null,
    seedLocked: br ? !!br.seedLocked : null,
    championship: m.championship ? true : (br ? !!br.championship : false),
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

export const config = { path: '/.netlify/functions/public-schedule' };
