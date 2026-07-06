// netlify/functions/lib/availability-reminders.js
//
// Automatic + manual availability reminders.
//
// Goal: get players to mark themselves in/out. NOT a lineup gate — everyone stays
// eligible whether or not they reply. A regular rostered player who hasn't
// responded gets a one-tap email 4 days before the match, then once per day until
// they confirm (in or out) or the lineup locks. SUBS are excluded from the
// automatic reminders — captains nudge them manually only when needed.
//
// Idempotency: one marker per player per LA calendar day, stored in the
// 'availability' store under reminder/<matchId>/<teamId>.json. Manual "nudge"
// sends bypass the day/window gates but still record the marker so the cron won't
// double-send the same day.

import { getStore } from '@netlify/blobs';
import { circuitCode } from './circuit.js';
import { getTeamAvailability } from './availability.js';
import { hardLockTime, DEFAULT_LOCK_OFFSET_MIN } from './lineup-helpers.js';
import { signAvailabilityToken } from './availability-token.js';
import { sendEmail, renderAvailabilityReminder } from './email.js';

const TZ = 'America/Los_Angeles';
const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;

function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.netlify.app';
}

// 'YYYY-MM-DD' in LA time — the idempotency key for "once per day".
function laDateKey(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
// Hour 0–23 in LA time — used to keep sends to daytime.
function laHour(d) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(d)) % 24;
}

const remStore = () => getStore({ name: 'availability', consistency: 'strong' });
const remKey = (matchId, teamId) => `reminder/${matchId}/${teamId}.json`;

async function getReminderRec(matchId, teamId) {
  const rec = await remStore().get(remKey(matchId, teamId), { type: 'json' }).catch(() => null);
  return rec && rec.players ? rec : { matchId, teamId, players: {} };
}
async function markReminded(matchId, teamId, playerId, when) {
  const rec = await getReminderRec(matchId, teamId);
  const entry = rec.players[playerId] || { dates: {} };
  entry.lastSentAt = when.toISOString();
  entry.dates = entry.dates || {};
  entry.dates[laDateKey(when)] = when.toISOString();
  rec.players[playerId] = entry;
  rec.updatedAt = when.toISOString();
  await remStore().setJSON(remKey(matchId, teamId), rec);
}

// Public: last-reminded info for a team's match, so the captain view can show
// "reminded 4h ago". Returns { <playerId>: lastSentAt(iso) }.
export async function getReminderStatus(matchId, teamId) {
  const rec = await getReminderRec(matchId, teamId);
  const out = {};
  for (const [pid, v] of Object.entries(rec.players || {})) out[pid] = v.lastSentAt || null;
  return out;
}

function buildDateLine(match) {
  const parts = [`Week ${match.week}`];
  if (match.scheduledAt) {
    const d = new Date(match.scheduledAt);
    if (!isNaN(d)) parts.push(d.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ,
    }));
  }
  if (match.court) parts.push(match.court);
  return parts.join(' · ');
}
function buildLockLine(lockAt) {
  if (!lockAt) return '';
  const d = new Date(lockAt);
  if (isNaN(d)) return '';
  return 'Lineup locks ' + d.toLocaleString('en-US', {
    weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: TZ,
  }) + '.';
}

// Send one reminder to one player and record the marker. Returns true if sent.
async function sendOneReminder({ team, match, player, opponent, oppEmoji, lockAt, when }) {
  const to = (player.email || '').trim();
  if (!to) return false;
  const inUrl = `${siteUrl()}/.netlify/functions/availability-confirm?t=` +
    encodeURIComponent(signAvailabilityToken({ matchId: match.id, teamId: team.id, playerId: player.id, status: 'in' }));
  const outUrl = `${siteUrl()}/.netlify/functions/availability-confirm?t=` +
    encodeURIComponent(signAvailabilityToken({ matchId: match.id, teamId: team.id, playerId: player.id, status: 'out' }));
  const html = renderAvailabilityReminder({
    playerName: player.name, teamName: team.name, teamEmoji: team.emoji || '',
    opponentName: opponent?.name || 'your opponent', oppEmoji: oppEmoji || '',
    week: match.week, dateLine: buildDateLine(match), lockLine: buildLockLine(lockAt),
    inUrl, outUrl,
  });
  await sendEmail({ to, subject: `Confirm your availability — Week ${match.week}`, html });
  await markReminded(match.id, team.id, player.id, when);
  return true;
}

// Resolve opponent + emoji + season lineup-lock offset for a match/team.
async function matchContext(match, team, teamCache) {
  const isA = match.teamA?.id === team.id;
  const opponent = isA ? match.teamB : match.teamA;
  let oppEmoji = '';
  if (opponent?.id) {
    const ot = await loadTeam(opponent.id, teamCache);
    oppEmoji = ot?.emoji || '';
  }
  let lockOffset = DEFAULT_LOCK_OFFSET_MIN;
  if (team.seasonId) {
    const season = await getStore('seasons').get(team.seasonId, { type: 'json' }).catch(() => null);
    if (season && Number(season.lineupLockOffsetMin)) lockOffset = Number(season.lineupLockOffsetMin);
  }
  const lockAt = hardLockTime(match.scheduledAt, lockOffset);
  return { opponent, oppEmoji, lockAt };
}

async function loadTeam(id, cache) {
  if (cache && cache.has(id)) return cache.get(id);
  const t = await getStore('teams').get(`team/${id}.json`, { type: 'json' }).catch(() => null);
  if (cache) cache.set(id, t);
  return t;
}

// Players eligible for an AUTO reminder: active, not a sub, has an email, and has
// not responded yet (no availability record).
function autoTargets(team, availRec) {
  const responded = availRec.players || {};
  return (team.roster || []).filter(p =>
    !p.archived && !p.isSub && (p.email || '').trim() && !responded[p.id]);
}

/**
 * Automatic path (cron). Send any due reminders for one team in one match.
 * Returns the number of emails sent.
 */
async function remindTeamAuto({ match, team, teamCache, now }) {
  if (match.finalizedAt) return 0;
  const startMs = match.scheduledAt ? new Date(match.scheduledAt).getTime() : NaN;
  if (isNaN(startMs) || now.getTime() >= startMs) return 0;          // no time / already started
  if (now.getTime() < startMs - FOUR_DAYS_MS) return 0;              // more than 4 days out
  const h = laHour(now);
  if (h < 8 || h >= 21) return 0;                                    // daytime only

  const { opponent, oppEmoji, lockAt } = await matchContext(match, team, teamCache);
  if (lockAt && now.getTime() >= new Date(lockAt).getTime()) return 0; // lineup locked → stop

  const availRec = await getTeamAvailability(match.id, team.id);
  const remRec = await getReminderRec(match.id, team.id);
  const today = laDateKey(now);
  let sent = 0;
  for (const player of autoTargets(team, availRec)) {
    if (remRec.players?.[player.id]?.dates?.[today]) continue;       // already sent today
    try { if (await sendOneReminder({ team, match, player, opponent, oppEmoji, lockAt, when: now })) sent++; }
    catch (e) { console.warn('availability reminder send failed:', e?.message || e); }
  }
  return sent;
}

/**
 * Cron entry: scan every upcoming match in a circuit and fire due reminders.
 * Returns a small summary array for logging.
 */
export async function runDueAvailabilityReminders(circuit = 'I') {
  const code = circuitCode(circuit);
  const scheduleStore = getStore('schedule');
  const teamCache = new Map();
  const now = new Date();
  const summary = [];
  const { blobs } = await scheduleStore.list({ prefix: `schedule/${code}/` });
  for (const b of blobs) {
    const data = await scheduleStore.get(b.key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    const wk = data.week || parseInt((b.key.match(/week-(\d+)\.json$/) || [])[1], 10) || null;
    for (const m of data.matches) {
      const match = { ...m, week: m.week || wk };
      for (const side of [match.teamA, match.teamB]) {
        if (!side?.id) continue;
        const team = await loadTeam(side.id, teamCache);
        if (!team) continue;
        const sent = await remindTeamAuto({ match, team, teamCache, now }).catch(() => 0);
        if (sent) summary.push({ match: match.id, team: team.name, sent });
      }
    }
  }
  return summary;
}

/**
 * Manual "nudge" (captain). Send immediately, bypassing the day/window gates.
 * - playerIds omitted → all unconfirmed regular (non-sub) players with an email.
 * - playerIds given   → exactly those players (may include subs), if unconfirmed
 *   and reachable. Returns { sent, skipped, noEmail }.
 */
export async function nudgeTeam({ team, match, playerIds }) {
  const now = new Date();
  const teamCache = new Map();
  const { opponent, oppEmoji, lockAt } = await matchContext(match, team, teamCache);
  const availRec = await getTeamAvailability(match.id, team.id);
  const responded = availRec.players || {};

  let targets;
  if (Array.isArray(playerIds) && playerIds.length) {
    const wanted = new Set(playerIds);
    targets = (team.roster || []).filter(p => !p.archived && wanted.has(p.id) && !responded[p.id]);
  } else {
    targets = autoTargets(team, availRec); // regular non-sub, unconfirmed, has email
  }

  let sent = 0, skipped = 0, noEmail = 0;
  for (const player of targets) {
    if (!(player.email || '').trim()) { noEmail++; continue; }
    try {
      if (await sendOneReminder({ team, match, player, opponent, oppEmoji, lockAt, when: now })) sent++;
      else skipped++;
    } catch (e) { console.warn('nudge send failed:', e?.message || e); skipped++; }
  }
  return { sent, skipped, noEmail };
}
