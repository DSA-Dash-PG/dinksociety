// public/js/recap-photos.js
// The recap photo layer, shared by every ladder recap page.
//
//   <script src="/js/recap-photos.js" data-event="<eventId>" defer></script>
//
// Pulls the night's album (public-ladder-photos?event=…) and weaves it into
// the article: the cover shot goes full-bleed behind the headline, two photos
// float into the copy, and the whole album lands as a grid at the end — every
// photo opening a small keyboard/tap lightbox. The page is not touched at all
// until an album actually exists, so a recap with no photos renders exactly
// as authored; upload photos to the night later and its recap lights up on
// the next visit with no edit here.
//
// Styles are injected from this file (they lean on the recap pages' shared
// CSS variables: --surf1, --surf3, --gold, --lime, --txt, --txt-faint), so a
// recap needs exactly one line to opt in. data-figs="0" turns off the inline
// article photos for a night whose story shouldn't be interrupted.
(function () {
  var script = document.currentScript;
  var EVENT_ID = script && script.dataset.event;
  if (!EVENT_ID) return;
  var FIGS = script.dataset.figs != null ? parseInt(script.dataset.figs, 10) : 2;

  var CSS = [
    '.rhero{position:relative;border-radius:18px;overflow:hidden;min-height:300px;display:flex;align-items:flex-end;margin-bottom:28px;background:var(--surf1)}',
    '.rhero .rh-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
    '.rhero::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(14,14,14,.3),rgba(14,14,14,.95) 90%)}',
    '.rhero .rh-tx{position:relative;z-index:2;padding:26px 26px 22px}',
    '.rhero h1{max-width:24ch;text-wrap:balance}',
    '.rhero .sub{margin-bottom:0}',
    '@media (max-width:640px){.rhero{min-height:230px}.rhero .rh-tx{padding:18px 16px 16px}}',
    '.rph{float:right;width:46%;margin:6px 0 12px 20px;border-radius:12px;overflow:hidden;border:1px solid var(--surf3);cursor:pointer;background:var(--surf1)}',
    '.rph img{width:100%;display:block}',
    '.rph figcaption{font-size:11px;color:var(--txt-faint);padding:7px 10px 9px}',
    '@media (max-width:640px){.rph{float:none;width:100%;margin:8px 0 14px}}',
    '.album-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}',
    '.album-grid a{display:block;border-radius:10px;overflow:hidden;aspect-ratio:4/3;border:1px solid var(--surf3)}',
    '.album-grid img{width:100%;height:100%;object-fit:cover;display:block}',
    '.album-cta{display:inline-block;margin-top:14px;font-size:13px;font-weight:800;color:var(--lime);text-decoration:none;border-bottom:2px solid var(--lime);padding-bottom:2px}',
    '.rlb{position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.94);display:none;align-items:center;justify-content:center;padding:20px}',
    '.rlb.on{display:flex}',
    '.rlb img{max-width:min(1100px,94vw);max-height:92vh;border-radius:10px}',
    '.rlb button{position:absolute;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);color:#fff;border-radius:9999px;cursor:pointer;font-size:20px;line-height:1;width:44px;height:44px}',
    '.rlb .x{top:16px;right:16px}',
    '.rlb .pv{left:12px;top:50%;transform:translateY(-50%)}',
    '.rlb .nx{right:12px;top:50%;transform:translateY(-50%)}',
  ].join('\n');

  var PH = [], CUR = 0, lb = null, lbImg = null;

  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  // Admin-set focal point (Photos tab → Focus) → object-position, so crops
  // keep faces in frame everywhere a photo is cover-fitted.
  function fpos(p) {
    var x = Number.isFinite(p.fx) ? p.fx : 50, y = Number.isFinite(p.fy) ? p.fy : 50;
    return x + '% ' + y + '%';
  }

  function buildLb() {
    lb = el('div', 'rlb');
    lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', 'Photo viewer');
    var x = el('button', 'x'); x.innerHTML = '&times;'; x.setAttribute('aria-label', 'Close');
    var pv = el('button', 'pv'); pv.innerHTML = '&#8249;'; pv.setAttribute('aria-label', 'Previous');
    var nx = el('button', 'nx'); nx.innerHTML = '&#8250;'; nx.setAttribute('aria-label', 'Next');
    lbImg = el('img'); lbImg.alt = '';
    lb.appendChild(x); lb.appendChild(pv); lb.appendChild(lbImg); lb.appendChild(nx);
    document.body.appendChild(lb);
    x.onclick = closeLb;
    pv.onclick = function (e) { e.stopPropagation(); step(-1); };
    nx.onclick = function (e) { e.stopPropagation(); step(1); };
    lb.addEventListener('click', function (e) { if (e.target === lb) closeLb(); });
    document.addEventListener('keydown', function (e) {
      if (!lb.classList.contains('on')) return;
      if (e.key === 'Escape') closeLb();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    });
  }
  function openLb(i) { if (i < 0 || i >= PH.length) return; CUR = i; lbImg.src = PH[i].url; lb.classList.add('on'); document.body.style.overflow = 'hidden'; }
  function closeLb() { lb.classList.remove('on'); document.body.style.overflow = ''; lbImg.src = ''; }
  function step(n) { var i = CUR + n; if (i >= 0 && i < PH.length) { CUR = i; lbImg.src = PH[i].url; } }

  function fig(p) {
    var f = el('figure', 'rph');
    var img = el('img');
    img.src = p.thumb; img.alt = p.caption || 'Photo from the night'; img.loading = 'lazy';
    img.style.objectPosition = fpos(p);
    f.appendChild(img);
    if (p.caption) { var c = el('figcaption'); c.textContent = p.caption; f.appendChild(c); }
    f.onclick = function () { openLb(PH.indexOf(p)); };
    return f;
  }

  // Wrap the standard recap header (.eyebrow + h1 + .sub at the top of .wrap)
  // in the hero frame and slide the cover shot behind it.
  function buildHero(cover) {
    var wrap = document.querySelector('.wrap');
    var eyebrow = wrap && wrap.querySelector(':scope > .eyebrow');
    var h1 = wrap && wrap.querySelector(':scope > h1');
    var sub = wrap && wrap.querySelector(':scope > .sub, :scope > p.sub');
    if (!wrap || !eyebrow || !h1) return;
    var hero = el('div', 'rhero'), tx = el('div', 'rh-tx');
    var img = el('img', 'rh-img'); img.alt = ''; img.src = cover.url;
    img.style.objectPosition = fpos(cover);
    hero.appendChild(img); hero.appendChild(tx);
    wrap.insertBefore(hero, eyebrow);
    tx.appendChild(eyebrow); tx.appendChild(h1); if (sub) tx.appendChild(sub);
  }

  function buildAlbum(a) {
    var wrap = document.querySelector('.wrap');
    if (!wrap) return;
    var sec = el('section');
    var h2 = el('h2'); h2.innerHTML = '&#128248; From the night'; sec.appendChild(h2);
    var sub = el('p', 'chart-sub');
    sub.textContent = a.count + ' photo' + (a.count === 1 ? '' : 's') + ' from the night — tap any to open';
    sec.appendChild(sub);
    var grid = el('div', 'album-grid');
    PH.forEach(function (p, i) {
      var link = el('a'); link.href = p.url;
      var t = el('img'); t.src = p.thumb; t.alt = p.caption || 'Photo from the night'; t.loading = 'lazy';
      t.style.objectPosition = fpos(p);
      link.appendChild(t);
      link.onclick = function (e) { e.preventDefault(); openLb(i); };
      grid.appendChild(link);
    });
    sec.appendChild(grid);
    if (a.type === 'womens') {
      var cta = el('a', 'album-cta'); cta.href = '/queen.html#gallery'; cta.innerHTML = 'See the full Queen gallery &rarr;';
      sec.appendChild(cta);
    }
    // One gallery, mid-page: right after the KPI card row when the page has
    // one, so the photos break up the stats instead of trailing the table.
    var kpi = wrap.querySelector('.kpirow');
    if (kpi && kpi.nextSibling) wrap.insertBefore(sec, kpi.nextSibling);
    else wrap.appendChild(sec);
  }

  // A recap that shipped with its own photo section (the pre-shared-layer
  // pattern) would otherwise show two galleries — this layer is canonical.
  function removeLegacyGallery() {
    var s1 = document.getElementById('night-photos'); if (s1) s1.remove();
    var s2 = document.getElementById('phtLb'); if (s2) s2.remove();
  }

  function run() {
    fetch('/.netlify/functions/public-ladder-photos?event=' + encodeURIComponent(EVENT_ID))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var a = (d.albums || [])[0];
        if (!a || !a.photos || !a.photos.length) return;   // no album → untouched page
        PH = a.photos;
        removeLegacyGallery();

        var style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
        buildLb();

        buildHero(PH[0]);

        // Photos floated into the article — after the lede, and by the close.
        var ps = document.querySelectorAll('.article > p');
        if (FIGS >= 1 && PH[1] && ps[1]) ps[1].parentNode.insertBefore(fig(PH[1]), ps[1]);
        if (FIGS >= 2 && PH[2] && ps.length > 3) ps[ps.length - 1].parentNode.insertBefore(fig(PH[2]), ps[ps.length - 1]);

        buildAlbum(a);
      })
      .catch(function () { /* photo layer is optional — the article stands alone */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
