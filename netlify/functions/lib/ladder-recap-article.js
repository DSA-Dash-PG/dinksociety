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
//   buildNarrative()      the PROSE — headline, dek and the paragraphs. Fully
//                         templated off the computed stats. No API, no key, no
//                         external call, so an article can never fail to
//                         publish and never invents a number.
//   renderArticleHtml()   the page itself. Awards, tables and charts are built
//                         from the computed stats too.
//
// The writer leads on whatever actually decided the night, which is why
// buildArticleStats computes `beforeFinal` (the table as it stood going into
// the last round). A tie or a lead change there is the story, and it is
// invisible in the final table.

import { getEvent, parseTime } from './ladder.js';
import { getPlay, toSession, playersFromPlay } from './ladder-play.js';
import { calcStats, calcDinkRating, fixedPartnerMap, orderPairWomenFirst } from './ladder-scoring.js';
import { getMergeMap, applyMerges } from './player-merge.js';
import { getDirectory, applyDirectory } from './player-directory.js';

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

/**
 * Not every ladder runs at night -- Men's Ladder #2 (2026-09-26) ran 9-11am, and
 * the article copy calling a morning ladder "Night DR" and "the night" read
 * wrong to players who were there. One word, derived from the event's own start
 * time, threading through the awards and narrative below instead of a
 * hardcoded "night".
 */
function sessionWords(event) {
  const t = parseTime(event?.startTime);
  const h = t ? t.h : 19; // unknown start time: keep the old evening-ladder default
  if (h < 12) return { noun: 'morning', cap: 'Morning' };
  if (h < 17) return { noun: 'afternoon', cap: 'Afternoon' };
  return { noun: 'night', cap: 'Night' };
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
  const session = sessionWords(event);

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
        mvp: 0, progress: [],   // progress: per-round {round, diff (cumulative), w, l, court}
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
    // On a FIXED-PARTNER night both of a team's ids resolve to the SAME entity
    // (keyFor pairs them), so crediting just g.a[0]/g.b[0] was already correct
    // there. On an INDIVIDUAL night each teammate is their OWN entity, and
    // crediting only index 0 silently dropped every second teammate's stats
    // from the whole night (2026-09-26: this is why Quan V had 0 recorded
    // games and vanished from the table, and why everyone else's record only
    // reflected the games where they happened to be listed first). Crediting
    // every distinct entity on each side fixes both formats: the Set collapses
    // back to one credit per team on a fixed-partner night.
    const sideAKeys = [...new Set(g.a.map(id => entityOf.get(id)).filter(Boolean))];
    const sideBKeys = [...new Set(g.b.map(id => entityOf.get(id)).filter(Boolean))];
    sideAKeys.forEach(k => {
      const e = entities.get(k); if (!e) return;
      e.pf += g.sa; e.pa += g.sb; e.courts.push(g.court);
      if (g.sa > g.sb) { e.w++; e.seq.push('W'); } else if (g.sb > g.sa) { e.l++; e.seq.push('L'); }
      e.progress.push({ round: g.round, diff: e.pf - e.pa, w: e.w, l: e.l, court: g.court, result: g.sa > g.sb ? 'W' : 'L' });
    });
    sideBKeys.forEach(k => {
      const e = entities.get(k); if (!e) return;
      e.pf += g.sb; e.pa += g.sa; e.courts.push(g.court);
      if (g.sb > g.sa) { e.w++; e.seq.push('W'); } else if (g.sa > g.sb) { e.l++; e.seq.push('L'); }
      e.progress.push({ round: g.round, diff: e.pf - e.pa, w: e.w, l: e.l, court: g.court, result: g.sb > g.sa ? 'W' : 'L' });
    });
    g.entA = ka; g.entB = kb;
    // Every entity on each side. On a fixed-partner night this is one key per
    // side (the pair); on an individual night it is BOTH players, which is
    // what the round-by-round board, awards and narrative have to print —
    // showing only entA/entB made every doubles game read as singles
    // (2026-10-05).
    g.sideA = sideAKeys; g.sideB = sideBKeys;
  }
  const sideName = keys => (keys || []).map(k => entities.get(k)?.name).filter(Boolean).join(' & ');

  // MVP shares: per round, whoever won by the largest margin that round gets
  // the credit (both entities on a winning side, since a team win is shared).
  // Richard, 2026-09-26: "best margin win that round" — a deliberately simple,
  // fully-computable stand-in for the MVP calls a human made on the hand-built
  // Kings Court article. Ties for the round's largest margin all get credit.
  {
    const byRound = new Map();
    for (const g of games) { if (!byRound.has(g.round)) byRound.set(g.round, []); byRound.get(g.round).push(g); }
    for (const rGames of byRound.values()) {
      const maxMargin = Math.max(...rGames.map(g => g.margin));
      if (maxMargin <= 0) continue;
      for (const g of rGames.filter(g => g.margin === maxMargin)) {
        for (const k of (g.sa > g.sb ? g.sideA : g.sideB)) {
          const e = entities.get(k);
          if (e) e.mvp++;
        }
      }
    }
  }

  // Comeback wins: the only "comeback" the box score can actually prove is a
  // win coming immediately after a loss the round before — there's no
  // point-by-point log to detect an in-game comeback from.
  for (const e of entities.values()) {
    e.comebackWins = e.seq.reduce((n, r, i) => n + (r === 'W' && e.seq[i - 1] === 'L' ? 1 : 0), 0);
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
      avgFor: (e.w + e.l) ? Math.round((e.pf / (e.w + e.l)) * 10) / 10 : 0,
      avgAgainst: (e.w + e.l) ? Math.round((e.pa / (e.w + e.l)) * 10) / 10 : 0,
      mvp: e.mvp,
      comebackWins: e.comebackWins,
      progress: e.progress,
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
  const push = a => { awards.push(a); (a.entities || [a.entity]).forEach(k => awarded.add(k)); };
  if (rows[0]) push({
    cls: 'winner', tag: rows.length && rows[0].pair ? `${session.cap} winners` : `${session.cap} winner`,
    entity: rows[0].key,
    detail: `${rows[0].w}-${rows[0].l} and ${signed(rows[0].diff)}${rows[0].climb > 0
      ? `, climbing from ${courtName(rows[0].start)} to ${courtName(rows[0].end)}`
      : ''}. Allowed ${rows[0].avgAgainst} points a game.`,
  });
  const topScorer = pick(scorers, r => r.pf);
  if (topScorer && topScorer.key !== rows[0]?.key) push({
    cls: 'gain', tag: 'Most points scored', entity: topScorer.key,
    detail: `${topScorer.pf} points at ${topScorer.avgFor} a game, more than anyone else on the ${session.noun}.`,
  });
  const climber = pick(climbers, r => r.climb);
  if (climber && climber.key !== rows[0]?.key) push({
    cls: 'climb', tag: 'Biggest climb', entity: climber.key,
    detail: `${courtName(climber.start)} up to ${courtName(climber.end)}, ${signed(climber.climb)} courts across the ${session.noun}.`,
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
    entities: closest.sa > closest.sb ? closest.sideA : closest.sideB,
    detail: `${Math.max(closest.sa, closest.sb)}-${Math.min(closest.sa, closest.sb)} over ${
      esc(sideName(closest.sa > closest.sb ? closest.sideB : closest.sideA))
    } in round ${closest.round} on ${courtName(closest.court)}${
      games.filter(g => g.margin === closest.margin).length === 1
        ? ` — the only ${closest.margin}-point game of the ${session.noun}` : ''
    }.`,
  });
  const slider = pick(sliders, r => r.climb);
  if (slider) push({
    cls: 'drop', tag: 'Free fall', entity: slider.key,
    detail: `From ${courtName(slider.start)} down to ${courtName(slider.end)}, ${slider.climb} courts — the steepest slide of the ${session.noun}.`,
  });
  const last = rows[rows.length - 1];
  if (last && rows.length > 3) push({
    cls: 'loser', tag: `Toughest ${session.noun}`, entity: last.key,
    detail: `${last.w}-${last.l} with a ${signed(last.diff)} differential.`,
  });
  // Biggest blowout margin (widest was already computed above and, before
  // 2026-09-26, never actually used anywhere).
  if (widest && widest.margin > 0) push({
    cls: 'kitchen', tag: 'Beat down',
    entity: widest.sa > widest.sb ? widest.entA : widest.entB,
    entities: widest.sa > widest.sb ? widest.sideA : widest.sideB,
    detail: `${Math.max(widest.sa, widest.sb)}-${Math.min(widest.sa, widest.sb)} over ${
      esc(sideName(widest.sa > widest.sb ? widest.sideB : widest.sideA))
    } in round ${widest.round} on ${courtName(widest.court)}${
      games.filter(g => g.margin === widest.margin).length === 1
        ? `, the widest margin of the ${session.noun}` : ''
    }.`,
  });
  // Best Dink Rating in the field, when it isn't already the outright winner —
  // DR and the win-loss ranking answer different questions (Kings Court had a
  // runner-up post the field's best rating).
  const bestDR = pick(byDesc(rows.filter(r => r.dr != null), r => r.dr), r => r.dr);
  if (bestDR && bestDR.key !== rows[0]?.key) push({
    cls: 'gain', tag: `Best ${session.noun} rating`, entity: bestDR.key,
    detail: `A ${bestDR.dr} Dink Rating, the highest in the field, on a ${bestDR.w}-${bestDR.l} record.`,
  });
  // Comeback wins: only provable as "won the round right after losing one" —
  // see the comment where comebackWins is computed.
  const comebacker = pick(byDesc(rows.filter(r => r.comebackWins > 0), r => r.comebackWins), r => r.comebackWins);
  if (comebacker) push({
    cls: 'gain', tag: 'Comeback king', entity: comebacker.key,
    detail: `${plural(comebacker.comebackWins, 'win')} that immediately followed a loss, more than anyone else.`,
  });
  // MVP shares (best-margin win per round — see where mvp is tallied above).
  const mvpLeader = pick(byDesc(rows.filter(r => r.mvp > 0), r => r.mvp), r => r.mvp);
  if (mvpLeader) push({
    cls: 'winner', tag: 'Most MVP nods', entity: mvpLeader.key,
    detail: `${plural(mvpLeader.mvp, 'round MVP share')}, the largest winning margin of the round, more than anyone else.`,
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
      for (const k of g.sideA) {
        const A = acc[k]; if (!A) continue;
        A.pf += g.sa; A.pa += g.sb;
        if (g.sa > g.sb) A.w++; else if (g.sb > g.sa) A.l++;
      }
      for (const k of g.sideB) {
        const B = acc[k]; if (!B) continue;
        B.pf += g.sb; B.pa += g.sa;
        if (g.sb > g.sa) B.w++; else if (g.sa > g.sb) B.l++;
      }
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
    session,
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

const plural = (n, w, sfx) => `${n} ${n === 1 ? w : (sfx || w + 's')}`;
const SMALL = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];
const spellOut = n => (n >= 0 && n < SMALL.length ? SMALL[n] : String(n));
const Spell = n => { const w = spellOut(n); return w.charAt(0).toUpperCase() + w.slice(1); };
const ordinal = n => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/** Deterministic choice so phrasing varies between nights but never re-rolls. */
function pickOne(seed, arr) {
  const str = String(seed);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return arr[(h >>> 0) % arr.length];
}

/**
 * The article's prose, templated from the computed stats.
 *
 * Order of business: work out what decided the night (a last-round tie, a lead
 * change, or a wire-to-wire win), lead with that, then the podium and its
 * tiebreaks, then the shape of the field, then the organizer's notes.
 */
export function buildNarrative(stats, { notes = '' } = {}) {
  const cn = stats.courtLabel;
  const rows = stats.rows;
  const seed = `${stats.event.id}|${stats.event.date}`;
  const unit = stats.fixedPartner ? 'pair' : 'player';
  const w = rows[0];
  const paragraphs = [];
  let headline = null;

  // House style: full names on first mention, first names after that.
  const seen = new Set();
  const shortOf = key => (stats.entities.get(key)?.names || []).map(firstName).join(' & ');
  const nm = key => {
    if (!key) return '';
    const full = stats.entities.get(key)?.name || '';
    if (seen.has(key)) return shortOf(key) || full;
    seen.add(key);
    return full;
  };

  const before = stats.beforeFinal;
  const bLead = before ? before[0] : null;
  const bSecond = before ? before[1] : null;
  const deadHeat = !!(bLead && bSecond && bLead.w === bSecond.w && bLead.diff === bSecond.diff);
  const leadChanged = !!(bLead && w && bLead.key !== w.key);

  // Did the two pairs who were level actually meet in the final round?
  const finalGames = stats.games.filter(g => g.round === stats.lastRound);
  const onSide = (g, side, key) => (g[side] || [g[side === 'sideA' ? 'entA' : 'entB']]).includes(key);
  const decider = (deadHeat && finalGames.find(g =>
    (onSide(g, 'sideA', bLead.key) && onSide(g, 'sideB', bSecond.key)) ||
    (onSide(g, 'sideA', bSecond.key) && onSide(g, 'sideB', bLead.key)))) || null;

  // ── the lead ──
  if (deadHeat && decider) {
    const leadOnA = onSide(decider, 'sideA', bLead.key);
    const leadWon = leadOnA ? decider.sa > decider.sb : decider.sb > decider.sa;
    const winnerKey = leadWon ? bLead.key : bSecond.key;
    const loserKey = leadWon ? bSecond.key : bLead.key;
    const wn = stats.entities.get(winnerKey)?.name;
    const ln = stats.entities.get(loserKey)?.name;
    const score = `${Math.max(decider.sa, decider.sb)}-${Math.min(decider.sa, decider.sb)}`;
    headline = `Dead Level Going Into the Last Round: ${(wn || '').split(' & ')[0]} Settles It on ${cn(decider.court).replace('Court ', '')}`;
    paragraphs.push(
      `Two ${unit}s walked onto ${cn(decider.court)} for the final round with nothing between them. ` +
      `${nm(winnerKey)} and ${nm(loserKey)} were both ${bLead.w}-${bLead.l}. Both were ${signed(bLead.diff)} on point differential. ` +
      `Not close, identical. ${Spell(stats.lastRound - 1)} rounds had failed to separate them, so the ${stats.session.noun} did the ` +
      `sensible thing and settled it head to head. ${nm(winnerKey)} won it ${score}.`
    );
  } else if (deadHeat) {
    headline = `${(w.name || '').split(' & ')[0]} Takes It on the Last Round`;
    paragraphs.push(
      `${nm(bLead.key)} and ${nm(bSecond.key)} went into the final round tied at ${bLead.w}-${bLead.l}, level on ` +
      `point differential at ${signed(bLead.diff)}, playing different opponents and watching each other's scoreboard. ` +
      `${nm(w.key)} came out of it on top at ${w.w}-${w.l}.`
    );
  } else if (leadChanged) {
    headline = `${(w.name || '').split(' & ')[0]} Steals It in the Final Round`;
    paragraphs.push(
      `${nm(bLead.key)} led going into the last round at ${bLead.w}-${bLead.l}. They did not lead coming out of it. ` +
      `${nm(w.key)} closed at ${w.w}-${w.l} with a ${signed(w.diff)} differential and took the ${stats.session.noun} off them ` +
      `in the time it takes to play one game.`
    );
  } else if (w) {
    headline = pickOne(seed, [
      `${(w.name || '').split(' & ')[0]} Runs the Ladder at the ${stats.event.name}`,
      `${w.w}-${w.l} and No Argument: ${(w.name || '').split(' & ')[0]} Takes the ${stats.session.cap}`,
    ]);
    paragraphs.push(
      `${nm(w.key)} won the ${stats.event.name} at ${w.w}-${w.l} with a ${signed(w.diff)} point differential, ` +
      `and led or shared the lead going into the final round. No late drama, no tiebreak, just the best ` +
      `${unit} on the courts finishing like it.`
    );
  }

  // ── the winner's session (morning/afternoon/night) in detail ──
  if (w) {
    const bits = [];
    if (w.climb > 0) {
      bits.push(`They opened on ${cn(w.start)} and finished on ${cn(w.end)}, ${
        w.start === 1 && w.end === stats.maxCourt
          ? `the full bottom-to-top climb and the only one of the ${stats.session.noun}`
          : `a climb of ${plural(w.climb, 'court')}`}`);
    } else if (w.kingRounds === w.games) {
      bits.push(`They never left ${cn(stats.maxCourt)}, all ${plural(w.games, 'round')} of it`);
    } else {
      bits.push(`They started and finished on ${cn(w.end)}`);
    }
    if (w.avgAgainst != null) bits.push(`and gave up ${w.avgAgainst} points a game, the stingiest defense in the field`);
    if (w.streak >= 3) bits.push(`with ${plural(w.streak, 'straight win')} in the middle of it`);
    paragraphs.push(`${bits.join(', ')}. ${stats.session.cap} DR of ${w.dr ?? '—'}.`);
  }

  // ── the podium, and any tiebreak that decided it ──
  const p2 = rows[1], p3 = rows[2], p4 = rows[3];
  if (p2 && p3) {
    const tied23 = p2.w === p3.w;
    const tied34 = p4 && p3.w === p4.w;
    if (tied34 && p3.diff - p4.diff <= 2) {
      paragraphs.push(
        `Third came down to arithmetic. ${nm(p3.key)} and ${nm(p4.key)} both finished ${p3.w}-${p3.l}, so it went to ` +
        `point differential: ${signed(p3.diff)} against ${signed(p4.diff)}. ` +
        `${p3.diff - p4.diff === 1 ? `One point, across a full ${stats.session.noun} of games, decided the last podium step.` :
          `${plural(p3.diff - p4.diff, 'point')} decided the last podium step.`}`
      );
    } else if (tied23) {
      paragraphs.push(
        `${nm(p2.key)} and ${nm(p3.key)} both finished ${p2.w}-${p2.l}, split by point differential at ` +
        `${signed(p2.diff)} and ${signed(p3.diff)}.`
      );
    } else {
      paragraphs.push(
        `${nm(p2.key)} took second at ${p2.w}-${p2.l} (${signed(p2.diff)}) and ${nm(p3.key)} third at ` +
        `${p3.w}-${p3.l} (${signed(p3.diff)}).`
      );
    }
  }

  // ── anyone who led and then fell off the podium ──
  if (before) {
    const topBefore = before.slice(0, 3).map(r => r.key);
    const topAfter = rows.slice(0, 3).map(r => r.key);
    const dropped = before.slice(0, 2).find(r => topBefore.includes(r.key) && !topAfter.includes(r.key));
    if (dropped) {
      const now = rows.find(r => r.key === dropped.key);
      if (now) paragraphs.push(
        `${nm(now.key)} will want the last round back. They were ${ordinal(dropped.rank)} going into it at ` +
        `${dropped.w}-${dropped.l} and finished ${ordinal(now.rank)}, off the podium entirely. ` +
        `${now.kingRounds >= Math.ceil(now.games / 2)
          ? `They had spent ${now.kingRounds} of ${plural(now.games, 'round')} on ${cn(stats.maxCourt)}, which makes it sting more.`
          : ''}`.trim()
      );
    }
  }

  // ── the shape of the field ──
  const field = [];
  const kings = [...rows].sort((a, b) => b.kingRounds - a.kingRounds)[0];
  if (kings && kings.kingRounds > 0 && kings.key !== w?.key) {
    const sharers = rows.filter(r => r.kingRounds === kings.kingRounds);
    field.push(sharers.length > 1
      ? `${sharers.map(r => nm(r.key)).join(' and ')} spent the most time on ${cn(stats.maxCourt)}, ${kings.kingRounds} rounds each`
      : `${nm(kings.key)} spent the most time on ${cn(stats.maxCourt)}, ${kings.kingRounds} of ${plural(kings.games, 'round')}`);
  }
  const slider = [...rows.filter(r => r.climb < 0)].sort((a, b) => (a.climb - b.climb) || (a.end - b.end))[0];
  if (slider) {
    field.push(`${nm(slider.key)} went the other way, from ${cn(slider.start)} down to ${cn(slider.end)}`);
  }
  const closest = [...stats.games].sort((a, b) => (a.margin - b.margin) || (a.round - b.round))[0];
  if (closest && closest.margin <= 2) {
    const sideNm = keys => (keys || []).map(nm).filter(Boolean).join(' & ');
    const cw = sideNm(closest.sa > closest.sb ? closest.sideA : closest.sideB);
    const cl = sideNm(closest.sa > closest.sb ? closest.sideB : closest.sideA);
    const only = stats.games.filter(g => g.margin === closest.margin).length === 1;
    field.push(
      `the tightest game of the ${stats.session.noun} was ${cw} over ${cl}, ` +
      `${Math.max(closest.sa, closest.sb)}-${Math.min(closest.sa, closest.sb)} in round ${closest.round}` +
      (only ? `, the only ${closest.margin}-point game out of ${stats.games.length}` : '')
    );
  }
  if (field.length) paragraphs.push(`Down the ladder: ${field.join('; ')}.`);

  // ── last place, with its dignity intact ──
  const last = rows[rows.length - 1];
  if (last && rows.length > 3 && last.key !== w?.key) {
    paragraphs.push(
      `${nm(last.key)} had the hardest ${stats.session.noun} of it at ${last.w}-${last.l} (${signed(last.diff)})` +
      (last.streak >= 2
        ? `, though they did win ${plural(last.streak, 'game')} back to back in there, which the differential does its best to hide.`
        : `, and answered the bell for all ${plural(last.games, 'round')} anyway.`)
    );
  }

  // ── the organizer's own notes, as their own beat ──
  for (const line of String(notes || '').split(/\n{2,}|\r\n\r\n/).map(t => t.trim()).filter(Boolean)) {
    paragraphs.push(line);
  }

  return {
    headline: headline || `${stats.event.name} Recap`,
    dek: `${plural(stats.kpis.players, 'player')} · ${plural(stats.kpis.rounds, 'round')} · ${plural(stats.kpis.courts, 'court')}`,
    paragraphs,
    engine: 'templated',
  };
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
  /* Shared bar-chart grid: name | track | value. Both charts use it so their
     tracks are exactly the same width on every screen. */
  .crow { display:grid; grid-template-columns:150px minmax(0,1fr) 52px; align-items:center; column-gap:12px; height:30px; margin-bottom:6px; }
  .cname { font-size:12.5px; color:var(--txt-muted); text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ctrack { position:relative; height:22px; min-width:0; }
  .ctrack.diff { background:var(--surf1); border-radius:4px; }
  .ctrack.wl { display:flex; gap:2px; }
  .cmid { position:absolute; left:50%; top:0; bottom:0; width:1px; background:var(--surf3); }
  .cbar { height:22px; border-radius:4px; }
  .ctrack.diff .cbar { position:absolute; top:0; }
  .ctrack.diff .cbar.pos { left:50%; background:#b8ff2c; border-radius:0 4px 4px 0; }
  .ctrack.diff .cbar.neg { right:50%; background:#ff5c47; border-radius:4px 0 0 4px; }
  .cbar.win { background:#b8ff2c; } .cbar.loss { background:#ff5c47; }
  .cval { font-size:12.5px; font-weight:700; color:var(--txt); font-variant-numeric:tabular-nums; white-space:nowrap; }
  .progress-wrap { border:1px solid var(--surf3); border-radius:10px; padding:16px; background:var(--surf2); }
  .pgSel { background:var(--surf3); color:var(--txt); border:1px solid var(--surf3); border-radius:8px; padding:8px 12px; font-size:13px; font-weight:600; margin-bottom:14px; max-width:100%; }
  #pgSvg { width:100%; height:auto; display:block; }
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
  tbody td { padding:10px; border-bottom:1px solid var(--surf1); font-variant-numeric:tabular-nums; white-space:nowrap; }
  tbody tr:hover { background:var(--surf1); }
  td.rank { color:var(--txt-faint); } td.pname { font-weight:600; }
  .rounds { display:grid; grid-template-columns:repeat(2,1fr); gap:14px; }
  .rnd { background:var(--surf1); border-radius:12px; padding:14px 16px; }
  .rnd h3 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--txt-faint); font-weight:800; margin:0 0 10px; }
  .gm { display:grid; grid-template-columns:34px minmax(0,1fr); column-gap:10px; align-items:center; padding:8px 0; border-bottom:1px solid var(--surf2); }
  .gm:last-child { border-bottom:0; padding-bottom:2px; }
  .gm .ct { color:var(--txt-faint); font-weight:800; font-size:11px; line-height:1.2; text-align:center; }
  .gm .ct .kt { display:block; color:var(--gold); font-size:8.5px; letter-spacing:.06em; text-transform:uppercase; margin-top:2px; }
  .gm.king .ct { color:var(--gold); }
  .gm .sides { display:flex; flex-direction:column; gap:3px; min-width:0; }
  .gm .side { display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:12.5px; color:var(--txt-muted); min-width:0; }
  .gm .side .tm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .gm .side .sc { font-variant-numeric:tabular-nums; font-weight:700; flex-shrink:0; width:22px; text-align:right; color:var(--txt-faint); }
  .gm .side.won { color:var(--txt); font-weight:700; }
  .gm .side.won .sc { color:var(--lime); }
  @media (max-width:900px) {
    .article-wrap { grid-template-columns:1fr; }
    .podium-aside { grid-column:1; order:-1; margin-bottom:8px; position:static; flex-direction:row; overflow-x:auto; }
    .article { order:1; } .podcard { flex:1 1 0; min-width:150px; }
  }
  @media (max-width:640px) {
    .kpirow,.awards,.rounds { grid-template-columns:1fr 1fr; }
    .crow { grid-template-columns:96px minmax(0,1fr) 44px; column-gap:8px; }
    .cname { font-size:11px; } .cval { font-size:11.5px; }
    .podium-aside { flex-direction:column; }
  }
  @media (max-width:520px) { .rounds { grid-template-columns:1fr; } .gm .side { font-size:13px; } }
`;

const SORT_SCRIPT = `
(function(){
  var tables=document.querySelectorAll('table.sortable-table');
  tables.forEach(function(table){
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
  });
})();
`;

// Player progress chart — cumulative point differential round by round for
// whichever player/pair is selected. Ladder-specific and single-night, unlike
// the season-wide DSR trend chart on the player profile page: 2026-09-26,
// Richard asked for "kind of like [the profile page] but ladder specific."
const PROGRESS_SCRIPT = `
(function(){
  var data = window.__DS_PROGRESS__ || [];
  var sel = document.getElementById('pgSel');
  var svg = document.getElementById('pgSvg');
  if (!sel || !svg || !data.length) return;
  var NS = 'http://www.w3.org/2000/svg';
  var W = 720, H = 260, padL = 34, padR = 16, padT = 16, padB = 26;
  function draw(idx){
    var series = data[idx]; if (!series) return;
    var pts = series.points || [];
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!pts.length) return;
    var maxAbs = 4;
    pts.forEach(function(p){ maxAbs = Math.max(maxAbs, Math.abs(p.diff)); });
    var n = pts.length;
    var xAt = function(i){ return padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR)); };
    var yAt = function(v){ return padT + (H - padT - padB) / 2 - (v / maxAbs) * ((H - padT - padB) / 2); };
    var zero = document.createElementNS(NS, 'line');
    zero.setAttribute('x1', padL); zero.setAttribute('x2', W - padR);
    zero.setAttribute('y1', yAt(0)); zero.setAttribute('y2', yAt(0));
    zero.setAttribute('stroke', 'rgba(255,255,255,.18)'); zero.setAttribute('stroke-dasharray', '3,3');
    svg.appendChild(zero);
    var d = pts.map(function(p, i){ return (i === 0 ? 'M' : 'L') + xAt(i).toFixed(1) + ',' + yAt(p.diff).toFixed(1); }).join(' ');
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', pts[pts.length - 1].diff >= 0 ? '#b8ff2c' : '#ff5c47');
    path.setAttribute('stroke-width', '2.5');
    svg.appendChild(path);
    pts.forEach(function(p, i){
      var c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', xAt(i)); c.setAttribute('cy', yAt(p.diff)); c.setAttribute('r', 4);
      c.setAttribute('fill', p.result === 'W' ? '#b8ff2c' : '#ff5c47');
      var title = document.createElementNS(NS, 'title');
      title.textContent = 'Round ' + p.round + ': ' + (p.result === 'W' ? 'Won' : 'Lost') +
        ', diff ' + (p.diff >= 0 ? '+' : '') + p.diff + ' (' + p.court + ')';
      c.appendChild(title);
      svg.appendChild(c);
      var lbl = document.createElementNS(NS, 'text');
      lbl.setAttribute('x', xAt(i)); lbl.setAttribute('y', H - 8);
      lbl.setAttribute('text-anchor', 'middle'); lbl.setAttribute('font-size', '9.5');
      lbl.setAttribute('fill', '#8a8f85');
      lbl.textContent = 'R' + p.round;
      svg.appendChild(lbl);
    });
  }
  sel.addEventListener('change', function(){ draw(+sel.value); });
  draw(0);
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
    `<strong>Fixed Partner format:</strong> teams were locked at signup and stayed together all ${stats.session.noun}, ` +
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
      A(`      <div class="who">${(a.entities && a.entities.length ? a.entities : [a.entity]).map(entLink).join(' &amp; ')}</div>`);
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
  A('    <table id="standingsheet" class="sortable-table">');
  A('      <thead><tr>');
  A(`        <th>#</th><th class="sortable" data-key="name">${stats.fixedPartner ? 'Pair' : 'Player'}</th><th class="num sortable" data-key="w">W-L</th><th class="num sortable" data-key="pf">PF-PA</th>`);
  A('        <th class="num sortable" data-key="diff">Diff</th><th class="num sortable" data-key="dr">DR</th><th class="num sortable" data-key="streak">Best streak</th><th class="num sortable" data-key="mvp">MVP</th><th class="num">Court (start&rarr;end)</th><th class="num sortable" data-key="climb">Climb</th><th class="num sortable" data-key="king">King Court rds</th>');
  A('      </tr></thead>');
  A('      <tbody>');
  for (const r of rows) {
    const dc = r.diff > 0 ? '#b8ff2c' : '#ff5c47';
    const climb = r.climb > 0
      ? `<span style="color:#b8ff2c;">+${r.climb}</span>`
      : r.climb < 0 ? `<span style="color:#ff5c47;">${r.climb}</span>` : '<span style="color:#9a9e97;">0</span>';
    A(`    <tr data-name="${esc(r.name)}" data-w="${r.w}" data-pf="${r.pf}" data-diff="${r.diff}" data-dr="${r.dr ?? 0}" data-streak="${r.streak}" data-mvp="${r.mvp}" data-climb="${r.climb}" data-king="${r.kingRounds}">`);
    A(`      <td class="rank">${r.rank}</td>`);
    A(`      <td class="pname">${entLink(r.key)}</td>`);
    A(`      <td class="num">${r.w}-${r.l}</td>`);
    A(`      <td class="num">${r.pf}-${r.pa}</td>`);
    A(`      <td class="num" style="color:${dc};font-weight:700;">${signed(r.diff)}</td>`);
    A(`      <td class="num">${r.dr ?? '&mdash;'}</td>`);
    A(`      <td class="num">${r.streak}</td>`);
    A(`      <td class="num">${r.mvp || '&mdash;'}</td>`);
    A(`      <td class="num">${esc(cn(r.start))} &rarr; ${esc(cn(r.end))}</td>`);
    A(`      <td class="num">${climb}</td>`);
    A(`      <td class="num">${r.kingRounds}/${r.games}</td>`);
    A('    </tr>');
  }
  A('      </tbody></table></div>');
  A('  </section>');

  // player progress — cumulative point differential, round by round, for
  // whichever player/pair is picked from the dropdown.
  A('  <section>');
  A(`    <h2>Player progress</h2>`);
  A(`    <p class="chart-sub">Cumulative point differential, round by round. Pick a ${unit} to trace their ${stats.session.noun}.</p>`);
  A('    <div class="progress-wrap">');
  A('      <select id="pgSel" class="pgSel">');
  rows.forEach((r, i) => A(`        <option value="${i}">${esc(r.name)}</option>`));
  A('      </select>');
  A('      <svg id="pgSvg" viewBox="0 0 720 260" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Point differential by round"></svg>');
  A('    </div>');
  A('  </section>');
  A(`<script>window.__DS_PROGRESS__ = ${JSON.stringify(rows.map(r => ({
    name: r.name,
    points: r.progress.map(p => ({ round: p.round, diff: p.diff, result: p.result, court: cn(p.court) })),
  })))};</script>`);

  // differential chart
  const mx = Math.max(1, ...rows.map(r => Math.abs(r.diff)));
  A('  <section>');
  A(`    <h2>Point differential by ${unit}</h2>`);
  A('    <div class="legend">');
  A('      <span><span class="swatch" style="background:#b8ff2c"></span>Net positive</span>');
  A('      <span><span class="swatch" style="background:#ff5c47"></span>Net negative</span>');
  A('    </div>');
  // Both charts share one grid (name | track | value) so their tracks are
  // exactly the same width — the old W/L chart used a fixed 200px bar that
  // looked like a thumbnail next to the full-width differential chart
  // (2026-10-05). Values sit in their own column, never over the bar.
  for (const r of rows) {
    const w = (Math.abs(r.diff) / mx * 50).toFixed(1);
    const pos = r.diff >= 0;
    A(`    <div class="crow" title="${esc(r.name)}: ${r.w}-${r.l}, point diff ${signed(r.diff)}">`);
    A(`      <div class="cname">${entShort(r.key)}</div>`);
    A('      <div class="ctrack diff"><div class="cmid"></div>');
    A(`        <div class="cbar ${pos ? 'pos' : 'neg'}" style="width:${w}%;"></div>`);
    A('      </div>');
    A(`      <div class="cval" style="color:${pos ? '#b8ff2c' : '#ff5c47'};">${signed(r.diff)}</div>`);
    A('    </div>');
  }
  A('  </section>');

  // W/L chart — each row's bar is scaled to the games played, so the busiest
  // row fills the track; wins and losses split it.
  const maxGames = Math.max(1, ...rows.map(r => r.games));
  A('  <section>');
  A(`    <h2>Win / loss record by ${unit}</h2>`);
  A('    <div class="legend">');
  A('      <span><span class="swatch" style="background:#b8ff2c"></span>Wins</span>');
  A('      <span><span class="swatch" style="background:#ff5c47"></span>Losses</span>');
  A('    </div>');
  for (const r of rows) {
    const wPct = (r.w / maxGames * 100).toFixed(1);
    const lPct = (r.l / maxGames * 100).toFixed(1);
    A(`    <div class="crow" title="${esc(r.name)}: ${r.w} wins, ${r.l} losses">`);
    A(`      <div class="cname">${entShort(r.key)}</div>`);
    A('      <div class="ctrack wl">');
    if (r.w) A(`        <div class="cbar win" style="width:${wPct}%;"></div>`);
    if (r.l) A(`        <div class="cbar loss" style="width:${lPct}%;"></div>`);
    A('      </div>');
    A(`      <div class="cval">${r.w}-${r.l}</div>`);
    A('    </div>');
  }
  A('  </section>');

  // round by round
  const byRound = {};
  for (const g of stats.games) (byRound[g.round] = byRound[g.round] || []).push(g);
  A('  <section>');
  A('    <h2>Round by round</h2>');
  A(`    <p class="chart-sub">Every game of the ${stats.session.noun}. Courts are listed top to bottom: <strong>${esc(cn(stats.maxCourt))} is King Court</strong>, ${esc(cn(1))} the bottom. Win and you move up a court for the next round, lose and you move down.</p>`);
  A('    <div class="rounds">');
  for (const rn of Object.keys(byRound).sort((a, b) => a - b)) {
    A('      <div class="rnd">');
    A(`        <h3>Round ${rn}</h3>`);
    // Top court first, so the board reads the way the ladder is stacked.
    // Each game is a stacked pair of team rows (names left, score right) so
    // a doubles side — two names — never has to share one line with the
    // other side's two names and the score. Winner is bold with a lime score.
    for (const g of byRound[rn].sort((x, y) => y.court - x.court)) {
      const sideA = g.sideA && g.sideA.length ? g.sideA : [g.entA];
      const sideB = g.sideB && g.sideB.length ? g.sideB : [g.entB];
      const aw = g.sa > g.sb, bw = g.sb > g.sa;
      const isKing = g.court === stats.maxCourt;
      const cname = cn(g.court).replace(/^Court /, '');
      A(`        <div class="gm${isKing ? ' king' : ''}">`);
      A(`          <div class="ct">${esc(cname)}${isKing ? '<span class="kt">King</span>' : ''}</div>`);
      A(`          <div class="sides">`);
      A(`            <div class="side${aw ? ' won' : ''}"><span class="tm">${sideA.map(entShort).join(' &amp; ')}</span><span class="sc">${g.sa}</span></div>`);
      A(`            <div class="side${bw ? ' won' : ''}"><span class="tm">${sideB.map(entShort).join(' &amp; ')}</span><span class="sc">${g.sb}</span></div>`);
      A(`          </div>`);
      A(`        </div>`);
    }
    A('      </div>');
  }
  A('    </div>');
  A('  </section>');

  // individual table (fixed-partner nights only — otherwise it duplicates standings)
  if (stats.fixedPartner) {
    A('  <section>');
    A('    <h2>Individual stats (sortable)</h2>');
    A(`    <p class="chart-sub">In Fixed Partner play a player&rsquo;s record, differential and court path are their pair&rsquo;s &mdash; partners share every game. <strong>Best streak</strong> is the longest run of consecutive wins. <strong>King Court rds</strong> counts rounds played on ${esc(cn(stats.maxCourt))}, the top court. Every game still counts toward their overall Dink Society profile.</p>`);
    A('    <div class="table-wrap">');
    A('    <table id="statsheet" class="sortable-table">');
    A('      <thead><tr>');
    A('        <th>#</th><th class="sortable" data-key="name">Player</th><th>Pair</th><th class="num">W-L</th>');
    A('        <th class="num sortable" data-key="diff">Diff</th><th class="num sortable" data-key="dr">DR</th>');
    A('        <th class="num sortable" data-key="streak">Best streak</th><th class="num sortable" data-key="king">King Court rds</th><th class="num">Court (start&rarr;end)</th>');
    A('      </tr></thead>');
    A('      <tbody>');
    let n = 0;
    for (const r of rows) {
      const dc = r.diff > 0 ? '#b8ff2c' : '#ff5c47';
      r.names.forEach((nm, j) => {
        n++;
        const other = firstName(r.names[1 - j] || '');
        A(`    <tr data-name="${esc(nm)}" data-diff="${r.diff}" data-dr="${r.dr ?? 0}" data-streak="${r.streak}" data-king="${r.kingRounds}">`);
        A(`      <td class="rank">${n}</td>`);
        A(`      <td class="pname">${nameLink(nm)}</td>`);
        A(`      <td>${other ? 'w/ ' + esc(other) : '&mdash;'}</td>`);
        A(`      <td class="num">${r.w}-${r.l}</td>`);
        A(`      <td class="num" style="color:${dc};font-weight:700;">${signed(r.diff)}</td>`);
        A(`      <td class="num">${r.dr ?? '&mdash;'}</td>`);
        A(`      <td class="num">${r.streak}</td>`);
        A(`      <td class="num">${r.kingRounds}/${r.games}</td>`);
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
  A(`<script>${PROGRESS_SCRIPT}</script>`);
  A('</body>');
  A('</html>');
  return L.join('\n') + '\n';
}

// ──────────────────────────── orchestrator ────────────────────────────

function slugify(s) {
  return String(s || 'ladder').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Bump this whenever the rendered HTML/CSS changes shape. Stored on every
 * article record; ladder-recap-page.js rebuilds an article whose stamp is
 * older on its next view, so already-published nights pick up template fixes
 * (doubles sides on the round board, the chart grid, …) without an admin
 * having to force-regenerate each one.
 *   2 — 2026-10-05: round-by-round shows both players per side; charts share a grid.
 */
export const TEMPLATE_VERSION = 2;

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
  const narrative = buildNarrative(stats, { notes: useNotes });
  const html = renderArticleHtml(stats, narrative);

  const record = await saveArticle(eventId, {
    date: stats.event.date,
    slug: `${stats.event.date}-${slugify(stats.event.name)}`,
    title: narrative.headline,
    dek: narrative.dek || '',
    html,
    notes: useNotes,
    generatedBy: narrative.engine,
    templateVersion: TEMPLATE_VERSION,
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
