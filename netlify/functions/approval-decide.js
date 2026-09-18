// netlify/functions/approval-decide.js
// One-tap Approve / Deny from the admin "needs your approval" emails — profile
// photo/bio changes and captains' roster-add requests. The token carries its
// own auth (unguessable, single-use, expiring) — no login, same as the ladder
// Venmo confirm links. GET so it works straight from an inbox.
//
//   GET ?t=<token>   token.kind 'profile' | 'roster', token.action 'approve' | 'reject'
//
// The decision logic is shared with the admin panel (lib/profile-approvals.js,
// lib/roster-approvals.js), so a tap here is exactly the same as clicking the
// button in the Approvals tab. If the item was already ruled on (in the panel,
// or via the other link) the record has nothing pending and you get an
// "Already handled" page — nothing double-fires.

import { consumeApprovalToken } from './lib/approval-token.js';
import { decideProfileChange, ApprovalError } from './lib/profile-approvals.js';
import { decideRosterAdd, RosterApprovalError } from './lib/roster-approvals.js';
import { resultPage } from './lib/ladder-notify.js';

const LIME = '#b8ff2c';
const GOLD = '#f5c842';
const RED = '#ff5c47';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function adminLink() {
  return ' <a href="https://dinksociety.app/admin.html" style="color:#b8ff2c;">Open the admin panel</a> to see the queue.';
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const token = new URL(req.url).searchParams.get('t');
  const rec = await consumeApprovalToken(token);
  if (!rec || (rec.action !== 'approve' && rec.action !== 'reject')) {
    return resultPage('Link expired', 'This approval link is no longer valid — it may have already been used.' + adminLink(), RED);
  }

  const approved = rec.action === 'approve';

  try {
    if (rec.kind === 'profile') {
      const out = await decideProfileChange({ teamId: rec.teamId, playerId: rec.playerId, action: rec.action });
      return approved
        ? resultPage('Approved ✓', `${esc(out.name)}'s profile change is live on their player page.`, LIME)
        : resultPage('Denied', `${esc(out.name)}'s profile change was discarded. Their current profile is unchanged.`, GOLD);
    }
    if (rec.kind === 'roster') {
      const out = await decideRosterAdd({ teamId: rec.teamId, playerId: rec.playerId, action: rec.action, adminEmail: 'admin (email link)' });
      return approved
        ? resultPage('Approved ✓', `${esc(out.name)} is on the ${esc(out.teamName)} roster. The captain${out.notified ? ' and the player have' : ' has'} been emailed.`, LIME)
        : resultPage('Denied', `${esc(out.name)} was not added to ${esc(out.teamName)}. The captain has been told.`, GOLD);
    }
    return resultPage('Link expired', 'This approval link is no longer valid.' + adminLink(), RED);
  } catch (err) {
    if ((err instanceof ApprovalError || err instanceof RosterApprovalError) && err.status === 409) {
      return resultPage('Already handled', 'This one was already approved or denied — nothing pending here.' + adminLink(), GOLD);
    }
    if ((err instanceof ApprovalError || err instanceof RosterApprovalError) && err.status === 404) {
      return resultPage('Not found', 'That player or team no longer exists.' + adminLink(), RED);
    }
    console.error('[approval-decide] failed:', err);
    return resultPage('Something went wrong', 'The change could not be applied. Try it from the admin panel instead.' + adminLink(), RED);
  }
};

export const config = { path: '/.netlify/functions/approval-decide' };
