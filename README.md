# BookerReads

Members-only, neighbourhood-scoped book lending network for Bangalore.

## Stack

Next.js 15 (App Router, RSC) · TypeScript · Tailwind 4 + shadcn/ui · Drizzle ORM · Supabase (Postgres, Auth, Storage) · Razorpay · Interakt (WhatsApp) + MSG91 (SMS) · Vitest · Playwright.

## Prerequisites

- Node 22+ and pnpm 9 (`corepack enable`)
- Docker Desktop and the Supabase CLI for local Postgres/Auth/Storage (`brew install supabase/tap/supabase`)

## Local development

```sh
pnpm install
cp .env.example .env.local        # fill in values
supabase start                    # local Postgres, Auth, Storage
pnpm db:migrate
pnpm db:seed
pnpm dev
```

## Scripts

| Script                                         | What it does                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm dev` / `pnpm build` / `pnpm start`       | Next.js                                                              |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | ESLint, `tsc --noEmit`, Prettier                                     |
| `pnpm test`                                    | Vitest unit and integration tests                                    |
| `pnpm test:e2e`                                | Playwright on a Pixel 5 viewport (`E2E_BASE_URL` to target a deploy) |
| `pnpm db:generate`                             | Generate a Drizzle migration from `db/schema`                        |
| `pnpm db:migrate` / `pnpm db:seed`             | Apply migrations / load fixture data                                 |
| `pnpm ledger:check`                            | Reconcile ledger sums against cached balances                        |

## Layout

```
app/(public)   landing, cluster browse, book pages, public shelves, search
app/(auth)     phone OTP login, onboarding
app/(member)   shelf, requests, loans, activation, earnings, profile
app/(admin)    /admin/*
app/api        webhooks (razorpay, interakt), cron (daily, monthly), catalogue lookup
lib/           domain logic; pure where possible, tested in isolation
db/            Drizzle schema, migrations, seed
components/    UI (shadcn in components/ui, app components alongside)
e2e/           Playwright
```

Conventions: money is integer paise; timestamps are `timestamptz`; server actions never throw to the client; the service-role Supabase client is imported only from server code (enforced by ESLint).
