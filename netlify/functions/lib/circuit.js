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

// The season id ("circuit-i") for a given circuit code ("I").
export function seasonIdForCircuit(code) {
  return 'circuit-' + circuitCode(code).toLowerCase();
}
