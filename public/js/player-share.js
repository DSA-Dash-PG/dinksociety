// public/js/player-share.js
// Player Portal → "Your team share" card. A player sees ONLY their own balance
// with their captain, plus how to pay it. Renders into #ds-share-slot (me.html
// re-creates that slot on every home render, so mount() is cheap and cached).
(function () {
  'use strict';
  const API = '/.netlify/functions/player-team-share';
  let cache = null, inflight = null, open = false, busy = false, err = '';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (c) => {
    const n = Math.round(Number(c) || 0), a = Math.abs(n), cents = a % 100;
    return (n < 0 ? '-' : '') + '$' + Math.floor(a / 100).toLocaleString('en-US') + (cents ? '.' + String(cents).padStart(2, '0') : '');
  };
  const shortDate = (iso) => { try { return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }); } catch { return ''; } };

  function css() {
    if (document.getElementById('shr-css')) return;
    const st = document.createElement('style');
    st.id = 'shr-css';
    st.textContent = `
      .shr{background:var(--color-surface);border:1px solid var(--color-border);border-radius:16px;padding:16px;margin:0 0 14px}
      .shr--due{border-color:rgba(184,255,44,.3)}
      .shr__h{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
      .shr__t{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}
      .shr__s{font-size:11px;color:var(--color-text-faint)}
      .shr__big{font-size:38px;font-weight:800;line-height:1;text-align:center;margin:14px 0 6px}
      .shr__to{font-size:12px;color:var(--color-text-muted);text-align:center;line-height:1.5}
      .shr__to b{color:var(--color-text)}
      .shr__btn{display:block;width:100%;box-sizing:border-box;text-align:center;text-decoration:none;border:none;border-radius:9999px;font:inherit;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;padding:13px;margin-top:12px;cursor:pointer}
      .shr__btn--venmo{background:#008cff;color:#fff}
      .shr__btn--ghost{background:none;border:1px solid var(--color-border-strong);color:var(--color-text)}
      .shr__btn:disabled{opacity:.5}
      .shr__note{font-size:11px;color:var(--color-text-faint);text-align:center;line-height:1.5;margin-top:10px}
      .shr__claim{background:var(--color-gold-dim);border:1px solid rgba(240,192,64,.3);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--color-text-muted);line-height:1.5;margin-top:12px;text-align:center}
      .shr__claim b{color:var(--color-gold)}
      .shr__more{display:block;margin:12px auto 0;background:none;border:none;font:inherit;font-size:11px;font-weight:700;color:var(--color-teal);cursor:pointer}
      .shr__kv{display:flex;justify-content:space-between;font-size:12px;color:var(--color-text-muted);padding:5px 0}
      .shr__kv span:last-child{color:var(--color-text);font-weight:700}
      .shr__kv.tot{border-top:1px solid var(--color-border);margin-top:4px;padding-top:9px}
      .shr__ok{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--color-text-muted)}
      .shr__ok b{color:var(--color-lime)}
      .shr__err{font-size:12px;color:var(--color-red);text-align:center;margin-top:8px}
    `;
    document.head.appendChild(st);
  }

  function detailHtml(d) {
    const s = d.share;
    const buy = s.buyInCents || 0;
    const weeks = s.mode === 'pergame'
      ? (buy ? `<div class="shr__kv"><span>Buy-in to be on the team</span><span>${fmt(buy)}</span></div>` : '') + s.weeks.map(w => `<div class="shr__kv"><span>Week ${esc(w.week)}${w.phase ? ' · ' + esc(w.phase) : ''} · ${w.games} game${w.games === 1 ? '' : 's'}${w.pricing === 'week' ? ' · flat' : ' × ' + fmt(w.rateCents)}</span><span>${fmt(w.cents)}</span></div>`).join('')
        + `<div class="shr__kv tot"><span>${s.playerRate?.mode === 'week' ? 'Your price · ' + fmt(s.playerRate.cents) + ' a week' : 'Games · ' + s.games}</span><span>${fmt(s.usedCents)}</span></div>`
        + (buy ? `<div class="shr__kv"><span>${s.buyInLeftCents > 0 ? 'Buy-in still unused' : 'Buy-in used up — now per game'}</span><span>${s.buyInLeftCents > 0 ? fmt(s.buyInLeftCents) : '✓'}</span></div><div class="shr__kv tot"><span>Your total so far</span><span>${fmt(s.owedCents)}</span></div>` : '')
      : `<div class="shr__kv"><span>Your share of the team amount</span><span>${fmt(s.owedCents)}</span></div>`;
    const pays = s.payments.map(p => `<div class="shr__kv"><span>Paid ${shortDate(p.at)} · ${esc(p.method)}</span><span style="color:var(--color-lime)">−${fmt(p.cents)}</span></div>`).join('');
    return `<div style="margin-top:12px">${weeks}${pays}<div class="shr__kv tot"><span>You owe</span><span>${fmt(Math.max(0, s.balanceCents))}</span></div></div>`;
  }

  function html(d) {
    const s = d.share, to = d.payTo;
    if (s.self) return '';                                    // the captain is the payee
    if (s.owedCents <= 0 && s.paidCents <= 0) return '';      // nothing billed yet
    const sub = `${esc(d.teamName || 'Your team')}${s.mode === 'pergame' ? ' · ' + (s.playerRate ? fmt(s.playerRate.cents) + (s.playerRate.mode === 'week' ? ' a week' : ' a game') : fmt(d.rateCents) + ' a game') + (s.buyInCents ? ' · ' + fmt(s.buyInCents) + ' buy-in' : '') : ''}`;
    if (s.balanceCents <= 0) {
      return `<div class="shr" id="share"><div class="shr__ok"><span>✅</span><span><b>You're settled with ${esc(to.name)}.</b> ${fmt(s.paidCents)} paid${s.balanceCents < 0 ? ' · ' + fmt(-s.balanceCents) + ' credit toward future games' : ''}.</span></div></div>`;
    }
    const owe = fmt(s.balanceCents);
    return `<div class="shr shr--due" id="share">
      <div class="shr__h"><span class="shr__t">Your team share</span><span class="shr__s">${sub}</span></div>
      <div class="shr__big">${owe}</div>
      <div class="shr__to">to your captain <b>${esc(to.name)}</b>${to.venmoHandle ? ' · @' + esc(to.venmoHandle) : ''}</div>
      ${s.claim
        ? `<div class="shr__claim"><b>Waiting on ${esc(to.name.split(' ')[0])} to confirm.</b> You said you paid ${fmt(s.claim.cents)} on ${shortDate(s.claim.at)}. <button class="shr__more" style="display:inline;margin:0" data-share="unclaim">Undo</button></div>`
        : `${to.venmoUrl ? `<a class="shr__btn shr__btn--venmo" href="${esc(to.venmoUrl)}" target="_blank" rel="noopener">Pay ${owe} on Venmo</a>` : ''}
           <button class="shr__btn shr__btn--ghost" data-share="claim" ${busy ? 'disabled' : ''}>I paid</button>
           <div class="shr__note">${to.venmoUrl ? `Venmo opens ${esc(to.name.split(' ')[0])}'s profile — enter ${owe}. Then tap “I paid” so they know to look.` : `Pay ${esc(to.name.split(' ')[0])} however you two usually do, then tap “I paid”.`}</div>`}
      ${err ? `<div class="shr__err">${esc(err)}</div>` : ''}
      <button class="shr__more" data-share="toggle">${open ? 'Hide the breakdown ▲' : 'How this was worked out ▼'}</button>
      ${open ? detailHtml(d) : ''}
    </div>`;
  }

  function paint() {
    const slot = document.getElementById('ds-share-slot');
    if (!slot) return;
    if (!cache || !cache.active) { slot.innerHTML = ''; return; }
    css();
    slot.innerHTML = html(cache);
    slot.querySelectorAll('[data-share]').forEach(el => el.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const a = el.dataset.share;
      if (a === 'toggle') { open = !open; paint(); return; }
      post(a);
    }));
    if (location.hash === '#share' && !paint.scrolled) {
      const card = document.getElementById('share');
      if (card) { paint.scrolled = true; setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250); }
    }
  }

  async function post(action) {
    if (busy) return;
    busy = true; err = ''; paint();
    try {
      const res = await fetch(API, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong — try again.');
      cache = data;
    } catch (e) { err = e.message; }
    busy = false; paint();
  }

  function mount() {
    if (cache) { paint(); return; }
    if (inflight) return;
    inflight = fetch(API, { credentials: 'include' })
      .then(r => r.ok ? r.json() : { active: false })
      .then(d => { cache = d; paint(); })
      .catch(() => { cache = { active: false }; })
      .finally(() => { inflight = null; });
  }

  window.DSShare = { mount, refresh() { cache = null; mount(); } };
})();
