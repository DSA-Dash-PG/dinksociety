// netlify/functions/lib/ladder-dupr-email.js
// Pure render of the admin email that carries a ladder night's DUPR import CSV
// (sent by ladder-dupr-cron.js). Night-Match styling, same shell as the other
// admin notifications in lib/email.js.

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmtDate(d) {
  if (!d) return '';
  const t = new Date(`${d}T12:00:00Z`);
  if (Number.isNaN(t.getTime())) return d;
  return t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

const box = (label, inner, color = '#8a8a8a') => `
      <div style="background:#161616;border-radius:8px;padding:14px 16px;margin:0 0 14px;">
        <div style="font-size:11px;color:${color};text-transform:uppercase;letter-spacing:0.06em;font-weight:800;margin-bottom:7px;">${label}</div>
        ${inner}
      </div>`;

/**
 * @param {{ event:object, export:{ games:number, total:number, skipped:Array, missing:string[], unverified:Array<{name:string,club:string}> },
 *           correction?:boolean, adminUrl?:string }} o
 */
export function renderDuprExportEmail({ event, export: x, correction = false, adminUrl }) {
  const name = esc(event && event.name);
  const when = esc(fmtDate(event && event.date));
  const p = 'font-size:14px;color:#cfcfcf;line-height:1.6;margin:0;';
  const skipped = (x.skipped || []);
  const unv = (x.unverified || []);

  const lead = correction
    ? `This night was reopened and finished again, so here is the corrected file. Delete the earlier upload's matches in DUPR before importing this one, or the games will count twice.`
    : `The night is final. The attached CSV has every game in DUPR's import format.`;

  const steps = `<ol style="${p}padding-left:18px;">
          <li>DUPR → your club → <b style="color:#fff;">Matches</b> → <b style="color:#fff;">Import Matches via CSV</b></li>
          <li>Date format <b style="color:#fff;">YYYY-MM-DD</b>, upload the attached file</li>
          <li>Check the preview has ${x.games} row${x.games === 1 ? '' : 's'}, then Upload</li>
        </ol>`;

  const skippedHtml = skipped.length
    ? box(`Left out (${skipped.length})`, `<ul style="${p}padding-left:18px;">${skipped.map(s => `<li>Round ${s.round}, ${esc(s.court)}: ${esc(s.reason)}</li>`).join('')}</ul>
        ${(x.missing || []).length ? `<p style="${p}margin-top:8px;color:#8a8a8a;">Add the missing DUPR IDs in Admin → Players, then download the file again from the ladder page.</p>` : ''}`, '#ff5c47')
    : '';

  const unvHtml = unv.length
    ? box(`Not verified in the DUPR club (${unv.length})`, `<p style="${p}">DUPR only takes matches for club members. If any of these haven't joined, their games will be rejected:</p>
        <p style="${p}margin-top:6px;color:#fff;">${unv.map(u => `${esc(u.name)}${u.club === 'confirmed' ? ' <span style="color:#8a8a8a;">(says joined)</span>' : ''}`).join(', ')}</p>`, '#f0c040')
    : '';

  return `
    <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#0e0e0e;color:#f5f5f5;">
      <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:#f5f5f5;margin-bottom:28px;">THE DINK SOCIETY</div>
      <h1 style="font-size:22px;font-weight:800;color:#f5f5f5;margin:0 0 6px;line-height:1.25;">${correction ? 'Updated ' : ''}DUPR upload: ${name}</h1>
      <div style="font-size:13px;color:#8a8a8a;margin:0 0 18px;">${when}${event && event.place ? ` · ${esc(event.place)}` : ''}</div>
      <p style="${p}margin-bottom:18px;">${lead}</p>
      ${box('In the file', `<div style="font-size:26px;font-weight:800;color:#b8ff2c;">${x.games} <span style="font-size:14px;color:#cfcfcf;font-weight:700;">of ${x.total} game${x.total === 1 ? '' : 's'}</span></div>`)}
      ${skippedHtml}
      ${unvHtml}
      ${box('How to upload', steps)}
      ${adminUrl ? `<p style="${p}font-size:13px;color:#8a8a8a;">Need it again? Admin → Ladders → open the ladder → <b style="color:#cfcfcf;">Download DUPR CSV</b>. <a href="${esc(adminUrl)}" style="color:#b8ff2c;">Open admin</a></p>` : ''}
      <div style="margin-top:40px;padding-top:20px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;">
        The Dink Society · Sent to admins after every DUPR-rated ladder.
      </div>
    </div>
  `;
}
