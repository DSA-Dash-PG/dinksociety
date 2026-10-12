// netlify/functions/ladder-dupr-cron.js
// Netlify SCHEDULED function — when a DUPR-rated ladder night is finished,
// emails every admin the night's DUPR import CSV (DUPR club → Matches →
// Import Matches via CSV). Runs every 15 minutes; a cheap no-op when nothing
// is due.
//
// One email per finish: the ledger (blob store `ladder-dupr`, key
// `sent/<eventId>.json`) records the finishedAt it sent for. If a night is
// reopened, corrected and finished again, finishedAt changes and the admins
// get an updated file, marked as a correction.
//
// Only nights finished in the last MAX_AGE_MS are picked up, so switching this
// on doesn't mail out every old DUPR ladder.

import { getStore } from '@netlify/blobs';
import { listPlay } from './lib/ladder-play.js';
import { getEvent } from './lib/ladder.js';
import { duprExportForEvent, duprFileName } from './lib/ladder-dupr-export.js';
import { renderDuprExportEmail } from './lib/ladder-dupr-email.js';
import { sendEmail } from './lib/email.js';
import { adminEmailList } from './lib/admin-auth.js';

const MIN_AGE_MS = 10 * 60 * 1000;        // let a just-finished night settle
const MAX_AGE_MS = 12 * 60 * 60 * 1000;   // ignore nights finished long ago

function ledger() { return getStore({ name: 'ladder-dupr', consistency: 'strong' }); }

export default async () => {
  const out = [];
  try {
    const to = adminEmailList();
    if (!to.length) { console.warn('[ladder-dupr-cron] no ADMIN_EMAILS set'); return new Response('ok'); }
    const plays = await listPlay();
    const now = Date.now();
    for (const p of plays) {
      if (!p.finished || !p.finishedAt) continue;
      const age = now - new Date(p.finishedAt).getTime();
      if (!(age >= MIN_AGE_MS && age <= MAX_AGE_MS)) continue;
      const event = await getEvent(p.eventId).catch(() => null);
      if (!event || !event.duprRated) continue;
      const key = `sent/${p.eventId}.json`;
      const prev = await ledger().get(key, { type: 'json' }).catch(() => null);
      if (prev && prev.finishedAt === p.finishedAt) continue; // already sent for this finish
      try {
        const x = await duprExportForEvent(p.eventId);
        if (!x.ok) { out.push({ eventId: p.eventId, ok: false, error: x.error }); continue; }
        const filename = duprFileName(event);
        const correction = !!prev;
        await sendEmail({
          to,
          subject: `${correction ? 'Updated ' : ''}DUPR upload ready: ${event.name} (${x.games} game${x.games === 1 ? '' : 's'})`,
          html: renderDuprExportEmail({ event, export: x, correction, adminUrl: `${process.env.SITE_URL || 'https://dinksociety.app'}/admin-ladders.html` }),
          attachments: [{ filename, content: Buffer.from(x.csv, 'utf8').toString('base64') }],
        });
        await ledger().setJSON(key, { eventId: p.eventId, finishedAt: p.finishedAt, sentAt: new Date().toISOString(), games: x.games, skipped: x.skipped.length, to });
        out.push({ eventId: p.eventId, ok: true, games: x.games, skipped: x.skipped.length });
      } catch (e) {
        out.push({ eventId: p.eventId, ok: false, error: String(e.message || e) });
      }
    }
    if (out.length) console.log('[ladder-dupr-cron]', JSON.stringify(out));
  } catch (e) {
    console.error('[ladder-dupr-cron] failed:', e);
  }
  return new Response('ok');
};

export const config = { schedule: '*/15 * * * *' };
