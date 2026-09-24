// netlify/functions/lib/roster-diff.js
//
// Turn "here is the whole roster again" into an audit trail a human can read.
//
// Both roster editors (admin-teams PUT and captain-roster PUT) send the entire
// roster array on every save, even when one field on one player changed. The
// log used to record that as "Roster replaced (15 players)" with no clue what
// changed — useless when auditing. This diffs the stored roster against the
// saved one and emits ONE event per real change:
//
//   player.added      "Marta Loj added (martusdanus@gmail.com)"
//   player.removed    "Lee Cox removed"
//   player.edited     "Emanuel Escamilla: email a@x → b@y · phone updated"
//   roster.saved      "Roster saved — no changes (15 players)"   (only when nothing changed)
//
// Role flips (captain / co-captain / sub) that come through a roster save are
// reported as edits too; the dedicated set-captain / set-sub endpoints keep
// their own events.

import { logActivity } from './activity-log.js';
import { normalizeEmail, normalizePhone } from './identity.js';

const norm = v => String(v ?? '').trim();

function roleOf(p) {
  if (p?.isCaptain) return 'captain';
  if (p?.isCoCaptain) return 'co-captain';
  if (p?.isSub) return 'sub';
  return 'player';
}

/** Compare two roster arrays by player id. */
export function diffRosters(prevRoster, nextRoster) {
  const prev = new Map((prevRoster || []).filter(p => p && p.id).map(p => [p.id, p]));
  const next = new Map((nextRoster || []).filter(p => p && p.id).map(p => [p.id, p]));

  const added = [], removed = [], edited = [];

  for (const [id, p] of next) {
    const was = prev.get(id);
    if (!was) { added.push(p); continue; }

    const changes = [];
    if (norm(was.name) !== norm(p.name)) changes.push(`name "${norm(was.name)}" → "${norm(p.name)}"`);
    if ((normalizeEmail(was.email) || '') !== (normalizeEmail(p.email) || '')) {
      changes.push(`email ${norm(was.email) || '(none)'} → ${norm(p.email) || '(none)'}`);
    }
    if ((normalizePhone(was.phone) || '') !== (normalizePhone(p.phone) || '')) changes.push('phone updated');
    if (norm(was.gender) !== norm(p.gender)) changes.push(`gender ${norm(was.gender) || '—'} → ${norm(p.gender) || '—'}`);
    if (norm(was.dupr) !== norm(p.dupr)) changes.push(`DUPR ${norm(was.dupr) || '—'} → ${norm(p.dupr) || '—'}`);
    if (roleOf(was) !== roleOf(p)) changes.push(`role ${roleOf(was)} → ${roleOf(p)}`);
    if (!!was.archived !== !!p.archived) changes.push(p.archived ? 'archived' : 'restored');
    if (!!was.pendingAdd !== !!p.pendingAdd) changes.push(p.pendingAdd ? 'sent for approval' : 'approved');

    if (changes.length) edited.push({ player: p, changes });
  }
  for (const [id, p] of prev) if (!next.has(id)) removed.push(p);

  return { added, removed, edited, unchanged: !added.length && !removed.length && !edited.length };
}

/**
 * Write the diff to the activity log. Never throws (logActivity swallows).
 * `pendingIds` — players on `added` who are only REQUESTED (captain add
 * awaiting league approval) are logged as roster.add.requested instead.
 *
 * @param {{ actor:{email:string, role:string}, team:object,
 *           prevRoster:object[], nextRoster:object[], pendingIds?:Set<string> }} opts
 * @returns {Promise<ReturnType<typeof diffRosters>>}
 */
export async function logRosterChanges({ actor, team, prevRoster, nextRoster, pendingIds }) {
  const diff = diffRosters(prevRoster, nextRoster);
  const pending = pendingIds || new Set();
  const who = p => norm(p.name) || 'Unnamed player';
  const mail = p => (norm(p.email) ? ` (${norm(p.email)})` : '');

  const events = [];
  for (const p of diff.added) {
    const requested = pending.has(p.id) || !!p.pendingAdd;
    events.push({
      type: requested ? 'roster.add.requested' : 'player.added',
      player: { id: p.id, name: p.name },
      details: requested
        ? `${who(p)} requested for ${team.name}${mail(p)} — awaiting league approval`
        : `${who(p)} added to ${team.name}${mail(p)}`,
    });
  }
  for (const p of diff.removed) {
    events.push({ type: 'player.removed', player: { id: p.id, name: p.name }, details: `${who(p)} removed from ${team.name}${mail(p)}` });
  }
  for (const { player: p, changes } of diff.edited) {
    events.push({ type: 'player.edited', player: { id: p.id, name: p.name }, details: `${who(p)}: ${changes.join(' · ')}` });
  }
  if (diff.unchanged) {
    events.push({ type: 'roster.saved', details: `Roster saved — no changes (${(nextRoster || []).length} players)` });
  }

  for (const evt of events) {
    await logActivity({ ...evt, actor, team }).catch(() => {});
  }
  return diff;
}
