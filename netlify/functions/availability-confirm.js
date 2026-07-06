// netlify/functions/availability-confirm.js
//
// Public, no-login endpoint behind the one-tap buttons in the reminder email.
//   GET ?t=<signed token>   → records the player's status and shows a confirmation
//
// The token (lib/availability-token.js) binds { matchId, teamId, playerId, status },
// so a link can't be tampered to mark someone else or flip the status. Idempotent:
// re-hitting is safe, and the confirmation page offers the opposite button so a
// player can change their mind.

import { getStore } from '@netlify/blobs';
import { circuitCode } from './lib/circuit.js';
import { getTeamAvailability, setPlayerAvailability } from './lib/availability.js';
import { verifyAvailabilityToken, signAvailabilityToken } from './lib/availability-token.js';
import { notifyCaptainsOfChange } from './lib/availability-notify.js';
import { logActivity } from './lib/activity-log.js';

const TZ = 'America/Los_Angeles';

export default async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  const decoded = verifyAvailabilityToken(token);
  if (!decoded) return page('Link expired or invalid', 'This confirmation link is no longer valid. Please open the team portal to set your availability.', null);

  const { matchId, teamId, playerId, status } = decoded;
  const team = await getStore('teams').get(`team/${teamId}.json`, { type: 'json' }).catch(() => null);
  if (!team) return page('Team not found', 'We could not find your team. It may have changed.', null);
  const player = (team.roster || []).find(p => p.id === playerId);
  const match = await findMatch(team, matchId);

  // Too late to change — match started or finalized.
  const started = match?.scheduledAt && Date.now() >= new Date(match.scheduledAt).getTime();
  if (!match || match.finalizedAt || started) {
    return page('Too late to change', 'This match has already started or wrapped up, so availability is locked. Thanks anyway!', team);
  }

  // Previous status (null = no response) → only notify the captain on a real change.
  const before = await getTeamAvailability(matchId, teamId);
  const prev = before.players?.[playerId]?.status || null;

  await setPlayerAvailability({
    matchId, teamId, playerId, status,
    reason: '', byEmail: player?.email || null, byRole: 'player',
  });

  // Let the captain know without them logging in; the email links back to set the
  // lineup. Best-effort — never block the player's confirmation on it.
  if (prev !== status && player) {
    try { await notifyCaptainsOfChange({ team, player, actingEmail: player.email, match, status, reason: '' }); }
    catch (e) { console.warn('availability confirm notify failed:', e?.message || e); }
  }

  await logActivity({
    type: 'availability.set',
    actor: { email: player?.email || null, role: 'player' },
    team, matchId, week: match.week, circuit: circuitCode(team.circuit),
    details: `${player?.name || 'A player'} marked ${status === 'out' ? 'UNAVAILABLE' : 'available'} for Week ${match.week} (email link)`,
  }).catch(() => {});

  const isOut = status === 'out';
  const oppToken = signAvailabilityToken({ matchId, teamId, playerId, status: isOut ? 'in' : 'out' });
  const oppUrl = `/.netlify/functions/availability-confirm?t=${encodeURIComponent(oppToken)}`;
  const dateLine = buildDateLine(match);
  const title = isOut ? "You're marked OUT" : "You're in! ✓";
  const body = isOut
    ? `Thanks for letting your captain know you can't make Week ${match.week}.`
    : `Nice — your captain knows you're playing Week ${match.week}.`;
  const flip = isOut
    ? `Change of plans? <a href="${oppUrl}" style="color:#b8ff2c;font-weight:700;">I can play after all</a>`
    : `Something come up? <a href="${oppUrl}" style="color:#ff9a3c;font-weight:700;">I can't make it</a>`;

  return page(title, body, team, { dateLine, flip, out: isOut });
};

async function findMatch(team, matchId) {
  const scheduleStore = getStore('schedule');
  const circuit = circuitCode(team.circuit);
  for (let week = 1; week <= 12; week++) {
    const data = await scheduleStore
      .get(`schedule/${circuit}/${team.division}/week-${week}.json`, { type: 'json' })
      .catch(() => null);
    if (!data?.matches) continue;
    const m = data.matches.find(x => x.id === matchId);
    if (m && (m.teamA?.id === team.id || m.teamB?.id === team.id)) return { ...m, week };
  }
  return null;
}

function buildDateLine(match) {
  if (!match) return '';
  const parts = [`Week ${match.week}`];
  if (match.scheduledAt) {
    const d = new Date(match.scheduledAt);
    if (!isNaN(d)) parts.push(d.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ,
    }));
  }
  if (match?.court) parts.push(match.court);
  return parts.join(' · ');
}

function page(title, body, team, extra) {
  const accent = extra?.out ? '#ff9a3c' : '#b8ff2c';
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(title)} · The Dink Society</title>
    <style>
      body{margin:0;background:#0e0e0e;color:#f0f0ec;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;}
      .card{max-width:400px;width:100%;background:#161616;border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:34px 28px;text-align:center;}
      .brand{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#17d7b0;font-weight:800;}
      h1{font-size:26px;font-weight:900;font-style:italic;text-transform:uppercase;margin:16px 0 10px;color:${accent};}
      p{font-size:15px;line-height:1.6;color:#c8ccc4;margin:0 0 14px;}
      .meta{font-size:12px;color:#7a7f77;margin:14px 0;padding:12px;background:#1e1e1e;border-radius:10px;}
      .flip{font-size:13px;color:#9a9e97;margin-top:18px;}
      a{color:${accent};}
    </style></head><body>
    <div class="card">
      <div class="brand">The Dink Society</div>
      <h1>${esc(title)}</h1>
      <p>${body}</p>
      ${extra?.dateLine ? `<div class="meta">${esc(extra.dateLine)}${team ? ' · ' + esc(team.name) : ''}</div>` : ''}
      ${extra?.flip ? `<div class="flip">${extra.flip}</div>` : ''}
    </div></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const config = { path: '/.netlify/functions/availability-confirm' };
