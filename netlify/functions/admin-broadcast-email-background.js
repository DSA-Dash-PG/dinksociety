// netlify/functions/admin-broadcast-email-background.js
//
// Sends the emails for one league broadcast — in the BACKGROUND.
//
// admin-messages (action=broadcast) writes the message to every team's thread,
// stores a broadcast record with emailStatus:'queued', and POSTs { broadcastId }
// here. Netlify answers 202 immediately and lets this run for up to 15 minutes,
// which is what a sixty-recipient send with a 4 MB attachment needs. Sending
// inline from admin-messages hit the 10s limit and 504'd with half the league
// emailed and no record of who.
//
// Progress is written back onto the broadcast record: emailed, failed,
// optedOut, firstError, emailStatus ('sending' → 'done'), so the admin UI can
// show it.
//
// Every send goes through sendNotify({ category: 'league' }) — so a player who
// hit "Unsubscribe from all" (or turned off League announcements) is skipped,
// and everyone else gets the manage/unsubscribe footer + List-Unsubscribe
// headers. Before this, broadcasts used raw sendEmail and nobody could opt out.
//
// POST body: { broadcastId }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { renderAdminMessage } from './lib/email.js';
import { sendNotify } from './lib/notify-prefs.js';
import { listAllTeams, recipientEmails, getEmailTemplate, siteUrl } from './admin-messages.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
  const broadcastId = String(body.broadcastId || '');
  if (!/^bc_[A-Za-z0-9_-]+$/.test(broadcastId)) return json({ error: 'broadcastId required' }, 400);

  const store = getStore('broadcasts');
  const key = `broadcast/${broadcastId}.json`;
  const rec = await store.get(key, { type: 'json' }).catch(() => null);
  if (!rec) return json({ error: 'Broadcast not found' }, 404);
  if (rec.emailStatus && rec.emailStatus !== 'queued') {
    // Already sent (or in flight) — never double-email the league.
    return json({ ok: true, skipped: true, emailStatus: rec.emailStatus });
  }

  const save = async (patch) => {
    Object.assign(rec, patch);
    await store.setJSON(key, rec).catch(e => console.error('broadcast progress save failed:', e));
  };
  await save({ emailStatus: 'sending', emailStartedAt: new Date().toISOString() });

  const site = siteUrl();
  const template = await getEmailTemplate();
  const attachments = Array.isArray(rec.attachments) ? rec.attachments : [];
  // Resend fetches each attachment by hosted URL at send time.
  const mailAttachments = attachments.map(a => ({ filename: a.filename, path: a.url }));
  const subject = rec.subject && rec.subject.trim()
    ? `${rec.subject.trim()} — The Dink Society`
    : 'Update from The Dink Society';

  // Targets are the exact team ids the broadcast was written to.
  const wanted = new Set(Array.isArray(rec.teamIds) ? rec.teamIds : []);
  const teams = (await listAllTeams('')).filter(t => wanted.has(t.id));

  let emailed = 0, failed = 0, optedOut = 0, firstError = null;
  // De-dupe across teams: a player rostered twice still gets one email.
  const seen = new Set();
  for (const team of teams) {
    const html = renderAdminMessage({
      subject: rec.subject, bodyHtml: rec.bodyHtml || '', body: rec.body || '', teamName: team.name,
      portalUrl: `${site}/captain.html`, template, attachments,
    });
    // A Drop broadcast pins its resolved per-team list on the record (roster
    // email → identity-layer fallback), so the send matches the count the
    // admin was shown. Message-center broadcasts still resolve here.
    const tos = (rec.recipientsByTeam && Array.isArray(rec.recipientsByTeam[team.id]))
      ? rec.recipientsByTeam[team.id]
      : recipientEmails(team, rec.audience || 'captains');
    for (const to of tos) {
      if (seen.has(to)) continue;
      seen.add(to);
      let ok = false, skipped = false;
      // Resend allows ~2 requests/second; back off and retry once on a limit.
      for (let attempt = 0; attempt < 3 && !ok && !skipped; attempt++) {
        try {
          const r = await sendNotify({ to, category: 'league', subject, html, attachments: mailAttachments });
          if (r && r.skipped) { skipped = true; break; }
          ok = true;
        } catch (e) {
          const msg = String(e && e.message || e);
          if (/rate|429|too many/i.test(msg) && attempt < 2) { await sleep(1500); continue; }
          failed++;
          if (!firstError) firstError = msg;
          console.error('broadcast email failed:', to, msg);
          break;
        }
      }
      if (ok) emailed++;
      if (skipped) { optedOut++; continue; } // no Resend call happened — no need to pace
      if ((emailed + failed) % 5 === 0) await save({ emailed, failed, optedOut, firstError });
      await sleep(550);
    }
  }

  await save({ emailed, failed, optedOut, firstError, emailStatus: 'done', emailFinishedAt: new Date().toISOString() });
  return json({ ok: true, emailed, failed, optedOut, firstError });
};
