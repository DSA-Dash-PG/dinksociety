// public/js/shirt-size.js
// Shirt sizes, two surfaces:
//   DSShirt.mountPlayer(el)  Player Portal → profile sheet. Tap a size — saves right away.
//   DSShirt.mountAdmin(el)   Admin → Players. League-wide order sheet, who's missing,
//                            set a size for someone, export CSV.
(function () {
  'use strict';
  const P_API = '/.netlify/functions/player-shirt-size';
  const A_API = '/.netlify/functions/admin-shirt-sizes';
  const CUT_LABEL = { unisex: 'Unisex / Men’s', womens: 'Women’s' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function css() {
    if (document.getElementById('shirt-css')) return;
    const st = document.createElement('style');
    st.id = 'shirt-css';
    st.textContent = `
      .sz{margin:14px 0 4px}
      .sz__l{font-size:11px;font-weight:700;color:var(--color-text-muted);margin-bottom:8px;display:flex;justify-content:space-between;gap:8px}
      .sz__l em{font-style:normal;color:var(--color-teal);font-weight:700}
      .sz__row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
      .sz__b{font:inherit;font-size:12px;font-weight:800;min-width:44px;padding:9px 10px;border-radius:10px;border:1px solid var(--color-border-strong);background:var(--color-surface-2);color:var(--color-text);cursor:pointer}
      .sz__b.on{background:var(--color-lime);border-color:var(--color-lime);color:var(--color-text-inverse)}
      .sz__b:disabled{opacity:.5}
      .sz__hint{font-size:11px;color:var(--color-text-faint);line-height:1.5}
      .sza{background:var(--color-surface);border:1px solid var(--color-border);border-radius:14px;padding:14px 16px;margin:0 0 14px}
      .sza__h{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
      .sza__t{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}
      .sza__t span{color:var(--color-text-faint);font-weight:600;text-transform:none;letter-spacing:0}
      .sza__tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
      .sza__tools select,.sza__tools a,.sza__tools button{font:inherit;font-size:11px;font-weight:700;border-radius:9999px;padding:6px 12px;border:1px solid var(--color-border-strong);background:var(--color-surface-2);color:var(--color-text);cursor:pointer;text-decoration:none}
      .sza__grid{display:grid;grid-template-columns:auto repeat(7,minmax(34px,1fr)) auto;gap:4px 6px;font-size:12px;align-items:center;overflow-x:auto}
      .sza__grid div{text-align:center;padding:5px 2px}
      .sza__grid .hd{font-size:10px;font-weight:800;color:var(--color-text-faint);letter-spacing:.06em}
      .sza__grid .rl{text-align:left;font-weight:700;color:var(--color-text-muted);white-space:nowrap}
      .sza__grid .n{font-weight:800;background:var(--color-surface-2);border-radius:8px}
      .sza__grid .n.z{color:var(--color-text-faint);font-weight:600}
      .sza__grid .tot{font-weight:800;color:var(--color-lime)}
      .sza__bar{position:sticky;top:0;z-index:3;display:flex;gap:6px;flex-wrap:wrap;background:var(--color-surface);padding:10px 0}
      .sza__bar input{flex:1;min-width:160px}
      .sza__tbl{width:100%;border-collapse:collapse;font-size:12px}
      .sza__tbl td{padding:6px 8px 6px 0;border-top:1px solid var(--color-border)}
      .sza__tbl select{font:inherit;font-size:12px;padding:4px 6px;min-height:0;width:auto}
      .sza__miss{color:#ff5c47;font-weight:700}
    `;
    document.head.appendChild(st);
  }

  // ════════ PLAYER ════════
  async function mountPlayer(el) {
    if (!el) return;
    css();
    let d = null, busy = false, note = '';
    const paint = () => {
      const sizes = d.sizes || [], cut = d.cut || 'unisex';
      el.innerHTML = `<div class="sz">
        <div class="sz__l"><span>Shirt size</span><em>${esc(note)}</em></div>
        <div class="sz__row">${sizes.map(s => `<button type="button" class="sz__b${d.size === s ? ' on' : ''}" data-size="${s}" ${busy ? 'disabled' : ''}>${s}</button>`).join('')}</div>
        <div class="sz__row">${(d.cuts || []).map(c => `<button type="button" class="sz__b${cut === c ? ' on' : ''}" data-cut="${c}" ${busy || !d.size ? 'disabled' : ''}>${CUT_LABEL[c] || c}</button>`).join('')}</div>
        <div class="sz__hint">For league shirts. Saves right away, stays with you season to season, and only the league sees it.</div>
      </div>`;
      el.querySelectorAll('[data-size]').forEach(b => b.addEventListener('click', () => save({ size: b.dataset.size, cut: d.cut || undefined })));
      el.querySelectorAll('[data-cut]').forEach(b => b.addEventListener('click', () => save({ size: d.size, cut: b.dataset.cut })));
    };
    const save = async (body) => {
      if (busy) return;
      busy = true; note = 'Saving…'; paint();
      try {
        const r = await fetch(P_API, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'Could not save');
        d = Object.assign({}, d, j); note = 'Saved ✓';
      } catch (e) { note = e.message; }
      busy = false; paint();
    };
    el.innerHTML = '<div class="sz"><div class="sz__hint">Loading shirt size…</div></div>';
    try {
      const r = await fetch(P_API, { credentials: 'include' });
      if (!r.ok) throw new Error();
      d = await r.json(); paint();
    } catch { el.innerHTML = ''; }
  }

  // ════════ ADMIN ════════
  function mountAdmin(el) {
    if (!el) return;
    css();
    const S = el.__shirt = el.__shirt || { circuit: '', open: false, q: '', missingOnly: false, data: null };
    const load = async () => {
      if (!S.data) el.innerHTML = '<div class="sza"><div class="sz__hint">Loading shirt sizes…</div></div>';
      try {
        const r = await fetch(A_API + (S.circuit ? '?circuit=' + encodeURIComponent(S.circuit) : ''), { credentials: 'include' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'Could not load shirt sizes');
        S.data = j; paint();
      } catch (e) { el.innerHTML = '<div class="sza"><div class="sz__hint" style="color:#ff5c47">' + esc(e.message) + '</div></div>'; }
    };
    const paint = () => {
      const d = S.data, T = d.tally, sizes = d.sizes;
      const gridRow = (cut) => {
        const c = T.counts[cut], tot = sizes.reduce((s, z) => s + c[z], 0);
        return `<div class="rl">${CUT_LABEL[cut]}</div>` + sizes.map(z => `<div class="n${c[z] ? '' : ' z'}">${c[z]}</div>`).join('') + `<div class="tot">${tot}</div>`;
      };
      const q = S.q.trim().toLowerCase();
      const rows = d.rows.filter(r => (!S.missingOnly || !r.size) && (!q || (r.name + ' ' + r.team + ' ' + r.email).toLowerCase().includes(q)));
      const sel = (r) => `<select data-k="${esc(r.email || '')}" data-p="${esc(r.playerId)}" data-f="size"><option value="">—</option>${sizes.map(z => `<option${r.size === z ? ' selected' : ''}>${z}</option>`).join('')}</select>
        <select data-k="${esc(r.email || '')}" data-p="${esc(r.playerId)}" data-f="cut" ${r.size ? '' : 'disabled'}>${d.cuts.map(c => `<option value="${c}"${(r.cut || 'unisex') === c ? ' selected' : ''}>${c === 'womens' ? 'Women’s' : 'Unisex'}</option>`).join('')}</select>`;
      el.innerHTML = `<div class="sza">
        <div class="sza__h">
          <div class="sza__t">👕 Shirt sizes <span>· ${T.have} of ${T.total} in${T.missing ? ` · <b class="sza__miss">${T.missing} missing</b>` : ' · everyone’s in'}</span></div>
          <div class="sza__tools">
            <select id="sza-circ" aria-label="Season"><option value="">Live season</option><option value="all"${S.circuit === 'all' ? ' selected' : ''}>All seasons</option></select>
            <button type="button" id="sza-toggle">${S.open ? 'Hide players' : 'Show players'}</button>
            <a href="${A_API}?format=csv${S.circuit ? '&circuit=' + encodeURIComponent(S.circuit) : ''}">Export CSV</a>
          </div>
        </div>
        <div class="sza__grid"><div class="hd"></div>${sizes.map(z => `<div class="hd">${z}</div>`).join('')}<div class="hd">TOTAL</div>${gridRow('unisex')}${gridRow('womens')}</div>
        ${S.open ? `
          <div class="sza__bar">
            <input id="sza-q" type="text" placeholder="Type a name or team…" value="${esc(S.q)}" aria-label="Find a player">
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--color-text-muted);white-space:nowrap;"><input type="checkbox" id="sza-miss" ${S.missingOnly ? 'checked' : ''} style="width:auto;min-height:0;"> Missing only</label>
          </div>
          <div style="max-height:420px;overflow:auto;"><table class="sza__tbl"><tbody>${rows.map(r => `<tr>
            <td><b>${esc(r.name)}</b>${r.isSub ? ' <span style="color:var(--color-text-faint)">(sub)</span>' : ''}<div style="color:var(--color-text-faint);font-size:11px;">${esc(r.team)}${r.gender ? ' · ' + esc(r.gender) : ''}</div></td>
            <td style="white-space:nowrap;text-align:right;">${sel(r)}</td>
          </tr>`).join('') || '<tr><td style="color:var(--color-text-faint);padding:14px 0;">Nobody matches.</td></tr>'}</tbody></table></div>
          <div class="sz__hint" style="margin-top:8px;">Players set this in their own profile. Changing it here saves right away on their behalf.</div>` : ''}
      </div>`;
      el.querySelector('#sza-toggle').addEventListener('click', () => { S.open = !S.open; paint(); });
      el.querySelector('#sza-circ').addEventListener('change', (e) => { S.circuit = e.target.value; S.data = null; load(); });
      const qEl = el.querySelector('#sza-q');
      if (qEl) qEl.addEventListener('input', () => { S.q = qEl.value; const pos = qEl.selectionStart; paint(); const n = el.querySelector('#sza-q'); n.focus(); try { n.setSelectionRange(pos, pos); } catch {} });
      el.querySelector('#sza-miss')?.addEventListener('change', (e) => { S.missingOnly = e.target.checked; paint(); });
      el.querySelectorAll('select[data-f]').forEach(s => s.addEventListener('change', async () => {
        const row = d.rows.find(r => r.playerId === s.dataset.p);
        if (!row) return;
        const size = s.dataset.f === 'size' ? s.value : row.size;
        const cut = s.dataset.f === 'cut' ? s.value : (row.cut || 'unisex');
        s.disabled = true;
        try {
          const r = await fetch(A_API, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: row.email || undefined, playerId: row.playerId, size: size || null, cut }) });
          if (!r.ok) throw new Error();
        } catch { alert('Could not save that size — try again.'); }
        load();
      }));
    };
    load();
  }

  window.DSShirt = { mountPlayer, mountAdmin };
})();
