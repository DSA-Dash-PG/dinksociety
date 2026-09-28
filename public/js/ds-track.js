// ═══════════════════════════════════════════════════════════════
// ds-track.js — The Dink Society
// First-party page analytics for the admin Traffic page. Sends one small
// beacon when a page opens, a heartbeat every 30s while someone is actually
// using it, and a final one when they leave — so we know which pages people
// read and for how long. No third parties, no cookies of its own; ds_vid /
// ds_sess in localStorage are random ids. Loaded by partials.js on public
// pages and by a <script> tag on the portal pages.
// Server side: netlify/functions/track.js → lib/traffic.js
// ═══════════════════════════════════════════════════════════════
(function () {
  if (window.__dsTrack) return;
  window.__dsTrack = true;
  try {
    if (navigator.webdriver) return;
    if (/[?&]embed=1\b/.test(location.search)) return;          // admin console iframes
    if (/^(localhost|127\.|192\.168\.)/.test(location.hostname)) return;
  } catch (e) { return; }

  var URL_ = '/.netlify/functions/track';
  var HEARTBEAT = 30000;          // ms between heartbeats while active
  var IDLE = 3 * 60000;           // no input for this long → stop counting time
  var SESSION_GAP = 30 * 60000;   // away this long → next visit is a new session
  var QKEYS = ['slug', 'id', 'team', 'player', 'tab', 'week', 'circuit', 'division', 'season', 'ladder', 'event', 'm'];

  function rid() {
    try { if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 20); } catch (e) {}
    return (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/g, '').slice(0, 20);
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // Visitor id — shares the key the old anonymous counter used.
  var vid = lsGet('ds_vid');
  if (!vid || !/^[a-z0-9-]{8,40}$/i.test(vid)) { vid = rid(); lsSet('ds_vid', vid); }
  vid = vid.replace(/-/g, '').slice(0, 32);

  // Session id — shared across tabs, rolls over after 30 min of nothing.
  function session(touch) {
    var now = Date.now(), s = null;
    try { s = JSON.parse(lsGet('ds_sess') || 'null'); } catch (e) {}
    if (!s || !s.id || now - (s.at || 0) > SESSION_GAP) s = { id: rid(), at: now };
    if (touch) { s.at = now; lsSet('ds_sess', JSON.stringify(s)); }
    return s.id;
  }

  function query() {
    var out = {}, p;
    try { p = new URLSearchParams(location.search); } catch (e) { return out; }
    QKEYS.forEach(function (k) { var v = p.get(k); if (v) out[k] = v.slice(0, 60); });
    return out;
  }
  function hashTab() {
    var h = (location.hash || '').replace(/^#/, '');
    return /^[a-z0-9\/_-]{1,30}$/i.test(h) ? h : '';
  }
  function screen() { var q = query(); return location.pathname + '|' + (q.tab || '') + '|' + hashTab(); }
  function scrollPct() {
    var d = document.documentElement, b = document.body;
    var h = Math.max(d.scrollHeight, b ? b.scrollHeight : 0) - window.innerHeight;
    if (h <= 0) return 100;
    return Math.min(100, Math.round(100 * (window.scrollY || d.scrollTop || 0) / h));
  }
  var standalone = false;
  try { standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) {}
  var utm = '';
  try { utm = (new URLSearchParams(location.search).get('utm_source') || '').slice(0, 40); } catch (e) {}

  var pv = null;               // current page view
  var lastInput = Date.now();
  var lastTick = Date.now();
  var lastSentMs = -1;
  var hiddenAt = 0;
  var firstView = true;

  function newView() {
    var ref = '';
    if (firstView) {
      try { if (document.referrer && new URL(document.referrer).origin !== location.origin) ref = document.referrer; } catch (e) {}
    }
    pv = {
      pvid: rid(), sid: session(true), st: Date.now(), ms: 0, sc: scrollPct(), key: screen(),
      ref: ref, src: firstView ? utm : '',
    };
    firstView = false;
    lastTick = Date.now();
    lastSentMs = -1;
    send('start');
  }

  function accrue() {
    var now = Date.now();
    if (pv && document.visibilityState === 'visible') {
      // Only count the stretch up to IDLE past the last input.
      var until = Math.min(now, lastInput + IDLE);
      if (until > lastTick) pv.ms += until - lastTick;
      pv.sc = Math.max(pv.sc, scrollPct());
    }
    lastTick = now;
  }

  function send(kind) {
    if (!pv) return;
    var body = JSON.stringify({
      k: kind, vid: vid, sid: pv.sid, pvid: pv.pvid, st: pv.st, ms: Math.round(pv.ms), sc: pv.sc,
      path: location.pathname, q: query(), h: hashTab(),
      title: (document.title || '').slice(0, 120), ref: pv.ref, src: pv.src,
      sw: window.screen ? window.screen.width : 0, tp: (navigator.maxTouchPoints || 0) > 1 ? 1 : 0,
      pwa: standalone ? 1 : 0,
    });
    lastSentMs = pv.ms;
    try {
      if ((kind === 'end' || kind === 'hide') && navigator.sendBeacon) {
        navigator.sendBeacon(URL_, new Blob([body], { type: 'text/plain' }));
      } else {
        fetch(URL_, { method: 'POST', body: body, keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
      }
    } catch (e) {}
  }

  // Input = "still here".
  var bump = function () { lastInput = Date.now(); };
  ['pointerdown', 'keydown', 'scroll', 'touchstart', 'wheel'].forEach(function (ev) {
    window.addEventListener(ev, bump, { passive: true, capture: true });
  });
  var lastMove = 0;
  window.addEventListener('mousemove', function () { var n = Date.now(); if (n - lastMove > 5000) { lastMove = n; bump(); } }, { passive: true });

  // Heartbeat.
  setInterval(function () {
    accrue();
    if (!pv || document.visibilityState !== 'visible') return;
    if (Date.now() - lastInput > IDLE) return;        // idle → drop off "live now"
    if (pv.ms !== lastSentMs) { session(true); send('hb'); }
  }, HEARTBEAT);
  setInterval(accrue, 5000);

  // Tab/hash changes inside a page count as a new view.
  function checkScreen() {
    if (!pv) return;
    var k = screen();
    if (k === pv.key) return;
    accrue(); send('end');
    newView();
  }
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    if (!orig) return;
    history[m] = function () { var r = orig.apply(this, arguments); setTimeout(checkScreen, 0); return r; };
  });
  window.addEventListener('hashchange', checkScreen);
  window.addEventListener('popstate', checkScreen);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      accrue(); hiddenAt = Date.now(); send('hide');
    } else {
      lastTick = Date.now(); lastInput = Date.now();
      // Back after a long break → a fresh visit, not one 9-hour page view.
      if (hiddenAt && Date.now() - hiddenAt > SESSION_GAP) { hiddenAt = 0; newView(); }
      else { hiddenAt = 0; session(true); send('hb'); }
    }
  });
  window.addEventListener('pagehide', function () { accrue(); send('end'); });

  newView();
})();
