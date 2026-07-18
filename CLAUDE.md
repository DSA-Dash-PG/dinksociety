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

## Known open issues

- **Rivalry Week (Week 6) cards on the schedule are hardcoded in the page JS**, not real
  match records — courts `1 & 2`, `3 & 6`, `5 & 7` are literal strings and the pairings are
  derived client-side from standings. Admin can't see or edit them. Fix: create real match
  rows and render Week 6 from the DB like every other week, applying seed badges from
  standings at render time.
- Partner impact on leaderboard/player detail shows only 3 partners — likely a `slice` limit.
- `ANTHROPIC_API_KEY` in Netlify env is invalid, so automated recap generation is broken.
