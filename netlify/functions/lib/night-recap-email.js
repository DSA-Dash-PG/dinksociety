// netlify/functions/lib/night-recap-email.js
//
// Renders the league "morning-after" email (the Receipt) for ONE player from the
// model lib/night-recap-data.js builds. Pure: no I/O, so it renders in tests and
// in the admin preview exactly as it sends.
//
//   ① Your Night   record, rank movement, every game, "the receipt says"
//   ② Next Up      next week's match with one-tap I'm in / I'm out
//   ③ Your Team    the match, round by round, and everyone who played
//   ④ The Table    standings with movement, the playoff line, weekly honors
//
// Inline styles and tables only (email clients strip <style>, Outlook has no
// flexbox). Same palette and header as lib/ladder-recap-email.js so the two
// recaps read as one family.

import { ord, sign } from './night-recap-data.js';
import { seasonName, seasonIdForCircuit } from './circuit.js';

const C = {
  bg: '#0e0e0e', surf: '#161616', surf2: '#1e1e1e', bd: '#262626', bd2: '#33373c',
  tx: '#f0f0ec', body: '#dcdfd7', mut: '#9a9e97', lbl: '#8a8f88', inv: '#0e0e0e',
  lime: '#b8ff2c', teal: '#17d7b0', gold: '#f0c040', red: '#ff5c47',
};
const TZ = 'America/Los_Angeles';
const UTM = 'utm_source=night-recap';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'x';
const diffColor = n => (n > 0 ? C.lime : n < 0 ? C.red : C.tx);
const fmt = (iso, opts) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('en-US', { timeZone: TZ, ...opts });
};

const label = (text, color = C.lbl) =>
  `<div style="font-size:10.5px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:${color}">${text}</div>`;
const rule = () => `<tr><td style="padding:0 24px"><div style="height:1px;background:${C.bd};margin:24px 0 0;font-size:0;line-height:0">&nbsp;</div></td></tr>`;

function tiles(cells, { size = 20, mt = 14 } = {}) {
  const w = (100 / cells.length).toFixed(2);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:${mt}px 0 0"><tr>${cells.map((c, i) =>
    `<td width="${w}%" style="padding:0 ${i === cells.length - 1 ? 0 : 4}px 0 ${i ? 4 : 0}px" valign="top"><div style="background:${C.surf2};border:1px solid ${C.bd};border-radius:11px;padding:12px 6px;text-align:center">
      <div style="font-size:${size}px;font-weight:900;font-style:italic;color:${c.color || C.tx}">${c.v}</div>
      <div style="font-size:9.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.lbl};margin-top:4px">${c.k}</div></div></td>`).join('')}</tr></table>`;
}

function minis(cells, { mt = 10 } = {}) {
  const w = (100 / cells.length).toFixed(2);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:${mt}px 0 0"><tr>${cells.map((c, i) =>
    `<td width="${w}%" style="padding:0 ${i === cells.length - 1 ? 0 : 4}px 0 ${i ? 4 : 0}px" valign="top"><div style="background:${C.surf2};border:1px solid ${C.bd};border-radius:11px;padding:12px 13px">
      <div style="font-size:9.5px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:${c.labelColor || C.lbl}">${c.k}</div>
      <div style="font-size:15px;font-weight:800;color:${C.tx};margin-top:5px">${c.v}</div>
      ${c.s ? `<div style="font-size:11.5px;color:${C.mut};margin-top:3px;line-height:1.4">${c.s}</div>` : ''}</div></td>`).join('')}</tr></table>`;
}

const pill = (href, text, primary) => primary
  ? `<a href="${esc(href)}" style="display:block;text-align:center;background:${C.lime};color:${C.inv};font-weight:900;font-size:14px;padding:15px;border-radius:9999px;text-decoration:none">${text}</a>`
  : `<a href="${esc(href)}" style="display:block;text-align:center;color:${C.tx};font-weight:800;font-size:12.5px;padding:12px;border:1px solid ${C.bd2};border-radius:9999px;text-decoration:none">${text}</a>`;

function arrow(delta, size = 12) {
  if (delta == null) return `<span style="color:${C.lbl}">&ndash;</span>`;
  if (delta > 0) return `<span style="color:${C.lime};font-weight:800;font-size:${size}px">&#9650; ${delta}</span>`;
  if (delta < 0) return `<span style="color:${C.red};font-weight:800;font-size:${size}px">&#9660; ${-delta}</span>`;
  return `<span style="color:${C.lbl}">&ndash;</span>`;
}

// ── ① Your Night ───────────────────────────────────────────────────────────
function badge(m) {
  const h = m.honors || {};
  const chip = (text, bg) => `<div style="margin:0 0 14px"><span style="display:inline-block;font-size:10.5px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:${C.inv};background:${bg};padding:7px 14px;border-radius:9999px">${text}</span></div>`;
  if (h.potw) return chip(`SuprDupr Player of the Week &middot; ${esc(h.genderLabel)}`, C.gold);
  if (h.weekRank) return chip(`Top 5 ${esc(h.genderLabel)} &middot; Week ${m.week} &middot; #${h.weekRank}`, C.teal);
  if (h.bestMixed) return chip(`Best mixed night &middot; Week ${m.week}`, C.teal);
  return '';
}

function yourNight(m, links) {
  const n = m.night, s = m.season, rl = m.rankLine;
  const move = rl.dir > 0 ? `<span style="color:${C.lime}">&#9650; ${rl.delta}</span> &middot; `
    : rl.dir < 0 ? `<span style="color:${C.red}">&#9660; ${rl.delta}</span> &middot; ` : '';
  const recColor = n.l === 0 ? C.lime : C.tx;
  const where = [n.oppName ? `vs ${esc(n.oppName)}` : '', esc(n.courts || ''), esc(n.venue || '')].filter(Boolean).join(' &middot; ');

  // Third + fourth tiles: rank and best board when ranked; progress when not.
  const board = s.mixedRank != null && (s.genderRank == null || s.mixedRank <= s.genderRank)
    ? { v: `#${s.mixedRank}`, k: 'Mixed board', color: C.lime }
    : s.genderRank != null ? { v: `#${s.genderRank}`, k: `${esc(s.genderLabel)} board`, color: C.lime } : null;
  const t = [
    { v: `${n.w}&ndash;${n.l}`, k: 'Record' },
    { v: sign(n.diff), k: 'Point diff', color: diffColor(n.diff) },
  ];
  if (s.rank != null) {
    t.push({ v: ord(s.rank), k: 'Overall', color: C.gold });
    t.push(board || { v: s.dsr != null ? s.dsr.toFixed(1) : '&ndash;', k: 'DSR', color: C.lime });
  } else {
    t.push({ v: `${s.w}&ndash;${s.l}`, k: 'Season' });
    t.push({ v: `${s.games} / ${s.needGames}`, k: 'To rank', color: C.gold });
  }

  const rows = n.games.map((g, i) => {
    const chip = g.won
      ? `<span style="display:inline-block;width:24px;height:24px;border-radius:6px;background:${C.lime};color:${C.inv};font-size:12px;font-weight:900;text-align:center;line-height:24px">W</span>`
      : `<span style="display:inline-block;width:22px;height:22px;border-radius:6px;border:1px solid ${C.red};color:${C.red};font-size:12px;font-weight:900;text-align:center;line-height:22px">L</span>`;
    return `<tr>
      <td width="36" valign="middle" style="padding:12px 0;border-top:${i ? `1px dashed ${C.bd2}` : '0'}">${chip}</td>
      <td valign="middle" style="padding:12px 8px 12px 0;border-top:${i ? `1px dashed ${C.bd2}` : '0'}">
        <div style="font-size:13.5px;font-weight:800;color:${C.tx}">${esc(g.typeLabel)}${g.partnerName ? ` &middot; with ${esc(g.partnerName)}` : ''}</div>
        <div style="font-size:12px;color:${C.mut};margin-top:2px">vs ${esc(g.oppNames.join(' & '))}</div></td>
      <td align="right" valign="middle" style="padding:12px 0;border-top:${i ? `1px dashed ${C.bd2}` : '0'};font-size:18px;font-weight:900;font-style:italic;color:${g.won ? C.lime : C.tx};white-space:nowrap">${g.my}&ndash;${g.opp}</td>
    </tr>`;
  }).join('');
  const receipt = `<div style="margin-top:16px;border:1px solid ${C.bd};border-radius:12px;background:${C.surf};padding:4px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
      <tr><td colspan="2" style="padding:12px 0;border-top:1px dashed ${C.bd2};font-size:10.5px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:${C.lbl}">Points on the night</td>
      <td align="right" style="padding:12px 0;border-top:1px dashed ${C.bd2};font-size:13px;font-weight:800;color:${C.tx};white-space:nowrap">${n.ps}&ndash;${n.pa} <span style="color:${diffColor(n.diff)}">(${sign(n.diff)})</span></td></tr>
    </table></div>`;

  const read = m.read ? `<div style="background:rgba(184,255,44,.1);border:1px solid rgba(184,255,44,.28);border-radius:10px;padding:14px 16px;margin-top:14px">
    <div style="font-size:9.5px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:${C.lime};margin-bottom:5px">The receipt says</div>
    <div style="font-size:13.5px;line-height:1.55;color:#eef3e4">${esc(m.read)}</div></div>` : '';

  const mini = [];
  mini.push({ k: 'Season', v: `${s.w}&ndash;${s.l}${s.diff != null ? ` &middot; ${sign(s.diff)}` : ''}`, s: s.winPct != null ? `${s.winPct}% win rate` : '' });
  if (s.dsr != null) {
    const d = s.dsrPrev != null ? Math.round((s.dsr - s.dsrPrev) * 10) / 10 : null;
    const chg = d == null || d === 0 ? '' : d > 0
      ? ` <span style="color:${C.lime};font-size:12px">&#9650; ${d.toFixed(1)}</span>`
      : ` <span style="color:${C.red};font-size:12px">&#9660; ${Math.abs(d).toFixed(1)}</span>`;
    mini.push({ k: 'DSR', v: `${s.dsr.toFixed(1)}${chg}`, s: s.dsrPrev != null ? `was ${s.dsrPrev.toFixed(1)} last week` : 'your first rating' });
  }
  if (m.partner) mini.push({ k: 'Best partner', v: esc(m.partner.name), s: `${m.partner.w}&ndash;${m.partner.l} together` });
  else if (m.clutch) mini.push({ k: 'Close games', v: `${m.clutch.w}&ndash;${m.clutch.l}`, s: 'decided by 3 or fewer' });

  return `<tr><td style="padding:22px 24px 0">
    ${label('&#9312; Your Night')}
    <div style="margin-top:12px">${badge(m)}</div>
    <div style="font-size:13px;color:${C.mut};font-weight:700">${esc(m.hi)}</div>
    <div style="margin-top:6px"><span style="font-size:54px;font-weight:900;font-style:italic;line-height:1;color:${recColor}">${n.w}&ndash;${n.l}</span>
      <span style="font-size:15px;font-weight:700;color:${C.mut};padding-left:8px">${move}${esc(rl.text)}</span></div>
    ${where ? `<div style="font-size:13px;color:${C.mut};font-weight:600;margin-top:6px">${where}</div>` : ''}
    ${tiles(t)}
    ${receipt}
    ${read}
    ${minis(mini)}
    <div style="margin-top:16px">${pill(links.profile, 'See every game on your profile &rarr;', true)}</div>
  </td></tr>`;
}

// ── ② Next Up ──────────────────────────────────────────────────────────────
function nextUp(m, x, links) {
  const nx = m.next;
  if (!nx) return '';
  if (nx.bye) {
    return `<tr><td style="padding:22px 24px 0">
      ${label('&#9313; Next Up')}
      <div style="background:${C.surf};border:1px solid ${C.bd};border-radius:14px;padding:18px 20px;margin-top:14px">
        <div style="font-size:18px;font-weight:900;font-style:italic;text-transform:uppercase;color:${C.tx}">Week ${nx.week}: bye week</div>
        <div style="font-size:13px;color:${C.mut};margin-top:6px;line-height:1.5">No match for ${esc(m.teamName)} in Week ${nx.week}.</div>
      </div></td></tr>`;
  }
  const when = [
    fmt(nx.scheduledAt, { weekday: 'long', month: 'short', day: 'numeric' }),
    fmt(nx.scheduledAt, { hour: 'numeric', minute: '2-digit' }),
    nx.courts, nx.venue,
  ].filter(Boolean).map(esc).join(' &middot; ');
  const oppBits = [];
  if (nx.oppRank != null && nx.oppPts != null) {
    oppBits.push(`${esc(nx.oppName)}: ${ord(nx.oppRank)}, ${nx.oppPts}&ndash;${nx.oppPtsAgainst} in match points, ${nx.oppGw}&ndash;${nx.oppGl} in games.`);
  }
  if (!nx.phase) {
    const last = nx.meetings[nx.meetings.length - 1];
    oppBits.push(last
      ? `Last meeting, Week ${last.week}: ${esc(m.teamName)} ${last.for}, ${esc(nx.oppName)} ${last.against}.`
      : 'First meeting this season.');
  }

  let action;
  if (x.availability === 'in' || x.availability === 'out') {
    const isIn = x.availability === 'in';
    const flip = isIn ? x.outUrl : x.inUrl;
    action = `<div style="margin-top:16px;background:${C.surf2};border:1px solid ${C.bd};border-radius:11px;padding:13px 15px;font-size:13.5px;color:${C.body};line-height:1.5">
      You're marked <b style="color:${isIn ? C.lime : C.red}">${isIn ? 'IN' : 'OUT'}</b> for Week ${nx.week}.
      ${flip ? `<a href="${esc(flip)}" style="color:${C.lime};font-weight:800;text-decoration:none;white-space:nowrap">${isIn ? "Can't make it after all" : 'I can play after all'} &rarr;</a>` : ''}</div>`;
  } else if (x.inUrl && x.outUrl) {
    action = `<div style="font-size:13px;color:${C.body};font-weight:700;margin-top:16px">Are you in? One tap tells your captain.</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0 0"><tr>
        <td width="50%" style="padding:0 4px 0 0"><a href="${esc(x.inUrl)}" style="display:block;text-align:center;background:${C.lime};color:${C.inv};font-weight:900;font-size:14px;padding:15px 8px;border-radius:9999px;text-decoration:none">I'm in for Week ${nx.week}</a></td>
        <td width="50%" style="padding:0 0 0 4px"><a href="${esc(x.outUrl)}" style="display:block;text-align:center;color:${C.tx};font-weight:800;font-size:14px;padding:14px 8px;border:1px solid #5e625c;border-radius:9999px;text-decoration:none">I'm out</a></td>
      </tr></table>`;
  } else {
    action = `<div style="margin-top:14px"><a href="${esc(links.portal)}" style="color:${C.lime};font-weight:800;font-size:12.5px;text-decoration:none">Set your availability in the player portal &rarr;</a></div>`;
  }

  return `<tr><td style="padding:22px 24px 0">
    ${label('&#9313; Next Up')}
    <div style="background:#12160d;border:1px solid rgba(184,255,44,.28);border-radius:14px;padding:20px;margin-top:14px">
      <div style="font-size:10.5px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:${C.lime}">Week ${nx.week}</div>
      <div style="font-size:22px;font-weight:900;font-style:italic;text-transform:uppercase;line-height:1.1;margin-top:8px;color:${C.tx}">${esc(m.teamName)} <span style="color:${C.lbl}">vs</span> ${esc(nx.oppName)}</div>
      ${when ? `<div style="font-size:13px;color:${C.body};margin-top:8px;line-height:1.55">${when}</div>` : ''}
      ${oppBits.length ? `<div style="font-size:13px;color:${C.mut};margin-top:4px;line-height:1.55">${oppBits.join(' ')}</div>` : ''}
      ${action}
      <div style="text-align:center;margin-top:12px"><a href="${esc(links.matchup)}" style="color:${C.lime};font-weight:800;font-size:12.5px;text-decoration:none">Scout the matchup, team vs team &rarr;</a></div>
    </div></td></tr>`;
}

// ── ③ Your Team ────────────────────────────────────────────────────────────
function yourTeam(m, n) {
  const t = m.team;
  const win = t.mp > t.oppMp, loss = t.mp < t.oppMp;
  const num = (v, on) => `<span style="color:${on ? C.lime : C.mut}">${v}</span>`;
  const roundTile = (r) => ({ v: `${r.for}&ndash;${r.against}`, color: r.for > r.against ? C.lime : r.for === r.against ? C.teal : C.tx });
  const rows = t.roster.map(p => `<tr>
    <td style="padding:11px 16px;border-top:1px solid ${C.bd};font-size:13.5px;font-weight:${p.you ? 800 : 700};color:${C.tx};${p.you ? 'background:rgba(184,255,44,.08);' : ''}">${esc(p.name)}${p.you ? ` <span style="font-size:10px;font-weight:900;letter-spacing:.08em;color:${C.lime};padding-left:4px">YOU</span>` : ''}</td>
    <td width="60" align="right" style="padding:11px 0;border-top:1px solid ${C.bd};font-size:13.5px;font-weight:800;color:${C.tx};${p.you ? 'background:rgba(184,255,44,.08);' : ''}">${p.w}&ndash;${p.l}</td>
    <td width="70" align="right" style="padding:11px 16px 11px 0;border-top:1px solid ${C.bd};font-size:13.5px;font-weight:800;color:${diffColor(p.diff)};${p.you ? 'background:rgba(184,255,44,.08);' : ''}">${sign(p.diff)}</td>
  </tr>`).join('');
  const th = `font-size:9.5px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:${C.lbl};background:${C.surf}`;
  const s = t.season;
  return `<tr><td style="padding:22px 24px 0">
    ${label(`${n} Your Team`)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;background:${C.surf};border:1px solid ${C.bd};border-radius:12px"><tr>
      <td width="38%" style="padding:16px 0 16px 18px;font-size:15px;font-weight:900;font-style:italic;text-transform:uppercase;line-height:1.15;color:${C.tx}">${esc(t.name)}</td>
      <td width="24%" align="center" style="padding:16px 4px;font-size:30px;font-weight:900;font-style:italic;white-space:nowrap">${num(t.mp, win)} <span style="color:#5e625c">&ndash;</span> ${num(t.oppMp, loss)}</td>
      <td width="38%" align="right" style="padding:16px 18px 16px 0;font-size:15px;font-weight:900;font-style:italic;text-transform:uppercase;line-height:1.15;color:${C.tx}">${esc(t.oppName)}</td>
    </tr></table>
    ${tiles([
      { ...roundTile(t.r1), k: 'Round 1 games' },
      { ...roundTile(t.r2), k: 'Round 2 games' },
      { v: `${t.points.for}&ndash;${t.points.against}`, k: 'Total points' },
    ], { size: 17, mt: 8 })}
    ${t.read ? `<div style="font-size:13.5px;line-height:1.6;color:${C.body};margin-top:14px">${esc(t.read)}</div>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border:1px solid ${C.bd};border-radius:12px;border-collapse:separate;overflow:hidden">
      <tr><td style="padding:9px 16px;${th}">${esc(t.name)} on the night</td><td width="60" align="right" style="padding:9px 0;${th}">W&ndash;L</td><td width="70" align="right" style="padding:9px 16px 9px 0;${th}">Diff</td></tr>
      ${rows}
    </table>
    ${s ? `<div style="font-size:12px;color:${C.mut};margin-top:10px;line-height:1.5">${esc(t.name)} on the season: ${s.pts}&ndash;${s.ptsAgainst} in match points, ${s.gw}&ndash;${s.gl} in games, ${sign(s.diff)} in point differential.</div>` : ''}
  </td></tr>`;
}

// ── ④ The Table ────────────────────────────────────────────────────────────
function theTable(m, n, links) {
  const th = `font-size:9.5px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:${C.lbl};background:${C.surf}`;
  let rows = '';
  for (const r of m.table) {
    const bg = r.you ? 'background:rgba(184,255,44,.08);' : '';
    const cell = `border-top:1px solid ${C.bd};font-size:13.5px;${bg}`;
    rows += `<tr>
      <td width="30" style="padding:11px 0 11px 16px;${cell}font-weight:900;color:${C.tx}">${r.rank}</td>
      <td width="42" style="padding:11px 0;${cell}">${arrow(r.delta)}</td>
      <td style="padding:11px 0;${cell}font-weight:${r.you ? 800 : 700};color:${C.tx}">${esc(r.teamName)}</td>
      <td width="40" align="right" style="padding:11px 0;${cell}font-weight:900;color:${C.tx}">${r.pts}</td>
      <td width="62" align="right" style="padding:11px 0;${cell}color:${C.mut}">${r.gw}&ndash;${r.gl}</td>
      <td width="60" align="right" style="padding:11px 16px 11px 0;${cell}font-weight:800;color:${diffColor(r.diff)}">${sign(r.diff)}</td>
    </tr>`;
    if (m.playoffSpots && r.rank === m.playoffSpots) {
      rows += `<tr><td colspan="6" style="padding:6px 16px;border-top:1px dashed ${C.teal};font-size:9.5px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:${C.teal};background:#101413">Playoff line &middot; top ${m.playoffSpots}</td></tr>`;
    }
  }
  const honor = (title, w) => w ? { k: title, labelColor: C.gold, v: esc(w.name), s: `${esc(w.teamName || '')} &middot; ${w.w}&ndash;${w.l} &middot; ${sign(w.diff)}` } : null;
  const honors = [honor('SuprDupr Player of the Week &middot; Men', m.potw?.men), honor('SuprDupr Player of the Week &middot; Women', m.potw?.women)].filter(Boolean);
  const mx = [m.mixed?.men, m.mixed?.women].filter(Boolean)
    .map(w => `${esc(w.name)} (${w.w}&ndash;${w.l}, ${sign(w.diff)})`);
  return `<tr><td style="padding:22px 24px 0">
    ${label(`${n} The Table`)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border:1px solid ${C.bd};border-radius:12px;border-collapse:separate;overflow:hidden">
      <tr><td style="padding:9px 0 9px 16px;${th}">#</td><td style="padding:9px 0;${th}">Move</td><td style="padding:9px 0;${th}">Team</td><td align="right" style="padding:9px 0;${th}">Pts</td><td align="right" style="padding:9px 0;${th}">Games</td><td align="right" style="padding:9px 16px 9px 0;${th}">Diff</td></tr>
      ${rows}
    </table>
    ${m.tableRead ? `<div style="font-size:13.5px;line-height:1.6;color:${C.body};margin-top:12px">${esc(m.tableRead)}</div>` : ''}
    ${honors.length ? minis(honors, { mt: 14 }) : ''}
    ${mx.length ? `<div style="font-size:12px;color:${C.mut};margin-top:10px;line-height:1.5"><b style="color:${C.teal};font-weight:900;letter-spacing:.06em;text-transform:uppercase;font-size:10px">Best in mixed</b> &nbsp;${mx.join(' &middot; ')}</div>` : ''}
    <div style="margin-top:16px">${pill(links.standings, 'Open the full standings &rarr;', true)}</div>
    <div style="margin-top:8px">${pill(links.rankings, `Rankings &middot; where ${m.season.rankedCount ? `all ${m.season.rankedCount} players` : 'everyone'} landed &rarr;`, false)}</div>
  </td></tr>`;
}

/**
 * @param {object} m   model from buildNightModels
 * @param {object} [x] per-recipient extras:
 *   { site, inUrl, outUrl, availability: 'in'|'out'|null }
 * @returns {{ subject:string, html:string }}
 */
export function renderNightRecapEmail(m, x = {}) {
  const site = String(x.site || 'https://dinksociety.app').replace(/\/$/, '');
  const seasonId = seasonIdForCircuit(m.circuit);
  const q = `season=${encodeURIComponent(seasonId)}&${UTM}`;
  const links = {
    profile: `${site}/player?team=${encodeURIComponent(slug(m.teamName))}&name=${encodeURIComponent(m.name)}&${q}`,
    standings: `${site}/standings.html?${q}`,
    rankings: `${site}/leaderboard.html?circuit=${encodeURIComponent(m.circuit)}&${UTM}`,
    matchup: `${site}/leaderboard.html?circuit=${encodeURIComponent(m.circuit)}&view=tvt&${UTM}`,
    drop: `${site}/drop.html?${UTM}`,
    portal: `${site}/me?${UTM}`,
  };
  const hasNext = !!m.next;
  const num = hasNext ? ['&#9314;', '&#9315;'] : ['&#9313;', '&#9314;'];
  const dateLine = [seasonName(m.circuit), `Week ${m.week}`, fmt(m.date, { weekday: 'short', month: 'short', day: 'numeric' })]
    .filter(Boolean).map(esc).join(' &middot; ');

  const html = `<div style="background:${C.bg};margin:0;padding:0">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px">${esc(m.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000;padding:20px 8px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.bg};border:1px solid ${C.bd};border-radius:16px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:${C.tx}">
  <tr><td style="background:#12160d;padding:20px 24px;border-bottom:1px solid ${C.bd}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="white-space:nowrap"><span style="display:inline-block;width:32px;height:32px;border-radius:8px;background:${C.lime};color:${C.inv};font-weight:900;font-style:italic;text-align:center;line-height:32px;font-size:14px">DS</span>
      <span style="font-size:12px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;vertical-align:middle;margin-left:8px;color:${C.tx}">The Dink Society</span></td>
      <td align="right" style="font-size:10.5px;color:${C.lbl};font-weight:700;text-transform:uppercase;letter-spacing:.04em">${dateLine}</td>
    </tr></table>
  </td></tr>
  ${yourNight(m, links)}
  ${hasNext ? rule() + nextUp(m, x, links) : ''}
  ${rule()}
  ${yourTeam(m, num[0])}
  ${rule()}
  ${theTable(m, num[1], links)}
  <tr><td style="padding:18px 24px 24px">
    <div style="border-top:1px solid ${C.bd};padding-top:18px;font-size:11px;color:${C.lbl};line-height:1.7">You're getting this because you played Week ${m.week} of ${esc(seasonName(m.circuit))}.<br>
    <a href="${esc(links.profile)}" style="color:${C.lime};text-decoration:none;font-weight:700">Your profile</a> &middot; <a href="${esc(links.standings)}" style="color:${C.lime};text-decoration:none;font-weight:700">Standings</a> &middot; <a href="${esc(links.rankings)}" style="color:${C.lime};text-decoration:none;font-weight:700">Rankings</a> &middot; <a href="${esc(links.drop)}" style="color:${C.lime};text-decoration:none;font-weight:700">The Drop</a></div>
  </td></tr>
</table>
</td></tr></table></div>`;
  return { subject: m.subject, html };
}
