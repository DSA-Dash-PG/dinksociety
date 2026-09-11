// netlify/functions/admin-ladder-recap-article.js
// Admin/organizer control for the FULL recap ARTICLE (the public
// /ladders/recaps/<eventId> page the cron publishes ten minutes after a night).
//
//   GET  ?event=<id>                              → status, notes, stats (no html)
//   POST ?event=<id> { action:'generate', force? } → build/rebuild it now
//   POST ?event=<id> { action:'notes', notes }     → save night notes AND rebuild
//
// Night notes are the point of this endpoint. The generator can read every
// score, but it cannot know that someone's partner no-showed, that the defending
// champ was on vacation, or that a night was carded DUPR and run unrated. Drop
// those in as plain sentences and the article gets rebuilt around them; they are
// stored on the record, so later rebuilds keep them.
//
// Same permission model as admin-ladder-recap.js: an admin, or the organizer
// who owns this ladder.

import { requireLadderOwner, orgErr } from './lib/organizer-auth.js';
import { getArticle, deleteArticle } from './lib/recap-article-store.js';
import { generateRecapArticle } from './lib/ladder-recap-article.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

const summarize = rec => (rec ? {
  eventId: rec.eventId,
  date: rec.date,
  slug: rec.slug,
  title: rec.title,
  dek: rec.dek,
  notes: rec.notes || '',
  generatedBy: rec.generatedBy,
  model: rec.model,
  generatorError: rec.generatorError || null,
  createdAt: rec.createdAt,
  updatedAt: rec.updatedAt,
  url: `/ladders/recaps/${rec.eventId}`,
  bytes: (rec.html || '').length,
  stats: rec.stats || null,
} : null);

export default async (req) => {
  const eventId = new URL(req.url).searchParams.get('event');
  if (!eventId) return json({ error: 'event id required' }, 400);

  const auth = await requireLadderOwner(req, eventId);
  if (!auth.ok) return orgErr(auth);

  if (req.method === 'GET') {
    return json({ article: summarize(await getArticle(eventId)) });
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'generate';

    if (action === 'delete') {
      await deleteArticle(eventId);
      return json({ ok: true, article: null });
    }

    if (action !== 'generate' && action !== 'notes') {
      return json({ error: `unknown action "${action}"` }, 400);
    }

    // Saving notes always forces a rebuild — the notes exist to change the copy.
    const notes = action === 'notes' ? String(body.notes || '') : (body.notes ? String(body.notes) : '');
    const force = action === 'notes' ? true : !!body.force;

    const r = await generateRecapArticle(eventId, { force, notes });
    if (!r.ok) return json({ ok: false, reason: r.reason || 'not-generated' }, 200);

    return json({ ok: true, engine: r.engine, article: summarize(r.record) });
  }

  return json({ error: 'Method not allowed' }, 405);
};

export const config = { path: '/.netlify/functions/admin-ladder-recap-article' };
