// netlify/functions/lib/week-dates.js
//
// Planned game-night dates, keyed by SEASON.
//
// A "planned week date" lets an admin publish when Week 6 will be played
// before that week's matchups exist, so the public schedule can show a date
// instead of falling back to "start date + 7n". It is only ever a fallback —
// a real match's scheduledAt always wins.
//
// These used to be stored league-wide as a flat { "<week>": <iso> } map, which
// meant Season 1's planned dates leaked into Season 2's schedule: Season 2 had
// no matchups yet, so weeks 5-8 rendered Season 1's July dates while weeks 1-4
// (with no stored date) correctly computed off Sep 17. Storage is now keyed by
// circuit CODE — the same canonical key the schedule/standings blobs use, so
// "season-2", "circuit-ii" and "Season 2" all land in the same bucket:
//
//   { "I": { "5": "2026-07-14T02:00:00.000Z" }, "II": { "3": "..." } }
//
// A legacy flat map is migrated on read to the season that was current when it
// was written — settings.circuitName names that season.

import { circuitCode } from './circuit.js';

/** True when `v` looks like the old flat { "<week>": "<iso>" } shape. */
function isLegacyFlat(v) {
  if (!v || typeof v !== 'object') return false;
  return Object.values(v).some(x => typeof x === 'string');
}

/** Keep only { "<week>": "<iso string>" } pairs. */
function cleanBucket(bucket) {
  const out = {};
  if (!bucket || typeof bucket !== 'object') return out;
  for (const [week, iso] of Object.entries(bucket)) {
    if (!/^\d+$/.test(String(week))) continue;
    if (typeof iso !== 'string' || !iso.trim()) continue;
    out[String(Number(week))] = iso;
  }
  return out;
}

/**
 * Normalize whatever is stored into { [CODE]: { [week]: iso } }.
 * `legacyOwner` is anything circuitCode() understands (settings.circuitName);
 * a flat legacy map is attributed to it.
 */
export function normalizeWeekDates(raw, legacyOwner) {
  if (!raw || typeof raw !== 'object') return {};
  if (isLegacyFlat(raw)) {
    const flat = cleanBucket(raw);
    return Object.keys(flat).length ? { [circuitCode(legacyOwner)]: flat } : {};
  }
  const out = {};
  for (const [key, bucket] of Object.entries(raw)) {
    const cleaned = cleanBucket(bucket);
    if (!Object.keys(cleaned).length) continue;
    const code = circuitCode(key);
    out[code] = { ...(out[code] || {}), ...cleaned };
  }
  return out;
}

/**
 * The planned dates for one season, as a flat { [week]: iso } map.
 * `season` may be a code, a season id, or a season name.
 */
export function weekDatesFor(raw, season, legacyOwner) {
  const all = normalizeWeekDates(raw, legacyOwner);
  return all[circuitCode(season)] || {};
}
