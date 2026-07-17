/* ds-ui.js — The Dink Society branded dialogs & toasts (Night-Match theme).
 * Replaces native alert()/confirm() with on-brand modals + toasts.
 * Self-contained: injects its own CSS, no dependencies. Load once per page:
 *     <script src="/js/ds-ui.js"></script>
 *
 * API (all return a Promise so they drop into async flows):
 *   dsToast(message, { type:'success'|'error'|'info'|'warn', title, timeout })
 *   dsAlert({ title, message, okLabel, tone })              -> resolves when dismissed
 *   dsConfirm({ title, message, confirmLabel, cancelLabel, danger }) -> resolves true/false
 *   dsCelebrate({ title, message, okLabel })               -> big lime success moment
 * Each also accepts a plain string as the first arg (message/ title shortcut).
 */
(function () {
  if (window.__dsUiLoaded) return;
  window.__dsUiLoaded = true;

  var CSS = [
    ':root{--ds-lime:#b8ff2c;--ds-teal:#17d7b0;--ds-red:#ff5c47;--ds-gold:#ffcc00;}',
    '.ds-ov{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;',
      'background:rgba(6,9,6,.72);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity .16s;font-family:"Inter",system-ui,-apple-system,sans-serif;}',
    '.ds-ov.on{opacity:1;}',
    '.ds-modal{background:#161914;border:1px solid rgba(255,255,255,.12);border-radius:20px;max-width:360px;width:100%;padding:26px 24px 22px;text-align:center;color:#f0f2ec;',
      'transform:translateY(10px) scale(.98);transition:transform .16s;box-shadow:0 24px 70px rgba(0,0,0,.6);}',
    '.ds-ov.on .ds-modal{transform:none;}',
    '.ds-ic{width:56px;height:56px;border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 15px;font-size:28px;line-height:1;}',
    '.ds-ic.ok{background:rgba(184,255,44,.15);color:var(--ds-lime);}',
    '.ds-ic.warn{background:rgba(255,204,0,.15);color:var(--ds-gold);}',
    '.ds-ic.danger{background:rgba(255,92,71,.15);color:var(--ds-red);}',
    '.ds-ic.info{background:rgba(23,215,176,.15);color:var(--ds-teal);}',
    '.ds-modal h3{margin:0 0 8px;font-size:1.25rem;font-weight:900;letter-spacing:-.01em;}',
    '.ds-modal p{margin:0 0 20px;font-size:.9rem;line-height:1.55;color:#9aa094;}',
    '.ds-modal p b{color:var(--ds-lime);font-weight:800;}',
    '.ds-acts{display:flex;flex-direction:column;gap:9px;}',
    '.ds-btn{border:0;border-radius:9999px;padding:13px 18px;font:inherit;font-size:.92rem;font-weight:800;cursor:pointer;transition:filter .12s,background .12s;}',
    '.ds-btn.primary{background:var(--ds-lime);color:#06210f;}',
    '.ds-btn.primary:hover{filter:brightness(1.06);}',
    '.ds-btn.danger{background:var(--ds-red);color:#fff;}',
    '.ds-btn.danger:hover{filter:brightness(1.06);}',
    '.ds-btn.ghost{background:transparent;color:#c7cdbe;border:1px solid rgba(255,255,255,.18);}',
    '.ds-btn.ghost:hover{background:#1c1f18;color:#f0f2ec;}',
    '.ds-celebrate .ds-ic{width:66px;height:66px;font-size:34px;}',
    '.ds-toastwrap{position:fixed;left:0;right:0;top:14px;z-index:10001;display:flex;flex-direction:column;align-items:center;gap:9px;pointer-events:none;padding:0 14px;font-family:"Inter",system-ui,sans-serif;}',
    '.ds-toast{display:flex;align-items:flex-start;gap:11px;max-width:400px;width:100%;background:#1c1f18;border:1px solid rgba(255,255,255,.12);border-radius:13px;',
      'padding:12px 14px;box-shadow:0 14px 40px rgba(0,0,0,.55);pointer-events:auto;transform:translateY(-14px);opacity:0;transition:transform .2s,opacity .2s;}',
    '.ds-toast.on{transform:none;opacity:1;}',
    '.ds-toast.success{border-left:3px solid var(--ds-lime);}',
    '.ds-toast.error{border-left:3px solid var(--ds-red);}',
    '.ds-toast.warn{border-left:3px solid var(--ds-gold);}',
    '.ds-toast.info{border-left:3px solid var(--ds-teal);}',
    '.ds-tic{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}',
    '.ds-toast.success .ds-tic{background:rgba(184,255,44,.15);color:var(--ds-lime);}',
    '.ds-toast.error .ds-tic{background:rgba(255,92,71,.15);color:var(--ds-red);}',
    '.ds-toast.warn .ds-tic{background:rgba(255,204,0,.15);color:var(--ds-gold);}',
    '.ds-toast.info .ds-tic{background:rgba(23,215,176,.15);color:var(--ds-teal);}',
    '.ds-tt{font-size:.86rem;font-weight:800;color:#f0f2ec;}',
    '.ds-tb{font-size:.8rem;color:#9aa094;margin-top:1px;line-height:1.4;}',
    '.ds-tx{margin-left:auto;color:#6a766a;cursor:pointer;font-size:1.05rem;line-height:1;padding:2px 2px 2px 6px;}'
  ].join('');

  function injectCSS() {
    if (document.getElementById('ds-ui-css')) return;
    var st = document.createElement('style');
    st.id = 'ds-ui-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectCSS);
  else injectCSS();

  var ICON = { ok: '✓', danger: '!', warn: '!', info: 'i', ticket: '🎟', party: '🎉' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---- modal core (returns a promise resolving to the chosen value) ----
  function modal(opts) {
    injectCSS();
    return new Promise(function (resolve) {
      var ov = document.createElement('div');
      ov.className = 'ds-ov' + (opts.celebrate ? ' ds-celebrate' : '');
      var glyph = opts.glyph != null ? opts.glyph : (ICON[opts.icon] || ICON.info);
      var btns = (opts.buttons || []).map(function (b, i) {
        return '<button class="ds-btn ' + (b.variant || 'ghost') + '" data-i="' + i + '">' + esc(b.label) + '</button>';
      }).join('');
      ov.innerHTML =
        '<div class="ds-modal" role="dialog" aria-modal="true">' +
          '<div class="ds-ic ' + (opts.tone || 'info') + '">' + glyph + '</div>' +
          (opts.title ? '<h3>' + esc(opts.title) + '</h3>' : '') +
          (opts.message ? '<p>' + (opts.html ? opts.message : esc(opts.message)) + '</p>' : '') +
          '<div class="ds-acts">' + btns + '</div>' +
        '</div>';
      document.body.appendChild(ov);
      requestAnimationFrame(function () { ov.classList.add('on'); });

      function close(val) {
        ov.classList.remove('on');
        setTimeout(function () { ov.remove(); }, 180);
        document.removeEventListener('keydown', onKey);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === 'Escape') close(opts.dismissValue);
        if (e.key === 'Enter' && opts.enterIndex != null && opts.buttons[opts.enterIndex]) {
          close(opts.buttons[opts.enterIndex].value);
        }
      }
      ov.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-i]');
        if (b) { close(opts.buttons[+b.dataset.i].value); return; }
        if (e.target === ov && opts.backdropDismiss !== false) close(opts.dismissValue);
      });
      document.addEventListener('keydown', onKey);
    });
  }

  // ---- public: confirm ----
  window.dsConfirm = function (a, b) {
    var o = typeof a === 'string' ? Object.assign({ message: a }, b) : (a || {});
    return modal({
      tone: o.danger ? 'danger' : (o.tone || 'warn'),
      icon: o.danger ? 'danger' : (o.icon || 'warn'),
      glyph: o.glyph,
      title: o.title || 'Are you sure?',
      message: o.message, html: o.html,
      buttons: [
        { label: o.confirmLabel || 'Confirm', variant: o.danger ? 'danger' : 'primary', value: true },
        { label: o.cancelLabel || 'Cancel', variant: 'ghost', value: false }
      ],
      enterIndex: 0, dismissValue: false
    });
  };

  // ---- public: alert ----
  window.dsAlert = function (a, b) {
    var o = typeof a === 'string' ? Object.assign({ message: a }, b) : (a || {});
    return modal({
      tone: o.tone || 'info', icon: o.icon || (o.tone === 'danger' ? 'danger' : o.tone === 'warn' ? 'warn' : 'info'),
      glyph: o.glyph, title: o.title || '', message: o.message, html: o.html,
      buttons: [{ label: o.okLabel || 'OK', variant: 'primary', value: true }],
      enterIndex: 0, dismissValue: true
    });
  };

  // ---- public: celebrate (big lime success) ----
  window.dsCelebrate = function (a, b) {
    var o = typeof a === 'string' ? Object.assign({ message: a }, b) : (a || {});
    return modal({
      celebrate: true, tone: 'ok', glyph: o.glyph || ICON.party,
      title: o.title || 'Nice!', message: o.message, html: o.html,
      buttons: [{ label: o.okLabel || 'Got it', variant: 'primary', value: true }],
      enterIndex: 0, dismissValue: true, backdropDismiss: true
    });
  };

  // ---- public: toast ----
  function wrap() {
    var w = document.getElementById('ds-toastwrap');
    if (!w) { w = document.createElement('div'); w.id = 'ds-toastwrap'; w.className = 'ds-toastwrap'; document.body.appendChild(w); }
    return w;
  }
  window.dsToast = function (a, b) {
    injectCSS();
    var o = typeof a === 'string' ? Object.assign({ message: a }, b) : (a || {});
    var type = o.type || 'success';
    var glyph = o.glyph != null ? o.glyph : (ICON[o.icon] || (type === 'error' ? ICON.danger : type === 'warn' ? ICON.warn : type === 'info' ? ICON.info : ICON.ok));
    var t = document.createElement('div');
    t.className = 'ds-toast ' + type;
    t.innerHTML =
      '<div class="ds-tic">' + glyph + '</div>' +
      '<div>' + (o.title ? '<div class="ds-tt">' + esc(o.title) + '</div>' : '') +
        (o.message ? '<div class="ds-tb">' + esc(o.message) + '</div>' : '') + '</div>' +
      '<span class="ds-tx">&times;</span>';
    wrap().appendChild(t);
    requestAnimationFrame(function () { t.classList.add('on'); });
    var timeout = o.timeout != null ? o.timeout : 3400;
    var killed = false;
    function kill() { if (killed) return; killed = true; t.classList.remove('on'); setTimeout(function () { t.remove(); }, 220); }
    t.querySelector('.ds-tx').addEventListener('click', kill);
    if (timeout > 0) setTimeout(kill, timeout);
    return Promise.resolve();
  };
})();
