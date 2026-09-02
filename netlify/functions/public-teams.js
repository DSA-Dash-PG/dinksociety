// netlify/functions/public-teams.js
//
// PUBLIC endpoint — no auth. Returns teams grouped by division for
// the public teams page. Reads from the 'teams' blob store.
//
// GET /.netlify/functions/public-teams?season=circuit-i
//   → { teams: [ { id, name, emoji, division, captain, roster: [{ name, gender, dupr }] } ] }
//
// Player emails are stripped for privacy.

import { getStore } from '@netlify/blobs';
import { circuitCode } from './lib/circuit.js';
import { publicProfile } from './lib/profile.js';
import { shouldHideTestRecord } from './lib/test-data.js';
import { isActivePlayer } from './lib/roster.js';

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const seasonId = url.searchParams.get('season') || 'circuit-i';
  const wantCode = circuitCode(seasonId);
  const division = url.searchParams.get('division') || '';

  try {
    const store = getStore('teams');
    const { blobs } = await store.list();
    const teams = [];

    for (const blob of blobs) {
      const raw = await store.get(blob.key);
      if (!raw) continue;
      try {
        const team = JSON.parse(raw);
        // Hide test/demo teams unless this request explicitly targets that season.
        if (shouldHideTestRecord(team, seasonId)) continue;
        // Which season is this team in? Registration writes `circuit` on the team
        // but no `seasonId`, so matching on seasonId alone hid every registered
        // team from any season but the first. Match on the CODE, which both
        // carry, and fall back to seasonId when a team has one.
        const teamCode = circuitCode(team.circuit || team.seasonId);
        if (team.seasonId && team.seasonId !== seasonId && teamCode !== wantCode) continue;
        if (!team.seasonId && teamCode !== wantCode) continue;
        // Filter by division if requested
        if (division && team.division !== division) continue;

        // Captain is anchored to captainEmail (the login identity), NOT roster
        // order — registration teams store no isCaptain flag, so falling back to
        // roster[0] showed whoever sorted first alphabetically as "captain".
        const capEmail = (team.captainEmail || '').toLowerCase();
        const capByEmail = capEmail
          ? (team.roster || []).find(p => (p.email || '').toLowerCase() === capEmail)
          : null;
        const captainName = capByEmail?.name || team.captain || team.captainName || '';

        teams.push({
          id: team.id,
          name: team.name,
          emoji: team.emoji || '',
          color: team.color || null,
          bio: team.bio || '',
          division: team.division,
          divisionLabel: team.divisionLabel || null,
          captain: captainName,
          // Team photo (optional). `team.photo.updatedAt` is stamped by
          // team-photo-upload; the ?v= cache-busts when the photo changes.
          photoUrl: team.photo?.updatedAt
            ? `/.netlify/functions/team-photo-serve?id=${encodeURIComponent(team.id)}&v=${encodeURIComponent(team.photo.updatedAt)}`
            : null,
          roster: (team.roster || []).filter(isActivePlayer).map(p => {
            // Approved bio fields only — DOB is converted to a computed age and
            // never emitted. Pending (unapproved) edits are NOT exposed here.
            const prof = publicProfile(p);
            return {
              id: p.id || null,
              name: p.name,
              gender: p.gender || '',
              dupr: p.dupr || null,
              isCaptain: capEmail
                ? (p.email || '').toLowerCase() === capEmail
                : (p.role === 'captain' || p.isCaptain || false),
              // MLP-style profile fields (approved only)
              height: prof.height,
              age: prof.age,
              plays: prof.plays,
              city: prof.city,
              homeCourt: prof.homeCourt,
              photoUrl: p.photo?.updatedAt
                ? `/.netlify/functions/player-photo-serve?id=${encodeURIComponent(p.id)}&v=${encodeURIComponent(p.photo.updatedAt)}`
                : null,
            };
          }),
        });
      } catch {}
    }

    // Sort by division then name
    teams.sort((a, b) => a.division.localeCompare(b.division) || a.name.localeCompare(b.name));

    return new Response(JSON.stringify({ teams }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (err) {
    console.error('public-teams error:', err);
    return new Response(JSON.stringify({ teams: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/public-teams' };
