// netlify/functions/ohana-photo.js
// The South Bay Ohana team picture — private like the rest of /ohana.
//
//   GET    → the image (roster + owner only; private cache, never public)
//   POST   multipart { file } → upload/replace (managers only)
//   DELETE → remove (managers only)
//
// Binary lives next to the league record in the private 'private-leagues'
// store (key photo/ohana), NOT the public 'team-photos' store. The league
// record gets photo:{updatedAt, contentType} so the page can cache-bust.

import { getStore } from '@netlify/blobs';
import { loadLeague, saveLeague, viewer, json } from './lib/ohana.js';

const KEY = 'photo/ohana';
const MAX_BYTES = 6 * 1024 * 1024; // client compresses first
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const store = () => getStore({ name: 'private-leagues', consistency: 'strong' });

export default async (req) => {
  const league = await loadLeague();
  const v = await viewer(req, league);
  if (!v.signedIn) return json({ error: 'Sign in first' }, 401);
  if (!v.allowed) return json({ error: 'Roster only' }, 403);

  if (req.method === 'GET') {
    const r = await store().getWithMetadata(KEY, { type: 'arrayBuffer' }).catch(() => null);
    if (!r?.data) return new Response('Not found', { status: 404 });
    return new Response(r.data, {
      status: 200,
      headers: {
        'Content-Type': r.metadata?.contentType || 'image/jpeg',
        'Cache-Control': 'private, max-age=86400', // page adds ?v=<updatedAt>
        'X-Robots-Tag': 'noindex',
      },
    });
  }

  if (!v.canEdit) return json({ error: 'Only team managers can change the team photo' }, 403);

  if (req.method === 'DELETE') {
    await store().delete(KEY).catch(() => null);
    league.photo = null;
    league.log.push({ at: new Date().toISOString(), by: v.email, what: 'removed team photo' });
    await saveLeague(league);
    return json({ ok: true });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let file;
  try { file = (await req.formData()).get('file'); } catch { return json({ error: 'Bad upload' }, 400); }
  if (!file || typeof file === 'string') return json({ error: 'No file provided' }, 400);
  if (!TYPES.has(file.type)) return json({ error: 'Only JPG, PNG, or WebP' }, 400);
  if (file.size > MAX_BYTES) return json({ error: 'Photo is too large — try a smaller one' }, 400);

  await store().set(KEY, await file.arrayBuffer(), { metadata: { contentType: file.type } });
  league.photo = { updatedAt: new Date().toISOString(), contentType: file.type };
  league.log.push({ at: league.photo.updatedAt, by: v.email, what: 'updated team photo' });
  await saveLeague(league);
  return json({ ok: true, photo: league.photo });
};

export const config = { path: '/.netlify/functions/ohana-photo' };
