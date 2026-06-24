// netlify/functions/lib/potw-email.js
// Core logic + templates for the weekly K'CHN Player of the Week congratulation
// emails. Mirrors The Drop: a scheduled cron prepares a draft, but NOTHING is
// sent to a member until Richard taps "Approve & send" in the approval email.
//
// Data flow:
//   prepareWeeklyPotwApproval('I')
//     → fetch winners from the public-leaderboard function (weeklyTopPerformers)
//     → resolve each winner's email from the `teams` blob (captain fallback)
//     → generate fresh subject + write-up via Claude (template fallback)
//     → render the branded congrats email, stash it as a pending record,
//       mint a single-use approve token
//     → email Richard ONE approval email with a preview + Approve button each
//   sendApprovedPotw('I', week, winnerKey)  ← called by potw-approve.js on POST
//     → load the pending record, send it via Resend to the member, BCC Richard,
//       mark sent.

import { getStore } from '@netlify/blobs';
import { sendEmail } from './email.js';
import { siteUrl } from './ladder-notify.js';
import { normalizeEmail } from './identity.js';
import { createPotwToken } from './potw-token.js';
import { signSizeToken } from './potw-size-token.js';

const STATE_STORE = 'potw-emails';
function stateStore() { return getStore({ name: STATE_STORE, consistency: 'strong' }); }

const pendingKey = (code, week, winnerKey) => `pending/${code}/week-${week}/${winnerKey}.json`;
const markerKey = (code, week) => `state/${code}/week-${week}.json`;

// ── small helpers ───────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function teamSlug(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '-');
}
function profileUrl(name, teamName) {
  return `${siteUrl()}/player?name=${encodeURIComponent(name)}&team=${teamSlug(teamName)}`;
}
function adminRecipients() {
  const raw = process.env.ADMIN_NOTIFY_EMAIL
    || process.env.ADMIN_EMAILS
    || process.env.EMAIL_ADMIN_BCC
    || process.env.EMAIL_REPLY_TO
    || '';
  return raw.split(',').map(s => s.trim()).filter(e => e.includes('@'));
}
// The award emails send AS the sponsor desk so any reply lands in that shared
// inbox (not a personal Gmail). Override with POTW_FROM if the address changes.
function potwFrom() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('POTW_FROM'))
    || process.env.POTW_FROM || 'dink@dinksociety.app';
}
function sizeEndpoint() {
  return `${siteUrl()}/.netlify/functions/potw-size`;
}
function chefEmoji(gender) {
  return String(gender).toUpperCase() === 'F' ? '\u{1F469}‍\u{1F373}' : '\u{1F468}‍\u{1F373}';
}
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || 'DS';
}
function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || name;
}

// ── 1. winners from the live leaderboard ────────────────────────────────────
/**
 * Fetch the latest completed week's POTW winners from the public-leaderboard
 * function. Returns { week, label, winners: [{ winnerKey, gender, ...stats }] }
 * or null if there are no weekly performers yet.
 */
export async function fetchLatestWinners(circuit = 'I', targetWeek = null) {
  const res = await fetch(`${siteUrl()}/.netlify/functions/public-leaderboard`, {
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) throw new Error(`public-leaderboard ${res.status}`);
  const data = await res.json();
  const wk = Array.isArray(data.weeklyTopPerformers) ? data.weeklyTopPerformers : [];
  if (!wk.length) return null;
  // A specific past week if asked for, otherwise the highest week number present.
  const entry = targetWeek != null
    ? wk.find(e => Number(e.week) === Number(targetWeek))
    : wk.reduce((a, b) => (Number(b.week) > Number(a.week) ? b : a));
  if (!entry) return null;
  const winners = [];
  const take = (arr, key, gender) => {
    const w = Array.isArray(arr) ? arr[0] : null;
    if (w && w.name) winners.push({ winnerKey: key, gender, ...w });
  };
  take(entry.men, 'men', 'M');
  take(entry.women, 'women', 'F');
  if (!winners.length) return null;
  return { week: Number(entry.week), label: entry.label || `Week ${entry.week}`, winners };
}

// ── 2. recipient resolution from the teams blob (captain fallback) ───────────
/**
 * Resolve who an award email should go to. Prefers the player's own address;
 * falls back to their team captain. Reads the `teams` blob directly (player
 * emails are never exposed by the public endpoints).
 * @returns {{ to:string|null, recipientType:'player'|'captain'|'none',
 *             playerEmail:string|null, captainName:string|null, captainEmail:string|null }}
 */
export async function resolveRecipient(winner) {
  const teams = getStore('teams');
  let team = null;
  try {
    if (winner.teamId) {
      team = await teams.get(`team/${winner.teamId}.json`, { type: 'json' }).catch(() => null);
    }
    if (!team) {
      const { blobs } = await teams.list({ prefix: 'team/' });
      const all = await Promise.all(blobs.map(b => teams.get(b.key, { type: 'json' }).catch(() => null)));
      team = all.find(t => t && (t.id === winner.teamId || t.name === winner.teamName)) || null;
    }
  } catch { team = null; }

  let playerEmail = null;
  let captainEmail = null;
  let captainName = null;
  if (team) {
    captainEmail = normalizeEmail(team.captainEmail) || null;
    captainName = team.captainName || null;
    const want = String(winner.name || '').trim().toLowerCase();
    const entry = (team.roster || []).find(p => String(p.name || '').trim().toLowerCase() === want);
    if (entry) playerEmail = normalizeEmail(entry.email) || null;
    if (!captainEmail) {
      const cap = (team.roster || []).find(p => p.isCaptain);
      if (cap) { captainEmail = normalizeEmail(cap.email) || null; captainName = captainName || cap.name; }
    }
  }

  if (playerEmail) return { to: playerEmail, recipientType: 'player', playerEmail, captainName, captainEmail };
  if (captainEmail) return { to: captainEmail, recipientType: 'captain', playerEmail: null, captainName, captainEmail };
  return { to: null, recipientType: 'none', playerEmail: null, captainName, captainEmail };
}

// ── 3. copy generation (Claude, with template fallback) ─────────────────────
function highlightOf(w) {
  const bits = [];
  if (Number(w.l) === 0 && Number(w.w) > 0) bits.push(`a perfect ${w.w}-0 night`);
  if (w.diff != null) bits.push(`a league-best +${w.diff} point differential`);
  if (w.ps != null) bits.push(`${w.ps} points scored`);
  return bits.join(', ');
}

function apiKey() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('ANTHROPIC_API_KEY')) || process.env.ANTHROPIC_API_KEY || '';
}
function modelId() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('DROP_MODEL')) || process.env.DROP_MODEL || 'claude-sonnet-4-6';
}

const COPY_SYSTEM = `You write short, warm, celebratory copy for "The Dink Society", a Monday-night pickleball league, announcing the weekly "K'CHN Player of the Week" award (K'CHN is the league sponsor).
House rules, follow exactly:
- NEVER use the em dash character. Recast the sentence instead.
- Use the player's first name only. Never a bare surname.
- Be specific to the real stats given. Never invent names, scores, partners, or facts not provided.
- Tone: genuine, upbeat, a little witty, never generic, never corny.
Return ONLY minified JSON: {"subject": "...", "lead": "..."}
- subject: a fresh, punchy subject line (max ~60 chars). One emoji allowed, optional. Vary the angle week to week.
- lead: 2 to 3 sentences congratulating them, weaving in the real highlight and stats. No greeting, no signature, no HTML.`;

function buildCopyPrompt(w, week, label) {
  const brief = {
    award: 'K\'CHN Player of the Week',
    week, label,
    player: firstName(w.name),
    team: w.teamName,
    record: `${w.w}-${w.l}`,
    winRate: (Number(w.w) + Number(w.l)) > 0 ? Math.round((Number(w.w) / (Number(w.w) + Number(w.l))) * 100) + '%' : null,
    dsr: w.dsr,
    pointDiff: w.diff,
    pointsScored: w.ps,
    highlight: highlightOf(w),
  };
  return `Write the subject and lead for this winner. Data:\n${JSON.stringify(brief, null, 2)}`;
}

function templateCopy(w, week) {
  const fn = firstName(w.name);
  const perfect = Number(w.l) === 0 && Number(w.w) > 0;
  // Two angles so the men's and women's fallback subjects never collide on a
  // night where both winners share a record (the live path uses Claude, which
  // already varies the line week to week).
  const female = String(w.gender).toUpperCase() === 'F';
  const subject = perfect
    ? (female
        ? `${fn} ran the kitchen: a perfect ${w.w}-0 night \u{1F44F}`
        : `${fn}, a perfect ${w.w}-0 night. You're Player of the Week \u{1F3C6}`)
    : (female
        ? `Nice cooking, ${fn}. The week was yours \u{1F948}`
        : `${fn}, you're the K'CHN Player of the Week \u{1F44F}`);
  const winRate = (Number(w.w) + Number(w.l)) > 0 ? Math.round((Number(w.w) / (Number(w.w) + Number(w.l))) * 100) : null;
  const lead = `${fn} turned in one of the standout nights of Week ${week}, going ${w.w}-${w.l}${winRate === 100 ? ' for a flawless sheet' : ''} with a ${w.diff >= 0 ? '+' : ''}${w.diff} point differential and a league-leading DSR of ${w.dsr}. That kind of night earns the loudest honor we hand out: K'CHN Player of the Week. Congratulations.`;
  return { subject, lead };
}

/** Generate { subject, lead }. Falls back to a template if Claude is unavailable. */
export async function generateCopy(w, week, label) {
  const key = apiKey();
  if (!key) return templateCopy(w, week);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: modelId(),
        max_tokens: 600,
        system: COPY_SYSTEM,
        messages: [{ role: 'user', content: buildCopyPrompt(w, week, label) }],
      }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}`);
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : text);
    if (obj && obj.subject && obj.lead) {
      // Belt-and-suspenders: strip any em dash the model slipped in.
      obj.subject = String(obj.subject).replace(/—/g, ', ');
      obj.lead = String(obj.lead).replace(/—/g, ', ');
      return obj;
    }
    throw new Error('bad copy json');
  } catch (e) {
    console.warn('[potw] copy gen fell back to template:', e.message);
    return templateCopy(w, week);
  }
}

// ── 4. branded congrats email (Mockup A) ────────────────────────────────────
const SIZE_PILL = (s) => `<span style="display:inline-block;border:1px solid #2a2a2a;border-radius:7px;padding:7px 13px;margin:4px 5px 0 0;font-size:13px;font-weight:700;color:#f5f5f5;background:#101010">${s}</span>`;

/**
 * Render the full branded congrats email body.
 * @param {{ winner:object, week:number, subject:string, lead:string,
 *           captainIntro?:string, sizeToken?:string, currentSize?:string }} o
 *   sizeToken wires the one-tap shirt-size buttons to the public potw-size
 *   endpoint. currentSize highlights the size already on file (if any).
 */
export function renderCongratsEmail({ winner: w, week, lead, captainIntro, sizeToken, currentSize }) {
  const fn = firstName(w.name);
  const winRate = (Number(w.w) + Number(w.l)) > 0 ? Math.round((Number(w.w) / (Number(w.w) + Number(w.l))) * 100) + '%' : '—';
  const url = profileUrl(w.name, w.teamName);
  const statCell = (num, lab) => `<td style="background:#161616;border:1px solid #2a2a2a;border-radius:10px;padding:14px 10px;text-align:center;width:25%"><div style="font-size:24px;font-weight:800;color:#b8ff2c;line-height:1">${esc(num)}</div><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#8a8a8a;margin-top:7px">${esc(lab)}</div></td>`;
  const capLine = captainIntro
    ? `<p style="font-size:14px;color:#b8ff2c;line-height:1.6;margin:0 0 22px;padding:12px 14px;background:#161616;border-left:3px solid #b8ff2c;border-radius:6px">${esc(captainIntro)}</p>`
    : '';
  // One-tap size buttons (each is a GET link to the public size endpoint). The
  // endpoint is idempotent, so tapping a different size simply updates the pick.
  const base = sizeEndpoint();
  const sizeBtn = (s) => {
    if (!sizeToken) return SIZE_PILL(s);
    const on = String(currentSize || '') === s;
    return `<a href="${base}?t=${encodeURIComponent(sizeToken)}&amp;size=${encodeURIComponent(s)}" style="display:inline-block;border:1px solid ${on ? '#b8ff2c' : '#2a2a2a'};border-radius:8px;padding:11px 17px;margin:5px 6px 0 0;font-size:14px;font-weight:800;color:${on ? '#0e0e0e' : '#f5f5f5'};background:${on ? '#b8ff2c' : '#101010'};text-decoration:none">${s}</a>`;
  };
  const sizeButtons = ['XS', 'S', 'M', 'L', 'XL', '2XL'].map(sizeBtn).join('');
  const sizeBlurb = sizeToken
    ? (currentSize
        ? `Got it, your size is <b style="color:#fff">${esc(currentSize)}</b>. Tap a different size below if you need to change it.`
        : `Your Player of the Week shirt is sponsored by <b style="color:#fff">K'CHN</b>. Tap your size below and we'll have it ready to present to you on game day.`)
    : `Your Player of the Week shirt is sponsored by <b style="color:#fff">K'CHN</b>. Reply with your size and we'll have it ready to present to you on game day.`;
  return `<div style="background:#0e0e0e;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f5f5f5;max-width:600px;margin:0 auto;padding:40px 26px">
  ${capLine}
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:30px">
    <span style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#f5f5f5">THE DINK SOCIETY</span>
    <span style="font-size:11px;color:#8a8a8a;font-weight:600">PRESENTED BY <b style="color:#b8ff2c;font-weight:800;letter-spacing:.04em">K'CHN</b></span>
  </div>
  <span style="display:inline-block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#b8ff2c;background:rgba(184,255,44,.10);border:1px solid rgba(184,255,44,.30);padding:7px 12px;border-radius:9999px;margin-bottom:18px">${chefEmoji(w.gender)} K'CHN Player of the Week &middot; Week ${esc(week)}</span>
  <div style="width:64px;height:64px;border-radius:9999px;background:linear-gradient(135deg,#243b00,#0e0e0e);border:2px solid #b8ff2c;text-align:center;line-height:64px;font-size:22px;font-weight:800;color:#b8ff2c;margin:0 0 22px">${esc(initials(w.name))}</div>
  <h1 style="font-size:30px;font-weight:800;line-height:1.12;margin:0 0 8px;color:#f5f5f5;letter-spacing:-.01em">Nice cooking,<br><span style="font-style:italic;text-transform:uppercase">${esc(fn)}.</span></h1>
  <p style="font-size:14px;color:#8a8a8a;margin:0 0 24px">${esc(w.teamName)}</p>
  <p style="font-size:15px;color:#cfcfcf;line-height:1.7;margin:0 0 14px">${esc(lead)}</p>
  <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:8px;margin:18px 0 8px"><tr>
    ${statCell(`${w.w}-${w.l}`, 'Record')}
    ${statCell(winRate, 'Win rate')}
    ${statCell(w.dsr, 'DSR')}
    ${statCell(`${Number(w.diff) >= 0 ? '+' : ''}${w.diff}`, 'Pt diff')}
  </tr></table>
  <a href="${esc(url)}" style="display:inline-block;padding:14px 32px;background:#b8ff2c;color:#0e0e0e;font-size:14px;font-weight:800;text-decoration:none;border-radius:9999px;margin:14px 0 4px">View your player profile &rarr;</a>
  <div style="background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:18px;margin:26px 0 10px">
    <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#b8ff2c;margin-bottom:8px"><span style="color:#fff">\u{1F455}</span> Claim your K'CHN jersey</div>
    <p style="font-size:14px;color:#cfcfcf;line-height:1.6;margin:0">${sizeBlurb}</p>
    <div style="margin-top:12px">${sizeButtons}</div>
  </div>
  <p style="font-size:13px;color:#8a8a8a;line-height:1.6;margin:20px 0 0">\u{1F4F8} We'll present your award courtside before next game day and grab a quick photo for the league feed. Wear the grin. You earned it.</p>
  <div style="margin-top:34px;padding-top:18px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;line-height:1.6"><b style="color:#8a8a8a;font-weight:700">THE DINK SOCIETY</b> &middot; Season 1 &middot; Player of the Week presented by K'CHN</div>
</div>`;
}

// ── 5. approval email to Richard ────────────────────────────────────────────
/** Render the internal approval email: one card per winner with a preview + Approve button. */
function renderApprovalEmail({ week, items }) {
  const cards = items.map((it) => {
    const w = it.winner;
    const recipientLine = it.recipientType === 'player'
      ? `Will send to <b style="color:#f5f5f5">${esc(it.to)}</b> (the player)`
      : it.recipientType === 'captain'
        ? `No player email on file. Will send to captain <b style="color:#f5f5f5">${esc(it.captainName || 'captain')}</b> at <b style="color:#f5f5f5">${esc(it.to)}</b> to relay.`
        : `<b style="color:#ff5c47">No email on file for the player or captain.</b> Look up an address and send manually.`;
    const button = it.approveUrl
      ? `<a href="${esc(it.approveUrl)}" style="display:inline-block;padding:13px 26px;background:#b8ff2c;color:#0e0e0e;font-size:14px;font-weight:800;text-decoration:none;border-radius:9999px;margin:4px 0 2px">Approve &amp; send to ${esc(firstName(w.name))} &rarr;</a>`
      : `<span style="display:inline-block;padding:13px 26px;background:#222;color:#888;font-size:13px;font-weight:700;border-radius:9999px">No address &mdash; handle manually</span>`.replace('—', '-');
    return `<div style="background:#0e0e0e;border:1px solid #2a2a2a;border-radius:12px;padding:18px;margin:0 0 16px">
      <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#b8ff2c;margin-bottom:6px">${chefEmoji(w.gender)} ${it.winnerKey === 'women' ? "Women's" : "Men's"} winner</div>
      <div style="font-size:18px;font-weight:800;color:#f5f5f5">${esc(w.name)} <span style="font-size:13px;font-weight:600;color:#8a8a8a">&middot; ${esc(w.teamName)}</span></div>
      <div style="font-size:13px;color:#cfcfcf;margin:6px 0 10px">${esc(w.w)}-${esc(w.l)} &middot; DSR ${esc(w.dsr)} &middot; ${Number(w.diff) >= 0 ? '+' : ''}${esc(w.diff)} diff</div>
      <div style="font-size:13px;color:#9a9e97;margin:0 0 8px;line-height:1.5">Subject: <span style="color:#cfcfcf">${esc(it.subject)}</span></div>
      <div style="font-size:13px;color:#9a9e97;margin:0 0 14px;line-height:1.5">${recipientLine}</div>
      ${button}
    </div>`;
  }).join('');
  return `<div style="background:#0e0e0e;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f5f5f5;max-width:600px;margin:0 auto;padding:36px 24px">
    <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#f5f5f5;margin-bottom:8px">THE DINK SOCIETY &middot; ADMIN</div>
    <h1 style="font-size:22px;font-weight:800;color:#f5f5f5;margin:0 0 6px">Week ${esc(week)} Player of the Week &mdash; ready to send</h1>
    <p style="font-size:14px;color:#9a9e97;line-height:1.6;margin:0 0 20px">Review each winner below. Tap "Approve &amp; send" and the branded congrats email goes out from the league to that person (you'll be BCC'd). Nothing sends until you tap.</p>
    ${cards}
    <p style="font-size:12px;color:#666;line-height:1.6;margin:18px 0 0">Each button opens a quick confirm page before anything is sent, so a link preview can't fire it by accident. Links expire in 14 days.</p>
  </div>`.replace(/—/g, '–');
}

// ── 6. orchestration ────────────────────────────────────────────────────────
/**
 * Prepare the week's award emails and send Richard the approval email.
 * Idempotent: if the latest week was already prepared, it no-ops.
 * @returns {Promise<{ok:boolean, reason?:string, week?:number, count?:number}>}
 */
export async function prepareWeeklyPotwApproval(circuit = 'I', { force = false, notify = true, week = null } = {}) {
  const code = String(circuit);
  const found = await fetchLatestWinners(code, week);
  if (!found) return { ok: false, reason: week != null ? 'no-winners-for-week' : 'no-winners', week: week != null ? Number(week) : undefined };
  const { week, label, winners } = found;

  const marker = await stateStore().get(markerKey(code, week), { type: 'json' }).catch(() => null);
  if (marker && !force) return { ok: false, reason: 'already-prepared', week };

  const items = [];
  for (const w of winners) {
    // Preserve anything already captured for this winner (a submitted shirt size,
    // a prior send) so a re-draft never wipes it.
    const prev = await loadPending(code, week, w.winnerKey);
    const rcpt = await resolveRecipient(w);
    const { subject, lead } = await generateCopy(w, week, label);
    const captainIntro = rcpt.recipientType === 'captain'
      ? `Hi ${firstName(rcpt.captainName || 'captain')}, ${firstName(w.name)} is this week's K'CHN Player of the Week. Could you pass this along and grab their shirt size?`
      : '';
    const sizeToken = signSizeToken({ circuit: code, week, winnerKey: w.winnerKey });
    const html = renderCongratsEmail({
      winner: w, week, lead, captainIntro, sizeToken, currentSize: prev?.size?.value || null,
    });

    // Approve-by-email tokens are only minted when we actually notify (the admin
    // panel is the primary send surface now and needs no token).
    let approveUrl = null;
    let token = prev?.token || null;
    if (notify && rcpt.to) {
      token = await createPotwToken({ circuit: code, week, winnerKey: w.winnerKey });
      approveUrl = `${siteUrl()}/.netlify/functions/potw-approve?t=${token}`;
    }

    const alreadySent = prev?.status === 'sent';
    const record = {
      circuit: code, week, winnerKey: w.winnerKey,
      winner: w,
      to: rcpt.to, recipientType: rcpt.recipientType,
      captainName: rcpt.captainName, captainEmail: rcpt.captainEmail,
      subject, html,
      status: alreadySent ? 'sent' : (rcpt.to ? 'pending' : 'no-recipient'),
      size: prev?.size || null,
      token,
      createdAt: prev?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sentAt: prev?.sentAt || null,
    };
    await stateStore().setJSON(pendingKey(code, week, w.winnerKey), record);
    items.push({ ...record, approveUrl });
  }

  if (notify) {
    const to = adminRecipients();
    if (to.length) {
      await sendEmail({
        to,
        subject: `\u{1F3C6} Approve Week ${week} Player of the Week emails (${items.length})`,
        html: renderApprovalEmail({ week, items }),
      }).catch(e => console.error('[potw] approval email failed:', e.message));
    } else {
      console.warn('[potw] no admin recipient configured (ADMIN_NOTIFY_EMAIL/ADMIN_EMAILS)');
    }
  }

  await stateStore().setJSON(markerKey(code, week), {
    week, preparedAt: new Date().toISOString(), winners: items.map(i => i.winnerKey),
  });
  return { ok: true, week, count: items.length };
}

/** Load a pending record (for the approve endpoint). */
export async function loadPending(circuit, week, winnerKey) {
  return stateStore().get(pendingKey(String(circuit), Number(week), winnerKey), { type: 'json' }).catch(() => null);
}

/**
 * Send the approved congrats email to the member. Called by potw-approve.js POST
 * AFTER the token has been consumed.
 * @returns {{ok:boolean, reason?:string, to?:string, name?:string}}
 */
export async function sendApprovedPotw(circuit, week, winnerKey, who = null) {
  const rec = await loadPending(circuit, week, winnerKey);
  if (!rec) return { ok: false, reason: 'not-found' };
  if (rec.status === 'sent') return { ok: false, reason: 'already-sent', to: rec.to, name: rec.winner?.name };
  if (!rec.to) return { ok: false, reason: 'no-recipient', name: rec.winner?.name };

  // Send AS the sponsor desk, with replies routed to that same shared inbox.
  await sendEmail({ to: rec.to, from: potwFrom(), replyTo: potwFrom(), subject: rec.subject, html: rec.html });
  await stateStore().setJSON(pendingKey(String(circuit), Number(week), winnerKey), {
    ...rec, status: 'sent', sentAt: new Date().toISOString(), sentBy: who || rec.sentBy || null,
  });
  return { ok: true, to: rec.to, name: rec.winner?.name };
}

/** Record a shirt-size submission against a pending record. Idempotent. */
export async function recordPotwSize(circuit, week, winnerKey, size) {
  const rec = await loadPending(circuit, week, winnerKey);
  if (!rec) return null;
  const updated = { ...rec, size: { value: size, at: new Date().toISOString() }, updatedAt: new Date().toISOString() };
  await stateStore().setJSON(pendingKey(String(circuit), Number(week), winnerKey), updated);
  return updated;
}

/** All winner records for one prepared week (men first, then women). */
export async function listPendingForWeek(circuit, week) {
  const code = String(circuit);
  const s = stateStore();
  const { blobs } = await s.list({ prefix: `pending/${code}/week-${Number(week)}/` }).catch(() => ({ blobs: [] }));
  const recs = (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' }).catch(() => null)))).filter(Boolean);
  recs.sort((a, b) => (a.winnerKey === 'men' ? 0 : 1) - (b.winnerKey === 'men' ? 0 : 1));
  return recs;
}

/** Every prepared week for a circuit, newest first (from the markers). */
export async function listPreparedWeeks(circuit) {
  const code = String(circuit);
  const s = stateStore();
  const { blobs } = await s.list({ prefix: `state/${code}/` }).catch(() => ({ blobs: [] }));
  const marks = (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' }).catch(() => null)))).filter(Boolean);
  marks.sort((a, b) => (b.week || 0) - (a.week || 0));
  return marks;
}

// ── settings (auto-send toggle) ─────────────────────────────────────────────
const settingsKey = () => 'config/settings.json';

/** Read the POTW feature settings. Defaults to auto-send OFF. */
export async function getPotwSettings() {
  const s = await stateStore().get(settingsKey(), { type: 'json' }).catch(() => null);
  return { autoSend: false, ...(s || {}) };
}

/** Flip the Wednesday auto-send on/off. */
export async function setPotwAutoSend(enabled) {
  const cur = await getPotwSettings();
  const next = { ...cur, autoSend: !!enabled, updatedAt: new Date().toISOString() };
  await stateStore().setJSON(settingsKey(), next);
  return next;
}

/**
 * Send every not-yet-sent winner with a recipient for a week. Used by the
 * Wednesday cron when auto-send is on, and by the panel "Send all" button.
 */
export async function sendAllPending(circuit, week, who = null) {
  const recs = await listPendingForWeek(circuit, week);
  let sent = 0, skipped = 0, failed = 0;
  const errors = [];
  for (const r of recs) {
    if (r.status === 'sent' || !r.to) { skipped++; continue; }
    try {
      const out = await sendApprovedPotw(circuit, week, r.winnerKey, who);
      if (out.ok) sent++; else skipped++;
    } catch (e) { failed++; errors.push(e.message || String(e)); }
  }
  return { week, sent, skipped, failed, errors };
}

// Exposed for tests.
export const _internal = { templateCopy, highlightOf, teamSlug, profileUrl, firstName };
