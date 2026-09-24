-- Row Level Security (design.md Security; Requirements 3.5, 13.1, 15.1, 15.2).
--
-- Model: client roles (anon, authenticated) may only SELECT, and only the rows
-- the policies below allow. Every write goes through server actions using the
-- service role, which bypasses RLS. Admin reads are allowed via members.is_admin.
--
-- Written to run on both hosted Supabase (where auth.uid() and the roles exist)
-- and on plain Postgres/PGlite for tests (where they are created here).

-- ---------------------------------------------------------------------------
-- Roles and auth helpers (no-ops on Supabase)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS auth;--> statement-breakpoint

-- Supabase defines auth.uid() already; only define it when absent (local tests).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    CREATE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE
      AS $f$
        SELECT coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
        )::uuid
      $f$;
  END IF;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- App helpers. SECURITY DEFINER so policies can consult members without
-- recursing into the members policy.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_member_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT id FROM members WHERE auth_user_id = auth.uid() AND deleted_at IS NULL $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT coalesce((SELECT is_admin FROM members WHERE auth_user_id = auth.uid() AND deleted_at IS NULL), false) $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.is_loan_party(p_loan_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM loans l
      WHERE l.id = p_loan_id
        AND (l.lender_id = public.current_member_id() OR l.borrower_id = public.current_member_id())
    )
  $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.current_member_id() FROM public;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_admin() FROM public;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_loan_party(uuid) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.current_member_id() TO anon, authenticated, service_role;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_loan_party(uuid) TO anon, authenticated, service_role;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Public projection of members. Owned by the migration role, so it reads
-- members without RLS and exposes only what Requirement 3.5 allows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.member_public AS
  SELECT id, display_name, cluster_id, trust_score, created_at AS member_since,
         state IN ('active') AS can_borrow
  FROM members
  WHERE deleted_at IS NULL AND display_name IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges: clients read; nobody but the service role writes.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon, authenticated;--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;--> statement-breakpoint
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;--> statement-breakpoint
GRANT SELECT ON public.member_public TO anon, authenticated;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon, authenticated;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;--> statement-breakpoint

-- drop_points.qr_secret must never reach a client even for rows they may see.
-- A table-level GRANT covers every column, so swap it for explicit column grants.
REVOKE SELECT ON drop_points FROM anon, authenticated;--> statement-breakpoint
GRANT SELECT (id, created_at, updated_at, cluster_id, name, address, contact, hours, capacity, occupancy, active)
  ON drop_points TO anon, authenticated;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere (also for the table owner, so nothing slips past).
-- ---------------------------------------------------------------------------
ALTER TABLE clusters ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cluster_waitlist ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE otp_attempts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE members ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE books ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE copies ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE drop_points ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE loans ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE loan_photos ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE loan_messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE pool_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE trust_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE admin_actions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE config ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cron_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- SELECT policies. No INSERT/UPDATE/DELETE policies exist for client roles.
-- ---------------------------------------------------------------------------

-- Reference data: readable by everyone.
CREATE POLICY clusters_read ON clusters FOR SELECT TO anon, authenticated USING (true);--> statement-breakpoint
CREATE POLICY plans_read ON plans FOR SELECT TO anon, authenticated USING (active OR public.is_admin());--> statement-breakpoint
CREATE POLICY books_read ON books FOR SELECT TO anon, authenticated USING (true);--> statement-breakpoint
CREATE POLICY drop_points_read ON drop_points FOR SELECT TO anon, authenticated USING (active OR public.is_admin());--> statement-breakpoint

-- Members: own row or admin. Everyone else uses member_public.
CREATE POLICY members_read_self ON members FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid() OR public.is_admin());--> statement-breakpoint

-- Copies: listed copies are public; owners see all of theirs; admins see all.
CREATE POLICY copies_read ON copies FOR SELECT TO anon, authenticated
  USING (
    availability IN ('available', 'on_loan')
    OR owner_id = public.current_member_id()
    OR public.is_admin()
  );--> statement-breakpoint

-- Loans and their attachments: the two parties or admin.
CREATE POLICY loans_read_party ON loans FOR SELECT TO authenticated
  USING (lender_id = public.current_member_id() OR borrower_id = public.current_member_id() OR public.is_admin());--> statement-breakpoint
CREATE POLICY loan_photos_read_party ON loan_photos FOR SELECT TO authenticated
  USING (public.is_loan_party(loan_id) OR public.is_admin());--> statement-breakpoint
-- Chat: parties only while the loan is between accepted and returned + 48 h; admins always.
CREATE POLICY loan_messages_read_party ON loan_messages FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (
      public.is_loan_party(loan_id)
      AND EXISTS (
        SELECT 1 FROM loans l
        WHERE l.id = loan_id
          AND (
            l.state IN ('accepted', 'on_loan', 'overdue', 'disputed')
            OR (l.state IN ('returned', 'resolved', 'lost') AND coalesce(l.returned_at, l.updated_at) > now() - interval '48 hours')
          )
      )
    )
  );--> statement-breakpoint
CREATE POLICY disputes_read_party ON disputes FOR SELECT TO authenticated
  USING (public.is_loan_party(loan_id) OR public.is_admin());--> statement-breakpoint

-- Per-member financial and trust data: own or admin.
CREATE POLICY ledger_read_own ON ledger_entries FOR SELECT TO authenticated
  USING (member_id = public.current_member_id() OR public.is_admin());--> statement-breakpoint
CREATE POLICY subscription_payments_read_own ON subscription_payments FOR SELECT TO authenticated
  USING (member_id = public.current_member_id() OR public.is_admin());--> statement-breakpoint
CREATE POLICY payouts_read_own ON payouts FOR SELECT TO authenticated
  USING (member_id = public.current_member_id() OR public.is_admin());--> statement-breakpoint
CREATE POLICY trust_events_read_own ON trust_events FOR SELECT TO authenticated
  USING (member_id = public.current_member_id() OR public.is_admin());--> statement-breakpoint
CREATE POLICY notifications_read_own ON notifications FOR SELECT TO authenticated
  USING (member_id = public.current_member_id() OR public.is_admin());--> statement-breakpoint
CREATE POLICY cluster_waitlist_read_own ON cluster_waitlist FOR SELECT TO authenticated
  USING (member_id = public.current_member_id() OR public.is_admin());--> statement-breakpoint

-- Operational tables: admin only from a client.
CREATE POLICY pool_runs_admin ON pool_runs FOR SELECT TO authenticated USING (public.is_admin());--> statement-breakpoint
CREATE POLICY events_admin ON events FOR SELECT TO authenticated USING (public.is_admin());--> statement-breakpoint
CREATE POLICY admin_actions_admin ON admin_actions FOR SELECT TO authenticated USING (public.is_admin());--> statement-breakpoint
CREATE POLICY config_admin ON config FOR SELECT TO authenticated USING (public.is_admin());--> statement-breakpoint
CREATE POLICY cron_runs_admin ON cron_runs FOR SELECT TO authenticated USING (public.is_admin());--> statement-breakpoint
CREATE POLICY webhook_events_admin ON webhook_events FOR SELECT TO authenticated USING (public.is_admin());--> statement-breakpoint
-- otp_attempts: no client policy at all; server-only.
