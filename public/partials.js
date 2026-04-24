/* =========================================================
   Partials loader + active-nav highlighter
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
})();
