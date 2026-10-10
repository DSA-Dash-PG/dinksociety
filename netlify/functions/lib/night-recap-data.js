// netlify/functions/lib/night-recap-data.js
//
// PURE math + copy for the league "morning-after" email (the Receipt): one
// personal model per player who played a game on a league night. No I/O and no
// dependencies beyond lib/tiebreak.js, so every number and every sentence here
// is unit-testable (tests/night-recap.test.js). lib/night-recap.js loads the
// blobs and feeds this; lib/night-recap-email.js renders what comes out.
//
// THIS EMAIL SENDS WITHOUT A HUMAN LOOK (Richard, 2026-10-09: with 100+ players
// an approve tap per email is not workable). So the copy rules are the same as
// lib/ladder-recap-basic.js: a sentence is only written when the numbers in
// hand support it, and anything that cannot be worked out is left out rather
// than guessed.

import { sortStandings } from './tiebreak.js';

// Slot type by slot key (matches lib/standings.js / captain-lineup.js).
export const SLOT_TYPE = {
  r1g1: 'womens', r1g2: 'mens', r1g3: 'mixed', r1g4: 'mixed', r1g5: 'mixed', r1g6: 'mixed',
  r2g1: 'womens', r2g2: 'mens', r2g3: 'mixed', r2g4: 'mixed', r2g5: 'mixed', r2g6: 'mixed',
};
export const SLOT_KEYS = Object.keys(SLOT_TYPE);
export const TYPE_LABEL = { womens: "Women's", mens: "Men's", mixed: 'Mixed' };

// A "close" game for the copy: decided by two points or fewer. (DSR's clutch
// component uses three; that number is only quoted where DSR itself is.)
const CLOSE = 2;

export const ord = (n) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
export const sign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';
export const normGender = (g) => {
  const s = String(g || '').trim().toLowerCase();
  return s[0] === 'f' ? 'F' : s[0] === 'm' ? 'M' : '';
};
const plural = (n, one, many) => (n === 1 ? one : (many || one + 's'));
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const word = (n) => (n >= 0 && n < WORDS.length ? WORDS[n] : String(n));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const isPost = (m) => m.phase === 'playoff' || m.phase === 'championship';

// ─────────────────────────────────────────────────────────────────────────
// Games
// ─────────────────────────────────────────────────────────────────────────

/**
 * Flatten one finalized match into completed game rows.
 * `score` must already be normalized (lib/score-helpers normalizeScore), so
 * score.games[slot] = { home, away }. teamA is always the home side.
 * A game only counts when both scores are in, there is a winner, and both
 * lineups name the pair — the same bar lib/standings.js uses.
 */
export function matchGames({ lineupA, lineupB, score, nameOf = () => null }) {
  const out = [];
  for (const slot of SLOT_KEYS) {
    const gs = score?.games?.[slot];
    const h = gs?.home, a = gs?.away;
    if (!Number.isInteger(h) || !Number.isInteger(a) || h === a) continue;
    const hp = lineupA?.games?.[slot], ap = lineupB?.games?.[slot];
    if (!hp || !ap) continue;
    const side = (pick) => {
      const ids = [pick.p1, pick.p2].filter(Boolean);
      const names = [[pick.p1, pick.p1Name], [pick.p2, pick.p2Name]]
        .filter(([id]) => id)
        .map(([id, fallback]) => nameOf(id) || fallback || 'Player');
      return { ids, names };
    };
    out.push({
      slot, round: slot.startsWith('r1') ? 1 : 2, type: SLOT_TYPE[slot],
      home: side(hp), away: side(ap), homeScore: h, awayScore: a,
    });
  }
  return out;
}

/**
 * Everyone's night, from the week's matches.
 * @param {Array<{match:object, games:Array}>} weekMatches
 * @returns {Map<string, object>} playerId → night record
 */
export function nightByPlayer(weekMatches) {
  const map = new Map();
  for (const { match, games } of weekMatches) {
    for (const g of games) {
      for (const [mine, theirs, myScore, oppScore, teamId, oppTeamId] of [
        [g.home, g.away, g.homeScore, g.awayScore, match.teamA?.id, match.teamB?.id],
        [g.away, g.home, g.awayScore, g.homeScore, match.teamB?.id, match.teamA?.id],
      ]) {
        mine.ids.forEach((pid, i) => {
          if (!map.has(pid)) {
            map.set(pid, {
              playerId: pid, name: mine.names[i], teamId, oppTeamId, matchId: match.id,
              games: [], w: 0, l: 0, ps: 0, pa: 0, diff: 0,
              byType: {},
            });
          }
          const n = map.get(pid);
          // A player who somehow suited up in two matches keeps the first as
          // "their" match; games from both still count toward the night.
          const won = myScore > oppScore;
          const partnerIdx = mine.ids.findIndex((x, j) => j !== i);
          n.games.push({
            matchId: match.id, slot: g.slot, round: g.round, type: g.type, typeLabel: TYPE_LABEL[g.type],
            partnerId: partnerIdx >= 0 ? mine.ids[partnerIdx] : null,
            partnerName: partnerIdx >= 0 ? mine.names[partnerIdx] : null,
            oppNames: theirs.names.slice(),
            my: myScore, opp: oppScore, won,
          });
          if (won) n.w++; else n.l++;
          n.ps += myScore; n.pa += oppScore; n.diff += myScore - oppScore;
          const bt = n.byType[g.type] || (n.byType[g.type] = { w: 0, l: 0, diff: 0 });
          if (won) bt.w++; else bt.l++;
          bt.diff += myScore - oppScore;
        });
      }
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────
// The table (regular season), at the end of any week
// ─────────────────────────────────────────────────────────────────────────

const TABLE_FIELDS = {
  pts: t => t.pts, gw: t => t.gw, diff: t => t.diff, ps: t => t.ps, name: t => t.teamName,
  h2h: (a, b) => a.h2h?.[b.teamId]?.for ?? null,
};

/**
 * Standings for one division from finalized regular-season matches up to and
 * including `week`, in the league's tiebreak order (lib/tiebreak.js).
 * @param {Array} matches finalized matches of ONE division, each with `week`
 * @param {number} week
 * @param {Array<{id,name}>} [seedTeams] teams to list even with no result yet
 */
export function tableThrough(matches, week, seedTeams = []) {
  const rows = new Map();
  const row = (t) => {
    if (!t?.id) return null;
    if (!rows.has(t.id)) {
      rows.set(t.id, { teamId: t.id, teamName: t.name || '', played: 0, pts: 0, ptsAgainst: 0, gw: 0, gl: 0, ps: 0, pa: 0, diff: 0, h2h: {} });
    }
    const r = rows.get(t.id);
    if (t.name) r.teamName = t.name;
    return r;
  };
  for (const t of seedTeams) row(t);
  for (const m of matches) {
    if (!m.finalizedAt || isPost(m) || !(m.week <= week)) continue;
    const a = row(m.teamA), b = row(m.teamB);
    if (!a || !b) continue;
    const mpA = m.scoreA ?? 0, mpB = m.scoreB ?? 0;
    const r1 = m.round1 || {}, r2 = m.round2 || {};
    const gA = (r1.homeGames || 0) + (r2.homeGames || 0), gB = (r1.awayGames || 0) + (r2.awayGames || 0);
    a.played++; b.played++;
    a.pts += mpA; a.ptsAgainst += mpB; b.pts += mpB; b.ptsAgainst += mpA;
    a.gw += gA; a.gl += gB; b.gw += gB; b.gl += gA;
    const pA = m.pointsA ?? 0, pB = m.pointsB ?? 0;
    a.ps += pA; a.pa += pB; b.ps += pB; b.pa += pA;
    (a.h2h[b.teamId] ||= { for: 0, against: 0, meetings: [] });
    (b.h2h[a.teamId] ||= { for: 0, against: 0, meetings: [] });
    a.h2h[b.teamId].for += mpA; a.h2h[b.teamId].against += mpB;
    b.h2h[a.teamId].for += mpB; b.h2h[a.teamId].against += mpA;
    a.h2h[b.teamId].meetings.push({ week: m.week, for: mpA, against: mpB });
    b.h2h[a.teamId].meetings.push({ week: m.week, for: mpB, against: mpA });
  }
  const list = [...rows.values()];
  for (const r of list) r.diff = r.ps - r.pa;
  const anyPlayed = list.some(r => r.played > 0);
  const sorted = anyPlayed
    ? sortStandings(list, TABLE_FIELDS)
    : list.sort((x, y) => String(x.teamName).localeCompare(String(y.teamName)));
  sorted.forEach((r, i) => { r.rank = i + 1; });
  return sorted;
}

/** The table after `week`, each row carrying its movement since the week before. */
export function tableWithMovement(matches, week, seedTeams = []) {
  const now = tableThrough(matches, week, seedTeams);
  const before = tableThrough(matches, week - 1, seedTeams);
  const hadTable = before.some(r => r.played > 0);
  const prevRank = new Map(before.map(r => [r.teamId, r.rank]));
  return now.map(r => ({
    ...r,
    prevRank: hadTable ? (prevRank.get(r.teamId) ?? null) : null,
    delta: hadTable && prevRank.has(r.teamId) ? prevRank.get(r.teamId) - r.rank : null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Player season + ranking, as of the end of a week
// ─────────────────────────────────────────────────────────────────────────

/** Games-needed-to-rank at a given count of played weeks (lib/standings.js). */
export const qualifyThreshold = (weeksPlayed) => Math.min(10, 2 * Math.max(0, weeksPlayed));

/**
 * @param {object} p        player-stats record
 * @param {number} week
 * @param {object} ctx      { rankedCount, weeksPlayed, isLatest }
 */
export function seasonAt(p, week, ctx) {
  const hist = Array.isArray(p?.dsrHistory) ? p.dsrHistory : [];
  const cur = hist.find(h => Number(h.week) === week) || null;
  const prev = hist.filter(h => Number(h.week) < week).sort((a, b) => b.week - a.week)[0] || null;

  let w = 0, l = 0, ps = 0, pa = 0, hasPoints = true;
  for (const r of (p?.weeklyGameRecords || [])) {
    if (!(Number(r.week) <= week)) continue;
    w += r.w || 0; l += r.l || 0;
    if (r.ps == null || r.pa == null) hasPoints = false;
    ps += r.ps || 0; pa += r.pa || 0;
  }
  // Older blobs carry no per-week rally points. On the latest week the season
  // totals on the record are the same thing, so use them.
  let diff = hasPoints && (w + l) > 0 ? ps - pa : null;
  if (ctx.isLatest && (p?.gamesWon || 0) + (p?.gamesLost || 0) > 0) {
    w = p.gamesWon || 0; l = p.gamesLost || 0;
    if (Number.isFinite(p.diff)) diff = p.diff;
  }
  const games = w + l;
  const need = qualifyThreshold(ctx.weeksPlayed);
  const rank = cur?.rank ?? null;
  const prevRank = prev?.rank ?? null;
  const gender = normGender(p?.gender);

  return {
    w, l, games, diff,
    winPct: games ? Math.round((w / games) * 100) : null,
    dsr: cur?.dsr ?? null, dsrPrev: prev?.dsr ?? null,
    rank, prevRank,
    delta: rank != null && prevRank != null ? prevRank - rank : null,
    newlyRanked: rank != null && prevRank == null && !!prev,
    rankedCount: ctx.rankedCount,
    needGames: need, gamesToRank: rank == null ? Math.max(0, need - games) : 0,
    mixedRank: cur?.xRank ?? null, mixedDsr: cur?.xDsr ?? null,
    genderRank: cur?.gRank ?? null, genderDsr: cur?.gDsr ?? null,
    genderLabel: gender === 'F' ? "Women's" : gender === 'M' ? "Men's" : null,
    // Season-to-date only fields — trustworthy on the latest week only.
    mixedRecord: ctx.isLatest && p?.byType?.mixed?.played
      ? { w: p.byType.mixed.won || 0, l: p.byType.mixed.played - (p.byType.mixed.won || 0) } : null,
  };
}

/** Best season partner: at least two games together, best win rate. */
export function bestPartner(p, nameOf) {
  let best = null;
  for (const [pid, rec] of Object.entries(p?.partners || {})) {
    if (!rec || (rec.played || 0) < 2) continue;
    const won = rec.won || 0, pct = won / rec.played;
    if (!best || pct > best.pct || (pct === best.pct && rec.played > best.played)) {
      best = { playerId: pid, played: rec.played, w: won, l: rec.played - won, pct };
    }
  }
  if (!best || best.w === 0) return null;
  const name = nameOf(best.playerId);
  return name ? { name, w: best.w, l: best.l } : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Weekly honors
// ─────────────────────────────────────────────────────────────────────────

/**
 * Best mixed night, one man and one woman: most (wins − losses) in mixed games,
 * then mixed point diff, then mixed wins. Needs two mixed games and a winning
 * mixed record to be in the conversation.
 */
export function bestMixed(night, genderOf) {
  const pick = (flag) => {
    const pool = [...night.values()]
      .filter(n => normGender(genderOf(n.playerId)) === flag)
      .map(n => ({ n, x: n.byType.mixed }))
      .filter(({ x }) => x && (x.w + x.l) >= 2 && x.w > x.l)
      .sort((a, b) => ((b.x.w - b.x.l) - (a.x.w - a.x.l)) || (b.x.diff - a.x.diff) || (b.x.w - a.x.w)
        || String(a.n.name).localeCompare(String(b.n.name)));
    const top = pool[0];
    return top ? { playerId: top.n.playerId, name: top.n.name, w: top.x.w, l: top.x.l, diff: top.x.diff } : null;
  };
  return { men: pick('M'), women: pick('F') };
}

/** What this player earned this week, from the site's own weekly leaders. */
export function honorsFor(pid, gender, performers, mixed) {
  const key = gender === 'F' ? 'women' : gender === 'M' ? 'men' : null;
  const out = { potw: false, weekRank: null, weekDsr: null, bestMixed: false, genderLabel: key === 'women' ? "Women's" : key === 'men' ? "Men's" : null };
  if (!key) return out;
  const top = performers?.[key] || [];
  if (top[0]?.playerId === pid) out.potw = true;
  const leaders = performers?.leaders?.[key]?.dsr || top;
  const idx = leaders.findIndex(e => e?.playerId === pid);
  if (idx >= 0 && idx < 5) { out.weekRank = idx + 1; out.weekDsr = leaders[idx].dsr ?? null; }
  if (mixed?.[key]?.playerId === pid) out.bestMixed = true;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Copy — every sentence is gated on the numbers that support it
// ─────────────────────────────────────────────────────────────────────────

const scoreList = (games) => games.map(g => `${g.my}–${g.opp}`);
const allSame = (arr) => arr.length > 0 && arr.every(x => x === arr[0]);

export function greeting(night, first) {
  const { w, l } = night;
  const closeLosses = night.games.filter(g => !g.won && g.opp - g.my <= CLOSE).length;
  if (l === 0 && w >= 2) return `Unbeaten night, ${first}.`;
  if (l === 0) return `Clean sheet, ${first}.`;
  if (w > l) return `Winning night, ${first}.`;
  if (w === l) return `Even night, ${first}.`;
  if (closeLosses >= 1 && closeLosses >= l - w) return `Closer than it reads, ${first}.`;
  if (w === 0) return `Tough one, ${first}.`;
  return `Not your night, ${first}.`;
}

/** The line beside the big record: where the player sits now. */
export function rankLine(s) {
  if (s.rank == null) {
    return s.gamesToRank > 0
      ? { text: `Not ranked yet · ${s.games} of ${s.needGames} games`, dir: 0, delta: null }
      : { text: 'Not ranked yet', dir: 0, delta: null };
  }
  const where = `${ord(s.rank)} of ${s.rankedCount}`;
  if (s.delta == null) return { text: s.newlyRanked ? `on the board · ${where}` : where, dir: 0, delta: null };
  if (s.delta > 0) return { text: `now ${where}`, dir: 1, delta: s.delta };
  if (s.delta < 0) return { text: `now ${where}`, dir: -1, delta: -s.delta };
  return { text: `held ${where}`, dir: 0, delta: 0 };
}

/** "The receipt says" — two or three plain sentences about the night. */
export function receiptRead(night, s) {
  const out = [];
  const { w, l, games } = night;
  const losses = games.filter(g => !g.won), wins = games.filter(g => g.won);
  const closeL = losses.filter(g => g.opp - g.my <= CLOSE);
  const closeW = wins.filter(g => g.my - g.opp <= CLOSE);

  // 1. The shape of the night.
  if (l === 0 && w >= 2) {
    const big = wins.slice().sort((a, b) => (b.my - b.opp) - (a.my - a.opp))[0];
    out.push(`Nobody took a game off you. The biggest was ${big.my}–${big.opp}${big.partnerName ? ` with ${firstName(big.partnerName)}` : ''}.`);
  } else if (closeL.length >= 1 && w < l) {
    const scores = scoreList(closeL);
    const lead = closeL.length === losses.length
      ? (losses.length === 1 ? `Your one loss finished ${scores[0]}.` : `${cap(word(closeL.length))} losses, ${closeL.length === 2 ? 'both' : 'all'} ${allSame(scores) ? scores[0] : 'by two points or fewer'}.`)
      : `${cap(word(closeL.length))} of your ${word(losses.length)} losses ${allSame(scores) ? `finished ${scores[0]}` : 'came by two points or fewer'}.`;
    const fw = w + closeL.length, fl = l - closeL.length;
    out.push(fw > fl
      ? `${lead} Flip ${closeL.length === 1 ? 'that one' : `those ${word(closeL.length)}`} and it's a ${fw}–${fl} night.`
      : lead);
  } else if (closeW.length >= 2 && w > l) {
    out.push(`${cap(word(closeW.length))} of your ${word(w)} wins came by two points or fewer. You closed.`);
  } else if (w > 0 && l > 0) {
    const big = wins.slice().sort((a, b) => (b.my - b.opp) - (a.my - a.opp))[0];
    out.push(`Best game of the night: ${big.my}–${big.opp}${big.partnerName ? ` with ${firstName(big.partnerName)}` : ''}.`);
  }

  // 2. Gender line vs mixed, when the two sides of the night differed.
  const gKey = night.byType.mens ? 'mens' : night.byType.womens ? 'womens' : null;
  const g = gKey ? night.byType[gKey] : null, x = night.byType.mixed || null;
  if (g && x) {
    const gl = `${TYPE_LABEL[gKey]} went ${g.w}–${g.l}`, xl = `mixed went ${x.w}–${x.l}`;
    const gPct = g.w / (g.w + g.l), xPct = x.w / (x.w + x.l);
    if (gPct !== xPct) out.push(gPct > xPct ? `${gl}; ${xl}.` : `${cap(xl)}; ${gl.charAt(0).toLowerCase() + gl.slice(1)}.`);
  }

  // 3. Where it leaves them.
  if (s.rank == null) {
    if (s.gamesToRank > 0) out.push(`${cap(word(s.gamesToRank))} more ${plural(s.gamesToRank, 'game')} puts you on the rankings.`);
  } else if (s.mixedRank != null && s.mixedRank <= 5 && s.mixedRecord) {
    out.push(`At ${s.mixedRecord.w}–${s.mixedRecord.l} in mixed this season you are #${s.mixedRank} on the Mixed board.`);
  } else if (s.genderRank != null && s.genderRank <= 5 && s.genderLabel) {
    out.push(`You are #${s.genderRank} on the ${s.genderLabel} board.`);
  } else if (s.delta != null && s.delta > 0) {
    out.push(`That moved you up ${s.delta} ${plural(s.delta, 'spot')} to ${ord(s.rank)}.`);
  }
  return out.join(' ');
}

/** One or two sentences on how the team's night went. */
export function teamRead(t) {
  const out = [];
  const you = t.name, opp = t.oppName;
  const rd = (n, r) => (r.for === r.against
    ? `Round ${n} was split ${r.for}–${r.against}`
    : r.for > r.against ? `${you} took Round ${n} ${r.for}–${r.against}` : `${opp} took Round ${n} ${r.against}–${r.for}`);
  if (t.mp === 4 && t.oppMp === 0) out.push(`${you} swept both rounds, ${t.gw}–${t.gl} in games.`);
  else if (t.oppMp === 4 && t.mp === 0) out.push(`${opp} took both rounds, ${t.gl}–${t.gw} in games.`);
  else if (t.r1 && t.r2 && (t.r1.for + t.r1.against) && (t.r2.for + t.r2.against)) out.push(`${rd(1, t.r1)}. ${rd(2, t.r2)}.`);
  if (t.closingRun >= 3 && t.gl > 0 && t.mp < 4) {
    out.push(`${you} won the last ${word(t.closingRun)} games on the card${t.closingScores?.length ? ` (${t.closingScores.join(', ')})` : ''}.`);
  } else if (t.closeLosses >= 2 && t.mp < t.oppMp) {
    out.push(`${cap(word(t.closeLosses))} of the ${word(t.gl)} losses were by two points or fewer.`);
  }
  return out.join(' ');
}

/** Where the team stands relative to the playoff line. */
export function tableRead(table, teamId, playoffSpots) {
  const me = table.find(r => r.teamId === teamId);
  if (!me || !table.some(r => r.played > 0)) return '';
  const at = (rank) => table.find(r => r.rank === rank);
  const pts = (n) => `${n} ${plural(n, 'point')}`;
  const cut = table.length > playoffSpots ? playoffSpots : null;
  if (me.rank === 1) {
    const second = at(2);
    if (!second) return '';
    const gap = me.pts - second.pts;
    return gap > 0 ? `${me.teamName}: top of the standings, ${pts(gap)} clear of ${second.teamName}.`
      : `${me.teamName}: top of the standings, level on points with ${second.teamName}.`;
  }
  if (cut && me.rank === cut) {
    const below = at(cut + 1);
    const gap = me.pts - below.pts;
    return gap > 0 ? `${me.teamName}: ${ord(me.rank)}, holding the last playoff spot by ${pts(gap)} over ${below.teamName}.`
      : `${me.teamName}: ${ord(me.rank)}, holding the last playoff spot on a tiebreak over ${below.teamName}.`;
  }
  if (cut && me.rank > cut) {
    const line = at(cut);
    const gap = line.pts - me.pts;
    return gap > 0 ? `${me.teamName}: ${ord(me.rank)}, ${pts(gap)} behind ${line.teamName} for the last playoff spot.`
      : `${me.teamName}: ${ord(me.rank)}, level on points with ${line.teamName} for the last playoff spot.`;
  }
  const above = at(me.rank - 1);
  const gap = above.pts - me.pts;
  return gap > 0 ? `${me.teamName}: ${ord(me.rank)}, ${pts(gap)} behind ${above.teamName}.`
    : `${me.teamName}: ${ord(me.rank)}, level on points with ${above.teamName}.`;
}

export function subjectFor(m) {
  const base = `${m.first}, your Week ${m.week} receipt: ${m.night.w}–${m.night.l}`;
  const s = m.season;
  if (s.delta != null && s.delta > 0) return `${base} and up ${s.delta} ${plural(s.delta, 'spot')}`;
  if (s.delta != null && s.delta < 0) return `${base}, now ${ord(s.rank)} overall`;
  if (s.rank != null && s.delta === 0) return `${base}, holding ${ord(s.rank)}`;
  return base;
}

export function preheaderFor(m) {
  const s = m.season, bits = [];
  if (s.rank == null) bits.push(s.gamesToRank > 0 ? `${cap(word(s.gamesToRank))} more ${plural(s.gamesToRank, 'game')} to join the rankings.` : 'Your night, game by game.');
  else if (s.delta > 0) bits.push(`Up ${s.delta} to ${ord(s.rank)} overall.`);
  else if (s.delta < 0) bits.push(`Down ${-s.delta} to ${ord(s.rank)} overall.`);
  else bits.push(`${ord(s.rank)} overall.`);
  if (m.team) bits.push(`${m.team.name} ${m.team.mp}, ${m.team.oppName} ${m.team.oppMp}.`);
  if (m.next?.oppName) bits.push(`Next: ${m.next.oppName}.`);
  return bits.join(' ');
}

// ─────────────────────────────────────────────────────────────────────────
// The model
// ─────────────────────────────────────────────────────────────────────────

function courtsLabel(m) {
  if (m?.court) return String(m.court);
  if (m?.courtA != null && m?.courtB != null) return `Courts ${m.courtA} & ${m.courtB}`;
  return null;
}

/**
 * Build one model per player who played in `week`.
 *
 * @param {object} o
 * @param {string} o.circuit
 * @param {number} o.week
 * @param {Array<{match:object, games:Array}>} o.weekMatches  finalized matches of the week (match has `division`, `week`)
 * @param {Array} o.seasonMatches   every match of the circuit, finalized or not (each with `division`, `week`)
 * @param {object} o.byesByWeek     { [week]: [teamId, …] }
 * @param {object} o.playerStats    the player-stats blob ({ players: { [id]: … } })
 * @param {object|null} o.performers  standings.weeklyTopPerformers entry for this week
 * @param {Map} o.teamsById         id → team record ({ id, name, roster })
 * @param {number} [o.playoffSpots=4]
 * @returns {{ week, date, models: object[] }}
 */
export function buildNightModels({ circuit, week, weekMatches, seasonMatches, byesByWeek = {}, playerStats, performers = null, teamsById, playoffSpots = 4 }) {
  const players = playerStats?.players || {};
  const nameOf = (id) => players[id]?.name || null;
  const genderOf = (id) => players[id]?.gender || null;
  const night = nightByPlayer(weekMatches);

  const finalized = seasonMatches.filter(m => m.finalizedAt);
  const regularWeeks = [...new Set(finalized.filter(m => !isPost(m)).map(m => m.week))].sort((a, b) => a - b);
  const latestWeek = finalized.reduce((mx, m) => Math.max(mx, m.week || 0), 0);
  const isLatest = week >= latestWeek;
  const weeksPlayed = regularWeeks.filter(w => w <= week).length;
  const rankedCount = Object.values(players)
    .filter(p => (p.dsrHistory || []).some(h => Number(h.week) === week && h.rank != null)).length;
  const ctx = { rankedCount, weeksPlayed, isLatest };

  // Tables per division, with movement.
  const tables = new Map();
  const tableFor = (division) => {
    if (!tables.has(division)) {
      const divMatches = seasonMatches.filter(m => m.division === division);
      const seed = [];
      for (const m of divMatches) for (const t of [m.teamA, m.teamB]) if (t?.id && !isPost(m)) seed.push(t);
      tables.set(division, tableWithMovement(divMatches, week, seed));
    }
    return tables.get(division);
  };

  const mixed = bestMixed(night, genderOf);
  const potw = {
    men: performers?.men?.[0] || null,
    women: performers?.women?.[0] || null,
  };

  let date = null;
  for (const { match } of weekMatches) {
    if (match.scheduledAt && (!date || new Date(match.scheduledAt) < new Date(date))) date = match.scheduledAt;
  }

  const models = [];
  for (const n of night.values()) {
    const p = players[n.playerId] || null;
    const wm = weekMatches.find(x => x.match.id === n.matchId);
    if (!wm) continue;
    const match = wm.match;
    const isHome = match.teamA?.id === n.teamId;
    const myTeam = isHome ? match.teamA : match.teamB;
    const oppTeam = isHome ? match.teamB : match.teamA;
    const teamName = teamsById.get(n.teamId)?.name || myTeam?.name || '';
    const oppName = teamsById.get(oppTeam?.id)?.name || oppTeam?.name || '';
    const first = firstName(n.name);
    const season = p ? seasonAt(p, week, ctx) : seasonAt({}, week, ctx);
    const gender = normGender(p?.gender);

    // ── Team night ──
    const r = (round) => {
      const x = match[round] || {};
      return { for: (isHome ? x.homeGames : x.awayGames) || 0, against: (isHome ? x.awayGames : x.homeGames) || 0 };
    };
    const teamGames = wm.games.map(g => {
      const my = isHome ? g.homeScore : g.awayScore, opp = isHome ? g.awayScore : g.homeScore;
      return { my, opp, won: my > opp };
    });
    let closingRun = 0;
    for (let i = teamGames.length - 1; i >= 0 && teamGames[i].won; i--) closingRun++;
    const gw = teamGames.filter(g => g.won).length, gl = teamGames.length - gw;
    const roster = [...night.values()]
      .filter(x => x.teamId === n.teamId && x.matchId === match.id)
      .map(x => ({ playerId: x.playerId, name: x.name, w: x.w, l: x.l, diff: x.diff, you: x.playerId === n.playerId }))
      .sort((a, b) => (b.w - a.w) || (b.diff - a.diff) || (a.l - b.l) || String(a.name).localeCompare(String(b.name)));
    const table = tableFor(match.division);
    const myRow = table.find(t => t.teamId === n.teamId) || null;
    const team = {
      id: n.teamId, name: teamName, oppId: oppTeam?.id || null, oppName,
      mp: (isHome ? match.scoreA : match.scoreB) ?? 0, oppMp: (isHome ? match.scoreB : match.scoreA) ?? 0,
      r1: r('round1'), r2: r('round2'),
      points: { for: teamGames.reduce((s, g) => s + g.my, 0), against: teamGames.reduce((s, g) => s + g.opp, 0) },
      gw, gl, closingRun,
      closingScores: closingRun >= 3 ? teamGames.slice(-closingRun).map(g => `${g.my}–${g.opp}`) : [],
      closeLosses: teamGames.filter(g => !g.won && g.opp - g.my <= CLOSE).length,
      roster,
      season: myRow ? { pts: myRow.pts, ptsAgainst: myRow.ptsAgainst, gw: myRow.gw, gl: myRow.gl, diff: myRow.diff } : null,
      rank: myRow?.rank ?? null, delta: myRow?.delta ?? null,
    };
    team.read = teamRead(team);

    // ── Next up ──
    const upcoming = seasonMatches
      .filter(m => !m.finalizedAt && m.week > week && m.teamA?.id && m.teamB?.id
        && (m.teamA.id === n.teamId || m.teamB.id === n.teamId))
      .sort((a, b) => (a.week - b.week) || (new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0)));
    const nm = upcoming[0] || null;
    let next = null;
    if (nm) {
      const opp = nm.teamA.id === n.teamId ? nm.teamB : nm.teamA;
      const oppRow = table.find(t => t.teamId === opp.id) || null;
      const meetings = (myRow?.h2h?.[opp.id]?.meetings || []).slice().sort((a, b) => a.week - b.week);
      next = {
        matchId: nm.id, week: nm.week, scheduledAt: nm.scheduledAt || null,
        phase: nm.phase || null,
        oppId: opp.id, oppName: teamsById.get(opp.id)?.name || opp.name || '',
        oppRank: oppRow?.rank ?? null, oppPts: oppRow?.pts ?? null, oppPtsAgainst: oppRow?.ptsAgainst ?? null,
        oppGw: oppRow?.gw ?? null, oppGl: oppRow?.gl ?? null,
        courts: courtsLabel(nm), venue: nm.venue || null,
        meetings,
      };
    } else {
      const nextWeek = Object.keys(byesByWeek).map(Number).filter(w => w > week).sort((a, b) => a - b)
        .find(w => (byesByWeek[w] || []).includes(n.teamId));
      if (nextWeek != null) next = { bye: true, week: nextWeek };
    }

    const model = {
      circuit, week, date,
      playerId: n.playerId, name: n.name, first, gender,
      teamId: n.teamId, teamName,
      night: {
        w: n.w, l: n.l, ps: n.ps, pa: n.pa, diff: n.diff, byType: n.byType,
        games: n.games.filter(g => g.matchId === match.id).concat(n.games.filter(g => g.matchId !== match.id)),
        oppName, courts: courtsLabel(match), venue: match.venue || null,
      },
      season,
      partner: p && isLatest ? bestPartner(p, nameOf) : null,
      clutch: p && isLatest && p.clutchG > 0 ? { w: p.clutchW || 0, l: p.clutchG - (p.clutchW || 0) } : null,
      honors: honorsFor(n.playerId, gender, performers, mixed),
      team,
      table: table.map(t => ({ teamId: t.teamId, teamName: t.teamName, rank: t.rank, delta: t.delta, pts: t.pts, gw: t.gw, gl: t.gl, diff: t.diff, you: t.teamId === n.teamId })),
      playoffSpots: table.length > playoffSpots ? playoffSpots : null,
      potw, mixed,
      next,
    };
    model.hi = greeting(model.night, first);
    model.rankLine = rankLine(season);
    model.read = receiptRead(model.night, season);
    model.tableRead = tableRead(table, n.teamId, playoffSpots);
    model.subject = subjectFor(model);
    model.preheader = preheaderFor(model);
    models.push(model);
  }
  models.sort((a, b) => String(a.teamName).localeCompare(String(b.teamName)) || String(a.name).localeCompare(String(b.name)));
  return { week, date, models };
}

// ─────────────────────────────────────────────────────────────────────────
// When is a week due?
// ─────────────────────────────────────────────────────────────────────────

const TZ = 'America/Los_Angeles';
const laDateKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const laMinutes = (d) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(d);
  const h = Number(parts.find(x => x.type === 'hour').value) % 24, m = Number(parts.find(x => x.type === 'minute').value);
  return h * 60 + m;
};

export const SEND_AFTER_MIN = 7 * 60 + 30;   // 7:30 AM Pacific
export const SEND_BEFORE_MIN = 20 * 60;      // never after 8 PM
export const SETTLE_MS = 30 * 60 * 1000;     // 30 minutes after the last finalize
export const STALE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Which week (if any) should be mailed right now?
 *
 * The rule, in the league's words: "the following morning when games are
 * finalized." Not a named weekday — league night moves from season to season.
 *   • the latest week with a finalized match, and
 *   • every match of that week whose start time has passed is finalized, and
 *   • it is the morning AFTER the night (Pacific), 7:30 AM – 8 PM, and
 *   • the last finalize was at least 30 minutes ago (a re-opened score settles), and
 *   • the night is no more than three days old.
 *
 * @param {Array} matches every match of the circuit (each with `week`)
 * @param {Date} now
 * @returns {{ week:number|null, due:boolean, reason:string, nightAt?:string }}
 */
export function dueWeek(matches, now = new Date()) {
  const finalized = matches.filter(m => m.finalizedAt);
  if (!finalized.length) return { week: null, due: false, reason: 'no finalized matches' };
  const week = finalized.reduce((mx, m) => Math.max(mx, m.week || 0), 0);
  const ofWeek = matches.filter(m => m.week === week && m.teamA?.id && m.teamB?.id);
  const started = (m) => m.scheduledAt && new Date(m.scheduledAt).getTime() <= now.getTime();
  const open = ofWeek.filter(m => !m.finalizedAt && started(m));
  if (open.length) return { week, due: false, reason: `${open.length} match${open.length === 1 ? '' : 'es'} not finalized yet` };

  const done = ofWeek.filter(m => m.finalizedAt);
  if (!done.length) return { week, due: false, reason: 'no finalized matches with both teams set' };
  const nightMs = Math.max(...done.map(m => new Date(m.scheduledAt || m.finalizedAt).getTime()));
  const lastFinal = Math.max(...done.map(m => new Date(m.finalizedAt).getTime()));
  const nightAt = new Date(nightMs).toISOString();
  if (now.getTime() - nightMs > STALE_MS) return { week, due: false, reason: 'night is more than three days old', nightAt };
  if (laDateKey(now) <= laDateKey(new Date(nightMs))) return { week, due: false, reason: 'waiting for the morning after', nightAt };
  const mins = laMinutes(now);
  if (mins < SEND_AFTER_MIN) return { week, due: false, reason: 'before 7:30 AM Pacific', nightAt };
  if (mins >= SEND_BEFORE_MIN) return { week, due: false, reason: 'after 8 PM Pacific, holding until morning', nightAt };
  if (now.getTime() - lastFinal < SETTLE_MS) return { week, due: false, reason: 'scores finalized in the last 30 minutes', nightAt };
  return { week, due: true, reason: 'due', nightAt };
}
