// ═══════════════════════════════════════════════════════════════
// partials.js — The Dink Society
// Loads HTML partials into [data-partial] slots.
// Example: <div data-partial="nav"></div> fetches /partials/nav.html
// ═══════════════════════════════════════════════════════════════

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
      } catch (err) {
        console.warn(`[partials] Could not load "${name}":`, err);
      }
    })
  );
})();
