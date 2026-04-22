// netlify/functions/admin-seed-teams.js
// Reads confirmed registrations and creates team records in the 'teams' store
// so captains can sign in via magic link.
//
// Admin-only. Idempotent: running it twice does not duplicate teams. Uses
// dryRun=true to preview what it would do without writing.
//
// GET  ?dryRun=1    → returns a plan: { toCreate, toUpdate, toSkip }
// POST              → applies the plan, returns { created, updated, skipped, errors }
//
// Team ID derivation: slugified team name, de-duplicated with -2, -3, etc.
// If a team with the same captainEmail already exists, it's matched by email
// rather than by generated ID. This lets captains change their team name
// post-registration without orphaning the record.

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

const DIVISION_LABELS = {
  '3.0M': '3.0 Mixed',
  '3.5M': '3.5 Mixed',
  '3.5W': "3.5 Women's",
};

export default async (req) => {
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  const method = req.method;
  if (method !== 'GET' && method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const dryRun = method === 'GET' || url.searchParams.get('dryRun') === '1';

  try {
    const plan = await buildPlan();

    if (dryRun) {
      return json({
        dryRun: true,
        toCreate: plan.toCreate.map(redactPlanItem),
        toUpdate: plan.toUpdate.map(redactPlanItem),
        toSkip: plan.toSkip.map(redactPlanItem),
        freeAgentsCount: plan.freeAgents.length,
      });
    }

    const result = await applyPlan(plan, admin.email);
    return json({ dryRun: false, ...result });
  } catch (err) {
    console.error('admin-seed-teams error:', err);
    return json({ error: 'Seeding failed', detail: err.message }, 500);
  }
};

// ===== Plan construction =====

async function buildPlan() {
  const regStore = getStore('registrations');
  const teamsStore = getStore('teams');

  // Load all confirmed registrations
  const { blobs: regBlobs } = await regStore.list({ prefix: 'confirmed/' });
  const regs = (await Promise.all(
    regBlobs.map(b => regStore.get(b.key, { type: 'json' }))
  )).filter(Boolean);

  // Load all existing teams into lookup maps
  const { blobs: teamBlobs } = await teamsStore.list({ prefix: 'team/' });
  const existingTeams = (await Promise.all(
    teamBlobs.map(b => teamsStore.get(b.key, { type: 'json' }))
  )).filter(Boolean);

  const teamsByEmail = new Map();
  const existingIds = new Set();
  for (const t of existingTeams) {
    existingIds.add(t.id);
    if (t.captainEmail) teamsByEmail.set(t.captainEmail.toLowerCase(), t);
  }

  const teamRegs = regs.filter(r => r.path === 'team');
  const freeAgents = regs.filter(r => r.path === 'agent');

  const toCreate = [];
  const toUpdate = [];
  const toSkip = [];

  // Track newly-minted IDs within this run so two registrations with the
  // same team name don't collide mid-plan
  const claimedIds = new Set(existingIds);

  for (const reg of teamRegs) {
    const captainEmail = (reg.team?.players?.[0]?.email || '').toLowerCase();
    const teamName = (reg.team?.name || '').trim();

    if (!captainEmail || !teamName) {
      toSkip.push({
        reason: 'missing captain email or team name',
        registrationId: reg.id,
      });
      continue;
    }

    const roster = buildRosterFromRegistration(reg);

    const existing = teamsByEmail.get(captainEmail);
    if (existing) {
      // Update path: team record exists for this captain email already
      const changes = diffExistingTeam(existing, { reg, teamName, captainEmail, roster });
      if (changes.length === 0) {
        toSkip.push({
          reason: 'team already exists and matches registration',
          teamId: existing.id,
          teamName: existing.name,
          captainEmail,
        });
      } else {
        toUpdate.push({
          action: 'update',
          teamId: existing.id,
          teamName,
          captainEmail,
          division: reg.division,
          changes,
          _reg: reg,
          _existing: existing,
        });
      }
      continue;
    }

    // Create path
    const id = generateTeamId(teamName, claimedIds);
    claimedIds.add(id);
    toCreate.push({
      action: 'create',
      teamId: id,
      teamName,
      captainEmail,
      division: reg.division,
      divisionLabel: reg.divisionLabel || DIVISION_LABELS[reg.division],
      circuit: reg.circuit,
      roster,
      _reg: reg,
    });
  }

  return { toCreate, toUpdate, toSkip, freeAgents };
}

function diffExistingTeam(existing, { reg, teamName, roster }) {
  const changes = [];
  if (existing.name !== teamName) changes.push(`name: "${existing.name}" → "${teamName}"`);
  if (existing.division !== reg.division) changes.push(`division: ${existing.division} → ${reg.division}`);
  if (existing.circuit !== reg.circuit) changes.push(`circuit: ${existing.circuit} → ${reg.circuit}`);

  // Only propose roster update if existing roster is empty (don't clobber captain edits)
  const existingRoster = existing.roster || [];
  if (existingRoster.length === 0 && roster.length > 0) {
    changes.push(`seed roster (${roster.length} players)`);
  }
  return changes;
}

// ===== Apply =====

async function applyPlan(plan, adminEmail) {
  const teamsStore = getStore('teams');
  const created = [];
  const updated = [];
  const errors = [];
  const now = new Date().toISOString();

  for (const item of plan.toCreate) {
    try {
      const team = {
        id: item.teamId,
        name: item.teamName,
        captainEmail: item.captainEmail,
        circuit: item.circuit,
        division: item.division,
        divisionLabel: item.divisionLabel,
        roster: item.roster,
        createdAt: now,
        createdBy: adminEmail,
        seededFromRegistrationId: item._reg.id,
      };
      await teamsStore.setJSON(`team/${team.id}.json`, team);
      created.push({ teamId: team.id, name: team.name, captainEmail: team.captainEmail });
    } catch (err) {
      errors.push({ teamName: item.teamName, error: err.message });
    }
  }

  for (const item of plan.toUpdate) {
    try {
      const existing = item._existing;
      const reg = item._reg;
      const roster = (existing.roster && existing.roster.length > 0)
        ? existing.roster
        : buildRosterFromRegistration(reg);

      const team = {
        ...existing,
        name: item.teamName,
        captainEmail: item.captainEmail,
        division: reg.division,
        divisionLabel: reg.divisionLabel || DIVISION_LABELS[reg.division],
        circuit: reg.circuit,
        roster,
        updatedAt: now,
        updatedBy: adminEmail,
      };
      await teamsStore.setJSON(`team/${team.id}.json`, team);
      updated.push({ teamId: team.id, name: team.name, changes: item.changes });
    } catch (err) {
      errors.push({ teamName: item.teamName, error: err.message });
    }
  }

  return {
    created: created.length,
    updated: updated.length,
    skipped: plan.toSkip.length,
    errors: errors.length,
    details: { created, updated, skipped: plan.toSkip, errors },
  };
}

// ===== Roster seeding =====

function buildRosterFromRegistration(reg) {
  const players = reg.team?.players || [];
  return players.map((p, idx) => ({
    id: generatePlayerId(),
    name: (p.name || '').trim(),
    gender: '', // Captain must fill this in — registration doesn't capture it
    email: p.email || null,
    phone: p.phone || null,
    dupr: null,
    linkedUserId: null,
    isCaptain: idx === 0,
    seededFromRegistration: true,
  })).filter(p => p.name); // drop entries with no name
}

// ===== ID generation =====

function generateTeamId(teamName, claimedIds) {
  const base = 't_' + slugify(teamName);
  if (!claimedIds.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!claimedIds.has(candidate)) return candidate;
  }
  // Last-resort random suffix
  return `${base}-${randomSuffix()}`;
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'team';
}

function generatePlayerId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return 'p_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomSuffix() {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===== Redaction for dry-run responses =====

function redactPlanItem(item) {
  // Strip the private _reg / _existing handles so dry-run responses are clean
  const { _reg, _existing, ...rest } = item;
  return rest;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    },
  });
}

export const config = { path: '/.netlify/functions/admin-seed-teams' };
