// netlify/functions/admin-extend-season.js
//
// Admin-only, one-time. Converts a LIVE 6-team season from the original format
//   Wk 1–5 round-robin · Wk 6 Rivalry · Wk 7 Semis · Wk 8 Gold/Bronze
// to the DOUBLE format (lib/bracket.js FORMAT.DOUBLE):
//   Wk 1–5 round-robin · Wk 6–10 round-robin again (home/away flipped)
//   Wk 11 Championship Night — #1 v #2 (title), #3 v #4, #5 v #6
//
// What it writes, per division in the season:
//   • schedule/<C>/<div>/week-6..10.json — real matches (the Wk 1–5 pairings
//     replayed with home/away swapped; court sets shifted one slot so nobody
//     repeats the courts of the first meeting). Overwrites the old Rivalry /
//     Playoff placeholder blobs at weeks 6–8.
//   • schedule/<C>/<div>/week-11.json — Championship Night placeholders,
//     seeded by rank off the full 10-week standings, stamped format:'double'.
//   • Every old week-6+ blob is snapshotted to schedule-backups first.
// Then: planned week dates (circuit-settings.weekDates) for weeks 6–11, the
// season record's `weeks` (and endDate, if it has one), and a standings rebuild.
//
// Refuses if anything at week 6+ has been played or has a score sheet.
//
// POST body: { circuit: 'II', championshipDate: '2026-12-03', dryRun: true }
//   circuit           season code (default: the live season)
//   championshipDate  YYYY-MM-DD for Week 11 (default: Week 10 + 7 days)
//   dryRun            true → returns the plan, writes nothing

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { rebuildStandings } from './lib/standings.js';
import { circuitCode, seasonCircuitCode } from './lib/circuit.js';
import { liveCircuit } from './lib/current-season.js';
import { normalizeWeekDates } from './lib/week-dates.js';
import { buildBracketWeeks, FORMAT, regularRounds } from './lib/bracket.js';

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

    const store = getStore('schedule');
    const { blobs } = await store.list({ prefix: `schedule/${circuit}/` });
    const byDiv = {};
    for (const b of blobs) {
      const data = await store.get(b.key, { type: 'json' }).catch(() => null);
      if (!data?.division || !data.week) continue;
      (byDiv[data.division] ||= {})[data.week] = { key: b.key, data };
    }
    if (!Object.keys(byDiv).length) return json({ error: `No schedule found for season ${circuit}` }, 404);

    const scoresStore = getStore({ name: 'scores', consistency: 'strong' });
    const now = new Date().toISOString();
    const plan = [];
    const writes = [];          // { key, data }
    const backups = [];         // { key, data }
    const plannedDates = {};    // week → iso

    for (const [division, weeks] of Object.entries(byDiv)) {
      // ── Round 1 must be the complete single round-robin ──
      const rr1 = [];
      for (let w = 1; weeks[w] && !(weeks[w].data.matches || []).some(m => m.phase); w++) rr1.push(weeks[w]);
      const teams = new Set();
      rr1.forEach(wf => wf.data.matches.forEach(m => { if (m.teamA?.id) teams.add(m.teamA.id); if (m.teamB?.id) teams.add(m.teamB.id); }));
      const n = teams.size;
      const once = regularRounds(n, FORMAT.SINGLE);
      if (n < 4 || n % 2 || rr1.length !== once) {
        return json({ error: `${division}: expected ${once} round-robin weeks for ${n} teams, found ${rr1.length}. Not touching it.` }, 409);
      }
      const R = regularRounds(n, FORMAT.DOUBLE);   // 10 for 6 teams
      const champWeek = R + 1;

      // ── Guard: nothing after round 1 may have been played ──
      const laterWeeks = Object.keys(weeks).map(Number).filter(w => w > once);
      for (const w of laterWeeks) {
        const ms = weeks[w].data.matches || [];
        if (ms.some(m => m.finalizedAt || m.scoreA != null)) {
          return json({ error: `${division} Week ${w} already has a result. Not touching it.` }, 409);
        }
        for (const m of ms) {
          const sheet = await scoresStore.get(`score/${m.id}.json`, { type: 'json' }).catch(() => null);
          if (sheet) return json({ error: `${division} Week ${w} match ${m.id} has a score sheet. Not touching it.` }, 409);
        }
        if (weeks[w].data.format === FORMAT.DOUBLE || (ms.length && ms.every(m => !m.phase) && w <= R)) {
          // Already extended (re-run) — fine, it'll be rewritten identically.
        }
        backups.push({ key: weeks[w].key, data: weeks[w].data });
      }

      // ── Dates: straight Thursdays after the last round-1 week, same clock time ──
      const last = rr1[rr1.length - 1].data.matches.find(m => m.scheduledAt)?.scheduledAt;
      if (!last) return json({ error: `${division}: Week ${once} has no scheduledAt to count from.` }, 409);
      const { ymd: lastYmd, hm } = laParts(last);
      const dateFor = (w) => {
        if (w === champWeek && champDateIn) return laIso(champDateIn, hm);
        return laIso(addDays(lastYmd, (w - once) * 7), hm);
      };

      // ── Weeks once+1 .. R: replay round 1 with home/away swapped ──
      for (let k = 1; k <= once; k++) {
        const src = rr1[k - 1].data.matches;
        const week = once + k;
        const at = dateFor(week);
        const matches = src.map((m, idx) => {
          const c = src[(idx + 1) % src.length];  // shift court sets one slot
          return {
            id: matchId(circuit, division, week, idx),
            teamA: { id: m.teamB.id, name: m.teamB.name },
            teamB: { id: m.teamA.id, name: m.teamA.name },
            courtSet: c.courtSet ?? null,
            courtA: c.courtA ?? null,
            courtB: c.courtB ?? null,
            court: c.court || (c.courtA != null ? `Courts ${c.courtA} & ${c.courtB}` : null),
            venue: m.venue || null,
            scheduledAt: at,
            startTime: m.startTime || null,
            endTime: m.endTime || null,
            scoreA: null, scoreB: null, playedAt: null,
          };
        });
        writes.push({
          key: `schedule/${circuit}/${division}/week-${week}.json`,
          data: { circuit, division, week, matches, generatedAt: now, generatedBy: admin.email, extendedFrom: `week-${k}`, format: FORMAT.DOUBLE },
        });
        plannedDates[week] = at;
        plan.push({ division, week, date: at, matches: matches.map(m => `${m.teamA.name} vs ${m.teamB.name} · ${m.court || ''}`) });
      }

      // ── Championship Night ──
      const built = buildBracketWeeks({ circuit, division, numTeams: n, format: FORMAT.DOUBLE })[champWeek] || [];
      const lastCourts = rr1[0].data.matches;        // reuse the league's real courts
      const champAt = dateFor(champWeek);
      const champ = built.map((m, idx) => {
        const c = lastCourts[idx % lastCourts.length];
        return {
          ...m,
          courtSet: c.courtSet ?? m.courtSet, courtA: c.courtA ?? m.courtA, courtB: c.courtB ?? m.courtB,
          court: c.court || m.court,
          venue: c.venue || null,
          scheduledAt: champAt,
          startTime: c.startTime || null,
          endTime: c.endTime || null,
        };
      });
      writes.push({
        key: `schedule/${circuit}/${division}/week-${champWeek}.json`,
        data: { circuit, division, week: champWeek, phase: 'championship', phaseLabel: 'Championship Night', bracket: true, format: FORMAT.DOUBLE, matches: champ, generatedAt: now, generatedBy: admin.email },
      });
      plannedDates[champWeek] = champAt;
      plan.push({ division, week: champWeek, date: champAt, matches: champ.map(m => `${m.bracketGroup}: #${m.seedA.rank} vs #${m.seedB.rank} · ${m.court || ''}`) });

      // Old placeholder weeks past the new championship week (none for 6 teams,
      // but a bigger division could have them) are removed after backup.
      for (const w of laterWeeks) if (w > champWeek) writes.push({ key: weeks[w].key, data: null });
    }

    const totalWeeks = Math.max(...Object.keys(plannedDates).map(Number));
    if (dryRun) {
      return json({ ok: true, dryRun: true, circuit, totalWeeks, plan, backups: backups.map(b => b.key) });
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

    return json({ ok: true, circuit, totalWeeks, plan, backedUp: backups.length, seasonUpdated, standingsRebuilt });
  } catch (err) {
    console.error('admin-extend-season error:', err);
    return json({ error: 'Extend failed', detail: err.message }, 500);
  }
};

// ── helpers ──
function matchId(circuit, division, week, idx) {
  return `m_${circuit}_${String(division).toLowerCase()}_w${week}_${idx + 1}`;
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
