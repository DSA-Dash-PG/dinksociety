/* =========================================================
   Partials loader + active-nav highlighter + season propagation
   ========================================================= */
(function () {
  // Load partials
  document.querySelectorAll('[data-partial]').forEach(async (el) => {
    const name = el.getAttribute('data-partial');
    try {
      const res = await fetch(`/partials/${name}.html`);
      if (res.ok) {
        el.innerHTML = await res.text();
        if (name === 'nav') highlightNav();
        propagateSeasonLinks(el); // keep nav/footer in the current season context
      }
    } catch (e) {
      console.warn(`Partial "${name}" failed to load`, e);
    }
  });

  function highlightNav() {
    const path = location.pathname;
    let key = 'home';

    if (path.includes('schedule'))    key = 'schedule';
    else if (path.includes('standing'))  key = 'standings';
    else if (path.includes('leaderboard')) key = 'leaderboard';
    else if (path.includes('stats'))     key = 'stats';
    else if (path.includes('team'))      key = 'teams';
    else if (path.includes('gallery') || path.includes('moments')) key = 'gallery';
    else if (path.includes('rules'))     key = 'rules';
    else if (path.includes('contact'))   key = 'contact';
    else if (path.includes('register'))  key = 'register';
    else if (path === '/' || path.includes('index')) key = 'home';

    document.querySelectorAll('[data-nav]').forEach((link) => {
      if (link.getAttribute('data-nav') === key) {
        link.classList.add('is-active');
      }
    });
  }

  // If the current page is viewing a non-default season (e.g. the test season
  // via ?season=circuit-test or ?circuit=TEST), carry that context onto the
  // nav/footer links so navigating the site stays in that season.
  //
  // TODO: make this mapping data-driven instead of string manipulation.
  // The admin-settings response (window.DS_SETTINGS) currently has NO
  // season↔circuit mapping — only display fields (circuitName, startDate,
  // fees, etc.). To do this properly, admin-settings would need to return
  // something like:
  //   seasons: [
  //     { id: 'circuit-i',    circuit: 'I',    default: true  },
  //     { id: 'circuit-test', circuit: 'TEST', default: false },
  //   ]
  // i.e. one entry per season with its blob-store season id, its circuit
  // code (the standings/player-stats storage key), and a default flag so
  // the "nothing to carry" check stops hardcoding 'circuit-i' / 'I'.
  // Until that field exists, the string-derivation below
  // ('circuit-<x>' ↔ uppercase code) is the safe fallback — it matches
  // the same convention used server-side in netlify/functions/lib/circuit.js.
  function seasonContext() {
    const q = new URLSearchParams(location.search);
    let season = q.get('season');
    let circuit = q.get('circuit');
    if (!season && !circuit) return null;
    if (season && !circuit) circuit = season.replace('circuit-', '').toUpperCase();
    if (circuit && !season) season = 'circuit-' + circuit.toLowerCase();
    if (season === 'circuit-i' || circuit === 'I') return null; // default season — nothing to carry
    return { season, circuit };
  }

  function propagateSeasonLinks(root) {
    const ctx = seasonContext();
    if (!ctx) return;
    root.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (!href || /^(https?:|#|mailto:|tel:)/i.test(href)) return;
      let url;
      try { url = new URL(href, location.origin); } catch { return; }
      const path = url.pathname;
      const circuitPage = /(leaderboard|stats)/.test(path);
      const seasonPage  = /(standings|teams|team|player|schedule)/.test(path);
      if (!circuitPage && !seasonPage) return;
      if (circuitPage) {
        if (!url.searchParams.has('circuit')) url.searchParams.set('circuit', ctx.circuit);
      } else {
        if (!url.searchParams.has('season')) url.searchParams.set('season', ctx.season);
      }
      a.setAttribute('href', url.pathname + url.search + url.hash);
    });
  }
})();
