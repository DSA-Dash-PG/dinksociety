// view-as-banner.js
// Shows a fixed banner when an admin is impersonating a captain or player
// (ds_view_as cookie, set by /.netlify/functions/admin-impersonate).
// "Exit" kills the impersonated session, clears the cookie, returns to /admin.html.
(function () {
  const m = document.cookie.match(/(?:^|;\s*)ds_view_as=([^;]+)/);
  if (!m) return;
  let v;
  try { v = JSON.parse(decodeURIComponent(m[1])); } catch { return; }
  if (!v || !v.mode) return;

  // Only render on the portal that matches the impersonated session.
  const path = location.pathname;
  const expected = v.mode === 'captain' ? '/captain' : '/me';
  if (!path.startsWith(expected)) return;

  const roleLabel = v.mode === 'captain'
    ? (v.role === 'cocaptain' ? 'Co-Captain' : 'Captain')
    : 'Player';

  // Ultra-slim strip (~20px) that docks ON TOP of the portal's bottom nav —
  // never covers it (see reposition() below). Richard 2026-06-07: nav must be
  // 100% visible while impersonating.
  const bar = document.createElement('div');
  bar.id = 'view-as-banner';
  bar.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;z-index:99999;' +
    'display:flex;align-items:center;justify-content:center;gap:8px;' +
    'padding:2px 10px;background:#b45309;color:#fff;' +
    'font:600 11px/1.4 system-ui,sans-serif;';

  const text = document.createElement('span');
  text.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  text.textContent = '👁 ' + roleLabel + ': ' + (v.name || '?') + ' (' + (v.team || '?') + ')';

  const btn = document.createElement('button');
  btn.textContent = 'Exit';
  btn.style.cssText =
    'padding:0 10px;border:1px solid rgba(255,255,255,0.6);border-radius:999px;' +
    'background:transparent;color:#fff;font:600 11px/1.5 system-ui,sans-serif;cursor:pointer;flex:0 0 auto;';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Exiting…';
    const endpoint = v.mode === 'captain'
      ? '/.netlify/functions/captain-logout'
      : '/.netlify/functions/player-logout';
    try { await fetch(endpoint, { method: 'POST', credentials: 'include' }); } catch {}
    document.cookie = 'ds_view_as=; Path=/; Max-Age=0; Secure; SameSite=Strict';
    location.href = '/admin.html';
  });

  bar.appendChild(text);
  bar.appendChild(btn);
  document.body.appendChild(bar);

  // Sit ABOVE the portal's fixed bottom nav (player portal `.nav`,
  // captain mobile `.cap-bottomnav`) instead of covering it. Re-measure on
  // resize (the captain nav only exists ≤860px) and once after load in case
  // the nav renders after this script runs.
  function reposition() {
    let navH = 0;
    for (const sel of ['.nav', '.cap-bottomnav']) {
      const nav = document.querySelector(sel);
      if (nav && getComputedStyle(nav).display !== 'none') {
        navH = Math.max(navH, nav.getBoundingClientRect().height);
      }
    }
    bar.style.bottom = navH + 'px';
    // Page CSS already clears its own nav — body just needs the banner's height.
    document.body.style.paddingBottom = bar.getBoundingClientRect().height + 'px';
  }
  reposition();
  window.addEventListener('resize', reposition);
  if (document.readyState !== 'complete') window.addEventListener('load', reposition);
  setTimeout(reposition, 500); // late-rendered navs
})();
