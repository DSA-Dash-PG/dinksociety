// ═══════════════════════════════════════════════════════════════
// partials.js — The Dink Society
// Loads HTML partials into [data-partial] slots.
// Example: <div data-partial="nav"></div> fetches /partials/nav.html
// ═══════════════════════════════════════════════════════════════

// Central settings fetch — ONE request shared site-wide.
// Starts as a promise; nav.html awaits it and then replaces it with the
// resolved object so existing synchronous readers (captain.html,
// register.html) keep working once it has loaded.
//
// public-settings, NOT admin-settings: this response is readable by anyone who
// opens the site, so it carries only the fields the public pages render (venue,
// fees, season length, planned week dates). admin-settings is admin-only.
window.DS_SETTINGS = fetch('/.netlify/functions/public-settings').then(r => r.json()).catch(() => ({}));

(async function loadPartials() {
  // Partials may themselves contain [data-partial] slots (footer.html nests
  // the live ticker), so fill recursively rather than scanning once. `seen`
  // guards against a partial that includes itself.
  const seen = new Set();

  async function fillAll(root) {
    const slots = root.querySelectorAll('[data-partial]');
    if (!slots.length) return;
    await Promise.all(Array.from(slots).map(fill));
  }

  async function fill(slot) {
    const name = slot.getAttribute('data-partial');
    if (!name || slot.dataset.partialLoaded) return;
    if (seen.has(name)) return;
    seen.add(name);
    slot.dataset.partialLoaded = '1';

    try {
      const res = await fetch(`/partials/${name}.html`);
      if (!res.ok) return; // Silently skip missing partials
      slot.innerHTML = await res.text();

      // Nested slots first, so any scripts we run below see a complete DOM.
      await fillAll(slot);

      // Re-run any <script> tags inside the partial so event
      // listeners (hamburger, drawer, etc.) get wired up.
      slot.querySelectorAll('script').forEach((oldScript) => {
        const newScript = document.createElement('script');
        for (const attr of oldScript.attributes) {
          newScript.setAttribute(attr.name, attr.value);
        }
        newScript.textContent = oldScript.textContent;
        oldScript.parentNode.replaceChild(newScript, oldScript);
      });

      // Single source of truth for the active nav link.
      if (name === 'nav') highlightNav();
    } catch (err) {
      console.warn(`[partials] Could not load "${name}":`, err);
    }
  }

  await fillAll(document);
})();

// ═══════════════════════════════════════════════════════════════
// highlightNav — marks the current page's nav link with .is-active.
// Reads location.pathname (NOT body[data-page]; the inline data-page
// script that used to live in partials/nav.html has been removed).
// ═══════════════════════════════════════════════════════════════
function highlightNav() {
  const path = location.pathname;
  let key = null;

  if (path.includes('drop'))             key = 'drop';
  else if (path.includes('nvz'))         key = 'nvz';
  else if (path.includes('schedule'))    key = 'schedule';
  else if (path.includes('standing'))    key = 'standings';
  else if (path.includes('leaderboard')) key = 'leaderboard';
  // /queen.html and /ladders.html both light up the Ladders dropdown.
  // Checked after 'leaderboard' so that page keeps its own key.
  else if (path.includes('queen') || path.includes('ladder')) key = 'ladders';
  else if (path.includes('stats'))       key = 'stats';
  else if (path.includes('team'))        key = 'teams';
  else if (path.includes('gallery') || path.includes('moments')) key = 'gallery';
  else if (path.includes('rules'))       key = 'rules';
  else if (path.includes('contact'))     key = 'contact';
  else if (path.includes('register'))    key = 'register';
  else if (path.includes('me.') || path.includes('player')) key = 'player';
  else if (path === '/' || path.includes('index')) key = 'home';

  if (!key) return;
  document.querySelectorAll('[data-nav]').forEach((link) => {
    if (link.getAttribute('data-nav') === key) {
      link.classList.add('is-active');
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// Page analytics — loads /js/ds-track.js (who's on the site, which pages,
// how long). It also feeds the older anonymous daily counter server-side, so
// the admin Analytics tab keeps working. Portal pages that don't load
// partials.js include ds-track.js with their own <script> tag; the script
// guards against running twice.
// ═══════════════════════════════════════════════════════════════
(function loadTracker() {
  try {
    if (window.__dsTrack) return;
    var s = document.createElement('script');
    s.src = '/js/ds-track.js';
    s.defer = true;
    document.head.appendChild(s);
  } catch (e) {}
})();

// ═══════════════════════════════════════════════════════════════
// Keep-warm ping — fires every 4 minutes while the tab is visible,
// so Netlify functions stay warm during active browsing.
// ═══════════════════════════════════════════════════════════════
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  fetch('/.netlify/functions/ping').catch(() => {});
}, 4 * 60 * 1000);