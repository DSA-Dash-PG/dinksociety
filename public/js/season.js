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
//   S.isCurrent / S.isPast / S.isUpcoming
//                            → the live season, one that's finished, or one that
//                              hasn't started yet. A future season must never be
//                              labelled "Final".
//   S.isRegistering          → upcoming AND taking sign-ups; the label people
//                              should see on it is "Registering", not "Upcoming"
//   S.tag      'Registering' → the one word to show beside a season's name,
//                              or '' for the current one
//   S.suffix   ''            → append to internal links; empty on the current
//                              season so its URLs stay clean
//   S.all      [...]         → every public season, in season order (1, 2, 3…)
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

  // ── Where is a season in its own life? ──────────────────────────
  // Deliberately NOT "is this the season the site is showing". Season 1 keeps
  // the site populated until Season 2 flips a week before its start, but it
  // finished playing in August — calling it "Current" there is just wrong.
  var DAY = 864e5, FLIP_LEAD = 7, TAIL_GRACE = 21;
  function ms(d) { var t = Date.parse(String(d || '').slice(0, 10) + 'T00:00:00Z'); return isNaN(t) ? null : t; }
  function endOf(season) {
    var e = ms(season && season.endDate);
    if (e != null) return e + DAY;
    var st = ms(season && season.startDate), wk = Number(season && season.weeks);
    if (st == null || !(wk > 0)) return null;          // no idea → never ends
    return st + (wk * 7 + TAIL_GRACE) * DAY;
  }
  // '' while it is being played, else the one word to show beside its name.
  function tagOf(season, now) {
    var st = ms(season && season.startDate);
    if (st == null) return '';
    var t = now == null ? Date.now() : now;
    if (t < st - FLIP_LEAD * DAY) {
      var reg = String((season && (season.registration || season.status)) || '').toLowerCase();
      return reg === 'closed' ? 'Upcoming' : 'Registering';
    }
    var en = endOf(season);
    return (en != null && t >= en) ? 'Final' : '';
  }

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
               isUpcoming: false, isRegistering: false, tag: '', suffix: '', qs: '',
               all: [], current: null, explicit: false };
    });
    return cached;
  };

  function finish(chosen, cur, all, explicit) {
    var code = codeOf(chosen);
    var id = chosen.id || idOf(code);
    var currentCode = cur ? String(cur.circuit || codeOf(cur)).toUpperCase() : null;
    var isCurrent = currentCode ? code === currentCode : true;
    // A season that hasn't started is UPCOMING, not final. Compared against the
    // current season's start so "future" doesn't drift with the clock.
    var curStart = (cur && cur.startDate) || '';
    var myStart = chosen.startDate || '';
    var isUpcoming = !isCurrent && !!myStart && !!curStart && myStart > curStart;
    var myTag = tagOf(chosen);
    // Season order, oldest first — Season 1 at the top of every list. Each entry
    // carries its own tag so menus don't have to recompute it.
    var sorted = all.slice()
      .sort(function (a, b) { return String(a.startDate || '').localeCompare(String(b.startDate || '')); })
      .map(function (x) { return Object.assign({}, x, { tag: tagOf(x) }); });
    return {
      id: id,
      circuit: code,
      name: chosen.name || chosen.label || (code === 'TEST' ? 'Test Season' : 'Season ' + ((ROMAN.indexOf(code) + 1) || code)),
      startDate: chosen.startDate || null,
      isCurrent: isCurrent,
      isUpcoming: isUpcoming,
      // "Past" only when we know what current is, this isn't it, and it isn't
      // still ahead of us. An unknown season is shown plainly rather than
      // stamped FINAL on a guess.
      isPast: !!currentCode && !isCurrent && !isUpcoming,
      isRegistering: myTag === 'Registering',
      // The single word to show beside this season's name, anywhere. Empty while
      // it is being played — no badge is the badge for "this is happening now".
      tag: myTag,
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
