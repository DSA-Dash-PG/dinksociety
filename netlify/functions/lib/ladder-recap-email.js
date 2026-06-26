// netlify/functions/lib/ladder-recap-email.js
// Renders the two-part ladder recap email for ONE recipient. Tiles + podium +
// minis are built from hard numbers; the prose comes from the saved AI draft.
// Inline styles only (email clients strip <style>). Dark theme to match the app.

const C = {
  bg: '#0e0e0e', surf: '#161616', surf2: '#1e1e1e', bd: '#262626',
  tx: '#f0f0ec', mut: '#9a9e97', fnt: '#5e625c', inv: '#0e0e0e',
  lime: '#b8ff2c', teal: '#17d7b0', gold: '#f0c040', red: '#ff5c47',
};
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ord = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const sign = n => (n > 0 ? '+' : '') + n;
const fmtDate = d => { if (!d) return ''; try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }); } catch { return d; } };

function tile(v, k, color) {
  return `<td width="25%" style="padding:4px"><div style="background:${C.surf2};border:1px solid ${C.bd};border-radius:11px;padding:11px 8px;text-align:center">
    <div style="font-size:20px;font-weight:900;font-style:italic;color:${color || C.tx}">${v}</div>
    <div style="font-size:9px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.fnt};margin-top:3px">${k}</div></div></td>`;
}
function paras(arr) { return (arr || []).map(p => `<p style="margin:0 0 12px">${esc(p)}</p>`).join(''); }
// Part-2 html is AI HTML (already limited tags); keep as-is but strip anything wild.
const safeHtml = h => String(h || '').replace(/<(?!\/?(p|b|strong|em|blockquote)\b)[^>]*>/gi, '');

function podiumCells(podium) {
  const order = [podium[1], podium[0], podium[2]]; // 2-1-3 visual
  const mdl = ['🥈', '🥇', '🥉'];
  return order.map((p, i) => {
    if (!p) return '<td width="33%"></td>';
    const lead = i === 1;
    return `<td width="33%" valign="bottom" style="padding:4px"><div style="border:1px solid ${lead ? 'rgba(240,192,64,.35)' : C.bd};background:${lead ? 'rgba(240,192,64,.12)' : C.surf2};border-radius:11px;padding:12px 8px;text-align:center">
      <div style="font-size:18px">${mdl[i]}</div>
      <div style="font-size:13px;font-weight:800;color:${C.tx};margin-top:4px">${esc(p.name)}</div>
      <div style="font-size:10px;color:${C.mut};margin-top:2px">${p.w}–${p.l} · ${sign(p.diff)}</div></div></td>`;
  }).join('');
}

function miniRow(label, value, sub, color) {
  return `<td width="50%" style="padding:4px;vertical-align:top"><div style="background:${C.surf2};border:1px solid ${C.bd};border-radius:11px;padding:12px 13px">
    <div style="font-size:9px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:${C.fnt};margin-bottom:5px">${label}</div>
    <div style="font-size:14px;font-weight:800;color:${color || C.tx}">${value}</div>
    ${sub ? `<div style="font-size:11px;color:${C.mut};margin-top:2px;line-height:1.4">${sub}</div>` : ''}</div></td>`;
}

/**
 * @param {object} pr   player record from the draft (name, rank, count, w, l, diff, dr, delta, hi, sub, story, call, streak)
 * @param {object} recap the draft.recap (title, dek, html, seasonNote, podium, minis)
 * @param {object} event {name, date, type}
 * @param {string} siteUrl
 */
export function renderLadderRecapEmail(pr, recap, event, siteUrl) {
  const first = String(pr.name || 'there').split(' ')[0];
  const place = pr.rank ? ord(pr.rank) : '—';
  const climb = pr.delta == null ? '—' : pr.delta > 0 ? `▲ ${pr.delta}` : pr.delta < 0 ? `▼ ${Math.abs(pr.delta)}` : 'even';
  const climbColor = pr.delta > 0 ? C.lime : pr.delta < 0 ? C.red : C.mut;
  const diffColor = pr.diff > 0 ? C.lime : pr.diff < 0 ? C.red : C.tx;

  const tiles = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 6px"><tr>
    ${tile(`${pr.w}–${pr.l}`, 'Record')}
    ${tile(sign(pr.diff), 'Point diff', diffColor)}
    ${tile(`${place}`, 'Finish', C.gold)}
    ${tile(climb, 'Spots', climbColor)}
  </tr></table>`;

  const call = pr.call ? `<div style="background:rgba(184,255,44,.12);border:1px solid rgba(184,255,44,.28);border-left:3px solid ${C.lime};border-radius:10px;padding:13px 15px;margin:6px 0">
    <div style="font-size:9.5px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:${C.lime};margin-bottom:4px">${esc(pr.call.title || 'Highlight')}</div>
    <div style="font-size:13.5px;line-height:1.5;color:#eef3e4">${esc(pr.call.body || '')}</div></div>` : '';
  const streak = pr.streak ? `<div style="background:rgba(240,192,64,.12);border:1px solid rgba(240,192,64,.25);border-radius:10px;padding:11px 14px;margin:12px 0 0">
    <span style="font-size:16px">${esc(pr.streak.emoji || '⭐')}</span> <span style="font-size:12.5px;color:#f4e6c0;line-height:1.45">${esc(pr.streak.text || '')}</span></div>` : '';

  const m = recap.minis || {};
  const cells = [];
  if (m.biggestMover) cells.push(miniRow('Biggest Mover', `${esc(m.biggestMover.name)} ▲ ${m.biggestMover.jump}`, `From ${ord(m.biggestMover.from)} to ${ord(m.biggestMover.to)}${m.biggestMover.bestEver ? ' — a personal best' : ''}.`, C.lime));
  if (m.topGame) cells.push(miniRow('Top Game', esc(m.topGame.score), `${esc((m.topGame.winners || []).join(' & '))} over ${esc((m.topGame.losers || []).join(' & '))}, R${m.topGame.round}.`));
  if (m.mvpMale) cells.push(miniRow('MVP — Men', esc(m.mvpMale.name), `${m.mvpMale.w}–${m.mvpMale.l} · ${sign(m.mvpMale.diff)} diff.`, C.teal));
  if (m.mvpFemale) cells.push(miniRow('MVP — Women', esc(m.mvpFemale.name), `${m.mvpFemale.w}–${m.mvpFemale.l} · ${sign(m.mvpFemale.diff)} diff.`, C.teal));
  let minis = '';
  for (let i = 0; i < cells.length; i += 2) {
    minis += `<tr>${cells[i]}${cells[i + 1] || '<td width="50%"></td>'}</tr>`;
  }
  minis = minis ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0 4px">${minis}</table>` : '';

  const url = (siteUrl || 'https://dinksociety.app').replace(/\/$/, '');

  return `<div style="background:${C.bg};margin:0;padding:0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000;padding:20px 8px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.bg};border:1px solid ${C.bd};border-radius:16px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:${C.tx}">
  <tr><td style="background:#12160d;padding:20px 24px;border-bottom:1px solid ${C.bd}">
    <table role="presentation" width="100%"><tr>
      <td><span style="display:inline-block;width:32px;height:32px;border-radius:8px;background:${C.lime};color:${C.inv};font-weight:900;font-style:italic;text-align:center;line-height:32px;font-size:14px">DS</span>
      <span style="font-size:12px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;vertical-align:middle;margin-left:8px">The Dink Society</span></td>
      <td align="right" style="font-size:10.5px;color:${C.fnt};font-weight:700;text-transform:uppercase">${esc(fmtDate(event.date))}</td>
    </tr></table>
  </td></tr>

  <!-- PART 1 -->
  <tr><td style="padding:20px 24px 0">
    <div style="font-size:10.5px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:${C.fnt}">① Your Night</div>
    <div style="font-size:13px;color:${C.mut};font-weight:700;margin-top:12px">${esc(pr.hi || `Nice work, ${first}.`)}</div>
    <div style="font-size:38px;font-weight:900;font-style:italic;text-transform:uppercase;line-height:1;margin:6px 0 2px"><span style="color:${C.lime}">${place}</span> <span style="font-size:15px;color:${C.mut};font-style:normal;font-weight:700">of ${pr.count}</span></div>
    ${pr.sub ? `<div style="font-size:13px;color:${C.mut};font-weight:600">${esc(pr.sub)}</div>` : ''}
    ${tiles}
    <div style="font-size:14px;line-height:1.68;color:#dcdfd7;padding-top:8px">${paras(pr.story)}</div>
    ${call}
    ${streak}
  </td></tr>

  <tr><td style="padding:0 24px"><div style="height:1px;background:${C.bd};margin:22px 0 0"></div></td></tr>

  <!-- PART 2 -->
  <tr><td style="padding:20px 24px 0">
    <div style="font-size:10.5px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:${C.fnt}">② The Ladder Recap</div>
    <div style="font-size:26px;font-weight:900;font-style:italic;text-transform:uppercase;line-height:1.05;margin-top:12px">${esc(recap.title)}</div>
    ${recap.dek ? `<div style="font-size:12px;color:${C.mut};font-weight:600;margin-top:5px">${esc(recap.dek)}</div>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 4px"><tr>${podiumCells(recap.podium || [])}</tr></table>
    <div style="font-size:14px;line-height:1.68;color:#dcdfd7;padding-top:10px">${safeHtml(recap.html)}</div>
    ${minis}
    ${recap.seasonNote ? `<div style="background:rgba(184,255,44,.1);border:1px solid rgba(184,255,44,.22);border-radius:10px;padding:13px 15px;margin-top:12px;font-size:13.5px;line-height:1.55;color:#eef3e4">${safeHtml(recap.seasonNote)}</div>` : ''}
    <a href="${url}/ladders.html" style="display:block;text-align:center;margin:16px 0 0;background:${C.lime};color:${C.inv};font-weight:900;font-size:13px;padding:13px;border-radius:9999px;text-decoration:none">See full results & the live ladder →</a>
  </td></tr>

  <tr><td style="padding:18px 24px 24px;border-top:1px solid ${C.bd};margin-top:18px">
    <div style="font-size:11px;color:${C.fnt};line-height:1.6">You're getting this because you played the ${esc(event.name)} ladder. Scores are final once both captains on each court confirm.<br>
    <a href="${url}/ladders.html" style="color:${C.lime};text-decoration:none;font-weight:700">View the ladder</a> · <a href="${url}/me.html" style="color:${C.lime};text-decoration:none;font-weight:700">Your profile</a></div>
  </td></tr>
</table>
</td></tr></table></div>`;
}
