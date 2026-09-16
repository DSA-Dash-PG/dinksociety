// netlify/functions/admin-restore-schedule.js
//
// Admin-only. Rebuilds a season's schedule week files from the per-match score
// blobs ('scores' store, score/<matchId>.json) after "Generate season" was run
// over a season that already had results.
//
// Why this works: Generate season only overwrites schedule/<circuit>/<div>/week-N.json.
// Score sheets (scores store) and lineups (lineups store) are keyed by match id
// and are never touched, and each score record carries week, division, home and
// away teams. So the finalized results can be written back onto the schedule and
// standings + player stats rebuilt from them.
//
// By default only divisions that look wiped are restored: the schedule has NO
// finalized matches but the score store has finalized sheets for that division.
//
// GET  ?circuit=I                      → dry run, shows what would be restored
// GET  ?circuit=I&division=3.5M        → dry run, one division (forces it even if not wiped)
// GET  ?circuit=I&apply=1              → writes the week files + rebuilds standings

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { rebuildStandings } from './lib/standings.js';
import { circuitCode } from './lib/circuit.js';
import { decorate } from './lib/score-helpers.js';

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  const url = new URL(req.url);
  const circuit = circuitCode(url.searchParams.get('circuit') || 'I');
  const onlyDiv = (url.searchParams.get('division') || '').trim();
  const apply = url.searchParams.get('apply') === '1';

  try {
    const scheduleStore = getStore({ name: 'schedule', consistency: 'strong' });
    const scoresStore = getStore({ name: 'scores', consistency: 'strong' });
    const backupStore = getStore('schedule-backups');

    // ── 1. Every score sheet for this circuit, grouped by division → week ──
    const { blobs: scoreBlobs } = await scoresStore.list({ prefix: `score/m_${circuit}_` });
    const scoresByDiv = {};
    for (const b of scoreBlobs) {
      const s = await scoresStore.get(b.key, { type: 'json' }).catch(() => null);
      if (!s?.matchId || !s.home?.id || !s.away?.id) continue;
      if (s.circuit && circuitCode(s.circuit) !== circuit) continue;
      const parsed = parseMatchId(s.matchId);
      const div = s.division || parsed.division;
      const week = Number(s.week || parsed.week);
      if (!div || !week) continue;
      ((scoresByDiv[div] ||= {})[week] ||= []).push(s);
    }

    // ── 2. Current (regenerated) schedule files, grouped by division → week ──
    const { blobs: schedBlobs } = await scheduleStore.list({ prefix: `schedule/${circuit}/` });
    const schedByDiv = {};
    for (const b of schedBlobs) {
      const d = await scheduleStore.get(b.key, { type: 'json' }).catch(() => null);
      if (!d?.division || !d.week) continue;
      (schedByDiv[d.division] ||= {})[d.week] = { key: b.key, data: d };
    }

    const report = [];
    const writes = [];
    const stamp = new Date().toISOString();

    for (const [div, weeks] of Object.entries(scoresByDiv)) {
      if (onlyDiv && div.toLowerCase() !== onlyDiv.toLowerCase()) continue;

      const finalizedSheets = Object.values(weeks).flat().filter(s => s.finalizedAt).length;
      const schedWeeks = schedByDiv[div] || {};
      const finalizedOnSchedule = Object.values(schedWeeks)
        .flatMap(w => w.data.matches || []).filter(m => m.finalizedAt).length;
      const wiped = finalizedSheets > 0 && finalizedOnSchedule === 0;

      if (!onlyDiv && !wiped) {
        report.push({ division: div, skipped: true,
          reason: `schedule still has ${finalizedOnSchedule} finalized match(es) — not wiped`,
          finalizedSheets, finalizedOnSchedule });
        continue;
      }

      const divReport = { division: div, finalizedSheets, weeks: [] };
      for (const [wkStr, sheets] of Object.entries(weeks).sort((a, b) => a[0] - b[0])) {
        const week = Number(wkStr);
        const key = `schedule/${circuit}/${div}/week-${week}.json`;
        const current = schedWeeks[week]?.data || null;
        const currentRows = current?.matches || [];
        const byId = new Map(currentRows.map(m => [m.id, m]));
        const scoredIds = new Set(sheets.map(s => s.matchId));

        const rows = sheets
          .sort((a, b) => String(a.matchId).localeCompare(String(b.matchId)))
          .map(s => {
            const base = byId.get(s.matchId) || {
              id: s.matchId, scheduledAt: null, playedAt: null,
            };
            const row = {
              ...base,
              teamA: { id: s.home.id, name: s.home.name },
              teamB: { id: s.away.id, name: s.away.name },
              scoreA: null, scoreB: null, finalizedAt: null, round1: null, round2: null,
            };
            if (s.finalizedAt) {
              const champ = !!(base.championship || s.championship);
              const dec = decorate(JSON.parse(JSON.stringify(s)), champ);
              row.scoreA = dec.computed.matchPoints.home;
              row.scoreB = dec.computed.matchPoints.away;
              row.finalizedAt = s.finalizedAt;
              row.round1 = dec.computed.round1;
              row.round2 = dec.computed.round2;
              let pa = 0, pb = 0;
              for (const g of dec.computed.gameStatuses) {
                if (g.status !== 'confirmed') continue;
                const gm = s.games?.[g.slot];
                const h = Number.isInteger(gm?.home) ? gm.home : gm?.homeEntry?.home;
                const a = Number.isInteger(gm?.away) ? gm.away : gm?.homeEntry?.away;
                if (Number.isInteger(h)) pa += h;
                if (Number.isInteger(a)) pb += a;
              }
              row.pointsA = pa; row.pointsB = pb;
            }
            return row;
          });

        // Keep unscored bracket placeholders; drop regenerated round-robin rows
        // that have no score sheet (they are new pairings, not Season history).
        const keptPlaceholders = currentRows.filter(m => !scoredIds.has(m.id) && m.phase);
        const dropped = currentRows.filter(m => !scoredIds.has(m.id) && !m.phase)
          .map(m => `${m.teamA?.name || 'TBD'} vs ${m.teamB?.name || 'TBD'}`);

        const next = {
          ...(current || { circuit, division: div, week }),
          circuit, division: div, week,
          matches: [...rows, ...keptPlaceholders],
          restoredAt: stamp, restoredBy: admin.email,
        };

        divReport.weeks.push({
          week,
          matches: rows.map(r => `${r.teamA.name} ${r.scoreA ?? '-'}–${r.scoreB ?? '-'} ${r.teamB.name}${r.finalizedAt ? '' : ' (not final)'}`),
          keptPlaceholders: keptPlaceholders.length,
          droppedRegeneratedRows: dropped,
        });
        writes.push({ key, next, current });
      }
      report.push(divReport);
    }

    if (!apply) {
      return json({ ok: true, dryRun: true, circuit, wouldWriteWeeks: writes.length, report,
        next: writes.length ? 'Looks right? Add &apply=1 to the URL to restore.' : 'Nothing to restore.' });
    }

    // Back up what's there now before writing, so the restore is reversible too.
    for (const w of writes) {
      if (w.current) await backupStore.setJSON(`restore-${stamp}/${w.key}`, w.current);
      await scheduleStore.setJSON(w.key, w.next);
    }

    let standingsRebuilt = false;
    if (writes.length) {
      await rebuildStandings(circuit);
      standingsRebuilt = true;
    }

    return json({ ok: true, applied: true, circuit, weeksWritten: writes.length, standingsRebuilt, report });
  } catch (err) {
    console.error('admin-restore-schedule error:', err);
    return json({ error: 'Restore failed', detail: err.message }, 500);
  }
};

// m_I_3.5m_w4_2  /  m_I_3.5m_w7_semi-A
function parseMatchId(id) {
  const m = /^m_[^_]+_(.+)_w(\d+)_[^_]+$/.exec(String(id || ''));
  return m ? { division: null, week: Number(m[2]) } : { division: null, week: null };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const config = { path: '/.netlify/functions/admin-restore-schedule' };