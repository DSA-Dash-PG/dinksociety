// netlify/functions/public-drop.js
//
// PUBLIC endpoint — no auth. Serves PUBLISHED "Drop" editorials only; drafts
// are never exposed. Powers the homepage teaser and the /drop.html article page.
//
//   GET /.netlify/functions/public-drop?circuit=I                → latest published Drop
//   GET /.netlify/functions/public-drop?circuit=I&edition=week-5 → that edition (if published)
//   GET /.netlify/functions/public-drop?circuit=I&week=5         → same, legacy form
//   GET /.netlify/functions/public-drop?circuit=II&edition=preseason
//   GET /.netlify/functions/public-drop?circuit=I&view=index     → published editions, in reading order
//
// ETag-cached via lib/http-cache.js so the homepage can poll cheaply.

import { getDrop, getLatestPublished, listDrops, toPublic, parseEdition } from './lib/drop.js';
import { circuitCode } from './lib/circuit.js';
import { etagJson } from './lib/http-cache.js';

export default async (req) => {
  const url = new URL(req.url);
  const circuit = circuitCode(url.searchParams.get('circuit') || 'I');
  const view = (url.searchParams.get('view') || '').trim();
  const ed = parseEdition(url.searchParams.get('edition') ?? url.searchParams.get('week'));

  try {
    if (view === 'index') {
      const recs = await listDrops(circuit);
      const pub = recs.filter(r => r.status === 'published');
      // `editions` is the full picker, oldest → newest (pre-season first). `weeks`
      // is kept for older readers and lists numbered weeks only.
      const editions = pub.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(r => ({ edition: r.edition, week: r.week, label: r.label, short: r.short, order: r.order, title: r.title, kicker: r.kicker, publishedAt: r.publishedAt }));
      const weeks = pub.filter(r => r.week != null)
        .map(r => ({ week: r.week, title: r.title, kicker: r.kicker, publishedAt: r.publishedAt }));
      return etagJson(req, { circuit, editions, weeks });
    }

    let rec;
    if (ed) {
      rec = await getDrop(circuit, ed.id);
      if (!rec || rec.status !== 'published') {
        return etagJson(req, { circuit, empty: true, message: 'No published Drop for that edition yet.' });
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
