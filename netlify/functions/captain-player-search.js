// netlify/functions/captain-player-search.js
//
// Type-to-find over everyone who has ever played in the league, for the
// captain portal's "Add player" sheet.
//
// GET ?q=sar  →  { results: [ { name, gender, email, emailMasked, phone, dupr,
//                               lastTeamName, lastSeasonName, playedForYou } ],
//                  query }
//
// WHY THIS EXISTS. Adding a player used to mean retyping their name, gender,
// email and phone from memory — and a typo in the email meant a second copy of
// that person in the league, a broken sign-in, and stats that don't follow them.
// Picking from this list reuses the exact address the league already has, which
// is what keeps one human as one player across seasons (lib/identity.js).
//
// Results are ordered with the captain's own past players first — those are
// almost always who they're reaching for when a team re-registers, and they're
// the ones that join with no approval step. `needsApproval` flags the rest
// (played in the league, but for someone else) so the picker can say up front
// that the league has to sign off, rather than surprising the captain after
// they save.
//
// SCOPE. Captain-authed, minimum 2 characters, 8 results. Anyone already on
// this captain's roster (active, archived or pending) is filtered out — they're
// not an "add".

import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { buildLeagueIndex, playedForTeam, maskEmail } from './lib/league-players.js';
import { normalizeEmail } from './lib/identity.js';

const MIN_QUERY = 2;
const MAX_RESULTS = 8;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;

  const q = (new URL(req.url).searchParams.get('q') || '').trim().toLowerCase();
  if (q.length < MIN_QUERY) return json({ results: [], query: q });

  const { byEmail } = await buildLeagueIndex();

  // Already on this roster in any state — including pending and archived, so a
  // captain doesn't "add" someone who is sitting in their own approval queue.
  const onRoster = new Set();
  for (const p of (ctx.team?.roster || [])) {
    const k = p.normalizedEmail || normalizeEmail(p.email);
    if (k) onRoster.add(k);
  }

  const hits = [];
  for (const rec of byEmail.values()) {
    if (onRoster.has(rec.email)) continue;
    const name = String(rec.name || '').toLowerCase();
    const nameHit = name.includes(q);
    if (!nameHit && !rec.email.startsWith(q)) continue;

    const mine = playedForTeam(rec, ctx.team);
    hits.push({
      rank: (mine ? 0 : 2) + (name.startsWith(q) ? 0 : 1),
      name: rec.name || '',
      gender: rec.gender || '',
      dupr: rec.dupr || '',
      phone: rec.phone || '',
      // The real address is what gets written onto the roster; the mask is what
      // the dropdown shows, so a full inbox list isn't sprayed across the UI.
      email: rec.email,
      emailMasked: maskEmail(rec.email),
      lastTeamName: mine ? mine.teamName : (rec.lastTeamName || ''),
      lastSeasonName: mine ? mine.seasonName : (rec.lastSeasonName || ''),
      playedForYou: !!mine,
      needsApproval: !mine,
    });
  }

  hits.sort((a, b) => a.rank - b.rank || String(a.name).localeCompare(String(b.name)));

  return json({
    results: hits.slice(0, MAX_RESULTS).map(({ rank, ...r }) => r),
    query: q,
    more: Math.max(0, hits.length - MAX_RESULTS),
  });
};

export const config = { path: '/.netlify/functions/captain-player-search' };
