// ═══════════════════════════════════════════════════════════════
// hero-rotate.js — The Dink Society
// Cross-fades a hero background through several images.
//
//   dsHeroRotate(el, ['/a.jpg', '/b.jpg'], { interval: 7000 })
//
// Images come from a Site Images slot (admin → Site Images): upload more than
// one to a slot and that page's hero starts rotating. One image = a plain
// static background, exactly as before.
//
// How it works: a clone of the hero element is stacked directly on top (same
// class, so it inherits every background/filter rule from CSS). The next image
// is loaded into whichever layer is hidden, that layer fades in, then the two
// swap roles. Nothing is animated until the image has actually decoded, so a
// slow photo never fades in half-drawn.
//
// Pauses while the tab is hidden, and never animates for visitors who ask for
// reduced motion (they get the first image, static).
// ═══════════════════════════════════════════════════════════════
(function () {
  var FADE_MS = 900;

  function cssUrl(u) { return 'url("' + String(u).replace(/"/g, '%22') + '")'; }

  function preload(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(url); };
      img.onerror = function () { reject(new Error('hero image failed: ' + url)); };
      img.src = url;
    });
  }

  window.dsHeroRotate = function (el, urls, opts) {
    if (!el || !Array.isArray(urls)) return;
    var list = urls.filter(Boolean);
    if (!list.length) return;

    opts = opts || {};
    var interval = Math.max(2000, opts.interval || 7000);
    // The placeholder gradient class the page uses before an image lands.
    var phClass = opts.placeholderClass || '';

    function paint(node, url) {
      if (phClass) node.classList.remove(phClass);
      node.classList.remove('page-hero__bg--fallback');
      node.style.backgroundImage = cssUrl(url);
    }

    // First image goes up straight away — no fade on initial paint.
    preload(list[0]).then(function () { paint(el, list[0]); }).catch(function () {});

    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (list.length < 2 || reduced) return;

    // Second layer, stacked on top of the original.
    var top = el.cloneNode(false);
    top.removeAttribute('id');
    // Only the original should answer the [data-hero-slot] lookup.
    top.removeAttribute('data-hero-slot');
    if (phClass) top.classList.remove(phClass);
    top.classList.remove('page-hero__bg--fallback');
    top.style.backgroundImage = '';
    top.style.opacity = '0';
    top.style.transition = 'opacity ' + FADE_MS + 'ms ease-in-out';
    top.setAttribute('aria-hidden', 'true');
    el.parentNode.insertBefore(top, el.nextSibling);

    var back = el;    // currently visible
    var front = top;  // hidden layer we paint the next image into
    var i = 0;
    var busy = false;

    function step() {
      if (busy || document.hidden) return;
      busy = true;
      var next = list[(i + 1) % list.length];
      preload(next).then(function () {
        paint(front, next);
        // Let the paint land before starting the fade.
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            front.style.opacity = '1';
            setTimeout(function () {
              // Fade done: copy the image down to the back layer, then reset
              // the front layer to transparent with no transition so the swap
              // is invisible.
              paint(back, next);
              front.style.transition = 'none';
              front.style.opacity = '0';
              // Force a reflow so 'none' applies before the transition returns.
              void front.offsetHeight;
              front.style.transition = 'opacity ' + FADE_MS + 'ms ease-in-out';
              i = (i + 1) % list.length;
              busy = false;
            }, FADE_MS + 60);
          });
        });
      }).catch(function () {
        // Bad URL — skip it and keep the rotation going.
        list.splice((i + 1) % list.length, 1);
        busy = false;
        if (list.length < 2) clearInterval(timer);
      });
    }

    var timer = setInterval(step, interval);
    // Don't burn cycles (or stack up fades) on a background tab.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) busy = false;
    });
  };
})();
