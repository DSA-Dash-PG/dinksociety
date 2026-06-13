// ═══════════════════════════════════════════════════════════════
// partials.js — The Dink Society
// Loads HTML partials into [data-partial] slots.
// Example: <div data-partial="nav"></div> fetches /partials/nav.html
// ═══════════════════════════════════════════════════════════════

// Central admin-settings fetch — ONE request shared site-wide.
// Starts as a promise; nav.html awaits it and then replaces it with the
// resolved object so existing synchronous readers (captain.html,
// register.html) keep working once it has loaded.
window.DS_SETTINGS = fetch('/.netlify/functions/admin-settings').then(r => r.json()).catch(() => ({}));

(async function loadPartials() {
  const slots = document.querySelectorAll('[data-partial]');
  if (!slots.length) return;

  await Promise.all(
    Array.from(slots).map(async (slot) => {
      const name = slot.getAttribute('data-partial');
      if (!name) return;
      try {
        const res = await fetch(`/partials/${name}.html`);
        if (!res.ok) return; // Silently skip missing partials
        const html = await res.text();
        slot.innerHTML = html;

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
    })
  );
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
  else if (path.includes('schedule'))    key = 'schedule';
  else if (path.includes('standing'))    key = 'standings';
  else if (path.includes('leaderboard')) key = 'leaderboard';
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
// Anonymous pageview beacon — counts public-page traffic for the admin
// Analytics tab. No PII: ds_vid is a random per-browser id used only to
// estimate daily uniques. partials.js loads on public pages ONLY (not the
// me/captain/admin portals), so this never double-counts authed sessions.
// Fire-and-forget; one hit per page load.
// ═══════════════════════════════════════════════════════════════
(function trackPublicPageview() {
  try {
    let vid = localStorage.getItem('ds_vid');
    if (!vid) {
      vid = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : (Date.now().toString(36) + Math.random().toString(16).slice(2));
      localStorage.setItem('ds_vid', vid);
    }
    const body = JSON.stringify({ path: location.pathname, vid });
    const url = '/.netlify/functions/activity-public';
    if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    else fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch {}
})();

// ═══════════════════════════════════════════════════════════════
// Keep-warm ping — fires every 4 minutes while the tab is visible,
// so Netlify functions stay warm during active browsing.
// ═══════════════════════════════════════════════════════════════
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  fetch('/.netlify/functions/ping').catch(() => {});
}, 4 * 60 * 1000);