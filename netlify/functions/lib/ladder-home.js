// netlify/functions/lib/ladder-home.js
// What the HOME PAGE shows about the ladders, assembled in one place:
//
//   next      the next public ladder (name, when, where, how full) — the strip
//             under the headline: "N spots left · Sign up" / "Sold out · Join
//             the waitlist" / "Live now".
//   last      the most recent finished ladder whose recap has gone out: podium
//             + link. The strip shows it for two days after a ladder night.
//   writeups  the newest ladder write-ups (sent recaps and published previews),
//             newest first, each with its publish time. The home page gives the
//             newest one the headline for 48 hours — unless a league Drop is
//             inside its own 48 — then a card until it is four days old.
//
// Public data only: private (invite-only) ladders never appear, and nothing here
// carries a roster, an email or draft copy.
//
// `deps` exists so the assembly can be tested without Blobs.

import { listEvents, getSignups, toPublicSignups, eventStartMs, LADDER_TZ } from './ladder.js';
import { recapTeaser } from './ladder-recap-teaser.js';
import { LADDER_PREVIEWS } from './ladder-previews.js';
import { listPhotos } from './ladder-photos.js';

const UPCOMING = ['open', 'closed', 'full', 'live'];
const isPublic = e => e && e.visibility !== 'private';

/** Today's date (YYYY-MM-DD) in the league timezone. */
export function todayIn(now = Date.now(), timeZone = LADDER_TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

// The public facts about a ladder night (never the roster).
function facts(e) {
  return {
    id: e.id, name: e.name || 'Ladder', date: e.date || null,
    startTime: e.startTime || null, endTime: e.endTime || null, place: e.place || null,
    type: e.type || 'mixed', format: e.format || 'individual',
    courts: e.courts || null, duprRated: !!e.duprRated, status: e.status || 'open',
    startMs: eventStartMs(e),
  };
}

const defaults = {
  listEvents: () => listEvents({}),
  getSignups,
  recapTeaser,
  previews: LADDER_PREVIEWS,
  // Cover photo first (listPhotos already sorts that way); null when the night has none.
  photoFor: async (eventId) => {
    const p = (await listPhotos(eventId).catch(() => []))[0];
    return p ? { id: p.id, fx: Number.isFinite(p.fx) ? p.fx : null, fy: Number.isFinite(p.fy) ? p.fy : null } : null;
  },
};

export async function buildLadderHome({ now = Date.now(), deps = {} } = {}) {
  const d = { ...defaults, ...deps };
  const events = ((await d.listEvents().catch(() => [])) || []).filter(isPublic);
  const today = todayIn(now);

  // How full a night is. One signups read per night asked about.
  const fillCache = new Map();
  const fill = async (e) => {
    if (!fillCache.has(e.id)) {
      const rec = await Promise.resolve(d.getSignups(e.id)).catch(() => null);
      const p = rec ? toPublicSignups(e, rec) : null;
      fillCache.set(e.id, p ? { capacity: p.capacity, spotsLeft: p.spotsLeft, rosterCount: p.rosterCount, waitlistCount: p.waitlistCount } : {});
    }
    return fillCache.get(e.id);
  };
  const isUpcoming = e => UPCOMING.includes(e.status || 'open') && ((e.status || '') === 'live' || String(e.date || '') >= today);
  const previewOf = id => {
    const p = d.previews[id];
    return p && p.url ? p : null;
  };

  // ── next ──
  const upcoming = events.filter(isUpcoming)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || ((eventStartMs(a) || 0) - (eventStartMs(b) || 0)));
  const nextEv = upcoming[0] || null;
  let next = null;
  if (nextEv) {
    const pv = previewOf(nextEv.id);
    next = { ...facts(nextEv), ...(await fill(nextEv)), preview: pv ? { url: pv.url, title: pv.title || null } : null };
  }

  // ── last + recap write-ups: newest finished nights first, sent recaps only ──
  const finals = events.filter(e => (e.status || '') === 'final')
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 6);
  const recaps = [];
  for (const e of finals) {
    if (recaps.length >= 2) break;
    const t = await Promise.resolve(d.recapTeaser(e)).catch(() => null);
    if (!t) continue;
    recaps.push({
      kind: 'recap', eventId: e.id, name: t.name, date: t.date, place: t.place, type: t.type, format: t.format,
      title: t.title, dek: t.dek, url: t.url, publishedAt: t.sentAt, podium: t.podium || [],
    });
  }
  const last = recaps[0] ? { ...recaps[0] } : null;
  if (recaps[0]) {
    recaps[0].photo = await Promise.resolve(d.photoFor(recaps[0].eventId)).catch(() => null);
    last.photo = recaps[0].photo;
  }

  // ── preview write-ups: only for a ladder that still exists and is public ──
  const previews = [];
  for (const [eventId, p] of Object.entries(d.previews || {})) {
    const e = events.find(x => x.id === eventId);
    if (!e || !p || !p.url || !p.title || !p.publishedAt) continue;
    const up = isUpcoming(e);
    previews.push({
      kind: 'preview', eventId, ...facts(e), ...(up ? await fill(e) : {}), upcoming: up,
      title: p.title, dek: p.dek || null, url: p.url, publishedAt: p.publishedAt,
      sections: Array.isArray(p.sections) ? p.sections.slice(0, 8).map(s => ({ label: String(s.label || ''), id: String(s.id || '') })).filter(s => s.label && s.id) : [],
    });
  }

  const at = w => { const t = Date.parse(w.publishedAt || ''); return isNaN(t) ? 0 : t; };
  const writeups = recaps.concat(previews).filter(w => at(w) > 0 && at(w) <= now + 60000)
    .sort((a, b) => at(b) - at(a)).slice(0, 3);

  return { next, last, writeups };
}
