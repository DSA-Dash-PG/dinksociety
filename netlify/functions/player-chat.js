// netlify/functions/player-chat.js
// Player side of the TEAM group chat. Strictly scoped to the signed-in player's
// own team — requirePlayer resolves teamId from the session, and every store
// key is namespaced by that teamId, so a player can only ever read or post to
// their own team's thread.
//
// GET                  → this team's chat thread + this player's unread count
//                        (does NOT auto-mark read; call mark-read explicitly)
// POST action=send     body: { body }   → post a message to the team
// POST action=mark-read                 → clear this player's unread count

import { verifyPlayerSession, unauthResponse } from './lib/auth.js';
import { sendEmail, renderTeamChatNotify } from './lib/email.js';
import { normalizeEmail } from './lib/identity.js';
import {
  listTeamChat, appendTeamChatMessage,
  getPlayerRead, setPlayerRead, unreadCountForPlayer, getAllPlayerReads,
  getNotifyPref, setNotifyPref,
} from './lib/team-chat.js';

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
  const verified = await verifyPlayerSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;
  const { playerId, teamId, team, player } = ctx;

  // ── GET — load thread ──────────────────────────────────────
  if (req.method === 'GET') {
    const [messages, reads, notifyEmail, allReads] = await Promise.all([
      listTeamChat(teamId),
      getPlayerRead(teamId, playerId),
      getNotifyPref(teamId, playerId),
      getAllPlayerReads(teamId),
    ]);
    // Read receipts: send each teammate's last-read time + their name so the
    // client can show "Seen by N of M" on the player's own messages and reveal
    // exactly who. Names only (no PII).
    const roster = (team.roster || []).map(p => ({ id: p.id, name: p.name || 'Teammate' }));
    return json({
      team: { id: teamId, name: team.name },
      me: { playerId },
      messages,
      unread: unreadCountForPlayer(messages, reads, playerId),
      notifyEmail,
      roster,                 // [{id,name}] — teammates incl. me
      reads: allReads,        // { playerId: readAtISO }
    });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const action = body.action;

  // ── Post a message to the team ─────────────────────────────
  if (action === 'send') {
    const text = body.body;
    if (!text?.trim()) return json({ error: 'Message body required' }, 400);

    const msg = await appendTeamChatMessage({
      teamId,
      authorId: playerId,
      authorName: player.name || ctx.session.email,
      authorEmail: ctx.session.email,
      body: text,
    });
    await setPlayerRead(teamId, playerId); // sender has obviously seen the thread

    // Notify other rostered teammates who have an email on file. Best-effort:
    // a failed send must never block posting the message.
    try {
      const myEmail = normalizeEmail(ctx.session.email);
      // Resolve each teammate's opt-out preference, then keep only those who
      // still want email and have a usable address.
      const teammates = (team.roster || []).filter(p => p.id !== playerId && (p.email || '').trim());
      const wantsEmail = await Promise.all(teammates.map(p => getNotifyPref(teamId, p.id)));
      const seen = new Set();
      const recipients = teammates
        .filter((p, i) => wantsEmail[i])
        .map(p => p.email.trim())
        .filter(e => {
          const n = normalizeEmail(e);
          if (!n || n === myEmail || seen.has(n)) return false;
          seen.add(n);
          return true;
        });

      if (recipients.length) {
        const html = renderTeamChatNotify({
          teamName: team.name,
          authorName: player.name || 'A teammate',
          body: text,
          portalUrl: `${siteUrl()}/me.html`,
        });
        const subject = `New message in ${team.name} chat`;
        await Promise.allSettled(
          recipients.map(to => sendEmail({ to, subject, html }))
        );
      }
    } catch (e) {
      console.error('team chat notify failed:', e);
    }

    return json({ ok: true, message: msg });
  }

  // ── Mark thread read ───────────────────────────────────────
  if (action === 'mark-read') {
    await setPlayerRead(teamId, playerId);
    return json({ ok: true });
  }

  // ── Toggle email-notification preference ───────────────────
  if (action === 'set-notify') {
    await setNotifyPref(teamId, playerId, body.emailNotify === true);
    return json({ ok: true, notifyEmail: body.emailNotify === true });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
};

export const config = { path: '/.netlify/functions/player-chat' };
