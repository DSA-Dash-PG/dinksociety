// netlify/functions/lib/night-recap.js
//
// The I/O half of the league "morning-after" email (the Receipt): loads a week
// from the blobs, hands it to the pure builder (lib/night-recap-data.js) and the
// renderer (lib/night-recap-email.js), and owns sending + the ledger.
//
// WHO GETS IT: every player who played at least one completed game in the week,
// one email per person. WHEN: the morning after the night, once every match of
// the week is finalized (dueWeek() in night-recap-data.js has the exact rule).
//
// IT SENDS WITHOUT A HUMAN LOOK — that is the design (Richard, 2026-10-09). The
// guards that stand in for a review:
//   • a week is mailed at most once: state/<circuit>/week-<n>.json goes
//     queued → sending → sent, and a finished week is never reopened by the cron;
//   • each person is mailed at most once per week: sent/<circuit>/week-<n>/<id>.json
//     is written the moment their email is accepted, so a crashed or retried run
//     picks up where it stopped instead of starting over;
//   • a player whose numbers can't be found is skipped and reported, never sent
//     a zeroed-out email (the ladder recap learned that one the hard way);
//   • auto-send only covers nights played AFTER it was switched on, so turning
//     it on (or deploying it) never back-mails an old week.
//
// Opt-outs: every send goes through sendNotify({ category: 'recap' }) — the
// existing "Post-night recap" preference — which also adds the manage /
// unsubscribe footer and List-Unsubscribe headers.
//
// Blob store `night-recap` (strong consistency):
//   config/settings.json                       { autoSend, since, updatedAt, updatedBy }
//   state/<circuit>/week-<n>.json               progress + result of one week's send
//   sent/<circuit>/week-<n>/<personId>.json     one marker per person mailed

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { circuitCode } from './circuit.js';
import { normalizeScore } from './score-helpers.js';
import { normalizeEmail } from './identity.js';
import { listRosterEntries, getIdentityMap, groupEntries } from './league-identity.js';
import { isActivePlayer } from './roster.js';
import { getTeamAvailability } from './availability.js';
import { signAvailabilityToken } from './availability-token.js';
import { sendNotify } from './notify-prefs.js';
import { sendEmail } from './email.js';
import { recordSend } from './recap-tracking.js';
import { liveCircuit } from './current-season.js';
import { buildNightModels, matchGames, dueWeek } from './night-recap-data.js';
import { renderNightRecapEmail } from './night-recap-email.js';

const STORE = 'night-recap';
const store = () => getStore({ name: STORE, consistency: 'strong' });
const stateKey = (code, week) => `state/${code}/week-${Number(week)}.json`;
const sentPrefix = (code, week) => `sent/${code}/week-${Number(week)}/`;
const sentKey = (code, week, personId) => `${sentPrefix(code, week)}${encodeURIComponent(personId)}.json`;
const SETTINGS_KEY = 'config/settings.json';

// Auto-send is ON by default (that is the whole point), but it only applies to
// nights played after this moment — so the deploy itself mails nobody for a
// week that was already in the books. Switching auto-send off and on again in
// the admin panel moves the line to that moment.
const DEFAULT_SINCE = '2026-10-10T07:00:00.000Z';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.app';
}

// ── settings + state ───────────────────────────────────────────────────────
export async function getSettings() {
  const s = await store().get(SETTINGS_KEY, { type: 'json' }).catch(() => null);
  return { autoSend: true, since: DEFAULT_SINCE, ...(s || {}) };
}

export async function setAutoSend(enabled, who = null) {
  const cur = await getSettings();
  const next = { ...cur, autoSend: !!enabled, updatedAt: new Date().toISOString(), updatedBy: who };
  // Turning it back on starts the clock fresh: nights before now stay unsent.
  if (enabled && !cur.autoSend) next.since = new Date().toISOString();
  await store().setJSON(SETTINGS_KEY, next);
  return next;
}

export async function getState(code, week) {
  return store().get(stateKey(code, week), { type: 'json' }).catch(() => null);
}
async function saveState(code, week, rec) {
  await store().setJSON(stateKey(code, week), { ...rec, circuit: code, week: Number(week), updatedAt: new Date().toISOString() });
}

export async function listStates(code) {
  const s = store();
  const { blobs } = await s.list({ prefix: `state/${code}/` }).catch(() => ({ blobs: [] }));
  const recs = (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' }).catch(() => null)))).filter(Boolean);
  return recs.sort((a, b) => (b.week || 0) - (a.week || 0));
}

async function sentIds(code, week) {
  const { blobs } = await store().list({ prefix: sentPrefix(code, week) }).catch(() => ({ blobs: [] }));
  return new Set(blobs.map(b => decodeURIComponent(b.key.slice(sentPrefix(code, week).length).replace(/\.json$/, ''))));
}

// ── loading ────────────────────────────────────────────────────────────────

/** Every match of a circuit (finalized or not), flattened, plus bye weeks. */
export async function loadSeasonMatches(circuit) {
  const code = circuitCode(circuit);
  // Strong reads: finalize writes these moments before anything reads them back.
  const sched = getStore({ name: 'schedule', consistency: 'strong' });
  const { blobs } = await sched.list({ prefix: `schedule/${code}/` }).catch(() => ({ blobs: [] }));
  const matches = [], byesByWeek = {};
  for (const b of blobs) {
    const data = await sched.get(b.key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    const week = Number(data.week) || parseInt((b.key.match(/week-(\d+)\.json$/) || [])[1], 10) || null;
    if (week == null) continue;
    for (const m of data.matches) matches.push({ ...m, week, division: data.division });
    const playing = new Set(data.matches.flatMap(m => [m.teamA?.id, m.teamB?.id]).filter(Boolean));
    const byes = (data.byes || []).map(t => t?.id).filter(id => id && !playing.has(id));
    if (byes.length) byesByWeek[week] = (byesByWeek[week] || []).concat(byes);
  }
  return { code, matches, byesByWeek };
}

// Every team record, keyed by id. Not filtered by season: team ids are unique,
// and a team's `circuit` field has held a code, a season id and a display name
// at different times — the schedule's team ids are the reliable join.
async function loadTeams() {
  const teams = getStore({ name: 'teams', consistency: 'strong' });
  const { blobs } = await teams.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));
  const all = await Promise.all(blobs.map(b => teams.get(b.key, { type: 'json' }).catch(() => null)));
  const byId = new Map();
  for (const t of all) if (t?.id) byId.set(t.id, t);
  return byId;
}

/**
 * Build every player's model for one week.
 * @returns {Promise<{ ok:boolean, reason?:string, code, week, models:object[], teamsById:Map, date }>}
 */
export async function loadWeek(circuit, week) {
  const { code, matches, byesByWeek } = await loadSeasonMatches(circuit);
  const wk = Number(week);
  const weekFinal = matches.filter(m => m.week === wk && m.finalizedAt && m.teamA?.id && m.teamB?.id);
  if (!weekFinal.length) return { ok: false, reason: 'no finalized matches in that week', code, week: wk, models: [] };

  const teamsById = await loadTeams();
  const lineups = getStore({ name: 'lineups', consistency: 'strong' });
  const scores = getStore({ name: 'scores', consistency: 'strong' });

  const weekMatches = [];
  for (const match of weekFinal) {
    const [lineupA, lineupB, score] = await Promise.all([
      lineups.get(`lineup/${match.id}/${match.teamA.id}.json`, { type: 'json' }).catch(() => null),
      lineups.get(`lineup/${match.id}/${match.teamB.id}.json`, { type: 'json' }).catch(() => null),
      scores.get(`score/${match.id}.json`, { type: 'json' }).catch(() => null),
    ]);
    if (!lineupA || !lineupB || !score?.games) continue;
    normalizeScore(score, !!match.championship);
    const names = new Map();
    for (const t of [teamsById.get(match.teamA.id), teamsById.get(match.teamB.id)]) {
      for (const p of t?.roster || []) if (p?.id) names.set(p.id, p.name);
    }
    const games = matchGames({ lineupA, lineupB, score, nameOf: id => names.get(id) || null });
    if (games.length) weekMatches.push({ match, games });
  }
  if (!weekMatches.length) return { ok: false, reason: 'no completed games found for that week', code, week: wk, models: [] };

  const [playerStats, standings] = await Promise.all([
    getStore({ name: 'player-stats', consistency: 'strong' }).get(`player-stats/${code}.json`, { type: 'json' }).catch(() => null),
    getStore({ name: 'standings', consistency: 'strong' }).get(`standings/${code}.json`, { type: 'json' }).catch(() => null),
  ]);
  if (!playerStats?.players) return { ok: false, reason: 'player stats have not been built for this season', code, week: wk, models: [] };
  const performers = (standings?.weeklyTopPerformers || []).find(e => Number(e.week) === wk) || null;

  const { models, date } = buildNightModels({
    circuit: code, week: wk, weekMatches, seasonMatches: matches, byesByWeek,
    playerStats, performers, teamsById,
  });
  return { ok: true, code, week: wk, models, teamsById, date };
}

/**
 * Who is who, and where to reach them. Reads `normalizedEmail` first, then raw
 * `email`; a roster entry with neither falls back to any other entry the
 * identity layer says is the same person (their Season 1 entry, a linked id) —
 * the same rule admin-drop.js uses, for the same reason: Season 2 entries added
 * through the picker carry no address of their own.
 */
async function identityAndEmails() {
  const emailById = new Map();
  let personOf = (id) => id, idsFor = (id) => [id];
  try {
    const [entries, map] = await Promise.all([listRosterEntries(), getIdentityMap()]);
    for (const e of entries) {
      const em = e.normalizedEmail || normalizeEmail(e.email);
      if (em && EMAIL_RE.test(em)) emailById.set(e.id, em);
    }
    const { canonicalOf, membersOf } = groupEntries(entries, map);
    personOf = (id) => canonicalOf[id] || id;
    idsFor = (id) => { const c = canonicalOf[id]; return c ? (membersOf[c] || [id]) : [id]; };
  } catch (e) {
    console.error('[night-recap] identity lookup failed, using roster emails only:', e?.message || e);
  }
  const emailOf = (rosterEntry, playerId) => {
    const direct = rosterEntry && (rosterEntry.normalizedEmail || normalizeEmail(rosterEntry.email));
    if (direct && EMAIL_RE.test(direct)) return direct;
    for (const id of idsFor(playerId)) { const em = emailById.get(id); if (em) return em; }
    return null;
  };
  return { personOf, emailOf };
}

/**
 * The per-recipient extras: the one-tap in/out links for next week and what the
 * player has already answered. `live:false` (admin preview + test sends) points
 * the buttons at the portal instead, so looking at someone's email can never
 * record an answer for them.
 */
async function extrasFor(model, teamsById, availCache, { live = true } = {}) {
  const site = siteUrl().replace(/\/$/, '');
  const x = { site, inUrl: null, outUrl: null, availability: null };
  const nx = model.next;
  if (!nx || nx.bye || !nx.matchId) return x;
  const started = nx.scheduledAt && Date.now() >= new Date(nx.scheduledAt).getTime();
  const entry = (teamsById.get(model.teamId)?.roster || []).find(p => p.id === model.playerId);
  if (started || !entry || !isActivePlayer(entry)) return x;

  if (!live) {
    x.inUrl = x.outUrl = `${site}/me`;
  } else {
    const link = (status) => `${site}/.netlify/functions/availability-confirm?t=` +
      encodeURIComponent(signAvailabilityToken({ matchId: nx.matchId, teamId: model.teamId, playerId: model.playerId, status }));
    x.inUrl = link('in'); x.outUrl = link('out');
  }
  const key = `${nx.matchId}|${model.teamId}`;
  if (!availCache.has(key)) availCache.set(key, await getTeamAvailability(nx.matchId, model.teamId).catch(() => ({ players: {} })));
  const status = availCache.get(key).players?.[model.playerId]?.status;
  x.availability = status === 'in' || status === 'out' ? status : null;
  return x;
}

// ── admin: who played, preview, test ───────────────────────────────────────

/** Everyone who would be mailed for a week, with their status. */
export async function listWeekPlayers(circuit, week) {
  const wk = await loadWeek(circuit, week);
  if (!wk.ok) return { ok: false, reason: wk.reason, players: [] };
  const [{ personOf, emailOf }, sent] = await Promise.all([identityAndEmails(), sentIds(wk.code, wk.week)]);
  const players = wk.models.map(m => {
    const entry = (wk.teamsById.get(m.teamId)?.roster || []).find(p => p.id === m.playerId);
    return {
      playerId: m.playerId, name: m.name, teamName: m.teamName,
      record: `${m.night.w}-${m.night.l}`,
      hasEmail: !!emailOf(entry, m.playerId),
      sent: sent.has(personOf(m.playerId)),
    };
  });
  return { ok: true, week: wk.week, players };
}

/** Render one player's email exactly as it would send (buttons made inert). */
export async function previewFor(circuit, week, playerId) {
  const wk = await loadWeek(circuit, week);
  if (!wk.ok) return { ok: false, reason: wk.reason };
  const model = wk.models.find(m => m.playerId === playerId);
  if (!model) return { ok: false, reason: 'that player did not play in this week' };
  const x = await extrasFor(model, wk.teamsById, new Map(), { live: false });
  const { subject, html } = renderNightRecapEmail(model, x);
  return { ok: true, subject, html, name: model.name, preheader: model.preheader };
}

/** Send one player's version to an admin address. Never touches the ledger. */
export async function sendTest(circuit, week, playerId, to) {
  const addr = normalizeEmail(to);
  if (!addr || !EMAIL_RE.test(addr)) return { ok: false, reason: 'no address to send the test to' };
  const pv = await previewFor(circuit, week, playerId);
  if (!pv.ok) return pv;
  await sendEmail({ to: addr, subject: `[Test] ${pv.subject}`, html: pv.html });
  return { ok: true, to: addr, name: pv.name };
}

// ── sending ────────────────────────────────────────────────────────────────

/** A fresh one-time token the cron hands the background sender. */
function newKick() { return crypto.randomBytes(24).toString('hex'); }

/** Constant-time compare of a kick token against the one pinned on the state. */
export function kickMatches(given, want) {
  const a = String(given || ''), b = String(want || '');
  if (b.length < 32 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const STUCK_MS = 20 * 60 * 1000; // a background run gets 15 minutes

/**
 * Mark a week queued and hand back the one-time kick for the background sender.
 * Refuses a week that is already sent, or one that is mid-send and not stuck.
 */
export async function queueWeek(circuit, week, { by = 'cron', force = false } = {}) {
  const code = circuitCode(circuit);
  const cur = await getState(code, week);
  if (cur?.status === 'sent' && !force) return { ok: false, reason: 'already sent' };
  const age = cur?.updatedAt ? Date.now() - new Date(cur.updatedAt).getTime() : Infinity;
  if ((cur?.status === 'queued' || cur?.status === 'sending') && age < STUCK_MS) return { ok: false, reason: `already ${cur.status}` };
  const kickToken = newKick();
  await saveState(code, week, {
    ...(cur || {}), status: 'queued', kickToken, queuedAt: new Date().toISOString(), queuedBy: by,
  });
  return { ok: true, code, week: Number(week), kickToken };
}

/**
 * Send a week to everyone who played and has not had it yet. Runs inside the
 * background function (up to 15 minutes); safe to run again after a crash.
 */
export async function sendWeek(circuit, week, { by = 'cron' } = {}) {
  const code = circuitCode(circuit);
  const cur = (await getState(code, week)) || {};
  if (cur.status === 'sent') return { ok: true, skipped: true, reason: 'already sent' };
  await saveState(code, week, { ...cur, status: 'sending', kickToken: null, startedAt: new Date().toISOString(), startedBy: by });

  const wk = await loadWeek(code, week);
  if (!wk.ok) {
    await saveState(code, week, { ...cur, status: 'failed', kickToken: null, error: wk.reason });
    return { ok: false, reason: wk.reason };
  }
  const [{ personOf, emailOf }, already] = await Promise.all([identityAndEmails(), sentIds(code, wk.week)]);
  const availCache = new Map();
  const eventId = `league-${code}-week-${wk.week}`;

  let sent = 0, optedOut = 0;
  const noEmail = [], failed = [], seen = new Set();
  const progress = () => saveState(code, week, {
    ...cur, status: 'sending', kickToken: null, total: wk.models.length,
    sent: sent + already.size, optedOut, noEmail, failed,
  }).catch(e => console.error('[night-recap] progress save failed:', e?.message || e));

  for (const model of wk.models) {
    const person = personOf(model.playerId);
    // One email per person per week — across a crashed run (the ledger) and
    // across two roster entries for the same human (seen).
    if (already.has(person) || seen.has(person)) continue;
    seen.add(person);

    const entry = (wk.teamsById.get(model.teamId)?.roster || []).find(p => p.id === model.playerId);
    const to = emailOf(entry, model.playerId);
    if (!to) { noEmail.push(`${model.name} (${model.teamName})`); continue; }

    let res = null, err = null;
    try {
      const x = await extrasFor(model, wk.teamsById, availCache, { live: true });
      const { subject, html } = renderNightRecapEmail(model, x);
      // Resend allows ~2 requests/second; back off and retry on a rate limit.
      for (let attempt = 0; attempt < 3; attempt++) {
        try { res = await sendNotify({ to, category: 'recap', subject, html }); err = null; break; }
        catch (e) {
          err = e;
          if (/rate|429|too many/i.test(String(e?.message || e)) && attempt < 2) { await sleep(1500); continue; }
          break;
        }
      }
    } catch (e) { err = e; }

    if (err) {
      failed.push({ name: model.name, reason: String(err?.message || err).slice(0, 160) });
      console.error('[night-recap] send failed:', model.name, err?.message || err);
    } else if (res?.skipped) {
      optedOut++;
      // An opt-out is an answer, not a failure: mark it so a re-run stays quiet.
      await store().setJSON(sentKey(code, wk.week, person), { optedOut: true, at: new Date().toISOString() }).catch(() => {});
      continue; // no Resend call happened — no need to pace
    } else {
      sent++;
      const messageId = res?.data?.id || res?.id || null;
      await store().setJSON(sentKey(code, wk.week, person), { to, playerId: model.playerId, messageId, at: new Date().toISOString() })
        .catch(e => console.error('[night-recap] ledger write failed:', e?.message || e));
      if (messageId) {
        await recordSend({ messageId, eventId, playerId: model.playerId, name: model.name, email: to, category: 'night-recap' }).catch(() => {});
      }
    }
    if ((sent + failed.length) % 5 === 0) await progress();
    await sleep(550);
  }

  const result = {
    status: 'sent', kickToken: null, total: wk.models.length,
    sent: sent + [...already].length, sentThisRun: sent, optedOut, noEmail, failed,
    finishedAt: new Date().toISOString(),
  };
  await saveState(code, week, { ...cur, ...result, startedAt: cur.startedAt || null });
  console.log(`[night-recap] ${code} week ${wk.week}: sent ${sent}, opted out ${optedOut}, no email ${noEmail.length}, failed ${failed.length}`);
  return { ok: true, week: wk.week, ...result };
}

/** POST the background sender. Returns true when Netlify accepted the job. */
export async function kickBackground({ code, week, kickToken, cookie = '' }) {
  const r = await fetch(`${siteUrl().replace(/\/$/, '')}/.netlify/functions/night-recap-send-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(kickToken ? { 'x-night-recap-kick': kickToken } : {}) },
    body: JSON.stringify({ circuit: code, week }),
  });
  return r.status === 202 || r.ok;
}

/**
 * The cron entry. Cheap when nothing is due: one schedule listing and at most
 * two small reads.
 */
export async function runDue(now = new Date()) {
  const settings = await getSettings();
  if (!settings.autoSend) return { ok: true, sent: false, reason: 'auto-send is off' };
  const circuit = await liveCircuit(now.getTime());
  const { code, matches } = await loadSeasonMatches(circuit);
  const due = dueWeek(matches, now);
  if (!due.due) return { ok: true, sent: false, circuit: code, week: due.week, reason: due.reason };
  if (settings.since && new Date(due.nightAt) < new Date(settings.since)) {
    return { ok: true, sent: false, circuit: code, week: due.week, reason: 'night was played before auto-send was switched on' };
  }
  const q = await queueWeek(code, due.week, { by: 'cron' });
  if (!q.ok) return { ok: true, sent: false, circuit: code, week: due.week, reason: q.reason };
  const kicked = await kickBackground(q).catch(e => { console.error('[night-recap] kick failed:', e?.message || e); return false; });
  return { ok: true, sent: kicked, circuit: code, week: due.week, reason: kicked ? 'queued' : 'background sender did not accept the job' };
}

/** What the admin panel shows for the live week. */
export async function statusFor(circuit, now = new Date()) {
  const { code, matches } = await loadSeasonMatches(circuit);
  const due = dueWeek(matches, now);
  const [settings, states] = await Promise.all([getSettings(), listStates(code)]);
  const strip = (s) => { const { kickToken, ...rest } = s; return rest; };
  return {
    circuit: code, settings,
    latestWeek: due.week, due: due.due, dueReason: due.reason, nightAt: due.nightAt || null,
    coveredByAutoSend: !!(due.nightAt && settings.autoSend && new Date(due.nightAt) >= new Date(settings.since)),
    weeks: states.map(strip),
  };
}
