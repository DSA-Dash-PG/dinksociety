// netlify/functions/ladder-recap-page.js
//
// Serves a GENERATED recap article at /ladders/recaps/<eventId> (or its
// <date>-<slug>). Netlify's redirect for /ladders/recaps/* is non-forced, so
// the seven hand-built static articles under public/ladders/recaps/ keep
// serving from disk and only unmatched paths reach this function.
//
// Before the cron has published a night (the ~10 minute window after the last
// score lands) this answers 200 with a "recap on the way" placeholder rather
// than a 404, because the recap email and the hub link to the URL immediately.

import { getArticle, listArticles } from './lib/recap-article-store.js';

function pathId(req) {
  const url = new URL(req.url);
  const q = url.searchParams.get('id');
  if (q) return decodeURIComponent(q).replace(/\.html$/i, '').replace(/^\/+|\/+$/g, '');
  const m = /\/ladders\/recaps\/([^/?#]+)/i.exec(url.pathname);
  return m ? decodeURIComponent(m[1]).replace(/\.html$/i, '') : '';
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const id = pathId(req);
  if (!id) return html(placeholder(null), 404);

  try {
    // Fast path: the id IS the event id.
    let rec = await getArticle(id);

    // Otherwise match on the stored slug, or on a bare YYYY-MM-DD date.
    if (!rec) {
      const all = await listArticles();
      const lower = id.toLowerCase();
      const hit = all.find(a => (a.slug || '').toLowerCase() === lower)
        || (/^\d{4}-\d{2}-\d{2}$/.test(id) ? all.find(a => a.date === id) : null)
        || all.find(a => (a.slug || '').toLowerCase().startsWith(lower));
      if (hit) rec = await getArticle(hit.eventId);
    }

    if (!rec || !rec.html) return html(placeholder(id), 200);

    return new Response(rec.html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Short cache: an article can be regenerated after the organizer adds
        // night notes, and they should see that within a minute.
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=600',
      },
    });
  } catch (err) {
    console.error('ladder-recap-page error:', err);
    return html(placeholder(id), 200);
  }
};

function html(body, status) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function placeholder(id) {
  const back = id ? `/ladders#ladders/${encodeURIComponent(id)}` : '/ladders';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Recap on the way | The Dink Society</title>
<link rel="icon" type="image/svg+xml" href="/img/favicon.svg">
<link rel="stylesheet" href="/css/shared.css">
<link rel="stylesheet" href="/css/shared-nav.css">
<style>
  body { margin:0; background:#0e0e0e; color:#f0f0ec;
    font-family:'Inter',-apple-system,sans-serif; }
  .wrap { max-width:620px; margin:0 auto; padding:140px 24px 80px; text-align:center; }
  .eyebrow { color:#b8ff2c; text-transform:uppercase; letter-spacing:.12em; font-size:12px; font-weight:800; }
  h1 { font-size:28px; font-weight:900; margin:10px 0 12px; }
  p { color:#9a9e97; font-size:14.5px; line-height:1.7; margin:0 0 22px; }
  a.btn { display:inline-block; background:#b8ff2c; color:#0e0e0e; font-weight:800;
    font-size:13px; text-decoration:none; padding:11px 20px; border-radius:9px; }
</style>
</head>
<body data-page="ladders">
<div data-partial="nav"></div>
<div class="wrap">
  <div class="eyebrow">The Dink Society</div>
  <h1>Recap on the way</h1>
  <p>The write-up for this night is still being put together. It usually lands within about ten minutes of the last score going in. The results are already live.</p>
  <a class="btn" href="${back}">See the results &rarr;</a>
</div>
<div data-partial="footer"></div>
<script src="/js/partials.js"></script>
</body>
</html>`;
}

export const config = { path: '/.netlify/functions/ladder-recap-page' };
