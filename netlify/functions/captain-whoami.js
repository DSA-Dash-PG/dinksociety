// netlify/functions/captain-whoami.js
// Returns the captain's email and ALL teams they manage.
// The frontend uses this to populate the team switcher.

import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { findAllLeaderTeamsByEmail } from './lib/captain-auth.js';
import { getRelevantAnnouncements } from './lib/announcements.js';
import { circuitCode } from './lib/circuit.js';
import { rosterWaiverGaps } from './lib/waiver.js';
import { isAdminEmail } from './lib/admin-auth.js';
import { normalizeEmail } from './lib/identity.js';
import { findPlayerByEmail } from './lib/player-auth.js';
import { photoResolver } from './lib/player-photo.js';

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
  // Looks across every roster id a person holds (lib/waiver.js
  // rosterWaiverGaps), so a returning player who signed while logged in as
  // her old-season self still counts once she signs for this season.
  let waiverGaps = [];
  if (teamEntry && t) {
    const season = circuitCode(t.circuit);
    const gaps = await rosterWaiverGaps(t, season).catch(() => []);
    waiverGaps = gaps.map(g => ({
      id: g.id, title: g.title, missing: g.missing.length,
      names: g.missing.map(p => p.name).slice(0, 8),
      playerIds: g.missing.map(p => p.id),
      noEmail: g.missing.filter(p => !p.email).length,
      // Who HAS signed — so the captain sees progress, not just the gap.
      signedCount: (g.signed || []).length,
      total: g.missing.length + (g.signed || []).length,
      signed: (g.signed || []).map(p => ({ id: p.id, name: p.name, signedAt: p.signedAt, method: p.method })),
    }));
  }

  // The captain's own avatar — the SAME one the player portal and public
  // pages show (lib/player-photo.js), so switching Captain ⇄ Me never swaps
  // pictures. Found by email: their entry on this roster, else any profile.
  let name = null, photoUrl = null;
  try {
    const em = normalizeEmail(ctx.user.email);
    const mine = (t?.roster || []).find(p => (p.normalizedEmail || normalizeEmail(p.email)) === em);
    let pid = mine?.id || null;
    name = mine?.name || null;
    if (!pid) {
      const found = await findPlayerByEmail(ctx.user.email).catch(() => null);
      pid = found?.playerId || null;
      name = name || found?.player?.name || found?.name || null;
    }
    if (pid) photoUrl = (await photoResolver()).urlFor(pid);
  } catch { /* initials */ }

  return new Response(JSON.stringify({
    captain: true,
    email: ctx.user.email,
    name,
    photoUrl,
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
