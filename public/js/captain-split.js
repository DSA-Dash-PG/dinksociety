// public/js/captain-split.js
// Captain portal → Billing → "Split with your team".
// Self-contained: renders into #split-area, talks to captain-split and
// captain-split-notify. captain.html only needs the card markup, this script
// tag, and one call to window.DSSplit.load() when the Billing tab opens.
//
// All money is integer cents end to end — no rounding to the dollar.
(function () {
  'use strict';
  const API = '/.netlify/functions/captain-split';
  const NOTIFY = '/.netlify/functions/captain-split-notify';
  const GAMES_PER_NIGHT = 24;   // 12 games x 2 of our players
  const SEASON_NIGHTS = 7;

  const S = { data: null, editing: false, filter: 'all', open: null, draft: null, msg: null };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (c) => {
    const n = Math.round(Number(c) || 0), a = Math.abs(n), cents = a % 100;
    return (n < 0 ? '-' : '') + '$' + Math.floor(a / 100).toLocaleString('en-US') + (cents ? '.' + String(cents).padStart(2, '0') : '');
  };
  const toCents = (v) => {
    const s = String(v ?? '').replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    const [d, f = ''] = s.split('.');
    return Number(d) * 100 + Number((f + '00').slice(0, 2));
  };
  const dollars = (c) => (Math.round(c || 0) / 100).toFixed(2).replace(/\.00$/, '');
  const initials = (n) => String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const shortDate = (iso) => { try { return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }); } catch { return ''; } };

  async function api(url, body) {
    const res = await fetch(url, body
      ? { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong — try again.');
    return data;
  }

  function injectCss() {
    if ($('spl-css')) return;
    const st = document.createElement('style');
    st.id = 'spl-css';
    st.textContent = `
      .spl-seg{display:flex;background:var(--color-surface-2);border-radius:9999px;padding:3px;margin:0 0 14px}
      .spl-seg button{flex:1;border:none;background:none;font:inherit;font-size:12px;font-weight:800;padding:9px 0;border-radius:9999px;color:var(--color-text-faint);cursor:pointer}
      .spl-seg button.on{background:var(--color-lime);color:var(--color-text-inverse)}
      .spl-fld{margin:0 0 12px}
      .spl-fld label{display:block;font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--color-text-faint);margin-bottom:5px}
      .spl-inp{display:flex;align-items:center;background:var(--color-surface-2);border:1px solid var(--color-border-strong);border-radius:10px;padding:0 12px}
      .spl-inp:focus-within{border-color:var(--color-lime)}
      .spl-inp span{color:var(--color-text-faint);font-weight:700;font-size:15px}
      .spl-inp input{flex:1;min-width:0;width:100%;background:none;border:none;outline:none;color:var(--color-text);font:inherit;font-size:16px;font-weight:800;padding:11px 6px}
      .spl-hint{font-size:12px;color:var(--color-text-muted);line-height:1.55;margin:6px 0 0}
      .spl-chip{display:inline-block;font:inherit;font-size:11px;font-weight:700;border:1px solid rgba(184,255,44,.35);color:var(--color-lime);background:var(--color-lime-ghost);border-radius:9999px;padding:5px 11px;margin-top:8px;cursor:pointer}
      .spl-result{background:linear-gradient(135deg,rgba(184,255,44,.14),rgba(23,215,176,.07));border:1px solid rgba(184,255,44,.28);border-radius:14px;padding:14px;margin:4px 0 14px;text-align:center}
      .spl-result__l{font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--color-text-muted);margin-bottom:6px}
      .spl-result__b{font-size:28px;font-weight:800;color:var(--color-lime);line-height:1}
      .spl-result__s{font-size:12px;color:var(--color-text-muted);margin-top:7px;line-height:1.5}
      .spl-note{display:flex;gap:9px;align-items:flex-start;background:var(--color-gold-dim);border:1px solid rgba(240,192,64,.28);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--color-text-muted);line-height:1.5;margin:0 0 14px}
      .spl-note b{color:var(--color-gold)}
      .spl-prog{height:8px;border-radius:9999px;background:var(--color-surface-3);overflow:hidden;margin:4px 0 7px}
      .spl-prog i{display:block;height:100%;background:var(--color-lime);border-radius:9999px;transition:width .25s}
      .spl-progrow{display:flex;justify-content:space-between;font-size:12px;color:var(--color-text-muted);margin-bottom:12px}
      .spl-progrow b{color:var(--color-text)}
      .spl-filters{position:sticky;top:56px;z-index:5;display:flex;gap:6px;padding:8px 0;background:var(--color-surface);overflow-x:auto}
      .spl-filters button{flex-shrink:0;font:inherit;font-size:11px;font-weight:800;padding:7px 13px;border-radius:9999px;border:1px solid var(--color-border-strong);background:none;color:var(--color-text-muted);cursor:pointer}
      .spl-filters button.on{background:var(--color-text);color:var(--color-text-inverse);border-color:var(--color-text)}
      .spl-row{border-bottom:1px solid var(--color-border)}
      .spl-row:last-child{border-bottom:none}
      .spl-row__top{display:flex;align-items:center;gap:10px;padding:11px 0;cursor:pointer}
      .spl-av{width:32px;height:32px;border-radius:50%;background:var(--color-surface-3);display:grid;place-items:center;font-size:11px;font-weight:800;color:var(--color-text-muted);flex-shrink:0}
      .spl-row__m{flex:1;min-width:0}
      .spl-row__n{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .spl-row__d{font-size:11px;color:var(--color-text-faint);margin-top:1px}
      .spl-row__amt{font-size:13px;font-weight:800;text-align:right;white-space:nowrap}
      .spl-pill{font:inherit;font-size:10px;font-weight:800;border-radius:9999px;padding:6px 11px;border:none;cursor:pointer;white-space:nowrap}
      .spl-pill.paid{background:var(--color-lime-dim);color:var(--color-lime);cursor:default}
      .spl-pill.owes{background:var(--color-lime);color:var(--color-text-inverse)}
      .spl-pill.claim{background:var(--color-gold);color:var(--color-text-inverse)}
      .spl-pill.self,.spl-pill.none{background:var(--color-surface-2);color:var(--color-text-faint);cursor:default}
      .spl-x{font:inherit;font-size:12px;font-weight:800;width:28px;height:28px;border-radius:50%;border:1px solid var(--color-border-strong);background:none;color:var(--color-text-muted);cursor:pointer}
      .spl-drawer{background:var(--color-surface-2);border-radius:12px;padding:12px;margin:0 0 12px;font-size:12px;color:var(--color-text-muted)}
      .spl-drawer h4{font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--color-text-faint);margin:12px 0 6px}
      .spl-drawer h4:first-child{margin-top:0}
      .spl-kv{display:flex;justify-content:space-between;gap:10px;padding:4px 0}
      .spl-kv span:last-child{color:var(--color-text);font-weight:700;white-space:nowrap}
      .spl-mini{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
      .spl-mini input,.spl-mini select{font:inherit;font-size:13px;font-weight:700;background:var(--color-surface);border:1px solid var(--color-border-strong);border-radius:8px;color:var(--color-text);padding:8px 9px;min-width:0}
      .spl-mini input{width:92px}
      .spl-link{font:inherit;font-size:11px;font-weight:700;background:none;border:none;color:var(--color-teal);cursor:pointer;padding:0;text-decoration:underline}
      .spl-link.red{color:var(--color-red)}
      .spl-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
      .spl-actions .cap-btn{flex:1;min-width:150px;padding:12px 14px}
      .spl-msg{font-size:12px;margin-top:12px;padding:10px 14px;border-radius:10px}
      .spl-msg.ok{background:var(--color-teal-dim);color:var(--color-teal)}
      .spl-msg.err{background:var(--color-red-dim);color:var(--color-red)}
      .spl-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:6px;font-size:13px;color:var(--color-text-muted)}
      .spl-head b{color:var(--color-text)}
    `;
    document.head.appendChild(st);
  }

  // ── exact-cent even split, mirrors lib/team-split-math.js splitEvenly()
  function evenText(totalCents, n) {
    if (!n) return 'Add players to your roster first.';
    const base = Math.floor(totalCents / n), extra = totalCents - base * n;
    if (!extra) return `${n} players × ${fmt(base)} = ${fmt(totalCents)}`;
    return `${extra} pay ${fmt(base + 1)} · ${n - extra} pay ${fmt(base)} = ${fmt(totalCents)} to the cent`;
  }

  function setMsg(kind, text) { S.msg = text ? { kind, text } : null; }
  const msgHtml = () => S.msg ? `<div class="spl-msg ${S.msg.kind}">${esc(S.msg.text)}</div>` : '';

  // ════════ SETUP ════════
  function renderSetup() {
    const d = S.data, cfg = d.config;
    const dr = S.draft = S.draft || {
      mode: cfg?.mode || 'flat',
      amount: cfg?.amountCents ? dollars(cfg.amountCents) : (d.teamFeeCents ? dollars(d.teamFeeCents) : ''),
      rate: cfg?.rateCents ? dollars(cfg.rateCents) : '',
      collect: cfg?.collect || 'weekly',
      venmoHandle: cfg?.venmoHandle || '',
    };
    const n = d.activeCount || 0;
    const flat = dr.mode === 'flat';
    const seasonGames = GAMES_PER_NIGHT * SEASON_NIGHTS;
    const suggest = d.teamFeeCents ? Math.ceil(d.teamFeeCents / seasonGames) : null;

    let result = '';
    if (flat) {
      const c = toCents(dr.amount);
      result = c == null
        ? `<div class="spl-result"><div class="spl-result__l">Each player owes</div><div class="spl-result__b">—</div><div class="spl-result__s">Type the amount you want to split.</div></div>`
        : `<div class="spl-result"><div class="spl-result__l">Each player owes</div><div class="spl-result__b">${n ? fmt(Math.floor(c / n)) + (c % n ? ' – ' + fmt(Math.floor(c / n) + 1) : '') : '—'}</div><div class="spl-result__s">${esc(evenText(c, n))}<br>You count as one of the ${n}.</div></div>`;
    } else {
      const r = toCents(dr.rate);
      const tot = r == null ? null : r * seasonGames;
      const gap = (tot != null && d.teamFeeCents) ? tot - d.teamFeeCents : null;
      result = `<div class="spl-result"><div class="spl-result__l">If your team plays ${SEASON_NIGHTS} nights</div><div class="spl-result__b" style="${gap != null && gap < 0 ? 'color:var(--color-red)' : ''}">${tot == null ? '—' : fmt(tot)}</div><div class="spl-result__s">${
        tot == null ? 'Type a price per game.'
          : `${seasonGames} player-games × ${fmt(r)}` + (gap == null ? '' : gap < 0 ? ` · <b style="color:var(--color-red)">${fmt(-gap)} short of your ${fmt(d.teamFeeCents)} fee</b>` : ` · covers your ${fmt(d.teamFeeCents)} fee${gap ? ' with ' + fmt(gap) + ' to spare' : ''}`)
      }<br>A match night is 12 games × 2 players = ${GAMES_PER_NIGHT} player-games, whatever your roster size.</div></div>`;
    }

    $('split-area').innerHTML = `
      <div class="spl-seg" id="spl-mode"><button data-m="flat" class="${flat ? 'on' : ''}">Flat split</button><button data-m="pergame" class="${flat ? '' : 'on'}">Per game</button></div>
      ${flat ? `
        <div class="spl-fld"><label for="spl-amount">Amount to split</label><div class="spl-inp"><span>$</span><input id="spl-amount" inputmode="decimal" autocomplete="off" value="${esc(dr.amount)}" placeholder="700"></div>
          <p class="spl-hint">Starts at your team fee. Add to it if you're also covering balls or shirts. Split to the exact cent across your ${n} active players — no rounding up.</p></div>`
      : `
        <div class="spl-fld"><label for="spl-rate">Price per game</label><div class="spl-inp"><span>$</span><input id="spl-rate" inputmode="decimal" autocomplete="off" value="${esc(dr.rate)}" placeholder="4.17"></div>
          ${suggest ? `<button type="button" class="spl-chip" id="spl-suggest">Use ${fmt(suggest)} — covers the ${fmt(d.teamFeeCents)} fee</button>` : ''}
          <p class="spl-hint">Players pay for the games they actually play, all season long — playoffs included. Tabs update on their own once a match night is finalized.</p></div>`}
      ${result}
      ${flat ? '' : `<div class="spl-fld"><label>Collect</label><div class="spl-seg" id="spl-collect" style="margin:0"><button data-c="weekly" class="${dr.collect === 'weekly' ? 'on' : ''}">After each week</button><button data-c="season" class="${dr.collect === 'season' ? 'on' : ''}">End of season</button></div></div>`}
      <div class="spl-fld"><label for="spl-venmo">Your Venmo handle</label><div class="spl-inp"><span>@</span><input id="spl-venmo" autocomplete="off" autocapitalize="off" spellcheck="false" style="font-size:15px" value="${esc(dr.venmoHandle)}" placeholder="your-handle"></div>
        <p class="spl-hint">Players get a Pay-on-Venmo button that opens your profile. Leave blank if you collect another way.</p></div>
      ${flat ? `<div class="spl-note"><span>🔒</span><div><b>Shares follow your roster until it locks</b> (after your Week 2 match), then freeze. You can also lock them early from the ledger.</div></div>` : ''}
      <div class="spl-actions">
        <button class="cap-btn cap-btn--primary" id="spl-save">Save split</button>
        ${cfg ? `<button class="cap-btn cap-btn--ghost" id="spl-cancel">Cancel</button>` : ''}
      </div>
      ${cfg?.enabled ? `<p class="spl-hint" style="text-align:center;margin-top:14px"><button class="spl-link red" id="spl-off">Turn the split off</button> — players stop seeing it; your ledger is kept.</p>` : ''}
      ${msgHtml()}`;

    const keep = (id, key) => { const el = $(id); if (el) el.addEventListener('input', () => { dr[key] = el.value; refreshResult(); }); };
    keep('spl-amount', 'amount'); keep('spl-rate', 'rate'); keep('spl-venmo', 'venmoHandle');
    $('spl-mode').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { dr.mode = b.dataset.m; setMsg(); renderSetup(); }));
    $('spl-collect')?.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { dr.collect = b.dataset.c; renderSetup(); }));
    $('spl-suggest')?.addEventListener('click', () => { dr.rate = dollars(suggest); renderSetup(); });
    $('spl-cancel')?.addEventListener('click', () => { S.editing = false; S.draft = null; setMsg(); render(); });
    $('spl-save').addEventListener('click', () => save(true));
    $('spl-off')?.addEventListener('click', () => { if (confirm('Turn the split off? Players will stop seeing their share. Your ledger is kept and you can turn it back on.')) save(false); });
  }

  // Re-render only the result box while typing so the input keeps focus.
  function refreshResult() {
    const active = document.activeElement, id = active && active.id, pos = active && active.selectionStart;
    renderSetup();
    if (id && $(id)) { $(id).focus(); try { $(id).setSelectionRange(pos, pos); } catch {} }
  }

  async function save(enabled) {
    const dr = S.draft, btn = $('spl-save');
    if (btn) btn.disabled = true;
    try {
      S.data = await api(API, { action: 'save', enabled, mode: dr.mode, amount: dr.amount, rate: dr.rate, collect: dr.collect, venmoHandle: dr.venmoHandle });
      S.editing = false; S.draft = null;
      setMsg('ok', enabled ? 'Saved. Email everyone their share when you’re ready.' : 'Split turned off.');
      render();
    } catch (e) { setMsg('err', e.message); renderSetup(); }
  }

  // ════════ LEDGER ════════
  function rowDetail(r, L) {
    if (r.self) return 'You · your share is covered';
    if (L.mode === 'pergame') return `${r.games} game${r.games === 1 ? '' : 's'} × ${fmt(S.data.config.rateCents)} = ${fmt(r.owedCents)}` + (r.paidCents ? ` · paid ${fmt(r.paidCents)}` : '');
    if (r.status === 'claim') return `Says they paid ${fmt(r.claim.cents)} · ${shortDate(r.claim.at)}`;
    if (r.paidCents && r.balanceCents > 0) return `Paid ${fmt(r.paidCents)} of ${fmt(r.owedCents)}`;
    if (r.status === 'paid') return 'Settled';
    return (r.overrideCents != null ? 'Custom share' : 'Even share') + (r.lastNudgedOn ? ` · reminded ${shortDate(r.lastNudgedOn + 'T12:00:00')}` : '') + (r.archived ? ' · left the team' : '');
  }

  function pillHtml(r) {
    if (r.self) return `<span class="spl-pill self">You</span>`;
    if (r.status === 'claim') return `<button class="spl-pill claim" data-act="confirm-claim" data-p="${esc(r.playerId)}">Confirm ${fmt(r.claim.cents)}</button><button class="spl-x" title="Not received" data-act="dismiss-claim" data-p="${esc(r.playerId)}">✕</button>`;
    if (r.status === 'owes') return `<button class="spl-pill owes" data-act="pay" data-p="${esc(r.playerId)}">Mark paid</button>`;
    if (r.status === 'paid') return `<span class="spl-pill paid">${r.balanceCents < 0 ? 'Credit ' + fmt(-r.balanceCents) : 'Paid ✓'}</span>`;
    return `<span class="spl-pill none">Nothing yet</span>`;
  }

  function drawerHtml(r, L) {
    if (r.self) return '';
    const pid = esc(r.playerId);
    const weeks = L.mode === 'pergame' && r.weeks.length
      ? `<h4>Their tab</h4>` + r.weeks.map(w => `<div class="spl-kv"><span>Week ${esc(w.week)}${w.phase ? ' · ' + esc(w.phase) : ''} · ${w.games} game${w.games === 1 ? '' : 's'}</span><span>${fmt(w.cents)}</span></div>`).join('') : '';
    const pays = r.payments.length
      ? `<h4>Payments recorded</h4>` + r.payments.map(p => `<div class="spl-kv"><span>${shortDate(p.at)} · ${esc(p.method)}${p.note ? ' · ' + esc(p.note) : ''} <button class="spl-link red" data-act="undo-pay" data-p="${pid}" data-pay="${esc(p.id)}">undo</button></span><span>${fmt(p.cents)}</span></div>`).join('') : '';
    const record = `<h4>Record a payment</h4><div class="spl-mini">
        <input id="spl-amt-${pid}" inputmode="decimal" placeholder="${r.balanceCents > 0 ? dollars(r.balanceCents) : '0.00'}" aria-label="Amount paid">
        <select id="spl-mth-${pid}" aria-label="How they paid"><option value="venmo">Venmo</option><option value="cash">Cash</option><option value="zelle">Zelle</option><option value="other">Other</option></select>
        <button class="cap-btn cap-btn--ghost" data-act="pay-custom" data-p="${pid}">Record</button></div>`;
    const override = L.mode === 'flat' ? `<h4>Custom share</h4><div class="spl-mini">
        <input id="spl-ovr-${pid}" inputmode="decimal" placeholder="even share" value="${r.overrideCents != null ? dollars(r.overrideCents) : ''}" aria-label="Custom share">
        <button class="cap-btn cap-btn--ghost" data-act="override" data-p="${pid}">Set</button>
        ${r.overrideCents != null ? `<button class="spl-link" data-act="override-clear" data-p="${pid}">back to even</button>` : ''}</div>
        <p class="spl-hint">A sub who pays less, or 0 to leave someone out. Everyone else's share rebalances to the cent.</p>` : '';
    const nudge = r.balanceCents > 0 ? `<h4>Reminder</h4>${r.hasEmail ? `<button class="cap-btn cap-btn--ghost" data-act="nudge-one" data-p="${pid}">Email ${esc(r.name.split(' ')[0])} a reminder</button>` : '<span>No email on file for this player.</span>'}` : '';
    return `<div class="spl-drawer"><div class="spl-kv"><span>Owes in total</span><span>${fmt(r.owedCents)}</span></div><div class="spl-kv"><span>Paid</span><span>${fmt(r.paidCents)}</span></div><div class="spl-kv"><span>Balance</span><span>${fmt(r.balanceCents)}</span></div>${weeks}${pays}${record}${override}${nudge}</div>`;
  }

  function renderLedger() {
    const d = S.data, cfg = d.config, L = d.ledger, T = L.totals;
    const pct = T.totalCents ? Math.round(T.collectedCents / T.totalCents * 100) : 0;
    const flat = L.mode === 'flat';
    const want = (r) => S.filter === 'all' || (S.filter === 'owes' && r.balanceCents > 0 && r.status !== 'claim') || (S.filter === 'claim' && r.status === 'claim') || (S.filter === 'paid' && (r.status === 'paid' || r.self));
    const rows = L.rows.filter(want);
    const count = (f) => L.rows.filter(r => f === 'owes' ? (r.balanceCents > 0 && r.status !== 'claim') : f === 'claim' ? r.status === 'claim' : (r.status === 'paid' || r.self)).length;

    const summary = flat
      ? `<b>${fmt(cfg.amountCents)}</b> split across ${L.rows.length} player${L.rows.length === 1 ? '' : 's'}`
      : `<b>${fmt(cfg.rateCents)}</b> a game · ${T.gamesBilled} game${T.gamesBilled === 1 ? '' : 's'} billed so far`;
    const lockNote = !flat ? ''
      : cfg.lockedAt
        ? `<div class="spl-note"><span>🔒</span><div><b>Shares locked</b> ${shortDate(cfg.lockedAt)}${cfg.lockedBy === 'roster-lock' ? ' when your roster locked' : ''}. Roster changes no longer move anyone's share. <button class="spl-link" data-act="unlock">${d.rosterLocked ? 'Re-sync to current roster' : 'Unlock'}</button></div></div>`
        : `<div class="spl-note"><span>🔓</span><div><b>Shares still follow your roster.</b> They freeze when your roster locks after Week 2. <button class="spl-link" data-act="lock">Lock shares now</button></div></div>`;
    const gap = L.unassignedCents > 0 ? `<div class="spl-msg err">${fmt(L.unassignedCents)} of the amount isn't assigned to anyone — every player has a custom share and they don't add up. Clear one to fix it.</div>` : '';

    $('split-area').innerHTML = `
      <div class="spl-head"><span>${summary}${cfg.venmoHandle ? ' · @' + esc(cfg.venmoHandle) : ''}</span><button class="spl-link" id="spl-edit">Edit split</button></div>
      <div class="spl-prog"><i style="width:${pct}%"></i></div>
      <div class="spl-progrow"><span><b style="color:var(--color-lime)">${fmt(T.collectedCents)}</b> collected</span><span><b>${fmt(T.outstandingCents)}</b> outstanding</span></div>
      ${lockNote}${gap}
      <div class="spl-filters" id="spl-filters">
        <button data-f="all" class="${S.filter === 'all' ? 'on' : ''}">All ${L.rows.length}</button>
        <button data-f="owes" class="${S.filter === 'owes' ? 'on' : ''}">Owes ${count('owes')}</button>
        <button data-f="claim" class="${S.filter === 'claim' ? 'on' : ''}">Says paid ${count('claim')}</button>
        <button data-f="paid" class="${S.filter === 'paid' ? 'on' : ''}">Paid ${count('paid')}</button>
      </div>
      <div id="spl-rows">${rows.map(r => `
        <div class="spl-row">
          <div class="spl-row__top" data-open="${esc(r.playerId)}">
            <div class="spl-av">${esc(initials(r.name))}</div>
            <div class="spl-row__m"><div class="spl-row__n">${esc(r.name)}${r.isSub ? ' <span style="color:var(--color-text-faint);font-weight:600">· sub</span>' : ''}</div><div class="spl-row__d">${esc(rowDetail(r, L))}</div></div>
            <div class="spl-row__amt">${fmt(r.status === 'paid' || r.self ? r.owedCents : Math.max(0, r.balanceCents))}</div>
            ${pillHtml(r)}
          </div>
          ${S.open === r.playerId ? drawerHtml(r, L) : ''}
        </div>`).join('') || '<div class="empty-state" style="padding:24px 0">Nobody here.</div>'}</div>
      <div class="spl-actions">
        <button class="cap-btn cap-btn--primary" data-act="announce">${cfg.announcedAt ? 'Re-send everyone their share' : 'Email everyone their share'}</button>
        <button class="cap-btn cap-btn--ghost" data-act="nudge-all">Nudge everyone unpaid</button>
      </div>
      <p class="spl-hint" style="text-align:center">Tap a player for payments, a custom amount${flat ? ', a custom share' : ''} or a reminder. Only you and your co-captain see this list — each player sees just their own share.</p>
      ${msgHtml()}`;

    $('spl-edit').addEventListener('click', () => { S.editing = true; S.draft = null; setMsg(); render(); });
    $('spl-filters').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { S.filter = b.dataset.f; renderLedger(); }));
    $('split-area').querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', (e) => {
      if (e.target.closest('[data-act]')) return;
      S.open = S.open === el.dataset.open ? null : el.dataset.open; renderLedger();
    }));
    $('split-area').querySelectorAll('[data-act]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); act(el); }));
  }

  async function act(el) {
    const a = el.dataset.act, pid = el.dataset.p;
    el.disabled = true;
    try {
      if (a === 'announce' || a === 'nudge-all' || a === 'nudge-one') {
        const r = await api(NOTIFY, { kind: a === 'announce' ? 'announce' : 'nudge', playerId: a === 'nudge-one' ? pid : undefined });
        const bits = [`Emailed ${r.sent} player${r.sent === 1 ? '' : 's'}`];
        if (r.nothingOwed) bits[0] = 'Nobody owes anything right now';
        if (r.skipped) bits.push(`${r.skipped} already reminded today`);
        if (r.noEmail) bits.push(`${r.noEmail} with no email on file`);
        if (r.failed && r.failed.length) bits.push(`couldn't reach ${r.failed.join(', ')}`);
        S.data = await api(API);
        setMsg(r.failed && r.failed.length ? 'err' : 'ok', bits.join(' · ') + '.');
      } else if (a === 'pay-custom') {
        S.data = await api(API, { action: 'pay', playerId: pid, amount: $('spl-amt-' + pid).value || null, method: $('spl-mth-' + pid).value });
        setMsg();
      } else if (a === 'override' || a === 'override-clear') {
        S.data = await api(API, { action: 'override', playerId: pid, amount: a === 'override' ? $('spl-ovr-' + pid).value : null });
        setMsg();
      } else if (a === 'undo-pay') {
        S.data = await api(API, { action: 'undo-pay', playerId: pid, paymentId: el.dataset.pay });
        setMsg();
      } else {
        S.data = await api(API, { action: a, playerId: pid });
        setMsg();
      }
    } catch (e) { setMsg('err', e.message); }
    render();
  }

  function render() {
    if (!$('split-area')) return;
    const d = S.data;
    if (!d) return;
    const sub = $('split-sub');
    if (S.editing || !d.config || !d.config.enabled || !d.ledger) {
      if (sub) sub.textContent = 'Work out what each player owes you';
      S.editing = true;
      renderSetup();
    } else {
      if (sub) sub.textContent = d.ledger.mode === 'flat' ? 'Flat split' : 'Per game';
      renderLedger();
    }
  }

  async function load() {
    const area = $('split-area');
    if (!area) return;
    injectCss();
    if (!S.data) area.innerHTML = '<div class="empty-state">Loading&hellip;</div>';
    try {
      S.data = await api(API);
      S.editing = false;
      render();
    } catch (e) {
      area.innerHTML = '<div class="empty-state">Could not load the team split.</div>';
    }
  }

  window.DSSplit = { load };
})();
