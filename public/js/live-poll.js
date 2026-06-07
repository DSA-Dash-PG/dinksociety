// public/js/live-poll.js
//
// Shared "live refresh" poller — the client half of the ESPN-style pipeline.
// Server half: netlify/functions/lib/http-cache.js (ETag + 304s).
//
// Polls a JSON endpoint with If-None-Match so unchanged data costs one
// empty 304. Pauses while the tab is hidden, fires an immediate catch-up
// poll when it becomes visible again, and supports an adaptive interval
// (e.g. fast during a live match, slow otherwise, off overnight).
//
// Usage:
//   const poller = DSLivePoll.create({
//     url: '/.netlify/functions/public-standings?season=circuit-i',
//     interval: 30000,                    // ms, or a function → ms (0/null = idle)
//     fetchOpts: { credentials: 'include' },
//     onUpdate(data) { ... },             // only called when the payload CHANGED
//     onError(err)  { ... },              // optional; polling continues regardless
//   });
//   poller.start();      // also polls immediately
//   poller.stop();
//   poller.pollNow();    // force a poll (e.g. after the user submits something)
//
// Idle behavior: when interval() returns 0/null the poller stays alive but
// dormant, re-checking every IDLE_RECHECK_MS so it can wake up when a match
// window opens without a page reload.

(function () {
  'use strict';

  const IDLE_RECHECK_MS = 5 * 60 * 1000; // dormant pollers re-evaluate every 5 min

  function create(opts) {
    const { url, fetchOpts = {}, onUpdate, onError } = opts;
    let etag = opts.etag || null;   // seed from an initial fetch if you have one
    let timer = null;
    let running = false;
    let inFlight = false;

    const intervalMs = () =>
      typeof opts.interval === 'function' ? (opts.interval() || 0) : (opts.interval || 0);

    async function poll() {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const headers = Object.assign({}, fetchOpts.headers);
        if (etag) headers['If-None-Match'] = etag;
        const res = await fetch(url, Object.assign({}, fetchOpts, { headers }));
        if (res.status === 304) return;        // nothing changed — cheapest outcome
        if (!res.ok) throw new Error('poll failed: ' + res.status);
        etag = res.headers.get('ETag') || etag;
        const data = await res.json();
        if (onUpdate) onUpdate(data);
      } catch (err) {
        if (onError) onError(err);             // swallow otherwise: polling is best-effort
      } finally {
        inFlight = false;
        schedule();
      }
    }

    function schedule() {
      if (!running) return;
      clearTimeout(timer);
      const ms = intervalMs();
      // 0/null = idle right now (e.g. no match today) — recheck later.
      timer = setTimeout(poll, ms > 0 ? ms : IDLE_RECHECK_MS);
    }

    function onVisibility() {
      if (document.hidden) {
        clearTimeout(timer);                   // sleep with the tab
      } else if (running) {
        poll();                                // instant catch-up, then reschedule
      }
    }

    return {
      start() {
        if (running) return;
        running = true;
        document.addEventListener('visibilitychange', onVisibility);
        poll();
      },
      stop() {
        running = false;
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onVisibility);
      },
      pollNow() { if (running) { clearTimeout(timer); poll(); } },
      setEtag(t) { etag = t; },
    };
  }

  window.DSLivePoll = { create };
})();
