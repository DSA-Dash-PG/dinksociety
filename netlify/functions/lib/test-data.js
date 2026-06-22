// netlify/functions/lib/test-data.js
//
// Tiny, dependency-free predicates for keeping QA / demo data out of normal
// production and public views. Both the isolated TEST season (circuit-test)
// and the demo season (circuit-demo) are considered "test data".
//
// Read paths should EXCLUDE test/demo records by default and only include them
// when the request is explicitly targeting that season (e.g. ?season=circuit-demo).

export const TEST_SEASON_IDS = new Set(['circuit-test', 'circuit-demo']);

/** Is this seasonId one of the non-production (test/demo) seasons? */
export function isTestSeasonId(id) {
  return TEST_SEASON_IDS.has(String(id || '').toLowerCase());
}

/** Does this record carry the isTest marker? (teams, matches, regs, seasons …) */
export function isTestRecord(obj) {
  return !!(obj && obj.isTest === true);
}

/**
 * Should a record be hidden from the view currently being requested?
 * Hide test/demo records unless the caller is explicitly looking at a
 * test/demo season.
 */
export function shouldHideTestRecord(obj, requestedSeasonId) {
  if (!isTestRecord(obj)) return false;          // production data: always show
  return !isTestSeasonId(requestedSeasonId);     // test data: only when targeted
}
