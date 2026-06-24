// public/js/universal-search.js
// Shared universal search (players + teams) for The Dink Society.
// Self-contained: injects its own styles + overlay markup, builds a search index
// from the public endpoints on first open (cached), and opens as a centered
// palette on desktop / a bottom sheet on mobile.
//
// Use on any page:
//   1. <script src="/js/universal-search.js"></script>
//   2. add a trigger with id="ds-srch-open" or attribute [data-ds-search]
//      (or call window.dsSearch.open() yourself)
// The nav partial loads this automatically; me.html / captain.html include it
// directly. No external CSS required (works on shared.css and local themes).
(function () {
  'use strict';
  if (window.dsSearch) return;

  function injectStyles() {
    if (document.getElementById('ds-srch-styles')) return;
    var css = `
.ds-srch-trigger{display:inline-flex;align-items:center;gap:9px;height:40px;padding:0 14px;border-radius:9999px;border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text-muted);font:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:all var(--transition,.2s);max-width:230px}
.ds-srch-trigger:hover{color:var(--color-text);border-color:var(--color-border-strong,rgba(255,255,255,.18))}
.ds-srch-trigger svg{width:15px;height:15px;flex:none}
.ds-srch-trigger .ds-srch-tx{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ds-srch-trigger .ds-srch-k{font-size:10px;font-weight:700;border:1px solid var(--color-border);border-radius:5px;padding:1px 5px;color:var(--color-text-faint)}
.ds-srch{position:fixed;inset:0;z-index:1000;display:none}
.ds-srch.is-open{display:block}
.ds-srch-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(2px)}
.ds-srch-panel{position:absolute;left:50%;top:72px;transform:translateX(-50%);width:min(620px,calc(100% - 28px));background:var(--color-surface);border:1px solid var(--color-border-strong,#333);border-radius:16px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.5);display:flex;flex-direction:column;max-height:74vh}
.ds-srch-grip{display:none}
.ds-srch-bar{display:flex;align-items:center;gap:11px;padding:14px 16px;border-bottom:1px solid var(--color-border)}
.ds-srch-bar svg{width:18px;height:18px;flex:none;color:var(--color-text-faint)}
.ds-srch-bar input{flex:1;background:none;border:0;outline:0;color:var(--color-text);font:inherit;font-size:16px}
.ds-srch-bar input::placeholder{color:var(--color-text-faint)}
.ds-srch-cancel{background:none;border:0;color:var(--color-text-faint);font:inherit;font-size:13px;font-weight:600;cursor:pointer;padding:4px 6px}
.ds-srch-cancel:hover{color:var(--color-text)}
.ds-srch-scopes{display:flex;gap:7px;padding:10px 14px;border-bottom:1px solid var(--color-border)}
.ds-srch-scope{font:inherit;font-size:11.5px;font-weight:700;border:1px solid var(--color-border);background:transparent;border-radius:9999px;padding:4px 12px;color:var(--color-text-muted);cursor:pointer}
.ds-srch-scope.is-on{background:var(--color-lime-dim,rgba(184,255,44,.12));border-color:rgba(184,255,44,.4);color:var(--color-lime)}
.ds-srch-results{overflow-y:auto;padding:6px 6px 10px}
.ds-srch-grp{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.09em;color:var(--color-text-faint);padding:11px 12px 5px}
.ds-srch-row{display:flex;align-items:center;gap:11px;padding:9px 12px;border-radius:11px;cursor:pointer}
.ds-srch-row.is-sel{background:var(--color-surface-2)}
.ds-srch-av{width:36px;height:36px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#06231d}
.ds-srch-tav{width:36px;height:36px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;font-size:18px;background:var(--color-surface-2)}
.ds-srch-bd{flex:1;min-width:0}
.ds-srch-nm{font-size:14.5px;font-weight:700;color:var(--color-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ds-srch-nm mark{background:rgba(184,255,44,.22);color:var(--color-lime);border-radius:3px;padding:0 1px}
.ds-srch-sub{font-size:11.5px;color:var(--color-text-faint);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ds-srch-sub .cp{color:var(--color-lime);font-weight:700}
.ds-srch-dsr{font-size:15px;font-weight:800;color:var(--color-lime);flex:none;font-variant-numeric:tabular-nums}
.ds-srch-dsr.teal{color:var(--color-teal)}
.ds-srch-dsr small{font-size:8px;color:var(--color-text-faint);font-weight:700}
.ds-srch-rank{font-size:10px;font-weight:800;color:var(--color-text-muted);background:var(--color-surface-2);border:1px solid var(--color-border);border-radius:9999px;padding:3px 7px;flex:none;margin-left:8px}
.ds-srch-empty{padding:30px 18px;text-align:center;color:var(--color-text-faint);font-size:13px;line-height:1.6}
.ds-srch-empty .big{font-size:14px;color:var(--color-text-muted);margin-bottom:3px}
.ds-srch-foot{display:flex;gap:14px;border-top:1px solid var(--color-border);padding:9px 16px;font-size:11px;color:var(--color-text-faint);font-weight:600}
.ds-srch-foot kbd{font:inherit;font-size:10px;border:1px solid var(--color-border);border-radius:5px;padding:1px 5px}
@media (max-width:900px){
.ds-srch-trigger{width:40px;height:40px;max-width:none;padding:0;justify-content:center;border-radius:var(--radius-sm,10px)}
.ds-srch-trigger .ds-srch-tx,.ds-srch-trigger .ds-srch-k{display:none}
.ds-srch-panel{left:0;right:0;bottom:0;top:auto;transform:none;width:100%;max-width:none;border-radius:18px 18px 0 0;max-height:86vh;animation:dsSrchUp .2s ease}
.ds-srch-grip{display:block;width:38px;height:4px;background:var(--color-border-strong,#3a3a3a);border-radius:9999px;margin:8px auto 2px}
.ds-srch-foot{display:none}
}
@keyframes dsSrchUp{from{transform:translateY(26px)}to{transform:none}}`;
    var st = document.createElement('style');
    st.id = 'ds-srch-styles';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  function injectOverlay() {
    var existing = document.getElementById('ds-srch');
    if (existing) return existing;
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<div class="ds-srch" id="ds-srch" aria-hidden="true">' +
        '<div class="ds-srch-backdrop" data-srch-close></div>' +
        '<div class="ds-srch-panel" role="dialog" aria-label="Search players and teams" aria-modal="true">' +
          '<div class="ds-srch-grip"></div>' +
          '<div class="ds-srch-bar">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
            '<input id="ds-srch-input" type="text" placeholder="Search players, teams…" autocomplete="off" spellcheck="false" />' +
            '<button class="ds-srch-cancel" type="button" data-srch-close>Cancel</button>' +
          '</div>' +
          '<div class="ds-srch-scopes" id="ds-srch-scopes">' +
            '<button class="ds-srch-scope is-on" type="button" data-scope="all">All</button>' +
            '<button class="ds-srch-scope" type="button" data-scope="players">Players</button>' +
            '<button class="ds-srch-scope" type="button" data-scope="teams">Teams</button>' +
          '</div>' +
          '<div class="ds-srch-results" id="ds-srch-results"></div>' +
          '<div class="ds-srch-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>' +
        '</div>' +
      '</div>';
    var node = wrap.firstChild;
    document.body.appendChild(node);
    return node;
  }

  var overlay, input, resEl, scopesEl;
  var SEASON, SUF, idx = null, loading = null, SCOPE = 'all', SEL = 0, FLAT = [];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function slugify(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function initials(n) { var p = String(n || '').trim().split(/\s+/); return ((p[0] && p[0][0] || '') + (p[1] && p[1][0] || '')).toUpperCase() || '·'; }
  function color(n) { var h = 0, s = String(n || ''); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; var c = ['#b8ff2c', '#17d7b0', '#f0c040', '#ff6fb5', '#3b9eff', '#a78bfa']; return c[h % c.length]; }
  function teamEmoji(n) { return (idx && idx.emojiBy[n]) || '🏓'; }

  function load() {
    if (idx) return Promise.resolve(idx);
    if (loading) return loading;
    loading = Promise.all([
      fetch('/.netlify/functions/public-leaderboard?view=players' + SUF).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetch('/.netlify/functions/public-teams?season=' + encodeURIComponent(SEASON)).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    ]).then(function (res) {
      var pj = res[0], tj = res[1], teams = (tj && tj.teams) || [];
      var emojiBy = {}, capBy = {};
      teams.forEach(function (t) { emojiBy[t.name] = t.emoji || '🏓'; capBy[t.name] = t.captain || ((t.roster || []).find(function (r) { return r.isCaptain; }) || {}).name || ''; });
      var raw = (pj && (pj.players || pj.rows || pj)) || [];
      var arr = Array.isArray(raw) ? raw : Object.keys(raw || {}).map(function (k) { return raw[k]; });
      var players = arr.map(function (p) {
        return { name: p.name, team: p.teamName, gender: p.gender, dsr: (p.composite != null ? Number(p.composite) : (p.dsr != null ? Number(p.dsr) : null)), cap: (capBy[p.teamName] === p.name) };
      }).filter(function (p) { return p.name && p.team; });
      players.filter(function (p) { return p.dsr != null; }).sort(function (a, b) { return b.dsr - a.dsr; }).forEach(function (p, i) { p.rank = i + 1; });
      idx = { players: players, teams: teams.map(function (t) { return { name: t.name, emoji: emojiBy[t.name], cap: capBy[t.name], players: (t.roster || []).length }; }), emojiBy: emojiBy };
      return idx;
    });
    return loading;
  }

  function score(name, q) { name = name.toLowerCase(); var parts = name.split(/\s+/); if (name === q) return 100; if (name.indexOf(q) === 0) return 80; if (parts.some(function (p) { return p.indexOf(q) === 0; })) return 65; if (name.indexOf(q) >= 0) return 40; return 0; }
  function hl(name, q) { q = (q || '').trim(); if (!q) return esc(name); var i = name.toLowerCase().indexOf(q.toLowerCase()); if (i < 0) return esc(name); return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length)); }
  function search(q) {
    q = (q || '').trim().toLowerCase(); var players = [], teams = [];
    if (!idx) return { players: [], teams: [] };
    if (!q) { if (SCOPE !== 'teams') players = idx.players.filter(function (p) { return p.dsr != null; }).slice(0, 6); if (SCOPE !== 'players') teams = idx.teams.slice(0, 6); return { players: players, teams: teams, sug: true }; }
    if (SCOPE !== 'teams') players = idx.players.map(function (p) { return { p: p, s: score(p.name, q) }; }).filter(function (x) { return x.s > 0; }).sort(function (a, b) { return b.s - a.s || ((b.p.dsr || 0) - (a.p.dsr || 0)); }).slice(0, 8).map(function (x) { return x.p; });
    if (SCOPE !== 'players') teams = idx.teams.map(function (t) { return { t: t, s: score(t.name, q) }; }).filter(function (x) { return x.s > 0; }).sort(function (a, b) { return b.s - a.s; }).slice(0, 4).map(function (x) { return x.t; });
    return { players: players, teams: teams, sug: false };
  }

  function render() {
    if (!idx) { resEl.innerHTML = '<div class="ds-srch-empty">Loading…</div>'; return; }
    var q = input.value, r = search(q), html = '', flat = [];
    if (!r.players.length && !r.teams.length) { resEl.innerHTML = '<div class="ds-srch-empty"><div class="big">No matches for “' + esc(q) + '”</div>Try a first name, last name, or team.</div>'; FLAT = []; return; }
    if (r.players.length) {
      html += '<div class="ds-srch-grp">' + (r.sug ? 'Top players' : 'Players') + '</div>';
      r.players.forEach(function (p) {
        var i = flat.length; flat.push({ kind: 'player', item: p });
        var g = p.gender === 'F' ? "Women's" : p.gender === 'M' ? "Men's" : '';
        html += '<div class="ds-srch-row" data-i="' + i + '">' +
          '<div class="ds-srch-av" style="background:' + color(p.team) + '">' + esc(initials(p.name)) + '</div>' +
          '<div class="ds-srch-bd"><div class="ds-srch-nm">' + hl(p.name, q) + '</div><div class="ds-srch-sub">' + teamEmoji(p.team) + ' ' + esc(p.team) + (g ? ' · ' + g : '') + (p.cap ? ' · <span class="cp">Captain</span>' : '') + '</div></div>' +
          (p.dsr != null ? '<div class="ds-srch-dsr' + (p.gender === 'F' ? ' teal' : '') + '">' + p.dsr.toFixed(1) + ' <small>DSR</small></div>' : '') +
          (p.rank != null ? '<div class="ds-srch-rank">#' + p.rank + '</div>' : '') + '</div>';
      });
    }
    if (r.teams.length) {
      html += '<div class="ds-srch-grp">Teams</div>';
      r.teams.forEach(function (t) {
        var i = flat.length; flat.push({ kind: 'team', item: t });
        html += '<div class="ds-srch-row" data-i="' + i + '">' +
          '<div class="ds-srch-tav">' + esc(t.emoji || '🏓') + '</div>' +
          '<div class="ds-srch-bd"><div class="ds-srch-nm">' + hl(t.name, q) + '</div><div class="ds-srch-sub">' + (t.players ? t.players + ' players' : 'Team') + (t.cap ? ' · Captain ' + esc(t.cap) : '') + '</div></div></div>';
      });
    }
    resEl.innerHTML = html; FLAT = flat; SEL = 0; paint();
    Array.prototype.forEach.call(resEl.querySelectorAll('.ds-srch-row'), function (row) {
      row.addEventListener('mousemove', function () { SEL = +row.dataset.i; paint(); });
      row.addEventListener('click', function () { SEL = +row.dataset.i; go(); });
    });
  }
  function paint() { Array.prototype.forEach.call(resEl.querySelectorAll('.ds-srch-row'), function (row) { var on = (+row.dataset.i === SEL); row.classList.toggle('is-sel', on); if (on) row.scrollIntoView({ block: 'nearest' }); }); }
  function go() { var e = FLAT[SEL]; if (!e) return; location.href = e.kind === 'player' ? '/player?name=' + encodeURIComponent(e.item.name) + '&team=' + slugify(e.item.team) + SUF : '/team?id=' + slugify(e.item.name) + SUF; }

  function open() {
    if (!overlay) return;
    overlay.classList.add('is-open'); overlay.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden';
    input.value = ''; resEl.innerHTML = '<div class="ds-srch-empty">Loading…</div>';
    load().then(function () { if (overlay.classList.contains('is-open')) render(); });
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 40);
  }
  function close() { if (!overlay) return; overlay.classList.remove('is-open'); overlay.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; }

  function init() {
    injectStyles();
    overlay = injectOverlay();
    input = document.getElementById('ds-srch-input');
    resEl = document.getElementById('ds-srch-results');
    scopesEl = document.getElementById('ds-srch-scopes');
    SEASON = new URLSearchParams(location.search).get('season') || 'circuit-i';
    SUF = SEASON === 'circuit-i' ? '' : '&season=' + encodeURIComponent(SEASON);

    input.addEventListener('input', render);
    Array.prototype.forEach.call(overlay.querySelectorAll('[data-srch-close]'), function (c) { c.addEventListener('click', close); });
    scopesEl.addEventListener('click', function (e) { var s = e.target.closest('.ds-srch-scope'); if (!s) return; SCOPE = s.dataset.scope; Array.prototype.forEach.call(scopesEl.querySelectorAll('.ds-srch-scope'), function (x) { x.classList.toggle('is-on', x === s); }); render(); input.focus(); });

    // Any trigger anywhere on the page opens search (delegated, so it works for
    // triggers rendered after this script runs — e.g. the nav partial).
    document.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('#ds-srch-open, [data-ds-search]') : null;
      if (t) { e.preventDefault(); open(); }
    });
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); overlay.classList.contains('is-open') ? close() : open(); return; }
      if (!overlay.classList.contains('is-open')) return;
      if (e.key === 'Escape') { close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (FLAT.length) { SEL = (SEL + 1) % FLAT.length; paint(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (FLAT.length) { SEL = (SEL - 1 + FLAT.length) % FLAT.length; paint(); } }
      else if (e.key === 'Enter') { e.preventDefault(); go(); }
    });
  }

  window.dsSearch = { open: function () { open(); }, close: function () { close(); } };

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
