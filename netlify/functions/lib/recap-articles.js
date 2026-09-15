// netlify/functions/lib/recap-articles.js
// The full-length recap ARTICLES (the /ladders/recaps/*.html pages) — the
// server-side twin of window.DS_RECAP_URLS in public/js/recap-urls.js.
// Functions can't read the publish directory at runtime, so the map lives in
// code. KEEP BOTH IN SYNC: when a new article ships, add its entry here and in
// public/js/recap-urls.js.
// Used by ladder-recap-email.js to put a "Read the full recap" button in the
// player recap email (Richard, 2026-08-28: "email the recap to the players too").
//
// Keyed by EVENT ID, never date: a single night can hold more than one ladder
// (2026-09-14 ran the men's Kings Court and the women's September Reigns), so a
// date key cannot address them. The id is the same value the article's own
// <script src="/js/recap-photos.js" data-event="..."> carries.
export const RECAP_ARTICLES = {
  '01adcfc2aa5a': '/ladders/recaps/2026-09-14-kings-court-ladder.html',
  '888e94ce398c': '/ladders/recaps/2026-09-14-september-reigns.html',
  '35682ec4cfff': '/ladders/recaps/2026-09-10-fix-partner-ladder.html',
  '1499b2154d2d': '/ladders/recaps/2026-08-27-fix-partner-mix-ladder.html',
  '14869357c434': '/ladders/recaps/2026-08-17-august-birthdays-womens-ladder.html',
  '306f79a891a2': '/ladders/recaps/2026-08-06-thursday-night-ladder-dupr-rated.html',
  '445fea97277c': '/ladders/recaps/2026-07-28-amazing-ladies-ladder.html',
  '891c61c1b79b': '/ladders/recaps/2026-07-23-thursday-night-ladder.html',
  'f42f0a03811d': '/ladders/recaps/2026-07-16-thursday-night-ladder.html',
  '25f36641f571': '/ladders/recaps/2026-07-14-aloha-night-ladder.html',
};

// Absolute URL of a night's article, looked up by event id.
//
// A hand-built article wins when the id is in the map above. Otherwise fall
// back to the GENERATED article at /ladders/recaps/<id> — recap-article-cron
// publishes that within ten minutes of a night finishing, and ladder-recap-page
// answers "recap on the way" in the meantime, so the link is always safe to
// send. Null only when there's no event id at all.
export function recapArticleUrl(eventId, siteUrl) {
  const base = (siteUrl || 'https://dinksociety.app').replace(/\/$/, '');
  if (!eventId) return null;
  const path = RECAP_ARTICLES[eventId];
  if (path) return base + path;
  return `${base}/ladders/recaps/${encodeURIComponent(eventId)}`;
}
