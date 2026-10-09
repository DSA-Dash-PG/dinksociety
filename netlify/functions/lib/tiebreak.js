// netlify/functions/lib/tiebreak.js
//
// The ONE ordering rule for league standings (pure, no I/O). Used by
// lib/standings.js (the table and seeding ranks) and lib/bracket.js (bracket
// seeds). The public pages that rebuild a table in the browser carry an inline
// copy, dsSortStandings() — standings.html, index.html, ranking-trajectory.html.
// Change the rule here and there together, and on rules.html.
//
//   1. PTS   match points
//   2. GW    games won
//   3. H2H   head-to-head match points — ONLY when exactly two teams are level
//            on PTS and GW
//   4. DIFF  rally-point differential (scored − against)
//   5. PS    rally points scored
//   then team name, so the order never depends on the order teams came in.
//
// Three or more teams level on PTS and GW skip head-to-head and go straight to
// DIFF: pairwise head-to-head can run in a circle (A beat B, B beat C, C beat A)
// and has no fair answer. Two teams that split their meetings evenly, or have
// not met yet, also fall through to DIFF.
//
// `f` reads the fields off whatever row shape the caller has:
//   { pts(t), gw(t), diff(t), ps(t), name(t), h2h(a, b) }
// h2h(a, b) = the match points a took off b, or null if they have not met.

export function sortStandings(items, f) {
  const base = [...items].sort((a, b) => (f.pts(b) - f.pts(a)) || (f.gw(b) - f.gw(a)));
  const rest = (a, b) =>
    (f.diff(b) - f.diff(a)) || (f.ps(b) - f.ps(a)) || String(f.name(a)).localeCompare(String(f.name(b)));
  const out = [];
  for (let i = 0; i < base.length;) {
    let j = i + 1;
    while (j < base.length && f.pts(base[j]) === f.pts(base[i]) && f.gw(base[j]) === f.gw(base[i])) j++;
    const group = base.slice(i, j);
    if (group.length === 2) {
      const ab = f.h2h(group[0], group[1]), ba = f.h2h(group[1], group[0]);
      if (ab != null && ba != null && ab !== ba) { if (ba > ab) group.reverse(); }
      else group.sort(rest);
    } else {
      group.sort(rest);
    }
    out.push(...group);
    i = j;
  }
  return out;
}
