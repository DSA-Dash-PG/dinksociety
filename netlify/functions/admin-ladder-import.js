// netlify/functions/admin-ladder-import.js
// POST /api/admin-ladder-import   (admin session required)
//
// One-time (idempotent) migration of historical Pickleladder ladder nights into
// Dink Society. Pulls live from the old site's public list endpoint and, for
// every past session that has scored rounds, creates a finalized Ladder Event +
// its play record + an imported roster. Safe to re-run: events keyed `imp_<id>`
// are skipped if they already exist.
//
// Body (optional): { url } to override the source. Defaults to the live old site.

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { getEvent, setEvent, setSignups } from './lib/ladder.js';
import { setPlay } from './lib/ladder-play.js';

const DEFAULT_SRC = 'https://pickleladder.netlify.app/.netlify/functions/api?action=list';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  const body = await req.json().catch(() => ({}));
  const src = body.url || DEFAULT_SRC;

  let data;
  try {
    const r = await fetch(src, { headers: { Accept: 'application/json' } });
    if (!r.ok) return json({ error: `Source returned ${r.status}` }, 502);
    data = await r.json();
  } catch (e) {
    return json({ error: 'Could not fetch source: ' + (e?.message || e) }, 502);
  }

  const ladders = data.ladders || [];
  const resync = !!body.resync;   // when true, refresh play/roster for already-imported nights
  let imported = 0, resynced = 0, skipped = 0, playersTouched = 0;
  const log = [];

  for (const lg of ladders) {
    const byId = {}; (lg.players || []).forEach(p => { byId[p.id] = p; });
    for (const season of (lg.seasons || [])) {
      for (const sess of (season.sessions || [])) {
        if (!Array.isArray(sess.rounds) || !sess.rounds.length) continue;
        const hasScore = sess.rounds.some(r => (r.courts || []).some(c => c.score && c.score.winner));
        if (!hasScore) continue;

        const eid = 'imp_' + sess.id;
        const existing = await getEvent(eid);
        if (existing && !resync) { skipped++; continue; }

        const event = {
          id: eid, circuit: 'legacy',
          name: (sess.name && sess.name.trim()) || `${lg.name} · ${sess.date || ''}`.trim(),
          date: sess.date || null, startTime: sess.config?.startTime || '', place: sess.config?.place || '',
          courts: sess.config?.courts || 0, capacity: 0, feeCents: 0,
          paymentMethods: [], venmoHandle: null, waitlist: false,
          spotOpenPolicy: 'hold', cancelPolicy: 'no_credit', fcfsWindowHours: 24, organizers: [],
          status: 'final', source: 'pickleladder', importRef: sess.id,
          importLeague: lg.name, importSeason: season.name,
          createdAt: new Date().toISOString(), createdBy: 'import',
        };
        if (!existing) await setEvent(event);   // keep existing event metadata on re-sync
        // Always (re)write the play record — THIS backfills scores onto already-imported nights.
        // Include config + currentRound so the scoring screen can open imported nights too.
        await setPlay(eid, {
          eventId: eid, date: sess.date || null, rounds: sess.rounds,
          config: { courts: sess.config?.courts || event.courts || 0, rounds: (sess.rounds || []).length, roundMin: sess.config?.roundMin || 12, scoreMode: 'points' },
          currentRound: Math.max(0, (sess.rounds || []).length - 1),
          started: true, finished: true, source: 'pickleladder',
        });

        // Roster: from participants if present, else everyone who appears in rounds.
        let entries;
        if (Array.isArray(sess.participants) && sess.participants.length) {
          entries = sess.participants.map(id => byId[id]).filter(Boolean);
        } else {
          const seen = {};
          sess.rounds.forEach(r => (r.courts || []).forEach(c => [...(c.team1 || []), ...(c.team2 || [])].filter(Boolean).forEach(pl => { if (!seen[pl.id]) seen[pl.id] = pl; })));
          entries = Object.values(seen);
        }
        await setSignups({
          eventId: eid,
          roster: entries.map(p => ({
            playerId: p.id, name: p.name, email: (p.email || '').toLowerCase(), gender: p.gender || null,
            paymentStatus: 'paid', paymentMethod: 'imported', amountCents: 0,
            signedUpAt: sess.date ? new Date(sess.date + 'T12:00:00').toISOString() : new Date().toISOString(),
            imported: true,
          })),
          waitlist: [], pendingClaim: null,
        });

        if (existing) resynced++; else imported++;
        playersTouched += entries.length;
        log.push({ event: event.name, players: entries.length, resynced: !!existing });
      }
    }
  }

  return json({ ok: true, imported, resynced, skipped, playersTouched, log });
};

export const config = { path: '/.netlify/functions/admin-ladder-import' };
