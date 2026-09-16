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
// firstError, emailStatus ('sending' → 'done'), so the admin UI can show it.
//
// POST body: { broadcastId }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { sendEmail, renderAdminMessage } from './lib/email.js';
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

  let emailed = 0, failed = 0, firstError = null;
  // De-dupe across teams: a player rostered twice still gets one email.
  const seen = new Set();
  for (const team of teams) {
    const html = renderAdminMessage({
      subject: rec.subject, bodyHtml: rec.bodyHtml || '', body: rec.body || '', teamName: team.name,
      portalUrl: `${site}/captain.html`, template, attachments,
    });
    for (const to of recipientEmails(team, rec.audience || 'captains')) {
      if (seen.has(to)) continue;
      seen.add(to);
      let ok = false;
      // Resend allows ~2 requests/second; back off and retry once on a limit.
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          await sendEmail({ to, subject, html, attachments: mailAttachments });
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
      if ((emailed + failed) % 5 === 0) await save({ emailed, failed, firstError });
      await sleep(550);
    }
  }

  await save({ emailed, failed, firstError, emailStatus: 'done', emailFinishedAt: new Date().toISOString() });
  return json({ ok: true, emailed, failed, firstError });
};
