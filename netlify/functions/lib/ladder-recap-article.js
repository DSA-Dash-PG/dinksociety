// netlify/functions/lib/ladder-recap-article.js
//
// The FULL-LENGTH recap article for one finished ladder night — the long-form
// page that lives at /ladders/recaps/<eventId>, matching the hand-built
// Jul–Aug 2026 articles (2026-08-27-fix-partner-mix-ladder.html et al).
//
// Three separate jobs, deliberately kept apart:
//
//   buildArticleStats()   every NUMBER, computed from the play record with the
//                         same engine the public stats use (wins → point diff →
//                         Dink Rating). Court paths, King Court tenure, climbs,
//                         streaks, margins and the round-by-round board.
//   writeNarrative()      only the PROSE — headline, dek and 4–6 paragraphs.
//                         Claude gets the computed stats and may not introduce
//                         a number of its own. Falls back to a templated write
//                         up when there's no API key or the call fails, so an
//                         article is never blocked on the API.
//   renderArticleHtml()   the page itself. Awards, tables and charts are built
//                         from the computed stats, never from model output.
//
// That split is the anti-fabrication guarantee: the model can pick what to
// talk about, but every figure on the page came out of the scoring engine.
//
// Env: ANTHROPIC_API_KEY (optional), LADDER_RECAP_MODEL / DROP_MODEL (optional).

import { getEvent } from './ladder.js';
import { getPlay, toSession, playersFromPlay } from './ladder-play.js';
import { calcStats, calcDinkRating, fixedPartnerMap, orderPairWomenFirst } from './ladder-scoring.js';
import { getMergeMap, applyMerges } from './player-merge.js';
import { getDirectory, applyDirectory } from './player-directory.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
function env(name) {
  return (typeof Netlify !== 'undefined' && Netlify.env.get(name)) || process.env[name] || '';
}
function apiKey() { return env('ANTHROPIC_API_KEY'); }
function modelId() { return env('LADDER_RECAP_MODEL') || env('DROP_MODEL') || DEFAULT_MODEL; }

// ───────────────────────────── helpers ─────────────────────────────

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const firstName = n => String(n || '').trim().split(/\s+/)[0] || String(n || '');
const round1 = n => (n == null ? null : Math.round(n * 10) / 10);
const signed = n => (n > 0 ? `+${n}` : String(n));

function maxStreak(seq) {
  let m = 0, c = 0;
  for (const x of seq) { c = x === 'W' ? c + 1 : 0; if (c > m) m = c; }
  return m;
}

/**
 * Display name for a court index, using the event's own court names.
 *
 * IMPORTANT, and easy to get backwards: the play data numbers courts from the
 * BOTTOM up. lib/ladder-scoring.js `genNR`/`genNRPairs` send a winner to
 * `Math.min(totalCourts, court + 1)` and a loser to `Math.max(1, court - 1)`,
 * so the HIGHEST index is the top court (King Court) and index 1 is the bottom.
 * `event.courtNames` is entered by the admin TOP FIRST ("3A, 3B, 3C, 3D"), so
 * the two run in opposite directions and the name for index i is
 * names[n - i], not names[i - 1].
 *
 * Getting this wrong silently inverts every court reference in the article
 * (it put the winner on the bottom court in the Jul/Aug 2026 hand-built ones).
 */
function courtNamer(event, play) {
  const names = event?.courtNames || play?.config?.courtNames || null;
  const n = Array.isArray(names) ? names.length : 0;
  return idx => {
    const name = n ? names[n - idx] : null;   // top-first names vs bottom-first index
    return name ? `Court ${name}` : `Court ${idx}`;
  };
}

// ─────────────────────────── stats builder ───────────────────────────

/**
 * Every number the article needs, for either night format.
 * Returns null when the event has no scored play yet.
 *
 * Court convention: the HIGHEST court index is the top court (King Court) and
 * index 1 is the bottom — winners move up a number, losers move down. See
 * courtNamer() above for why the NAME list runs the other way.
 */
export async function buildArticleStats(eventId) {
  const event = await getEvent(eventId);
  const rawPlay = await getPlay(eventId);
  if (!event || !rawPlay || !(rawPlay.rounds || []).length) return null;

  const mergeMap = await getMergeMap();
  const dir = await getDirectory();
  const [play] = applyDirectory(applyMerges([rawPlay], mergeMap), dir);

  const players = playersFromPlay([play]);
  const sessions = [toSession(play)];
  const rawStats = calcStats(sessions, players);
  const drMap = calcDinkRating(rawStats, sessions, players);
  const fpm = fixedPartnerMap(sessions[0]);
  const courtName = courtNamer(event, play);

  const byId = {};
  players.forEach(p => { byId[p.id] = p; });

  // One pass over every completed game: records, points, court paths, margins.
  const games = [];
  let maxCourt = 1;
  (play.rounds || []).forEach((rd, ri) => {
    (rd.courts || []).forEach(c => {
      const sc = c.score || {};
      if (sc.t1 == null || sc.t2 == null) return;
      const a = (c.team1 || []).filter(Boolean);
      const b = (c.team2 || []).filter(Boolean);
      if (!a.length || !b.length) return;
      const court = c.court || 1;
      if (court > maxCourt) maxCourt = court;
      games.push({
        round: ri + 1, court,
        a: a.map(p => p.id), b: b.map(p => p.id),
        aNames: a.map(p => p.name), bNames: b.map(p => p.name),
        sa: sc.t1, sb: sc.t2,
        margin: Math.abs(sc.t1 - sc.t2),
        total: sc.t1 + sc.t2,
      });
    });
  });
  if (!games.length) return null;

  // Group into ENTITIES — a pair on a fixed-partner night, else one player.
  const entities = new Map(); // key -> entity
  const entityOf = new Map(); // playerId -> key
  const keyFor = id => (fpm && fpm[id] ? [id, fpm[id]].sort().join('|') : String(id));

  for (const p of players) {
    const k = keyFor(p.id);
    entityOf.set(p.id, k);
    if (!entities.has(k)) {
      entities.set(k, {
        key: k, ids: [], names: [], w: 0, l: 0, pf: 0, pa: 0,
        courts: [], seq: [], pair: !!(fpm && fpm[p.id]),
      });
    }
    const e = entities.get(k);
    if (!e.ids.includes(p.id)) { e.ids.push(p.id); e.names.push(p.name); }
  }

  // Order a pair's names the way the rest of the site does (women first).
  for (const e of entities.values()) {
    if (e.pair && e.ids.length === 2) {
      const [x, y] = e.ids.map(id => byId[id]).filter(Boolean);
      if (x && y) {
        const [f, m] = orderPairWomenFirst(x, y);
        e.ids = [f.id, m.id];
        e.names = [f.name, m.name];
      }
    }
    e.name = e.names.join(' & ');
  }

  for (const g of games) {
    const ka = entityOf.get(g.a[0]);
    const kb = entityOf.get(g.b[0]);
    const ea = entities.get(ka), eb = entities.get(kb);
    if (!ea || !eb) continue;
    ea.pf += g.sa; ea.pa += g.sb; eb.pf += g.sb; eb.pa += g.sa;
    ea.courts.push(g.court); eb.courts.push(g.court);
    if (g.sa > g.sb) { ea.w++; eb.l++; ea.seq.push('W'); eb.seq.push('L'); }
    else if (g.sb > g.sa) { eb.w++; ea.l++; eb.seq.push('W'); ea.seq.push('L'); }
    g.entA = ka; g.entB = kb;
  }

  const rows = [...entities.values()].filter(e => e.w + e.l > 0).map(e => {
    const dr = round1(drMap[e.ids[0]] ?? null);
    return {
      ...e,
      diff: e.pf - e.pa,
      dr,
      games: e.w + e.l,
      start: e.courts[0] ?? null,
      end: e.courts[e.courts.length - 1] ?? null,
      climb: (e.courts[e.courts.length - 1] ?? 0) - (e.courts[0] ?? 0),
      kingRounds: e.courts.filter(c => c === maxCourt).length,
      streak: maxStreak(e.seq),
      avgFor: e.games ? Math.round((e.pf / (e.w + e.l)) * 10) / 10 : 0,
      avgAgainst: e.games ? Math.round((e.pa / (e.w + e.l)) * 10) / 10 : 0,
    };
  });

  // Site ranking: wins → point differential → Dink Rating.
  rows.sort((a, b) => (b.w - a.w) || (b.diff - a.diff) || ((b.dr ?? -1) - (a.dr ?? -1)));
  rows.forEach((r, i) => { r.rank = i + 1; });

  const rankOf = {};
  rows.forEach(r => { rankOf[r.key] = r.rank; });

  // ── awards, all derived from the numbers above ──
  const byDesc = (arr, f) => [...arr].sort((a, b) => f(b) - f(a));
  const closest = [...games].sort((a, b) => (a.margin - b.margin) || (a.round - b.round))[0];
  const widest = [...games].sort((a, b) => (b.margin - a.margin) || (a.round - b.round))[0];
  const climbers = byDesc(rows.filter(r => r.climb > 0), r => r.climb);
  const sliders = [...rows.filter(r => r.climb < 0)]
    .sort((a, b) => (a.climb - b.climb) || (a.end - b.end) || (b.start - a.start));
  const kingCourt = byDesc(rows, r => r.kingRounds);
  const scorers = byDesc(rows, r => r.pf);
  const streaks = byDesc(rows, r => r.streak);
  const nameOfKey = k => (entities.get(k)?.name) || '';

  const awards = [];
  const awarded = new Set();
  // Prefer an entity that hasn't already won something when candidates are tied
  // on the metric — one pair sweeping every award reads as a bug, not a night.
  const pick = (sorted, metric) => {
    if (!sorted.length) return null;
    const best = metric(sorted[0]);
    const tied = sorted.filter(r => metric(r) === best);
    return tied.find(r => !awarded.has(r.key)) || tied[0];
  };
  const push = a => { awards.push(a); awarded.add(a.entity); };
  if (rows[0]) push({
    cls: 'winner', tag: rows.length && rows[0].pair ? 'Night winners' : 'Night winner',
    entity: rows[0].key,
    detail: `${rows[0].w}-${rows[0].l} and ${signed(rows[0].diff)}${rows[0].climb > 0
      ? `, climbing from ${courtName(rows[0].start)} to ${courtName(rows[0].end)}`
      : ''}. Allowed ${rows[0].avgAgainst} points a game.`,
  });
  const topScorer = pick(scorers, r => r.pf);
  if (topScorer && topScorer.key !== rows[0]?.key) push({
    cls: 'gain', tag: 'Most points scored', entity: topScorer.key,
    detail: `${topScorer.pf} points at ${topScorer.avgFor} a game, more than anyone else on the night.`,
  });
  const climber = pick(climbers, r => r.climb);
  if (climber && climber.key !== rows[0]?.key) push({
    cls: 'climb', tag: 'Biggest climb', entity: climber.key,
    detail: `${courtName(climber.start)} up to ${courtName(climber.end)}, ${signed(climber.climb)} courts across the night.`,
  });
  const king = pick(kingCourt, r => r.kingRounds);
  if (king && king.kingRounds > 0) push({
    cls: 'kitchen', tag: 'King Court tenure', entity: king.key,
    detail: `${king.kingRounds} of ${king.games} rounds on ${courtName(maxCourt)}, the top court${
      kingCourt.filter(r => r.kingRounds === king.kingRounds).length > 1 ? '' : ' — more than anyone else'}.`,
  });
  const streaker = pick(streaks, r => r.streak);
  if (streaker && streaker.streak >= 3) push({
    cls: 'gain', tag: 'Longest win streak', entity: streaker.key,
    detail: `${streaker.streak} straight wins.`,
  });
  if (closest && closest.margin <= 2) push({
    cls: 'kitchen', tag: 'Closest game',
    entity: closest.sa > closest.sb ? closest.entA : closest.entB,
    detail: `${Math.max(closest.sa, closest.sb)}-${Math.min(closest.sa, closest.sb)} over ${
      esc(nameOfKey(closest.sa > closest.sb ? closest.entB : closest.entA))
    } in round ${closest.round} on ${courtName(closest.court)}${
      games.filter(g => g.margin === closest.margin).length === 1
        ? ` — the only ${closest.margin}-point game of the night` : ''
    }.`,
  });
  const slider = pick(sliders, r => r.climb);
  if (slider) push({
    cls: 'drop', tag: 'Free fall', entity: slider.key,
    detail: `From ${courtName(slider.start)} down to ${courtName(slider.end)}, ${slider.climb} courts — the steepest slide of the night.`,
  });
  const last = rows[rows.length - 1];
  if (last && rows.length > 3) push({
    cls: 'loser', tag: 'Toughest night', entity: last.key,
    detail: `${last.w}-${last.l} with a ${signed(last.diff)} differential.`,
  });

  // Standings as they stood BEFORE the last round. Most ladder nights are
  // decided in that final game, and a tie or a one-game lead going in is the
  // story — but it is invisible in the final table, so compute it explicitly.
  const lastRound = Math.max(...games.map(g => g.round));
  const beforeFinal = (() => {
    if (lastRound < 2) return null;
    const acc = {};
    for (const r of rows) acc[r.key] = { key: r.key, name: r.name, w: 0, l: 0, pf: 0, pa: 0, dr: r.dr };
    for (const g of games) {
      if (g.round >= lastRound) continue;
      const A = acc[g.entA], B = acc[g.entB];
      if (!A || !B) continue;
      A.pf += g.sa; A.pa += g.sb; B.pf += g.sb; B.pa += g.sa;
      if (g.sa > g.sb) { A.w++; B.l++; } else if (g.sb > g.sa) { B.w++; A.l++; }
    }
    const list = Object.values(acc).map(x => ({ ...x, diff: x.pf - x.pa }));
    list.sort((a, b) => (b.w - a.w) || (b.diff - a.diff) || ((b.dr ?? -1) - (a.dr ?? -1)));
    list.forEach((x, i) => { x.rank = i + 1; });
    return list;
  })();

  const roster = [...new Set(games.flatMap(g => [...g.a, ...g.b]))];

  return {
    event: {
      id: event.id,
      name: event.name || 'Ladder',
      date: String(event.date || play.date || '').slice(0, 10),
      place: event.place || null,
      placeLong: event.placeLong || null,
      address: event.address || null,
      type: event.type || 'mixed',
      format: event.format || (fpm ? 'fixed-partner' : 'individual'),
      courtNames: event.courtNames || null,
      dupr: !!event.dupr,
    },
    fixedPartner: !!fpm,
    maxCourt,
    courtLabel: idx => courtName(idx),
    kpis: {
      players: roster.length,
      pairs: fpm ? rows.length : null,
      games: games.length,
      rounds: (play.rounds || []).length,
      courts: maxCourt,
    },
    rows,
    games,
    awards,
    beforeFinal,
    lastRound,
    byId,
    entities,
  };
}

// ───────────────────────────── narrative ─────────────────────────────

const SYSTEM = `You are the editorial voice of The Dink Society, a social pickleball league in Southern California, writing the long-form recap article for one ladder night. The voice: a great sports columnist secretly having the time of their life. Confident, specific, funny, warm. The league's motto is "The Society keeps receipts."

You are given a STATS PACK containing every computed number for the night, and sometimes NIGHT NOTES from the organizer with context the numbers cannot show (someone's partner no-showed, a player was on vacation, a running joke). The notes are true and are the best material in the pack. Use them.

HARD RULES, no exceptions:
- Every number you write MUST appear in the STATS PACK. Never invent or estimate a score, record, differential, rating, court, round number or streak. If you want to make a point and the number is not in the pack, make a different point.
- Never invent quotes, names, or events. NIGHT NOTES may be paraphrased but not embellished with invented detail.
- Roast records and math, never people. Everyone keeps their dignity, especially whoever finished last.
- The tiebreaker is wins, then point differential, then Dink Rating (DR). It is NEVER head-to-head. Do not describe a tie as broken by head-to-head.
- On a night with only 2 courts there is no real court movement, so do not use climbing or ladder-progression framing. With 3+ courts, climbing framing is accurate and encouraged.
- Court direction: the STATS PACK names the top court (King Court) and the bottom court explicitly. Use those names exactly as given. Never assume a court name is high or low from its letter or number.
- On a fixed-partner night the pair places together; write about pairs, not individuals, in the standings narrative.
- Name a player as first name plus last initial on first mention, first name after.
- No em dashes anywhere. Recast the sentence instead.

Return ONLY valid JSON, no markdown fence, in exactly this shape:
{
  "headline": "the article headline, earned and specific, 6 to 14 words",
  "dek": "one sentence under the headline giving the night's shape",
  "paragraphs": ["<p-worth of text>", "…4 to 6 of them…"]
}
Paragraphs are plain text, no HTML tags. Lead with whatever actually decided the night. Check standingsBeforeTheFinalRound against the final standings first: if the night turned on the last round, if anyone was tied going in, or if a pair led with one round left and finished off the podium, that IS the lead. Otherwise lead with the winner. Then the podium fight, then the rest of the field, then anything from NIGHT NOTES that deserves its own beat.`;

function statsPack(stats) {
  const cn = stats.courtLabel;
  return {
    event: stats.event,
    format: stats.fixedPartner ? 'fixed-partner (pairs place together)' : 'individual',
    shape: stats.kpis,
    topCourtIsCalled: cn(stats.maxCourt) + ' — the TOP court, called King Court',
    bottomCourtIsCalled: cn(1) + ' — the BOTTOM court',
    standings: stats.rows.map(r => ({
      rank: r.rank, name: r.name, record: `${r.w}-${r.l}`,
      pointsFor: r.pf, pointsAgainst: r.pa, differential: r.diff,
      dinkRating: r.dr, pointsPerGame: r.avgFor, allowedPerGame: r.avgAgainst,
      longestWinStreak: r.streak,
      startedOn: cn(r.start), finishedOn: cn(r.end), courtsMoved: r.climb,
      roundsOnKingCourt: r.kingRounds, roundsPlayed: r.games,
      courtByRound: r.courts.map(cn),
      resultByRound: r.seq,
    })),
    standingsBeforeTheFinalRound: stats.beforeFinal ? stats.beforeFinal.map(r => ({
      rank: r.rank, name: r.name, record: `${r.w}-${r.l}`, differential: r.diff,
    })) : null,
    finalRoundNumber: stats.lastRound,
    everyGame: stats.games.map(g => ({
      round: g.round, court: cn(g.court),
      winner: g.sa > g.sb ? g.aNames.join(' & ') : g.bNames.join(' & '),
      loser: g.sa > g.sb ? g.bNames.join(' & ') : g.aNames.join(' & '),
      score: `${Math.max(g.sa, g.sb)}-${Math.min(g.sa, g.sb)}`,
      margin: g.margin,
    })),
    computedAwards: stats.awards.map(a => ({
      award: a.tag, who: stats.entities.get(a.entity)?.name, detail: a.detail.replace(/<[^>]+>/g, ''),
    })),
  };
}

/** Templated write-up used when there is no API key or the call fails. */
function basicNarrative(stats) {
  const cn = stats.courtLabel;
  const r = stats.rows;
  const w = r[0];
  const unit = stats.fixedPartner ? 'pair' : 'player';
  const paragraphs = [];
  if (w) paragraphs.push(
    `${w.name} took the night at ${w.w}-${w.l} with a ${signed(w.diff)} point differential, ` +
    `scoring ${w.avgFor} a game and allowing ${w.avgAgainst}. ` +
    (w.climb > 0
      ? `They started on ${cn(w.start)} and finished on ${cn(w.end)}.`
      : `They started and finished on ${cn(w.end)}.`)
  );
  if (r[1] && r[2]) paragraphs.push(
    `${r[1].name} finished second at ${r[1].w}-${r[1].l} (${signed(r[1].diff)}), ` +
    `and ${r[2].name} took third at ${r[2].w}-${r[2].l} (${signed(r[2].diff)}). ` +
    `Places are settled on wins first, then point differential, then Dink Rating.`
  );
  const best = [...r].sort((a, b) => b.kingRounds - a.kingRounds)[0];
  if (best && best.kingRounds > 0) paragraphs.push(
    `${best.name} spent the most time on King Court, ${best.kingRounds} of ${best.games} rounds on ${cn(stats.maxCourt)}.`
  );
  paragraphs.push(
    `${stats.kpis.games} games across ${stats.kpis.rounds} rounds on ${stats.kpis.courts} courts, ` +
    `with ${stats.kpis.players} players${stats.kpis.pairs ? ` in ${stats.kpis.pairs} fixed pairs` : ''}. ` +
    `Full standings and the round by round board are below.`
  );
  return {
    headline: w ? `${w.name} Take the ${stats.event.name}` : `${stats.event.name} Recap`,
    dek: `${stats.kpis.players} players · ${stats.kpis.rounds} rounds · ${stats.kpis.courts} courts`,
    paragraphs,
    engine: 'basic',
  };
}

function extractJson(text) {
  if (!text) throw new Error('Empty model response');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('No JSON object in model response');
  return JSON.parse(raw.slice(start, end + 1));
}

export async function writeNarrative(stats, { notes = '' } = {}) {
  const key = apiKey();
  if (!key) return basicNarrative(stats);
  try {
    const user = `STATS PACK\n${JSON.stringify(statsPack(stats), null, 2)}\n\n` +
      (notes ? `NIGHT NOTES from the organizer (true, use them):\n${notes}\n\n` : '') +
      `Write the article for ${stats.event.name} on ${stats.event.date}.`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: modelId(), max_tokens: 3000, system: SYSTEM,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const out = extractJson(text);
    if (!out.headline || !Array.isArray(out.paragraphs) || !out.paragraphs.length) {
      throw new Error('Model response missing headline/paragraphs');
    }
    return { ...out, engine: 'claude', model: modelId() };
  } catch (e) {
    const fb = basicNarrative(stats);
    return { ...fb, engine: 'basic-fallback', error: String(e.message || e) };
  }
}

// ────────────────────────────── render ──────────────────────────────

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  :root { --bg:#0e0e0e; --surf1:#161616; --surf2:#1e1e1e; --surf3:#262626;
    --lime:#b8ff2c; --teal:#17d7b0; --gold:#f0c040; --red:#ff5c47;
    --txt:#f0f0ec; --txt-muted:#9a9e97; --txt-faint:#5e625c; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt);
    font-family:'Inter',-apple-system,sans-serif; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:980px; margin:0 auto; padding:104px 24px 80px; }
  .eyebrow { color:var(--lime); text-transform:uppercase; letter-spacing:.12em; font-size:12px; font-weight:800; }
  h1 { font-size:34px; font-weight:900; margin:8px 0 4px; line-height:1.1; }
  h1 .accent { color:var(--lime); }
  .sub { color:var(--txt-muted); font-size:14.5px; margin:0 0 28px; }
  .banner { background:var(--surf1); border-left:3px solid var(--teal); border-radius:0 10px 10px 0;
    padding:14px 18px; font-size:13.5px; color:var(--txt-muted); line-height:1.6; margin-bottom:32px; }
  .banner strong { color:var(--teal); }
  .plink { color:inherit; text-decoration:none; border-bottom:1px dotted rgba(240,240,236,.4); }
  .plink:hover { color:var(--lime); border-bottom-color:var(--lime); }
  .article-wrap { display:grid; grid-template-columns:1fr 260px; gap:28px; margin-bottom:32px; align-items:start; }
  .article { grid-column:1; }
  .article .kick { color:var(--gold); text-transform:uppercase; letter-spacing:.1em; font-size:11px; font-weight:800; margin-bottom:8px; }
  .article h2 { font-size:23px; font-weight:900; line-height:1.2; margin:0 0 10px; max-width:34ch; }
  .article p { font-size:14.5px; line-height:1.75; color:var(--txt); max-width:64ch; margin:0 0 14px; }
  .article p:last-child { margin-bottom:0; }
  .article strong { color:var(--lime); }
  .podium-aside { grid-column:2; display:flex; flex-direction:column; gap:12px; position:sticky; top:24px; }
  .podcard { background:var(--surf1); border:1px solid; border-radius:14px; padding:16px 18px; }
  .podcard.pod-first { padding:20px 20px 22px; }
  .pod-rank { display:inline-flex; align-items:center; gap:5px; font-size:10.5px; font-weight:900; letter-spacing:.08em; border-radius:6px; padding:3px 8px; margin-bottom:10px; }
  .pod-name { font-size:15px; font-weight:800; margin-bottom:12px; }
  .podcard.pod-first .pod-name { font-size:17px; }
  .pod-body { display:flex; gap:14px; align-items:center; }
  .pod-rec { text-align:center; flex-shrink:0; }
  .pod-rec .v { font-size:26px; font-weight:900; line-height:1; color:var(--lime);
    text-shadow:0 0 14px rgba(184,255,44,.45),0 0 3px rgba(184,255,44,.6); }
  .podcard.pod-first .pod-rec .v { font-size:30px; }
  .pod-rec .l { font-size:9px; text-transform:uppercase; letter-spacing:.06em; color:var(--txt-faint); font-weight:700; margin-top:5px; }
  .pod-div { width:1px; align-self:stretch; background:var(--surf3); }
  .pod-side { flex:1; display:flex; flex-direction:column; gap:9px; }
  .pod-stat { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
  .pod-stat .v { font-size:18px; font-weight:900; line-height:1; }
  .podcard.pod-first .pod-stat .v { font-size:20px; }
  .pod-stat .l { font-size:9.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--txt-faint); font-weight:700; }
  .diff-v { color:var(--gold); text-shadow:0 0 10px rgba(240,192,64,.3); }
  .dr-v { color:var(--teal); text-shadow:0 0 10px rgba(23,215,176,.3); }
  .kpirow { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:32px; }
  .kpi { background:var(--surf1); border-radius:12px; padding:16px 18px; }
  .kpi .val { font-size:28px; font-weight:800; color:var(--txt); }
  .kpi .lbl { font-size:11.5px; color:var(--txt-muted); text-transform:uppercase; letter-spacing:.06em; margin-top:2px; }
  .awards { display:grid; grid-template-columns:repeat(2,1fr); gap:14px; margin-bottom:40px; }
  .award { background:var(--surf1); border-radius:14px; padding:20px 22px; position:relative; overflow:hidden; }
  .award::before { content:""; position:absolute; top:0; left:0; width:4px; height:100%; }
  .award.winner::before { background:var(--lime); } .award.loser::before { background:var(--red); }
  .award.climb::before { background:var(--teal); } .award.kitchen::before { background:var(--gold); }
  .award.gain::before { background:var(--lime); } .award.drop::before { background:var(--red); }
  .award .tag { font-size:11px; text-transform:uppercase; letter-spacing:.08em; font-weight:800; margin-bottom:8px; }
  .award.winner .tag { color:var(--lime); } .award.loser .tag { color:var(--red); }
  .award.climb .tag { color:var(--teal); } .award.kitchen .tag { color:var(--gold); }
  .award.gain .tag { color:var(--lime); } .award.drop .tag { color:var(--red); }
  .award .who { font-size:20px; font-weight:800; margin-bottom:4px; }
  .award .detail { font-size:13px; color:var(--txt-muted); line-height:1.5; }
  section { margin-bottom:44px; }
  h2 { font-size:18px; font-weight:800; margin:0 0 4px; }
  .chart-sub { font-size:12.5px; color:var(--txt-muted); margin:0 0 18px; }
  .legend { display:flex; gap:18px; font-size:12px; color:var(--txt-muted); margin-bottom:14px; }
  .legend span { display:inline-flex; align-items:center; gap:6px; }
  .swatch { width:10px; height:10px; border-radius:3px; display:inline-block; }
  .diffrow { display:flex; align-items:center; height:30px; margin-bottom:6px; }
  .diffname { width:150px; font-size:12.5px; color:var(--txt-muted); flex-shrink:0; text-align:right; padding-right:12px; }
  .diffbar { position:relative; flex:1; height:30px; }
  .diffbar-mid { position:absolute; left:50%; top:0; bottom:0; width:1px; background:var(--surf3); }
  .wlrow { display:flex; align-items:center; height:26px; margin-bottom:8px; }
  .wlname { width:150px; font-size:12.5px; color:var(--txt-muted); flex-shrink:0; text-align:right; padding-right:12px; }
  .wlbarwrap { display:flex; align-items:center; height:22px; position:relative; }
  .wlbar { height:22px; border-radius:4px; }
  .wlgap { width:2px; }
  .wlrecord { margin-left:10px; font-size:12px; font-weight:700; color:var(--txt); }
  .table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; margin:0 -4px; }
  table { width:100%; min-width:600px; border-collapse:collapse; font-size:13px; }
  thead th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--txt-faint); font-weight:700; padding:8px 10px; border-bottom:1px solid var(--surf3); }
  thead th.num, td.num { text-align:right; }
  thead th.sortable { cursor:pointer; user-select:none; }
  thead th.sortable:hover { color:var(--txt); }
  thead th.sortable:focus-visible { outline:1px solid var(--teal); outline-offset:2px; }
  thead th.sortable::after { content:'\\2195'; display:inline-block; margin-left:5px; opacity:.35; font-size:10px; }
  thead th.sortable[data-sort-dir="asc"]::after { content:'\\25B2'; opacity:1; color:var(--teal); }
  thead th.sortable[data-sort-dir="desc"]::after { content:'\\25BC'; opacity:1; color:var(--teal); }
  tbody td { padding:10px; border-bottom:1px solid var(--surf1); font-variant-numeric:tabular-nums; }
  tbody tr:hover { background:var(--surf1); }
  td.rank { color:var(--txt-faint); } td.pname { font-weight:600; }
  .rounds { display:grid; grid-template-columns:repeat(2,1fr); gap:14px; }
  .rnd { background:var(--surf1); border-radius:12px; padding:14px 16px; }
  .rnd h3 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--txt-faint); font-weight:800; margin:0 0 10px; }
  .gm { display:flex; align-items:baseline; gap:8px; font-size:12.5px; padding:5px 0; border-bottom:1px solid var(--surf2); }
  .gm:last-child { border-bottom:0; }
  .gm .ct { color:var(--txt-faint); font-weight:700; font-size:10.5px; width:30px; flex-shrink:0; }
  .gm .tm { flex:1; color:var(--txt-muted); }
  .gm .tm.won { color:var(--txt); font-weight:700; }
  .gm .sc { font-variant-numeric:tabular-nums; font-weight:700; color:var(--txt); flex-shrink:0; }
  .gm .kt { color:var(--gold); font-size:10px; font-weight:800; flex-shrink:0; }
  @media (max-width:900px) {
    .article-wrap { grid-template-columns:1fr; }
    .podium-aside { grid-column:1; order:-1; margin-bottom:8px; position:static; flex-direction:row; overflow-x:auto; }
    .article { order:1; } .podcard { flex:1 1 0; min-width:150px; }
  }
  @media (max-width:640px) {
    .kpirow,.awards,.rounds { grid-template-columns:1fr 1fr; }
    .diffname,.wlname { width:90px; font-size:11px; }
    .diffbar { width:auto; } .podium-aside { flex-direction:column; }
  }
  @media (max-width:520px) { .rounds { grid-template-columns:1fr; } }
`;

const SORT_SCRIPT = `
(function(){
  var table=document.getElementById('statsheet'); if(!table) return;
  var tbody=table.querySelector('tbody'), headers=table.querySelectorAll('th.sortable');
  var state={key:null,dir:1};
  headers.forEach(function(th){
    th.setAttribute('tabindex','0'); th.setAttribute('role','button');
    function doSort(){
      var key=th.getAttribute('data-key'), dir;
      if(state.key===key){dir=-state.dir;}else{dir=(key==='name')?1:-1;}
      state={key:key,dir:dir};
      headers.forEach(function(t){t.removeAttribute('data-sort-dir');});
      th.setAttribute('data-sort-dir',dir===1?'asc':'desc');
      var rows=Array.prototype.slice.call(tbody.querySelectorAll('tr'));
      rows.sort(function(ra,rb){
        var av=ra.getAttribute('data-'+key), bv=rb.getAttribute('data-'+key);
        if(key==='name') return dir*av.localeCompare(bv);
        return dir*(parseFloat(av)-parseFloat(bv));
      });
      rows.forEach(function(r){tbody.appendChild(r);});
    }
    th.addEventListener('click',doSort);
    th.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){e.preventDefault();doSort();} });
  });
})();
`;

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function prettyDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  if (!m) return String(d || '');
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

export function renderArticleHtml(stats, narrative) {
  const cn = stats.courtLabel;
  const rows = stats.rows;
  const ent = k => stats.entities.get(k);
  const pid = name => {
    for (const p of Object.values(stats.byId)) if (p.name === name) return p.id;
    return null;
  };
  const nameLink = name => {
    const id = pid(name);
    return id
      ? `<a class="plink" href="/profile?ladderId=${encodeURIComponent(id)}">${esc(name)}</a>`
      : esc(name);
  };
  const entLink = k => (ent(k)?.names || []).map(nameLink).join(' &amp; ');
  const entShort = k => (ent(k)?.names || []).map(firstName).map(esc).join(' &amp; ');

  // Link player names where they appear in the prose, first mention only.
  const linkProse = text => {
    let out = esc(text);
    const seen = new Set();
    const names = Object.values(stats.byId).map(p => p.name)
      .sort((a, b) => b.length - a.length);
    for (const n of names) {
      if (seen.has(n)) continue;
      const safe = esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(^|[^\\w>])(${safe})(?![^<]*>)`, '');
      if (re.test(out)) { out = out.replace(re, (m, p1, p2) => `${p1}${nameLink(n)}`); seen.add(n); }
    }
    return out;
  };

  const unit = stats.fixedPartner ? 'pair' : 'player';
  const L = [];
  const A = s => L.push(s);

  A('<!DOCTYPE html>');
  A('<html lang="en" data-palette="#b8ff2c,#17d7b0,#f0c040,#ff5c47">');
  A('<head>');
  A('<meta charset="UTF-8">');
  A('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
  A(`<title>${esc(stats.event.name)} Recap &mdash; ${prettyDate(stats.event.date)} | The Dink Society</title>`);
  A(`<meta name="description" content="${esc(narrative.dek || `Recap of the ${prettyDate(stats.event.date)} ${stats.event.name}: standings, court movement and the full round by round board.`)}">`);
  A('<link rel="icon" type="image/svg+xml" href="/img/favicon.svg">');
  A('<link rel="stylesheet" href="/css/shared.css">');
  A('<script>(function(){var t=localStorage.getItem("ds-theme");if(t==="light"){document.documentElement.setAttribute("data-theme","light")}else{document.documentElement.setAttribute("data-theme","dark")}})()</script>');
  A('<link rel="stylesheet" href="/css/shared-nav.css">');
  A(`<style>${CSS}</style>`);
  A('</head>');
  A('<body data-page="ladders">');
  A('<div data-partial="nav"></div>');
  A('<div class="wrap">');
  A('  <div class="eyebrow">The Dink Society</div>');
  A(`  <h1>${esc(stats.event.name)} <span class="accent">Recap</span></h1>`);
  const subBits = [prettyDate(stats.event.date)];
  if (stats.event.placeLong || stats.event.place) subBits.push(stats.event.placeLong || stats.event.place);
  subBits.push(`${stats.kpis.players} players`);
  if (stats.kpis.pairs) subBits.push(`${stats.kpis.pairs} fixed pairs`);
  subBits.push(`${stats.kpis.rounds} rounds`, `${stats.kpis.courts} courts`);
  A(`  <p class="sub">${subBits.map(esc).join(' &middot; ')}</p>`);

  // article + podium
  A('  <div class="article-wrap">');
  A('    <div class="article">');
  A('      <div class="kick">The Recap</div>');
  A(`      <h2>${esc(narrative.headline)}</h2>`);
  for (const p of narrative.paragraphs) A(`    <p>${linkProse(p)}</p>`);
  A('    </div>');
  A('    <div class="podium-aside">');
  const pod = [['pod-first', '#f0c040', '&#129351; 1ST'], ['', '#cfd3c8', '&#129352; 2ND'], ['', '#d88a3a', '&#129353; 3RD']];
  pod.forEach(([cls, c, label], i) => {
    const r = rows[i]; if (!r) return;
    A(`    <div class="podcard ${cls}" style="border-color:${c}55;">`);
    A(`      <div class="pod-rank" style="color:${c};background:${c}1a;">${label}</div>`);
    A(`      <div class="pod-name">${entLink(r.key)}</div>`);
    A('      <div class="pod-body">');
    A(`        <div class="pod-rec"><div class="v">${r.w}-${r.l}</div><div class="l">Record</div></div>`);
    A('        <div class="pod-div"></div>');
    A('        <div class="pod-side">');
    A(`          <div class="pod-stat"><span class="l">Diff</span><span class="v diff-v">${signed(r.diff)}</span></div>`);
    if (r.dr != null) A(`          <div class="pod-stat"><span class="l">DR</span><span class="v dr-v">${r.dr}</span></div>`);
    A('        </div>');
    A('      </div>');
    A('    </div>');
  });
  A('    </div>');
  A('  </div>');

  // banner
  const bannerBits = [];
  if (stats.fixedPartner) bannerBits.push(
    '<strong>Fixed Partner format:</strong> teams were locked at signup and stayed together all night, ' +
    'no re-pairing between rounds, so the standings here are by pair. Every game still counts on each player&rsquo;s individual profile.'
  );
  bannerBits.push(
    `Winners move up a court, losers move down. <strong>${esc(cn(stats.maxCourt))} is King Court</strong>, ${esc(cn(1))} the bottom. ` +
    'Ranked by <strong>wins &rarr; point differential &rarr; DR</strong>.'
  );
  A(`  <div class="banner">${bannerBits.join(' ')}</div>`);

  // kpis
  A('  <div class="kpirow">');
  const kpis = [[stats.kpis.players, 'Players']];
  if (stats.kpis.pairs) kpis.push([stats.kpis.pairs, 'Fixed pairs']);
  kpis.push([stats.kpis.games, 'Games played'], [stats.kpis.rounds, 'Rounds']);
  if (kpis.length < 4) kpis.push([stats.kpis.courts, 'Courts']);
  kpis.slice(0, 4).forEach(([v, l]) => A(`    <div class="kpi"><div class="val">${v}</div><div class="lbl">${l}</div></div>`));
  A('  </div>');

  // awards
  if (stats.awards.length) {
    A('  <div class="awards">');
    for (const a of stats.awards) {
      A(`    <div class="award ${a.cls}">`);
      A(`      <div class="tag">${esc(a.tag)}</div>`);
      A(`      <div class="who">${entLink(a.entity)}</div>`);
      A(`      <div class="detail">${a.detail}</div>`);
      A('    </div>');
    }
    A('  </div>');
  }

  // standings
  A('  <section>');
  A(`    <h2>${stats.fixedPartner ? 'Pair standings' : 'Standings'}</h2>`);
  A(`    <p class="chart-sub">${stats.fixedPartner
    ? 'Partners share every game, so wins, points and differential are the pair&rsquo;s. '
    : ''}Ranked by wins &rarr; point differential &rarr; DR. &ldquo;King Court rds&rdquo; counts rounds played on ${esc(cn(stats.maxCourt))}, the top court.</p>`);
  A('    <div class="table-wrap">');
  A('    <table>');
  A('      <thead><tr>');
  A(`        <th>#</th><th>${stats.fixedPartner ? 'Pair' : 'Player'}</th><th class="num">W-L</th><th class="num">PF-PA</th>`);
  A('        <th class="num">Diff</th><th class="num">DR</th><th class="num">Court (start&rarr;end)</th><th class="num">Climb</th><th class="num">King Court rds</th>');
  A('      </tr></thead>');
  A('      <tbody>');
  for (const r of rows) {
    const dc = r.diff > 0 ? '#b8ff2c' : '#ff5c47';
    const climb = r.climb > 0
      ? `<span style="color:#b8ff2c;">+${r.climb}</span>`
      : r.climb < 0 ? `<span style="color:#ff5c47;">${r.climb}</span>` : '<span style="color:#9a9e97;">0</span>';
    A('    <tr>');
    A(`      <td class="rank">${r.rank}</td>`);
    A(`      <td class="pname">${entLink(r.key)}</td>`);
    A(`      <td class="num">${r.w}-${r.l}</td>`);
    A(`      <td class="num">${r.pf}-${r.pa}</td>`);
    A(`      <td class="num" style="color:${dc};font-weight:700;">${signed(r.diff)}</td>`);
    A(`      <td class="num">${r.dr ?? '&mdash;'}</td>`);
    A(`      <td class="num">${esc(cn(r.start))} &rarr; ${esc(cn(r.end))}</td>`);
    A(`      <td class="num">${climb}</td>`);
    A(`      <td class="num">${r.kingRounds}/${r.games}</td>`);
    A('    </tr>');
  }
  A('      </tbody></table></div>');
  A('  </section>');

  // differential chart
  const mx = Math.max(1, ...rows.map(r => Math.abs(r.diff)));
  A('  <section>');
  A(`    <h2>Point differential by ${unit}</h2>`);
  A('    <div class="legend">');
  A('      <span><span class="swatch" style="background:#b8ff2c"></span>Net positive</span>');
  A('      <span><span class="swatch" style="background:#ff5c47"></span>Net negative</span>');
  A('    </div>');
  for (const r of rows) {
    const w = (Math.abs(r.diff) / mx * 44).toFixed(1);
    A(`    <div class="diffrow" title="${esc(r.name)}: ${r.w}-${r.l}, point diff ${signed(r.diff)}">`);
    A(`      <div class="diffname">${entShort(r.key)}</div>`);
    A('      <div class="diffbar"><div class="diffbar-mid"></div>');
    if (r.diff >= 0) {
      A(`        <div style="position:absolute;left:50%;width:${w}%;top:4px;height:20px;background:#b8ff2c;border-radius:4px;"></div><span style="position:absolute;left:calc(50% + ${w}% + 8px);top:5px;font-weight:600;color:#f0f0ec;font-size:12.5px;">${signed(r.diff)}</span>`);
    } else {
      A(`        <div style="position:absolute;right:50%;width:${w}%;top:4px;height:20px;background:#ff5c47;border-radius:4px;"></div><span style="position:absolute;right:calc(50% + ${w}% + 8px);top:5px;font-weight:600;color:#f0f0ec;font-size:12.5px;">${r.diff}</span>`);
    }
    A('      </div>');
    A('    </div>');
  }
  A('  </section>');

  // W/L chart
  const maxGames = Math.max(1, ...rows.map(r => r.games));
  const px = 200 / maxGames;
  A('  <section>');
  A(`    <h2>Win / loss record by ${unit}</h2>`);
  A('    <div class="legend">');
  A('      <span><span class="swatch" style="background:#b8ff2c"></span>Wins</span>');
  A('      <span><span class="swatch" style="background:#ff5c47"></span>Losses</span>');
  A('    </div>');
  for (const r of rows) {
    A(`    <div class="wlrow" title="${esc(r.name)}: ${r.w} wins, ${r.l} losses">`);
    A(`      <div class="wlname">${entShort(r.key)}</div>`);
    A('      <div class="wlbarwrap">');
    A(`        <div class="wlbar" style="width:${Math.round(r.w * px)}px;background:#b8ff2c;"></div>`);
    A('        <div class="wlgap"></div>');
    A(`        <div class="wlbar" style="width:${Math.round(r.l * px)}px;background:#ff5c47;"></div>`);
    A(`        <span class="wlrecord">${r.w}-${r.l}</span>`);
    A('      </div>');
    A('    </div>');
  }
  A('  </section>');

  // round by round
  const byRound = {};
  for (const g of stats.games) (byRound[g.round] = byRound[g.round] || []).push(g);
  A('  <section>');
  A('    <h2>Round by round</h2>');
  A(`    <p class="chart-sub">Every game of the night, court by court. ${esc(cn(stats.maxCourt))} is King Court, ${esc(cn(1))} the bottom.</p>`);
  A('    <div class="rounds">');
  for (const rn of Object.keys(byRound).sort((a, b) => a - b)) {
    A('      <div class="rnd">');
    A(`        <h3>Round ${rn}</h3>`);
    for (const g of byRound[rn].sort((x, y) => x.court - y.court)) {
      const aw = g.sa > g.sb ? 'won' : '';
      const bw = g.sb > g.sa ? 'won' : '';
      const kt = g.court === stats.maxCourt ? ' <span class="kt">KING</span>' : '';
      const cname = cn(g.court).replace(/^Court /, '');
      A(`        <div class="gm"><span class="ct">${esc(cname)}</span><span class="tm ${aw}">${entShort(g.entA)}</span><span class="sc">${g.sa}&ndash;${g.sb}</span><span class="tm ${bw}" style="text-align:right;">${entShort(g.entB)}</span>${kt}</div>`);
    }
    A('      </div>');
  }
  A('    </div>');
  A('  </section>');

  // individual table (fixed-partner nights only — otherwise it duplicates standings)
  if (stats.fixedPartner) {
    A('  <section>');
    A('    <h2>Individual stats (sortable)</h2>');
    A('    <p class="chart-sub">In Fixed Partner play a player&rsquo;s record and differential match their pair&rsquo;s. Every game still counts toward their overall Dink Society profile.</p>');
    A('    <div class="table-wrap">');
    A('    <table id="statsheet">');
    A('      <thead><tr>');
    A('        <th>#</th><th class="sortable" data-key="name">Player</th><th>Pair</th><th class="num">W-L</th>');
    A('        <th class="num sortable" data-key="diff">Diff</th><th class="num sortable" data-key="dr">DR</th>');
    A('        <th class="num sortable" data-key="streak">Best streak</th><th class="num">Court (start&rarr;end)</th>');
    A('      </tr></thead>');
    A('      <tbody>');
    let n = 0;
    for (const r of rows) {
      const dc = r.diff > 0 ? '#b8ff2c' : '#ff5c47';
      r.names.forEach((nm, j) => {
        n++;
        const other = firstName(r.names[1 - j] || '');
        A(`    <tr data-name="${esc(nm)}" data-diff="${r.diff}" data-dr="${r.dr ?? 0}" data-streak="${r.streak}">`);
        A(`      <td class="rank">${n}</td>`);
        A(`      <td class="pname">${nameLink(nm)}</td>`);
        A(`      <td>${other ? 'w/ ' + esc(other) : '&mdash;'}</td>`);
        A(`      <td class="num">${r.w}-${r.l}</td>`);
        A(`      <td class="num" style="color:${dc};font-weight:700;">${signed(r.diff)}</td>`);
        A(`      <td class="num">${r.dr ?? '&mdash;'}</td>`);
        A(`      <td class="num">${r.streak}</td>`);
        A(`      <td class="num">${esc(cn(r.start))} &rarr; ${esc(cn(r.end))}</td>`);
        A('    </tr>');
      });
    }
    A('      </tbody></table></div>');
    A('  </section>');
  }

  A('</div>');
  A('<div data-partial="footer"></div>');
  A('<script src="/js/partials.js"></script>');
  A(`<script src="/js/recap-photos.js" data-event="${esc(stats.event.id)}" defer></script>`);
  A(`<script>${SORT_SCRIPT}</script>`);
  A('</body>');
  A('</html>');
  return L.join('\n') + '\n';
}

// ──────────────────────────── orchestrator ────────────────────────────

function slugify(s) {
  return String(s || 'ladder').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Build and store the full recap article for one finished event.
 * @returns {Promise<{ok, skipped?, reason?, record?}>}
 */
export async function generateRecapArticle(eventId, { force = false, notes = '' } = {}) {
  const { getArticle, saveArticle } = await import('./recap-article-store.js');

  const existing = await getArticle(eventId);
  if (existing && !force) return { ok: false, skipped: true, reason: 'already-generated' };

  const stats = await buildArticleStats(eventId);
  if (!stats) return { ok: false, skipped: true, reason: 'no-scored-play' };
  if (stats.rows.length < 2) return { ok: false, skipped: true, reason: 'not-enough-players' };

  // Carry forward any notes the admin already attached unless new ones are given.
  const useNotes = notes || existing?.notes || '';
  const narrative = await writeNarrative(stats, { notes: useNotes });
  const html = renderArticleHtml(stats, narrative);

  const record = await saveArticle(eventId, {
    date: stats.event.date,
    slug: `${stats.event.date}-${slugify(stats.event.name)}`,
    title: narrative.headline,
    dek: narrative.dek || '',
    html,
    notes: useNotes,
    generatedBy: narrative.engine,
    model: narrative.model || null,
    generatorError: narrative.error || null,
    // Keep the numbers that went into the page, for debugging a bad article.
    stats: {
      event: stats.event,
      kpis: stats.kpis,
      standings: stats.rows.map(r => ({
        rank: r.rank, name: r.name, w: r.w, l: r.l, pf: r.pf, pa: r.pa,
        diff: r.diff, dr: r.dr, climb: r.climb, kingRounds: r.kingRounds, streak: r.streak,
      })),
    },
  });

  return { ok: true, record, engine: narrative.engine };
}
