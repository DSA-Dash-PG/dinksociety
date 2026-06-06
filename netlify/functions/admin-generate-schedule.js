// netlify/functions/admin-generate-schedule.js
// Admin-only. Takes a circuit + division and generates round-robin pairings.
// For 6 teams this produces 5 weeks of matches (each team plays each other once).
// If there are more Circuit weeks than needed for one full round-robin, extra
// weeks are left as TBD (e.g. week 6 crossover, week 7 championship).
//
// POST body: { circuit: 'I', division: '3.5M', teams: [{id, name}, ...], courts: ['Court 1', 'Court 2', 'Court 3'] }
// Writes one file per week to the 'schedule' Blobs store and returns a summary.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { assignCourtSets } from './lib/courts.js';
import { rebuildStandings } from './lib/standings.js';
import { circuitCode } from './lib/circuit.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  try {
    const { circuit, division, teams, courts = [] } = await req.json();
    if (!circuit || !division || !Array.isArray(teams) || teams.length < 2) {
      return json({ error: 'circuit, division, and at least 2 teams required' }, 400);
    }
    if (teams.length % 2 !== 0) {
      return json({ error: 'Team count must be even for round-robin' }, 400);
    }

    const schedule = generateRoundRobin(teams);
    const store = getStore('schedule');

    // Rotate the 2-court sets (A=1&2, B=3&6, C=5&7) across the season so every
    // team plays each set as evenly as possible.
    const courtPlan = assignCourtSets(
      schedule.map(week => week.map(pair => ({ teamAId: pair[0].id, teamBId: pair[1].id })))
    );

    const summary = [];
    for (let i = 0; i < schedule.length; i++) {
      const week = i + 1;
      const pairings = schedule[i];
      const matches = pairings.map((pair, idx) => {
        const plan = courtPlan[i][idx];
        return {
          id: matchId(circuit, division, week, idx),
          teamA: { id: pair[0].id, name: pair[0].name },
          teamB: { id: pair[1].id, name: pair[1].name },
          courtSet: plan.courtSet,
          courtA: plan.courtA,
          courtB: plan.courtB,
          court: `Courts ${plan.courtA} & ${plan.courtB}`, // summary label
          scheduledAt: null,
          scoreA: null,
          scoreB: null,
          playedAt: null,
        };
      });

      const key = `schedule/${circuit}/${division}/week-${week}.json`;
      await store.setJSON(key, {
        circuit, division, week,
        matches,
        generatedAt: new Date().toISOString(),
        generatedBy: admin.email,
      });
      summary.push({ week, matchCount: matches.length });
    }

    // Rebuild standings so the division table goes live immediately (all teams
    // seeded at 0-0), rather than staying blank until the first score finalizes.
    let standingsRebuilt = false;
    try {
      await rebuildStandings(circuitCode(circuit));
      standingsRebuilt = true;
    } catch (e) {
      console.error('post-generate standings rebuild failed:', e);
    }

    return json({ ok: true, weeksGenerated: schedule.length, summary, standingsRebuilt });
  } catch (err) {
    console.error('admin-generate-schedule error:', err);
    return json({ error: 'Generation failed', detail: err.message }, 500);
  }
};

/**
 * Classic circle-method round-robin. For N teams returns an array of N-1 rounds,
 * each round being an array of [teamA, teamB] pairs covering all teams exactly once.
 */
function generateRoundRobin(teams) {
  const n = teams.length;
  const rotation = [...teams];
  const rounds = [];

  for (let round = 0; round < n - 1; round++) {
    const pairings = [];
    for (let i = 0; i < n / 2; i++) {
      pairings.push([rotation[i], rotation[n - 1 - i]]);
    }
    rounds.push(pairings);
    // Rotate all but the first team
    const fixed = rotation[0];
    const rest = rotation.slice(1);
    rest.unshift(rest.pop());
    rotation.splice(0, rotation.length, fixed, ...rest);
  }
  return rounds;
}

function matchId(circuit, division, week, idx) {
  return `m_${circuit}_${division.toLowerCase()}_w${week}_${idx + 1}`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export const config = { path: '/.netlify/functions/admin-generate-schedule' };
