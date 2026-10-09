// netlify/functions/admin-extend-season.js
//
// Admin-only. Converts a LIVE season from the original format
//   Wk 1–5 round-robin · Wk 6 Rivalry · Wk 7 Semis · Wk 8 Gold/Bronze
// to the DOUBLE format (lib/bracket.js FORMAT.DOUBLE):
//   Wk 1–5 round-robin · Wk 6–10 a second round-robin · Wk 11 Championship Night
//
// The second round-robin is a RANDOM DRAW by default (every team plays every
// other team once more, home/away flipped from the first meeting, last week's
// matchups kept out of the first new week).
//
// A team can LEAVE after the first round-robin (`withdrawn`). The rest then play
// with an odd count: one team has a BYE each week (every team gets exactly one),
// and Championship Night is #1 v #2 (title) and #3 v #4 — the last seed has no
// match. The team that left keeps its results in the standings but is never
// seeded.
//
// What it writes, per division in the season:
//   • schedule/<C>/<div>/week-6..10.json — real matches, plus `byes` and
//     `withdrawn` on the week when a team has left. Overwrites the old Rivalry /
//     Playoff placeholder blobs at weeks 6–8.
//   • schedule/<C>/<div>/week-11.json — Championship Night placeholders, seeded
//     by rank off the full regular-season standings, stamped format:'double'.
//   • Every old week-6+ blob is snapshotted to schedule-backups first.
// Then: planned week dates (circuit-settings.weekDates) for weeks 6–11, the
// season record's `weeks` (and endDate, if it has one), and a standings rebuild.
//
// Refuses if anything at week 6+ has a result, a score sheet or a lineup. Until
// then it can be run again (e.g. to re-draw) — the previous weeks are backed up.
//
// POST body:
//   circuit           season code (default: the live season)
//   championshipDate  YYYY-MM-DD for the last week (default: last regular week + 7 days)
//   withdrawn         ['FOURPLAY'] — team name(s) or id(s) not playing the second half
//   seed              number — repeats a draw. The dry run returns the seed it used;
//                     pass it back on the live run so the same draw is written.
//   rounds            pin the draw by hand instead of a seed:
//                     [{ bye: 'Team', matches: [['Team A', 'Team B'], …] }, …] one per week
//   shuffle           false → replay Wk 1–5 in order instead of drawing (even counts only)
//   dryRun            true (default) → returns the plan, writes nothing

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { rebuildStandings } from './lib/standings.js';
import { circuitCode, seasonCircuitCode } from './lib/circuit.js';
import { liveCircuit } from './lib/current-season.js';
import { normalizeWeekDates } from './lib/week-dates.js';
import { buildBracketWeeks, FORMAT } from './lib/bracket.js';
import { drawRounds, checkRounds, seededRng, pairKey } from './lib/rematch-draw.js';

const TZ = 'America/Los_Angeles';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  try {
    const body = await req.json().catch(() => ({}));
    const circuit = circuitCode(body.circuit || await liveCircuit());
    const dryRun = body.dryRun !== false;           // default SAFE: dry run
    const champDateIn = body.championshipDate ? String(body.championshipDate).slice(0, 10) : null;
    if (champDateIn && !/^\d{4}-\d{2}-\d{2}$/.test(champDateIn)) {
      return json({ error: 'championshipDate must be YYYY-MM-DD' }, 400);
    }
    const shuffle = body.shuffle !== false;
    const withdrawnIn = [].concat(body.withdrawn || []).map(x => String(x).trim()).filter(Boolean);
    const roundsIn = Array.isArray(body.rounds) && body.rounds.length ? body.rounds : null;
    let seed = (body.seed != null && body.seed !== '' && Number.isFinite(Number(body.seed)))
      ? (Number(body.seed) >>> 0) : null;

    const store = getStore('schedule');
    const { blobs } = await store.list({ prefix: `schedule/${circuit}/` });
    const byDiv = {};
    for (const b of blobs) {
      const data = await store.get(b.key, { type: 'json' }).catch(() => null);
      if (!data?.division || !data.week) continue;
      (byDiv[data.division] ||= {})[data.week] = { key: b.key, data };
    }
    if (!Object.keys(byDiv).length) return json({ error: `No schedule found for season ${circuit}` }, 404);
    if (roundsIn && Object.keys(byDiv).length !== 1) {
      return json({ error: '"rounds" can only pin the draw for a season with one division. Use "seed" instead.' }, 400);
    }

    const scoresStore = getStore({ name: 'scores', consistency: 'strong' });
    const lineupStore = getStore('lineups');
    const now = new Date().toISOString();
    const plan = [];
    const draw = {};            // division → rounds by team name (paste back as "rounds" to pin)
    const writes = [];          // { key, data }
    const backups = [];         // { key, data }
    const plannedDates = {};    // week → iso
    const withdrawnOut = [];    // names
    const matchedWithdrawn = new Set();

    for (const [division, weeks] of Object.entries(byDiv)) {
      // ── Round 1 must be the complete single round-robin ──
      // (stops at the first bracket week, or at a week this function wrote before)
      const firstHalf = (d) => !(d.matches || []).some(m => m.phase) && d.format !== FORMAT.DOUBLE && !d.extendedFrom;
      const rr1 = [];
      for (let w = 1; weeks[w] && firstHalf(weeks[w].data); w++) rr1.push(weeks[w]);
      const teams = new Map();
      rr1.forEach(wf => wf.data.matches.forEach(m => {
        if (m.teamA?.id) teams.set(m.teamA.id, m.teamA.name || '');
        if (m.teamB?.id) teams.set(m.teamB.id, m.teamB.name || '');
      }));
      const n = teams.size;
      const once = Math.max(0, n - 1);
      if (n < 4 || n % 2 || rr1.length !== once) {
        return json({ error: `${division}: expected ${once} round-robin weeks for ${n} teams, found ${rr1.length}. Not touching it.` }, 409);
      }

      // ── Who plays the second half ──
      const all = [...teams].map(([id, name]) => ({ id, name }));
      const gone = all.filter(t => withdrawnIn.some(w => {
        const hit = w === t.id || norm(w) === norm(t.name);
        if (hit) matchedWithdrawn.add(w);
        return hit;
      }));
      if (gone.length > 1) {
        return json({ error: `${division}: only one team can leave mid-season (got ${gone.map(t => t.name).join(', ')}).` }, 409);
      }
      const active = all.filter(t => !gone.includes(t));
      const nameOf = (id) => teams.get(id) || id;
      gone.forEach(t => withdrawnOut.push(t.name));
      const R = once * 2;                           // one team out of an even count still needs N-1 weeks
      const champWeek = R + 1;

      // ── Guard: nothing after round 1 may have been played or set up ──
      const laterWeeks = Object.keys(weeks).map(Number).filter(w => w > once);
      for (const w of laterWeeks) {
        const ms = weeks[w].data.matches || [];
        if (ms.some(m => m.finalizedAt || m.scoreA != null)) {
          return json({ error: `${division} Week ${w} already has a result. Not touching it.` }, 409);
        }
        for (const m of ms) {
          const sheet = await scoresStore.get(`score/${m.id}.json`, { type: 'json' }).catch(() => null);
          if (sheet) return json({ error: `${division} Week ${w} match ${m.id} has a score sheet. Not touching it.` }, 409);
          // Exact keys, not a prefix listing: the division id carries a "+"
          // ("3.5+Mix") and listings by a prefix containing it come back empty.
          for (const t of [m.teamA, m.teamB]) {
            if (!t?.id) continue;
            const lu = await lineupStore.get(`lineup/${m.id}/${t.id}.json`, { type: 'json' }).catch(() => null);
            if (lu) return json({ error: `${division} Week ${w} match ${m.id} already has a lineup. Clear that week in the admin schedule first.` }, 409);
          }
        }
        backups.push({ key: weeks[w].key, data: weeks[w].data });
      }

      // ── The draw: one round per week ──
      const activeIds = active.map(t => t.id);
      let rounds, drawnFrom;
      if (roundsIn) {
        const find = (x) => {
          const k = norm(x);
          const t = active.find(t => t.id === x || norm(t.name) === k);
          return t ? t.id : null;
        };
        rounds = [];
        for (const r of roundsIn) {
          const pairs = [];
          for (const p of (r?.matches || r?.pairs || [])) {
            const a = find(p?.[0]), b = find(p?.[1]);
            if (!a || !b) return json({ error: `rounds: "${!a ? p?.[0] : p?.[1]}" is not a team playing the second half of ${division}.` }, 400);
            pairs.push([a, b]);
          }
          let bye = null;
          if (r?.bye) {
            bye = find(r.bye);
            if (!bye) return json({ error: `rounds: bye "${r.bye}" is not a team playing the second half of ${division}.` }, 400);
          }
          rounds.push({ bye, pairs });
        }
        const bad = checkRounds(rounds, activeIds);
        if (bad) return json({ error: `rounds: ${bad.replace(/team_[0-9a-f]+/g, id => nameOf(id))}` }, 400);
        drawnFrom = 'rounds';
      } else if (shuffle || gone.length) {
        if (seed == null) {
          if (!dryRun) {
            return json({ error: 'Run the dry run first, then pass its "seed" (or "rounds") so the live run writes the same draw you previewed.' }, 400);
          }
          seed = Math.floor(Math.random() * 2147483647) + 1;
        }
        const lastWeek = rr1[rr1.length - 1].data.matches.map(m => [m.teamA.id, m.teamB.id]);
        rounds = drawRounds(activeIds, { rng: seededRng(seed), avoidFirst: lastWeek });
        drawnFrom = 'draw';
      } else {
        rounds = rr1.map(wf => ({ bye: null, pairs: wf.data.matches.map(m => [m.teamA.id, m.teamB.id]) }));
        drawnFrom = 'replay';
      }

      // ── First meetings: who was home, and on which courts ──
      const label = (m) => m.court || (m.courtA != null ? `Courts ${m.courtA} & ${m.courtB}` : '');
      const firstHome = {}, firstCourt = {}, usage = {};
      const bump = (id, l) => { if (l) (usage[id] ||= {})[l] = (usage[id][l] || 0) + 1; };
      rr1.forEach(wf => wf.data.matches.forEach(m => {
        const k = pairKey(m.teamA.id, m.teamB.id);
        firstHome[k] = m.teamA.id;
        firstCourt[k] = label(m);
        bump(m.teamA.id, label(m)); bump(m.teamB.id, label(m));
      }));
      // The courts in play now = the ones used in the last round-1 week.
      const pool = [];
      for (const m of rr1[rr1.length - 1].data.matches) {
        const l = label(m);
        if (!l || pool.some(c => c.label === l)) continue;
        pool.push({
          label: l, courtSet: m.courtSet ?? null, courtA: m.courtA ?? null, courtB: m.courtB ?? null,
          venue: m.venue || null, startTime: m.startTime || null, endTime: m.endTime || null,
        });
      }

      // ── Dates: straight Thursdays after the last round-1 week, same clock time ──
      const last = rr1[rr1.length - 1].data.matches.find(m => m.scheduledAt)?.scheduledAt;
      if (!last) return json({ error: `${division}: Week ${once} has no scheduledAt to count from.` }, 409);
      const { ymd: lastYmd, hm } = laParts(last);
      const dateFor = (w) => {
        if (w === champWeek && champDateIn) return laIso(champDateIn, hm);
        return laIso(addDays(lastYmd, (w - once) * 7), hm);
      };

      // ── Weeks once+1 .. R ──
      rounds.forEach((round, k) => {
        const week = once + k + 1;
        const at = dateFor(week);
        // [home, away] — the away side of the first meeting hosts the rematch.
        const pairs = round.pairs.map(([a, b]) => (firstHome[pairKey(a, b)] === a ? [b, a] : [a, b]));
        const courts = pickCourts(pairs, pool, usage, firstCourt, k);
        const matches = pairs.map(([home, away], idx) => {
          const c = courts[idx] || {};
          bump(home, c.label); bump(away, c.label);
          return {
            id: matchId(circuit, division, week, idx),
            teamA: { id: home, name: nameOf(home) },
            teamB: { id: away, name: nameOf(away) },
            courtSet: c.courtSet ?? null,
            courtA: c.courtA ?? null,
            courtB: c.courtB ?? null,
            court: c.label || null,
            venue: c.venue || null,
            scheduledAt: at,
            startTime: c.startTime || null,
            endTime: c.endTime || null,
            scoreA: null, scoreB: null, playedAt: null,
          };
        });
        const byes = round.bye ? [{ id: round.bye, name: nameOf(round.bye) }] : [];
        writes.push({
          key: `schedule/${circuit}/${division}/week-${week}.json`,
          data: {
            circuit, division, week, matches,
            ...(byes.length ? { byes } : {}),
            ...(gone.length ? { withdrawn: gone } : {}),
            generatedAt: now, generatedBy: admin.email,
            extendedFrom: drawnFrom === 'replay' ? `week-${k + 1}` : drawnFrom,
            ...(drawnFrom === 'draw' ? { drawSeed: seed } : {}),
            format: FORMAT.DOUBLE,
          },
        });
        plannedDates[week] = at;
        plan.push({
          division, week, date: at,
          matches: matches.map(m => `${m.teamA.name} vs ${m.teamB.name} · ${m.court || ''}`),
          bye: byes[0]?.name || null,
        });
      });
      draw[division] = rounds.map(r => ({
        ...(r.bye ? { bye: nameOf(r.bye) } : {}),
        matches: r.pairs.map(([a, b]) => [nameOf(a), nameOf(b)]),
      }));

      // ── Championship Night ──
      const built = buildBracketWeeks({
        circuit, division, numTeams: active.length, startWeek: champWeek, format: FORMAT.DOUBLE,
      })[champWeek] || [];
      const champAt = dateFor(champWeek);
      const champ = built.map((m, idx) => {
        const c = pool.length ? pool[idx % pool.length] : {};
        return {
          ...m,
          ...(gone.length ? { withdrawn: gone.map(t => t.id) } : {}),
          courtSet: c.courtSet ?? m.courtSet, courtA: c.courtA ?? m.courtA, courtB: c.courtB ?? m.courtB,
          court: c.label || m.court,
          venue: c.venue || null,
          scheduledAt: champAt,
          startTime: c.startTime || null,
          endTime: c.endTime || null,
        };
      });
      writes.push({
        key: `schedule/${circuit}/${division}/week-${champWeek}.json`,
        data: {
          circuit, division, week: champWeek, phase: 'championship', phaseLabel: 'Championship Night',
          bracket: true, format: FORMAT.DOUBLE, matches: champ,
          ...(gone.length ? { withdrawn: gone } : {}),
          generatedAt: now, generatedBy: admin.email,
        },
      });
      plannedDates[champWeek] = champAt;
      plan.push({
        division, week: champWeek, date: champAt,
        matches: champ.map(m => `${m.bracketGroup}: #${m.seedA.rank} vs #${m.seedB.rank} · ${m.court || ''}`),
        bye: active.length % 2 ? `#${active.length} seed (no match)` : null,
      });

      // Old placeholder weeks past the new championship week (none for 6 teams,
      // but a bigger division could have them) are removed after backup.
      for (const w of laterWeeks) if (w > champWeek) writes.push({ key: weeks[w].key, data: null });
    }

    const unmatched = withdrawnIn.filter(w => !matchedWithdrawn.has(w));
    if (unmatched.length) {
      return json({ error: `No team called "${unmatched.join('", "')}" in season ${circuit}.` }, 400);
    }

    const totalWeeks = Math.max(...Object.keys(plannedDates).map(Number));
    const summary = { circuit, totalWeeks, seed, withdrawn: withdrawnOut, plan, draw };
    if (dryRun) {
      return json({ ok: true, dryRun: true, ...summary, backups: backups.map(b => b.key) });
    }

    // ── Write: backups first, then the new weeks ──
    const backupStore = getStore('schedule-backups');
    for (const b of backups) await backupStore.setJSON(`extend-${now}/${b.key}`, b.data);
    for (const w of writes) {
      if (w.data === null) await store.delete(w.key);
      else await store.setJSON(w.key, w.data);
    }

    // ── Planned week dates (public schedule fallback + admin week editor) ──
    const cfg = getStore({ name: 'config', consistency: 'strong' });
    const rawCfg = await cfg.get('circuit-settings');
    if (rawCfg) {
      const s = JSON.parse(rawCfg);
      const all = normalizeWeekDates(s.weekDates, s.circuitName);
      const bucket = { ...(all[circuit] || {}) };
      for (const k of Object.keys(bucket)) if (Number(k) > totalWeeks) delete bucket[k];
      for (const [w, iso] of Object.entries(plannedDates)) bucket[String(w)] = iso;
      all[circuit] = bucket;
      s.weekDates = all;
      s.updatedAt = now; s.updatedBy = admin.email || 'admin';
      await cfg.set('circuit-settings', JSON.stringify(s));
    }

    // ── Season record: length (drives "is this season still live") ──
    let seasonUpdated = null;
    const seasons = getStore('seasons');
    const { blobs: sBlobs } = await seasons.list();
    const champYmd = laParts(plannedDates[totalWeeks]).ymd;
    for (const b of sBlobs) {
      const raw = await seasons.get(b.key).catch(() => null);
      if (!raw) continue;
      let rec; try { rec = JSON.parse(raw); } catch { continue; }
      if (rec.isTest === true || seasonCircuitCode(rec) !== circuit) continue;
      rec.weeks = totalWeeks;
      rec.format = FORMAT.DOUBLE;
      if (rec.endDate && String(rec.endDate).slice(0, 10) < champYmd) rec.endDate = champYmd;
      rec.updatedAt = now;
      await seasons.set(b.key, JSON.stringify(rec));
      seasonUpdated = rec.id || b.key;
    }

    let standingsRebuilt = false;
    try { await rebuildStandings(circuit); standingsRebuilt = true; }
    catch (e) { console.error('extend-season standings rebuild failed:', e); }

    return json({ ok: true, ...summary, backedUp: backups.length, seasonUpdated, standingsRebuilt });
  } catch (err) {
    console.error('admin-extend-season error:', err);
    return json({ error: 'Extend failed', detail: err.message }, 500);
  }
};

// ── helpers ──
function matchId(circuit, division, week, idx) {
  return `m_${circuit}_${String(division).toLowerCase()}_w${week}_${idx + 1}`;
}
// Loose team-name match: "Four Play" === "FOURPLAY".
function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
// Every way to hand `k` distinct courts from the pool to k matches.
function* arrangements(pool, k, picked = []) {
  if (picked.length === k) { yield picked; return; }
  for (const c of pool) if (!picked.includes(c)) yield* arrangements(pool, k, [...picked, c]);
}
// Courts for one week: distinct courts per match, favouring courts the two teams
// have used least this season and avoiding the courts of their first meeting.
function pickCourts(pairs, pool, usage, firstCourt, weekIdx) {
  if (!pool.length) return pairs.map(() => null);
  if (pool.length < pairs.length) return pairs.map((_, i) => pool[(i + weekIdx) % pool.length]);
  let best = null, bestCost = Infinity;
  for (const combo of arrangements(pool, pairs.length)) {
    let cost = 0;
    combo.forEach((c, i) => {
      const [a, b] = pairs[i];
      cost += (usage[a]?.[c.label] || 0) + (usage[b]?.[c.label] || 0)
        + (firstCourt[pairKey(a, b)] === c.label ? 3 : 0);
    });
    if (cost < bestCost) { bestCost = cost; best = combo; }
  }
  return best || pairs.map(() => null);
}
function addDays(ymd, days) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// Local LA date + HH:MM of an ISO instant.
function laParts(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
// ISO instant for a LA wall-clock date + time (DST-correct).
function laIso(ymd, hm) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const [H, M] = hm.split(':').map(Number);
  const want = Date.UTC(y, mo - 1, d, H, M);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = laParts(new Date(t).toISOString());
    const [py, pm, pd] = p.ymd.split('-').map(Number);
    const [ph, pmin] = p.hm.split(':').map(Number);
    t += want - Date.UTC(py, pm - 1, pd, ph, pmin);
  }
  return new Date(t).toISOString();
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export const config = { path: '/.netlify/functions/admin-extend-season' };
