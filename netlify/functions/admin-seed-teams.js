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
//
// MATCHING an existing team (this is the part that used to corrupt data).
// Matching was by captainEmail ALONE, in a Map with one entry per email. A
// team record is PER SEASON, so a captain who plays two seasons has two team
// records — and the map kept only the last one. Their Season 2 registration
// would then match their SEASON 1 team and overwrite its circuit and division
// with Season 2 values, silently moving a finished team into the new season.
// (That is how one Season 1 squad ended up filed under Season 2, showing as a
// second team in that season's Teams tab and standings.)
//
// Now it matches, in order:
//   1. the registration id already recorded on the team — the strongest link
//   2. captainEmail + SEASON together
//   3. no match → create
//
// WHAT SYNC WILL NOT TOUCH on a team that already exists:
//   name    — an admin renamed it deliberately (often to tell apart two teams
//             registered under the same name). The registration keeps the old
//             name forever, so copying it back wiped the rename every run.
//   circuit — the season is owned by the team record and the move-season
//             action; re-asserting it from the registration would undo a
//             deliberate move.
// Both are reported in the result as `preserved` so the difference between the
// team and its registration is visible rather than silently resolved.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { normalizeEmail, normalizePhone } from './lib/identity.js';
import { circuitCode, seasonName } from './lib/circuit.js';
import { logActivity } from './lib/activity-log.js';

const DIVISION_LABELS = {
  '3.0M': '3.0 Mixed',
  '3.5M': '3.5 Mixed',
  '3.5W': "3.5 Women's",
};

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

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

  // Two indexes, both season-aware. The email+season key is what stops a
  // captain's new-season registration from reaching their old-season team.
  const teamsByRegId = new Map();
  const teamsByEmailSeason = new Map();
  const existingIds = new Set();
  for (const t of existingTeams) {
    existingIds.add(t.id);
    const regId = t.registrationId || t.seededFromRegistrationId;
    if (regId) teamsByRegId.set(String(regId), t);
    if (t.captainEmail) {
      teamsByEmailSeason.set(emailSeasonKey(t.captainEmail, t.circuit || t.seasonId), t);
    }
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

    // Match by the registration this team was built from first; only then by
    // captain AND season. Never by email alone — see the header note.
    const existing = teamsByRegId.get(String(reg.id))
      || teamsByEmailSeason.get(emailSeasonKey(captainEmail, reg.circuit));

    if (existing) {
      // Update path: team record exists for this captain in this season
      const { changes, preserved } = diffExistingTeam(existing, { reg, teamName, captainEmail, roster });
      if (changes.length === 0) {
        toSkip.push({
          reason: 'team already exists and matches registration',
          teamId: existing.id,
          teamName: existing.name,
          captainEmail,
          ...(preserved.length ? { preserved } : {}),
        });
      } else {
        toUpdate.push({
          action: 'update',
          teamId: existing.id,
          // The team's OWN name is what gets written back — not the
          // registration's. `teamName` here is only used for reporting.
          teamName: existing.name,
          registrationName: teamName,
          captainEmail,
          division: reg.division,
          changes,
          preserved,
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
  const preserved = [];

  // Name and season are the team's own. Where they differ from the
  // registration, SAY so and move on — don't overwrite.
  if (existing.name !== teamName) {
    preserved.push(`name kept as "${existing.name}" (registration says "${teamName}")`);
  }
  if (circuitCode(existing.circuit || existing.seasonId) !== circuitCode(reg.circuit)) {
    preserved.push(`season kept as ${seasonName(existing.circuit || existing.seasonId)}`
      + ` (registration says ${seasonName(reg.circuit)})`);
  }

  if (existing.division !== reg.division) changes.push(`division: ${existing.division} → ${reg.division}`);

  // Only propose roster update if existing roster is empty (don't clobber captain edits)
  const existingRoster = existing.roster || [];
  if (existingRoster.length === 0 && roster.length > 0) {
    changes.push(`seed roster (${roster.length} players)`);
  }
  return { changes, preserved };
}

/** One key per captain PER SEASON — never per captain alone. */
function emailSeasonKey(email, circuitish) {
  return String(email || '').trim().toLowerCase() + '::' + circuitCode(circuitish);
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
      // Sync used to write nothing to the activity log, so a team appearing or
      // a name changing looked like it happened by itself.
      await logActivity({
        type: 'team.updated',
        actor: { email: adminEmail, role: 'admin' },
        team,
        details: `Created by Sync from Registrations (${seasonName(team.circuit)})`,
      }).catch(() => {});
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
        // name and circuit are deliberately NOT taken from the registration —
        // both are owned by the team record once it exists. See header.
        captainEmail: item.captainEmail,
        division: reg.division,
        divisionLabel: reg.divisionLabel || DIVISION_LABELS[reg.division],
        roster,
        // Record the link so future runs match on it rather than on identity.
        ...(existing.registrationId || existing.seededFromRegistrationId
          ? {}
          : { seededFromRegistrationId: reg.id }),
        updatedAt: now,
        updatedBy: adminEmail,
      };
      await teamsStore.setJSON(`team/${team.id}.json`, team);
      updated.push({
        teamId: team.id, name: team.name,
        changes: item.changes,
        ...(item.preserved?.length ? { preserved: item.preserved } : {}),
      });
      await logActivity({
        type: 'team.updated',
        actor: { email: adminEmail, role: 'admin' },
        team,
        details: `Sync from Registrations: ${item.changes.join('; ')}`
          + (item.preserved?.length ? ` · left alone: ${item.preserved.join('; ')}` : ''),
      }).catch(() => {});
    } catch (err) {
      errors.push({ teamName: item.teamName, error: err.message });
    }
  }

  // Everything Sync chose NOT to overwrite, surfaced together — the admin can
  // see at a glance where a team and its registration disagree.
  const preserved = [...plan.toUpdate, ...plan.toSkip]
    .filter(i => i.preserved?.length)
    .map(i => ({ teamId: i.teamId, teamName: i.teamName, preserved: i.preserved }));

  return {
    created: created.length,
    updated: updated.length,
    skipped: plan.toSkip.length,
    errors: errors.length,
    preservedCount: preserved.length,
    details: { created, updated, skipped: plan.toSkip, errors, preserved },
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
    normalizedEmail: normalizeEmail(p.email),
    normalizedPhone: normalizePhone(p.phone),
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
