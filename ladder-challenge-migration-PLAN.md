# Ladder Challenge — migrating Pickleladder into Dink Society

> **Build status (in progress).** Backend foundation is wired and unit-tested
> (29 tests pass). Done: `lib/ladder.js` (events/signups/waitlist + pure logic),
> `lib/credits.js` (credit ledger), `lib/ladder-token.js` (single-use action
> links), `lib/ladder-notify.js` (urls/recipients), ladder email templates in
> `lib/email.js` (spot-opened, **last-chance nudge**, confirmed, Venmo-claim),
> `ladder-signup.js` (GET/POST/DELETE: signup, waitlist, credit/Venmo pay, cancel→
> credit→promote), `ladder-cron.js` (every 5 min: nudge at ~5 min left, expire the
> 30-min hold, roll to next), `ladder-confirm-venmo.js` + `ladder-claim.js`
> (one-tap links), `ladder-checkout.js` + `ladder-stripe-webhook.js` (card pay,
> entry + 10% surcharge, webhook marks paid), 24h **first-come-first-serve** window,
> admin endpoints (`admin-ladders` list, `admin-ladder-save` create/update,
> `admin-ladder-manage` remove/confirm-Venmo/promote/status/delete) + shared
> `lib/ladder-promote.js`, `tests/ladder.test.js`. Player frontend wired:
> `public-ladders.js` (public list) + `public/ladders.html` (live Available/Stats
> page calling the real APIs — signup via credit/card/Venmo, waitlist, invite/share,
> `?demo=1` fallback). **Next:** the run-night **scoring/stats/DR engine** (port the
> pure functions from Pickleladder `app.js` into `lib/ladder-scoring.js` for identical
> behavior; then fill the Stats tab) and the admin UI HTML (mockups → live, calling
> `admin-ladder-*`).



**Goal:** bring the round-robin "ladder night" format (currently the standalone
`pickleladder.netlify.app` app) into Dink Society as a first-class play type — a
**Ladder Challenge** — reusing DS's auth, email, profiles, and recap engine, and
adding the two things the standalone app never had: **self-serve signup with a
waitlist** and **email notification when a spot opens**.

This is the written plan. The companion file `ladder-challenge-mockup.html`
mocks every screen described here.

---

## 1. What each system is today

**Pickleladder (the app in the screenshot)** — one Netlify Function (`api.mjs`)
over a single blob store. Hierarchy is **League → Season → Session (a night) →
rounds → courts**. Players are flat records `{id, name, gender, active}`. A night
mixes everyone across courts each round, scores are individual, and a podium is
computed at the end. No accounts, no signup — an admin picks participants. Admin
is gated by a 4-digit PIN.

**Dink Society** — a full team-league platform. Hierarchy is **Circuit (season)
→ Division → Team → roster players**, matches are team-vs-team per week with
captain-built lineups. It already has, and we reuse:

| Capability | Where it lives in DS today |
|---|---|
| Magic-link / session auth (admin, captain, player) | `lib/auth.js`, `lib/player-auth.js`, `lib/captain-auth.js` |
| Transactional email (Resend, verified sender) | `lib/email.js` (`sendEmail`, `renderAvailabilityNotify`) |
| "Notify on change" pattern | `player-availability.js` → `notifyCaptains()` |
| Player identity matching across rosters/seasons | `lib/identity.js` (normalized email/phone) |
| Player profiles | `me.html`, `player.html`, `lib/profile.js` |
| Winners / Player-of-the-Week / 🥇🥈🥉 podium | `index.html` `#recap`, `lib/drop.js` (`normPerformers`) |
| Standings / ratings (DSR) | `lib/standings.js`, `leaderboard.html` |
| Paid registration (optional for ladder) | `register-checkout.js`, `stripe-webhook.js` |

The punchline: **most of the original feature request already exists in DS.**
The migration is mostly about adding the ladder *event* object and an *opt-in
signup* flow, then pointing them at the infrastructure that's already there.

---

## 2. Data model mapping

| Pickleladder | Dink Society equivalent | Notes |
|---|---|---|
| League | Circuit + a `format: "ladder"` tag, or a standalone "Ladder" program | A ladder isn't division/team based, so model it as its own program under a Circuit. |
| Season | Circuit | Already DS's season unit. Ladder results roll up to the same Circuit a team season uses, so profiles show both. |
| Session (a night) | **new: Ladder Event** | The unit players sign up for. |
| Participants (admin-picked ids) | **new: Signups + Waitlist** | The change: players add themselves. |
| Player `{id,name,gender}` | DS roster-style player keyed by normalized email | `lib/identity.js` already does the matching so the same human is one profile across ladder nights *and* team play. |
| Podium (1–3) | `performers` snapshot (`normPerformers`) | Feeds the existing `#recap` podium on the home page. |

### New blob stores

```
ladder-events                                  (strong consistency)
  event/<eventId>.json
  { id, circuit, name, date, startTime, place,
    courts, capacity,            // capacity defaults to courts × 4
    scoreMode, status,           // open | full | live | final
    createdAt, createdBy }

ladder-signups                                 (strong consistency)
  signup/<eventId>.json
  { eventId,
    roster:   [ { playerId, name, email, gender, signedUpAt } ],   // length ≤ capacity
    waitlist: [ { playerId, name, email, gender, joinedAt } ],     // ordered queue
    updatedAt }
```

Strong consistency matters here for the same reason it does for scores and
availability in DS today: two people tapping "Sign up" on the last spot must not
both read an open slot ([[blobs-strong-consistency]] is the existing precedent).

---

## 3. The two genuinely new flows

### 3a. Self-signup + waitlist

New function `ladder-signup.js`:

- `GET ?event=<id>` → public roster + spots-left + waitlist length (ETag cached
  like `public-drop.js`).
- `POST ?event=<id>` (player session required) → atomically: if `roster.length <
  capacity`, append to `roster`; else append to `waitlist`. Return which list
  they landed in and their position.
- `DELETE ?event=<id>` → remove from roster/waitlist. **If a roster spot frees
  up and the waitlist is non-empty, promote the head of the queue and fire the
  "spot opened" email** (see 3b).

Identity comes from the player session (magic-link), so signups are tied to a
real, verified email — no impersonation, and the same player record links to
their profile and past results.

### 3b. "A spot opened" email

Reuse `sendEmail` from `lib/email.js` and add `renderLadderSpotOpened(...)`
alongside `renderAvailabilityNotify`. Promotion is the trigger, mirroring the
`notifyCaptains()` shape in `player-availability.js`:

```
on DELETE (or admin removal) →
  if roster has space and waitlist not empty:
    promoted = waitlist.shift()
    roster.push(promoted)
    sendEmail({ to: promoted.email,
                subject: "You're in! A spot opened for <event>",
                html: renderLadderSpotOpened({ ...event, confirmUrl }) })
```

Two policy options for the promoted player — both are in the mockup so you can
pick:
1. **Auto-claim** — they're immediately on the roster; email is a heads-up.
2. **Hold-and-confirm (default)** — the next person in line gets priority via a
   magic link with a **30-minute** window; if they don't confirm in time, the spot
   rolls to the next person automatically (a `drop-cron.js` style scheduled sweep
   handles the 30-min expiry — that cron pattern already exists).

   **Final-24h override → first-come-first-serve.** Inside 24h of start there's no
   time for a priority hold cycle, so an opened spot is NOT held for #1 — it stays
   open and the whole waitlist is emailed "grab it, first to claim & pay wins."
   Implemented as `isLastDay(event)` in `lib/ladder.js`; `promoteHead` returns
   `{ fcfs:true }` in the window (no hold), `moveWaitlistToRoster` lets a waitlister
   take the open spot, and `renderLadderFcfsOpen` is the blast email. Window is 24h
   by default, overridable per-event via `fcfsWindowHours`.

### 3c. Front-page winners (1–3)

After a night is finalized, snapshot the top 1–3 into the event record using the
existing `normPerformers` shape, and surface them in the home `#recap` block,
which already renders POTW cards and a 🥇🥈🥉 medal podium. Source = that night's
final standings (automatic). An admin override is a nice-to-have but not
required for v1.

---

### 3d. Invite a friend / sharing

Every ladder has a **shareable public link** — `dinksociety.app/l/<id>` — a signed,
read-only link anyone can open without logging in. From the ladder card a player
taps **Invite friends** → a native share sheet (copy link, Messages, WhatsApp, …)
with a prefilled message and the link. The friend lands on the ladder with an
**"invited by Richard"** banner plus social proof (who's already playing), then
signs up with a magic link — so a **non-member converts into a player (and a
profile) in one flow**. Stamp `invitedBy` on the signup for attribution. Function:
extend the public ladder read (`public-ladder.js`) to accept an invite token and
record the referrer. Optional later: a **referral hook** that gives the inviter
ladder credit once a friend they brought actually plays. (See
`ladder-invite-mockup.html`.)

## 4. Payments & refunds

Spots are **paid**. Two methods, both surfaced at signup:

### 4a. Card — Stripe (reuses what exists)

DS already has `register-checkout.js` + `stripe-webhook.js` for team registration.
A ladder spot reuses that exact pattern with a new `ladder-checkout.js`:

- On signup, create a Stripe Checkout Session for **entry + 10% service fee**.
- `ladder-stripe-webhook` (or extend the existing webhook) listens for
  `checkout.session.completed` and flips the signup `pending → paid`. Confirmation
  is automatic and near-instant — no admin step.

**Why 10% covers it.** Stripe takes ~2.9% + $0.30. The flat 30¢ dominates at low
ticket prices, so a percentage-only markup would under-collect — a flat 10% does
not:

| Entry | +10% fee | Player pays | Stripe takes | League nets |
|------:|---------:|------------:|-------------:|------------:|
| $7    | $0.70    | $7.70       | ~$0.52       | ~$7.18      |
| $8    | $0.80    | $8.80       | ~$0.56       | ~$8.24      |
| $10   | $1.00    | $11.00      | ~$0.62       | ~$10.38     |

The league nets at or above face value across the $7–10 range.

### 4b. Venmo — deep-link + confirm (fee-free)

No Stripe involvement. Build a Venmo deep link prefilled with the league handle,
amount (no surcharge), and a matchable note:

```
https://venmo.com/<handle>?txn=pay&amount=7.00&note=Sat%20Ladder%206/20%20—%20Marcus%20T
```

Player taps **"I've sent the payment"** → signup goes `venmo_pending` and DS emails
the **organizer** a one-tap confirm (see 4b-i). Unconfirmed Venmo holds expire
(~30 min) and release the spot to the waitlist — same `drop-cron.js` sweep pattern
already in the repo. (The admin manage-signups screen stays as a fallback, but the
email is the primary path — no panel work required.)

#### 4b-i. One-tap confirm by email (no login)

The whole point: the organizer should *only* have to say "got it." When a player
files a Venmo claim, send the organizer (and any co-organizers) an email with the
player, amount, and the exact Venmo note to look for, plus two buttons:

- **✅ Payment received — confirm spot**
- **✕ Didn't get it — decline**

Each button is a **signed, single-use link** — the same trust model as DS's
passwordless sign-in (HMAC over the secret in `lib/player-auth.js`). New endpoint:

```
GET /ladder-confirm-venmo?t=<signed-token>
  token payload: { eventId, playerId, action:'confirm'|'decline', exp, nonce }
```

`ladder-confirm-venmo.js`:
1. Verify the HMAC signature and `exp` (no session needed — the token *is* the auth).
2. Check the `nonce` hasn't been consumed (single-use; store consumed nonces so a
   forwarded/duplicated email can't double-fire).
3. `confirm` → set `paymentStatus: paid`, finalize the spot, email the player
   "you're in." `decline` → release the spot, promote/notify the waitlist.
4. Return a tiny standalone confirmation page ("Confirmed ✓ — Marcus is in").

Because the link carries its own auth, the organizer taps it straight from their
phone's mail app — no app open, no login, nothing to reconcile in a dashboard.
Adding a co-organizer is just another recipient on the same email.

### 4c. Spot hold

Signing up **reserves the spot immediately** (counts against capacity) with
`paymentStatus: pending`. Card auto-confirms via webhook; Venmo is admin-confirmed;
expired holds release and promote the next waitlister. Waitlisters are **not
charged** until they're promoted and claim.

### 4d. Cancellation → credit, not refunds (your rules)

> Cancelling opens the spot back up and gives the player **ladder credit** for a
> future night. **No refunds** — so no money ever moves, and there's nothing to
> process.

Why this is the low-admin choice: a refund is a cash-out that has to be issued,
reconciled, and (for Venmo) sent by hand. A credit is just a ledger entry the
system writes itself.

**Credit tracking — `ladder-credits` store, keyed by normalized email** (so it
follows the human across ladders, seasons, and teams via `lib/identity.js`):

```jsonc
credit/<normalizedEmail>.json
{
  "email": "marcus@...",
  "balanceCents": 700,            // integer cents — never floats for money
  "ledger": [
    { "id":"...", "ts":"2026-06-13T...", "delta": 700,  "type":"earned",
      "reason":"Cancelled Saturday Morning Ladder", "eventId":"evt_a" },
    { "id":"...", "ts":"2026-05-28T...", "delta": -700, "type":"spent",
      "reason":"Applied to Thursday Night Ladder",  "eventId":"evt_b" }
  ],
  "updatedAt": "..."
}
```

- **Append-only ledger** + a cached `balanceCents`. Balance is always
  `sum(ledger.delta)`, so it's verifiable and auditable — you can see exactly where
  every dollar came from and went.
- **Cents as integers**, never floating-point dollars.
- **Strong consistency** on writes so two concurrent spends can't both succeed
  (same rule as scores/signups).
- Entry `type`: `earned` (cancel), `spent` (applied at signup), `adjustment`
  (rare admin fix), `expired` (optional, if you ever expire credits).

**Triggers (all automatic):**

1. **Cancel** → signup `cancelled`, spot released (promote waitlist + spot-opened
   email), and append an `earned` entry for the entry fee. Per-event setting picks
   *when*: **Auto credit** (any cancellation) or **Credit if refilled** (only once
   the spot is retaken & paid). Default = Auto credit.
2. **Signup with a balance** → offer "Use credit" at the pay step; appends a
   `spent` entry and zeroes (or reduces) the charge. Partial credit + pay the rest
   by card/Venmo is allowed.
3. **Admin adjustment** → the one manual action, a single ledger write. There is
   no batch job and no money movement.

Credit value = the **entry fee** (e.g., $7), not the card total — the 10% card
surcharge only ever covered Stripe's processing, so it isn't part of the credit.

### 4e. Data fields

Each `ladder-signups` roster/waitlist entry:

```jsonc
{
  "playerId": "...", "name": "...", "email": "...",
  "paymentMethod": "card | venmo | credit",
  "paymentStatus": "pending | paid | cancelled",
  "amountCents": 770,             // what they paid (card incl. surcharge); 0 if credit
  "checkoutSessionId": "cs_...",  // card only
  "heldUntil": "2026-06-20T08:30:00Z"   // pending-hold expiry
}
```

Plus the separate `ladder-credits/<normalizedEmail>.json` ledger above.

New/changed functions: `ladder-checkout.js`, `ladder-stripe-webhook` (or extend
the existing one), `ladder-confirm-venmo.js` (signed one-tap confirm/decline link),
`lib/credits.js` (read balance, `earn`, `spend`, all atomic), and a hold-expiry
sweep in the existing cron. No refund function needed.

---

## 5. Migrating existing Pickleladder data

One-time importer (a script, or an admin-only function):

1. Read each league/season/session JSON out of the old blob store (the standalone
   API exposes `?action=list`).
2. For every distinct player, run `withNormalizedContact()` and upsert into DS so
   returning players merge into one profile (couples sharing an email get flagged
   for human confirmation, never auto-merged — same rule as `admin-duplicates.js`).
3. Map each past session → a finalized Ladder Event with its podium snapshot, so
   history and stats show up on profiles immediately.
4. Email isn't on the old records — collect it going forward at first signup;
   historical players stay claimable by matching name until they sign in.

### 5a. Claiming profiles & matching players across both products

**The unifying key is the normalized email** (`lib/identity.js`). Both lanes write
to the same profile keyed by that email, so a player who uses the **same email**
for league registration and for ladder signup is automatically **one profile
spanning both DR and DSR** — no matching step needed for live play. The only thing
that needs reconciling is *historical* ladder data, which has names but no emails.

**Import historical players as "unclaimed" stubs:**

```jsonc
profile/unclaimed/<id>.json
{ "source": "pickleladder", "name": "Marcus Tran", "gender": "M",
  "leagueId": "...", "ladderHistory": [ ... ], "claimedBy": null }
```

**Self-serve claim (magic-link authed) — the main path:** after a player signs in,
`profile-claim.js` shows unclaimed stubs whose name fuzzy-matches theirs within
leagues they're connected to — *"Did you play these? Thursday Night 2025 🥇"*. They
tap to confirm; the stub's history merges into their profile and `claimedBy` is set
(single-use). **The authenticated confirmation is the proof of identity** — a name
match alone is only ever a *suggestion* (there are two Mike S.'s). This is exactly
DS's existing rule: shared email/phone is a strong signal but never grounds to
auto-merge (couples share inboxes) — flag for confirmation
(`admin-duplicates.js`).

**Admin-assisted, for the rest:** reuse the `admin-duplicates.js` clustering to (a)
pre-link the obvious ones in bulk, (b) resolve ambiguous clusters by hand, and (c)
fire claim-invite emails ("claim your ladder history") to any addresses you do have.

**So the three cases resolve as:**
- *League player who starts playing ladders* → same email ⇒ auto-linked, one profile.
- *Brand-new ladder player* → signs up with email ⇒ new profile, nothing to match.
- *Returning historical ladder player* → signs in once, then claims their pre-import
  stub from the suggestion list ⇒ history attaches, profile now spans both lanes.

New function: `profile-claim.js` (GET candidate stubs, POST claim; player-session
authed), plus the claim/merge review in the existing admin duplicates flow.

---

## 6. Phasing

1. **Foundation** — `ladder-events` + `ladder-signups` stores, `ladder-signup.js`,
   event admin screen. (Signup + waitlist working, no email yet.)
2. **Notifications** — `renderLadderSpotOpened`, promotion-on-open, optional
   hold-and-confirm cron.
3. **Payments** — `ladder-checkout.js` (Stripe, +10% surcharge) + webhook
   auto-confirm; Venmo deep-link + **one-tap email confirm** (`ladder-confirm-venmo.js`);
   pending-hold expiry sweep.
4. **Credits** — `ladder-credits` ledger + `lib/credits.js`; cancel auto-issues
   credit; "use credit" option at signup. (Replaces refunds entirely.)
5. **Profiles + recap** — wire ladder results into `lib/profile.js` and the home
   `#recap` winners.
6. **Backfill** — run the importer for historical Pickleladder data.
7. **Cutover** — point `pickleladder.netlify.app` at DS / redirect; retire the
   standalone `api.mjs`.

## 7. Risk notes

- **Double-booking the last spot** → strong-consistency reads + a compare-on-write
  guard in `ladder-signup.js`.
- **Email deliverability** → already solved; DS sends from the verified
  `dinksociety.app` sender via Resend.
- **Identity collisions** (shared email/phone) → surface for admin confirmation,
  never auto-merge (`lib/identity.js` precedent).
- **No-show after promotion** → the hold-and-confirm option + waitlist roll-over.
- **Credit double-spend** → atomic ledger writes under strong consistency;
  `balanceCents` always equals `sum(ledger.delta)` so it's verifiable.
- **Credit stockpiling** (cancel repeatedly to bank credit) → optional "credit if
  refilled" setting and/or an expiry window; both are config, not code changes.
- **Venmo reconciliation** → matchable note (event + name) + one-tap confirm; never
  auto-confirm Venmo, since there's no payment webhook.
- **Surcharge transparency** → show the 10% card fee as a line item before pay so
  it's never a surprise (mockup does this).

---

## 8. One profile, two lanes (IA & brand)

League (team circuits) and Ladder (individual nights) are **distinct products under
one Dink Society profile**. The rule that keeps them seamless but never confusing:
**shared shell, lane identity.**

**Shared (neutral, unified):** the person — name, photo, account/login, magic-link
identity, and notifications. One login, one profile, one brand. This is what makes
adding a second product feel like growth, not a separate app. (Ratings are
**per-lane**, not shared — see the table.)

**Lane identity (repeated everywhere):** each product carries the same trio of
signals so it's recognizable at a glance, in any list, on any screen:

| Lane | Accent | Glyph | Tag | Rating |
|------|--------|-------|-----|--------|
| Ladder | Lime `--color-lime` | 🪜 | `LADDER` | **DR** — Dink Rating |
| League | Teal `--color-teal` | 🏆 | `LEAGUE` | **DSR** — Dink Society Rating |

Both are existing DS brand colors (primary + secondary), so nothing feels bolted on.
Apply the trio consistently: a left **accent border** + product **tag** on every
history/result row, lane glyph on cards, and the accent on that product's
standings/schedule pages.

**Where they separate vs. merge:**
- *Merge* — profile header, DSR, account settings, ladder credit (credit is a
  ladder-lane wallet, labeled as such).
- *Separate* — results history, standings, schedules, formats, badges. The profile
  uses an **All / 🪜 Ladder / 🏆 League** segmented filter (built in the mockup) so a
  player can view everything together or one lane at a time.

**Ratings are separate by design.** Ladder play feeds **DR (Dink Rating)**; league
play feeds **DSR (Dink Society Rating)**. They're computed and stored independently
(different formats — individual round-robin vs. team lines — so one scale wouldn't
be fair), and shown side by side on the profile, each in its lane accent. Don't
cross-pollinate the two scores.

**Navigation note:** keep the brand/nav shared; distinguish products with the
accent + a clear section label rather than separate sites. A top-level
**Ladders / Leagues** switch on the home page is the cleanest entry point.

**Mobile (logged in) — keep the existing 5-tab bar, add a per-page lane toggle.**
The real app already ships **Home · Games · Standings · Team · Me**; don't change it
(a 6th tab crowds the bar). Instead put a **🏆 League / 🪜 Ladder toggle at the top of
every page** — the same pattern the app already uses for "This Week / League." It
sets a lane context the whole page follows, including the rating shown (**DSR** for
league, **DR** for ladder). League turns teal, Ladder turns lime.

This is how a league-only player **discovers ladders**: they flip any page (Home or
Games) to 🪜 Ladder and see what's open to sign up for. Edge cases: **Team** is
league-only, so its Ladder side just points onward (ladders are individual); **Me**
keeps one shared identity header, then shows the selected lane's rating + results.

The lane can be **global** (pick once, every tab remembers — simpler, recommended)
or **per-tab** (Games on Ladder while Standings stays League). Desktop/web can use a
top-level switch instead. (See `player-home-lane-tabs-mockup.html`; the earlier
`mobile-bottom-nav-mockup.html` shows the bottom-bar-as-switch alternative.)

**v1 DECISION (chosen) — Ladders as its own standalone, tabbed page.** Rather than
thread a lane toggle through the whole league app, ship Ladders as **one
self-contained page** reached from a dedicated **🪜 Ladders** bottom-nav tab. Final
**5-tab bar: Home · Games · 🪜 Ladders · Team · Me** — *Games* now holds both
**Schedule** and **Standings** as sub-tabs (same league context), which freed the
slot for Ladders with no 6th tab. The Ladders tab stays lime so it reads as the
second product. The page has internal tabs, super basic to start:
**Available** (open ladders → sign up + waitlist) and **Stats** (your DR,
leaderboard, recent nights). More tabs later (Standings, Partners, Head-to-head)
are just one more button — no re-architecture, and the league app stays untouched.
The lane-toggle and bottom-bar approaches above remain documented as alternatives
if the products later need tighter interleaving. (See `ladders-page-mockup.html`.)
