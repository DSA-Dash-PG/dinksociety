// netlify/functions/ohana-save.js
// POST { action, ... } — manager edits on the private /ohana page.
//
//   addPlayer     { email, name }            add to the Ohana roster
//   removePlayer  { email }
//   setManager    { email, manager }
//   saveLineup    { matchId, slots:[{no, players:[email,email]}], notify }
//                   notify → first post emails everyone their games; later
//                   saves email only players whose games changed.
//   saveScores    { matchId, slots:[{no, us, them, opp:[a,b]}], notify }
//   editMatch     { matchId, date, time, courts, note, homeTeamId, awayTeamId, notify }
//                   notify → everyone on the roster gets the before → after.
//   saveResult    { matchId, home, away, notify }  final games won only — for
//                   other teams' matches (no stat sheet) or ours when we only
//                   have the final. Blank both to clear. Our game-by-game
//                   scores, when entered, always win over this.
//   message       { subject, text }           email the whole team
//

import { loadLeague, saveLeague, viewer, json, emailLineup, emailScheduleChange, emailResult, emailMessage } from './lib/ohana.js';
import {
  findMatch, normSlots, isOurs, lineupChangedFor, describeMatchChange, matchResult, slotScored,
} from './lib/ohana-core.js';
import { normalizeEmail } from './lib/identity.js';
import { isOwnerEmail } from './lib/owner.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clip = (s, n) => String(s ?? '').trim().slice(0, n);

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const league = await loadLeague();
  const v = await viewer(req, league);
  if (!v.signedIn) return json({ error: 'Sign in first' }, 401);
  if (!v.canEdit) return json({ error: 'Only team managers can edit' }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const who = v.entry?.name || v.email;
  const log = (what) => league.log.push({ at: new Date().toISOString(), by: v.email, what });
  const rosterSet = new Set(league.roster.map(p => p.email));
  const out = { ok: true };

  switch (body.action) {
    case 'addPlayer': {
      const email = normalizeEmail(body.email);
      const name = clip(body.name, 80);
      if (!email || !name) return json({ error: 'Name and email required' }, 400);
      if (rosterSet.has(email)) return json({ error: 'Already on the roster' }, 409);
      // The site owner is always a manager, so their own entry gets manager emails (lineup nudges).
      league.roster.push({ email, name, manager: isOwnerEmail(email), addedAt: new Date().toISOString() });
      league.roster.sort((a, b) => a.name.localeCompare(b.name));
      log(`added ${name}`);
      break;
    }
    case 'removePlayer': {
      const email = normalizeEmail(body.email);
      const p = league.roster.find(x => x.email === email);
      if (!p) return json({ error: 'Not on the roster' }, 404);
      league.roster = league.roster.filter(x => x.email !== email);
      log(`removed ${p.name}`);
      break;
    }
    case 'setManager': {
      const p = league.roster.find(x => x.email === normalizeEmail(body.email));
      if (!p) return json({ error: 'Not on the roster' }, 404);
      p.manager = !!body.manager;
      log(`${p.manager ? 'made' : 'removed'} ${p.name} ${p.manager ? 'a manager' : 'as manager'}`);
      break;
    }
    case 'saveLineup': {
      const hit = findMatch(league, body.matchId);
      if (!hit || !isOurs(league, hit.match)) return json({ error: 'Match not found' }, 404);
      const { week, match } = hit;
      const prev = normSlots(match.lineupSnapshot || [], league.gamesPerMatch);
      const incoming = normSlots(body.slots, league.gamesPerMatch);
      // Keep any scores already entered; only the pairings change here.
      const cur = normSlots(match.slots, league.gamesPerMatch);
      const next = incoming.map((s, i) => ({ ...cur[i], players: s.players.map(e => rosterSet.has(e) ? e : '') }));
      for (const s of next) if (s.players[0] && s.players[0] === s.players[1]) s.players[1] = '';
      match.slots = next;
      log(`lineup saved for ${week.label}`);
      if (body.notify) {
        const first = !match.lineupSentAt;
        const only = first ? null : lineupChangedFor(league, prev, next);
        if (first || only.length) {
          out.emailed = await emailLineup(league, week, match, { changed: !first, only });
        } else out.emailed = { sent: 0, note: 'No one’s games changed — no emails sent.' };
        match.lineupSentAt = new Date().toISOString();
        match.lineupSnapshot = next.map(s => ({ no: s.no, players: s.players }));
      }
      break;
    }
    case 'saveScores': {
      const hit = findMatch(league, body.matchId);
      if (!hit || !isOurs(league, hit.match)) return json({ error: 'Match not found' }, 404);
      const { week, match } = hit;
      const cur = normSlots(match.slots, league.gamesPerMatch);
      const incoming = normSlots(body.slots, league.gamesPerMatch);
      match.slots = cur.map((s, i) => ({ ...s, us: incoming[i].us, them: incoming[i].them, opp: incoming[i].opp }));
      log(`scores saved for ${week.label}`);
      const r = matchResult(league, match);
      if (body.notify && r && match.slots.some(slotScored)) out.emailed = await emailResult(league, week, match, r);
      break;
    }
    case 'saveResult': {
      const hit = findMatch(league, body.matchId);
      if (!hit) return json({ error: 'Match not found' }, 404);
      const { week, match } = hit;
      if (!match.home?.teamId || !match.away?.teamId) return json({ error: 'Set both teams first' }, 400);
      const blank = (x) => x === '' || x == null;
      if (blank(body.home) && blank(body.away)) { match.result = null; log(`cleared final for ${week.label} ${match.id}`); break; }
      const h = Number(body.home), a = Number(body.away);
      if (![h, a].every(n => Number.isInteger(n) && n >= 0 && n <= 30)) return json({ error: 'Enter games won for both teams' }, 400);
      match.result = { home: h, away: a };
      log(`final ${week.label}: ${h}-${a} (${match.id})`);
      if (isOurs(league, match) && match.slots?.some(slotScored)) out.note = 'Game-by-game scores are in for this match, so those count instead of this final.';
      else if (body.notify && isOurs(league, match)) out.emailed = await emailResult(league, week, match, match.result);
      break;
    }
    case 'editMatch': {
      const hit = findMatch(league, body.matchId);
      if (!hit) return json({ error: 'Match not found' }, 404);
      const { week, match } = hit;
      const before = JSON.parse(JSON.stringify(match));
      const wasOurs = isOurs(league, match);
      if (body.date !== undefined) {
        if (body.date && !DATE_RE.test(body.date)) return json({ error: 'Date must be YYYY-MM-DD' }, 400);
        match.date = body.date && body.date !== week.date ? body.date : undefined;
      }
      if (body.time !== undefined) match.time = clip(body.time, 20) || '7:00 PM';
      if (body.courts !== undefined) match.courts = clip(body.courts, 40);
      if (body.note !== undefined) match.note = clip(body.note, 140);
      const ids = new Set(league.teams.map(t => t.id));
      for (const k of ['home', 'away']) {
        const id = body[`${k}TeamId`];
        if (id === undefined) continue;
        match[k] = id && ids.has(id) ? { teamId: id, label: match[k]?.label || '' } : { teamId: null, label: match[k]?.label || 'TBD' };
      }
      if (match.home?.teamId && match.home.teamId === match.away?.teamId) return json({ error: 'A team can’t play itself' }, 400);
      const lines = describeMatchChange(league, before, match, week, week);
      if (lines.length) log(`${week.label} changed: ${lines.join('; ')}`);
      const nowOurs = isOurs(league, match);
      if (body.notify && lines.length && (wasOurs || nowOurs)) {
        out.emailed = await emailScheduleChange(league, week, match, lines);
      }
      out.changes = lines;
      break;
    }
    case 'message': {
      const text = clip(body.text, 4000);
      if (!text) return json({ error: 'Write a message first' }, 400);
      out.emailed = await emailMessage(league, who, clip(body.subject, 120), text);
      log(`emailed the team: ${clip(body.subject, 60) || '(no subject)'}`);
      break;
    }
    default:
      return json({ error: 'Unknown action' }, 400);
  }

  await saveLeague(league);
  return json(out);
};

export const config = { path: '/.netlify/functions/ohana-save' };
