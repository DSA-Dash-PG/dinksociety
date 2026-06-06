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

  const bar = document.createElement('div');
  bar.id = 'view-as-banner';
  bar.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;z-index:99999;' +
    'display:flex;align-items:center;justify-content:center;gap:12px;' +
    'padding:10px 16px;background:#b45309;color:#fff;' +
    'font:600 13px/1.3 system-ui,sans-serif;box-shadow:0 -2px 12px rgba(0,0,0,0.35);';

  const text = document.createElement('span');
  text.textContent = '👁 Admin view — ' + roleLabel + ': ' +
    (v.name || '?') + ' (' + (v.team || '?') + ')';

  const btn = document.createElement('button');
  btn.textContent = 'Exit';
  btn.style.cssText =
    'padding:5px 16px;border:1px solid rgba(255,255,255,0.6);border-radius:999px;' +
    'background:transparent;color:#fff;font:600 12px system-ui,sans-serif;cursor:pointer;';
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
  // Keep the bar from covering page content.
  document.body.style.paddingBottom = '52px';
})();
