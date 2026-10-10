// netlify/functions/lib/ladder-recap-teaser.js
// The PUBLIC teaser for one ladder night's recap: title, dek, podium names +
// records, when it went out and where the full article lives. Redacted — no
// emails, no per-player stories, no draft content. Only a SENT recap has one.
//
// Shared by public-ladder-recaps.js (the hub's "Latest nights" strip) and
// lib/ladder-home.js (the home page's ladder strip and headline rotation).

import { getRecap } from './ladder-recap.js';
import { getPlay, toSession, playersFromPlay } from './ladder-play.js';
import { calcStats, calcDinkRating, pairRows } from './ladder-scoring.js';
import { getMergeMap, applyMerges } from './player-merge.js';
import { getDirectory, applyDirectory } from './player-directory.js';
import { RECAP_ARTICLES } from './recap-articles.js';

// Fixed Partner nights place as PAIRS. Recaps sent before that rule existed
// stored an individual podium (Ryan, Annie, Phoebe — when Ryan & Annie were
// one pair), so for those events the teaser podium is rebuilt from the night's
// play record: one entry per pair, "A & B" names. Best-effort — the stored
// podium stays as the fallback.
export async function pairPodium(e) {
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

/** Site path of a night's recap article: the hand-built page when there is one, else the generated one. */
export function recapPath(eventId) {
  if (!eventId) return null;
  return RECAP_ARTICLES[eventId] || `/ladders/recaps/${encodeURIComponent(eventId)}`;
}

/** The teaser for event `e`, or null when its recap has not been sent. */
export async function recapTeaser(e) {
  const r = await getRecap(e.id).catch(() => null);
  if (!r || r.status !== 'sent' || !r.recap) return null;
  return {
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
    type: e.type || 'mixed',
    sentAt: r.sentAt || null,
    url: recapPath(e.id),
    podium: (e.format === 'fixed-partner' && await pairPodium(e)) || (r.recap.podium || []).slice(0, 3).map(p => ({
      name: p.name || '',
      w: p.w ?? null,
      l: p.l ?? null,
      ...(p.pair ? { pair: true, names: p.names } : {}),
    })),
  };
}
