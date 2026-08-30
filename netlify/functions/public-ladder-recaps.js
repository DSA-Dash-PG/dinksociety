// netlify/functions/public-ladder-recaps.js
// GET /.netlify/functions/public-ladder-recaps   (no auth)
// Teasers for the most recent SENT ladder-night recaps, for the "Latest
// nights" strip on the ladders page. Redacted: title, dek, podium names +
// records only — no emails, no per-player stories, no draft content.

import { listEvents } from './lib/ladder.js';
import { getRecap } from './lib/ladder-recap.js';
import { getPlay, toSession, playersFromPlay } from './lib/ladder-play.js';
import { calcStats, calcDinkRating, pairRows } from './lib/ladder-scoring.js';
import { getMergeMap, applyMerges } from './lib/player-merge.js';
import { getDirectory, applyDirectory } from './lib/player-directory.js';

// Fixed Partner nights place as PAIRS. Recaps sent before that rule existed
// stored an individual podium (Ryan, Annie, Phoebe — when Ryan & Annie were
// one pair), so for those events the teaser podium is rebuilt from the night's
// play record: one entry per pair, "A & B" names. Best-effort — the stored
// podium stays as the fallback.
async function pairPodium(e) {
  try {
    const raw = await getPlay(e.id);
    if (!raw) return null;
    const play = applyDirectory(applyMerges([raw], await getMergeMap()), await getDirectory())[0];
    const sess = toSession(play), players = playersFromPlay([play]);
    const stats = calcStats([sess], players);
    const dr = calcDinkRating(stats, [sess], players);
    const rows = stats.filter(s => s.w + s.l > 0)
      .map(s => ({ id: s.id, name: s.name, w: s.w, l: s.l, pf: s.pf, pa: s.pa, diff: s.pf - s.pa, dr: dr[s.id] ?? null }))
      .sort((a, b) => (b.w - a.w) || (b.diff - a.diff) || ((b.dr ?? -1) - (a.dr ?? -1)));
    const paired = pairRows(rows, sess, true);
    if (!paired.some(r => r.pair)) return null;
    return paired.slice(0, 3).map(r => ({ name: r.name, w: r.w, l: r.l, ...(r.pair ? { pair: true, names: r.names } : {}) }));
  } catch { return null; }
}

export default async () => {
  const events = (await listEvents({}))
    .filter(e => (e.status || '') === 'final')
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 8);

  const recaps = [];
  for (const e of events) {
    if (recaps.length >= 3) break;
    const r = await getRecap(e.id).catch(() => null);
    if (!r || r.status !== 'sent' || !r.recap) continue;
    recaps.push({
      eventId: e.id,
      name: e.name || 'Ladder',
      date: e.date || null,
      place: e.place || null,
      courts: e.courts || null,
      rounds: e.rounds || null,
      playersCount: Array.isArray(r.recipients) ? r.recipients.length : null,
      title: r.recap.title || null,
      dek: r.recap.dek || null,
      format: e.format || 'individual',
      podium: (e.format === 'fixed-partner' && await pairPodium(e)) || (r.recap.podium || []).slice(0, 3).map(p => ({
        name: p.name || '',
        w: p.w ?? null,
        l: p.l ?? null,
        ...(p.pair ? { pair: true, names: p.names } : {}),
      })),
    });
  }

  return new Response(JSON.stringify({ recaps }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
};

export const config = { path: '/.netlify/functions/public-ladder-recaps' };
