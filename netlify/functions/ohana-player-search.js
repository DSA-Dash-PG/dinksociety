// netlify/functions/ohana-player-search.js
// Type-to-find over everyone who has played in The Dink Society, for adding
// players to the private South Bay Ohana roster. Managers only.
// GET ?q=sar → { results:[{ name, email, lastTeamName }] }

import { loadLeague, viewer, json } from './lib/ohana.js';
import { buildLeagueIndex } from './lib/league-players.js';

export default async (req) => {
  const league = await loadLeague();
  const v = await viewer(req, league);
  if (!v.canEdit) return json({ error: 'Managers only' }, 403);
  const q = (new URL(req.url).searchParams.get('q') || '').trim().toLowerCase();
  if (q.length < 2) return json({ results: [] });
  const { byEmail } = await buildLeagueIndex();
  const onRoster = new Set(league.roster.map(p => p.email));
  const hits = [];
  for (const rec of byEmail.values()) {
    if (onRoster.has(rec.email)) continue;
    const n = String(rec.name || '').toLowerCase();
    if (!n.includes(q) && !rec.email.startsWith(q)) continue;
    hits.push({ rank: n.startsWith(q) ? 0 : 1, name: rec.name || rec.email, email: rec.email, gender: rec.gender || '', lastTeamName: rec.lastTeamName || '' });
  }
  hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return json({ results: hits.slice(0, 8).map(({ rank, ...h }) => h) });
};

export const config = { path: '/.netlify/functions/ohana-player-search' };
