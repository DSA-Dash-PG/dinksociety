# The Dink Society — Architecture B Bundle

Complete file set for Circuit I. Drop-in replacement for the `netlify/functions/` folder plus fresh/updated page files.

---

## What's in this bundle

```
dink-society/
├── INSTALL.md                 ← you're reading it
├── admin.html                 ← repo root
├── captain.html               ← repo root
├── index.html                 ← repo root
├── leaderboard.html           ← repo root (new)
├── moments.html               ← repo root
├── register-success.html      ← repo root
├── register.html              ← repo root
├── rules.html                 ← repo root (new)
├── css/
│   └── shared-nav.css         ← /css/ (new — append to shared.css OR include separately)
├── partials/
│   └── nav.html               ← /partials/ (REPLACES your existing nav partial)
├── netlify/
│   └── functions/
│       ├── lib/               ← helpers (imported by endpoints)
│       │   ├── admin-auth.js
│       │   ├── captain-auth.js
│       │   ├── email.js
│       │   └── standings.js   ← the file that was in the wrong place (fixes your build error)
│       ├── admin-generate-schedule.js
│       ├── admin-login.js
│       ├── admin-logout.js
│       ├── admin-matches.js
│       ├── admin-overview.js
│       ├── admin-rebuild-standings.js
│       ├── admin-registrations.js
│       ├── admin-seed-teams.js
│       ├── admin-whoami.js
│       ├── captain-lineup.js
│       ├── captain-link.js
│       ├── captain-login.js
│       ├── captain-logout.js
│       ├── captain-roster.js
│       ├── captain-schedule.js
│       ├── captain-score.js
│       ├── captain-whoami.js
│       ├── moments-delete.js
│       ├── moments-image.js
│       ├── moments-list.js
│       ├── moments-upload.js
│       ├── public-leaderboard.js
│       ├── register-checkout.js
│       ├── registration-lookup.js
│       └── stripe-webhook.js
└── docs/
    └── README.md              ← for reference (doesn't need to deploy)
```

**Counts:** 8 pages, 2 asset files (css + nav partial), 25 function endpoints, 4 lib helpers.

---

## Install steps

### 1. Wipe the old `netlify/functions/` folder
In your local repo clone:
```bash
cd just-dink-it
rm -rf netlify/functions
rm -rf lib/                    # if it exists at repo root (Architecture A leftover)
```

### 2. Drop in the new structure
Unzip this bundle. Copy its contents into your repo root, preserving folder structure:
```
bundle/netlify/functions/   →  your-repo/netlify/functions/
bundle/partials/nav.html    →  your-repo/partials/nav.html (overwrite)
bundle/css/shared-nav.css   →  your-repo/css/shared-nav.css
bundle/*.html               →  your-repo/ (overwrite existing)
```

### 3. Delete Architecture A pages if they exist
```bash
rm -f team.html player.html season.html
```

### 4. Update `netlify.toml`
Remove these redirects (they point at Architecture A pages):
```toml
# DELETE these:
[[redirects]]
  from = "/teams/:slug"
  to = "/team.html?slug=:slug"

[[redirects]]
  from = "/players/:slug"
  to = "/player.html?slug=:slug"

[[redirects]]
  from = "/seasons/:id"
  to = "/season.html?id=:id"
```

**Keep** `/api/*`, `/admin/*`, `/captain/*` redirects as-is.

### 5. Check `/css/shared.css`
The `shared-nav.css` file has hamburger drawer styles that need to be in your CSS. Two options:

- **Option A (simpler):** Open `css/shared-nav.css` and append its contents to your existing `css/shared.css`. Delete `shared-nav.css`.
- **Option B (modular):** Leave `shared-nav.css` as-is. Every page that uses the nav partial needs this in its `<head>`:
  ```html
  <link rel="stylesheet" href="/css/shared-nav.css">
  ```
  (Pages in this bundle already have this link tag.)

Pick one. Don't do both.

### 6. Commit + push
```bash
git add -A
git commit -m "Reconcile to Architecture B: clean functions folder, add leaderboard + rules + mobile nav"
git push
```

Netlify should build successfully.

---

## Environment variables to verify in Netlify dashboard

All of these need to be set for the site to work:

**Stripe:**
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_SUCCESS_URL` (optional — falls back to site URL)
- `STRIPE_CANCEL_URL` (optional)

**Email:**
- `RESEND_API_KEY`
- `EMAIL_FROM` (e.g. `"The Dink Society <noreply@dinksociety.com>"`)
- `EMAIL_REPLY_TO` (optional)
- `EMAIL_ADMIN_BCC` (optional)

**Supabase (admin portal auth only — captains use magic links):**
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_EMAILS` (comma-separated)

**General:**
- `SITE_URL` (e.g. `https://dinksociety.netlify.app`) — **critical for magic-link URLs**

---

## First-run smoke test

After your next successful deploy:

1. Visit `/` — homepage loads, hamburger appears on mobile
2. Visit `/leaderboard.html` — shows "no data yet" empty state (expected, no matches finalized yet)
3. Visit `/rules.html` — rules render
4. Visit `/captain.html` — magic-link login screen
5. Visit `/admin.html` — Supabase login screen
6. Sign into admin → Overview tab loads stats
7. Admin → Schedule tab → dropdowns populate

If any of those fail with a 500 or blank page, the error surfaces in Netlify function logs. Most common issues:
- Missing env var → endpoint throws on import
- Missing blob store permissions → first write to a new store fails silently until Netlify provisions it
- Typo in a Supabase admin email → `ADMIN_EMAILS` check fails

---

## Known post-install cleanup

**Blobs data from Architecture A:** if you ran any seed/test flows on the old codebase, you may have orphaned blob stores like `seasons/`, `sponsors/`, `players/`, `roster/`. They won't hurt anything but you can clean them via Netlify dashboard → Blobs if you want a clean slate.

**Supabase tables:** Architecture A may have created tables in Supabase for seasons/divisions/etc. Those are just dead rows — ignore or drop manually if you care.

**Package.json dependencies:** Architecture A required `stripe`, `@supabase/supabase-js`, `@netlify/blobs`. Architecture B requires the same set plus `resend` (if you added it). Check your `package.json` — if `resend` is missing, add it:
```bash
npm install resend
```

---

## What comes next (after this deploy is green)

1. **End-to-end test with fake data.** Admin seeds a schedule → two test captains sign in → lock lineups → enter scores → submit → verify leaderboard updates.
2. **Create the Claude Project.** Copy the canonical file structure + architecture notes into project instructions so future chats start pre-loaded.
3. **Invite the first batch of real captains.** Circuit I starts mid-May 2026.
