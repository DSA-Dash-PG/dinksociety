// netlify/functions/lib/roster-approvals.js
//
// The one place a captain's "add this player" request gets approved or
// rejected. Called by admin-roster-approvals.js (the Approvals tab) and by
// approval-decide.js (the one-tap Approve / Deny links in the admin email).
//
//   approve → clears pendingAdd; they are on the roster. Captain + co-captains
//             + whoever submitted get the decision email; the player gets the
//             roster welcome.
//   reject  → the entry is removed from the roster; leaders get the decision
//             email; the player (who never knew) hears nothing.

import { getStore } from '@netlify/blobs';
import { seasonName } from './circuit.js';
import { logActivity } from './activity-log.js';
import { sendEmail, renderRosterAddDecision } from './email.js';
import { sendRosterWelcomesSafe } from './roster-welcome.js';
import { adminEmailList } from './admin-auth.js';
import { createApprovalLinks } from './approval-token.js';

export const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export class RosterApprovalError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.app';
}

/**
 * Who hears about this decision: the captain, any co-captains, and whoever
 * actually submitted the request (a co-captain may have added them). Deduped,
 * lowercased, and never sent to an empty address.
 */
export function leaderEmails(team, requestedBy) {
  const set = new Set();
  const add = (e) => { const x = String(e || '').trim().toLowerCase(); if (x && x.includes('@')) set.add(x); };
  add(team.captainEmail);
  for (const p of (team.roster || [])) {
    if ((p.isCaptain || p.isCoCaptain) && p.email) add(p.email);
  }
  add(requestedBy);
  return [...set];
}

/**
 * Rule on one pending roster add.
 * @param {{ teamId:string, playerId:string, action:'approve'|'reject', note?:string, adminEmail?:string|null }} o
 * @returns {Promise<{ ok:true, action:string, playerId:string, teamId:string, name:string, teamName:string, notified:number }>}
 * @throws {RosterApprovalError}
 */
export async function decideRosterAdd({ teamId, playerId, action, note = '', adminEmail = null }) {
  if (!VALID_ID.test(String(teamId || ''))) throw new RosterApprovalError('teamId required', 400);
  if (!VALID_ID.test(String(playerId || ''))) throw new RosterApprovalError('playerId required', 400);
  if (!['approve', 'reject'].includes(action)) throw new RosterApprovalError('action must be approve or reject', 400);

  const store = getStore('teams');
  const key = `team/${teamId}.json`;
  const team = await store.get(key, { type: 'json', consistency: 'strong' }).catch(() => null);
  if (!team) throw new RosterApprovalError('Team not found', 404);

  const roster = Array.isArray(team.roster) ? team.roster : [];
  const player = roster.find(p => p && p.id === playerId);
  if (!player) throw new RosterApprovalError('Player not found on this team', 404);
  if (!player.pendingAdd) throw new RosterApprovalError('That player is not awaiting approval', 409);

  const requestedBy = player.pendingAddBy || null;

  if (action === 'approve') {
    delete player.pendingAdd;
    delete player.pendingAddAt;
    delete player.pendingAddBy;
    player.approvedAt = new Date().toISOString();
    player.approvedBy = adminEmail || 'admin';
    team.roster = roster;
  } else {
    team.roster = roster.filter(p => p.id !== playerId);
  }

  team.rosterUpdatedAt = new Date().toISOString();
  await store.setJSON(key, team);

  // Tell the captain. A request that vanishes without a word is worse than no
  // approval step at all — they'd re-add the player and wonder why nothing
  // sticks. Email is best-effort: a send failure must not undo the decision.
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 400) : '';
  const to = leaderEmails(team, requestedBy);
  if (to.length) {
    const html = renderRosterAddDecision({
      approved: action === 'approve',
      playerName: player.name || 'Your player',
      teamName: team.name || 'your team',
      teamEmoji: team.emoji || '',
      seasonName: seasonName(team.circuit || team.seasonId),
      note: cleanNote,
      portalUrl: `${siteUrl()}/captain.html`,
      adminEmail: 'dink@dinksociety.app',
    });
    const subject = action === 'approve'
      ? `${player.name || 'Your player'} is on your ${team.name || 'team'} roster`
      : `Roster request declined — ${player.name || 'your player'}`;
    try {
      await sendEmail({ to, subject, html, replyTo: 'dink@dinksociety.app' });
    } catch (err) {
      console.error('roster-approval email failed:', err?.message || err);
    }
  }

  // Approved means they are actually ON the roster now — that is the moment
  // the player hears from us. A rejection sends nothing to the player, who
  // never knew they were requested.
  if (action === 'approve') {
    await sendRosterWelcomesSafe({
      teamId,
      playerIds: [playerId],
      addedByName: player.pendingAddBy || team.captainName || '',
    });
  }

  await logActivity({
    type: action === 'approve' ? 'roster.add.approved' : 'roster.add.rejected',
    actor: { email: adminEmail || null, role: 'admin' },
    target: { teamId, teamName: team.name || '', playerId, playerName: player.name || '' },
  }).catch(() => {});

  return { ok: true, action, playerId, teamId, name: player.name || '', teamName: team.name || '', notified: to.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin notification: "a captain wants to add this player"
// ─────────────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function detailRow(label, value) {
  const v = value ? `<b style="color:#fff;">${esc(value)}</b>` : '<span style="color:#666;">&mdash;</span>';
  return `<tr>
    <td style="padding:8px 10px;font-size:12px;color:#8a8a8a;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;border-top:1px solid #222;white-space:nowrap;">${esc(label)}</td>
    <td style="padding:8px 10px;font-size:14px;color:#f5f5f5;border-top:1px solid #222;">${v}</td>
  </tr>`;
}

/**
 * Email every league admin that a captain has asked to add a player — with the
 * player's details in the email and one-tap Approve / Deny links (no sign-in).
 * One email per player. Best-effort: never throws.
 *
 * @param {{ team:object, player:object }} o  team = the saved team blob; player = the pending roster entry
 */
export async function notifyAdminsPendingRosterAdd({ team, player }) {
  try {
    const to = adminEmailList();
    if (!to.length || !team || !player || !player.id) return;

    const base = siteUrl();
    const adminUrl = `${base}/admin.html`;
    const teamName = team.name || 'a team';
    const season = seasonName(team.circuit || team.seasonId) || '';
    const requestedBy = player.pendingAddBy || team.captainEmail || 'the captain';
    const from = player.pendingAddFrom || null;

    let links = null;
    try {
      links = await createApprovalLinks({ kind: 'roster', teamId: team.id, playerId: player.id });
    } catch (e) {
      console.error('notifyAdminsPendingRosterAdd: token create failed (falling back to panel link):', e?.message || e);
    }
    const approveUrl = links ? `${base}/.netlify/functions/approval-decide?t=${links.approve}` : null;
    const denyUrl = links ? `${base}/.netlify/functions/approval-decide?t=${links.reject}` : null;

    const gender = player.gender === 'F' ? 'Female' : player.gender === 'M' ? 'Male' : player.gender || '';
    const details = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#161616;border-radius:8px;margin:0 0 14px;">
      <tr><td colspan="2" style="padding:12px 10px 6px;font-size:18px;font-weight:800;color:#f5f5f5;">${esc(player.name || 'Unnamed player')}</td></tr>
      ${detailRow('Gender', gender)}
      ${detailRow('Email', player.email)}
      ${detailRow('Phone', player.phone)}
      ${detailRow('DUPR', player.dupr)}
      ${detailRow('Requested by', requestedBy)}
    </table>`;

    const history = from
      ? `<p style="font-size:13px;color:#f5c842;line-height:1.5;margin:0 0 18px;">Has played in the league before &mdash; ${esc(from.teamName || 'another team')}${from.seasonName ? `, ${esc(from.seasonName)}` : ''}. Their stats follow their email either way.</p>`
      : `<p style="font-size:13px;color:#8a8a8a;line-height:1.5;margin:0 0 18px;">New to the league &mdash; no previous roster found for this email.</p>`;

    const buttons = approveUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 14px;"><tr>
          <td style="padding-right:6px;width:50%;"><a href="${approveUrl}" style="display:block;text-align:center;padding:14px 10px;background:#b8ff2c;color:#0e0e0e;font-size:15px;font-weight:800;text-decoration:none;border-radius:9999px;">&#10003; Approve</a></td>
          <td style="padding-left:6px;width:50%;"><a href="${denyUrl}" style="display:block;text-align:center;padding:13px 10px;background:transparent;color:#ff5c47;font-size:15px;font-weight:800;text-decoration:none;border:1px solid rgba(255,92,71,0.45);border-radius:9999px;">&#10005; Deny</a></td>
        </tr></table>
        <p style="font-size:12px;color:#777;line-height:1.5;margin:0 0 18px;">One tap does it &mdash; no sign-in. Approving emails the captain and welcomes the player; denying tells the captain. Links are single-use and expire in 14 days. <a href="${adminUrl}" style="color:#9a9e97;">Open admin panel</a> instead.</p>`
      : `<p style="margin:0 0 18px;"><a href="${adminUrl}" style="background:#b8ff2c;color:#0a0f08;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:9999px;display:inline-block;font-size:14px;">Open admin panel</a></p>`;

    const html = `<div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:36px 20px;background:#0e0e0e;color:#f5f5f5;">
      <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:#f5f5f5;margin-bottom:24px;">THE DINK SOCIETY</div>
      <h1 style="font-size:22px;font-weight:800;color:#f5f5f5;margin:0 0 12px;line-height:1.25;">Roster add awaiting approval</h1>
      <p style="font-size:15px;color:#cfcfcf;line-height:1.6;margin:0 0 18px;"><b style="color:#fff;">${esc(team.emoji ? team.emoji + ' ' : '')}${esc(teamName)}</b>${season ? ` (${esc(season)})` : ''} wants to add a player to their roster.</p>
      ${details}
      ${history}
      ${buttons}
      <div style="margin-top:28px;padding-top:16px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;">The Dink Society &middot; sent to league admins</div>
    </div>`;

    await sendEmail({
      to,
      subject: `Roster approval needed — ${player.name || 'New player'} (${teamName})`,
      html,
    });
  } catch (err) {
    console.error('notifyAdminsPendingRosterAdd failed (non-fatal):', err?.message || err);
  }
}
