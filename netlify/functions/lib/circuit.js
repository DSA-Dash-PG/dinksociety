// netlify/functions/lib/circuit.js
//
// Canonical circuit-code resolution.
//
// Blobs (schedule, standings, player-stats) are keyed by the circuit CODE —
// a short token like "I", "II", or "TEST". Unfortunately several places have
// historically stored other things in a team's `circuit` field:
//
//   - the season display name  ("Season 1")   ← register.html sends this
//   - the season id            ("circuit-i")  ← register-checkout fallback
//   - the code itself          ("I")          ← the correct value
//   - nothing at all           (undefined)
//
// Any of those must resolve to the same canonical code so that team-keyed
// reads (player-me, captain-schedule, standings rebuild) look in the same
// place the schedule generator and public pages write to.
//
// circuitCode('Season 1')   -> 'I'
// circuitCode('circuit-i')  -> 'I'
// circuitCode('I')          -> 'I'
// circuitCode('circuit-test') -> 'TEST'
// circuitCode('TEST')       -> 'TEST'
// circuitCode(undefined)    -> 'I'   (the default / only live circuit)

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

function intToRoman(n) {
  return (n >= 1 && n <= 10) ? ROMAN[n - 1] : String(n);
}

export function circuitCode(raw) {
  if (raw == null || raw === '') return 'I';
  const s = String(raw).trim();

  // Already a bare code: roman numeral or a known keyword like TEST.
  if (/^(TEST|[IVX]+)$/i.test(s)) return s.toUpperCase();

  // Season id form: "circuit-i", "circuit-test", "circuit-ii".
  if (/^circuit-/i.test(s)) {
    const tail = s.replace(/^circuit-/i, '').trim();
    // numeric season id ("circuit-1") -> roman
    if (/^\d+$/.test(tail)) return intToRoman(parseInt(tail, 10));
    return tail.toUpperCase();
  }

  // Display-name form: "Season 1", "Season 2".
  const m = s.match(/season\s*(\d+)/i);
  if (m) return intToRoman(parseInt(m[1], 10));

  // Fallback: assume it's already a code-ish token.
  return s.toUpperCase();
}

// Customer-facing name for a circuit code. Storage stays keyed by the code
// ("I", "II", "TEST"); everything a player reads says "Season 1".
//   seasonName('I') -> 'Season 1'   seasonName('TEST') -> 'Test Season'
export function seasonName(raw) {
  const code = circuitCode(raw);
  if (code === 'TEST') return 'Test Season';
  const i = ROMAN.indexOf(code);
  return i >= 0 ? `Season ${i + 1}` : `Season ${code}`;
}

// Is this a real code we know how to key blobs with?
const CANONICAL = new Set([...ROMAN, 'TEST']);
export function isCanonicalCode(code) { return CANONICAL.has(String(code || '').toUpperCase()); }

/**
 * The canonical code for a SEASON RECORD, trying its id and then its name.
 *
 * A season's id is not guaranteed to look like "circuit-1" — it can be a slug
 * or a generated key, and circuitCode() would then hand back that token
 * verbatim ("SEASON-1", "S_9F2C"), which matches no standings or player-stats
 * blob. Falling back to the display name ("Season 1" -> "I") is what keeps the
 * public pages pointed at the data that actually exists.
 */
export function seasonCircuitCode(season) {
  const fromId = circuitCode(season?.id);
  if (isCanonicalCode(fromId)) return fromId;
  for (const raw of [season?.circuit, season?.name, season?.label]) {
    if (!raw) continue;
    const c = circuitCode(raw);
    if (isCanonicalCode(c)) return c;
  }
  return fromId;
}

// The season id ("circuit-i") for a given circuit code ("I").
export function seasonIdForCircuit(code) {
  return 'circuit-' + circuitCode(code).toLowerCase();
}

// Is this team part of the isolated QA test season? The seeder tags every test
// team with isTest:true and keys them under the TEST circuit / circuit-test id,
// so check all three for safety. Used to keep test teams out of the team switcher
// so they can never shadow a real-season team.
export function isTestTeam(team) {
  if (!team) return false;
  if (team.isTest === true) return true;
  if (team.seasonId === 'circuit-test') return true;
  return circuitCode(team.circuit) === 'TEST';
}
