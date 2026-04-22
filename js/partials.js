/* =========================================================
   partials.js — The Dink Society
   Loads HTML partials (nav, footer, ticker) into
   <div data-partial="…"> slots, then wires interactivity.
   ========================================================= */
(function () {
  'use strict';

  var PARTIALS_DIR = '/partials/';
  var slots = document.querySelectorAll('[data-partial]');

  if (!slots.length) return;

  var pending = slots.length;

  slots.forEach(function (slot) {
    var name = slot.getAttribute('data-partial');
    var url  = PARTIALS_DIR + name + '.html';

    fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.text();
      })
      .then(function (html) {
        slot.innerHTML = html;
      })
      .catch(function () {
        /* partial not found — leave slot empty */
      })
      .finally(function () {
        pending--;
        if (pending === 0) onAllLoaded();
      });
  });

  function onAllLoaded() {
    highlightNav();
    initBurger();
  }

  /* — Highlight active nav link based on <body data-page> — */
  function highlightNav() {
    var page = document.body.getAttribute('data-page');
    if (!page) return;

    document.querySelectorAll('[data-nav]').forEach(function (a) {
      if (a.getAttribute('data-nav') === page) {
        a.classList.add('is-active');
      }
    });
  }

  /* — Mobile hamburger drawer — */
  function initBurger() {
    var btn    = document.querySelector('.ds-nav__burger');
    var drawer = document.querySelector('.ds-nav__drawer');
    var bg     = document.querySelector('.ds-nav__drawer-bg');

    if (!btn || !drawer) return;

    function open() {
      btn.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      drawer.classList.add('is-open');
      if (bg) bg.classList.add('is-visible');
      document.body.style.overflow = 'hidden';
    }

    function close() {
      btn.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      drawer.classList.remove('is-open');
      if (bg) bg.classList.remove('is-visible');
      document.body.style.overflow = '';
    }

    btn.addEventListener('click', function () {
      var isOpen = btn.classList.contains('is-open');
      isOpen ? close() : open();
    });

    if (bg) bg.addEventListener('click', close);

    /* Close on Escape key */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && btn.classList.contains('is-open')) close();
    });
  }
})();
