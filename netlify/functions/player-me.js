// netlify/functions/player-me.js
// Authed. Returns everything the player portal needs in one call:
// profile, my stats, leaderboard (with Player of the Week), team, schedule.

import { getStore } from '@netlify/blobs';
import { etagJson, PRIVATE } from './lib/http-cache.js';
import { verifyPlayerSession, unauthResponse } from './lib/auth.js';
import { findAllPlayerTeamsByEmail } from './lib/player-auth.js';
import { circuitCode } from './lib/circuit.js';
import { isRevealTime } from './lib/lineup-helpers.js';
import { getRelevantAnnouncements } from './lib/announcements.js';
import { getActiveWaivers, getSignature, isWaiverSatisfied } from './lib/waiver.js';
import { isAdminEmail } from './lib/admin-auth.js';
import { getTeamAvailability } from './lib/availability.js';

const SLOT_LABEL = {
  r1g1: "R1 · Women's", r1g2: "R1 · Men's", r1g3: 'R1 · Mixed', r1g4: 'R1 · Mixed', r1g5: 'R1 · Mixed', r1g6: 'R1 · Mixed',
  r2g1: "R2 · Women's", r2g2: "R2 · Men's", r2g3: 'R2 · Mixed', r2g4: 'R2 · Mixed', r2g5: 'R2 · Mixed', r2g6: 'R2 · Mixed',
};
const LINEUP_SLOTS = ['r1g1','r1g2','r1g3','r1g4','r1g5','r1g6','r2g1','r2g2','r2g3','r2g4','r2g5','r2g6'];

export default async (req) => {
  const verified = await verifyPlayerSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;

  const { playerId, teamId, team, player } = ctx;
  const circuit = circuitCode(team.circuit);
  const division = team.division || null;

  // Is this player a team leader? Drives the Captain tab in the portal.
  const myEmail = player.normalizedEmail || (player.email || '').toLowerCase() || null;
  const isCaptain = !!player.isCaptain || (!!myEmail && (team.captainEmail || '').toLowerCase() === myEmail);
  const isCoCaptain = !!player.isCoCaptain && !isCaptain;
  // Does this signed-in account also have admin rights? Drives the "Admin"
  // toggle in the portal's view switcher. Checked against the SESSION email
  // (authoritative), not the roster email.
  const isAdmin = isAdminEmail(ctx.session?.email || myEmail);

  const scheduleStore = getStore('schedule');
  const lineupStore = getStore('lineups');
  // Strong reads so a player never sees a just-finalized score blink out
  // (eventual replicas can briefly return the pre-write copy).
  const scoresStore = getStore({ name: 'scores', consistency: 'strong' });
  const statsStore = getStore('player-stats');
  const standingsStore = getStore('standings');
  const teamsStore = getStore('teams');

  const [psData, standings] = await Promise.all([
    statsStore.get(`player-stats/${circuit}.json`, { type: 'json' }).catch(() => null),
    standingsStore.get(`standings/${circuit}.json`, { type: 'json' }).catch(() => null),
  ]);
  const players = psData?.players || {};
  const myStats = players[playerId] || null;

  // teamId -> division (for tagging leaderboard rows)
  const teamDiv = new Map();
  const teamEmoji = new Map();
  try {
    const { blobs } = await teamsStore.list({ prefix: 'team/' });
    for (const b of blobs) {
      const t = await teamsStore.get(b.key, { type: 'json' }).catch(() => null);
      if (t?.id) { teamDiv.set(t.id, t.division || null); teamEmoji.set(t.id, t.emoji || null); }
    }
  } catch { /* non-fatal */ }

  // ── Leaderboard (ranked by composite) ──
  // Pre-season players (0 games) are included with dsr:null so the portal
  // matches the public leaderboard, which lists every rostered player.
  const leaderboard = Object.values(players)
    .map(p => ({
      playerId: p.playerId, name: p.name, teamName: p.teamName || null,
      division: teamDiv.get(p.teamId) || null, gender: p.gender || null,
      dsr: (p.composite != null && (p.gamesPlayed || 0) > 0) ? Math.round(p.composite * 10) / 10 : null,
      gp: p.gamesPlayed || 0,
      w: p.gamesWon || 0, l: p.gamesLost || 0, rankDelta: p.rankDelta ?? null,
    }))
    .sort((a, b) => ((b.dsr ?? -1) - (a.dsr ?? -1)) || String(a.name || '').localeCompare(String(b.name || '')))
    // Rank ONLY players who have a DSR (played ≥1 game). Players with 0 games
    // are unranked (rank: null) — no positional rank at season start.
    .map((p) => {
      const out = { ...p, rank: null, me: p.playerId === playerId };
      return out;
    });
  let _rk = 0;
  for (const p of leaderboard) { if (p.dsr != null) p.rank = ++_rk; }

  // Player of the Week (latest week, gender split)
  const pow = (standings?.weeklyTopPerformers || [])[0] || null;
  const powOut = pow ? {
    week: pow.week,
    woman: pow.women?.[0] || null,
    man: pow.men?.[0] || null,
  } : null;

  // K'CHN Top Chefs — weekly winners feed for the portal Leaders tab
  const chefWeeks = (standings?.weeklyTopPerformers || []).map(w => ({
    week: w.week,
    women: (w.women || []).slice(0, 3),
    men: (w.men || []).slice(0, 3),
  }));

  // ── Team standing + roster (with DSR) ──
  let teamStanding = null;
  if (standings?.divisions?.[division]?.teams) {
    teamStanding = standings.divisions[division].teams.find(t => t.teamId === teamId) || null;
  }
  const teamCapEmail = (team.captainEmail || '').toLowerCase();
  // Archived teammates drop off the Team tab (but the viewer always sees themselves).
  const roster = (team.roster || []).filter(p => !p.archived || p.id === playerId).map(p => ({
    id: p.id, name: p.name, gender: p.gender || null,
    dsr: players[p.id]?.composite != null ? Math.round(players[p.id].composite * 10) / 10 : null,
    me: p.id === playerId,
    // C / CC badges for the Team tab — flag on the roster entry OR captainEmail match
    isCaptain: !!p.isCaptain || (!!teamCapEmail && (p.normalizedEmail || (p.email || '').toLowerCase()) === teamCapEmail),
    isCoCaptain: !!p.isCoCaptain,
  })).sort((a, b) => (b.dsr ?? -1) - (a.dsr ?? -1));

  // ── Schedule (my team's matches) ──
  // NOTE: a team can play MORE than one match in the same week (e.g. a
  // make-up or admin-added game), so collect every match — not just the first.
  const schedule = [];
  if (division) {
    for (let w = 1; w <= 12; w++) {
      const data = await scheduleStore.get(`schedule/${circuit}/${division}/week-${w}.json`, { type: 'json' }).catch(() => null);
      if (!data?.matches) continue;
      const myMatches = data.matches.filter(m => m.teamA?.id === teamId || m.teamB?.id === teamId);
      for (const mt of myMatches) {
      const home = mt.teamA?.id === teamId;
      const opp = home ? mt.teamB : mt.teamA;
      const final = !!mt.finalizedAt;
      const myMp = home ? (mt.scoreA ?? null) : (mt.scoreB ?? null);
      const oppMp = home ? (mt.scoreB ?? null) : (mt.scoreA ?? null);
      let result = null;
      if (final && myMp != null && oppMp != null) result = myMp > oppMp ? 'W' : myMp < oppMp ? 'L' : 'T';

      // My availability for this match (default = available, so null until I act
      // or a captain sets it). Only meaningful for upcoming matches.
      let availability = null;
      if (!final) {
        const ar = await getTeamAvailability(mt.id, teamId);
        const a = ar.players?.[playerId] || null;
        const started = mt.scheduledAt ? Date.now() >= new Date(mt.scheduledAt).getTime() : false;
        availability = {
          status: a?.status || null,
          reason: a?.reason || '',
          byRole: a?.byRole || null,
          editable: !started,
        };
      }

      // My lineup membership (which games I'm slotted in), if my lineup is locked
      let myGames = [];
      let myLocked = false, revealed = false;
      // Full lineup for the player view: our team's pairings once locked, the
      // opponent's only once revealed (preserves the blind-lineup anti-cheat).
      let lineup = null;
      if (!final) {
        const [mine, oppLu] = await Promise.all([
          lineupStore.get(`lineup/${mt.id}/${teamId}.json`, { type: 'json' }).catch(() => null),
          opp?.id ? lineupStore.get(`lineup/${mt.id}/${opp.id}.json`, { type: 'json' }).catch(() => null) : null,
        ]);
        myLocked = !!mine?.lockedAt;
        // Simultaneous reveal: both locked AND within 15 min of match start.
        revealed = myLocked && !!oppLu?.lockedAt && isRevealTime(mt.scheduledAt);
        if (mine?.games) {
          for (const [slot, g] of Object.entries(mine.games)) {
            if (g && (g.p1 === playerId || g.p2 === playerId)) myGames.push(SLOT_LABEL[slot] || slot);
          }
        }
        if (myLocked && mine?.games) {
          // Names only — no PII. Mixed slots are already stored woman-first.
          const side = (lu) => {
            if (!lu?.games) return null;
            const o = {};
            for (const s of LINEUP_SLOTS) {
              const g = lu.games[s];
              o[s] = { p1: g?.p1Name || null, p2: g?.p2Name || null };
            }
            return o;
          };
          const mySlots = {};
          for (const s of LINEUP_SLOTS) {
            const g = mine.games[s];
            if (g?.p1 === playerId) mySlots[s] = 'p1';
            else if (g?.p2 === playerId) mySlots[s] = 'p2';
          }
          lineup = { mine: side(mine), opp: revealed ? side(oppLu) : null, mySlots };
        }
      }

      // Live game scores, sanitized (numbers only — no submitter PII).
      // Only once lineups are revealed: before that there's nothing to score,
      // and it keeps the blind-lineup window airtight. home = teamA.
      // Enter/confirm model: show the CONFIRMED canonical score when present;
      // otherwise fall back to the HOME team's entry — the home captain is
      // the single score-enterer, so that's the live number for BOTH teams.
      let scores = null;
      if (!final && revealed) {
        const sc = await scoresStore.get(`score/${mt.id}.json`, { type: 'json' }).catch(() => null);
        if (sc?.games) {
          scores = {};
          for (const s of LINEUP_SLOTS) {
            const g = sc.games[s];
            if (!g) continue;
            // Canonical agreed score first (also covers legacy records where
            // home/away were stored directly).
            let h = Number.isInteger(g.home) ? g.home : null;
            let a = Number.isInteger(g.away) ? g.away : null;
            if (h == null && a == null) {
              const e = g.homeEntry;
              if (e && (Number.isInteger(e.home) || Number.isInteger(e.away))) {
                h = Number.isInteger(e.home) ? e.home : null;
                a = Number.isInteger(e.away) ? e.away : null;
              }
            }
            if (h != null || a != null) scores[s] = { home: h, away: a };
          }
          if (!Object.keys(scores).length) scores = null;
        }
      }

      schedule.push({
        matchId: mt.id, week: w,
        opponent: { id: opp?.id || null, name: opp?.name || 'TBD', emoji: teamEmoji.get(opp?.id) || null },
        home, court: mt.court || null, venue: mt.venue || null, scheduledAt: mt.scheduledAt || null, startTime: mt.startTime || null,
        championship: !!mt.championship,
        final, myMp, oppMp, result,
        myLocked, revealed, myGames, lineup, scores, availability,
        status: final ? 'final' : revealed ? 'live' : myLocked ? 'locked' : 'upcoming',
      });
      }
    }
  }
  schedule.sort((a, b) => a.week - b.week);

  // Every team this player is rostered on, for the team switcher.
  const myTeams = (await findAllPlayerTeamsByEmail(myEmail)).map(({ team }) => ({
    id: team.id,
    name: team.name,
    division: team.division || null,
    divisionLabel: team.divisionLabel || null,
  }));
  // Always include the active team, even if it was filtered (e.g. test season).
  if (!myTeams.some(x => x.id === teamId)) {
    myTeams.unshift({ id: teamId, name: team.name, division, divisionLabel: team.divisionLabel || division });
  }

  // League announcements relevant to this player's team — PLAYER audience only.
  // Captain-addressed broadcasts stay in the captain portal; players see only
  // notices the admin sent to players.
  const announcements = await getRelevantAnnouncements({ teamId, division, limit: 3, audiences: ['players'] });

  // Liability waivers — each active waiver must be signed for the current
  // season + version. Returns the full list with a `required` flag per waiver.
  const activeWaivers = await getActiveWaivers();
  const waivers = await Promise.all(activeWaivers.map(async w => {
    const sig = await getSignature(w.id, playerId);
    const satisfied = isWaiverSatisfied({ waiver: w, signature: sig, season: circuit });
    return {
      id: w.id, title: w.title, text: w.text, version: w.version,
      required: !satisfied,
      signedAt: sig?.signedAt || null,
      method: sig?.method || null,
    };
  }));

  // ETag + private no-store: the portal's live poller sends If-None-Match,
  // so unchanged payloads come back as an empty 304 instead of the full blob.
  return etagJson(req, {
    profile: {
      playerId, name: player.name, gender: player.gender || null,
      teamId, teamName: team.name, teamEmoji: team.emoji || null,
      division, divisionLabel: team.divisionLabel || division, circuit,
      isCaptain, isCoCaptain, isAdmin,
      // Owner-only: the player's own bio fields (incl. DOB), any pending edit
      // awaiting admin approval, and whether an approved photo exists.
      bio: player.profile || {},
      pendingProfile: player.pendingProfile || null,
      hasPhoto: !!(player.photo && player.photo.updatedAt),
      photoUpdatedAt: player.photo?.updatedAt || null,
    },
    myTeams,
    currentTeamId: teamId,
    stats: myStats,
    partnerNames: partnerNames(myStats, players),
    leaderboard,
    pow: powOut,
    chefWeeks,
    team: {
      standing: teamStanding,
      roster,
    },
    schedule,
    announcements,
    waivers,
  }, { cacheControl: PRIVATE });
};

function partnerNames(myStats, players) {
  const out = {};
  if (myStats?.partners) {
    for (const pid of Object.keys(myStats.partners)) {
      const p = players[pid];
      if (p) out[pid] = { name: p.name, teamName: p.teamName || null };
    }
  }
  return out;
}

export const config = { path: '/.netlify/functions/player-me' };
