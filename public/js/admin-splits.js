// public/js/admin-splits.js
// Admin → Teams → team panel → "Team fee split (private)".
// READ-ONLY view of a captain's split ledger. The endpoint never writes, logs,
// or notifies, and nothing in the captain or player UI mentions admin access —
// so looking here leaves no trace on the team side.
(function () {
  'use strict';
  const API = '/.netlify/functions/admin-team-splits';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (c) => {
    const n = Math.round(Number(c) || 0), a = Math.abs(n), cents = a % 100;
    return (n < 0 ? '-' : '') + '$' + Math.floor(a / 100).toLocaleString('en-US') + (cents ? '.' + String(cents).padStart(2, '0') : '');
  };
  const shortDate = (iso) => { try { return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }); } catch { return ''; } };
  const STATUS = { self: 'Captain', paid: 'Paid', claim: 'Says paid', owes: 'Owes', none: '—' };
  const COLOR = { self: 'var(--color-text-faint)', paid: '#b8ff2c', claim: '#f0c040', owes: '#ff5c47', none: 'var(--color-text-faint)' };

  async function mount(teamId, el) {
    if (!el || !teamId) return;
    el.innerHTML = '<div style="font-size:12px;color:var(--color-text-faint);">Loading split…</div>';
    try {
      const res = await fetch(API + '?teamId=' + encodeURIComponent(teamId), { credentials: 'include' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not load');
      if (!d.config) { el.innerHTML = '<div style="font-size:12px;color:var(--color-text-faint);">This captain hasn’t set up a split.</div>'; return; }
      const c = d.config, L = d.ledger, T = L.totals;
      const head = (L.mode === 'flat' ? `Flat · ${fmt(c.amountCents)} split` : `Per game · ${fmt(c.rateCents)} a game · ${T.gamesBilled} games billed`)
        + (c.enabled ? '' : ' · <span style="color:#ff5c47">turned off</span>')
        + (c.venmoHandle ? ` · @${esc(c.venmoHandle)}` : '')
        + (L.mode === 'flat' ? (c.lockedAt ? ` · locked ${shortDate(c.lockedAt)}` : ' · not locked') : '');
      const rows = L.rows.map(r => `<tr>
          <td style="padding:6px 8px 6px 0;">${esc(r.name)}${r.isSub ? ' <span style="color:var(--color-text-faint)">(sub)</span>' : ''}${r.archived ? ' <span style="color:var(--color-text-faint)">(left)</span>' : ''}</td>
          ${L.mode === 'pergame' ? `<td style="padding:6px 8px;text-align:right;">${r.games}</td>` : ''}
          <td style="padding:6px 8px;text-align:right;">${fmt(r.owedCents)}</td>
          <td style="padding:6px 8px;text-align:right;">${fmt(r.paidCents)}</td>
          <td style="padding:6px 8px;text-align:right;font-weight:700;">${fmt(r.balanceCents)}</td>
          <td style="padding:6px 0 6px 8px;color:${COLOR[r.status]};font-weight:700;white-space:nowrap;">${STATUS[r.status]}</td>
        </tr>`).join('');
      el.innerHTML = `
        <div style="font-size:12px;color:var(--color-text-muted);margin-bottom:8px;">${head}</div>
        <div style="font-size:12px;margin-bottom:10px;"><b style="color:#b8ff2c">${fmt(T.collectedCents)}</b> collected · <b>${fmt(T.outstandingCents)}</b> outstanding of ${fmt(T.totalCents)}${c.updatedAt ? ` · updated ${shortDate(c.updatedAt)}` : ''}</div>
        <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="color:var(--color-text-faint);font-size:10px;text-transform:uppercase;letter-spacing:.08em;text-align:right;">
            <th style="text-align:left;padding:4px 8px 4px 0;">Player</th>${L.mode === 'pergame' ? '<th style="padding:4px 8px;">Games</th>' : ''}<th style="padding:4px 8px;">Owes</th><th style="padding:4px 8px;">Paid</th><th style="padding:4px 8px;">Balance</th><th style="text-align:left;padding:4px 0 4px 8px;">Status</th>
          </tr></thead><tbody>${rows}</tbody></table></div>`;
    } catch (e) {
      el.innerHTML = '<div style="font-size:12px;color:#ff5c47;">' + esc(e.message || 'Could not load the split.') + '</div>';
    }
  }

  window.DSAdminSplits = { mount };
})();
