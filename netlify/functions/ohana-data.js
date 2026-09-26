// netlify/functions/ohana-data.js
// GET → everything the private /ohana page renders, for the signed-in viewer.
//   401 { signedIn:false }                  — no Dink Society session
//   403 { signedIn:true, allowed:false }    — signed in, not on the Ohana roster
//   200 { me, league, weeks, stats, roster }
// Emails are only sent to managers (they need them to build the lineup);
// everyone else gets names.

import { loadLeague, viewer, json } from './lib/ohana.js';
import {
  teamName, ourSide, opponentOf, matchResult, matchDate, isByeWeek, computeStats, computeStandings, normSlots, slotScored, isOurs, laMs, lineupWarnings, byeTeams, publishedSlots, draftDirty, eligibility, TYPE_LABEL,
} from './lib/ohana-core.js';
import { DEFAULT_ANNOUNCEMENT } from './lib/ohana.js';

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const league = await loadLeague();
  const v = await viewer(req, league);
  if (!v.signedIn) return json({ signedIn: false }, 401);
  if (!v.allowed) return json({ signedIn: true, allowed: false, email: v.email }, 403);

  const nameOf = (e) => league.roster.find(p => p.email === e)?.name || '';
  const person = (e) => e ? (v.canEdit ? { email: e, name: nameOf(e) || e } : { name: nameOf(e) || 'Player', me: e === v.email }) : null;

  const weeks = league.weeks.map(wk => {
    const ours = wk.matches.find(m => isOurs(league, m)) || null;
    let match = null;
    if (ours) {
      const side = ourSide(league, ours);
      const r = matchResult(league, ours);
      // Managers work on the draft; everyone else only ever sees the finalized lineup.
      const slots = v.canEdit ? normSlots(ours.slots, league.gamesPerMatch) : publishedSlots(ours);
      match = {
        id: ours.id, date: matchDate(wk, ours), time: ours.time, courts: ours.courts, note: ours.note,
        side, opponent: teamName(league, opponentOf(league, ours)),
        startMs: laMs(matchDate(wk, ours), ours.time),
        result: r ? {
          us: side === 'home' ? r.home : r.away, them: side === 'home' ? r.away : r.home,
          ptsUs: side === 'home' ? r.ptsHome : r.ptsAway, ptsThem: side === 'home' ? r.ptsAway : r.ptsHome,
          rounds: r.rounds.map(x => ({ us: side === 'home' ? x.home : x.away, them: side === 'home' ? x.away : x.home })),
        } : null,
        warnings: v.canEdit ? lineupWarnings(league, ours.slots) : [],
        // true when we have game-by-game scores; false = final score only (no stat sheet)
        detailed: (ours.slots || []).some(slotScored),
        lineupSentAt: ours.lineupSentAt || null,
        finalizedAt: ours.lineupSnapshot ? (ours.lineupSentAt || null) : null,
        draftDirty: v.canEdit ? draftDirty(ours) : false,
        slots: slots.map(s => ({ no: s.no, round: s.round, type: s.type, typeLabel: TYPE_LABEL[s.type], players: s.players.map(person), opp: s.opp, us: s.us, them: s.them })),
      };
    }
    return {
      id: wk.id, label: wk.label, date: wk.date, type: wk.type, note: wk.note,
      bye: isByeWeek(league, wk), byes: byeTeams(league, wk), match,
      others: wk.matches.filter(m => m !== ours).map(m => ({
        id: m.id, home: teamName(league, m.home), away: teamName(league, m.away),
        homeId: m.home?.teamId || null, awayId: m.away?.teamId || null, courts: m.courts, note: m.note,
        result: matchResult(league, m),
      })),
    };
  });

  const stats = computeStats(league);
  if (!v.canEdit) {
    for (const p of stats.players) { delete p.email; for (const q of p.partners) delete q.email; }
  }

  const elig = eligibility(league);
  return json({
    signedIn: true, allowed: true,
    me: { name: v.entry?.name || '', email: v.email, canEdit: v.canEdit, owner: v.owner, onRoster: !!v.entry },
    league: { name: league.name, venue: league.venue, night: league.night, teams: league.teams, ourTeamId: league.ourTeamId, photo: league.photo || null },
    weeks,
    standings: computeStandings(league),
    stats: { team: stats.team, players: stats.players, pairs: stats.pairs.slice(0, 8) },
    eligibility: { total: elig.total, needed: elig.needed },
    announcement: league.announcement === undefined ? DEFAULT_ANNOUNCEMENT : league.announcement,
    roster: league.roster.map(p => ({ ...(v.canEdit ? { email: p.email, gender: p.gender || '' } : { me: p.email === v.email }), name: p.name, manager: !!p.manager, played: elig.played[p.email] || 0 })),
  });
};

export const config = { path: '/.netlify/functions/ohana-data' };
