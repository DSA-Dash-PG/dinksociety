// ═══════════════════════════════════════════════════════════════
// season.js — The Dink Society
//
// One answer to "which season is this page showing?", shared by every public
// page. Load it in <head>; it starts the season fetch immediately so the answer
// is usually ready before the page's own boot code asks for it.
//
//   const S = await window.dsSeason();
//   S.id       'circuit-2'   → the ?season= form the schedule/standings/teams APIs take
//   S.circuit  'II'          → the code the leaderboard/player/stats APIs take
//   S.name     'Season 2'
//   S.isCurrent / S.isPast   → is this the live season, or one that's finished?
//   S.suffix   ''            → append to internal links; empty on the current
//                              season so its URLs stay clean
//   S.all      [...]         → every public season, newest first
//
// The season comes from ?season= or ?circuit= when present, otherwise from
// whichever season the server says is current (it flips a week before start).
// Nothing here throws: if the fetch fails, pages fall back to Season 1 exactly
// as they did before this existed.
// ═══════════════════════════════════════════════════════════════
(function () {
  var API = '/.netlify/functions';
  var ROMAN = ['I','II','III','IV','V','VI','VII','VIII','IX','X'];

  // Kick the fetch off now — pages await the promise, they don't start it.
  window.DS_SEASONS = window.DS_SEASONS || fetch(API + '/public-seasons')
    .then(function (r) { return r.ok ? r.json() : { seasons: [] }; })
    .catch(function () { return { seasons: [] }; });

  function codeOf(season) {
    if (!season) return 'I';
    if (season.circuit) return String(season.circuit).toUpperCase();
    var tail = String(season.id || '').replace(/^circuit-/i, '').replace(/^season-/i, '').trim();
    if (/^\d+$/.test(tail)) { var n = parseInt(tail, 10); return ROMAN[n - 1] || String(n); }
    if (/^(TEST|[IVX]+)$/i.test(tail)) return tail.toUpperCase();
    var m = String(season.name || season.label || '').match(/season\s*(\d+)/i);
    if (m) { var k = parseInt(m[1], 10); return ROMAN[k - 1] || String(k); }
    return tail ? tail.toUpperCase() : 'I';
  }
  function idOf(code) { return 'circuit-' + String(code || 'I').toLowerCase(); }

  var cached = null;
  window.dsSeason = function () {
    if (cached) return cached;
    cached = window.DS_SEASONS.then(function (data) {
      var all = (data && data.seasons) || [];
      var cur = (data && data.current) || null;
      var q = new URLSearchParams(location.search);
      // Pages use two conventions; accept either so old links keep working.
      var asked = q.get('season') || q.get('circuit') || '';

      var chosen = null;
      if (asked) {
        var wantCode = codeOf({ id: asked, name: asked });
        chosen = all.find(function (s) { return s.id === asked; })
              || all.find(function (s) { return codeOf(s) === wantCode; })
              || null;
        // A season the list doesn't carry (an archived one reached by link, or
        // TEST) still resolves — we just can't name it.
        if (!chosen) {
          return finish({ id: /^circuit-/i.test(asked) ? asked : idOf(wantCode),
                          circuit: wantCode, name: null }, cur, all, true);
        }
      }
      if (!chosen && cur) chosen = all.find(function (s) { return s.id === cur.id; }) || cur;
      if (!chosen) chosen = all[0] || { id: 'circuit-i', name: 'Season 1' };
      return finish(chosen, cur, all, !!asked);
    }).catch(function () {
      return { id: 'circuit-i', circuit: 'I', name: 'Season 1', isCurrent: true, isPast: false,
               suffix: '', qs: '', all: [], current: null, explicit: false };
    });
    return cached;
  };

  function finish(chosen, cur, all, explicit) {
    var code = codeOf(chosen);
    var id = chosen.id || idOf(code);
    var currentCode = cur ? String(cur.circuit || codeOf(cur)).toUpperCase() : null;
    var isCurrent = currentCode ? code === currentCode : true;
    var sorted = all.slice().sort(function (a, b) {
      return String(b.startDate || '').localeCompare(String(a.startDate || ''));
    });
    return {
      id: id,
      circuit: code,
      name: chosen.name || chosen.label || (code === 'TEST' ? 'Test Season' : 'Season ' + ((ROMAN.indexOf(code) + 1) || code)),
      startDate: chosen.startDate || null,
      isCurrent: isCurrent,
      // "Past" only when we know what current is AND this isn't it. An unknown
      // season is shown plainly rather than stamped FINAL on a guess.
      isPast: !!currentCode && !isCurrent,
      // Append to internal links. Empty on the current season so its URLs stay clean.
      suffix: isCurrent ? '' : '&season=' + encodeURIComponent(id),
      qs: isCurrent ? '' : '?season=' + encodeURIComponent(id),
      current: cur,
      all: sorted,
      explicit: explicit,
    };
  }

  // Rewrite an internal href to stay in the season being viewed.
  window.dsSeasonLink = function (href, S) {
    if (!S || S.isCurrent || !href || /^(https?:|mailto:|tel:|#)/i.test(href)) return href;
    return href + (href.indexOf('?') >= 0 ? '&' : '?') + 'season=' + encodeURIComponent(S.id);
  };
})();
