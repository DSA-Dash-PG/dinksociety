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
window.DS_RECAP_URLS = {
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
