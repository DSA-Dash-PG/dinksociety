// netlify/functions/registration-returning-team.js
//
// "Welcome back" lookup for the registration page.
//
// POST { email, circuit? }
//   → { found: false }
//   → { found: true, teamId, teamName, seasonName,
//       players: [ { id, name, gender, dupr, emailMasked, hasEmail } ] }
//
// WHY. A team registering for a new season gets a brand-new team_<regId>
// record with only the captain on it — every returning player then had to be
// retyped by hand and queued for approval. This lets the page recognize the
// captain by email and offer last season's roster as a checklist; the ticked
// players are written straight into the new team at checkout.
//
// PRIVACY. This endpoint is PUBLIC (registration happens before any login), so
// it never returns a real email address — only a mask the captain can recognize
// their own player by, plus the roster ids. register-checkout re-resolves the
// real addresses server-side and re-checks that the registrant actually led
// that team (lib/league-players.js → carryOverRoster), so knowing a team id
// gets you nothing. Names are already public on the teams page.
//
// Rate-limited per email so the endpoint can't be walked to test which
// addresses captain a team.

import { loadAllTeams, lastTeamLedBy, carryableRoster, maskEmail } from './lib/league-players.js';
import { normalizeEmail } from './lib/identity.js';
import { seasonName } from './lib/circuit.js';
import { allowRequest } from './lib/rate-limit.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return json({ found: false }); }

  const email = normalizeEmail(body?.email);
  if (!email) return json({ found: false });

  if (!(await allowRequest(`returning-team:${email}`, { max: 15, windowMin: 15 }))) {
    return json({ found: false, throttled: true });
  }

  const teams = await loadAllTeams();
  // Exclude the season they're registering for, so a second pass at a
  // half-finished registration can't offer to import the team from itself.
  const prior = lastTeamLedBy(teams, email, { excludeCircuit: body?.circuit || null });
  if (!prior) return json({ found: false });

  const players = carryableRoster(prior, email).map(p => ({
    id: p.id,
    name: p.name || '',
    gender: p.gender || '',
    dupr: p.dupr || '',
    emailMasked: maskEmail(p.email),
    hasEmail: !!normalizeEmail(p.email),
  }));

  return json({
    found: true,
    teamId: prior.id,
    teamName: prior.name || '',
    seasonName: seasonName(prior.circuit || prior.seasonId),
    players,
  });
};

export const config = { path: '/.netlify/functions/registration-returning-team' };
