// netlify/functions/lib/late-entry.js
//
// A private, one-team invite to join a season that is already under way — the
// way a replacement team comes in mid-season (Season 2: a new team takes the
// place FOURPLAY leaves from Week 6 on, starting from 0–0 at $270).
//
// The invite lives on the season record:
//   season.lateEntry = {
//     code, division, divisionLabel, price, startWeek,
//     replaces: { id, name } | null,
//     invitedName, invitedEmail, createdAt, createdBy, sentAt,
//     registrationId, teamId, usedAt            ← set once she registers
//   }
//
// Flow:
//   1. Admin → Schedule → "Replacement team" creates the invite and emails the
//      captain a link: /register.html?invite=<code>
//   2. The registration page (invite mode) takes the team name + captain only,
//      at the invite price, paid in full by Venmo, even though season
//      registration is closed.
//   3. register-checkout hands the request to registerLateEntry(): the spot is
//      CONFIRMED straight away (the team record exists, so the captain can log
//      into the Captain Portal and build the roster immediately). The fee stays
//      on the registration as a balance until the Venmo is logged.
//   4. Admin → "Redraw Weeks 6–10" (admin-extend-season with `replacement`)
//      puts the new team into the schedule in the departing team's slot.
//
// The invite is single-use: once a registration holds it, the link stops
// working (the admin can issue a fresh one).

import crypto from 'crypto';
import { getStore } from '@netlify/blobs';
import { sendEmail } from './email.js';
import { circuitCode, seasonCircuitCode } from './circuit.js';
import { VENMO_HANDLE, venmoProfileUrl } from './payment-terms.js';
import { normalizeEmail } from './identity.js';
import { run as confirmRegistration } from '../admin-registration-confirm.js';

const TZ = 'America/Los_Angeles';
export const DEFAULT_LATE_PRICE = 270;

export function siteUrl() {
  return process.env.SITE_URL || 'https://dinksociety.app';
}

export function newInviteCode() {
  return crypto.randomBytes(9).toString('base64url');
}

export function inviteUrl(code) {
  return `${siteUrl()}/register.html?invite=${encodeURIComponent(code)}#register`;
}

export function seasonLabelOf(season) {
  return season?.circuitName || season?.name || season?.label || 'the season';
}

// ── Season lookup ──────────────────────────────────────────────────────────
// Returns { key, season } for the season whose live invite matches `code`.
export async function findSeasonByInvite(code) {
  const c = String(code || '').trim();
  if (!c) return null;
  const store = getStore('seasons');
  const { blobs } = await store.list();
  for (const b of blobs) {
    const raw = await store.get(b.key).catch(() => null);
    if (!raw) continue;
    let s; try { s = JSON.parse(raw); } catch { continue; }
    if (s.isTest === true) continue;
    if (s.lateEntry?.code && safeEqual(s.lateEntry.code, c)) return { key: b.key, season: s };
  }
  return null;
}

// Season record for a circuit code ("II").
export async function findSeasonByCircuit(circuit) {
  const want = circuitCode(circuit);
  const store = getStore('seasons');
  const { blobs } = await store.list();
  for (const b of blobs) {
    const raw = await store.get(b.key).catch(() => null);
    if (!raw) continue;
    let s; try { s = JSON.parse(raw); } catch { continue; }
    if (s.isTest === true) continue;
    if (seasonCircuitCode(s) === want) return { key: b.key, season: s };
  }
  return null;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ── Dates: the weeks the new team plays ────────────────────────────────────
// Reads the division's week blobs from `startWeek` on. Returns
// [{ week, at, label, phase }] — the regular weeks first, then Championship
// Night if it is scheduled.
export async function lateEntryWeeks({ circuit, division, startWeek }) {
  const store = getStore('schedule');
  const out = [];
  for (let w = Number(startWeek) || 1; w <= 20; w++) {
    const data = await store.get(`schedule/${circuit}/${division}/week-${w}.json`, { type: 'json' }).catch(() => null);
    if (!data) break;
    const at = (data.matches || []).find(m => m.scheduledAt)?.scheduledAt || null;
    const venue = (data.matches || []).find(m => m.venue)?.venue || null;
    out.push({ week: w, at, venue, phase: data.phase || null, label: data.phaseLabel || `Week ${w}` });
  }
  return out;
}

export function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
}
export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}

// What the public registration page is allowed to see about an invite.
export function publicLateEntry(le, weeks = []) {
  if (!le) return null;
  return {
    division: le.division,
    divisionLabel: le.divisionLabel || le.division,
    price: Number(le.price) || DEFAULT_LATE_PRICE,
    startWeek: Number(le.startWeek) || 1,
    invitedName: le.invitedName || '',
    used: !!le.registrationId,
    weeks: weeks.map(w => ({ week: w.week, at: w.at, label: w.label, phase: w.phase, venue: w.venue })),
  };
}

// ── Emails ─────────────────────────────────────────────────────────────────
const WRAP_OPEN = `<div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#0e0e0e;color:#f5f5f5;">
  <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:#f5f5f5;margin-bottom:32px;">THE DINK SOCIETY</div>`;
const WRAP_CLOSE = `<div style="margin-top:40px;padding-top:20px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;">The Dink Society · Southern California Pickleball League</div></div>`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function scheduleRows(weeks) {
  if (!weeks.length) return '';
  const rows = weeks.map(w => `<tr><td style="padding:6px 0;color:#8a8a8a;">${esc(w.phase === 'championship' ? 'Championship Night' : 'Week ' + w.week)}</td><td style="padding:6px 0;text-align:right;font-weight:600;">${esc(fmtDay(w.at))}${w.at ? ' · ' + esc(fmtTime(w.at)) : ''}</td></tr>`).join('');
  const venue = weeks.find(w => w.venue)?.venue;
  return `<div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin-bottom:24px;">
    <div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#17d7b0;margin-bottom:12px;font-weight:700;">Your schedule${venue ? ' · ' + esc(venue) : ''}</div>
    <table style="width:100%;font-size:14px;color:#f5f5f5;">${rows}</table>
  </div>`;
}

export function renderInviteEmail({ name, seasonName, divisionLabel, price, weeks, url }) {
  const first = String(name || '').trim().split(/\s+/)[0];
  const regular = weeks.filter(w => w.phase !== 'championship').length;
  return `${WRAP_OPEN}
  <h1 style="font-size:24px;font-weight:800;text-transform:uppercase;color:#f5f5f5;margin:0 0 8px;">You're invited${first ? ', ' + esc(first) : ''}.</h1>
  <p style="font-size:15px;color:#8a8a8a;line-height:1.6;margin:0 0 24px;">
    There's a spot open in <strong style="color:#f5f5f5;">${esc(seasonName)}</strong> (${esc(divisionLabel)})${regular ? ` for the last <strong style="color:#f5f5f5;">${regular} weeks</strong> of the regular season` : ''}. Your team starts fresh at 0–0 and plays every night — no byes.
  </p>
  ${scheduleRows(weeks)}
  <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-left:3px solid #b8ff2c;padding:20px;border-radius:0 12px 12px 0;margin-bottom:24px;">
    <p style="font-size:14px;margin:0 0 14px;line-height:1.6;color:#8a8a8a;">
      <strong style="color:#f5f5f5;">Team fee: $${esc(price)}</strong> for the rest of the season. Register your team with the link below — it takes two minutes — then build your roster in the Captain Portal right away.
    </p>
    <a href="${esc(url)}" style="display:inline-block;padding:13px 30px;background:#b8ff2c;color:#0e0e0e;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;text-decoration:none;border-radius:9999px;">Register your team →</a>
  </div>
  <p style="font-size:12px;color:#555;line-height:1.6;margin:0;">This link is just for your team. If the button doesn't work, paste this into your browser:<br><span style="color:#8a8a8a;word-break:break-all;">${esc(url)}</span></p>
  ${WRAP_CLOSE}`;
}

export function renderLateConfirmedEmail({ name, teamName, seasonName, divisionLabel, price, weeks, venmo, portalUrl, refCode }) {
  const first = String(name || '').trim().split(/\s+/)[0];
  return `${WRAP_OPEN}
  <h1 style="font-size:24px;font-weight:800;text-transform:uppercase;color:#f5f5f5;margin:0 0 8px;">You're in${first ? ', ' + esc(first) : ''}.</h1>
  <p style="font-size:15px;color:#8a8a8a;line-height:1.6;margin:0 0 24px;">
    <strong style="color:#f5f5f5;">${esc(teamName)}</strong> is on the board for <strong style="color:#f5f5f5;">${esc(seasonName)}</strong> (${esc(divisionLabel)}). You start at 0–0.
  </p>
  <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-left:3px solid #b8ff2c;padding:20px;border-radius:0 12px 12px 0;margin-bottom:24px;">
    <p style="font-size:14px;margin:0 0 14px;line-height:1.6;color:#8a8a8a;">
      <strong style="color:#f5f5f5;">Next: build your roster.</strong> Log into the Captain Portal with this email address — we'll send you a sign-in link — and add your players. Each player gets a welcome email to sign the waivers.
    </p>
    <a href="${esc(portalUrl)}" style="display:inline-block;padding:13px 30px;background:#b8ff2c;color:#0e0e0e;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;text-decoration:none;border-radius:9999px;">Open the Captain Portal →</a>
  </div>
  <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-left:3px solid #3d95ce;padding:20px;border-radius:0 12px 12px 0;margin-bottom:24px;">
    <div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#3d95ce;margin-bottom:12px;font-weight:700;">Team fee — pay by Venmo</div>
    <table style="width:100%;font-size:14px;color:#f5f5f5;">
      <tr><td style="padding:6px 0;color:#8a8a8a;">Send to</td><td style="padding:6px 0;text-align:right;font-weight:700;">@${esc(venmo.handle)}</td></tr>
      <tr><td style="padding:6px 0;color:#8a8a8a;">Amount</td><td style="padding:6px 0;text-align:right;font-weight:700;color:#b8ff2c;">$${esc(price)}</td></tr>
      <tr><td style="padding:6px 0;color:#8a8a8a;">Note</td><td style="padding:6px 0;text-align:right;font-weight:600;">${esc(venmo.note)}</td></tr>
    </table>
    <a href="${esc(venmo.url)}" style="display:inline-block;margin-top:14px;padding:12px 28px;background:#3d95ce;color:#fff;font-size:13px;font-weight:700;text-decoration:none;border-radius:9999px;">Open Venmo →</a>
  </div>
  ${scheduleRows(weeks)}
  <p style="font-size:12px;color:#555;line-height:1.6;margin:0;">Reference: <span style="font-family:monospace;color:#8a8a8a;">${esc(refCode)}</span></p>
  ${WRAP_CLOSE}`;
}

// ── Registration through an invite ─────────────────────────────────────────
// Called by register-checkout when the payload carries `invite`. Returns a
// Response.
export async function registerLateEntry({ invite, path, team, paymentMethod }) {
  const hit = await findSeasonByInvite(invite);
  if (!hit) return text('This invite link is no longer valid. Ask the league for a new one.', 400);
  const { season } = hit;
  const le = season.lateEntry;

  if (path !== 'team') return text('This invite is for a team registration.', 400);
  if (!team?.name || !team?.players?.[0]?.email) return text('Team name and captain email are required.', 400);

  const regStore = getStore('registrations');
  if (le.registrationId) {
    const existing = await regStore.get(`confirmed/${le.registrationId}.json`, { type: 'json' }).catch(() => null)
      || await regStore.get(`pending/${le.registrationId}.json`, { type: 'json' }).catch(() => null);
    if (existing) return text('This invite has already been used to register a team.', 409);
  }

  const circuit = circuitCode(seasonCircuitCode(season));
  const seasonName = seasonLabelOf(season);
  const division = le.division;
  const divisionLabel = le.divisionLabel || season.divisions?.find(d => d.id === division)?.name || division;
  const price = Number(le.price) || DEFAULT_LATE_PRICE;
  const startWeek = Number(le.startWeek) || 1;

  const regId = crypto.randomBytes(8).toString('hex');
  const refCode = regId.slice(-6).toUpperCase();
  const now = new Date().toISOString();
  const venmo = {
    handle: VENMO_HANDLE,
    url: venmoProfileUrl(VENMO_HANDLE),
    amount: price,
    note: `Dink Society · ${team.name} · ${refCode}`,
    requestedAt: now,
  };
  const weeks = await lateEntryWeeks({ circuit, division, startWeek }).catch(() => []);
  const firstAt = weeks[0]?.at || null;

  const registration = {
    id: regId,
    seasonId: season.id || null,
    circuit,
    division,
    divisionLabel,
    path: 'team',
    status: 'pending',
    paymentMethod: paymentMethod === 'card' ? 'card' : 'venmo',
    paymentStatus: 'unpaid',
    price,
    totalPrice: price,
    paymentType: 'full',
    depositAmount: price,
    amountPaid: 0,
    balanceDue: price,
    balanceAfterDeposit: 0,
    // The fee is due by the team's first night.
    balanceDueDate: firstAt ? new Date(firstAt).toLocaleDateString('en-CA', { timeZone: TZ }) : null,
    venmo,
    team: {
      ...team,
      players: (team.players || []).slice(0, 1).map(p => ({ ...p, email: String(p.email || '').trim() })),
    },
    lateEntry: {
      startWeek,
      replaces: le.replaces || null,
      invitedEmail: le.invitedEmail || null,
    },
    createdAt: now,
  };
  await regStore.set(`pending/${regId}.json`, JSON.stringify(registration));

  // Confirm on the spot: creates the team record (Captain Portal login works
  // at once) and rebuilds the standings. `quiet` skips the "Venmo received"
  // email — nothing has been received yet.
  const confirmRes = await confirmRegistration({ id: regId, quiet: true }, { email: 'invite' });
  if (confirmRes.status >= 400) {
    const detail = await confirmRes.text().catch(() => '');
    console.error('late-entry confirm failed:', detail);
    return text('Could not save the registration. Please try again.', 500);
  }

  // Burn the invite (re-read the season so nothing written meanwhile is lost).
  const seasons = getStore('seasons');
  const fresh = JSON.parse(await seasons.get(hit.key) || 'null') || season;
  fresh.lateEntry = {
    ...(fresh.lateEntry || le),
    registrationId: regId,
    teamId: `team_${regId}`,
    teamName: team.name,
    usedAt: now,
  };
  await seasons.set(hit.key, JSON.stringify(fresh));

  const captainEmail = normalizeEmail(team.players[0].email) || team.players[0].email;
  const captainName = team.captain || team.players[0].name || '';
  try {
    await sendEmail({
      to: captainEmail,
      subject: `You're in — build your ${team.name} roster (${seasonName})`,
      html: renderLateConfirmedEmail({
        name: captainName, teamName: team.name, seasonName, divisionLabel, price, weeks,
        venmo, portalUrl: `${siteUrl()}/captain.html`, refCode: regId.toUpperCase(),
      }),
    });
  } catch (e) { console.error('late-entry captain email failed:', e); }

  const adminTo = process.env.EMAIL_ADMIN_BCC || process.env.EMAIL_REPLY_TO;
  if (adminTo) {
    try {
      await sendEmail({
        to: adminTo,
        subject: `Replacement team registered: ${team.name} — expect $${price} on Venmo`,
        html: `${WRAP_OPEN}
          <h1 style="font-size:20px;font-weight:800;margin:0 0 12px;">${esc(team.name)} is in</h1>
          <p style="font-size:14px;color:#cfcfcf;line-height:1.6;margin:0 0 16px;">${esc(captainName || captainEmail)} registered through the invite link for ${esc(seasonName)} (${esc(divisionLabel)})${le.replaces?.name ? `, taking ${esc(le.replaces.name)}'s place` : ''}. The team is confirmed and can build its roster now. Look for <b style="color:#fff;">$${price}</b> on Venmo with note <b style="color:#fff;">${esc(venmo.note)}</b> and log it in the team's Payments.</p>
          <p style="font-size:14px;color:#cfcfcf;line-height:1.6;margin:0 0 16px;"><b style="color:#fff;">Next:</b> Admin → Schedule → Replacement team → <b style="color:#fff;">Redraw Weeks ${startWeek}+</b> to put them on the schedule.</p>
          <a href="${siteUrl()}/admin.html" style="display:inline-block;padding:12px 28px;background:#b8ff2c;color:#0e0e0e;font-size:13px;font-weight:700;text-decoration:none;border-radius:9999px;">Open Admin →</a>
        ${WRAP_CLOSE}`,
      });
    } catch (e) { console.error('late-entry admin email failed:', e); }
  }

  return new Response(JSON.stringify({
    confirmationUrl: `${siteUrl()}/register-success.html?id=${regId}&late=1`,
    paymentMethod: 'venmo',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function text(msg, status) {
  return new Response(msg, { status });
}
