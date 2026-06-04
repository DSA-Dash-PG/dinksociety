// netlify/functions/captain-messages.js
// Captain side of the message center.
//
// GET                    → this team's thread with admin + unread count
//                          (does NOT auto-mark read; call mark-read explicitly)
// POST action=send       body: { body }       → captain posts to admin
// POST action=mark-read                        → clears captain unread

import { requireCaptain, unauthResponse } from './lib/captain-auth.js';
import { sendEmail, renderCaptainMessageNotify } from './lib/email.js';
import { listThread, appendMessage, getReads, setRead, unreadCount } from './lib/messages.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.netlify.app';
}

export default async (req) => {
  const ctx = await requireCaptain(req);
  if (!ctx) return unauthResponse();
  const teamId = ctx.team.id;

  // ── GET — load thread ──────────────────────────────────────
  if (req.method === 'GET') {
    const messages = await listThread(teamId);
    const reads = await getReads(teamId);
    return json({
      team: { id: teamId, name: ctx.team.name },
      messages,
      unread: unreadCount(messages, reads, 'captain'),
    });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const action = body.action;

  // ── Send a message to admin ────────────────────────────────
  if (action === 'send') {
    const text = body.body;
    if (!text?.trim()) return json({ error: 'Message body required' }, 400);

    const msg = await appendMessage({
      teamId, from: 'captain',
      authorName: ctx.team.captain || ctx.user.email,
      authorEmail: ctx.user.email,
      body: text,
    });
    await setRead(teamId, 'captain'); // sender has obviously seen the thread

    // Notify the league admin by email if a notify address is configured.
    const notify = process.env.EMAIL_REPLY_TO || process.env.EMAIL_ADMIN_BCC || process.env.EMAIL_FROM;
    if (notify) {
      try {
        await sendEmail({
          to: notify,
          subject: `New captain message — ${ctx.team.name}`,
          html: renderCaptainMessageNotify({
            teamName: ctx.team.name, captainName: ctx.team.captain || ctx.user.email,
            body: text, adminUrl: `${siteUrl()}/admin.html`,
          }),
        });
      } catch (e) { console.error('captain message notify failed:', e); }
    }
    return json({ ok: true, message: msg });
  }

  // ── Mark thread read ───────────────────────────────────────
  if (action === 'mark-read') {
    await setRead(teamId, 'captain');
    return json({ ok: true });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
};

export const config = { path: '/.netlify/functions/captain-messages' };
