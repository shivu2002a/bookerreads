# Setting up BookerReads end to end

What each external service does, what you need from it, and where the value goes. Follow the sections in order; each one ends with a check you can run.

The app validates its environment at boot (`lib/env.ts`). Every variable in `.env.example` must be present, but only some need real values to test locally. The table at the end says which.

## 0. Tools on your machine

```sh
# Node 22 (supabase-js is dropping Node 20) and pnpm via corepack
brew install node@22          # or nvm install 22
corepack enable && corepack prepare pnpm@9.15.4 --activate

# Optional but useful: psql for poking at the database
brew install libpq && brew link --force libpq

cd bookerreads
pnpm install
cp .env.example .env.local     # if you have not already
```

`.env.local` is gitignored. Never put real keys anywhere else.

Check: `pnpm test` passes (367 tests; these run against an in-memory Postgres, no services needed).

## 1. Database: Neon (done)

Neon is hosted Postgres. Drizzle connects with `DATABASE_URL`.

Already configured. Two follow-ups:

1. **Rotate the password.** The connection string was shared in chat. Neon console → your project → Roles → `neondb_owner` → Reset password. Put the new string in `.env.local`.
2. **Region.** The current project is in `us-east-2` (Ohio). Users in Bangalore pay ~200 ms per query. Before launch, create a project in `ap-southeast-1` (Singapore), point `DATABASE_URL` at it, and re-run migrate + seed.

Commands you will reuse:

```sh
pnpm db:migrate     # applies db/migrations/*.sql (idempotent)
pnpm db:seed        # wipes and loads fixture data; NEVER against production
pnpm ledger:check   # reconciles cached balances to the ledger
```

Running SQL by hand: Neon console → SQL Editor, or `psql "$DATABASE_URL"`.

Check: `pnpm ledger:check` prints "All cached balances match the ledger."

## 2. Auth and photo storage: Supabase

Supabase does two jobs here: **phone OTP login** and **photo storage**. Its database is not used (Neon is).

### 2a. Create the project

1. https://supabase.com → New project. Name it anything; region is not critical for auth (Singapore is nearest). Save the database password somewhere; you won't need it.
2. Settings → API Keys. Supabase now issues short **publishable** and **secret** keys (the older `anon` / `service_role` JWTs still exist under a "Legacy" tab; either works). Copy three values into `.env.local`:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - Publishable key (`sb_publishable_…`) → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - Secret key (`sb_secret_…`) → `SUPABASE_SERVICE_ROLE_KEY` (server only; it bypasses all access rules and refuses to run in a browser)
   - The JWKS URL shown alongside them is not needed.

### 2b. Phone login

Authentication → Providers → Phone:

- Enable **Phone provider**.
- **SMS provider:** for local testing pick any (Twilio is the default); you won't send real SMS yet. For production, see section 6.
- **Test OTPs / test phone numbers:** add the seeded numbers so login works with no SMS at all. One per line, format `phone=code`, no plus sign:
  ```
  919999900001=123456
  919999900002=123456
  919999900003=123456
  919999900030=123456
  ```
  (Any of the 30 seeded numbers `919999900001`–`919999900030` work; add as many as you want.)
- Authentication → Settings (or Rate Limits): OTP expiry 600 s, and set SMS rate limit around 30/hour. These mirror `supabase/config.toml`.
- Authentication → URL Configuration: Site URL `http://localhost:3000`, add redirect `http://localhost:3000/**`.

### 2c. Storage buckets

Storage → New bucket, twice:

| Name             | Public | File size limit | Allowed MIME types |
| ---------------- | ------ | --------------- | ------------------ |
| `listing-photos` | **on** | 3 MB            | `image/jpeg`       |
| `loan-photos`    | off    | 3 MB            | `image/jpeg`       |

No storage policies are needed: uploads use signed URLs minted by the service role, listing photos are read via the public URL, loan photos via short-lived signed URLs.

### 2d. Link the seeded members to auth users

```sh
pnpm db:seed
```

With `SUPABASE_SERVICE_ROLE_KEY` set, the seed now creates a Supabase Auth user for each of the 30 members (you'll see `auth users: 30`). The member rows' `auth_user_id` point at them, so the test-OTP logins land on seeded accounts.

Check: `pnpm dev`, open http://localhost:3000/login, enter `99999 00001`, code `123456`. You should land on `/shelf` as **Ananya**, who is the seeded admin (`is_admin = true`), so `/admin` works too. Then `/shelf/add`: scan or type ISBN `9780062316097`, take a photo (on a laptop, any webcam frame; the gallery check only rejects files older than 60 s), save. The photo should appear on your shelf from the `listing-photos` bucket.

## 3. Payments: Razorpay (test mode)

Razorpay handles the ₹500 refundable deposit, per-loan rental payments, refunds, and (later) payouts. There is no subscription product to configure.

1. https://dashboard.razorpay.com → sign up → stay in **Test Mode** (toggle top-left).
2. Settings → API Keys → Generate Test Key. Copy:
   - Key Id → `RAZORPAY_KEY_ID` (starts `rzp_test_`)
   - Key Secret → `RAZORPAY_KEY_SECRET`
3. Nothing else to create: deposits and rentals are one-off Orders raised by the app.
4. Webhooks need a public URL. Run a tunnel in another terminal:
   ```sh
   brew install ngrok && ngrok http 3000     # or: npx localtunnel --port 3000
   ```
   Then Razorpay → Settings → Webhooks → Add: URL `https://<tunnel>/api/webhooks/razorpay`, set a secret and copy it to `RAZORPAY_WEBHOOK_SECRET`, and tick these events:
   `payment.captured`, `payment.failed`, `refund.processed`.
5. Set `NEXT_PUBLIC_APP_URL` to the tunnel URL while testing webhooks (it's used in message deep links), or leave it as localhost if you only care that the webhook arrives.

Test cards: `4111 1111 1111 1111`, any future expiry, any CVV; UPI `success@razorpay`.

Check: log in as a `registered` member (e.g. `919999900020` Varun, who has copies listed), go to `/activate`, pay the deposit with the test card. The panel should flip to "You can borrow." Then request a priced copy as that member, accept it as the lender (`919999900001`), and pay the rental from the loan page. Watch the dev server log for `processed` webhook outcomes. `pnpm ledger:check` shows the ₹500 deposit and the lender's rental credit.

## 4. Notifications: Interakt (WhatsApp) and MSG91 (SMS)

For local testing set `NOTIFY_MODE=mock` (the default). Every message is printed to the dev server console as `[notify:mock:whatsapp] ...` and recorded as delivered. The other four variables still need _some_ non-empty value; the placeholders are fine.

For real sending (`NOTIFY_MODE=live`):

- **Interakt** (https://www.interakt.shop): a WhatsApp Business account, then Settings → Developer → API key → `INTERAKT_API_KEY`. Submit every template in `lib/notify/templates.ts` for Meta approval with the body variables in the listed order (the `whatsapp:` name is what we send). Set the message-status webhook to `/api/webhooks/interakt`, header `x-interakt-signature`, secret → `INTERAKT_WEBHOOK_SECRET`. Approval takes days; do this early.
- **MSG91** (https://msg91.com): auth key → `MSG91_AUTH_KEY`; a DLT-registered 6-letter sender id → `MSG91_SENDER_ID`. DLT registration (mandatory in India for transactional SMS) also takes days.

Check (mock): trigger any loan action and see the `[notify:mock:...]` line. Check (live): same action, message arrives on your phone.

## 5. Scheduled jobs

Two routes run the timed rules: `/api/cron/daily` and `/api/cron/monthly`. On Vercel they are scheduled by `vercel.json`; locally you call them.

```sh
# CRON_SECRET must be at least 16 chars; .env.local already has a dev value
curl -H "Authorization: Bearer $(grep ^CRON_SECRET .env.local | cut -d= -f2)" http://localhost:3000/api/cron/daily
```

You get a JSON report per step. The seed includes loans sitting exactly on the boundaries (a request 47 h old and one 49 h old, etc.), so the first run does real work. `?force=1` re-runs the same day.

Check: `/admin/health` shows the run under "Recent scheduled jobs" with every step `ok`.

## 6. Production-only

Not needed to run locally; listed so nothing is a surprise later.

- **Vercel**: import the repo, region `bom1` (in `vercel.json`), paste every variable from `.env.example`. Cron and preview deploys come free with it. Add `LHCI_GITHUB_APP_TOKEN` in GitHub secrets if you want Lighthouse results posted on PRs.
- **Supabase SMS for real OTPs**: Supabase doesn't ship MSG91 natively. Options: use Twilio/Vonage as the OTP sender (simplest), or Authentication → Hooks → "Send SMS" pointing at a small endpoint that calls MSG91. Either way the app code is unchanged.
- **Razorpay live**: KYC, then repeat section 3 in Live Mode with live keys and the production webhook URL. Activate RazorpayX for bulk UPI payouts (CSV upload from `/admin/payouts`).
- **Sentry** (`NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` for source maps) and **PostHog** (`NEXT_PUBLIC_POSTHOG_KEY`): optional; leave blank to disable.
- **Production data**: do **not** run `pnpm db:seed`. Insert clusters and `config` rows by hand, log in once, then `update members set is_admin = true where id = '<you>'`.
- **Google Books**: `GOOGLE_BOOKS_API_KEY` is optional. Without it you get the anonymous quota (1,000/day), and lookups fall back to Open Library anyway.

The full pre-launch list is in `docs/launch-checklist.md`.

## Environment variables at a glance

| Variable                                                                                 | Needed locally                                             | Source                            |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------- |
| `DATABASE_URL`                                                                           | real                                                       | Neon (done)                       |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | real, for login and photos                                 | Supabase → Project Settings → API |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`                      | real only to test activation                               | Razorpay test mode                |
| `NOTIFY_MODE`                                                                            | `mock`                                                     |                                   |
| `INTERAKT_API_KEY`, `INTERAKT_WEBHOOK_SECRET`, `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`       | any non-empty placeholder in mock mode                     | Interakt, MSG91                   |
| `CRON_SECRET`                                                                            | any 16+ chars                                              | you                               |
| `NEXT_PUBLIC_APP_URL`                                                                    | `http://localhost:3000` (tunnel URL when testing webhooks) |                                   |
| `GOOGLE_BOOKS_API_KEY`, Sentry, PostHog                                                  | blank is fine                                              | optional                          |

## Running

```sh
pnpm dev                 # http://localhost:3000
pnpm test                # unit + integration (PGlite, no services)
pnpm test:e2e            # public pages against a dev server
E2E_FULL=1 pnpm test:e2e # full signup → list → loan → return flow; needs sections 1, 2 done
pnpm build && pnpm check:bundle   # production build and the 150 KB budget
```

## Test accounts (after `pnpm db:seed`)

All use code `123456` once added as test OTPs in Supabase.

| Phone      | Member | State                           | Good for                    |
| ---------- | ------ | ------------------------------- | --------------------------- |
| 9999900001 | Ananya | active, **admin**               | `/admin`, lending, disputes |
| 9999900002 | Rohan  | active                          | borrowing                   |
| 9999900018 | Nikhil | suspended (lost a book)         | top-up and suspension paths |
| 9999900020 | Varun  | registered, copies listed       | the `/activate` flow        |
| 9999900030 | Yash   | registered, 0 copies, new today | onboarding, listing cap     |
