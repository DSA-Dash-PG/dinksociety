// public/js/recap-urls.js
// Hand-built recap articles, keyed by EVENT ID. ONE copy — read by the
// Challengers hub (ladders.html), the Queen hub (queen.html) and the Ladders
// landing (ladders-home.html). Add a line here when a new article ships.
//
// Event id, never date: a single night can hold more than one ladder (2026-09-14
// ran the men's Kings Court at the Dink House and the women's September Reigns),
// so a date key cannot address them. The id is the same value the article's own
// <script src="/js/recap-photos.js" data-event="..."> carries, so grep the file
// if you need to confirm one.
const HAND_BUILT_RECAPS = {
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

// 2026-09-26: everything above is a HAND-BUILT article from before the article
// generator existed — those still need a manual line here. Every night since
// publishes automatically at /ladders/recaps/<eventId> (recap-article-cron.js,
// ~10-15 min after the night finishes; ladder-recap-page.js answers a friendly
// "recap on the way" placeholder if it's ever asked for before that), so this
// object falls back to that URL for any event id not in the hand-built map
// instead of silently showing "Recap coming soon" forever (Men's Ladder #2,
// 2026-09-26, sat with a live article nobody could find from this list).
// Server side has the same fallback already — see recapArticleUrl() in
// netlify/functions/lib/recap-articles.js.
window.DS_RECAP_URLS = new Proxy(HAND_BUILT_RECAPS, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'string' && prop) return `/ladders/recaps/${encodeURIComponent(prop)}`;
    return undefined;
  },
});

// Hand-built ladder PREVIEW articles, keyed by EVENT ID (upcoming nights).
// Read by the ladder hub's night cards ("Read the preview"). Add a line here
// when a new preview ships; the page lives under public/ladders/previews/.
window.DS_PREVIEW_URLS = {
  '2f810cf9c396': '/ladders/previews/2026-10-11-kings-court-3.html', // King's Court #3
};
