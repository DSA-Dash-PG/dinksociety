// netlify/functions/admin-duplicates.js
//
// Admin-only duplicate-player sweep. Scans every team roster, normalizes each
// player's email/phone, and returns clusters of roster entries that share a
// normalized email or phone — i.e. probable duplicate people.
//
// This is the "cure" half of duplicate handling (the "prevent" half lives in
// captain-roster.js / admin-teams.js, which flag collisions at save time).
//
// Normalization is recomputed here on the fly, so the sweep works on legacy
// roster entries saved before normalizedEmail/normalizedPhone existed — no
// backfill/migration required.
//
// GET                       → sweep all teams in all seasons
// GET ?seasonId=<id>        → restrict the sweep to one season
//
// Response: {
//   clusters: [{
//     field: 'email' | 'phone',
//     value: '<normalized value>',          // contact value redacted-ish (kept for admin use)
//     sameSeason: boolean,                   // true => almost certainly a real duplicate to merge
//     members: [{ playerId, name, teamId, teamName, seasonId, email, phone }]
//   }],
//   scannedTeams, scannedPlayers, clusterCount
// }
//
// NOTE: a shared phone/email means "review me," not "merge me." Couples and
// families share contact info. The admin confirms before any merge. Same-season
// clusters are flagged (sameSeason:true) because one person on two teams in the
// same season is the textbook duplicate; cross-season collisions are usually the
// SAME person returning next season, which is expected and not a defect.

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';
import { normalizeEmail, normalizePhone } from './lib/identity.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  const seasonFilter = url.searchParams.get('seasonId');

  const teamsStore = getStore('teams');
  const { blobs } = await teamsStore.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));

  const byEmail = new Map(); // normalizedEmail -> [member]
  const byPhone = new Map(); // normalizedPhone -> [member]
  let scannedTeams = 0;
  let scannedPlayers = 0;

  for (const b of blobs) {
    const team = await teamsStore.get(b.key, { type: 'json' }).catch(() => null);
    if (!team) continue;
    if (seasonFilter && team.seasonId !== seasonFilter) continue;
    scannedTeams++;

    for (const p of team.roster || []) {
      scannedPlayers++;
      const member = {
        playerId: p.id,
        name: p.name || null,
        teamId: team.id,
        teamName: team.name || null,
        seasonId: team.seasonId || null,
        email: p.email || null,
        phone: p.phone || null,
      };
      const ne = normalizeEmail(p.email);
      const np = normalizePhone(p.phone);
      if (ne) {
        if (!byEmail.has(ne)) byEmail.set(ne, []);
        byEmail.get(ne).push(member);
      }
      if (np) {
        if (!byPhone.has(np)) byPhone.set(np, []);
        byPhone.get(np).push(member);
      }
    }
  }

  const clusters = [];
  collect(byEmail, 'email', clusters);
  collect(byPhone, 'phone', clusters);

  // Real duplicates (same person, same season) first, then cross-season.
  clusters.sort((a, b) => (b.sameSeason - a.sameSeason));

  return json({
    clusters,
    clusterCount: clusters.length,
    scannedTeams,
    scannedPlayers,
    sweptAt: new Date().toISOString(),
  });
};

function collect(map, field, out) {
  for (const [value, members] of map) {
    // De-dupe: the same playerId can legitimately appear once; we only care
    // when 2+ DISTINCT players share the value.
    const distinctIds = new Set(members.map(m => m.playerId));
    if (distinctIds.size < 2) continue;

    const seasonIds = new Set(members.map(m => m.seasonId));
    out.push({
      field,
      value,
      sameSeason: seasonIds.size === 1,
      members,
    });
  }
}

export const config = { path: '/.netlify/functions/admin-duplicates' };
