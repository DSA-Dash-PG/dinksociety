# The Dink Society — Frontend Package

All components for the Dink Society site, built around the Circuit I framing.

**Brand:** The Dink Society (rebranded from Just Dink It)
**Instagram:** [@dinksociety.pb](https://instagram.com/dinksociety.pb)
**Current hosting:** `justdinkit.netlify.app` — new domain in progress. Update any hardcoded URLs when the new domain goes live (see "Domain migration" at the bottom).

---

## File placement

```
justdinkit/
├── index.html                                ← paste hero + how-it-works blocks inside
├── moments.html
├── register.html
├── register-success.html
└── netlify/
    └── functions/
        ├── lib/
        │   └── email.js                      ← shared Resend library
        ├── moments-list.js
        ├── moments-upload.js                 ← GATE with admin auth before production
        ├── moments-image.js
        ├── register-checkout.js              ← creates Stripe Checkout session
        ├── registration-lookup.js            ← fetches redacted registration for success page
        └── stripe-webhook.js                 ← confirms registration + sends email
```

---

## 1. Hero section

**File:** `hero.html`

Drop into `index.html` as the homepage hero. Self-contained; all classes prefixed `ds-hero__`. CTAs link to `/register.html` and `#how-it-works`. Hero tag reads Circuit I; stat row uses `Circuit / I · May 2026`.

---

## 2. How it works section

**File:** `how-it-works.html`

Drop into `index.html` directly below the hero. `id="how-it-works"` matches the hero's secondary CTA anchor. All classes prefixed `ds-how__`. Covers Format, A night at the Society, Circuit points, Dues & registration. Framed around the Circuit model: one Circuit covers all divisions, seven weeks, gold medals per division, points carry across Circuits.

---

## 3. Moments page

**File:** `moments.html` — drop at site root.

Full photo gallery with Circuit + Week filtering, sort, lightbox, upload modal. Week chips run 1-7; Circuit chips auto-grow as new Circuits appear in data. When "All circuits" is selected and photos span multiple circuits, results group under Circuit headers with Roman numerals.

### Storage model (Netlify Blobs)

Store name: `moments`

| Key pattern       | What it holds                                             |
|-------------------|-----------------------------------------------------------|
| `img/<id>`        | Raw image binary with `contentType` metadata              |
| `meta/<id>.json`  | `{ id, circuit, week, caption, contentType, uploadedAt }` |

`<id>` is a 16-char hex. `circuit` is a Roman numeral. Legacy records without `circuit` are treated as `I` by both backend and frontend.

### Functions

- `moments-list.js` — GET all metadata. Adds `circuit: 'I'` to any legacy records missing the field.
- `moments-upload.js` — POST a file + `circuit` + `week` + `caption`. Gate this behind admin auth before production.
- `moments-image.js` — streams images by ID with immutable caching.

### Dependencies

```bash
npm install @netlify/blobs
```

### Gate the upload function

`moments-upload.js` currently accepts any POST. Before shipping, uncomment the auth stub at the top:

```js
// import { requireAdmin } from './lib/supabase-auth.js';
// const admin = await requireAdmin(req);
// if (!admin) return new Response(..., { status: 401 });
```

Also hide the "Upload photos" button on the frontend unless the Supabase session shows admin role.

---

## 4. Registration flow

**File:** `register.html` — drop at site root.

Four-step flow: Path → Details → Waiver → Review & pay. Team path ($450) asks for team name and 4 players with the first as captain. Free-agent path ($75) asks for name, contact, optional DUPR, and notes. Division picker: 3.0 Mixed (open), 3.5 Mixed (open), 3.5 Women's (disabled "coming soon"). Waiver + code of conduct both required.

`register-success.html` is the post-Stripe landing page.

### Backend: Stripe Checkout

- `register-checkout.js` — creates a Stripe Checkout Session, stashes a pending registration in Blobs.
- `stripe-webhook.js` — listens for `checkout.session.completed`, moves the pending registration to confirmed.

### Storage model for registrations (Netlify Blobs)

Store name: `registrations`

| Key pattern            | When it's written                                  |
|------------------------|----------------------------------------------------|
| `pending/<id>.json`    | At checkout creation (before payment)              |
| `confirmed/<id>.json`  | After the Stripe webhook confirms payment          |

The pending record is deleted once confirmed. If payment is abandoned, the pending record sticks around — clean up later or ignore.

### Dependencies

```bash
npm install stripe
```

### Required env vars (Netlify dashboard)

| Variable                 | Purpose                                                        |
|--------------------------|----------------------------------------------------------------|
| `STRIPE_SECRET_KEY`      | `sk_live_...` or `sk_test_...`                                 |
| `STRIPE_WEBHOOK_SECRET`  | `whsec_...` — from Stripe dashboard when you create the endpoint |
| `STRIPE_SUCCESS_URL`     | Optional override for success URL                              |
| `STRIPE_CANCEL_URL`      | Optional override for cancel URL                               |
| `SITE_URL`               | Fallback for building URLs                                     |

### Wire up the Stripe webhook

1. Stripe Dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://justdinkit.netlify.app/.netlify/functions/stripe-webhook`
3. Event: `checkout.session.completed`
4. Copy the webhook signing secret into `STRIPE_WEBHOOK_SECRET`
5. Test with `stripe trigger checkout.session.completed` from the Stripe CLI

### Success page flow

The success page (`register-success.html`) fetches the registration by ID via `registration-lookup.js` and renders a full receipt with:

- Captain's first name in the title (personalized)
- Circuit, Division, Team name, Captain (or "Registered as" for free agents), Reference ID

**Security model:** The lookup endpoint is public. Anyone with the 20-char hex ID can read the redacted registration. Emails, phone numbers, Stripe IDs, and full rosters are never exposed — only public-facing details. The ID has 80 bits of entropy, so treating it as a bearer token is safe for this non-sensitive use case.

**Pending state:** If the user hits the success page before the Stripe webhook has fired (rare but possible on slow networks), the page still shows a receipt from the `pending/` record with a "finalizing your confirmation" notice. Once the webhook lands, a refresh will show the confirmed state.

**No-ID fallback:** If the page is hit directly without an `?id=` param, it falls back to a generic "You're all set" state with no receipt.

### Email confirmation (Resend)

Confirmation emails are sent via [Resend](https://resend.com) through a shared library at `netlify/functions/lib/email.js`. The library is reusable — use it later for schedule announcements, match reminders, etc.

**Setup:**

1. Create a Resend account and verify your sending domain (e.g. `justdinkit.com`) — follow Resend's DNS instructions (SPF + DKIM records).
2. Create an API key at https://resend.com/api-keys.
3. Install the SDK:

   ```bash
   npm install resend
   ```

4. Set env vars in Netlify:

   | Variable            | Purpose                                                         |
   |---------------------|-----------------------------------------------------------------|
   | `RESEND_API_KEY`    | `re_...` from Resend dashboard                                  |
   | `EMAIL_FROM`        | `The Dink Society <hello@justdinkit.com>` — domain must be verified |
   | `EMAIL_REPLY_TO`    | Optional reply-to (e.g. `richard@justdinkit.com`)               |
   | `EMAIL_ADMIN_BCC`   | Optional admin BCC so you get copies of every confirmation      |

**File placement:**

```
netlify/functions/
├── lib/
│   └── email.js                ← shared email library
└── stripe-webhook.js           ← already imports from ./lib/email.js
```

**Safe-fail behavior:** If `RESEND_API_KEY` or `EMAIL_FROM` is missing, the library logs a warning and skips the send — the webhook still returns 200 and the registration is still confirmed. Email is nice-to-have, not blocking.

**The email itself** uses table-based HTML (required for Outlook/Gmail compatibility), embeds the Circuit/Division/Team/Roster/Reference in a styled receipt, and includes a "What's next" callout in teal/gold. Looks good in both light and dark mail clients since it's on white/cream backgrounds.

### Using the email lib elsewhere

```js
import { sendEmail } from './lib/email.js';

await sendEmail({
  to: 'captain@example.com',
  subject: 'Week 1 schedule is live',
  html: '<h1>Week 1</h1><p>Your first match is...</p>',
});
```

For branded emails matching the Society aesthetic, model new templates off the structure in `renderRegistrationConfirmation` — same palette, same table layout, same gradient header.

---

## 5. Leaderboard tab rename

The How-it-works section now refers to "the Circuit leaderboard." Your existing leaderboard page has a tab currently labeled **Society Circuit** — rename it to **Circuit Leaderboard** for consistency. I don't have the leaderboard page in this conversation, so this change is yours to make directly.

If your leaderboard tabs are defined like:

```js
const TABS = ['Players', 'Teams', 'League', 'Society Circuit', 'Search'];
```

Change to:

```js
const TABS = ['Players', 'Teams', 'League', 'Circuit Leaderboard', 'Search'];
```

And update whatever CSS/ID selector identifies that tab.

---

## File summary

| File                       | Destination                                            |
|----------------------------|--------------------------------------------------------|
| `hero.html`                | Paste block into `index.html`                          |
| `how-it-works.html`        | Paste block into `index.html` below the hero           |
| `moments.html`             | Repo root                                              |
| `register.html`            | Repo root                                              |
| `register-success.html`    | Repo root                                              |
| `email.js`                 | `netlify/functions/lib/email.js`                       |
| `moments-list.js`          | `netlify/functions/moments-list.js`                    |
| `moments-upload.js`        | `netlify/functions/moments-upload.js`                  |
| `moments-image.js`         | `netlify/functions/moments-image.js`                   |
| `register-checkout.js`     | `netlify/functions/register-checkout.js`               |
| `registration-lookup.js`   | `netlify/functions/registration-lookup.js`             |
| `stripe-webhook.js`        | `netlify/functions/stripe-webhook.js`                  |

---

## Pre-launch checklist

- [ ] Paste hero + how-it-works into `index.html`
- [ ] Deploy `moments.html` and its three functions
- [ ] Gate `moments-upload.js` behind Supabase admin auth
- [ ] Hide Moments upload button on frontend unless admin is signed in
- [ ] Deploy `register.html`, `register-success.html`, and the two Stripe functions
- [ ] Install `stripe` and `resend` npm packages
- [ ] Set Stripe env vars in Netlify (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, URLs)
- [ ] Register the Stripe webhook endpoint, copy secret to env
- [ ] Verify sending domain in Resend (SPF + DKIM DNS records)
- [ ] Set Resend env vars (`RESEND_API_KEY`, `EMAIL_FROM`, optional `EMAIL_ADMIN_BCC`)
- [ ] Deploy `lib/email.js`
- [ ] Rename Leaderboard tab to "Circuit Leaderboard"
- [ ] End-to-end test: team registration with Stripe test card `4242 4242 4242 4242`
- [ ] Verify confirmation email arrives and renders correctly (check Gmail + Apple Mail + Outlook)
- [ ] End-to-end test: free-agent registration
- [ ] Upload a few Moments photos; verify Circuit + Week filtering works

---

## Domain migration

When the new domain (e.g. `dinksociety.com`) goes live, update these places:

| File                           | What to change                                            |
|--------------------------------|-----------------------------------------------------------|
| `register-checkout.js`         | `SITE_URL` env var default in Netlify dashboard           |
| `stripe-webhook.js`            | Stripe dashboard: update webhook endpoint URL             |
| `email.js`                     | `EMAIL_FROM` env var (needs new verified domain in Resend) |
| Stripe dashboard               | Business profile / statement descriptor                    |
| Resend dashboard               | Verify the new sending domain (SPF + DKIM)                |

The hardcoded `justdinkit.netlify.app` fallback in `register-checkout.js` is only used when `SITE_URL` env var is unset, so setting the env var correctly handles most cases. No code changes required for the happy path — just env vars.

Internal page-to-page links in the HTML files all use relative paths (`/register.html`, `/moments.html`, etc.) so they'll just work on whatever domain serves them.
