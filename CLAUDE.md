# Dink Society — working notes for Claude

## Source of truth: ALWAYS use this local repo

**Never** read the deployed site, browser DOM, or the project-knowledge cache to determine
how something works. Those are stale or incomplete. Read the files in this repo directly.

- Repo root: `C:\Github\dinksociety` (Linux sandbox: `/sessions/zen-festive-cerf/mnt/dinksociety/`)
- GitHub remote: `github.com/DSA-Dash-PG/dinksociety`
- **Netlify publish directory is `public/`** — editing files at the repo root has no effect
  on the deployed site. Always edit under `public/`.
- Netlify Functions live in `netlify/functions/` (v2 format).
- Shared function helpers live in `netlify/functions/lib/` (NOT `netlify/lib/`).

Only fall back to the live site when specifically diagnosing a deploy/runtime issue
(e.g. "is the latest commit actually live?"), and say so explicitly.

## Before changing anything

1. `grep` / read the actual file in `public/` or `netlify/functions/`.
2. Confirm the real data shape before writing code against it (schema-first).
3. Prefer surgical edits; use complete replacement files only when the scope is large.
4. Deliver drop-in ready output — no manual editing steps, no post-processing scripts.

## Stack

Netlify (hosting, Functions v2, Blobs, env vars) · Stripe (payments) ·
Resend (email, `FROM_EMAIL`) · Anthropic API (recap generation) · Capacitor 8 (native scaffolding)

## Design system — "Night-Match"

- Background `#0e0e0e`, primary accent electric lime `#b8ff2c`, secondary teal `#17d7b0`
- Inter 800 uppercase headings, pill buttons (`border-radius: 9999px`), no serif fonts
- Tokens in `shared.css`; nav/footer in `shared-nav.css`
- `compat.css` conflicts with this theme and should be deleted
- Google Fonts via `<link>` in `<head>`, never CSS `@import`
- Theme toggle must explicitly set `data-theme="dark"`; every page needs an inline theme
  init script before CSS links; persists via `localStorage` key `ds-theme`
- Admin/captain login links go in the **footer only**, not the nav
- `public/js/partials.js` must exist or nav/footer disappear entirely

## Gotchas

- Auth: `requireAdmin(req)` **throws** on failure — callers must wrap in try/catch.
  Admin and captain portals both use magic-link login (email only, no password).
- Blob keys for registrations are prefixed (`confirmed/`, `pending/`, `rejected/`).
  Bare keys are a legacy bug. `findTeamByCaptainEmail` must scan the `registrations`
  store with `prefix: 'confirmed/'`, matching `reg.team.players[0].email`.
- The Stripe webhook already converts cents to dollars — do not divide by 100 downstream.
- **Bracket weeks (Rivalry / playoff / championship) are real match records**, not hardcoded
  page JS. `netlify/functions/lib/bracket.js` defines the phases and, for 6 teams, three
  rivalry slots (`rank 1v2`, `3v4`, `5v6`); `lib/courts.js` supplies `COURT_SETS`.
  `public-schedule.js` uses persisted bracket blobs when they exist and otherwise
  synthesizes them via `buildBracketWeeks()`, so the bracket always renders. Matches carry
  real `courtA`/`courtB` — **per-match court values always win** over the `COURT_SET_META`
  labels in `schedule.html` / `index.html`, which are only a color source and a legacy
  fallback. (That's why live courts read `5A & 5B` rather than the default `1 & 2`.)
- **Scores go public per game, not per match.** `captain-score.js`: home captain enters,
  away captain confirms; a game is CONFIRMED only when away's confirmation matches home's
  entry, and a home edit clears the confirmation. `public-match.js` exposes only confirmed
  games — canonical `home`/`away` stay `null` until entries agree, so nothing unconfirmed
  is ever publicly visible. Note `matchPoints` (`scoreA`/`scoreB`) is written **only at
  finalize**; for a running score use games-won across confirmed games.

## Known open issues

- Partner impact on leaderboard/player detail shows only 3 partners — likely a `slice` limit.
- `ANTHROPIC_API_KEY` in Netlify env is invalid, so automated recap generation is broken.
