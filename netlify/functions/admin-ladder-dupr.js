// netlify/functions/admin-ladder-dupr.js
// Admin — DUPR import CSV for one ladder night.
//
//   GET ?event=<id>              → the CSV file (download)
//   GET ?event=<id>&format=json  → { ok, games, total, skipped, missing, unverified }
//
// Same file the ladder-dupr-cron emails after a DUPR-rated night ends.

import { requireAdmin, unauthResponse } from './lib/admin-auth.js';
import { duprExportForEvent, duprFileName } from './lib/ladder-dupr-export.js';

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }); }

export default async (req) => {
  try { await requireAdmin(req); } catch { return unauthResponse(); }
  const url = new URL(req.url);
  const eventId = url.searchParams.get('event');
  if (!eventId) return json({ error: 'event required' }, 400);
  const x = await duprExportForEvent(eventId);
  if (!x.ok) return json({ error: x.error }, x.event ? 409 : 404);
  if (url.searchParams.get('format') === 'json') {
    return json({ ok: true, games: x.games, total: x.total, skipped: x.skipped, missing: x.missing, unverified: x.unverified, filename: duprFileName(x.event) });
  }
  return new Response(x.csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${duprFileName(x.event)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
};

export const config = { path: '/.netlify/functions/admin-ladder-dupr' };
