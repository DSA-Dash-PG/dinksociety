// public/js/ds-ticker.js
//
// Live game-night ticker — renders two surfaces from one payload:
//   • bottomline strip  (site-wide, mounted by partials/ticker.html)
//   • homepage card     (index.html, #ds-livecard)
//
// Requires: /css/ticker.css, and /js/live-poll.js when using a live source.
//
// ---------------------------------------------------------------------------
// PAYLOAD SHAPE  (the contract — matches the proposed public-gameday.js)
// ---------------------------------------------------------------------------
//   {
//     season: 'circuit-i',
//     week: 6,
//     phase: 'rivalry',              // 'regular' | 'rivalry' | 'playoff' | 'championship'
//     phaseLabel: 'Rivalry Week',
//     gameNight: true,               // is tonight a match night?
//     venue: 'SBTC',
//     matches: [{
//       id, division,
//       courtA: '5A', courtB: '5B',  // client renders `Courts ${courtA} & ${courtB}`
//       court: 'Courts 5A & 5B',     // fallback label for legacy matches
//       scheduledAt: '2026-07-21T02:00:00.000Z',
//       status: 'live' | 'final' | 'awaiting',
//       home: { id, name, emoji, seedLabel },
//       away: { id, name, emoji, seedLabel },
//
//       // ---- SCORING MODEL (see lib/score-helpers.js) ----
//       // A match is 2 rounds x 6 games = 12 games. Each game has a real
//       // score (11-7 etc). A game is CONFIRMED only when the away captain
//       // confirms the home captain's entry; unconfirmed/disputed games are
//       // invisible here exactly as public-match.js gates them.
//       //
//       // Round points are awarded ONLY when all 6 games of that round are
//       // confirmed: round winner 2, tie 1-1. MATCH POINTS = r1 + r2, so the
//       // final match score is on a 0-4 scale (4-0, 3-1, 2-2 ...). That is
//       // what standings.js consumes as scoreA/scoreB.
//
//       games: [{ slot:'r1g1', round:1, gameNum:1, type:'MX',
//                 home:11, away:7 }],          // CONFIRMED games only
//       gamesHome: 5, gamesAway: 3,            // games won so far
//       gamesConfirmed: 8, gamesTotal: 12,     // progress through the match
//
//       round1: { homeGames, awayGames, homePoints, awayPoints, scoredGames },
//       round2: { ... },                       // points stay 0 until scoredGames === 6
//
//       // rally-point totals across confirmed games (PS/PA) — optional
//       pointsHome: 87, pointsAway: 74,
//
//       // FINAL match points (0-4). Written only at finalize — null during play.
//       mpHome: null, mpAway: null
//     }],
//     movers: [{ teamId, team, dir: 'up'|'down', n: 2, to: '3rd' }],
//     standings: [{ teamId, name, emoji, rank, mp, mpAgainst, pointsFor,
//                   pointsAgainst, byWeek: [3,4,3,4,4] }],   // mp = match points
//     h2h: { '<matchId>': { homeWins, awayWins, last: '4–0 ZERO ZERO TWO, Wk 5' } },
//     feed: [{                     // confirmed game results, newest first (venue board)
//       id, matchId, courtLabel: 'Ct 5A',
//       winnerPlayers: ['Philip R','Shay C'],      // the players ARE the headline
//       loserPlayers:  ['Devin Carroll','Pam Morioka'],
//       winner: 'ZERO ZERO TWO', loser: 'Smash Society',   // teams = sub-line
//       score: '11–7',
//       tag: 'Comeback',           // optional storyline chip
//       at: '2026-07-20T19:38:00.000Z'
//     }],
//     updatedAt: '2026-07-20T19:42:11.000Z'
//   }
//
// Until the backend lands, DSTicker.STUB below provides this exact shape.
// Swapping to real data = replacing the source in mount(), nothing else.
// ---------------------------------------------------------------------------

(function () {
  'use strict';

  var SPONSOR_MSGS = [
    'Live scoring presented by <b>K’CHN</b>',
    '<b>Point of the night</b> brought to you by K’CHN',
    'Post-match at <b>K’CHN</b> — show your paddle, get 15% off'
  ];

  var TUCK_KEY = 'ds-ticker-tucked';   // remembers a manual dismiss for the session

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function courtLabel(m) {
    if (m.courtA && m.courtB) return 'Courts ' + m.courtA + ' & ' + m.courtB;
    return m.court || '';
  }
  function shortCourt(m) {
    if (m.courtA && m.courtB) return 'Cts ' + m.courtA + ' & ' + m.courtB;
    return (m.court || '').replace('Courts ', 'Cts ');
  }
  function kchn() {
    return '<span class="ds-kchn">K’CHN</span>';
  }
  function timeAgo(iso) {
    if (!iso) return '';
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 90) return '1 min ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  // Match points, live. score-helpers.decorate() computes these from CONFIRMED
  // games alone — finalize only *persists* them to the schedule blob — so we
  // can show them as they accrue. They move in steps, not continuously: a
  // round pays out 2 pts (or 1-1) only once all 6 of its games are confirmed.
  function matchPts(m) {
    if (m.mpHome != null && m.mpAway != null) return { h: m.mpHome, a: m.mpAway };
    var r1 = m.round1 || {}, r2 = m.round2 || {};
    return { h: (r1.homePoints || 0) + (r2.homePoints || 0),
             a: (r1.awayPoints || 0) + (r2.awayPoints || 0) };
  }
  // Headline: games won while playing (moves every confirmed game), match
  // points once the match is done (that's the number standings speak in).
  function score(m) {
    if (m.status === 'final') { var mp = matchPts(m); return { h: mp.h, a: mp.a, kind: 'mp' }; }
    return { h: m.gamesHome || 0, a: m.gamesAway || 0, kind: 'games' };
  }
  function progress(m) {
    if (m.gamesConfirmed == null || !m.gamesTotal) return '';
    return m.gamesConfirmed + ' of ' + m.gamesTotal;
  }
  // "MP 2–0" chip — only meaningful once a round has actually paid out
  function mpChip(m) {
    var mp = matchPts(m);
    if (!mp.h && !mp.a) return '';
    return '<span class="mp">MP ' + mp.h + '–' + mp.a + '</span>';
  }
  // "Richard Hak" → "Richard H." (matches admin-matches-live convention)
  function shortName(n) {
    var p = String(n || '').trim().split(/\s+/);
    if (p.length < 2) return p[0] || '';
    return p[0] + ' ' + p[p.length - 1][0] + '.';
  }
  function pair(names) {
    return (names || []).map(shortName).filter(Boolean).join(' / ');
  }
  // Same pair, but split so CSS can drop the surname on narrow screens —
  // "Philip R." on desktop, just "Philip" on a phone.
  function pairHtml(names) {
    return (names || []).map(function (n) {
      var p = String(n || '').trim().split(/\s+/);
      var first = p[0] || '';
      var rest = p.length > 1 ? ' ' + p[p.length - 1][0] + '.' : '';
      if (!first) return '';
      return '<span class="pn"><b>' + esc(first) + '</b>' +
             (rest ? '<i>' + esc(rest) + '</i>' : '') + '</span>';
    }).filter(Boolean).join('<span class="amp">/</span>');
  }
  // Per-round tally: games won so far, plus round points once the round pays out.
  function roundChips(m) {
    var out = [];
    [['R1', m.round1], ['R2', m.round2]].forEach(function (p) {
      var r = p[1];
      if (!r || !r.scoredGames) return;
      var done = r.scoredGames === 6;
      out.push('<span class="rc' + (done ? ' done' : '') + '">' +
        '<i>' + p[0] + '</i>' +
        (r.homeGames || 0) + '–' + (r.awayGames || 0) +
        (done ? '<b>' + (r.homePoints || 0) + '–' + (r.awayPoints || 0) + '</b>'
              : '<u>' + r.scoredGames + '/6</u>') +
      '</span>');
    });
    return out.join('');
  }
  // most recent confirmed game with who played it —
  // "R2G2 · WD · Lara P / Judy DV 7–11 Annie K. / Phoebe B."
  function lastGame(m) {
    var gs = m.games || [];
    if (!gs.length) return '';
    var g = gs[gs.length - 1];
    var who = pair(g.homePlayers), them = pair(g.awayPlayers);
    var head = 'R' + g.round + 'G' + g.gameNum + (g.type ? ' · ' + g.type : '');
    if (!who || !them) return head + ' · ' + g.home + '–' + g.away;
    return head + ' · ' + who + ' ' + g.home + '–' + g.away + ' ' + them;
  }
  function isLiveish(d) {
    return !!(d && d.matches || []).length &&
           d.matches.some(function (m) { return m.status === 'live'; });
  }

  // ---------- bottomline items ----------
  function matchItem(m) {
    var live = m.status === 'live';
    var fin = m.status === 'final';
    var deck = m.status === 'awaiting';
    var s = score(m);
    var hWin = s.h > s.a, aWin = s.a > s.h;

    if (deck) {
      return '<a class="ds-tick-item" href="/team.html?match=' + esc(m.id) + '">' +
        '<span class="ct">' + esc(shortCourt(m)) + '</span>' +
        '<span class="emoji">' + esc(m.home.emoji || '') + '</span>' +
        '<span class="ds-tick-name">' + esc(m.home.name) + '</span>' +
        '<span class="note">vs</span>' +
        '<span class="ds-tick-name">' + esc(m.away.name) + '</span>' +
        '<span class="emoji">' + esc(m.away.emoji || '') + '</span>' +
        '<span class="fin">On deck</span>' +
      '</a>';
    }
    return '<a class="ds-tick-item' + (live ? ' is-live' : '') + '" href="/team.html?match=' + esc(m.id) + '">' +
      (live ? '<span class="ds-livedot"></span>' : '') +
      '<span class="ct">' + esc(shortCourt(m)) + '</span>' +
      '<span class="emoji">' + esc(m.home.emoji || '') + '</span>' +
      '<span class="ds-tick-name ' + (hWin ? 'win' : (fin ? 'lose' : '')) + '">' + esc(m.home.name) + '</span>' +
      '<span class="ds-tick-score">' + s.h + '<span class="dash">–</span>' + s.a + '</span>' +
      '<span class="ds-tick-name ' + (aWin ? 'win' : (fin ? 'lose' : '')) + '">' + esc(m.away.name) + '</span>' +
      '<span class="emoji">' + esc(m.away.emoji || '') + '</span>' +
      (fin ? '<span class="fin">Final</span>'
           : mpChip(m) + (lastGame(m) ? '<span class="note">' + esc(lastGame(m)) + '</span>' : '')) +
    '</a>';
  }

  function moverItem(mv) {
    var up = mv.dir === 'up';
    return '<span class="ds-tick-item">' +
      '<span class="' + (up ? 'up' : 'down') + '">' + (up ? '▲' : '▼') + mv.n + '</span>' +
      '<span class="ds-tick-name">' + esc(mv.team) + '</span>' +
      '<span class="note">now ' + esc(mv.to) + '</span>' +
    '</span>';
  }

  function sponsorItem(i) {
    return '<span class="ds-tick-item is-sponsor">' + kchn() +
      '<span class="msg">' + SPONSOR_MSGS[i % SPONSOR_MSGS.length] + '</span></span>';
  }

  function phaseItem(d) {
    if (d.phase !== 'rivalry') return '';
    return '<span class="ds-tick-item">' +
      '<span class="note" style="color:var(--color-teal)">' + esc(d.phaseLabel || 'Rivalry Week') + '</span>' +
      '<span class="note">Seeds locked off the standings</span>' +
    '</span>';
  }

  // A short slate (3 matches) makes a stubby loop — pad with movers, the
  // phase note, and a K'CHN slot after each match.
  function buildRun(d) {
    var out = [], s = 0;
    (d.matches || []).forEach(function (m, i) {
      out.push(matchItem(m));
      out.push(sponsorItem(s++));
      if ((d.movers || [])[i]) out.push(moverItem(d.movers[i]));
    });
    var ph = phaseItem(d);
    if (ph) out.push(ph);
    return out.join('');
  }

  // ---------- surface 1: bottomline ----------
  function renderStrip(root, d) {
    if (!root) return;
    var show = d && d.gameNight && (d.matches || []).length;
    root.hidden = !show;
    document.body.classList.toggle('has-ds-tick', !!show);
    if (!show) return;

    var run = buildRun(d);
    var meta = 'Week ' + d.week +
      (d.phase === 'rivalry' ? ' · <span class="rival">' + esc(d.phaseLabel || 'Rivalry Week') + '</span>' : '') +
      (d.venue ? ' · ' + esc(d.venue) : '');

    root.innerHTML =
      '<div class="ds-tick-brand"><span class="ds-livedot"></span>Dink Society<span class="lbl">LIVE</span></div>' +
      '<div class="ds-tick-meta">' + meta + '</div>' +
      '<div class="ds-tick-meta" style="gap:9px">' +
        '<span class="ds-presented">Presented by</span>' + kchn() +
      '</div>' +
      '<div class="ds-tick-viewport"><div class="ds-tick-track">' + run + run + '</div></div>' +
      '<button class="ds-tick-close" type="button" aria-label="Hide live ticker">×</button>';

    // duration scales with content so speed stays constant regardless of slate size
    var track = root.querySelector('.ds-tick-track');
    requestAnimationFrame(function () {
      var w = track.scrollWidth / 2;                 // one run
      track.style.setProperty('--ds-tick-speed', Math.max(24, Math.round(w / 42)) + 's');
    });

    root.querySelector('.ds-tick-close').addEventListener('click', function () {
      root.classList.add('is-tucked');
      document.body.classList.remove('has-ds-tick');
      try { sessionStorage.setItem(TUCK_KEY, '1'); } catch (e) {}
    });

    if (sessionStorageGet(TUCK_KEY)) {
      root.classList.add('is-tucked');
      document.body.classList.remove('has-ds-tick');
    }
  }

  function sessionStorageGet(k) {
    try { return sessionStorage.getItem(k); } catch (e) { return null; }
  }

  // Who's on court right now — falls back to the last confirmed game so the
  // card always names somebody once play is under way.
  function onCourtLine(m) {
    var g = m.current || (m.games || [])[(m.games || []).length - 1];
    if (!g) return '';
    var h = pairHtml(g.homePlayers), a = pairHtml(g.awayPlayers);
    if (!h && !a) return '';
    var label = m.current ? 'On court' : 'R' + g.round + 'G' + g.gameNum;
    return '<span class="ds-lc-players">' +
      '<span class="lbl">' + esc(label) + '</span>' + h +
      '<span class="v">v</span>' + a +
    '</span>';
  }

  // ---------- surface 2: homepage card ----------
  function renderCard(root, d) {
    if (!root) return;
    var show = d && d.gameNight && (d.matches || []).length;
    root.hidden = !show;
    if (!show) return;

    var accents = ['#4c8cff', '#c86cff', '#ff9f45', '#17d7b0', '#f0c040', '#ff5c47'];

    var rows = d.matches.map(function (m, i) {
      var live = m.status === 'live', fin = m.status === 'final', deck = m.status === 'awaiting';
      var s = score(m);
      var hWin = s.h > s.a, aWin = s.a > s.h;
      var st = live ? '<span class="st live">Live</span>'
             : fin ? '<span class="st final">Final</span>'
                   : '<span class="st deck">On deck</span>';
      var pts = function (v) {
        return deck ? '<span class="ds-lc-score" style="color:var(--color-text-faint);font-size:14px">–</span>'
                    : '<span class="ds-lc-score">' + v + '</span>';
      };
      return '<a class="ds-lc-row" style="--accent:' + accents[i % accents.length] + '" href="/team.html?match=' + esc(m.id) + '">' +
        '<span class="ds-lc-side' + (hWin ? ' win' : '') + '">' +
          '<span class="ds-lc-emoji">' + esc(m.home.emoji || '') + '</span>' +
          '<span class="ds-lc-name">' + esc(m.home.name) + '</span>' +
          pts(s.h) +
        '</span>' +
        '<span class="ds-lc-mid"><span class="ct">' + esc(courtLabel(m)) + '</span>' + st +
          (live ? mpChip(m) : '') + '</span>' +
        '<span class="ds-lc-side r' + (aWin ? ' win' : '') + '">' +
          pts(s.a) +
          '<span class="ds-lc-name">' + esc(m.away.name) + '</span>' +
          '<span class="ds-lc-emoji">' + esc(m.away.emoji || '') + '</span>' +
        '</span>' +
      '</a>' +
      (deck ? '' : '<div class="ds-lc-sub">' + roundChips(m) + onCourtLine(m) + '</div>');
    }).join('');

    root.innerHTML =
      '<div class="ds-lc-head">' +
        '<span class="ds-livedot"></span>' +
        '<h3>Now Playing</h3>' +
        '<span class="wk">Week ' + d.week +
          (d.phase === 'rivalry' ? ' · <span class="rival">' + esc(d.phaseLabel || 'Rivalry Week') + '</span>' : '') +
        '</span>' +
        '<span class="spon"><span class="ds-presented">Presented by</span>' + kchn() + '</span>' +
      '</div>' +
      '<div class="ds-lc-rows">' + rows + '</div>' +
      '<div class="ds-lc-foot">' +
        '<a href="/schedule.html">Full schedule →</a>' +
        '<span class="ts">Updated ' + esc(timeAgo(d.updatedAt)) + '</span>' +
      '</div>';
  }

  // ---------- public API ----------
  var state = { strip: null, card: null, data: null, poller: null };

  function render(data) {
    state.data = data;
    renderStrip(state.strip, data);
    renderCard(state.card, data);
  }

  // mount({ strip: el, card: el, source: 'stub' | {url, interval} })
  function mount(opts) {
    opts = opts || {};
    state.strip = opts.strip || document.getElementById('ds-ticker');
    state.card = opts.card || document.getElementById('ds-livecard');

    var src = opts.source || 'stub';

    if (src === 'stub') { render(DSTicker.STUB); return; }

    // Live source — requires /js/live-poll.js. If it's missing we render
    // NOTHING. Never fall back to STUB on a public surface: fabricated scores
    // and player pairings that look authoritative are worse than a blank bar.
    if (!window.DSLivePoll) {
      console.error('[ds-ticker] live-poll.js not loaded — ticker disabled');
      render({ gameNight: false, matches: [] });
      return;
    }
    state.poller = window.DSLivePoll.create({
      url: src.url,
      interval: src.interval || function () {
        var d = state.data;
        if (!d || !d.gameNight) return 0;          // dormant, rechecks every 5 min
        return isLiveish(d) ? 12000 : 60000;
      },
      onUpdate: render,
      onError: function (e) { console.warn('[ds-ticker]', e); }
    });
    state.poller.start();
  }

  // ---- demo helper (preview pages only) ----
  // Models one away-captain confirmation against the real payout rules from
  // lib/score-helpers.js: a round pays its winner 2 pts (1-1 on a 3-3 split)
  // only once all 6 of its games are confirmed; match points = r1 + r2.
  function demoConfirm(m) {
    if (m.status !== 'live') return;
    var n = m.gamesConfirmed || 0;
    if (n >= (m.gamesTotal || 12)) return;

    var round = n < 6 ? 1 : 2;
    var gameNum = (n % 6) + 1;
    var homeWins = Math.random() < 0.5;
    var win = 11, lose = Math.floor(Math.random() * 9) + 2;

    m.games = m.games || [];
    m.games.push({ slot: 'r' + round + 'g' + gameNum, round: round, gameNum: gameNum,
                   type: ['MX', 'WD', 'MD'][gameNum % 3],
                   home: homeWins ? win : lose, away: homeWins ? lose : win });

    if (homeWins) m.gamesHome = (m.gamesHome || 0) + 1;
    else m.gamesAway = (m.gamesAway || 0) + 1;
    m.gamesConfirmed = n + 1;

    var key = round === 1 ? 'round1' : 'round2';
    var r = m[key] || (m[key] = { homeGames: 0, awayGames: 0, homePoints: 0, awayPoints: 0, scoredGames: 0 });
    if (homeWins) r.homeGames++; else r.awayGames++;
    r.scoredGames++;
    if (r.scoredGames === 6) {
      if (r.homeGames > r.awayGames) { r.homePoints = 2; r.awayPoints = 0; }
      else if (r.awayGames > r.homeGames) { r.homePoints = 0; r.awayPoints = 2; }
      else { r.homePoints = 1; r.awayPoints = 1; }
    }
    if (m.gamesConfirmed >= (m.gamesTotal || 12)) {
      m.status = 'final';
      m.mpHome = (m.round1.homePoints || 0) + (m.round2.homePoints || 0);
      m.mpAway = (m.round1.awayPoints || 0) + (m.round2.awayPoints || 0);
    }
  }

  var DSTicker = {
    mount: mount,
    render: render,
    buildRun: buildRun,
    matchPts: matchPts,
    shortName: shortName,
    pair: pair,
    demoConfirm: demoConfirm,
    get data() { return state.data; },
    stop: function () { if (state.poller) state.poller.stop(); },

    // ---- stub payload ----
    // Week 6 Rivalry Week, Mon Jul 20, SBTC. Teams, ids, emoji, colours,
    // courts and rosters are REAL (pulled from public-schedule / public-teams);
    // the in-progress game scores are sample state.
    STUB: {
      season: 'circuit-i',
      week: 6,
      phase: 'rivalry',
      phaseLabel: 'Rivalry Week',
      gameNight: true,
      venue: 'SBTC',
      lineupsVisible: true,
      updatedAt: new Date().toISOString(),
      matches: [
        { id: 'm_I_3-0-mixed_w6_rivalry-1', division: '3-0-mixed',
          courtA: '5A', courtB: '5B', venue: 'SBTC',
          scheduledAt: '2026-07-21T02:00:00.000Z', status: 'live',
          home: { id: 'team_d8202999885752dc', name: 'ZERO ZERO TWO', emoji: '🎯', color: '#15b512', seedLabel: '#1 Seed' },
          away: { id: 'team_fd8a1d5cc957f4ee', name: 'Smash Society', emoji: '\uD83D\uDC4A', color: '#e27937', seedLabel: '#2 Seed' },
          games: [
            { slot:'r1g1', round:1, gameNum:1, type:'MX', home:11, away:7,
              homePlayers:['Philip R','Dona B'], awayPlayers:['Ryan Hom','Annie Kang'] },
            { slot:'r1g2', round:1, gameNum:2, type:'WD', home:9, away:11,
              homePlayers:['Shay C','Lara P'], awayPlayers:['Pam Morioka','Phoebe Borsum'] },
            { slot:'r1g3', round:1, gameNum:3, type:'MD', home:11, away:5,
              homePlayers:['Anthony B','Kyle U'], awayPlayers:['Kai Pylkkanen','Devin Carroll'] },
            { slot:'r1g4', round:1, gameNum:4, type:'MX', home:11, away:8,
              homePlayers:['Ian B','Judy DV'], awayPlayers:['Stan Esperon','Sally Whitty'] },
            { slot:'r1g5', round:1, gameNum:5, type:'WD', home:6, away:11,
              homePlayers:['Dona B','Kaithlyn R'], awayPlayers:['Cheryl','Dot M.'] },
            { slot:'r1g6', round:1, gameNum:6, type:'MD', home:11, away:9,
              homePlayers:['Francis A','Masaki'], awayPlayers:['Matt P.','Ryan Hom'] },
            { slot:'r2g1', round:2, gameNum:1, type:'MX', home:11, away:4,
              homePlayers:['Philip R','Shay C'], awayPlayers:['Devin Carroll','Pam Morioka'] },
            { slot:'r2g2', round:2, gameNum:2, type:'WD', home:7, away:11,
              homePlayers:['Lara P','Judy DV'], awayPlayers:['Annie Kang','Phoebe Borsum'] }
          ],
          current: { slot:'r2g3', round:2, gameNum:3, type:'MD',
                     homePlayers:['Anthony B','Ant B'], awayPlayers:['Kai Pylkkanen','Matt P.'] },
          gamesHome: 5, gamesAway: 3, gamesConfirmed: 8, gamesTotal: 12,
          round1: { homeGames:4, awayGames:2, homePoints:2, awayPoints:0, scoredGames:6 },
          round2: { homeGames:1, awayGames:1, homePoints:0, awayPoints:0, scoredGames:2 },
          pointsHome: 87, pointsAway: 74, mpHome: null, mpAway: null },

        { id: 'm_I_3-0-mixed_w6_rivalry-2', division: '3-0-mixed',
          courtA: '5C', courtB: '5D', venue: 'SBTC',
          scheduledAt: '2026-07-21T02:00:00.000Z', status: 'live',
          home: { id: 'team_4d3977839a1d212b', name: 'K\u2019CHN', emoji: '\uD83E\uDD0C', color: '#fff700', seedLabel: '#3 Seed' },
          away: { id: 'team_cb12d29b000c9332', name: 'Big Dink Energy', emoji: '\uD83D\uDE24', color: '#8bbc9e', seedLabel: '#4 Seed' },
          games: [
            { slot:'r1g1', round:1, gameNum:1, type:'MX', home:11, away:6,
              homePlayers:['Patrick','Vernice Carag'], awayPlayers:['Richard Hak','Jobeth Zapata'] },
            { slot:'r1g2', round:1, gameNum:2, type:'WD', home:8, away:11,
              homePlayers:['Katrina Nicasio','Kathleen Paraiso'], awayPlayers:['Angel Munar','Kayo Hayashi'] },
            { slot:'r1g3', round:1, gameNum:3, type:'MD', home:11, away:9,
              homePlayers:['Chris Carag','Jesse Nicasio'], awayPlayers:['Eli Henry','Chandler Hong'] },
            { slot:'r1g4', round:1, gameNum:4, type:'MX', home:5, away:11,
              homePlayers:['Philip Cadelina','Jennifer Morales'], awayPlayers:['Yoshi Nogimura','Tanya Deemer'] },
            { slot:'r1g5', round:1, gameNum:5, type:'WD', home:11, away:8,
              homePlayers:['Elizabeth Acevedez','Angela C.'], awayPlayers:['Fiat Tapaneeyakorn','Arica Green'] },
            { slot:'r1g6', round:1, gameNum:6, type:'MD', home:7, away:11,
              homePlayers:['Guilbert Balmaceda','Josh Manarang'], awayPlayers:['Richard Hak','Eli Henry'] }
          ],
          current: { slot:'r2g1', round:2, gameNum:1, type:'MX',
                     homePlayers:['Patrick','Katrina Nicasio'], awayPlayers:['Chandler Hong','Kayo Hayashi'] },
          gamesHome: 3, gamesAway: 3, gamesConfirmed: 6, gamesTotal: 12,
          round1: { homeGames:3, awayGames:3, homePoints:1, awayPoints:1, scoredGames:6 },
          round2: { homeGames:0, awayGames:0, homePoints:0, awayPoints:0, scoredGames:0 },
          pointsHome: 64, pointsAway: 66, mpHome: null, mpAway: null },

        { id: 'm_I_3-0-mixed_w6_rivalry-3', division: '3-0-mixed',
          courtA: '3A', courtB: '3B', venue: 'SBTC',
          scheduledAt: '2026-07-21T02:00:00.000Z', status: 'live',
          home: { id: 'team_a853cda246cedb85', name: 'What the Dink?!', emoji: '\uD83E\uDD2C', color: '#332092', seedLabel: '#5 Seed' },
          away: { id: 'team_3f4cbdb62c7a5616', name: 'Timog Cal', emoji: '\uD83C\uDF34', color: '#e47d07', seedLabel: '#6 Seed' },
          games: [
            { slot:'r1g1', round:1, gameNum:1, type:'MX', home:9, away:11,
              homePlayers:['Teddie Liu','Sheri O\u2019Neil'], awayPlayers:['Enrique','Sandee Petersen'] },
            { slot:'r1g2', round:1, gameNum:2, type:'WD', home:11, away:7,
              homePlayers:['Elaine Dodson','Amita Parikh'], awayPlayers:['Aurora Timbol','Selene'] },
            { slot:'r1g3', round:1, gameNum:3, type:'MD', home:6, away:11,
              homePlayers:['Ryan Yeung','Justin Kwok'], awayPlayers:['Bernard Comia','GM Ardoy'] },
            { slot:'r1g4', round:1, gameNum:4, type:'MX', home:8, away:11,
              homePlayers:['Emanual Escamilla','Chrisherlyn Dumrique'], awayPlayers:['Noel Manansala','Aurora Timbol'] },
            { slot:'r1g5', round:1, gameNum:5, type:'WD', home:11, away:9,
              homePlayers:['Sheri O\u2019Neil','Elaine Dodson'], awayPlayers:['Sandee Petersen','Selene'] },
            { slot:'r1g6', round:1, gameNum:6, type:'MD', home:4, away:11,
              homePlayers:['Teddie Liu','Ryan Yeung'], awayPlayers:['Ricky Pedernal','Wally Quijano'] },
            { slot:'r2g1', round:2, gameNum:1, type:'MX', home:9, away:11,
              homePlayers:['Justin Kwok','Amita Parikh'], awayPlayers:['Enrique','Aurora Timbol'] }
          ],
          current: { slot:'r2g2', round:2, gameNum:2, type:'WD',
                     homePlayers:['Elaine Dodson','Chrisherlyn Dumrique'], awayPlayers:['Sandee Petersen','Selene'] },
          gamesHome: 2, gamesAway: 5, gamesConfirmed: 7, gamesTotal: 12,
          round1: { homeGames:2, awayGames:4, homePoints:0, awayPoints:2, scoredGames:6 },
          round2: { homeGames:0, awayGames:1, homePoints:0, awayPoints:0, scoredGames:1 },
          pointsHome: 58, pointsAway: 71, mpHome: null, mpAway: null }
      ],

      // real standings through Week 5 (match points, 4 per match)
      standings: [
        { teamId:'team_d8202999885752dc', name:'ZERO ZERO TWO',   emoji:'🎯', color:'#15b512', rank:1, mp:18, byWeek:[3,4,3,4,4], pointsFor:617, pointsAgainst:399 },
        { teamId:'team_fd8a1d5cc957f4ee', name:'Smash Society',   emoji:'\uD83D\uDC4A', color:'#e27937', rank:2, mp:15, byWeek:[4,4,4,3,0], pointsFor:567, pointsAgainst:438 },
        { teamId:'team_4d3977839a1d212b', name:'K\u2019CHN',      emoji:'\uD83E\uDD0C', color:'#fff700', rank:3, mp:13, byWeek:[4,0,1,4,4], pointsFor:512, pointsAgainst:437 },
        { teamId:'team_cb12d29b000c9332', name:'Big Dink Energy', emoji:'\uD83D\uDE24', color:'#8bbc9e', rank:4, mp:10, byWeek:[1,4,4,1,0], pointsFor:477, pointsAgainst:475 },
        { teamId:'team_a853cda246cedb85', name:'What the Dink?!', emoji:'\uD83E\uDD2C', color:'#332092', rank:5, mp:3,  byWeek:[0,0,0,0,3], pointsFor:364, pointsAgainst:566 },
        { teamId:'team_3f4cbdb62c7a5616', name:'Timog Cal',       emoji:'\uD83C\uDF34', color:'#e47d07', rank:6, mp:1,  byWeek:[0,0,0,0,1], pointsFor:385, pointsAgainst:607 }
      ],

      // prior meetings — each rivalry pair met once, in Week 5
      h2h: {
        'm_I_3-0-mixed_w6_rivalry-1': { homeWins:1, awayWins:0, last:'ZERO ZERO TWO 4\u20130, Wk 5' },
        'm_I_3-0-mixed_w6_rivalry-2': { homeWins:1, awayWins:0, last:'K\u2019CHN 4\u20130, Wk 5' },
        'm_I_3-0-mixed_w6_rivalry-3': { homeWins:1, awayWins:0, last:'What the Dink?! 3\u20131, Wk 5' }
      },

      movers: [
        { teamId:'team_fd8a1d5cc957f4ee', team:'Smash Society',   dir:'up', n:1, to:'1st' },
        { teamId:'team_cb12d29b000c9332', team:'Big Dink Energy', dir:'up', n:1, to:'3rd' },
        { teamId:'team_3f4cbdb62c7a5616', team:'Timog Cal',       dir:'up', n:1, to:'5th' }
      ],

      feed: [
        { id:'g1', matchId:'m_I_3-0-mixed_w6_rivalry-1', courtLabel:'Ct 5A',
          winner:'ZERO ZERO TWO', loser:'Smash Society', score:'11\u20134', tag:null,
          winnerPlayers:['Philip R','Shay C'], loserPlayers:['Devin Carroll','Pam Morioka'], at:null },
        { id:'g2', matchId:'m_I_3-0-mixed_w6_rivalry-3', courtLabel:'Ct 3A',
          winner:'Timog Cal', loser:'What the Dink?!', score:'11\u20139', tag:'Upset',
          winnerPlayers:['Enrique','Aurora Timbol'], loserPlayers:['Justin Kwok','Amita Parikh'], at:null },
        { id:'g3', matchId:'m_I_3-0-mixed_w6_rivalry-2', courtLabel:'Ct 5D',
          winner:'Big Dink Energy', loser:'K\u2019CHN', score:'11\u20137', tag:null,
          winnerPlayers:['Richard Hak','Eli Henry'], loserPlayers:['Guilbert Balmaceda','Josh Manarang'], at:null },
        { id:'g4', matchId:'m_I_3-0-mixed_w6_rivalry-1', courtLabel:'Ct 5B',
          winner:'Smash Society', loser:'ZERO ZERO TWO', score:'11\u20137', tag:'Comeback',
          winnerPlayers:['Annie Kang','Phoebe Borsum'], loserPlayers:['Shay C','Lara P'], at:null },
        { id:'g5', matchId:'m_I_3-0-mixed_w6_rivalry-2', courtLabel:'Ct 5C',
          winner:'K\u2019CHN', loser:'Big Dink Energy', score:'11\u20139', tag:null,
          winnerPlayers:['Chris Carag','Jesse Nicasio'], loserPlayers:['Eli Henry','Chandler Hong'], at:null }
      ]
    }
  };

  window.DSTicker = DSTicker;
})();
