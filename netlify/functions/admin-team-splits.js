// netlify/functions/admin-team-splits.js
// League-admin view of the captains' "Split with your team" ledgers.
//
//   GET                → { teams: [{ teamId, teamName, division, mode, totals… }] }
//   GET ?teamId=<id>   → { config, ledger } — the same ledger the captain sees
//
// READ-ONLY and deliberately silent: nothing here writes to the split record,
// the activity log, or anything a captain or player can see, so looking leaves
// no trace on the team side. There is no admin mention anywhere in the captain
// or player UI.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { getSplit, listSplits, loadTabs, publicConfig } from './lib/team-split.js';
import { buildLedger } from './lib/team-split-math.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}

// Build a ledger WITHOUT the lazy writes loadLedger() does (roster-lock freeze,
// cache refresh) — an admin peek must not change the record.
async function readOnlyLedger(team, split) {
  const copy = JSON.parse(JSON.stringify(split));
  let tabs = [];
  if (copy.mode === 'pergame') tabs = (await loadTabs(team, copy, { useCache: false })).tabs;
  return buildLedger({ split: copy, team, tabs });
}

export default async (req) => {
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const teams = getStore({ name: 'teams', consistency: 'strong' });
  const teamId = new URL(req.url).searchParams.get('teamId');

  if (teamId) {
    const [team, split] = await Promise.all([
      teams.get(`team/${teamId}.json`, { type: 'json' }).catch(() => null),
      getSplit(teamId),
    ]);
    if (!team) return json({ error: 'Team not found' }, 404);
    if (!split) return json({ ok: true, config: null, ledger: null });
    return json({ ok: true, config: publicConfig(split), ledger: await readOnlyLedger(team, split) });
  }

  const out = [];
  for (const split of await listSplits()) {
    const team = await teams.get(`team/${split.teamId}.json`, { type: 'json' }).catch(() => null);
    if (!team) continue;
    const ledger = await readOnlyLedger(team, split);
    out.push({
      teamId: team.id, teamName: team.name || null, division: team.division || null, circuit: team.circuit || null,
      enabled: !!split.enabled, mode: ledger.mode, amountCents: split.amountCents || 0, rateCents: split.rateCents || 0,
      venmoHandle: split.venmoHandle || null, totals: ledger.totals, updatedAt: split.updatedAt || null,
    });
  }
  out.sort((a, b) => (a.teamName || '').localeCompare(b.teamName || ''));
  return json({ ok: true, teams: out });
};

export const config = { path: '/.netlify/functions/admin-team-splits' };
