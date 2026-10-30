// netlify/functions/lib/skill-bands.js
//
// "Performance vs. Skill Level" for player profiles — the DUPR-style
// breakdown of a player's win rate by how strong the other side of the net was.
//
// Pure: no blobs, no I/O. public-player.js feeds it the season's game log
// (each game already carries `oppDsr`, the opponents' average DSR as of that
// week, and `partnerDsr`) plus every rated player's DSR for the season.
//
// THE BANDS
//   The season's rated players are split into fifths by DSR (quintiles). Those
//   five DSR ranges are the bands: "vs. 31–42", "vs. 42–48", … A game falls in
//   the band that holds the opponents' average DSR. Splitting by the league's
//   own spread (instead of fixed cut-offs) keeps every band populated whatever
//   the season's numbers look like, and lets the bottom and top bands stretch
//   to cover anything outside the range.
//
//   Career rolls every season's games up by band index (bottom fifth … top
//   fifth). The DSR ranges differ season to season, so career rows are labelled
//   by tier, not by range.
//
// THE TAG on each band comes from the win rate, the way DUPR labels it:
//   ≥ 80% Dominant · ≥ 55% Strong · ≥ 40% Growing · below that Challenge.
//   Fewer than MIN_GAMES games in a band: "Small sample" and no verdict.
//
// THE READ (one sentence under the rows) may only say what the rows show. See
// readFor() — every branch states numbers that are on the screen.

export const TIERS = ['Bottom fifth', 'Lower-middle', 'Middle', 'Upper-middle', 'Top fifth'];
export const MIN_GAMES = 3;          // below this a band shows "Small sample"
const MIN_RATED = 10;                // fewer rated players than this → no bands

const r1 = v => (v == null || !Number.isFinite(+v)) ? null : Math.round(+v * 10) / 10;

/**
 * Five DSR bands from the season's rated players.
 * `values` is every player's DSR for the season (nulls ignored).
 * Returns [{ lo, hi }] × 5 (lo inclusive, hi exclusive except the last), or
 * null when there aren't enough rated players for fifths to mean anything.
 */
export function bandEdges(values) {
  // Unrated players come through as null — drop them before Number() turns them into 0.
  const v = (values || []).filter(x => x != null && x !== '').map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < MIN_RATED) return null;
  const q = p => {
    // Linear-interpolated quantile.
    const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return v[lo] + (v[hi] - v[lo]) * (i - lo);
  };
  const cuts = [v[0], q(0.2), q(0.4), q(0.6), q(0.8), v[v.length - 1]].map(r1);
  // A degenerate spread (everyone on the same rating) can't be banded.
  if (cuts[5] - cuts[0] <= 0) return null;
  const out = [];
  for (let i = 0; i < 5; i++) out.push({ lo: cuts[i], hi: cuts[i + 1] });
  return out;
}

/** Index 0–4 of the band holding `dsr`; values outside the range clamp to the ends. */
export function bandOf(dsr, edges) {
  if (!edges || dsr == null || !Number.isFinite(+dsr)) return null;
  const d = +dsr;
  for (let i = 0; i < edges.length - 1; i++) if (d < edges[i].hi) return i;
  return edges.length - 1;
}

export function tagFor(pct, played) {
  if (!played || played < MIN_GAMES) return 'sample';
  if (pct >= 80) return 'dominant';
  if (pct >= 55) return 'strong';
  if (pct >= 40) return 'growing';
  return 'challenge';
}

const mean = (sum, n) => (n ? r1(sum / n) : null);

/**
 * Tally games into the five bands.
 *
 *   games:  [{ won: true|false|null, oppDsr, partnerDsr, band? }]
 *           A game with `band` already set (career) keeps it; otherwise the
 *           band comes from `oppDsr` against `edges`. Ties / unscored (won null)
 *           and games without an opponent rating are left out.
 *   edges:  bandEdges() output, or null for the career roll-up.
 *   opts.myDsr  the player's own DSR — marks the band they sit in ("you").
 *
 * Returns null when there is nothing to show; otherwise
 *   { bands: [{ idx, tier, lo, hi, played, w, l, pct, tag, partner, opp }] (all five,
 *     bottom → top), you, games, partner, read }
 */
export function summarize(games, edges, opts = {}) {
  const acc = TIERS.map((tier, idx) => ({
    idx, tier, lo: edges ? edges[idx].lo : null, hi: edges ? edges[idx].hi : null,
    w: 0, l: 0, pS: 0, pN: 0, oS: 0, oN: 0,
  }));
  let n = 0, pSum = 0, pN = 0;
  for (const g of (games || [])) {
    if (g.won !== true && g.won !== false) continue;
    const idx = Number.isInteger(g.band) ? g.band : bandOf(g.oppDsr, edges);
    if (idx == null || !acc[idx]) continue;
    const b = acc[idx];
    if (g.won) b.w++; else b.l++;
    if (g.partnerDsr != null && Number.isFinite(+g.partnerDsr)) { b.pS += +g.partnerDsr; b.pN++; pSum += +g.partnerDsr; pN++; }
    if (g.oppDsr != null && Number.isFinite(+g.oppDsr)) { b.oS += +g.oppDsr; b.oN++; }
    n++;
  }
  if (!n) return null;

  const bands = acc.map(b => {
    const played = b.w + b.l;
    const pct = played ? Math.round(b.w / played * 100) : null;
    return { idx: b.idx, tier: b.tier, lo: b.lo, hi: b.hi, label: edges ? rangeLabel(b.idx, b.lo, b.hi) : null, played, w: b.w, l: b.l, pct,
      tag: played ? tagFor(pct, played) : null, partner: mean(b.pS, b.pN), opp: mean(b.oS, b.oN) };
  });
  const you = (edges && opts.myDsr != null) ? bandOf(opts.myDsr, edges) : null;
  const partner = mean(pSum, pN);
  return { bands, you, games: n, partner, read: readFor(bands, partner, !!edges) };
}

/**
 * How a band's DSR range reads on screen. The end bands are open-ended (they
 * also catch everything outside the league's range, and the bottom of the
 * league can dip below zero), so they read "under 30" and "56+".
 */
export function rangeLabel(idx, lo, hi) {
  if (lo == null || hi == null) return null;
  if (idx === 0) return `under ${Math.round(hi)}`;
  if (idx === TIERS.length - 1) return `${Math.round(lo)}+`;
  return `${Math.round(lo)}–${Math.round(hi)}`;
}

/** Best / toughest band among those with a real sample. Ties on win rate go
 *  to the bigger sample (9–0 beats 3–0), then the stronger / weaker band. */
export function bestWorst(bands) {
  const sampled = (bands || []).filter(b => b.played >= MIN_GAMES);
  if (sampled.length < 2) return {};
  let best = sampled[0], worst = sampled[0];
  for (const b of sampled) {
    if (b.pct > best.pct || (b.pct === best.pct && (b.played > best.played || (b.played === best.played && b.idx > best.idx)))) best = b;
    if (b.pct < worst.pct || (b.pct === worst.pct && (b.played > worst.played || (b.played === worst.played && b.idx < worst.idx)))) worst = b;
  }
  return (best.idx === worst.idx || best.pct === worst.pct) ? {} : { best, worst, sampled };
}

/**
 * One sentence, only from numbers the rows show. Needs two bands with a real
 * sample; otherwise null (the card shows no read).
 *
 *  1. Partner explains a dip: the toughest band is NOT the top one, and its
 *     average partner is the lowest of the sampled bands and at least 2 DSR
 *     under the player's season average partner.
 *  2. Otherwise: best and toughest band, side by side.
 */
export function readFor(bands, partnerAvg, ranged = true) {
  const { best, worst, sampled } = bestWorst(bands);
  if (!best) return null;
  const name = b => ranged && b.lo != null ? `vs. ${b.label || `${Math.round(b.lo)}–${Math.round(b.hi)}`}` : `vs. the ${b.tier.toLowerCase()}`;

  const withPartner = sampled.filter(b => b.partner != null);
  const lowestPartner = withPartner.reduce((m, b) => (m == null || b.partner < m.partner ? b : m), null);
  const topSampled = sampled[sampled.length - 1];
  if (worst !== topSampled && lowestPartner && lowestPartner.idx === worst.idx
      && partnerAvg != null && worst.partner <= partnerAvg - 2) {
    return `Your toughest band (${name(worst)}, ${worst.pct}%) is also where your partners averaged the lowest DSR — ${worst.partner.toFixed(1)}, against ${partnerAvg.toFixed(1)} across all your games.`;
  }
  return `Best results ${name(best)} (${best.pct}%, ${best.w}–${best.l}); toughest ${name(worst)} (${worst.pct}%, ${worst.w}–${worst.l}).`;
}
