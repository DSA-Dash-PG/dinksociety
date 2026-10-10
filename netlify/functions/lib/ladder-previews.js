// netlify/functions/lib/ladder-previews.js
// The hand-built ladder PREVIEW articles (public/ladders/previews/*.html), with
// what the home page needs to feature one: headline, dek, when it was published
// and the sections it can jump to. Keyed by EVENT ID.
//
// Functions can't read the publish directory at runtime, so this lives in code —
// the server-side twin of window.DS_PREVIEW_URLS in public/js/recap-urls.js.
// KEEP BOTH IN SYNC: when a new preview ships, add its entry here (all fields)
// and its URL line there.
//
//   url          site path of the article
//   title, dek   as written on the page
//   publishedAt  ISO time it went live. This starts the home page clock: the
//                preview is the headline for 48 hours (unless a league Drop is
//                inside its own 48), then a card until it is four days old.
//   sections     optional [{ label, id }] — h2 headings on the page that carry
//                that id, shown as "In this preview" links under the headline.
export const LADDER_PREVIEWS = {
  '2f810cf9c396': {   // King's Court #3 · Sun Oct 11, 2026
    url: '/ladders/previews/2026-10-11-kings-court-3.html',
    title: 'Sixteen men, four courts, one throne',
    dek: "King's Court #3 sold out — 16 of 16, with one man pacing the waitlist like a dad outside a delivery room. For the first time the men's ladder goes to four courts, which changes the math: from the bottom court it now takes three straight wins to reach King Court instead of two.",
    publishedAt: '2026-10-06T11:12:00-07:00',
    sections: [
      { label: 'The throne', id: 'the-throne' },
      { label: 'The contenders', id: 'the-contenders' },
      { label: 'The middle class', id: 'the-middle-class' },
      { label: 'New blood', id: 'new-blood' },
      { label: 'Four things to watch', id: 'four-things-to-watch' },
    ],
  },
};
