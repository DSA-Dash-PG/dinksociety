// netlify/functions/captain-nudge-waiver.js
// A captain (or co-captain) emails the roster players who still haven't signed
// the active waiver(s) for this team's season.
//
//   POST { waiverId? , playerId? }
//     waiverId  — limit to one waiver (default: every active waiver)
//     playerId  — nudge one player (default: everyone still missing)
//
// Each email carries a 3-day magic link straight into the Player Portal, where
// the waiver gate opens on arrival. One reminder per player per day — a second
// click the same day reports them as `skipped` rather than double-mailing.

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { circuitCode, seasonName } from './lib/circuit.js';
import { rosterWaiverGaps } from './lib/waiver.js';
import { createPlayerToken } from './lib/player-auth.js';
import { sendEmail, renderWaiverReminder, waiverReminderSubject } from './lib/email.js';
import { logActivity } from './lib/activity-log.js';

const LINK_MINUTES = 3 * 24 * 60;

function siteUrlOf() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL')) || process.env.SITE_URL || 'https://dinksociety.app';
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}
function dayKey() { return new Date().toISOString().slice(0, 10); }

export default async (req) => {
  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;
  const team = ctx.team;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!team) return json({ error: 'No team on this session.' }, 400);

  const body = await req.json().catch(() => ({}));
  const season = circuitCode(team.circuit);

  let gaps = await rosterWaiverGaps(team, season);
  if (body.waiverId) gaps = gaps.filter(g => g.id === body.waiverId);
  if (!gaps.length) return json({ ok: true, sent: 0, skipped: 0, noEmail: 0, alreadySigned: true });

  // Collapse to one email per player listing every waiver they're missing.
  const perPlayer = new Map();
  for (const g of gaps) {
    for (const p of g.missing) {
      if (body.playerId && p.id !== body.playerId) continue;
      if (!perPlayer.has(p.id)) perPlayer.set(p.id, { player: p, titles: [] });
      perPlayer.get(p.id).titles.push(g.title);
    }
  }
  if (!perPlayer.size) return json({ ok: true, sent: 0, skipped: 0, noEmail: 0, alreadySigned: true });

  const store = getStore('waivers');
  const siteUrl = siteUrlOf();
  const captainName = (team.roster || []).find(p => (p.email || '').toLowerCase() === (ctx.user.email || '').toLowerCase())?.name || null;
  let sent = 0, skipped = 0, noEmail = 0;
  const failed = [];

  for (const { player, titles } of perPlayer.values()) {
    if (!player.email) { noEmail++; continue; }
    const markerKey = `nudge/${team.id}/${player.id}/${dayKey()}.json`;
    const already = await store.get(markerKey, { type: 'json' }).catch(() => null);
    if (already && !body.force) { skipped++; continue; }
    try {
      const token = await createPlayerToken({ email: player.email, playerId: player.id, teamId: team.id, minutes: LINK_MINUTES });
      const signUrl = `${siteUrl}/.netlify/functions/player-link?token=${token}&next=${encodeURIComponent('/me.html')}`;
      await sendEmail({
        to: player.email,
        subject: waiverReminderSubject({ teamName: team.name || 'your team', waiverTitles: titles }),
        html: renderWaiverReminder({
          playerName: player.name, captainName,
          teamName: team.name, teamEmoji: team.emoji || '',
          seasonName: seasonName(team.circuit),
          waiverTitles: titles,
          signUrl, readUrl: `${siteUrl}/waiver`,
        }),
      });
      await store.setJSON(markerKey, { sentAt: new Date().toISOString(), by: ctx.user.email, titles }).catch(() => {});
      sent++;
    } catch (e) {
      console.error('captain-nudge-waiver send failed:', player.email, e?.message || e);
      failed.push(player.name || player.email);
    }
  }

  await logActivity({
    type: 'waiver.nudged',
    actor: { email: ctx.user.email, role: ctx.user.role },
    team, circuit: season,
    details: `${team.name}: waiver reminder to ${sent} player${sent === 1 ? '' : 's'}${skipped ? ` (${skipped} already reminded today)` : ''}${noEmail ? ` (${noEmail} with no email)` : ''}`,
  }).catch(() => {});

  return json({ ok: true, sent, skipped, noEmail, failed });
};

export const config = { path: '/.netlify/functions/captain-nudge-waiver' };
