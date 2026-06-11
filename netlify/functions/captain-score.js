// netlify/functions/captain-score.js
//
// Enter/confirm scoring with captain sign-off (model v3, June 7 2026 —
// replaced symmetric dual-entry, whose simultaneous saves caused constant
// races and double typing):
//   - The HOME captain enters every game score.
//   - The AWAY captain confirms each game (or flags it "not right" for the
//     home captain to fix — away never types numbers).
//   - A game is CONFIRMED when away's confirmation matches home's entry.
//   - The match finalizes only when all 12 games are confirmed AND both
//     captains have signed off ("I agree these scores are correct").
//
// GET   ?match=<id>                          → state + computed view (my side)
// PUT   ?match=<id>                          → HOME ONLY: save game entries
//                                                body: { games: { r1g1: { home: 11, away: 4 }, ... } }
// POST  ?match=<id>&action=confirm           → AWAY ONLY: confirm games
//                                                body: { slots: ['r1g1', ...] }
// POST  ?match=<id>&action=dispute           → AWAY ONLY: flag a game as wrong
//                                                body: { slot: 'r1g1' }
// POST  ?match=<id>&action=submit            → sign off (body: { agree: true })
// POST  ?match=<id>&action=withdraw          → revoke my sign-off (pre-finalize)
//
// Storage shape per slot (unchanged from dual-entry — see lib/score-helpers.js):
//   game = { home, away,                      // canonical agreed score
//            homeEntry: {home,away,by,at},    // what home entered
//            awayEntry: {home,away,by,at},    // set by away's CONFIRM (copy of homeEntry)
//            dispute:   {by,at} | undefined } // away's "not right" flag
// Keeping the shape means score-helpers (status/validity/canonical), admin
// tools, and player views all keep working; "confirmed" is still
// entries-agree. Home editing a game clears its confirmation AND dispute.

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { rebuildStandings } from './lib/standings.js';
import { circuitCode } from './lib/circuit.js';
import {
  SLOT_KEYS, newScoreRecord, toScore, decorate, prettySlot,
  normalizeScore, entryComplete, isValidGame,
} from './lib/score-helpers.js';
import { logActivity } from './lib/activity-log.js';
import { isRevealTime } from './lib/lineup-helpers.js';

export default async (req) => {
  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;

  const url = new URL(req.url);
  const matchId = url.searchParams.get('match');
  if (!matchId) return json({ error: 'match id required' }, 400);

  const scheduleStore = getStore('schedule');
  // STRONG consistency on scores: this lambda does the read-modify-write etag
  // loop AND the read-back. With default (eventual) reads, the etag read can
  // return a stale replica — the conditional write then fails spuriously and
  // burns retries (503 "save again"), and the GET read-back can return a
  // pre-write copy so a just-saved score visibly vanishes until the store
  // converges. Strong reads always reflect the latest write. (Same reasoning
  // lib/standings.js documents for rebuildStandings.)
  const scoresStore = getStore({ name: 'scores', consistency: 'strong' });
  const lineupStore = getStore('lineups');
  const seasonStore = getStore('seasons');
  const seasonData = ctx.team.seasonId
    ? await seasonStore.get(ctx.team.seasonId, { type: 'json' }).catch(() => null)
    : null;
  const WEEKS = seasonData?.weeks || 8;

  const match = await findMatch(scheduleStore, matchId, ctx.team, WEEKS);
  if (!match) return json({ error: 'Match not found or not yours' }, 404);

  const myRole = match.teamA.id === ctx.team.id ? 'home' : 'away';
  const scoreKey = `score/${matchId}.json`;
  const winBy = match.championship ? 2 : 1;

  const [lineupHome, lineupAway] = await Promise.all([
    lineupStore.get(`lineup/${matchId}/${match.teamA.id}.json`, { type: 'json' }).catch(() => null),
    lineupStore.get(`lineup/${matchId}/${match.teamB.id}.json`, { type: 'json' }).catch(() => null),
  ]);
  // Scoring opens at reveal: both lineups locked AND within 15 min of match start.
  const revealed = !!lineupHome?.lockedAt && !!lineupAway?.lockedAt
    && isRevealTime(match.scheduledAt, Number(seasonData?.lineupRevealOffsetMin) || undefined);

  // ===== GET =====
  if (req.method === 'GET') {
    if (!revealed) {
      return json({
        matchId, myRole, revealed: false,
        message: 'Both lineups must be locked before scoring.',
      });
    }
    const score = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null)
      || newScoreRecord(match);

    return json({
      matchId, myRole, revealed: true,
      match: publicMatchInfo(match),
      homeLineup: sanitizeLineup(lineupHome),
      awayLineup: sanitizeLineup(lineupAway),
      score: viewForCaptain(decorate(score, match.championship), myRole),
    });
  }

  if (!revealed) return json({ error: 'Both lineups must be locked before scoring' }, 409);

  // ===== PUT — HOME captain enters scores =====
  if (req.method === 'PUT') {
    if (myRole !== 'home') {
      return json({ error: 'The home team enters the scores — you review and confirm each game.' }, 403);
    }
    const body = await req.json();
    const incoming = body.games || {};
    const entryKey = 'homeEntry';

    // CONCURRENCY: home enters while away confirms — still two writers on ONE
    // shared blob, so every save is etag-guarded: if the other captain wrote
    // mid-flight, re-read and re-apply MY changes on top of theirs (the
    // unguarded version silently wiped scores in week-1 QA).
    let existing = null, changed = false, saved = false;
    for (let attempt = 0; attempt < 5 && !saved; attempt++) {
      const got = await scoresStore.getWithMetadata(scoreKey, { type: 'json' }).catch(() => null);
      existing = got?.data || newScoreRecord(match);
      const etag = got?.etag || null;
      normalizeScore(existing, match.championship);

      if (existing.finalizedAt) {
        return json({ error: 'Match is final. Contact admin to reopen.' }, 409);
      }

      const now = new Date().toISOString();
      changed = false;

      // Each captain writes ONLY their own team's version of the score.
      for (const slot of SLOT_KEYS) {
        if (!(slot in incoming)) continue;
        const g = incoming[slot] || {};
        const cur = existing.games[slot];
        const myEntry = cur[entryKey] || { home: null, away: null, by: null, at: null };
        let slotChanged = false;

        for (const side of ['home', 'away']) {
          if (!(side in g)) continue;
          const raw = g[side];
          const newVal = (raw === '' || raw === null || raw === undefined) ? null : toScore(raw);
          if (newVal === 'INVALID') {
            return json({ error: `${prettySlot(slot)}: scores must be integers 0-30` }, 400);
          }
          if (myEntry[side] === newVal) continue; // no change
          myEntry[side] = newVal;
          slotChanged = true;
        }

        if (slotChanged) {
          myEntry.by = ctx.user.email;
          myEntry.at = now;
          cur[entryKey] = myEntry;
          // An edit invalidates away's confirmation and clears any "not
          // right" flag — the new number needs a fresh confirm.
          cur.awayEntry = null;
          delete cur.dispute;
          changed = true;
        }
      }

      // My own complete entries must each form a valid finished game.
      // (Disagreeing with the other team is allowed — that's a mismatch,
      // surfaced in the UI — but an impossible score is rejected outright.)
      const invalidSlots = SLOT_KEYS.filter(slot => {
        const e = existing.games[slot][entryKey];
        if (!entryComplete(e)) return false; // partial mid-entry — ok
        return !isValidGame(e.home, e.away, winBy);
      });

      if (invalidSlots.length > 0) {
        const labels = invalidSlots.map(prettySlot).join(', ');
        const rule = match.championship ? 'first to 11, win by 2' : 'first to 11';
        return json({
          error: `${invalidSlots.length} game(s) have impossible scores (${rule}): ${labels}. Fix before saving.`,
          invalidSlots,
        }, 400);
      }

      // Re-derive canonical agreed scores from both entries.
      normalizeScore(existing, match.championship);

      // Any score change wipes both sign-offs — both captains must re-approve.
      if (changed && (existing.homeSubmittedAt || existing.awaySubmittedAt)) {
        existing.homeSubmittedAt = null;
        existing.homeSubmittedBy = null;
        existing.homeSignedName = null;
        existing.awaySubmittedAt = null;
        existing.awaySubmittedBy = null;
        existing.awaySignedName = null;
      }

      existing.updatedAt = now;
      existing.updatedBy = ctx.user.email;

      const res = etag
        ? await scoresStore.setJSON(scoreKey, existing, { onlyIfMatch: etag })
        : await scoresStore.setJSON(scoreKey, existing, { onlyIfNew: true });
      saved = !res || res.modified !== false; // lost the race → loop re-reads & re-applies
    }
    if (!saved) {
      return json({ error: 'The other team was saving at the same moment — your scores were NOT saved. Please save again.' }, 503);
    }

    if (changed) {
      await logActivity({
        type: 'score.entry',
        actor: { email: ctx.user.email, role: ctx.user.role },
        team: ctx.team,
        matchId, week: match.week, circuit: match.circuit,
        details: `${ctx.team.name} updated their Week ${match.week} scoresheet (${match.teamA.name} vs ${match.teamB.name})`,
      });
    }

    return json({ ok: true, score: viewForCaptain(decorate(existing, match.championship), myRole) });
  }

  // ===== POST confirm / dispute / submit / withdraw =====
  if (req.method === 'POST') {
    const action = url.searchParams.get('action');
    if (!['confirm', 'dispute', 'submit', 'withdraw'].includes(action)) {
      return json({ error: 'action must be confirm, dispute, submit or withdraw' }, 400);
    }

    // ── AWAY captain: confirm games / flag a game as wrong ──
    if (action === 'confirm' || action === 'dispute') {
      if (myRole !== 'away') {
        return json({ error: 'Only the away team confirms scores — you enter them.' }, 403);
      }
      const aBody = await req.json().catch(() => ({}));
      const slots = action === 'confirm'
        ? (Array.isArray(aBody.slots) ? aBody.slots : aBody.slot ? [aBody.slot] : [])
        : (aBody.slot ? [aBody.slot] : []);
      if (!slots.length || slots.some(s => !SLOT_KEYS.includes(s))) {
        return json({ error: 'Provide valid game slot(s) to ' + action }, 400);
      }

      let existing = null, saved = false;
      for (let attempt = 0; attempt < 5 && !saved; attempt++) {
        const got = await scoresStore.getWithMetadata(scoreKey, { type: 'json' }).catch(() => null);
        existing = got?.data || newScoreRecord(match);
        const etag = got?.etag || null;
        normalizeScore(existing, match.championship);
        if (existing.finalizedAt) {
          return json({ error: 'Match is final. Contact admin to reopen.' }, 409);
        }

        const now = new Date().toISOString();
        for (const slot of slots) {
          const g = existing.games[slot];
          if (!entryComplete(g.homeEntry) || !isValidGame(g.homeEntry.home, g.homeEntry.away, winBy)) {
            return json({ error: `${prettySlot(slot)}: the home team hasn't entered a complete, valid score yet.` }, 409);
          }
          if (action === 'confirm') {
            // Confirmation = away adopting home's numbers (entries-agree keeps
            // all downstream status/finalize logic working unchanged).
            g.awayEntry = { home: g.homeEntry.home, away: g.homeEntry.away, by: ctx.user.email, at: now };
            delete g.dispute;
          } else {
            // "Not right" — flag for home to fix; clears any prior confirm.
            g.awayEntry = null;
            g.dispute = { by: ctx.user.email, at: now };
          }
        }

        // A confirmation state change re-opens sign-offs (scores changed state).
        if (existing.homeSubmittedAt || existing.awaySubmittedAt) {
          existing.homeSubmittedAt = null; existing.homeSubmittedBy = null; existing.homeSignedName = null;
          existing.awaySubmittedAt = null; existing.awaySubmittedBy = null; existing.awaySignedName = null;
        }
        normalizeScore(existing, match.championship);
        existing.updatedAt = now;
        existing.updatedBy = ctx.user.email;

        const res = etag
          ? await scoresStore.setJSON(scoreKey, existing, { onlyIfMatch: etag })
          : await scoresStore.setJSON(scoreKey, existing, { onlyIfNew: true });
        saved = !res || res.modified !== false;
      }
      if (!saved) {
        return json({ error: 'The other team was saving at the same moment — please try again.' }, 503);
      }

      await logActivity({
        type: action === 'confirm' ? 'score.confirmed' : 'score.disputed',
        actor: { email: ctx.user.email, role: ctx.user.role },
        team: ctx.team,
        matchId, week: match.week, circuit: match.circuit,
        details: action === 'confirm'
          ? `${ctx.team.name} confirmed ${slots.length} game score(s) (${slots.map(prettySlot).join(', ')})`
          : `${ctx.team.name} flagged ${prettySlot(slots[0])} as incorrect — home team to fix`,
      });

      return json({ ok: true, score: viewForCaptain(decorate(existing, match.championship), myRole) });
    }

    const body = action === 'submit' ? await req.json().catch(() => ({})) : null;
    if (action === 'submit' && body.agree !== true) {
      return json({ error: 'You must confirm you agree with the scores before signing off.' }, 400);
    }

    // Same etag-guarded retry as PUT: without it, two captains signing off at
    // the same moment each read a record missing the other's signature — the
    // signatures clobber each other and the match never finalizes.
    let existing = null, finalized = false, saved = false;
    for (let attempt = 0; attempt < 5 && !saved; attempt++) {
      const got = await scoresStore.getWithMetadata(scoreKey, { type: 'json' }).catch(() => null);
      existing = got?.data || newScoreRecord(match);
      const etag = got?.etag || null;
      normalizeScore(existing, match.championship);
      finalized = false;

      if (action === 'submit') {
        if (existing.finalizedAt) {
          return json({ error: 'Already finalized' }, 409);
        }

        const decorated = decorate(existing, match.championship);

        // Mismatched games (the two teams' versions disagree) block sign-off.
        const mismatchedSlots = decorated.computed.gameStatuses
          .filter(g => g.status === 'mismatch')
          .map(g => g.slot);
        if (mismatchedSlots.length > 0) {
          const labels = mismatchedSlots.map(prettySlot).slice(0, 3).join(', ');
          const more = mismatchedSlots.length > 3 ? ` and ${mismatchedSlots.length - 3} more` : '';
          return json({
            error: `Cannot sign off — ${mismatchedSlots.length} game(s) don't match the other team's entry: ${labels}${more}. Confirm with the other captain, revise, and resave.`,
            mismatchedSlots,
          }, 400);
        }

        // All games must be CONFIRMED (both teams entered matching, valid scores)
        const unconfirmed = decorated.computed.gameStatuses.filter(g => g.status !== 'confirmed');
        if (unconfirmed.length > 0) {
          const rule = match.championship ? 'first to 11, win by 2' : 'first to 11';
          const labels = unconfirmed.map(g => prettySlot(g.slot)).slice(0, 3).join(', ');
          const more = unconfirmed.length > 3 ? ` and ${unconfirmed.length - 3} more` : '';
          return json({
            error: `Cannot sign off yet — ${unconfirmed.length} game(s) still need to be entered by the home team and confirmed by the away team (${rule}): ${labels}${more}.`,
          }, 400);
        }

        const now = new Date().toISOString();
        const signedName = captainName(ctx) || ctx.user.email;
        if (myRole === 'home') {
          existing.homeSubmittedAt = now;
          existing.homeSubmittedBy = ctx.user.email;
          existing.homeSignedName = signedName;
        } else {
          existing.awaySubmittedAt = now;
          existing.awaySubmittedBy = ctx.user.email;
          existing.awaySignedName = signedName;
        }

        // Both signed → finalize (side effects run after the write sticks)
        if (existing.homeSubmittedAt && existing.awaySubmittedAt) {
          existing.finalizedAt = now;
          finalized = true;
        }
      } else {
        // Withdraw
        if (existing.finalizedAt) {
          return json({ error: 'Match is finalized. Contact admin to reopen.' }, 409);
        }
        if (myRole === 'home') {
          existing.homeSubmittedAt = null;
          existing.homeSubmittedBy = null;
          existing.homeSignedName = null;
        } else {
          existing.awaySubmittedAt = null;
          existing.awaySubmittedBy = null;
          existing.awaySignedName = null;
        }
      }

      const res = etag
        ? await scoresStore.setJSON(scoreKey, existing, { onlyIfMatch: etag })
        : await scoresStore.setJSON(scoreKey, existing, { onlyIfNew: true });
      saved = !res || res.modified !== false;
    }
    if (!saved) {
      return json({ error: 'The other team was updating at the same moment — please try again.' }, 503);
    }

    if (finalized) {
      try {
        await writeFinalScoreToSchedule(scheduleStore, match, existing);
      } catch (err) {
        console.error('writeFinalScoreToSchedule failed for match', matchId, ':', err);
        // Don't block finalize — score record is already marked final
      }
      // Rebuild standings + player-stats aggregates for this Circuit.
      // MUST be awaited: serverless execution freezes once the response
      // returns, so a fire-and-forget rebuild silently never runs.
      try {
        await rebuildStandings(match.circuit);
      } catch (err) {
        console.error('rebuildStandings failed post-finalize for match', matchId, 'circuit', match.circuit, ':', err);
      }
      await logActivity({
        type: 'match.finalized',
        actor: { email: ctx.user.email, role: ctx.user.role },
        team: ctx.team,
        matchId, week: match.week, circuit: match.circuit,
        details: `Week ${match.week} match finalized: ${match.teamA.name} vs ${match.teamB.name} (both captains signed off)`,
      });
      return json({ ok: true, score: viewForCaptain(decorate(existing, match.championship), myRole) });
    }

    await logActivity({
      type: action === 'submit' ? 'score.signoff' : 'score.withdrawn',
      actor: { email: ctx.user.email, role: ctx.user.role },
      team: ctx.team,
      matchId, week: match.week, circuit: match.circuit,
      details: action === 'submit'
        ? `${ctx.team.name} signed off on the Week ${match.week} scoresheet (${match.teamA.name} vs ${match.teamB.name})`
        : `${ctx.team.name} withdrew their Week ${match.week} sign-off (${match.teamA.name} vs ${match.teamB.name})`,
    });

    return json({ ok: true, score: viewForCaptain(decorate(existing, match.championship), myRole) });
  }

  return new Response('Method not allowed', { status: 405 });
};

// ===== Helpers =====

async function findMatch(scheduleStore, matchId, team, weeks = 8) {
  const circuit = circuitCode(team.circuit);
  for (let week = 1; week <= weeks; week++) {
    const key = `schedule/${circuit}/${team.division}/week-${week}.json`;
    const data = await scheduleStore.get(key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    const m = data.matches.find(x => x.id === matchId);
    if (m && (m.teamA?.id === team.id || m.teamB?.id === team.id)) {
      return { ...m, week, circuit, division: team.division, scheduleKey: key };
    }
  }
  return null;
}

function sanitizeLineup(lineup) {
  if (!lineup) return null;
  return { teamId: lineup.teamId, teamName: lineup.teamName, games: lineup.games };
}

// Match metadata safe to expose to captains (dropped in the week-1 QA
// rewrite while the call site survived — every GET 500'd post-reveal).
function publicMatchInfo(match) {
  return {
    id: match.id, week: match.week, court: match.court,
    courtA: match.courtA ?? null,
    courtB: match.courtB ?? null,
    courtSet: match.courtSet ?? null,
    championship: !!match.championship,
    venue: match.venue || null,
    scheduledAt: match.scheduledAt || null,
    circuit: match.circuit, division: match.division,
    home: { id: match.teamA.id, name: match.teamA.name },
    away: { id: match.teamB.id, name: match.teamB.name },
  };
}

// Resolve the captain's display name from the team roster (for the sign-off).
function captainName(ctx) {
  const email = (ctx.user.email || '').toLowerCase();
  const p = (ctx.team.roster || []).find(x =>
    (x.normalizedEmail || (x.email || '').toLowerCase()) === email);
  return p?.name || null;
}

// Per-captain view of the score record (enter/confirm model):
//   - home's entry is visible to BOTH captains (away must see it to confirm)
//   - `confirmed` = away has confirmed home's numbers (entries agree)
//   - `disputed` = away flagged the game "not right" — home to fix
//   - submitter emails are not exposed; signed names are.
function viewForCaptain(decorated, myRole) {
  const games = {};
  for (const slot of SLOT_KEYS) {
    const g = decorated.games[slot] || {};
    const entered = g.homeEntry ? { home: g.homeEntry.home, away: g.homeEntry.away } : null;
    games[slot] = {
      home: g.home, away: g.away, // canonical agreed score (null until confirmed)
      entered,                                       // home's entry (both sides see it)
      enteredComplete: entryComplete(g.homeEntry),
      confirmed: entryComplete(g.homeEntry) && entryComplete(g.awayEntry)
        && g.homeEntry.home === g.awayEntry.home && g.homeEntry.away === g.awayEntry.away,
      disputed: !!g.dispute,
      // legacy field names kept so older cached clients don't crash mid-rollout
      mine: myRole === 'home' ? entered : (g.awayEntry ? { home: g.awayEntry.home, away: g.awayEntry.away } : null),
      theirs: myRole === 'home' ? (g.awayEntry ? { home: g.awayEntry.home, away: g.awayEntry.away } : null) : entered,
      theirsEntered: myRole === 'home' ? entryComplete(g.awayEntry) : entryComplete(g.homeEntry),
    };
  }

  return {
    matchId: decorated.matchId,
    week: decorated.week,
    championship: decorated.championship,
    home: decorated.home,
    away: decorated.away,
    games,
    homeSubmittedAt: decorated.homeSubmittedAt,
    awaySubmittedAt: decorated.awaySubmittedAt,
    homeSignedName: decorated.homeSignedName || null,
    awaySignedName: decorated.awaySignedName || null,
    finalizedAt: decorated.finalizedAt,
    updatedAt: decorated.updatedAt || null,
    computed: decorated.computed,
  };
}

async function writeFinalScoreToSchedule(scheduleStore, match, score) {
  const data = await scheduleStore.get(match.scheduleKey, { type: 'json' });
  if (!data?.matches) {
    throw new Error(`scheduleKey ${match.scheduleKey} returned no matches array`);
  }
  const m = data.matches.find(x => x.id === match.id);
  if (!m) {
    throw new Error(`match ${match.id} not found in scheduleKey ${match.scheduleKey}`);
  }

  const decorated = decorate(score, match.championship);
  m.scoreA = decorated.computed.matchPoints.home;
  m.scoreB = decorated.computed.matchPoints.away;
  m.finalizedAt = score.finalizedAt;
  m.round1 = decorated.computed.round1;
  m.round2 = decorated.computed.round2;

  // Total rally points for the night (PS/PA): sum every confirmed game's score.
  let pointsA = 0, pointsB = 0;
  for (const gstat of decorated.computed.gameStatuses) {
    if (gstat.status !== 'confirmed') continue;
    const g = score.games[gstat.slot];
    const h = Number.isInteger(g?.home) ? g.home : g?.homeEntry?.home;
    const a = Number.isInteger(g?.away) ? g.away : g?.homeEntry?.away;
    if (Number.isInteger(h)) pointsA += h;
    if (Number.isInteger(a)) pointsB += a;
  }
  m.pointsA = pointsA;
  m.pointsB = pointsB;

  data.updatedAt = new Date().toISOString();
  await scheduleStore.setJSON(match.scheduleKey, data);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/captain-score' };
