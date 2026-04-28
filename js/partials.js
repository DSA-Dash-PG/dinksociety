(async function loadPartials() {
  const slots = document.querySelectorAll('[data-partial]');
  if (!slots.length) return;
  await Promise.all(Array.from(slots).map(async (slot) => {
    const name = slot.getAttribute('data-partial');
    if (!name) return;
    try {
      const res = await fetch(`/partials/${name}.html`);
      if (!res.ok) return;
      slot.innerHTML = await res.text();
      slot.querySelectorAll('script').forEach(old => {
        const s = document.createElement('script');
        for (const a of old.attributes) s.setAttribute(a.name, a.value);
        s.textContent = old.textContent;
        old.parentNode.replaceChild(s, old);
      });
    } catch (e) { console.warn(`[partials] ${name}:`, e); }
  }));
})();
