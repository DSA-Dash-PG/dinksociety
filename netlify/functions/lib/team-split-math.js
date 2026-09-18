// netlify/functions/lib/team-split-math.js
// Pure money + ledger maths for the captain "Split with your team" feature.
// No storage, auth or request handling here — see lib/team-split.js for that.
//
// EVERYTHING is integer cents. There is no rounding up to the dollar: a flat
// amount is divided to the exact cent and any leftover pennies are handed out
// one at a time (the payee — the captain — takes the smaller share), so the
// shares always add back up to exactly the amount the captain typed.
//
// Two modes:
//   flat     the captain types an amount; it is split across the player set
//            (the live active roster until the roster locks, then the frozen
//            `lockedPlayerIds`). A per-player override pins one player to a
//            fixed amount and the rest share what is left.
//   pergame  the captain sets a rate; each player owes rate x games they
//            actually played in FINALIZED matches — every week of the season,
//            playoffs included.
//            The rate can change from a given week on (`rateHistory`, see
//            rateForWeek) — weeks already played keep the rate they were billed
//            at. A player can have their own price (`playerRates[pid]`): a flat
//            amount per week they play, or their own per-game rate.
//            Optional BUY-IN (`buyInCents`): a flat amount every player owes up
//            front to be on the team. Per-game charges draw it down; once it is
//            used up the player owes the overage game by game. So a player owes
//            max(buy-in, games x rate) — the buy-in is a floor, not an extra,
//            and an unused remainder is not refunded.

import { SLOT_KEYS, normalizeScore } from './score-helpers.js';

export const MAX_AMOUNT_CENTS = 100000 * 100; // $100,000 sanity cap
export const MAX_RATE_CENTS = 100 * 100;      // $100 a game sanity cap
export const PAY_METHODS = ['venmo', 'cash', 'zelle', 'other'];

/** Dollars (number or string like "4.25" / "$700") -> integer cents, or null. */
export function toCents(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [d, f = ''] = s.split('.');
  return Number(d) * 100 + Number((f + '00').slice(0, 2));
}

/** Integer cents -> "$77.78" (always two decimals unless a whole dollar). */
export function fmtCents(c) {
  const n = Math.round(Number(c) || 0);
  const neg = n < 0, a = Math.abs(n);
  const dollars = Math.floor(a / 100).toLocaleString('en-US');
  const cents = a % 100;
  return (neg ? '-' : '') + '$' + dollars + (cents ? '.' + String(cents).padStart(2, '0') : '');
}

/** "@Some-Handle " -> "Some-Handle", or null when it isn't a plausible handle. */
export function normalizeHandle(h) {
  const s = String(h || '').trim().replace(/^@+/, '');
  return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : null;
}

/**
 * Split totalCents across ids to the exact cent. Leftover pennies go to the
 * ids EARLIEST in the list, so put whoever should pay least LAST.
 */
export function splitEvenly(totalCents, ids) {
  const out = {};
  const n = ids.length;
  if (!n) return out;
  const total = Math.max(0, Math.round(totalCents));
  const base = Math.floor(total / n);
  let extra = total - base * n;
  for (const id of ids) { out[id] = base + (extra > 0 ? 1 : 0); if (extra > 0) extra--; }
  return out;
}

/**
 * Flat-mode shares.
 * @returns {{ shares: Record<string, number>, unassignedCents: number }}
 *   unassignedCents > 0 only when every player is overridden and the overrides
 *   don't add up to the amount (nobody left to absorb the difference).
 */
export function flatShares({ amountCents, playerIds, overrides = {}, payeeId = null }) {
  const amount = Math.max(0, Math.round(amountCents || 0));
  const shares = {};
  let pinned = 0;
  const free = [];
  for (const id of playerIds) {
    const o = overrides[id];
    if (Number.isInteger(o) && o >= 0) { shares[id] = o; pinned += o; }
    else free.push(id);
  }
  // Payee last -> the captain never picks up a rounding penny.
  free.sort((a, b) => (a === payeeId) - (b === payeeId));
  const rest = Math.max(0, amount - pinned);
  Object.assign(shares, splitEvenly(rest, free));
  return { shares, unassignedCents: free.length ? 0 : rest };
}

/**
 * Games each of OUR players actually played in one match: a slot counts when
 * the agreed (canonical) score is complete. Unplayed / unscored slots are free.
 * @returns {Record<string, number>} playerId -> games
 */
export function countGames({ lineup, score, championship = false }) {
  const counts = {};
  if (!lineup?.games || !score?.games) return counts;
  normalizeScore(score, championship);
  for (const slot of SLOT_KEYS) {
    const g = score.games[slot];
    if (!Number.isInteger(g?.home) || !Number.isInteger(g?.away)) continue;
    const picks = lineup.games[slot];
    if (!picks) continue;
    for (const pid of [picks.p1, picks.p2]) if (pid) counts[pid] = (counts[pid] || 0) + 1;
  }
  return counts;
}

/**
 * The per-game rate in force for a given week. `rateHistory` is
 * [{ fromWeek, rateCents }] — the entry with the largest fromWeek <= week wins.
 * No history → the single `rateCents` applies to every week.
 */
export function rateForWeek(split, week) {
  const hist = Array.isArray(split?.rateHistory) ? split.rateHistory : [];
  let rate = Math.max(0, Math.round(split?.rateCents || 0));
  let best = -Infinity;
  for (const h of hist) {
    const from = Number(h?.fromWeek);
    if (Number.isInteger(from) && from <= (week ?? 1) && from > best && Number.isInteger(h.rateCents)) { best = from; rate = h.rateCents; }
  }
  if (best === -Infinity && hist.length) {
    // week is before the earliest entry — use the earliest known rate
    const first = [...hist].sort((a, b) => a.fromWeek - b.fromWeek)[0];
    if (Number.isInteger(first?.rateCents)) rate = first.rateCents;
  }
  return Math.max(0, rate);
}

/**
 * Change the rate so it applies only to weeks not yet played.
 * lastPlayedWeek = highest week this team has a finalized match in (0 = none).
 * Returns the new rateHistory; `rateCents` should be set to newRate alongside.
 */
export function applyRateChange(split, newRateCents, lastPlayedWeek) {
  const current = Math.max(0, Math.round(split?.rateCents || 0));
  let hist = Array.isArray(split?.rateHistory) ? split.rateHistory.filter(h => Number.isInteger(h?.fromWeek) && Number.isInteger(h?.rateCents)) : [];
  if (!hist.length) hist = [{ fromWeek: 1, rateCents: current }];
  const fromWeek = Math.max(1, (lastPlayedWeek || 0) + 1);
  // Drop any entries at or after the effective week (they never billed anything), then add the new one.
  hist = hist.filter(h => h.fromWeek < fromWeek);
  if (!hist.length) return [{ fromWeek: 1, rateCents: newRateCents }];
  if (hist[hist.length - 1].rateCents === newRateCents) return hist.sort((a, b) => a.fromWeek - b.fromWeek);
  hist.push({ fromWeek, rateCents: newRateCents });
  return hist.sort((a, b) => a.fromWeek - b.fromWeek);
}

function sumPayments(list) {
  return (list || []).reduce((s, p) => s + (Number.isInteger(p?.cents) ? p.cents : 0), 0);
}

/**
 * Build the full ledger.
 * @param split  the stored split record
 * @param team   the team blob (roster used for names / payee / active set)
 * @param tabs   pergame only: [{ matchId, week, phase, counts: {pid: n} }]
 */
export function buildLedger({ split, team, tabs = [] }) {
  const roster = (team?.roster || []).filter(p => p && p.id);
  const byId = new Map(roster.map(p => [p.id, p]));
  const capEmail = String(team?.captainEmail || '').toLowerCase();
  const payee = roster.find(p => p.isCaptain)
    || roster.find(p => capEmail && String(p.email || '').toLowerCase() === capEmail) || null;
  const payeeId = payee?.id || null;
  const active = roster.filter(p => !p.archived && !p.pendingAdd).map(p => p.id);

  const mode = split?.mode === 'pergame' ? 'pergame' : 'flat';
  const owed = {};        // pid -> cents
  const games = {};       // pid -> total games (pergame)
  const weeks = {};       // pid -> [{ week, games, cents }]
  const used = {};        // pid -> cents of per-game charges so far (pergame)
  let buyIn = 0;          // pergame: flat amount each player owes up front
  let lastPlayedWeek = 0; // pergame: highest week with a finalized match
  let unassignedCents = 0;

  if (mode === 'flat') {
    const locked = Array.isArray(split?.lockedPlayerIds) && split.lockedPlayerIds.length;
    const ids = (locked ? split.lockedPlayerIds : active).filter(id => byId.has(id));
    const r = flatShares({ amountCents: split?.amountCents || 0, playerIds: ids, overrides: split?.overrides || {}, payeeId });
    Object.assign(owed, r.shares);
    unassignedCents = r.unassignedCents;
  } else {
    buyIn = Math.max(0, Math.round(split?.buyInCents || 0));
    const playerRates = split?.playerRates || {};
    const sorted = [...tabs].sort((a, b) => (a.week || 0) - (b.week || 0));
    for (const t of sorted) {
      const weekRate = rateForWeek(split, t.week);
      for (const [pid, n] of Object.entries(t.counts || {})) {
        if (!byId.has(pid) || !n) continue;
        // A player's own price beats the team rate: a flat amount for any week
        // they play, or their own per-game rate.
        const pr = playerRates[pid];
        const custom = pr && Number.isInteger(pr.cents) && (pr.mode === 'week' || pr.mode === 'game');
        const cents = custom ? (pr.mode === 'week' ? pr.cents : n * pr.cents) : n * weekRate;
        games[pid] = (games[pid] || 0) + n;
        used[pid] = (used[pid] || 0) + cents;
        (weeks[pid] = weeks[pid] || []).push({
          week: t.week, phase: t.phase || null, games: n, cents,
          rateCents: custom ? pr.cents : weekRate, pricing: custom ? pr.mode : 'game',
        });
      }
    }
    lastPlayedWeek = tabs.reduce((m, t) => Math.max(m, Number(t.week) || 0), 0);
    // Everyone on the active roster gets a row even before they play — and owes
    // the buy-in from day one. Someone who has left only owes it if they played.
    for (const id of active) if (!(id in used)) used[id] = 0;
    for (const id of Object.keys(used)) owed[id] = Math.max(used[id], buyIn);
  }

  // Anyone with money recorded against them keeps a row even if they owe nothing now.
  for (const pid of Object.keys(split?.payments || {})) if (byId.has(pid) && !(pid in owed)) owed[pid] = 0;

  const rows = Object.keys(owed).map(pid => {
    const p = byId.get(pid);
    const self = pid === payeeId;
    const payments = self ? [] : (split?.payments?.[pid] || []);
    const owedCents = owed[pid];
    const paidCents = self ? owedCents : sumPayments(payments);
    const balanceCents = owedCents - paidCents;
    const claim = (!self && split?.claims?.[pid]) || null;
    const status = self ? 'self'
      : balanceCents > 0 ? (claim ? 'claim' : 'owes')
      : (owedCents > 0 || paidCents > 0) ? 'paid' : 'none';
    return {
      playerId: pid, name: p.name || 'Player', self, isSub: !!p.isSub, archived: !!p.archived,
      hasEmail: !!p.email,
      overrideCents: mode === 'flat' && Number.isInteger(split?.overrides?.[pid]) ? split.overrides[pid] : null,
      games: games[pid] || 0, weeks: weeks[pid] || [],
      // pergame + buy-in: what their games have cost so far, and how much of the buy-in is left
      usedCents: used[pid] || 0,
      playerRate: mode === 'pergame' && split?.playerRates?.[pid] && Number.isInteger(split.playerRates[pid].cents) ? { mode: split.playerRates[pid].mode, cents: split.playerRates[pid].cents } : null,
      buyInLeftCents: buyIn > 0 && pid in used ? Math.max(0, buyIn - used[pid]) : 0,
      owedCents, paidCents, balanceCents, claim, status, payments,
      lastNudgedOn: split?.nudges?.[pid] || null,
    };
  });

  const order = { claim: 0, owes: 1, none: 2, paid: 3, self: 4 };
  rows.sort((a, b) => (order[a.status] - order[b.status]) || a.name.localeCompare(b.name));

  const totalCents = rows.reduce((s, r) => s + r.owedCents, 0);
  const outstandingCents = rows.reduce((s, r) => s + Math.max(0, r.balanceCents), 0);
  return {
    mode, payeeId, payeeName: payee?.name || null, buyInCents: buyIn, lastPlayedWeek,
    rateHistory: mode === 'pergame' && Array.isArray(split?.rateHistory) ? split.rateHistory : null,
    rows, unassignedCents,
    totals: {
      totalCents, outstandingCents,
      collectedCents: totalCents - outstandingCents,
      gamesBilled: rows.reduce((s, r) => s + r.games, 0),
      claims: rows.filter(r => r.status === 'claim').length,
      owing: rows.filter(r => r.balanceCents > 0).length,
    },
  };
}

/** The slice of a ledger one player is allowed to see: their own row only. */
export function playerView(ledger, playerId) {
  const r = ledger.rows.find(x => x.playerId === playerId);
  if (!r) return null;
  return {
    mode: ledger.mode, self: r.self,
    owedCents: r.owedCents, paidCents: r.paidCents, balanceCents: r.balanceCents,
    games: r.games, weeks: r.weeks, claim: r.claim, status: r.status,
    usedCents: r.usedCents, buyInLeftCents: r.buyInLeftCents, buyInCents: ledger.buyInCents || 0,
    playerRate: r.playerRate,
    payments: r.payments.map(p => ({ cents: p.cents, at: p.at, method: p.method })),
  };
}
