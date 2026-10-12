// ═══════════════════════════════════════════════════════════════
// heic-upload.js — The Dink Society
// Site-wide iPhone photo (HEIC/HEIF) support for every file upload.
//
// Most browsers outside Safari can't read HEIC, so every page's own
// canvas-compress / <img> preview step failed on iPhone photos. This file
// fixes that once, for every <input type="file"> on the page:
//
//  1. Widens each image input's `accept` so .heic/.heif files are pickable
//     on desktop (skipped on iPhone/iPad, where iOS already hands the page a
//     JPEG when the input doesn't ask for HEIC).
//  2. Catches the input's `change` event before the page's own handler,
//     converts any HEIC file to a JPEG, swaps it into input.files, then
//     re-fires `change` — so existing upload code just sees a normal JPEG.
//
// Decoding tries the browser first (Safari reads HEIC natively) and falls
// back to the self-hosted decoder at /js/vendor/heic-to.js, which only
// loads the first time someone actually picks an HEIC.
//
// For drag-and-drop or other custom pickers: await DSImage.normalize(file).
// ═══════════════════════════════════════════════════════════════
(function () {
  if (window.DSImage) return;

  var DECODER_URL = '/js/vendor/heic-to.js';
  var MAX_EDGE = 4096;          // long edge cap for converted photos
  var QUALITY = 0.9;
  var HEIC_ACCEPT = 'image/heic,image/heif,.heic,.heif';
  var IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var refired = new WeakSet();

  // ── detection ──────────────────────────────────────────────
  var BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];
  function looksHeic(file) {
    if (!file) return false;
    var t = (file.type || '').toLowerCase();
    return /image\/hei[cf]/.test(t) || /\.hei[cf]$/i.test(file.name || '');
  }
  async function sniffHeic(file) {
    if (looksHeic(file)) return true;
    var t = (file.type || '').toLowerCase();
    if (t && t !== 'application/octet-stream') return false;   // known non-HEIC type
    try {
      var b = new Uint8Array(await file.slice(4, 12).arrayBuffer());
      var box = String.fromCharCode(b[0], b[1], b[2], b[3]);
      var brand = String.fromCharCode(b[4], b[5], b[6], b[7]);
      return box === 'ftyp' && BRANDS.indexOf(brand) !== -1;
    } catch (_) { return false; }
  }

  // ── decoding ───────────────────────────────────────────────
  function jpegName(name) { return (name || 'photo').replace(/\.[^.]+$/, '') + '.jpg'; }

  function drawToJpeg(source, w, h) {
    var k = Math.min(1, MAX_EDGE / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return new Promise(function (ok, bad) {
      c.toBlob(function (b) { c.width = c.height = 1; b ? ok(b) : bad(new Error('encode failed')); }, 'image/jpeg', QUALITY);
    });
  }

  function loadImage(blob) {
    return new Promise(function (ok, bad) {
      var u = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { URL.revokeObjectURL(u); ok(img); };
      img.onerror = function () { URL.revokeObjectURL(u); bad(new Error('not decodable')); };
      img.src = u;
    });
  }

  var decoderP = null;
  function loadDecoder() {
    if (window.HeicTo) return Promise.resolve(window.HeicTo);
    if (decoderP) return decoderP;
    decoderP = new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = DECODER_URL; s.async = true;
      s.onload = function () { window.HeicTo ? ok(window.HeicTo) : bad(new Error('decoder missing')); };
      s.onerror = function () { decoderP = null; bad(new Error('Could not load the photo converter — check your connection')); };
      document.head.appendChild(s);
    });
    return decoderP;
  }

  async function heicToJpeg(file) {
    // 1) Native (Safari / iOS / macOS read HEIC directly).
    try {
      var img = await loadImage(file);
      if (img.naturalWidth) return await drawToJpeg(img, img.naturalWidth, img.naturalHeight);
    } catch (_) { /* fall through to the decoder */ }
    // 2) Bundled decoder.
    var HeicTo = await loadDecoder();
    var jpeg = await HeicTo({ blob: file, type: 'image/jpeg', quality: QUALITY });
    // Re-encode only if it's larger than our cap (48 MP iPhone shots).
    var out = await loadImage(jpeg);
    if (Math.max(out.naturalWidth, out.naturalHeight) > MAX_EDGE) {
      return drawToJpeg(out, out.naturalWidth, out.naturalHeight);
    }
    return jpeg;
  }

  // Returns a JPEG File for HEIC input; any other file comes back unchanged.
  async function normalize(file) {
    if (!file || !(await sniffHeic(file))) return file;
    var blob = await heicToJpeg(file);
    return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified || Date.now() });
  }

  // ── status pill ────────────────────────────────────────────
  var pill = null, pillT = null;
  function say(msg, isErr, hold) {
    if (!document.body) return;
    if (!pill) {
      pill = document.createElement('div');
      pill.setAttribute('role', 'status');
      pill.setAttribute('aria-live', 'polite');
      pill.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;' +
        'padding:10px 18px;border-radius:9999px;font:600 13px/1.3 Inter,system-ui,sans-serif;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.45);max-width:calc(100vw - 32px);text-align:center;pointer-events:none;' +
        'transition:opacity .2s;opacity:0';
      document.body.appendChild(pill);
    }
    clearTimeout(pillT);
    pill.textContent = msg;
    pill.style.background = isErr ? '#3a1414' : '#161616';
    pill.style.color = isErr ? '#ff8a8a' : '#b8ff2c';
    pill.style.border = '1px solid ' + (isErr ? '#ff5a5a55' : '#b8ff2c55');
    pill.style.opacity = '1';
    if (!hold) pillT = setTimeout(function () { pill.style.opacity = '0'; }, isErr ? 6000 : 1800);
  }

  // ── 1. let desktop pickers show .heic files ────────────────
  function widen(input) {
    if (IOS || !input || input.dataset.dsHeic) return;
    var a = input.getAttribute('accept');
    if (!a || !/image\/|\.jpe?g|\.png/i.test(a) || /hei[cf]/i.test(a)) return;
    input.dataset.dsHeic = '1';
    input.setAttribute('accept', a + ',' + HEIC_ACCEPT);
  }
  function widenAll(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches('input[type=file]')) widen(root);
    root.querySelectorAll('input[type=file]').forEach(widen);
  }

  // ── 2. convert on change, before the page's handler runs ───
  // Decided synchronously from name/type so plain JPG/PNG picks are never
  // delayed; typeless files are byte-sniffed inside process().
  document.addEventListener('change', function (e) {
    var input = e.target;
    if (!input || input.tagName !== 'INPUT' || input.type !== 'file') return;
    if (refired.has(e)) return;
    var files = Array.prototype.slice.call(input.files || []);
    var suspect = files.some(function (f) {
      var t = (f.type || '').toLowerCase();
      return looksHeic(f) || !t || t === 'application/octet-stream';
    });
    if (!suspect) return;                                    // plain JPG/PNG/etc — untouched
    e.stopImmediatePropagation();
    process(input, files);
  }, true);

  async function process(input, files) {
    var heicIdx = [];
    for (var i = 0; i < files.length; i++) if (await sniffHeic(files[i])) heicIdx.push(i);
    var out = files.slice(), failed = 0;
    if (heicIdx.length) {
      input.dataset.dsConverting = '1';
      for (var j = 0; j < heicIdx.length; j++) {
        var n = heicIdx[j];
        say(heicIdx.length > 1 ? 'Converting iPhone photo ' + (j + 1) + ' of ' + heicIdx.length + '…'
                               : 'Converting iPhone photo…', false, true);
        try { out[n] = await normalize(files[n]); }
        catch (err) { console.warn('[heic-upload]', err); out[n] = null; failed++; }
      }
      delete input.dataset.dsConverting;
      out = out.filter(Boolean);
      if (failed) say(failed === heicIdx.length && !out.length
        ? 'Couldn’t convert that iPhone photo. On your iPhone, set Settings › Camera › Formats to “Most Compatible”, or export it as JPG.'
        : failed + ' photo' + (failed > 1 ? 's' : '') + ' couldn’t be converted and ' + (failed > 1 ? 'were' : 'was') + ' skipped.', true);
      else say(heicIdx.length > 1 ? 'Photos ready' : 'Photo ready');
    }
    try {
      var dt = new DataTransfer();
      out.forEach(function (f) { dt.items.add(f); });
      input.files = dt.files;
    } catch (err) { console.warn('[heic-upload] could not replace files', err); }
    if (!out.length) { input.value = ''; return; }
    var ev = new Event('change', { bubbles: true });
    refired.add(ev);
    input.dispatchEvent(ev);
  }

  function boot() {
    widenAll(document);
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        if (m.type === 'attributes') widen(m.target);
        else m.addedNodes.forEach(function (n) { if (n.nodeType === 1) widenAll(n); });
      });
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['accept'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.DSImage = { normalize: normalize, isHeic: sniffHeic, toJpeg: heicToJpeg };
})();
