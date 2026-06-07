// netlify/functions/public-standings.js
//
// PUBLIC endpoint — no auth. Returns standings for the public standings page.
//
// Handles TWO blob formats:
//   OLD (seed-demo-data.js): per-division blobs with { seasonId, division, standings: [] }
//   NEW (standings.js lib):  single circuit blob at standings/I.json with { circuit, divisions: {} }
//
// GET /.netlify/functions/public-standings?season=circuit-i
//   → { divisions: { "3-5-mixed": { teams: [...], h2h: {...} } }, lastUpdated }
//
// Each team object:
//   { rank, teamId, teamName, teamEmoji, wins, losses, ties, matchesPlayed,
//     matchPointsFor, matchPointsAgainst, pointDiff, totalGamesWon, totalGamesLost,
//     h2h: { [opponentId]: { for, against } } }

import { getStore } from '@netlify/blobs';
import { etagJson } from './lib/http-cache.js';

// Map internal division codes → display labels
const DIVISION_LABELS = {
  '3.0M':     '3.0 Mixed',
  '3.5M':     '3.0–3.5 Mixed',
  '3-5-mixed':'3.0–3.5 Mixed',
  '3-0-mixed':'3.0 Mixed',
};

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const seasonId = url.searchParams.get('season') || 'circuit-i';
  const division = url.searchParams.get('division') || '';

  // Derive circuit letter from seasonId (circuit-i → I, circuit-ii → II, etc.)
  const circuitLetter = seasonId.replace('circuit-', '').toUpperCase();

  try {
    const store = getStore('standings');
    const teamsStore = getStore('teams');

    // Load team emoji lookup
    const teamEmojis = {};
    try {
      const { blobs: teamBlobs } = await teamsStore.list({ prefix: 'team/' });
      await Promise.all(teamBlobs.map(async b => {
        const t = await teamsStore.get(b.key, { type: 'json' }).catch(() => null);
        if (t?.id) teamEmojis[t.id] = t.emoji || '';
      }));
    } catch { /* non-fatal */ }

    const divisions = {};
    let lastUpdated = null;

    // ── Try new format first: standings/<CIRCUIT>.json ──────────────
    const newBlob = await store.get(`standings/${circuitLetter}.json`, { type: 'json' }).catch(() => null);
    if (newBlob?.divisions) {
      for (const [divId, divData] of Object.entries(newBlob.divisions)) {
        if (division && divId !== division) continue;

        const teams = (divData.teams || []).map((t, i) => ({
          rank:                i + 1,
          teamId:              t.teamId,
          teamName:            t.teamName,
          teamEmoji:           teamEmojis[t.teamId] || '',
          wins:                t.wins       ?? t.w ?? 0,
          losses:              t.losses     ?? t.l ?? 0,
          ties:                t.ties       ?? t.t ?? 0,
          matchesPlayed:       t.matchesPlayed ?? (t.wins ?? 0) + (t.losses ?? 0) + (t.ties ?? 0),
          matchPointsFor:      t.matchPointsFor  ?? t.pts ?? 0,
          matchPointsAgainst:  t.matchPointsAgainst ?? 0,
          pointDiff:           t.matchPointsFor  - (t.matchPointsAgainst ?? 0),
          totalGamesWon:       t.totalGamesWon  ?? t.gw ?? 0,
          totalGamesLost:      t.totalGamesLost ?? t.gl ?? 0,
          h2h:                 t.headToHead ?? {},
        }));

        divisions[divId] = {
          divisionLabel: DIVISION_LABELS[divId] || divId,
          teams,
          weeklyTopTeams: divData.weeklyTopTeams || {},
        };
      }
      if (newBlob.lastUpdated) lastUpdated = newBlob.lastUpdated;
    }

    // ── Fall back to old per-division blob format ────────────────────
    if (!Object.keys(divisions).length) {
      const { blobs } = await store.list();
      for (const blob of blobs) {
        const raw = await store.get(blob.key).catch(() => null);
        if (!raw) continue;
        try {
          const data = JSON.parse(raw);
          // Old format uses seasonId; skip if mismatch
          if (data.seasonId && data.seasonId !== seasonId) continue;
          // Skip new-format blobs (no per-division seasonId field)
          if (!data.standings) continue;
          if (division && data.division !== division) continue;

          const divId = data.division || 'mixed';
          const teams = (data.standings || []).map((t, i) => ({
            rank:               i + 1,
            teamId:             t.teamId,
            teamName:           t.teamName,
            teamEmoji:          teamEmojis[t.teamId] || '',
            wins:               t.w  ?? 0,
            losses:             t.l  ?? 0,
            ties:               t.t  ?? 0,
            matchesPlayed:      (t.w ?? 0) + (t.l ?? 0) + (t.t ?? 0),
            matchPointsFor:     t.pts ?? 0,
            matchPointsAgainst: t.pa  ?? 0,
            pointDiff:          t.pd  ?? (t.pts ?? 0) - (t.pa ?? 0),
            totalGamesWon:      t.gw  ?? 0,
            totalGamesLost:     t.gl  ?? 0,
            h2h:                t.headToHead ?? {},
          }));

          divisions[divId] = {
            divisionLabel: data.divisionLabel || DIVISION_LABELS[divId] || divId,
            teams,
          };

          if (data.updatedAt && (!lastUpdated || data.updatedAt > lastUpdated)) {
            lastUpdated = data.updatedAt;
          }
        } catch { /* skip corrupt blobs */ }
      }
    }

    if (!Object.keys(divisions).length) {
      return etagJson(req, {
        empty: true,
        message: 'No standings yet. Come back once matches are underway.',
      });
    }

    return etagJson(req, { divisions, lastUpdated });

  } catch (err) {
    console.error('public-standings error:', err);
    return new Response(JSON.stringify({
      empty: true,
      message: 'Standings unavailable.',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/public-standings' };
