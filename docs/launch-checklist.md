# Launch checklist

## Accounts and keys

- [ ] Supabase project in `ap-south-1`. Apply `[auth]` settings from `supabase/config.toml` (phone provider, OTP expiry 600 s, rate limits). Create buckets `listing-photos` (public) and `loan-photos` (private). Run `pnpm db:migrate`, then seed only reference data (see 26.1).
- [ ] MSG91: DLT-registered sender id and the OTP template text from `config.toml`. Wire it as Supabase's SMS provider (custom hook or Twilio-compatible endpoint).
- [ ] Razorpay live mode: live keys; no plans to create (deposits and rentals are one-off orders). Register the webhook `https://<host>/api/webhooks/razorpay` for every event in `HANDLED_EVENTS` (`lib/payments/webhooks.ts`) and set `RAZORPAY_WEBHOOK_SECRET`. Activate RazorpayX for bulk UPI payouts.
- [ ] Interakt: submit every template in `lib/notify/templates.ts` for WhatsApp approval using the listed body-variable order. Set the delivery webhook to `/api/webhooks/interakt` with header `x-interakt-signature`.
- [ ] Sentry project and DSN; PostHog project key. Optional locally.
- [ ] Vercel project pinned to `bom1` (already in `vercel.json`), all variables from `.env.example`, `NOTIFY_MODE=live`, `CRON_SECRET` 32+ random bytes.

## Data (task 26.1)

- [ ] Do **not** run `pnpm db:seed` in production. Insert clusters and `config` rows by hand or with a trimmed script.
- [ ] Set `is_admin = true` for your own member row via SQL after your first login.
- [ ] Run `pnpm ledger:check` (expect zero members) and hit `/api/cron/daily` once with the secret to confirm a clean `cron_runs` row.

## Performance (task 24.3)

- [ ] On a budget Android (Redmi 9A class) over Slow 4G in Chrome DevTools remote: `/`, `/c/central-east`, a book page, `/shelf`, `/requests`. Targets LCP <= 2.0 s, TTI <= 3.5 s. CI already enforces the 150 KB gzip budget and runs Lighthouse on previews.
- [ ] Verify the install prompt appears after the first listing and that a handoff confirmation made in airplane mode syncs on reconnect.

## Legal and compliance (tasks 25.1, 25.2)

- [ ] Lawyer review of `/terms` and `/privacy`. Amounts on `/terms` come from `config`, so edits there flow through.
- [ ] CA: GST registration threshold and invoice format for the platform fee on rentals; how to book deposits as a liability (the app never nets them against revenue; `/admin/health` and `pnpm ledger:check` report them separately). Record outcomes in `docs/compliance.md`.
- [ ] Decide whether founding members get a reduced platform fee (config `platform_fee_pct` is global today).

## Venues (task 25.3)

- [ ] Create the two Central-East drop points in `/admin/drop-points`, print posters from each detail page, and run one test handoff at each venue end to end (drop, collect, return).

## Launch (task 26.2) and review (26.3)

- [ ] Invite founding members with the install link. Cubbon Reads pop-up: tablet at `/shelf/add`; mark copies checked in person as `verified` via SQL or an admin loan override.
- [ ] After 30 days compare `/admin/health` against the Phase 0 pilot figures, review the first payout batch and platform-fee total, decide on the second cluster.
