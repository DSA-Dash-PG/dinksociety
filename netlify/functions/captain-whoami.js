// netlify/functions/captain-whoami.js
// Returns the captain's email and ALL teams they manage.
// The frontend uses this to populate the team switcher.

import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { findAllLeaderTeamsByEmail } from './lib/captain-auth.js';
import { getRelevantAnnouncements } from './lib/announcements.js';
import { circuitCode } from './lib/circuit.js';
import { getActiveWaivers, listSignatures } from './lib/waiver.js';
import { isAdminEmail } from './lib/admin-auth.js';

export default async (req) => {
  const result = await verifyCaptainSession(req);
  if (!result.valid) return unauthResponse(result.error);
  const ctx = result.payload;

  const t = ctx.team;
  const teamEntry = t ? {
    id: t.id,
    name: t.name,
    division: t.division || null,
    divisionLabel: t.divisionLabel || null,
    circuit: t.circuit || 'I',
    seasonId: t.seasonId || null,
    emoji: t.emoji || '',
    photo: t.photo || null,
    role: ctx.user.role,
  } : null;

  // Every team this captain leads, for the switcher.
  const all = await findAllLeaderTeamsByEmail(ctx.user.email);
  const teams = all.map(({ team, role }) => ({
    id: team.id,
    name: team.name,
    division: team.division || null,
    divisionLabel: team.divisionLabel || null,
    circuit: team.circuit || 'I',
    seasonId: team.seasonId || null,
    emoji: team.emoji || '',
    photo: team.photo || null,
    role,
  }));

  // Make sure the currently-active team is always present in the list, even if
  // it was filtered out (e.g. a test-season team the captain is QA-ing).
  if (teamEntry && !teams.some(x => x.id === teamEntry.id)) {
    teams.unshift(teamEntry);
  }

  // League announcements (admin broadcasts) relevant to this team.
  const announcements = teamEntry
    ? await getRelevantAnnouncements({ teamId: teamEntry.id, division: teamEntry.division, limit: 3 })
    : [];

  // Waiver gaps — roster players who still need to sign each active waiver,
  // so the captain Home to-do can remind them.
  let waiverGaps = [];
  if (teamEntry && t) {
    const season = circuitCode(t.circuit);
    const roster = (t.roster || []).filter(p => p.id);
    const active = await getActiveWaivers();
    for (const w of active) {
      const sigs = await listSignatures(w.id);
      const missing = roster.filter(p => {
        const s = sigs[p.id];
        return !(s && s.version === w.version && String(s.season) === String(season));
      });
      if (missing.length) {
        waiverGaps.push({ id: w.id, title: w.title, missing: missing.length, names: missing.map(p => p.name).slice(0, 8) });
      }
    }
  }

  return new Response(JSON.stringify({
    captain: true,
    email: ctx.user.email,
    teams,
    team: teamEntry,
    currentTeamId: teamEntry ? teamEntry.id : null,
    announcements,
    waiverGaps,
    isAdmin: isAdminEmail(ctx.session?.email || ctx.user?.email),
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
};

export const config = { path: '/.netlify/functions/captain-whoami' };
