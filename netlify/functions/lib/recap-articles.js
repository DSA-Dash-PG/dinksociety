// netlify/functions/lib/recap-articles.js
// The full-length recap ARTICLES (the /ladders/recaps/*.html pages), keyed by
// night date — the server-side twin of RECAP_URLS in public/ladders.html and
// public/queen.html. Functions can't read the publish directory at runtime, so
// the map lives in code. KEEP ALL THREE IN SYNC: when a new article ships, add
// its entry here and in both pages' RECAP_URLS.
// Used by ladder-recap-email.js to put a "Read the full recap" button in the
// player recap email (Richard, 2026-08-28: "email the recap to the players too").
export const RECAP_ARTICLES = {
  '2026-08-27': '/ladders/recaps/2026-08-27-fix-partner-mix-ladder.html',
  '2026-08-17': '/ladders/recaps/2026-08-17-august-birthdays-womens-ladder.html',
  '2026-08-06': '/ladders/recaps/2026-08-06-thursday-night-ladder-dupr-rated.html',
  '2026-07-28': '/ladders/recaps/2026-07-28-amazing-ladies-ladder.html',
  '2026-07-23': '/ladders/recaps/2026-07-23-thursday-night-ladder.html',
  '2026-07-16': '/ladders/recaps/2026-07-16-thursday-night-ladder.html',
  '2026-07-14': '/ladders/recaps/2026-07-14-aloha-night-ladder.html',
};

// Absolute URL of the night's article, or null when none exists. `date` is the
// event's YYYY-MM-DD; tolerant of a full ISO string.
export function recapArticleUrl(date, siteUrl) {
  const d = String(date || '').slice(0, 10);
  const path = RECAP_ARTICLES[d];
  if (!path) return null;
  return (siteUrl || 'https://dinksociety.app').replace(/\/$/, '') + path;
}
