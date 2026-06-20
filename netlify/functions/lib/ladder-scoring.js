// netlify/functions/lib/ladder-scoring.js
//
// The run-night engine for Ladders — PORTED VERBATIM from the Pickleladder app
// (js/app.js) so behavior is identical: same round generation, same movement,
// same stats, same Dink Rating (DR) formula. Pure functions only (no I/O, no
// DOM), so they're reusable on the server and unit-testable.
//
// Data shapes (unchanged from Pickleladder):
//   player  : { id, name, gender:'M'|'F' }
//   court   : { court, team1:[player|null,player|null], team2:[...],
//               score: { t1, t2, winner:'A'|'B'|'T' } | null }
//   round   : { courts:[court], completed?, totalCourts?, wave2started? }
//   session : { id, date, rounds:[round] }
//
// Source parity: lines mirror Pickleladder js/app.js (makeCoed, genR1, genNR,
// calcStats, calcBonusPts, calcPartners, getRoundMVPs, calcMvpCount,
// calcDinkRating, _buildStrengthFn). Keep changes to imports/exports only.

export const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

export function crownStr(wins) {
  if (!wins || wins < 1) return '';
  if (wins === 1) return '👑';
  return '👑×' + wins;
}

// Coed pairing: gender balance > no-repeat-partner > snake-draft for strength.
// `strength` is (playerId)=>number; falsy/missing → 0.
export function makeCoed(group, pp, strength) {
  const str = typeof strength === 'function' ? strength : (() => 0);
  const g = group.filter(Boolean);
  if (g.length < 2) return { t1: [g[0] || null, null], t2: [null, null] };
  const males = g.filter(p => p.gender === 'M').slice().sort((a, b) => str(b.id) - str(a.id));
  const females = g.filter(p => p.gender === 'F').slice().sort((a, b) => str(b.id) - str(a.id));
  const noRepeat = (a, b, c, d) => { if (!pp) return true; return pp[a?.id] !== b?.id && pp[b?.id] !== a?.id && pp[c?.id] !== d?.id && pp[d?.id] !== c?.id; };
  const teamStr = (a, b) => str(a?.id) + str(b?.id);
  const balanceScore = ([a, b]) => Math.abs(teamStr(a[0], a[1]) - teamStr(b[0], b[1]));

  const pairings = [];
  if (males.length === 2 && females.length === 2) {
    pairings.push([[males[0], females[1]], [males[1], females[0]]]);
    pairings.push([[males[0], females[0]], [males[1], females[1]]]);
  } else if (males.length === 3 && females.length === 1) {
    pairings.push([[males[0], females[0]], [males[1], males[2]]]);
    pairings.push([[males[1], females[0]], [males[0], males[2]]]);
    pairings.push([[males[2], females[0]], [males[0], males[1]]]);
  } else if (males.length === 1 && females.length === 3) {
    pairings.push([[females[0], males[0]], [females[1], females[2]]]);
    pairings.push([[females[1], males[0]], [females[0], females[2]]]);
    pairings.push([[females[2], males[0]], [females[0], females[1]]]);
  } else if (males.length === 4 || females.length === 4) {
    const arr = males.length === 4 ? males : females;
    pairings.push([[arr[0], arr[3]], [arr[1], arr[2]]]);
    pairings.push([[arr[0], arr[2]], [arr[1], arr[3]]]);
    pairings.push([[arr[0], arr[1]], [arr[2], arr[3]]]);
  } else {
    if (g[0] && g[1] && g[2] && g[3]) {
      pairings.push([[g[0], g[1]], [g[2], g[3]]]);
      pairings.push([[g[0], g[2]], [g[1], g[3]]]);
      pairings.push([[g[0], g[3]], [g[1], g[2]]]);
    } else if (males.length >= 1 && females.length >= 1) {
      const others = g.filter(p => p !== males[0] && p !== females[0]);
      pairings.push([[males[0], females[0]], [others[0] || null, others[1] || null]]);
    }
  }

  const noRepeatOpts = pairings.filter(([a, b]) => noRepeat(a[0], a[1], b[0], b[1]));
  let chosen;
  if (noRepeatOpts.length) {
    chosen = noRepeatOpts.slice().sort((x, y) => balanceScore(x) - balanceScore(y))[0];
  } else if (pairings.length) {
    chosen = pairings.slice().sort((x, y) => balanceScore(x) - balanceScore(y))[0];
  }
  if (!chosen) return { t1: [g[0] || null, g[1] || null], t2: [g[2] || null, g[3] || null] };
  return { t1: [chosen[0][0] || null, chosen[0][1] || null], t2: [chosen[1][0] || null, chosen[1][1] || null] };
}

// Round 1: snake by gender, then makeCoed each court.
export function genR1(players, nC, strength) {
  const tC = Math.min(Math.floor(players.length / 4), 2 * nC);
  const males = shuffle(players.filter(p => p.gender === 'M')), females = shuffle(players.filter(p => p.gender === 'F'));
  const courts = []; let mi = 0, fi = 0;
  for (let c = 0; c < tC; c++) {
    const g = [];
    for (let x = 0; x < 2; x++) { if (mi < males.length) g.push(males[mi++]); }
    for (let x = 0; x < 2; x++) { if (fi < females.length) g.push(females[fi++]); }
    while (g.length < 4 && mi < males.length) g.push(males[mi++]);
    while (g.length < 4 && fi < females.length) g.push(females[fi++]);
    const { t1, t2 } = makeCoed(g, null, strength);
    courts.push({ court: c + 1, team1: [t1[0] || null, t1[1] || null], team2: [t2[0] || null, t2[1] || null], score: null });
  }
  const res = { courts, completed: false, totalCourts: tC };
  if (tC > nC) res.wave2started = false;
  return res;
}

// Next round: winners rise, losers drop (king/bottom court rules), everyone splits.
export function genNR(prev, nC, strength) {
  const tC = prev.courts.length;
  const pp = {};
  prev.courts.forEach(c => { [c.team1, c.team2].forEach(t => { if (t[0] && t[1]) { pp[t[0].id] = t[1].id; pp[t[1].id] = t[0].id; } }); });

  const mvs = [];
  prev.courts.forEach(c => {
    const all = [...(c.team1 || []), ...(c.team2 || [])].filter(Boolean);
    if (!c.score || !c.score.winner) { all.forEach(p => mvs.push({ p, to: c.court })); return; }
    const w = c.score.winner === 'A' ? c.team1 : c.team2;
    const lo = c.score.winner === 'A' ? c.team2 : c.team1;
    w.filter(Boolean).forEach(p => mvs.push({ p, to: Math.min(tC, c.court + 1) }));
    lo.filter(Boolean).forEach(p => mvs.push({ p, to: Math.max(1, c.court - 1) }));
  });

  const bk = {}; for (let i = 1; i <= tC; i++) bk[i] = [];
  mvs.forEach(m => { if (bk[m.to]) bk[m.to].push(m.p); });
  for (let i = 1; i <= tC; i++) bk[i] = shuffle(bk[i]);

  const courts = [];
  for (let c = 0; c < tC; c++) {
    const g = bk[c + 1] || [];
    const { t1, t2 } = makeCoed(g.slice(0, 4), pp, strength);
    courts.push({ court: c + 1, team1: [t1[0] || null, t1[1] || null], team2: [t2[0] || null, t2[1] || null], score: null });
  }
  const res = { courts, completed: false, totalCourts: tC };
  if (tC > nC) res.wave2started = false;
  return res;
}

// Per-night bonus points for podium finishes (15/10/5), tie-broken by diff.
export function calcBonusPts(sessions, players) {
  const bonus = {};
  players.forEach(p => bonus[p.id] = { bonus: 0, wins: 0, ladderResults: [] });
  sessions.forEach(sess => {
    if (!sess || !Array.isArray(sess.rounds) || !sess.rounds.length) return;
    const pts = {}, pa = {}; players.forEach(p => { pts[p.id] = 0; pa[p.id] = 0; });
    sess.rounds.forEach(round => {
      round.courts.forEach(c => {
        if (!c.score || c.score.t1 === null || c.score.t2 === null || !c.score.winner) return;
        const { t1, t2 } = c.score;
        [[c.team1, t1, t2], [c.team2, t2, t1]].forEach(([team, sc, al]) => { team.filter(Boolean).forEach(p => { if (pts[p.id] !== undefined) { pts[p.id] += sc; pa[p.id] += al; } }); });
      });
    });
    const ranked = Object.entries(pts).filter(([id, p]) => p > 0).sort((a, b) => b[1] - a[1] || ((b[1] - pa[b[0]]) - (a[1] - pa[a[0]])));
    if (!ranked.length) return;
    const bonusMap = { 0: 15, 1: 10, 2: 5 };
    ranked.forEach(([id], i) => {
      if (!bonus[id]) return;
      const b = bonusMap[i] || 0;
      bonus[id].bonus += b;
      if (i === 0) bonus[id].wins++;
      bonus[id].ladderResults.push({ date: sess.date, pts: pts[id], rank: i + 1, bonus: b, sessId: sess.id });
    });
  });
  return bonus;
}

// Season stats: W/L, points for/against, best court, streaks, per-round detail.
export function calcStats(sessions, players) {
  const s = {}; players.forEach(p => { s[p.id] = { id: p.id, name: p.name, gender: p.gender, w: 0, l: 0, t: 0, pf: 0, pa: 0, best: 0, attended: 0, courtHist: [], roundRes: [], streak: 0, maxStreak: 0, roundPts: [] }; });
  sessions.forEach(sess => {
    const played = new Set();
    sess.rounds.forEach((round, ri) => {
      round.courts.forEach(c => {
        if (!c.score || c.score.t1 === null || c.score.t1 === undefined || c.score.t2 === null || c.score.t2 === undefined || !c.score.winner) return;
        const { t1, t2, winner } = c.score;
        [[c.team1, t1, t2, winner === 'A'], [c.team2, t2, t1, winner === 'B']].forEach(([team, sc, al, won]) => {
          team.filter(Boolean).forEach(p => {
            if (!s[p.id]) return;
            played.add(p.id); s[p.id].pf += sc; s[p.id].pa += al;
            if (won) { s[p.id].w++; s[p.id].streak = s[p.id].streak > 0 ? s[p.id].streak + 1 : 1; s[p.id].maxStreak = Math.max(s[p.id].maxStreak, s[p.id].streak); }
            else { s[p.id].l++; s[p.id].streak = s[p.id].streak < 0 ? s[p.id].streak - 1 : -1; }
            s[p.id].best = Math.max(s[p.id].best, c.court); s[p.id].courtHist.push({ round: ri + 1, court: c.court }); s[p.id].roundRes.push({ round: ri + 1, court: c.court, won, pf: sc, pa: al, diff: sc - al }); s[p.id].roundPts.push(sc);
          });
        });
      });
      played.forEach(id => { if (s[id]) s[id].attended++; });
    });
  });
  return Object.values(s).sort((a, b) => b.pf !== a.pf ? b.pf - a.pf : (b.pf - b.pa) - (a.pf - a.pa));
}

export function getRoundMVPs(round, players) {
  if (!round || !players) return { male: [], female: [] };
  const perfs = [];
  round.courts.forEach(c => {
    if (!c.score || !c.score.winner) return; const { t1, t2 } = c.score;
    [[c.team1, t1 - t2], [c.team2, t2 - t1]].forEach(([team, diff]) => { team.filter(Boolean).forEach(p => { const rosterP = players.find(x => x.id === p.id); const gender = rosterP?.gender || p.gender || 'M'; perfs.push({ p: { ...p, gender }, diff, court: c.court }); }); });
  });
  const sorted = perfs.sort((a, b) => b.diff - a.diff);
  const seen = new Set();
  const top = (gender) => sorted.filter(x => x.p.gender === gender && !seen.has(x.p.id) && seen.add(x.p.id)).slice(0, 2);
  return { male: top('M'), female: top('F') };
}

export function calcMvpCount(sessions, players) {
  const cnt = {};
  if (!sessions || !players) return cnt;
  sessions.forEach(sess => {
    if (!sess || !Array.isArray(sess.rounds)) return;
    sess.rounds.forEach(round => {
      const { male, female } = getRoundMVPs(round, players);
      [...male, ...female].forEach(x => { const id = x.p?.id; if (id) cnt[id] = (cnt[id] || 0) + 1; });
    });
  });
  return cnt;
}

export function calcPartners(sessions, players) {
  const pairs = {};
  sessions.forEach(sess => {
    sess.rounds.forEach(round => {
      round.courts.forEach(c => {
        if (!c.score || c.score.t1 === null || c.score.t2 === null) return; const won = c.score.winner;
        [c.team1, c.team2].forEach((team, ti) => {
          if (team[0] && team[1]) {
            const key = [team[0].id, team[1].id].sort().join('-');
            if (!pairs[key]) pairs[key] = { p1: team[0], p2: team[1], w: 0, l: 0 };
            const teamWon = (ti === 0 && won === 'A') || (ti === 1 && won === 'B');
            if (teamWon) pairs[key].w++; else if (won !== 'T') pairs[key].l++;
          }
        });
      });
    });
  });
  return Object.values(pairs).sort((a, b) => (b.w / (b.w + b.l || 1)) - (a.w / (a.w + a.l || 1)));
}

// ── Dink Rating (DR) — composite 0–100 across 8 weighted components ──
// CourtPerf(25) OppoQuality(20) PartnerIndep(15) PointDiff(10) Consistency(10)
// CourtHold(10) Recovery(5) PartnerDiversity(5). Returns { playerId: number|null }.
export function calcDinkRating(statsArr, sessions, players) {
  if (!statsArr || !statsArr.length) return {};
  const pprMap = {};
  statsArr.forEach(s => { pprMap[s.id] = s.roundPts && s.roundPts.length ? s.pf / s.roundPts.length : 0; });
  const allPpr = Object.values(pprMap);
  const avgPpr = allPpr.length ? allPpr.reduce((a, b) => a + b, 0) / allPpr.length : 8;
  const roundDetail = {};
  if (sessions) {
    sessions.forEach(sess => {
      sess.rounds.forEach(round => {
        round.courts.forEach(c => {
          if (!c.score || c.score.t1 === null || c.score.t2 === null) return;
          [[c.team1, c.score.t1, c.score.t2], [c.team2, c.score.t2, c.score.t1]].forEach(([team, pf, pa]) => {
            const valid = team.filter(Boolean);
            if (valid.length < 2) return;
            const [p1, p2] = valid;
            const opp = team === c.team1 ? c.team2 : c.team1;
            const oppPpr = opp.filter(Boolean).reduce((a, p) => a + (pprMap[p.id] ?? avgPpr), 0) / Math.max(1, opp.filter(Boolean).length);
            [p1, p2].forEach((p, i) => {
              if (!roundDetail[p.id]) roundDetail[p.id] = [];
              roundDetail[p.id].push({ court: c.court || 1, pf, pa, partnerPpr: i === 0 ? (pprMap[p2.id] ?? avgPpr) : (pprMap[p1.id] ?? avgPpr), oppoPpr: oppPpr, partnerId: i === 0 ? p2.id : p1.id });
            });
          });
        });
      });
    });
  }
  const maxCourt = Math.max(...statsArr.flatMap(s => s.courtHist.map(x => x.court)), 1);
  const ratings = {};
  calcDinkRating._breakdown = {};
  statsArr.forEach(s => {
    if (s.w + s.l === 0) { ratings[s.id] = null; return; }
    const rd = roundDetail[s.id] || [];
    const nR = rd.length || 1;
    const courtWts = rd.map(r => r.court / maxCourt);
    const wWins = rd.reduce((a, r, i) => a + (r.pf > r.pa ? courtWts[i] : 0), 0);
    const wTotal = courtWts.reduce((a, w) => a + w, 0) || 1;
    const c1 = wWins / wTotal;
    const avgOppo = rd.length ? rd.reduce((a, r) => a + r.oppoPpr, 0) / rd.length : avgPpr;
    const c2 = Math.min(1, avgOppo / (avgPpr * 1.5 || 1));
    const weakRounds = rd.filter(r => r.partnerPpr < avgPpr);
    const c3 = weakRounds.length ? weakRounds.filter(r => r.pf > r.pa).length / weakRounds.length : (s.w / (s.w + s.l));
    const maxPts = Math.max(...statsArr.map(x => x.pf), 1);
    const c4 = Math.max(0, Math.min(1, ((s.pf - s.pa) + maxPts * 0.4) / (maxPts * 0.8)));
    const pts = rd.map(r => r.pf);
    const mean = pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : 0;
    const variance = pts.length ? pts.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / pts.length : 0;
    const c5 = Math.max(0, 1 - Math.sqrt(variance) / (mean || 1));
    const c6 = rd.length ? rd.filter(r => r.court > maxCourt / 2).length / rd.length : 0;
    let recoveries = 0, recOpps = 0;
    for (let i = 1; i < rd.length; i++) { if (rd[i - 1].pf < rd[i - 1].pa) { recOpps++; if (rd[i].pf > rd[i].pa) recoveries++; } }
    const c7 = recOpps > 0 ? recoveries / recOpps : 0.5;
    const c8 = Math.min(1, new Set(rd.map(r => r.partnerId)).size / Math.max(nR * 0.5, 1));
    ratings[s.id] = Math.round((c1 * 0.25 + c2 * 0.20 + c3 * 0.15 + c4 * 0.10 + c5 * 0.10 + c6 * 0.10 + c7 * 0.05 + c8 * 0.05) * 1000) / 10;
    calcDinkRating._breakdown[s.id] = { c1, c2, c3, c4, c5, c6, c7, c8 };
  });
  return ratings;
}

// Strength fn for pairing balance = a player's avg points/round from prior stats.
// Pure version of Pickleladder's _buildStrengthFn (takes sessions+players).
export function buildStrengthFn(sessions, players) {
  if (!sessions || !players) return () => 0;
  const stats = calcStats(sessions, players);
  const m = {};
  stats.forEach(x => { m[x.id] = x.roundPts.length ? x.pf / x.roundPts.length : 0; });
  return (id) => m[id] || 0;
}
