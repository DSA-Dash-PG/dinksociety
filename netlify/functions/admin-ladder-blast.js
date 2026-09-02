// netlify/functions/admin-ladder-blast.js
// POST /api/admin-ladder-blast  (admin session required — never reachable by an
// organizer session; there is no organizer-facing UI or endpoint that calls this)
// — marketing blast to every past ladder participant (roster OR waitlist, across
// all ladders).
//
// Body:
//   { mode: 'recruit', eventId, neededCount?, confirmPrivate? }  → "we need N more for <ladder>"
//   { mode: 'open', audience? }                                  → "new ladders are open to register"
//
// audience (announcements only): 'ladder' (default — people who have played),
// 'league' (team rosters only), or 'all' (both, deduped). League players who
// have never played a ladder get an explainer opening instead of the regular
// one, plus the season-registration module when a season is taking sign-ups.
//
// Recruit excludes anyone already registered/waitlisted for that event.
//
// Recruit works for ANY event regardless of status (open/full/live/final) — an
// admin can blast a past or in-progress ladder just as easily as an upcoming one.
// A visibility:'private' (invite-only) ladder is normally excluded from broad
// announcements, but admin can deliberately override that and blast it to the
// whole league anyway by passing confirmPrivate:true — a conscious one-off choice,
// not the default. Without that flag the request 409s so the UI can re-prompt with
// an explicit "this is private, send anyway?" confirmation before retrying.

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { listEvents, getEvent, getSignups, eventStartMs, spotsLeft, effectiveCapacity } from './lib/ladder.js';
import { sendNotify } from './lib/notify-prefs.js';
import { dateLineOf, siteUrl } from './lib/ladder-notify.js';
import { normalizeEmail } from './lib/identity.js';
import { divisionBadge, divisionLabel, divisionTitle, courtsLabel, spotsModule, ctaButton, inviteButton } from './lib/ladder-email-ui.js';
import { getStore } from '@netlify/blobs';
import { listLitePlayers } from './lib/ladder-players.js';
import { isActivePlayer } from './lib/roster.js';
import { isTestTeam, seasonName } from './lib/circuit.js';
import { currentSeasonInfo, startMs } from './lib/current-season.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }
function blastFrom() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('LADDER_FROM')) || process.env.LADDER_FROM || 'dink@dinksociety.app';
}

// Ladder-only players who registered but may not have played yet. Queen of the
// Court is a women's ladder, not a separate product, so it is already covered by
// pastParticipants() — nothing extra is needed for it.
async function ladderRegistrants() {
  const byEmail = new Map();
  try {
    for (const p of (await listLitePlayers())) {
      const e = normalizeEmail(p.email);
      if (e && !byEmail.has(e)) byEmail.set(e, p.name || '');
    }
  } catch { /* ladder-players store may not exist yet */ }
  return byEmail;
}

// Everyone on a league team roster. Most of them have never played a ladder —
// they're the point of the wider announcement.
async function leaguePlayers() {
  const byEmail = new Map();
  try {
    const store = getStore('teams');
    const { blobs } = await store.list({ prefix: 'team/' });
    for (const b of blobs) {
      const team = await store.get(b.key, { type: 'json' }).catch(() => null);
      if (!team || isTestTeam(team)) continue;
      for (const p of (team.roster || [])) {
        if (!isActivePlayer(p)) continue;         // no pending adds, no archived
        const e = normalizeEmail(p.email);
        if (e && !byEmail.has(e)) byEmail.set(e, p.name || '');
      }
    }
  } catch { /* teams store unreadable — fall back to ladder audience only */ }
  return byEmail;
}

// The season to point people at: open for registration and still ahead of us.
async function registrationPitch(site) {
  try {
    const store = getStore('seasons');
    const { blobs } = await store.list();
    const seasons = (await Promise.all(
      blobs.map(x => store.get(x.key, { type: 'json' }).catch(() => null))
    )).filter(x => x && x.status !== 'archived' && x.status !== 'draft');
    if (!seasons.length) return null;
    const info = currentSeasonInfo(seasons, Date.now());
    // Prefer a season taking sign-ups; otherwise the next one on the calendar.
    const open = seasons
      .filter(x => String(x.registration || x.status || '').toLowerCase() === 'open')
      .filter(x => { const t = startMs(x); return t == null || t > Date.now(); })
      .sort((a, b) => (startMs(a) || 0) - (startMs(b) || 0))[0];
    const season = open || null;
    if (!season) return null;
    const start = startMs(season);
    const when = start
      ? new Date(start).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
      : null;
    const weeksOut = start ? Math.max(0, Math.round((start - Date.now()) / 6048e5)) : null;
    return {
      name: season.name || season.label || seasonName(season.circuit || season.id),
      when,
      weeksOut,
      url: `${site}/register.html`,
      currentName: info && info.name,
    };
  } catch { return null; }
}

// Every past participant: email → display name (first seen).
async function pastParticipants(circuit) {
  const events = await listEvents({ circuit });
  const byEmail = new Map();
  for (const ev of events) {
    const su = await getSignups(ev.id);
    for (const p of [...(su.roster || []), ...(su.waitlist || [])]) {
      const e = normalizeEmail(p.email);
      if (e && !byEmail.has(e)) byEmail.set(e, p.name || '');
    }
  }
  return byEmail;
}

function shell(inner) {
  return `<div style="background:#0e0e0e;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f5f5f5;max-width:600px;margin:0 auto;padding:36px 26px">
    <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-bottom:22px">THE DINK SOCIETY <span style="color:#17d7b0">· LADDER</span></div>
    ${inner}
    <div style="margin-top:30px;padding-top:16px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;line-height:1.6"><b style="color:#8a8a8a;font-weight:700">THE DINK SOCIETY · LADDER</b> · Open play, round-robin nights.</div>
  </div>`;
}

function evCard(ev, site) {
  const cap = effectiveCapacity(ev);
  const left = ev.spotsLeft != null ? ev.spotsLeft : '';
  const badgeUrl = `${site}/.netlify/functions/public-ladder-badge?event=${encodeURIComponent(ev.id)}`;
  const openTxt = left !== '' ? `${left} spot${left === 1 ? '' : 's'} open` : '';
  return `<div style="background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:15px 18px;margin:0 0 14px">
    <span style="display:inline-block;font-size:10px;font-weight:800;letter-spacing:.08em;color:#0e0e0e;background:#b8ff2c;padding:3px 9px;border-radius:9999px">${esc(divisionLabel(ev.type))}</span>
    <div style="font-size:15px;font-weight:800;margin-top:8px">${esc(ev.name)}</div>
    <div style="font-size:12.5px;color:#17d7b0;font-weight:700;margin-top:4px">${esc(dateLineOf(ev))}</div>
    <a href="${site}/ladders.html?event=${encodeURIComponent(ev.id)}" style="text-decoration:none;display:block"><img src="${esc(badgeUrl)}" width="300" alt="${esc(left)} of ${esc(cap)} spots left" style="display:block;border:0;outline:none;width:100%;max-width:300px;height:auto;margin:10px 0 4px"></a>
    <div style="font-size:12px;color:#8a8a8a;margin-top:2px">📍 ${esc(ev.place || '')} · ${esc(courtsLabel(ev))}${openTxt ? ` · <span style="color:#b8ff2c;font-weight:700">${esc(openTxt)}</span>` : ''}</div>
    <div style="margin-top:12px">${ctaButton(`${site}/ladders.html?event=${encodeURIComponent(ev.id)}`, 'Lock My Spot →')}</div>
  </div>`;
}

function renderRecruit({ name, event, needed, left, cap, site }) {
  return shell(`
    ${divisionBadge(event.type)}
    <h1 style="font-size:26px;font-weight:800;line-height:1.15;margin:0 0 12px">We need <span style="color:#b8ff2c">${esc(needed)}</span> more, ${esc(firstName(name))}.</h1>
    <p style="font-size:15px;color:#cfcfcf;line-height:1.7;margin:0 0 20px">A spot (or ${esc(needed)}) just opened up for an upcoming ${esc(divisionTitle(event.type))} ladder. If you're free, jump in — it fills fast.</p>
    ${spotsModule({ event, left, cap, site })}
    <div style="background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:15px 18px;margin:0 0 18px">
      <div style="font-size:16px;font-weight:800">${esc(event.name)}</div>
      <div style="font-size:13px;color:#17d7b0;font-weight:700;margin-top:5px">${esc(dateLineOf(event))}</div>
      <div style="font-size:12px;color:#8a8a8a;margin-top:7px">📍 ${esc(event.place || '')} · ${esc(courtsLabel(event))} · ${esc(divisionTitle(event.type))}</div>
    </div>
    ${ctaButton(`${site}/ladders.html?event=${encodeURIComponent(event.id)}`, 'Grab a Spot →')}
    ${inviteButton(event, site)}
    <p style="font-size:12.5px;color:#777;margin-top:16px">Not this time? No worries — you'll always get first look at the next one.</p>
  `);
}
// The registration nudge, appended to every announcement while a season is
// taking sign-ups. Silent when there's nothing open — no empty module.
function seasonModule(pitch) {
  if (!pitch) return '';
  const timing = pitch.weeksOut != null && pitch.weeksOut > 0
    ? `starts in about ${pitch.weeksOut} week${pitch.weeksOut === 1 ? '' : 's'}`
    : 'starts soon';
  return `<div style="background:rgba(184,255,44,.07);border:1px solid rgba(184,255,44,.28);border-radius:12px;padding:16px 18px;margin:22px 0 6px">
    <div style="font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#b8ff2c;margin-bottom:7px">Also — league registration is open</div>
    <div style="font-size:15px;font-weight:800;margin-bottom:5px">${esc(pitch.name)} ${esc(timing)}${pitch.when ? ` · ${esc(pitch.when)}` : ''}.</div>
    <p style="font-size:13.5px;color:#cfcfcf;line-height:1.65;margin:0 0 13px">Eight weeks of team play, one night a week, playoffs included. If you haven't put a team in yet, now's the time — spots go by division and they don't last.</p>
    ${ctaButton(pitch.url, 'Register a Team →')}
  </div>`;
}

// Two openings for the same announcement. Someone who has played a ladder just
// needs the dates; a league player may not know these nights exist at all — the
// whole reason for widening the audience.
function renderOpen({ name, events, site, pitch, knowsLadders = true }) {
  const single = events.length === 1;
  const header = single
    ? divisionBadge(events[0].type)
    : `<span style="display:inline-block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#17d7b0;background:rgba(23,215,176,.10);border:1px solid rgba(23,215,176,.30);padding:6px 12px;border-radius:9999px;margin-bottom:14px">🪜 New ladders open</span>`;
  const intro = knowsLadders
    ? `<h1 style="font-size:26px;font-weight:800;line-height:1.15;margin:0 0 12px">Fresh ladder${single ? '' : 's'} ${single ? 'is' : 'are'} up, ${esc(firstName(name))}.</h1>
       <p style="font-size:15px;color:#cfcfcf;line-height:1.7;margin:0 0 18px">New ladder night${single ? '' : 's'} just opened for registration. ${single ? 'Lock your spot before it fills:' : 'Pick one and lock your spot:'}</p>`
    : `<h1 style="font-size:26px;font-weight:800;line-height:1.15;margin:0 0 12px">There's pickleball on the off nights too, ${esc(firstName(name))}.</h1>
       <p style="font-size:15px;color:#cfcfcf;line-height:1.7;margin:0 0 18px">Beyond league night, the Society runs <b style="color:#f5f5f5">ladder nights every week</b> — open play, round-robin, you sign up on your own and get re-paired every round. Mixed, men's, and Queen of the Court women's nights. No team required, no season commitment.</p>
       <p style="font-size:15px;color:#cfcfcf;line-height:1.7;margin:0 0 18px">${single ? 'Here\u2019s the next one:' : 'Here\u2019s what\u2019s open:'}</p>`;
  return shell(`
    ${header}
    ${intro}
    ${events.map(ev => evCard(ev, site)).join('')}
    ${single ? inviteButton(events[0], site) : ''}
    <p style="font-size:12.5px;color:#777;margin-top:6px">See everything anytime at <a href="${site}/ladders.html" style="color:#17d7b0;text-decoration:none">the ladder page</a>.</p>
    ${seasonModule(pitch)}
  `);
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  const b = await req.json().catch(() => ({}));
  const mode = b.mode === 'open' ? 'open' : 'recruit';
  const circuit = b.circuit || 'I';
  const site = siteUrl();
  const from = blastFrom();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Who hears about it. 'ladder' preserves the original behaviour (people who
  // have played); 'all' adds ladder registrants who haven't played yet AND every
  // league player, which is the point of a new-ladder announcement — most league
  // players don't know the weekly nights exist.
  const audience = ['ladder', 'league', 'all'].includes(b.audience) ? b.audience : 'ladder';

  const played = await pastParticipants(circuit);          // knows what a ladder is
  const ladderKnown = new Map(played);
  if (audience !== 'league') {
    for (const [e, n2] of await ladderRegistrants()) if (!ladderKnown.has(e)) ladderKnown.set(e, n2);
  }

  const people = new Map(audience === 'league' ? [] : ladderKnown);
  if (audience === 'league' || audience === 'all') {
    for (const [e, n2] of await leaguePlayers()) if (!people.has(e)) people.set(e, n2);
  }
  if (!people.size) return json({ ok: true, sent: 0, recipients: 0, note: 'nobody to email yet' });

  let subject, htmlFor, pitch = null, exclude = new Set();

  if (mode === 'recruit') {
    if (!b.eventId) return json({ error: 'eventId required for recruit' }, 400);
    const event = await getEvent(b.eventId);
    if (!event) return json({ error: 'Event not found' }, 404);
    // A private/invite-only ladder is normally excluded from a league-wide blast —
    // that's the exact "everyone" exposure the visibility toggle is for. Admin can
    // still choose to blast it anyway (e.g. an organizer's invite-only night the
    // admin decides to throw open) by explicitly passing confirmPrivate:true; a
    // fresh request without that flag stops here with a 409 so the UI can surface
    // a distinct, explicit confirmation rather than sending silently.
    if (event.visibility === 'private' && !b.confirmPrivate) {
      return json({
        error: 'private_confirm_required',
        privateConfirmRequired: true,
        message: 'This ladder is private (invite-only). Blasting it emails every past player in the league, not just people invited to it.',
      }, 409);
    }
    const signups = await getSignups(b.eventId);
    [...(signups.roster || []), ...(signups.waitlist || [])].forEach(p => { const e = normalizeEmail(p.email); if (e) exclude.add(e); });
    const open = spotsLeft(event, signups);
    const needed = (b.neededCount != null && +b.neededCount > 0) ? Math.floor(+b.neededCount) : (open || 1);
    subject = `${needed} spot${needed === 1 ? '' : 's'} open — ${event.name}`;
    htmlFor = (name) => renderRecruit({ name, event, needed, left: open, cap: effectiveCapacity(event), site });
  } else {
    const now = Date.now();
    const events = (await listEvents({ circuit }))
      .filter(e => e.status === 'open' && e.visibility !== 'private')
      .filter(e => { const s = eventStartMs(e); return s != null && s > now; })
      .sort((a, b2) => (eventStartMs(a) || 0) - (eventStartMs(b2) || 0));
    if (!events.length) return json({ error: 'No open upcoming ladders to announce.' }, 400);
    // attach spotsLeft for the cards
    for (const e of events) { const su = await getSignups(e.id); e.spotsLeft = spotsLeft(e, su); }
    subject = events.length === 1 ? `🪜 New ladder open: ${events[0].name}` : `🪜 ${events.length} new ladders open for registration`;
    // Only fetched for announcements, and only rendered when a season is open.
    pitch = await registrationPitch(site);
    htmlFor = (name, knowsLadders) => renderOpen({ name, events, site, pitch, knowsLadders });
  }

  let sent = 0, failed = 0, skipped = 0, newToLadders = 0;
  for (const [email, name] of people) {
    if (exclude.has(email)) continue;
    // Someone who has never signed up for a ladder gets the explainer opening.
    const knowsLadders = ladderKnown.has(email);
    if (!knowsLadders) newToLadders++;
    try {
      const r = await sendNotify({ to: email, from, replyTo: from, category: 'new_ladders', subject, html: htmlFor(name, knowsLadders) });
      if (r && r.skipped) { skipped++; } else { sent++; await sleep(120); }
    }
    catch { failed++; }
  }
  return json({
    ok: true, mode, audience, sent, failed, skipped,
    recipients: people.size - exclude.size,
    newToLadders,
    seasonPitch: pitch ? pitch.name : null,
  });
};

export const config = { path: '/.netlify/functions/admin-ladder-blast' };
