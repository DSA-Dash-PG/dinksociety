// netlify/functions/lib/current-season.js
//
// WHICH SEASON IS "NOW"?
//
// Every public page used to answer this with the literal string 'circuit-i',
// which meant Season 2 would have stayed invisible until someone edited code on
// opening night. This resolves it from the season records instead.
//
// The rule: a season takes over ONE WEEK BEFORE its start date. That week is
// when captains are building rosters and players are looking for the schedule,
// so the site should already be pointed at the new season while the old one is
// still the last thing that happened.
//
// Everything here is pure — `now` is injected — so the flip is unit-testable
// rather than something you find out about on the night.

import { seasonCircuitCode } from './circuit.js';

/** How far ahead of its start date a season becomes the live one. */
export const FLIP_LEAD_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight local-ish parse of a YYYY-MM-DD start date. Null when unusable. */
export function startMs(season) {
  const d = String(season?.startDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = new Date(d + 'T00:00:00Z').getTime();
  return Number.isNaN(t) ? null : t;
}

/** The moment a season takes over: its start date minus the lead. */
export function flipMs(season) {
  const s = startMs(season);
  return s == null ? null : s - FLIP_LEAD_DAYS * DAY_MS;
}

/**
 * Pick the season the site should show by default.
 *
 * Candidates are everything public (the caller has already dropped test and
 * archived seasons). Among those that have flipped, the LATEST start wins — so
 * a new season takes over and an old one steps down on the same date. Before
 * any has flipped, the soonest upcoming one leads; with no dates at all, the
 * list order stands.
 *
 * @param {object[]} seasons
 * @param {number} now epoch ms
 * @returns {object|null}
 */
export function pickCurrentSeason(seasons, now = Date.now()) {
  const list = (seasons || []).filter(Boolean);
  if (!list.length) return null;

  const dated = list.filter(s => startMs(s) != null);
  if (!dated.length) return list[0];

  const flipped = dated.filter(s => flipMs(s) <= now);
  if (flipped.length) {
    return flipped.reduce((best, s) => (startMs(s) > startMs(best) ? s : best));
  }
  // Nothing has flipped yet — the soonest one on the calendar leads.
  return dated.reduce((best, s) => (startMs(s) < startMs(best) ? s : best));
}

/**
 * The compact shape pages need: which season is live, and when the next one
 * takes over (handy for an admin sanity-check, and it costs nothing to send).
 */
export function currentSeasonInfo(seasons, now = Date.now()) {
  const current = pickCurrentSeason(seasons, now);
  if (!current) return null;
  const next = (seasons || [])
    .filter(s => flipMs(s) != null && flipMs(s) > now)
    .sort((a, b) => flipMs(a) - flipMs(b))[0] || null;
  return {
    id: current.id || null,
    circuit: seasonCircuitCode(current),
    name: current.name || current.label || null,
    startDate: current.startDate || null,
    // ISO of the moment the NEXT season takes over, when there is one.
    nextFlipsAt: next ? new Date(flipMs(next)).toISOString() : null,
    nextName: next ? (next.name || next.label || null) : null,
  };
}
