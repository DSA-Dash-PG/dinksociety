// public/ladder-profile-view.js
// Shared renderer for the rich ladder player profile body, used by player.html,
// me.html, profile.html and ladders.html so every surface stays identical.
//
// window.ladderProfileBody(L) -> HTML string. Layout:
//   KPI grids · XP highlight · Last 10 rounds (value in each bar) ·
//   tabs [ Completed ladders | Court movement ].
// Tabs/expanders are driven by the global handlers below (inline onclick).
// CSS-var fallbacks let it work with both the --surf2/--bd theme (profile/ladders)
// and the --color-* theme (player/me).
(function () {
  var ESC = function (s) { return String(s == null ? '' : s).replace(/[<>&]/g, function (m) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m]; }); };
  var GR = '#9aa094', FA = '#5e655a', LIME = '#b8ff2c', RED = '#ff5c47', TEAL = '#17d7b0', PURP = '#a78bfa', GOLD = '#f0c040';
  function ord(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function dt(s) { if (!s) return ''; var d = new Date(s + 'T12:00:00'); return isNaN(d) ? '' : (d.getMonth() + 1) + '/' + d.getDate(); }
  function courtSvg(mv, h) {
    h = h || 150; var n = mv.length; if (!n) return '';
    var W = 440, pad = 14, maxC = Math.max.apply(null, mv.map(function (m) { return m.court || 1; }).concat([2]));
    var x = function (i) { return pad + (n <= 1 ? 0 : (W - 2 * pad) * i / (n - 1)); };
    var y = function (c) { return h - pad - (h - 2 * pad) * (((c || 1) - 1) / Math.max(1, maxC - 1)); };
    var poly = mv.map(function (m, i) { return x(i).toFixed(1) + ',' + y(m.court).toFixed(1); }).join(' ');
    var dots = mv.map(function (m, i) { var nl = (m.newLadder && i > 0) ? '<line x1="' + x(i).toFixed(1) + '" y1="6" x2="' + x(i).toFixed(1) + '" y2="' + (h - 6) + '" stroke="rgba(255,255,255,.13)" stroke-dasharray="3 3"/>' : ''; return nl + '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(m.court).toFixed(1) + '" r="3.2" fill="' + (m.won ? LIME : RED) + '"/>'; }).join('');
    return '<div style="background:var(--surf2,#151515);border:1px solid var(--bd,rgba(255,255,255,.08));border-radius:11px;padding:9px"><svg viewBox="0 0 ' + W + ' ' + h + '" style="width:100%;height:auto;display:block"><polyline points="' + poly + '" fill="none" stroke="' + TEAL + '" stroke-width="2" vector-effect="non-scaling-stroke"/>' + dots + '</svg><div style="font-size:10px;color:' + GR + ';text-align:right;margin-top:2px">' + n + ' rounds · up = higher court</div></div>';
  }
  function kc(n, l, c) { return '<div style="background:var(--surf2,#151515);border:1px solid var(--bd,rgba(255,255,255,.07));border-radius:10px;padding:9px 4px;text-align:center"><div style="font-size:17px;font-weight:900' + (c ? ';color:' + c : '') + '">' + n + '</div><div style="font-size:9px;font-weight:700;letter-spacing:.05em;color:' + FA + ';text-transform:uppercase;margin-top:3px">' + l + '</div></div>'; }
  function lab(t) { return '<div style="font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:' + FA + ';margin:15px 2px 7px">' + t + '</div>'; }
  var SEQ = 0;

  window.ladderProfileBody = function (L) {
    if (!L) return '';
    var ns = 'ldp' + (++SEQ);
    var sk = L.streak || 0, skS = sk > 0 ? 'W' + sk : sk < 0 ? 'L' + Math.abs(sk) : '–';
    var h = '';
    h += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">' + kc(L.w + '-' + L.l, 'Record') + kc((L.winPct != null ? L.winPct : 0) + '%', 'Win%', LIME) + kc(L.avg != null ? L.avg : '—', 'Avg') + kc('#' + (L.rank || '–'), 'Rank') + '</div>';
    h += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:6px">' + kc(L.pf != null ? L.pf : '—', 'PS') + kc(L.pa != null ? L.pa : '—', 'PA') + kc((L.diff > 0 ? '+' : '') + (L.diff || 0), 'Diff', (L.diff >= 0 ? LIME : RED)) + kc(skS, 'Streak', (sk > 0 ? LIME : sk < 0 ? RED : '')) + '</div>';
    h += '<div style="display:flex;align-items:center;gap:11px;background:rgba(184,255,44,.08);border:1px solid rgba(184,255,44,.3);border-radius:11px;padding:11px 13px;margin-top:10px"><div style="font-size:21px;font-weight:900;color:' + LIME + '">' + (L.xp != null ? L.xp : '—') + '</div><div><div style="font-weight:800;font-size:13px;color:' + LIME + '">XP · ' + (L.xpTier || '—') + '</div><div style="font-size:11px;color:' + GR + '">' + (L.ladders != null ? L.ladders : (L.nights != null ? L.nights : '—')) + ' ladders · ' + (L.podiums || 0) + ' podiums · ' + (L.mvp || 0) + '× top</div></div></div>';
    var last = L.last10 || [];
    if (last.length) {
      var mx = Math.max.apply(null, last.map(function (r) { return Math.abs(r.margin || 0); }).concat([1]));
      var lw = last.filter(function (r) { return r.won; }).length, ll = last.length - lw, net = last.reduce(function (a, r) { return a + (r.margin || 0); }, 0);
      h += lab('Last ' + last.length + ' rounds · point margin');
      h += '<div style="display:flex;gap:4px;align-items:flex-end;height:104px;background:var(--surf2,#151515);border:1px solid var(--bd,rgba(255,255,255,.08));border-radius:11px;padding:10px 8px">' + last.map(function (r) { var m = r.margin || 0; var hp = Math.round(20 + 72 * Math.abs(m) / mx); return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:3px;height:100%"><span style="font-size:9px;font-weight:800;color:' + (r.won ? LIME : RED) + '">' + (m > 0 ? '+' : '') + m + '</span><div style="width:100%;border-radius:3px;height:' + hp + '%;background:' + (r.won ? LIME : RED) + '"></div></div>'; }).join('') + '</div>';
      h += '<div style="font-size:11px;color:' + GR + ';text-align:right;margin-top:4px">' + lw + 'W · ' + ll + 'L · ' + (net > 0 ? '+' : '') + net + ' net</div>';
    }
    h += '<div style="display:flex;gap:5px;background:var(--surf2,#161616);border:1px solid var(--bd,rgba(255,255,255,.08));border-radius:9999px;padding:4px;margin:13px 0 10px">' +
      '<button id="' + ns + '-t-comp" onclick="ladderProfTab(\'' + ns + '\',\'comp\')" style="flex:1;padding:8px;border:0;border-radius:9999px;font:inherit;font-size:12px;font-weight:800;cursor:pointer;background:' + LIME + ';color:#06210f">Completed ladders</button>' +
      '<button id="' + ns + '-t-court" onclick="ladderProfTab(\'' + ns + '\',\'court\')" style="flex:1;padding:8px;border:0;border-radius:9999px;font:inherit;font-size:12px;font-weight:800;cursor:pointer;background:transparent;color:' + GR + '">Court movement</button></div>';
    var per = L.perLadder || [];
    var comp = per.map(function (p, idx) {
      var d = p.courtDelta || 0, an = Math.abs(d);
      var note = d > 0 ? '<span style="color:' + LIME + '">↑ ' + an + ' court' + (an > 1 ? 's' : '') + '</span>' : d < 0 ? '<span style="color:' + RED + '">↓ ' + an + ' court' + (an > 1 ? 's' : '') + '</span>' : '<span style="color:' + GR + '">Same court</span>';
      var dr = p.dr == null ? '–' : p.dr;
      var rounds = (p.rounds || []).map(function (r, i) { return '<div style="display:flex;align-items:center;gap:9px;padding:7px 11px;border-top:1px solid rgba(255,255,255,.05);font-size:12.5px"><span style="width:20px;color:' + FA + ';font-weight:800;font-size:10px">R' + (r.r || i + 1) + '</span><div style="flex:1;min-width:0">w/ ' + ESC(r.partner || '—') + ' <span style="color:' + FA + '">vs ' + ESC((r.opp || []).join(' + ')) + '</span></div><div style="font-weight:800;white-space:nowrap;color:' + (r.won ? LIME : RED) + '">' + r.pf + '<span style="color:' + FA + '">–' + r.pa + '</span></div></div>'; }).join('');
      var bodyId = ns + '-b-' + idx, open = idx === 0;
      var mini = (p.rounds && p.rounds.length > 1) ? '<div style="padding:9px 11px">' + courtSvg(p.rounds.map(function (r) { return { court: r.court, won: r.won }; }), 90) + '</div>' : '';
      return '<div style="background:var(--surf2,#151515);border:1px solid var(--bd,rgba(255,255,255,.08));border-radius:11px;margin-bottom:8px;overflow:hidden"><div onclick="ladderProfExp(\'' + bodyId + '\')" style="display:flex;align-items:center;gap:8px;padding:11px 13px;cursor:pointer"><div style="flex:1;min-width:0"><div style="font-weight:800;font-size:13px">' + ESC(p.name || 'Ladder') + ' <span style="color:' + FA + ';font-weight:600;font-size:11px">' + dt(p.date) + '</span></div><div style="font-size:11px;color:' + GR + ';font-weight:700;margin-top:2px">' + p.w + 'W–' + p.l + 'L' + (p.pts != null ? ' · ' + p.pts + ' pts' : '') + ' · DR ' + dr + (p.xp != null ? ' · ' + p.xp + ' XP' : '') + ' · ' + note + '</div></div><span style="color:' + GR + ';font-size:15px">▾</span></div><div id="' + bodyId + '" style="' + (open ? '' : 'display:none') + '">' + rounds + mini + '</div></div>';
    }).join('');
    h += '<div id="' + ns + '-p-comp">' + (comp || '<div style="color:' + GR + ';font-size:13px;padding:8px 2px">No completed ladders yet.</div>') + '</div>';
    var courtPane = '';
    if ((L.movement || []).length) courtPane += courtSvg(L.movement, 150);
    if (per.length) {
      var maxpts = Math.max.apply(null, per.map(function (p) { return p.pts || 0; }).concat([1]));
      courtPane += lab('Per ladder · pts · place · bonus') + per.map(function (p) { var pct = Math.round((p.pts || 0) / maxpts * 100); return '<div style="display:flex;align-items:center;gap:9px;padding:6px 0"><span style="width:34px;font-size:11px;color:' + GR + ';font-weight:700">' + dt(p.date) + '</span><span style="flex:1;height:9px;border-radius:9999px;background:#1f1f1f;overflow:hidden"><span style="display:block;height:100%;width:' + pct + '%;background:' + LIME + ';border-radius:9999px"></span></span><span style="width:32px;text-align:right;font-weight:800;font-size:12px">' + (p.pts || 0) + '</span><span style="width:28px;text-align:right;font-size:11px;color:' + (p.placeRank === 1 ? GOLD : GR) + ';font-weight:700">' + (p.placeRank ? ord(p.placeRank) : '—') + '</span><span style="width:26px;text-align:right;font-size:11px;color:' + (p.bonus ? LIME : FA) + '">' + (p.bonus ? '+' + p.bonus : '—') + '</span></div>'; }).join('');
    }
    h += '<div id="' + ns + '-p-court" style="display:none">' + (courtPane || '<div style="color:' + GR + ';font-size:13px;padding:8px 2px">No court movement yet.</div>') + '</div>';
    return h;
  };

  window.ladderProfTab = function (ns, t) {
    ['comp', 'court'].forEach(function (k) {
      var p = document.getElementById(ns + '-p-' + k); if (p) p.style.display = (k === t) ? '' : 'none';
      var b = document.getElementById(ns + '-t-' + k); if (b) { b.style.background = (k === t) ? LIME : 'transparent'; b.style.color = (k === t) ? '#06210f' : GR; }
    });
  };
  window.ladderProfExp = function (id) { var b = document.getElementById(id); if (b) b.style.display = b.style.display === 'none' ? '' : 'none'; };
})();
