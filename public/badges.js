// public/badges.js
// Shared player-badge system for The Dink Society — used by player.html,
// me.html, profile.html and the ladder surfaces so every profile stays identical.
//
//   window.dsBadges.summarize(opts) -> { total, counts{}, items[] }
//   window.dsBadges.avatarCrest(opts) -> clip-on crest <span> for a photo (marquee award) | ''
//   window.dsBadges.heroPills(opts)   -> inline pills row HTML (no wrapper)               | ''
//   window.dsBadges.trophyCase(opts)  -> full Trophy Case panel HTML                      | ''  (empty when no wins)
//   window.dsBadges.hasWins(opts)     -> boolean
//
// opts fields (all optional — pass whatever the surface has):
//   awards   : league POTW / Chef array  { week, type:'mens'|'womens', date, dsr, w, l, diff }
//   ladder   : ladder profile object — wins read from ladder.perLadder[] :
//                placeRank===1            -> Ladder Winner   (one per event)
//                w>0 && l===0             -> Undefeated Night (one per event)
//              ladder.maxStreak / opts.maxStreak -> 5+ / 10+ Win Streak milestones
//   grants   : admin-granted awards array, e.g.
//                [{ kind:'champion', label?, date? }, { kind:'improved', type:'mens'|'womens', date? }]
//              (Season Champion + Most Improved are judged season-end, not auto-derived.)
//   name     : player name (Trophy Case header)
//
// Self-contained: injects its own <style> once with --color-* fallbacks so it works on
// both the shared.css theme and me.html's local theme. No external CSS required.
(function () {
  'use strict';
  if (window.dsBadges) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, function (m) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m];
    });
  }
  function fmtDate(iso) {
    if (!iso) return '';
    try {
      var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T12:00:00' : iso);
      return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }
  function uid() { return 'dsbg' + Math.random().toString(36).slice(2, 8); }

  // ── Crest gradient helper ───────────────────────────────────────
  var GRADS = {
    gold:   ['#ffe08a', '#f0c040', '#b8841a'],
    teal:   ['#7af2dc', '#17d7b0', '#0b8e74'],
    lime:   ['#e4ff9e', '#b8ff2c', '#7da516'],
    violet: ['#d8ccff', '#a78bfa', '#6d4fd0'],
    rose:   ['#ffc2dd', '#ff6fb5', '#c83d86'],
    blue:   ['#bfe0ff', '#3b9eff', '#1f6fd0']
  };
  function ring(id, tone, inner) {
    var g = GRADS[tone] || GRADS.gold;
    return '<defs><radialGradient id="' + id + '" cx="50%" cy="38%" r="70%">' +
      '<stop offset="0%" stop-color="' + g[0] + '"/><stop offset="55%" stop-color="' + g[1] + '"/><stop offset="100%" stop-color="' + g[2] + '"/>' +
      '</radialGradient></defs>' +
      '<circle cx="60" cy="60" r="56" fill="#1a1a1a" stroke="url(#' + id + ')" stroke-width="3"/>' +
      '<circle cx="60" cy="60" r="47" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="1.5" stroke-dasharray="2 4"/>' + (inner || '');
  }
  function open(px) { return '<svg viewBox="0 0 120 120" width="' + px + '" height="' + px + '" aria-hidden="true">'; }

  // Admin config state (set via setConfig): custom logo URLs + disabled kinds.
  var LOGOS = {}, DISABLED = {};

  // Crest built from an admin-uploaded logo image, clipped into the tone ring.
  function logoCrest(kind, px, tone, url) {
    var id = uid(), cp = 'cp' + id, g = GRADS[tone] || GRADS.gold;
    return open(px) +
      '<defs><radialGradient id="' + id + '" cx="50%" cy="38%" r="70%">' +
      '<stop offset="0%" stop-color="' + g[0] + '"/><stop offset="55%" stop-color="' + g[1] + '"/><stop offset="100%" stop-color="' + g[2] + '"/>' +
      '</radialGradient><clipPath id="' + cp + '"><circle cx="60" cy="60" r="45"/></clipPath></defs>' +
      '<circle cx="60" cy="60" r="56" fill="#1a1a1a" stroke="url(#' + id + ')" stroke-width="3"/>' +
      '<image href="' + esc(url) + '" x="15" y="15" width="90" height="90" clip-path="url(#' + cp + ')" preserveAspectRatio="xMidYMid slice"/>' +
      '</svg>';
  }

  // ── Per-badge crest art ─────────────────────────────────────────
  function crestSvg(kind, px, tone, type) {
    px = px || 120;
    if (LOGOS[kind]) return logoCrest(kind, px, tone || (DEF[kind] && DEF[kind].tone) || 'gold', LOGOS[kind]);
    var id = uid(), F = 'url(#' + id + ')';
    switch (kind) {
      case 'ladder': {
        // Gendered "KING ME" (men) / "QUEEN ME" (women) — distinct crown per gender.
        var fem = (type === 'womens' || type === 'F' || type === 'f');
        var word = fem ? 'QUEEN' : 'KING';
        var crwn = fem
          ? '<g transform="translate(60 32)" fill="' + F + '"><path d="M-13 5 C-13 -3 -8 -3 -7 1 C-6 -6 -2 -8 0 -8 C2 -8 6 -6 7 1 C8 -3 13 -3 13 5 Z"/><rect x="-13" y="5" width="26" height="3.6" rx="1.6"/><circle cx="0" cy="-10" r="2.3"/></g>'
          : '<g transform="translate(60 32) scale(0.9)" fill="' + F + '"><path d="M-14 6 L-14 -9 L-7 -1 L0 -12 L7 -1 L14 -9 L14 6 Z"/><rect x="-14" y="6" width="28" height="4" rx="1.5"/><circle cx="-14" cy="-11" r="2.1"/><circle cx="0" cy="-14" r="2.4"/><circle cx="14" cy="-11" r="2.1"/></g>';
        return open(px) + ring(id, tone || 'teal',
          crwn +
          '<text x="60" y="66" text-anchor="middle" font-family="Inter,sans-serif" font-weight="900" font-style="italic" font-size="19" fill="' + F + '" letter-spacing="-0.5">' + word + '</text>' +
          '<text x="60" y="88" text-anchor="middle" font-family="Inter,sans-serif" font-weight="900" font-style="italic" font-size="19" fill="' + F + '" letter-spacing="-0.5">ME</text>') + '</svg>';
      }
      case 'champion':
        return open(px) + ring(id, 'gold',
          '<g transform="translate(60 56)" fill="' + F + '">' +
          '<path d="M-18-22 h36 v8 a18 18 0 01-36 0 z"/>' +
          '<path d="M-18-20 h-8 a10 10 0 0010 12" fill="none" stroke="' + F + '" stroke-width="4"/>' +
          '<path d="M18-20 h8 a10 10 0 01-10 12" fill="none" stroke="' + F + '" stroke-width="4"/>' +
          '<rect x="-4" y="-4" width="8" height="12"/><rect x="-12" y="8" width="24" height="6" rx="2"/></g>' +
          '<text x="60" y="98" text-anchor="middle" font-family="Inter,sans-serif" font-weight="900" font-size="11" fill="' + F + '" letter-spacing="1">CHAMPION</text>') + '</svg>';
      case 'undefeated':
        return open(px) + ring(id, 'lime',
          '<path d="M60 32 l22 8 v18 c0 16-12 26-22 30 c-10-4-22-14-22-30 V40 z" fill="none" stroke="' + F + '" stroke-width="3.5"/>' +
          '<path d="M50 60 l7 8 14-16" fill="none" stroke="' + F + '" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>' +
          '<text x="60" y="98" text-anchor="middle" font-family="Inter,sans-serif" font-weight="900" font-size="11" fill="' + F + '" letter-spacing="1">NO LOSSES</text>') + '</svg>';
      case 'streak5':
      case 'streak10':
        var num = kind === 'streak10' ? '10' : '5';
        var tone = kind === 'streak10' ? 'lime' : 'teal';
        var id2 = uid(), F2 = 'url(#' + id2 + ')';
        return open(px) + ring(id2, tone,
          '<path d="M60 30 c10 12 4 18 0 22 c-2-6-8-4-8 2 c-9-5-10-16-2-26 c0 8 6 10 10 2 z" fill="' + F2 + '"/>' +
          '<text x="60" y="74" text-anchor="middle" font-family="Inter,sans-serif" font-weight="900" font-size="30" fill="' + F2 + '">' + num + '</text>' +
          '<text x="60" y="96" text-anchor="middle" font-family="Inter,sans-serif" font-weight="900" font-size="9.5" fill="' + F2 + '" letter-spacing="1.5">WIN STREAK</text>') + '</svg>';
      case 'improved':
        return open(px) + ring(id, 'violet',
          '<g transform="translate(60 58)" fill="none" stroke="' + F + '" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M-16 8 L0 -8 L16 8"/><path d="M-16 22 L0 6 L16 22"/></g>' +
          '<text x="60" y="100" text-anchor="middle" font-family="Inter,sans-serif" font-weight="900" font-size="10" fill="' + F + '" letter-spacing="1">IMPROVED</text>') + '</svg>';
      case 'bestdressed':
        return open(px) + ring(id, tone || 'rose',
          '<path d="M60 34 c0 -5 7 -5 7 0 c0 4 -3.5 4 -3.5 6.5" fill="none" stroke="' + F + '" stroke-width="3" stroke-linecap="round"/>' +
          '<path d="M63.5 40.5 L36 64 a2 2 0 001.3 3.5 h45.4 a2 2 0 001.3 -3.5 Z" fill="none" stroke="' + F + '" stroke-width="3" stroke-linejoin="round"/>' +
          '<text x="60" y="100" text-anchor="middle" font-family="Inter,sans-serif" font-weight="900" font-size="9.5" fill="' + F + '" letter-spacing="1.2">BEST DRESSED</text>') + '</svg>';
      case 'potw':
      default:
        return open(px) + ring(id, 'gold',
          '<g transform="translate(60 34)" fill="' + F + '"><path d="M-14 6 L-14 -6 L-7 0 L0 -10 L7 0 L14 -6 L14 6 Z"/><rect x="-14" y="6" width="28" height="4" rx="1.5"/></g>' +
          '<text x="60" y="72" text-anchor="middle" font-family="Inter,sans-serif" font-weight="900" font-style="italic" font-size="25" fill="' + F + '" letter-spacing="-0.5">K\'CHN</text>' +
          '<text x="60" y="90" text-anchor="middle" font-family="Inter,sans-serif" font-weight="900" font-size="11" fill="' + F + '" letter-spacing="2.5">POTW</text>') + '</svg>';
    }
  }

  // pill icons
  var ICONS = {
    potw: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 9a3 3 0 116 0 3 3 0 01-6 0zm6 0a3 3 0 116 0 3 3 0 01-6 0zM3 7a2 2 0 114 0 2 2 0 01-4 0zM5 13h14v6H5z"/></svg>',
    ladder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M8 3v18M16 3v18M8 7h8M8 12h8M8 17h8"/></svg>',
    champion: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 4h14v3a5 5 0 01-5 5h-4A5 5 0 015 7zM4 5H2v1a4 4 0 004 4M20 5h2v1a4 4 0 01-4 4M9 13h6v4H9zM7 19h10v2H7z"/></svg>',
    undefeated: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    streak5: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2c3 4 1 6-1 8 1-3-2-3-2-1-3-2-3-6 1-9 0 3 2 4 2 2z"/><path d="M12 9c4 2 6 5 6 8a6 6 0 11-12 0c0-2 1-4 3-5 0 2 1 3 2 1 1-1 1-3 1-5z"/></svg>',
    streak10: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2c3 4 1 6-1 8 1-3-2-3-2-1-3-2-3-6 1-9 0 3 2 4 2 2z"/><path d="M12 9c4 2 6 5 6 8a6 6 0 11-12 0c0-2 1-4 3-5 0 2 1 3 2 1 1-1 1-3 1-5z"/></svg>',
    improved: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l5-5 5 5M4 18l5-5 5 5M14 10l3-3 3 3"/></svg>',
    bestdressed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5a2 2 0 112.4 1.96L12 9"/><path d="M12 9 3.6 16a1 1 0 00.6 1.8h15.6a1 1 0 00.6-1.8L12 9z"/></svg>'
  };

  // registry: pill label, color tone, marquee priority (higher = more prestige)
  var DEF = {
    champion:    { label: 'Season Champion', tone: 'gold',   pri: 70 },
    potw:        { label: 'Player of the Week', tone: 'gold', pri: 60 },
    ladder:      { label: 'Ladder Winner',   tone: 'teal',   pri: 50 },
    streak10:    { label: '10+ Win Streak',  tone: 'lime',   pri: 45 },
    improved:    { label: 'Most Improved',   tone: 'violet', pri: 40 },
    undefeated:  { label: 'Undefeated',      tone: 'lime',  pri: 30 },
    bestdressed: { label: 'Best Dressed',    tone: 'rose',   pri: 25 },
    streak5:     { label: '5+ Win Streak',   tone: 'teal',   pri: 20 }
  };

  // ── Build the earned-badge list from whatever data is available ──
  function summarize(opts) {
    opts = opts || {};
    var CS = opts.currentSeason != null ? String(opts.currentSeason) : null;
    // Player gender → 'mens' | 'womens' (drives KING ME / QUEEN ME on the ladder crest).
    var GEN = (function (g) { g = String(g || '').toLowerCase(); return g[0] === 'f' ? 'womens' : g[0] === 'm' ? 'mens' : null; })(opts.gender);
    var items = [];
    // extra: { permanent:bool, season:string } — auto-derived badges default to the current season.
    function push(kind, title, meta, sortDate, extra) {
      extra = extra || {};
      items.push({
        kind: kind, title: title, meta: meta || '', sortDate: sortDate || '',
        permanent: !!extra.permanent,
        type: extra.type || null,
        tone: extra.tone || null,
        // 'league' | 'ladder' — which view a badge belongs to (for the hero crest +
        // pills, which are view-specific). null = show in both views.
        domain: extra.domain || null,
        season: extra.season != null ? String(extra.season) : CS
      });
    }

    // Season Champion + Most Improved — admin-granted (judged season-end).
    // Permanent titles: Season Champion and season-end Most Improved (they headline the avatar forever).
    (Array.isArray(opts.grants) ? opts.grants : []).forEach(function (gr) {
      if (!gr || !DEF[gr.kind]) return;
      // Admin-granted awards are league-side (judged on league play), so they
      // headline the League view. A grant may override with gr.domain.
      var gDomain = gr.domain || 'league';
      if (gr.kind === 'improved') {
        var weekly = gr.scope === 'weekly';
        var scope = weekly ? ('Week ' + (gr.week != null ? gr.week + ' ' : '')) : '';
        var sex = gr.type === 'womens' ? " (Women's)" : gr.type === 'mens' ? " (Men's)" : '';
        push('improved', scope + 'Most Improved' + sex, [gr.label, fmtDate(gr.date)].filter(Boolean).join(' · '), gr.date,
          { permanent: !weekly, season: gr.season, domain: gDomain });
      } else if (gr.kind === 'champion') {
        push('champion', gr.label || 'Season Champion', fmtDate(gr.date), gr.date, { permanent: true, season: gr.season, domain: gDomain });
      } else if (gr.kind === 'bestdressed') {
        // Gendered by colour: men's = blue, women's = rose.
        push('bestdressed', gr.label || 'Best Dressed', fmtDate(gr.date), gr.date,
          { season: gr.season, type: gr.type, tone: gr.type === 'womens' ? 'rose' : 'blue', domain: gDomain });
      } else {
        push(gr.kind, gr.label || DEF[gr.kind].label, fmtDate(gr.date), gr.date, { season: gr.season, domain: gDomain });
      }
    });

    // POTW / Chef of the Week — league-side, one per award.
    (Array.isArray(opts.awards) ? opts.awards : []).forEach(function (a) {
      push('potw', 'Week ' + a.week + ' ' + (a.type === 'womens' ? "Women's" : "Men's") + ' Chef',
        [fmtDate(a.date), (a.w != null ? a.w + 'W–' + a.l + 'L' : ''), (a.diff != null ? (a.diff >= 0 ? '+' : '') + a.diff + ' pt diff' : '')].filter(Boolean).join(' · '), a.date,
        { domain: 'league' });
    });

    // League undefeated — per-week perfect records when supplied, else a season-to-date
    // perfect game record (0 losses). opts.leagueWeeks = [{week,w,l,date}].
    var lw = Array.isArray(opts.leagueWeeks) ? opts.leagueWeeks : null;
    if (lw && lw.length) {
      lw.forEach(function (w) {
        if ((w.w || 0) > 0 && (w.l || 0) === 0) {
          push('undefeated', 'Undefeated · Week ' + w.week,
            [fmtDate(w.date), w.w + '–0'].filter(Boolean).join(' · '), w.date || '', { domain: 'league' });
        }
      });
    } else {
      var lg = opts.league;
      if (lg && (lg.l || 0) === 0 && (lg.w || 0) > 0) {
        push('undefeated', 'Undefeated',
          [lg.w + '–0', 'perfect record'].join(' · '), '', { domain: 'league' });
      }
    }

    // Ladder-derived awards — ladder-side.
    var per = (opts.ladder && Array.isArray(opts.ladder.perLadder)) ? opts.ladder.perLadder : [];
    per.forEach(function (p) {
      if (Number(p.placeRank) === 1) {
        push('ladder', (p.name || 'Ladder Challenge') + ' — Champion',
          [fmtDate(p.date), (p.w != null ? p.w + 'W–' + p.l + 'L' : ''), 'finished #1'].filter(Boolean).join(' · '), p.date,
          { domain: 'ladder', type: GEN });
      }
      if ((p.w || 0) > 0 && (p.l || 0) === 0) {
        push('undefeated', 'Undefeated Night',
          [fmtDate(p.date), (p.name ? esc(p.name) : ''), p.w + '–0'].filter(Boolean).join(' · '), p.date,
          { domain: 'ladder' });
      }
    });

    // Win-streak milestones, tagged by where the streak came from so they show in
    // the right view. (Most surfaces only supply one source.)
    var ladderStreak = Number((opts.ladder && opts.ladder.maxStreak) || 0);
    var leagueStreak = Math.max(Number(opts.leagueStreak || 0), Number(opts.maxStreak || 0));
    if (ladderStreak >= 5) push('streak5', '5+ Win Streak', ladderStreak + ' in a row', '', { domain: 'ladder' });
    if (ladderStreak >= 10) push('streak10', '10+ Win Streak', ladderStreak + ' in a row', '', { domain: 'ladder' });
    if (leagueStreak >= 5) push('streak5', '5+ Win Streak', leagueStreak + ' in a row', '', { domain: 'league' });
    if (leagueStreak >= 10) push('streak10', '10+ Win Streak', leagueStreak + ' in a row', '', { domain: 'league' });

    // drop any badge types the admin has disabled
    items = items.filter(function (it) { return !DISABLED[it.kind]; });

    // newest first; dateless milestones sink to the bottom
    items.sort(function (a, b) { return (b.sortDate || '').localeCompare(a.sortDate || ''); });

    var counts = {};
    items.forEach(function (it) { counts[it.kind] = (counts[it.kind] || 0) + 1; });
    return { total: items.length, counts: counts, items: items };
  }

  // ── Public render helpers ───────────────────────────────────────
  // Avatar headline rule: permanent titles (Season Champion, season Most Improved) persist
  // forever; every other badge is only eligible during its own season. Among eligible badges,
  // highest prestige wins, ties broken by most recent.
  // Filter items to a view. domain 'league' | 'ladder' restricts to that view's
  // badges (plus any untagged/shared ones); null/undefined returns everything.
  function itemsForDomain(items, domain) {
    if (!domain) return items;
    return items.filter(function (it) { return it.domain === domain || it.domain == null; });
  }

  function marqueeItem(opts, domain) {
    var s = summarize(opts);
    var CS = opts.currentSeason != null ? String(opts.currentSeason) : null;
    var cands = itemsForDomain(s.items, domain).filter(function (it) {
      if (it.permanent) return true;        // titles always headline
      if (CS == null) return true;          // no season context → treat all as eligible
      if (it.season == null) return true;   // untagged → assume current
      return it.season === CS;              // otherwise only this season's badges
    });
    cands.sort(function (a, b) {
      var pa = DEF[a.kind] ? DEF[a.kind].pri : 0, pb = DEF[b.kind] ? DEF[b.kind].pri : 0;
      if (pb !== pa) return pb - pa;
      return (b.sortDate || '').localeCompare(a.sortDate || '');
    });
    return cands[0] || null;
  }

  function avatarCrest(opts, domain) {
    opts = opts || {};
    var it = marqueeItem(opts, domain);
    if (!it) return '';
    var label = (DEF[it.kind] && DEF[it.kind].label) || it.title;
    return '<span class="dsb-clip" title="' + esc(label) + '">' + crestSvg(it.kind, 46, it.tone, it.type) + '</span>';
  }

  function heroPills(opts, domain) {
    var s = summarize(opts);
    var items = itemsForDomain(s.items, domain);
    // one pill per distinct badge type, ordered by prestige, with ×N counts
    var counts = {};
    items.forEach(function (it) { counts[it.kind] = (counts[it.kind] || 0) + 1; });
    var pri = function (k) { return DEF[k] ? DEF[k].pri : 0; };
    var kinds = Object.keys(counts).sort(function (a, b) { return pri(b) - pri(a); });
    return kinds.map(function (k) {
      var n = counts[k];
      var it = items.find(function (x) { return x.kind === k; });
      var tone = (it && it.tone) || (DEF[k] && DEF[k].tone) || 'gold';
      var label = (DEF[k] && DEF[k].label) || k;
      return '<span class="dsb-pill dsb-pill--' + tone + '" title="' + esc(label) + '">' +
        (ICONS[k] || ICONS.potw) + esc(label) + (n > 1 ? ' <span class="dsb-x">×' + n + '</span>' : '') + '</span>';
    }).join('');
  }

  function trophyCase(opts) {
    var s = summarize(opts);
    if (!s.total) return '';
    var crests = s.items.map(function (it) {
      return '<div class="dsb-case-item">' +
        '<div class="dsb-crest">' + crestSvg(it.kind, 78, it.tone, it.type) + '</div>' +
        '<div class="dsb-case-t">' + esc(it.title) + '</div>' +
        (it.meta ? '<div class="dsb-case-m">' + esc(it.meta) + '</div>' : '') +
        '</div>';
    }).join('');
    var sub = Object.keys(s.counts).sort(function (a, b) { return DEF[b].pri - DEF[a].pri; })
      .map(function (k) { return s.counts[k] + '× ' + DEF[k].label; }).join(' · ');
    return '<div class="dsb-case">' +
      '<div class="dsb-case-head"><span class="dsb-case-h">🏆 Trophy Case</span>' +
      '<span class="dsb-case-sub">' + esc(sub) + '</span></div>' +
      '<div class="dsb-case-grid">' + crests + '</div>' +
      '</div>';
  }

  function hasWins(opts) { return summarize(opts).total > 0; }

  // Apply admin config (from /.netlify/functions/public-badges). Overrides label,
  // tone, prestige, enabled state and custom logo per badge; registers any
  // admin-created custom badges so grants of that kind render.
  function setConfig(cfg) {
    if (!cfg || !Array.isArray(cfg.badges)) return;
    cfg.badges.forEach(function (b) {
      if (!b || !b.kind) return;
      if (!DEF[b.kind]) DEF[b.kind] = { label: b.label || b.kind, tone: b.tone || 'gold', pri: Number(b.pri) || 10 };
      else {
        if (b.label) DEF[b.kind].label = b.label;
        if (b.tone) DEF[b.kind].tone = b.tone;
        if (b.pri != null) DEF[b.kind].pri = Number(b.pri);
      }
      DISABLED[b.kind] = (b.enabled === false);
      if (b.logoUrl) LOGOS[b.kind] = b.logoUrl; else delete LOGOS[b.kind];
    });
  }

  // ── One-time styles ─────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('dsb-styles')) return;
    var css =
      '.dsb-clip{position:absolute;bottom:-4px;right:-6px;width:34%;max-width:48px;min-width:32px;aspect-ratio:1;line-height:0;pointer-events:none}' +
      '.dsb-clip svg{width:100%;height:100%;filter:drop-shadow(0 3px 6px rgba(0,0,0,.5))}' +
      '.dsb-pills{display:flex;flex-wrap:wrap;gap:6px}' +
      '.dsb-pill{display:inline-flex;align-items:center;gap:7px;padding:6px 12px 6px 8px;border-radius:999px;font-size:12px;font-weight:800;letter-spacing:.01em;border:1px solid;line-height:1;white-space:nowrap}' +
      '.dsb-pill svg{width:16px;height:16px;flex:none}' +
      '.dsb-pill--gold{color:var(--color-gold,#f0c040);border-color:rgba(240,192,64,.5);background:var(--color-gold-dim,rgba(240,192,64,.12))}' +
      '.dsb-pill--teal{color:var(--color-teal,#17d7b0);border-color:rgba(23,215,176,.5);background:var(--color-teal-dim,rgba(23,215,176,.12))}' +
      '.dsb-pill--lime{color:var(--color-lime,#b8ff2c);border-color:rgba(184,255,44,.5);background:var(--color-lime-dim,rgba(184,255,44,.12))}' +
      '.dsb-pill--violet{color:#a78bfa;border-color:rgba(167,139,250,.5);background:rgba(167,139,250,.14)}' +
      '.dsb-pill--rose{color:#ff6fb5;border-color:rgba(255,111,181,.5);background:rgba(255,111,181,.14)}' +
      '.dsb-pill--blue{color:#3b9eff;border-color:rgba(59,158,255,.5);background:rgba(59,158,255,.14)}' +
      '.dsb-x{font-weight:900;opacity:.75;font-size:11px;margin-left:1px}' +
      '.dsb-case{background:var(--color-surface,#161616);border:1px solid var(--color-border,rgba(255,255,255,.08));border-radius:var(--radius-lg,18px);padding:20px 22px;margin-bottom:14px}' +
      '.dsb-case-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}' +
      '.dsb-case-h{font-size:15px;font-weight:800}' +
      '.dsb-case-sub{font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--color-text-faint,#5e625c);text-transform:uppercase}' +
      '.dsb-case-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:16px 10px}' +
      '.dsb-case-item{display:flex;flex-direction:column;align-items:center;text-align:center;gap:7px}' +
      '.dsb-crest{width:74px;height:74px;line-height:0}.dsb-crest svg{width:100%;height:100%}' +
      '.dsb-case-t{font-size:11.5px;font-weight:800;line-height:1.25}' +
      '.dsb-case-m{font-size:10.5px;color:var(--color-text-faint,#5e625c);font-weight:600;line-height:1.3}';
    var st = document.createElement('style');
    st.id = 'dsb-styles';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }
  if (document.readyState !== 'loading') injectStyles();
  else document.addEventListener('DOMContentLoaded', injectStyles);

  window.dsBadges = {
    summarize: summarize,
    avatarCrest: avatarCrest,
    heroPills: heroPills,
    trophyCase: trophyCase,
    hasWins: hasWins,
    crestSvg: crestSvg,
    setConfig: setConfig,
    DEF: DEF,
    _injectStyles: injectStyles
  };
})();
