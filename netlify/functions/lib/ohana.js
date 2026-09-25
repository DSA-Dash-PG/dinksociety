// netlify/functions/lib/ohana.js
// I/O for the private South Bay Ohana page (/ohana): storage, who may see it,
// and the team emails. Pure logic lives in ./ohana-core.js.
//
// ACCESS. Only people on the Ohana roster (by email) and the site owner can
// load anything. Sign-in is the normal Dink Society player sign-in (or a
// captain/admin session) — we just check that session's email against the
// roster here. Managers (roster entries with manager:true, plus the owner) can
// edit the lineup, scores, schedule and roster.

import { getStore } from '@netlify/blobs';
import { requirePlayer } from './player-auth.js';
import { verifyCaptainSession } from './auth.js';
import { requireAdmin } from './admin-auth.js';
import { isOwnerEmail } from './owner.js';
import { normalizeEmail } from './identity.js';
import { sendEmail } from './email.js';
import { siteUrl } from './ladder-notify.js';
import {
  SLUG, seedLeague, teamName, matchDate, ourSide, opponentOf, isOurs, dateLine, gamesByPlayer, roundOf, typeOf, TYPE_LABEL,
} from './ohana-core.js';

const KEY = `league/${SLUG}.json`;

/** Shown at the top of /ohana until a manager edits or clears it. */
export const DEFAULT_ANNOUNCEMENT = {
  title: 'League play begins next week!',
  body: 'The full PVTC league rules are in the Rules section below — please review them and have a copy with you. The recap covers the most important rules for the PVTC league.',
};
function store() { return getStore({ name: 'private-leagues', consistency: 'strong' }); }

export async function loadLeague() {
  const s = store();
  let league = await s.get(KEY, { type: 'json' }).catch(() => null);
  if (!league) { league = seedLeague(); await s.setJSON(KEY, league); }
  return league;
}
export async function saveLeague(league) {
  league.updatedAt = new Date().toISOString();
  if (Array.isArray(league.log) && league.log.length > 200) league.log = league.log.slice(-200);
  await store().setJSON(KEY, league);
}

/** Resolve the signed-in email from any Dink Society session. */
async function sessionEmail(req) {
  const p = await requirePlayer(req).catch(() => null);
  if (p?.session?.email) return normalizeEmail(p.session.email);
  const c = await verifyCaptainSession(req).catch(() => null);
  if (c?.valid && c.payload?.session?.email) return normalizeEmail(c.payload.session.email);
  const a = await requireAdmin(req).catch(() => null);
  if (a?.email) return normalizeEmail(a.email);
  return null;
}

/** { email, entry, owner, canEdit, allowed } — `signedIn:false` when no session. */
export async function viewer(req, league) {
  const email = await sessionEmail(req);
  if (!email) return { signedIn: false, allowed: false };
  const entry = (league.roster || []).find(p => p.email === email) || null;
  const owner = isOwnerEmail(email);
  return { signedIn: true, email, entry, owner, allowed: !!(entry || owner), canEdit: !!(owner || entry?.manager) };
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

export const pageUrl = () => `${siteUrl()}/ohana`;

// ── Email ────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const LIME = '#b8ff2c', TEAL = '#17d7b0';
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';

function shell({ h1, body, accent = TEAL }) {
  return `
  <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;background:#0e0e0e;color:#f5f5f5;">
    <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:${accent};margin-bottom:6px;">SOUTH BAY OHANA</div>
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#666;margin-bottom:26px;">PVTC Fall 2026 · 3.5 Mixed</div>
    <h1 style="font-size:22px;font-weight:800;color:#f5f5f5;margin:0 0 14px;line-height:1.25;">${esc(h1)}</h1>
    ${body}
    <div style="margin:28px 0 0;"><a href="${pageUrl()}" style="display:inline-block;padding:14px 32px;background:${LIME};color:#0e0e0e;font-weight:800;font-size:14px;text-decoration:none;border-radius:9999px;">Open the team page</a></div>
    <div style="margin-top:34px;padding-top:20px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;line-height:1.6;">
      You're getting this because you're on the South Bay Ohana roster. Private team page — sign in with your Dink Society email.<br>The Dink Society · Southern California Pickleball League
    </div>
  </div>`;
}

function matchCard(league, wk, m) {
  const side = ourSide(league, m);
  const opp = teamName(league, opponentOf(league, m));
  const ha = side === 'home' ? 'Home' : 'Away';
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;border-collapse:collapse;">
    <tr><td style="padding:14px 16px;background:#161616;border-left:3px solid ${LIME};border-radius:6px;">
      <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#8a8a8a;">${esc(wk.label)} · ${esc(ha)}</div>
      <div style="font-size:17px;font-weight:800;color:#f5f5f5;margin-top:4px;">vs ${esc(opp)}</div>
      <div style="font-size:13px;color:#cfcfcf;margin-top:4px;">${esc(dateLine(matchDate(wk, m), m.time))}</div>
      <div style="font-size:12px;color:#8a8a8a;margin-top:2px;">${esc(league.venue)} · Courts ${esc(m.courts)}${m.note ? ' · ' + esc(m.note) : ''}</div>
    </td></tr></table>
    <p style="font-size:12px;color:#8a8a8a;line-height:1.6;margin:-8px 0 20px;">${side === 'home'
      ? '<b style="color:#f5f5f5">We\'re home:</b> our captain picks up the game balls and clipboards at the front desk. We serve first in Round 1; they choose sides.'
      : '<b style="color:#f5f5f5">We\'re away:</b> they serve first in Round 1 and we choose sides. Switch in Round 2.'}
      Lineups are exchanged 10 minutes before start. Warm-up courts aren't guaranteed — you can arrive 30 min early; the captain checks with the front desk.</p>`;
}

function lineupTable(league, m, highlight) {
  const nameOf = (e) => league.roster.find(p => p.email === e)?.name || '';
  const rows = (m.slots || []).filter(s => s.players.some(Boolean)).map(s => {
    const mine = highlight && s.players.includes(highlight);
    const pair = s.players.map(nameOf).filter(Boolean).join(' & ') || 'TBD';
    const head = (s.no === 1 || s.no === 7) ? `<tr><td colspan="2" style="padding:${s.no === 1 ? 4 : 12}px 0 4px;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#666;">Round ${roundOf(s.no)}</td></tr>` : '';
    return `${head}<tr><td style="padding:5px 0;color:#8a8a8a;width:92px;">G${s.no} ${TYPE_LABEL[typeOf(s.no)]}</td><td style="padding:5px 0;color:${mine ? TEAL : '#cfcfcf'};${mine ? 'font-weight:700;' : ''}">${esc(pair)}</td></tr>`;
  }).join('');
  if (!rows) return '';
  return `<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#8a8a8a;margin:0 0 8px;">Full lineup</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:13px;margin:0 0 8px;">${rows}</table>`;
}

function myGamesLine(league, m, email) {
  const g = gamesByPlayer(league, m.slots)[email] || [];
  if (!g.length) return `<p style="font-size:15px;color:#cfcfcf;line-height:1.6;margin:0 0 18px;">You're not in the lineup this week — thanks for being ready if we need a sub.</p>`;
  const items = g.map(x => `<b style="color:${TEAL}">R${x.round} · G${x.no}</b> <span style="color:#8a8a8a">${TYPE_LABEL[x.type]}</span>${x.partner ? ' with ' + esc(x.partner) : ''}`).join('<br>');
  return `<p style="font-size:15px;color:#cfcfcf;line-height:1.6;margin:0 0 6px;">You're in <b>${g.length} game${g.length === 1 ? '' : 's'}</b>:</p>
    <p style="font-size:14px;color:#cfcfcf;line-height:1.8;margin:0 0 18px;">${items}</p>`;
}

async function sendAll(recipients, build) {
  const out = { sent: 0, failed: 0 };
  for (const p of recipients) {
    if (!p?.email) continue;
    try {
      const { subject, html } = build(p);
      await sendEmail({ to: p.email, subject, html });
      out.sent++;
    } catch (e) { console.error('[ohana] email failed', p.email, e?.message || e); out.failed++; }
  }
  return out;
}

/** Lineup posted (first time) or changed. `only` limits to players whose games moved. */
export async function emailLineup(league, wk, m, { changed = false, only = null } = {}) {
  const opp = teamName(league, opponentOf(league, m));
  const recips = only ? league.roster.filter(p => only.includes(p.email)) : league.roster;
  return sendAll(recips, (p) => ({
    subject: changed ? `Lineup change · ${wk.label} vs ${opp}` : `Lineup is set · ${wk.label} vs ${opp}`,
    html: shell({
      h1: changed ? `Heads up ${firstName(p.name)} — the lineup changed` : `Hi ${firstName(p.name)} — the lineup is set`,
      body: matchCard(league, wk, m) + myGamesLine(league, m, p.email) + lineupTable(league, m, p.email),
    }),
  }));
}

/** Day-before reminder (or bye-week note when m is null). */
export async function emailReminder(league, wk, m) {
  if (!m) {
    return sendAll(league.roster, (p) => ({
      subject: `Bye week · ${wk.label} (${dateLine(wk.date)})`,
      html: shell({ h1: `No match for us ${wk.label.replace(/ ·.*/, '')}`, accent: '#8a8a8a',
        body: `<p style="font-size:15px;color:#cfcfcf;line-height:1.6;margin:0 0 18px;">Hi ${esc(firstName(p.name))} — South Bay Ohana has a bye on ${esc(dateLine(wk.date))}. Enjoy the night off.</p>` }),
    }));
  }
  const opp = teamName(league, opponentOf(league, m));
  const hasLineup = (m.slots || []).some(s => s.players.some(Boolean));
  return sendAll(league.roster, (p) => ({
    subject: `Tomorrow: South Bay Ohana vs ${opp} · ${m.time}`,
    html: shell({ h1: `Match tomorrow vs ${opp}`,
      body: matchCard(league, wk, m) + (hasLineup
        ? myGamesLine(league, m, p.email) + lineupTable(league, m, p.email)
        : `<p style="font-size:15px;color:#cfcfcf;line-height:1.6;margin:0 0 18px;">Lineup is still being set — you'll get another email as soon as it's posted.</p>`) }),
  }));
}

/** Schedule change for one of our matches. */
export async function emailScheduleChange(league, wk, m, lines) {
  const opp = teamName(league, opponentOf(league, m));
  return sendAll(league.roster, (p) => ({
    subject: `Schedule change · ${wk.label} vs ${opp}`,
    html: shell({ h1: 'Schedule change', accent: '#ffb02e',
      body: `<p style="font-size:15px;color:#cfcfcf;line-height:1.6;margin:0 0 12px;">Hi ${esc(firstName(p.name))} — something changed for ${esc(wk.label)}:</p>
        <ul style="font-size:14px;color:#f5f5f5;line-height:1.7;margin:0 0 18px;padding-left:18px;">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` + matchCard(league, wk, m) }),
  }));
}

/** Final score. */
export async function emailResult(league, wk, m, r) {
  const side = ourSide(league, m);
  const us = side === 'home' ? r.home : r.away, them = side === 'home' ? r.away : r.home;
  const pu = side === 'home' ? r.ptsHome : r.ptsAway, pt = side === 'home' ? r.ptsAway : r.ptsHome;
  const opp = teamName(league, opponentOf(league, m));
  const verdict = pu > pt ? 'W' : pu < pt ? 'L' : 'T';
  const roundsLine = r.rounds.map((x, i) => { const a = side === 'home' ? x.home : x.away, b = side === 'home' ? x.away : x.home; return `Round ${i + 1}: ${a}–${b}`; }).join(' · ');
  const nameOf = (e) => league.roster.find(p => p.email === e)?.name || '';
  const rows = (m.slots || []).filter(s => s.us != null && s.them != null).map(s =>
    `<tr><td style="padding:4px 0;color:#8a8a8a;width:40px;">G${s.no}</td><td style="padding:4px 0;color:#cfcfcf;">${esc(s.players.map(nameOf).filter(Boolean).join(' & '))}</td><td style="padding:4px 0;text-align:right;color:${s.us > s.them ? TEAL : '#ff5c47'};font-weight:700;">${s.us}–${s.them}</td></tr>`).join('');
  return sendAll(league.roster, () => ({
    subject: `${verdict} vs ${opp} · ${pu} of 4 pts (${us}–${them} games) · ${wk.label}`,
    html: shell({ h1: `${verdict === 'W' ? 'Win' : verdict === 'L' ? 'Loss' : 'Split'} vs ${opp} — ${pu} of 4 points`,
      body: `<p style="font-size:14px;color:#cfcfcf;margin:0 0 4px;">${esc(roundsLine)} · ${us}–${them} games overall</p><p style="font-size:13px;color:#8a8a8a;margin:0 0 14px;">${esc(wk.label)} · ${esc(dateLine(matchDate(wk, m)))}</p>` +
        (rows ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:13px;">${rows}</table>` : '') }),
  }));
}

/** Free-form note from a manager to the whole team. */
export async function emailMessage(league, fromName, subject, text) {
  return sendAll(league.roster, (p) => ({
    subject: subject || 'South Bay Ohana update',
    html: shell({ h1: subject || 'Team update',
      body: `<p style="font-size:15px;color:#cfcfcf;line-height:1.65;margin:0 0 12px;">Hi ${esc(firstName(p.name))},</p><p style="font-size:15px;color:#cfcfcf;line-height:1.65;margin:0 0 12px;">${esc(text).replace(/\n/g, '<br>')}</p><p style="font-size:13px;color:#8a8a8a;margin:0;">— ${esc(fromName || 'Your captain')}</p>` }),
  }));
}

/** Nudge managers two days out when the lineup is empty. */
export async function emailLineupNudge(league, wk, m) {
  const opp = teamName(league, opponentOf(league, m));
  const managers = league.roster.filter(p => p.manager);
  return sendAll(managers, (p) => ({
    subject: `Set the lineup · ${wk.label} vs ${opp}`,
    html: shell({ h1: 'Lineup not set yet', accent: '#ffb02e',
      body: `<p style="font-size:15px;color:#cfcfcf;line-height:1.6;margin:0 0 18px;">Hi ${esc(firstName(p.name))} — we play ${esc(opp)} ${esc(dateLine(matchDate(wk, m), m.time))} and the lineup is empty. Post it on the team page and everyone gets their games by email.</p>` + matchCard(league, wk, m) }),
  }));
}

export { isOurs };
