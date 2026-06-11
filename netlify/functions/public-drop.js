// netlify/functions/public-drop.js
//
// PUBLIC endpoint — no auth. Serves PUBLISHED "Drop" editorials only; drafts
// are never exposed. Powers the homepage teaser and the /drop.html article page.
//
//   GET /.netlify/functions/public-drop?circuit=I         → latest published Drop
//   GET /.netlify/functions/public-drop?circuit=I&week=5  → that week (if published)
//   GET /.netlify/functions/public-drop?circuit=I&view=index → list of published weeks
//
// ETag-cached via lib/http-cache.js so the homepage can poll cheaply.

import { getDrop, getLatestPublished, listDrops, toPublic } from './lib/drop.js';
import { circuitCode } from './lib/circuit.js';
import { etagJson } from './lib/http-cache.js';

export default async (req) => {
  const url = new URL(req.url);
  const circuit = circuitCode(url.searchParams.get('circuit') || 'I');
  const view = (url.searchParams.get('view') || '').trim();
  const week = url.searchParams.get('week');

  try {
    if (view === 'index') {
      const recs = await listDrops(circuit);
      const weeks = recs.filter(r => r.status === 'published')
        .map(r => ({ week: r.week, title: r.title, kicker: r.kicker, publishedAt: r.publishedAt }));
      return etagJson(req, { circuit, weeks });
    }

    let rec;
    if (week) {
      rec = await getDrop(circuit, week);
      if (!rec || rec.status !== 'published') {
        return etagJson(req, { circuit, empty: true, message: 'No published Drop for that week yet.' });
      }
    } else {
      rec = await getLatestPublished(circuit);
      if (!rec) {
        return etagJson(req, { circuit, empty: true, message: 'The first Drop lands after Week 1.' });
      }
    }
    return etagJson(req, { circuit, drop: toPublic(rec) });
  } catch (err) {
    console.error('public-drop error:', err);
    return etagJson(req, { circuit, empty: true, message: 'The Drop is unavailable right now.' }, { status: 200 });
  }
};

export const config = { path: '/.netlify/functions/public-drop' };
