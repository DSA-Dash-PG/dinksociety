// netlify/functions/captain-split-notify.js
// Emails for the captain "Split with your team" ledger.
//
//   POST { kind: 'announce' }              → tell every player what they owe
//   POST { kind: 'nudge', playerId? }      → remind players who still owe
//                                            (one player, or everyone owing)
//
// Each email carries a 3-day magic link into the Player Portal, where the
// "Your team share" card has the Pay-on-Venmo and "I paid" buttons. Nudges are
// limited to one per player per day — a second click reports them as skipped.
// Sent because a captain asked, so (like the waiver reminder) this goes through
// sendEmail directly rather than the opt-out-gated broadcast path.

import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { createPlayerToken } from './lib/player-auth.js';
import { sendEmail } from './lib/email.js';
import { seasonName } from './lib/circuit.js';
import { venmoProfileUrl } from './lib/payment-terms.js';
import { logActivity } from './lib/activity-log.js';
import { getSplit, saveSplit, loadLedger } from './lib/team-split.js';
import { fmtCents } from './lib/team-split-math.js';

const LINK_MINUTES = 3 * 24 * 60;
const siteUrlOf = () => (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL')) || process.env.SITE_URL || 'https://dinksociety.app';
const dayKey = () => new Date().toISOString().slice(0, 10);
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}

function renderShareEmail({ kind, playerName, captainName, teamName, teamEmoji, season, row, mode, rateCents, buyInCents = 0, venmoHandle, portalUrl }) {
  const first = esc(String(playerName || '').split(' ')[0] || 'there');
  const cap = esc(captainName || 'your captain');
  const owe = fmtCents(Math.max(0, row.balanceCents));
  const headline = kind === 'nudge' ? `Quick reminder, ${first}` : `Your share for ${esc(teamName)}`;
  const lead = kind === 'nudge'
    ? `${cap} is still waiting on your share of the ${esc(teamName)} team fee.`
    : `${cap} has split the ${esc(teamName)} team fee${season ? ' for ' + esc(season) : ''}. Here’s your part.`;
  const paidBit = row.paidCents ? ` · ${fmtCents(row.paidCents)} already paid` : '';
  const how = mode === 'pergame' && buyInCents > 0
    ? (row.usedCents > buyInCents
      ? `${row.games} games × ${fmtCents(rateCents)} = ${fmtCents(row.usedCents)}. Your ${fmtCents(buyInCents)} buy-in covered the first part; the rest is collected game by game${paidBit}. Only finished match nights count.`
      : `${fmtCents(buyInCents)} buy-in to be on the team. It covers your games at ${fmtCents(rateCents)} each — ${row.games} played so far, ${fmtCents(row.buyInLeftCents)} of it left${paidBit}. Once it's used up you pay per game.`)
    : mode === 'pergame'
    ? `${row.games} game${row.games === 1 ? '' : 's'} played${row.playerRate ? ` at your price of ${fmtCents(row.playerRate.cents)} ${row.playerRate.mode === 'week' ? 'a week' : 'a game'}` : ''} = ${fmtCents(row.usedCents)}${paidBit}. Your tab grows as you play — only finished match nights count.`
    : `Your share of the team amount is ${fmtCents(row.owedCents)}${row.paidCents ? ` · ${fmtCents(row.paidCents)} already paid` : ''}.`;
  const venmo = venmoHandle
    ? `<p style="font-size: 13px; color: #cfcfcf; line-height: 1.6; margin: 16px 0 0;">Paying by Venmo? Send it to <a href="${venmoProfileUrl(venmoHandle)}" style="color:#b8ff2c;font-weight:700;">@${esc(venmoHandle)}</a>, then tap <strong>I paid</strong> in the portal so ${cap} knows to look.</p>`
    : '';
  return `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background: #0e0e0e; color: #f5f5f5;">
      <div style="font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #f5f5f5; margin-bottom: 28px;">THE DINK SOCIETY</div>
      <h1 style="font-size: 22px; font-weight: 800; color: #f5f5f5; margin: 0 0 10px; line-height: 1.15;">${headline}</h1>
      <p style="font-size: 14px; color: #cfcfcf; line-height: 1.6; margin: 0 0 18px;">${lead}</p>
      <div style="background: #161616; border-radius: 8px; padding: 16px; margin: 0 0 22px; text-align: center;">
        <div style="font-size: 11px; color: #8a8a8a; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; margin-bottom: 6px;">${esc(teamEmoji || '')} You owe ${cap}</div>
        <div style="font-size: 34px; font-weight: 800; color: #b8ff2c; line-height: 1;">${owe}</div>
        <div style="font-size: 12px; color: #8a8a8a; line-height: 1.55; margin-top: 10px;">${how}</div>
      </div>
      <a href="${portalUrl}" style="display:inline-block; width:100%; box-sizing:border-box; text-align:center; padding: 14px 28px; background: #b8ff2c; color: #0e0e0e; font-size: 14px; font-weight: 800; text-decoration: none; border-radius: 9999px;">Open my team share</a>
      ${venmo}
      <p style="font-size: 12px; color: #8a8a8a; line-height: 1.6; margin: 18px 0 0;">This is between you and your captain — the league doesn’t collect it. Paying another way? Just tell ${cap} and they’ll mark you paid. The button is personal to you, so don’t forward it.</p>
      <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #2a2a2a; font-size: 11px; color: #555;">
        The Dink Society · Sent because your captain asked us to.
      </div>
    </div>`;
}

export default async (req) => {
  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;
  const team = ctx.team;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const body = await req.json().catch(() => ({}));
  const kind = body.kind === 'nudge' ? 'nudge' : 'announce';
  const split = await getSplit(team.id);
  if (!split || !split.enabled) return json({ error: 'Set up and save the split first.' }, 400);

  const { ledger } = await loadLedger(team, { split });
  const byId = new Map((team.roster || []).filter(p => p && p.id).map(p => [p.id, p]));
  let rows = ledger.rows.filter(r => !r.self && !r.archived && r.balanceCents > 0);
  if (body.playerId) rows = rows.filter(r => r.playerId === body.playerId);
  if (!rows.length) return json({ ok: true, sent: 0, skipped: 0, noEmail: 0, nothingOwed: true });

  const siteUrl = siteUrlOf();
  const today = dayKey();
  split.nudges = split.nudges || {};
  let sent = 0, skipped = 0, noEmail = 0;
  const failed = [];

  for (const row of rows) {
    const player = byId.get(row.playerId);
    if (!player?.email) { noEmail++; continue; }
    if (kind === 'nudge' && split.nudges[row.playerId] === today && !body.force) { skipped++; continue; }
    try {
      const token = await createPlayerToken({ email: player.email, playerId: player.id, teamId: team.id, minutes: LINK_MINUTES });
      const portalUrl = `${siteUrl}/.netlify/functions/player-link?token=${token}&next=${encodeURIComponent('/me.html#share')}`;
      await sendEmail({
        to: player.email,
        subject: kind === 'nudge'
          ? `Reminder: ${fmtCents(row.balanceCents)} to ${ledger.payeeName || 'your captain'} — ${team.name}`
          : `Your team share: ${fmtCents(row.balanceCents)} — ${team.name}`,
        html: renderShareEmail({
          kind, playerName: player.name, captainName: ledger.payeeName, teamName: team.name, teamEmoji: team.emoji || '',
          season: seasonName(team.circuit), row, mode: ledger.mode, rateCents: split.rateCents, buyInCents: ledger.buyInCents || 0, venmoHandle: split.venmoHandle, portalUrl,
        }),
      });
      split.nudges[row.playerId] = today;
      sent++;
    } catch (e) {
      console.error('captain-split-notify send failed:', player.email, e?.message || e);
      failed.push(player.name || player.email);
    }
  }

  if (kind === 'announce' && sent) split.announcedAt = new Date().toISOString();
  await saveSplit(split, ctx.user.email).catch(() => {});
  await logActivity({
    type: kind === 'nudge' ? 'split.nudged' : 'split.announced',
    actor: { email: ctx.user.email, role: ctx.user.role }, team,
    details: `${team.name}: team-share ${kind === 'nudge' ? 'reminder' : 'notice'} to ${sent} player${sent === 1 ? '' : 's'}${skipped ? ` (${skipped} already reminded today)` : ''}${noEmail ? ` (${noEmail} with no email)` : ''}`,
  }).catch(() => {});

  return json({ ok: true, sent, skipped, noEmail, failed });
};

export const config = { path: '/.netlify/functions/captain-split-notify' };
