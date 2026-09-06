-- ============================================================================
-- Neo QC — DATABASE HARDENING MIGRATION  (run in the Supabase SQL editor)
-- ----------------------------------------------------------------------------
-- Closes the #1 critical finding: every table was RLS-enabled but FULLY OPEN to
-- the anonymous role, and the anon key ships in every installer + the public
-- website — so anyone could read, edit, or DELETE all customer data.
--
-- This is PHASED on purpose. Run one phase, TEST the whole fleet (every app mode
-- + the website + the Python importers), then run the next. Do NOT paste the
-- whole file blindly — Phase 2 will break any machine/importer that is still
-- using the anon key to write, so it must come AFTER Phase 1 is confirmed.
--
-- Preconditions you must confirm BEFORE Phase 2:
--   • Every Electron app mode (Staff, Admin, AND Testing Client) signs in with
--     Supabase Auth. If Testing Client currently runs without login, give it a
--     shared service-account login first, or it will lose DB access at Phase 2.
--   • The Python importers (pcstudio_import.py, ppi_sync.py, benchmark_import.py,
--     supabase_loader.py) are switched from the anon key to a SERVICE ROLE key
--     that is kept OFF the shop PCs (run them only on your workstation). The
--     service_role key bypasses RLS, so they keep working with no write policy.
-- ============================================================================


-- ============================================================================
-- PHASE 0 — IMMEDIATE, LOW-RISK: remove the "wipe everything" capability.
-- Nothing legitimate deletes rows through the anon key (the app deletes while
-- signed in; the importers never delete). Safe to run right now.
-- ============================================================================
DROP POLICY IF EXISTS "Allow anonymous delete access"    ON public.tickets;
DROP POLICY IF EXISTS "Allow anon delete component_prices" ON public.component_prices;
-- price_history has ON DELETE CASCADE from component_prices; with the parent's
-- anon DELETE gone, an anon caller can no longer cascade-wipe the price history.

-- After Phase 0, TEST: the app + website still read/update/create tickets and
-- prices (only anonymous DELETE is now blocked). Deleting a ticket from the app
-- still works because the app is signed in (authenticated), not anon.


-- ============================================================================
-- PHASE 1 — Add authenticated policies ALONGSIDE the existing anon ones.
-- This changes nothing yet (anon still works) but lets signed-in staff operate
-- once anon is removed in Phase 2. Deploy the whole fleet and confirm every
-- machine is signed in and fully functional before proceeding.
-- ============================================================================

-- tickets: full access for signed-in staff.
DROP POLICY IF EXISTS "auth all tickets" ON public.tickets;
CREATE POLICY "auth all tickets" ON public.tickets
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Catalogue / benchmark / PPI tables: signed-in staff may write (the app
-- confirms sku_aliases and can trigger PPI). Bulk importers use the SERVICE key
-- (bypasses RLS), so they need no policy.
DROP POLICY IF EXISTS "auth write component_prices" ON public.component_prices;
CREATE POLICY "auth write component_prices" ON public.component_prices
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth write price_history" ON public.price_history;
CREATE POLICY "auth write price_history" ON public.price_history
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth write component_performance" ON public.component_performance;
CREATE POLICY "auth write component_performance" ON public.component_performance
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth all sku_aliases" ON public.sku_aliases;
CREATE POLICY "auth all sku_aliases" ON public.sku_aliases
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth write ticket_ppi" ON public.ticket_ppi;
CREATE POLICY "auth write ticket_ppi" ON public.ticket_ppi
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ticket_queries + ticket_flags: signed-in staff only.
ALTER TABLE public.ticket_queries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth all ticket_queries" ON public.ticket_queries;
CREATE POLICY "auth all ticket_queries" ON public.ticket_queries
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- profiles: let signed-in staff READ all profiles (the ticket form needs the
-- sales-exec / technician dropdown). Editing stays self-only via the existing
-- column grants, so this does NOT let anyone change another user's tier.
DROP POLICY IF EXISTS "auth read profiles" ON public.profiles;
CREATE POLICY "auth read profiles" ON public.profiles
  FOR SELECT TO authenticated USING (true);


-- ============================================================================
-- PHASE 2 — LOCK DOWN. Run ONLY after Phase 1 is confirmed across the fleet.
-- Removes anon read/write of customer data and locks catalogue writes.
-- Public SELECT stays on the NON-PII catalogue/benchmark tables so the customer
-- "Track your build" PPI panel keeps working.
-- ============================================================================

-- 2a. tickets — remove ALL anon access (this is the PII table).
DROP POLICY IF EXISTS "Allow anonymous read access"   ON public.tickets;
DROP POLICY IF EXISTS "Allow anonymous insert access" ON public.tickets;
DROP POLICY IF EXISTS "Allow anonymous update access" ON public.tickets;

-- 2b. Customer "Track your build" lookup — anon can no longer read the tickets
-- table, so expose ONE ticket by its short code through a SECURITY DEFINER
-- function that returns only customer-safe columns (note: NOT the serials column,
-- which the old customer.html SELECT * leaked). Ambiguity is handled by the
-- caller (returns up to 2 rows; the page asks for more characters if >1).
CREATE OR REPLACE FUNCTION public.get_ticket_public(code text)
RETURNS TABLE (
  id text, customer_name text, status text, type text, technician text,
  created_at timestamptz, deadline timestamptz, completed_at timestamptz, diagnostics jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, customer_name, status, type, technician,
         created_at, deadline, completed_at, diagnostics
  FROM public.tickets
  WHERE code IS NOT NULL AND length(code) >= 4 AND id ILIKE '%' || code
  LIMIT 2;
$$;
REVOKE ALL ON FUNCTION public.get_ticket_public(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_ticket_public(text) TO anon, authenticated;
-- NOTE: if the returned `diagnostics` JSONB contains internal notes you don't
-- want customers to see, curate the SELECT above to a whitelisted subset.

-- 2c. Catalogue / benchmark / PPI — drop anon WRITE, keep anon READ (not PII;
-- the customer PPI panel and older read-only clients need it).
DROP POLICY IF EXISTS "Allow anon insert component_prices"     ON public.component_prices;
DROP POLICY IF EXISTS "Allow anon update component_prices"     ON public.component_prices;
DROP POLICY IF EXISTS "Allow anon insert price_history"        ON public.price_history;
DROP POLICY IF EXISTS "Allow anon insert component_performance" ON public.component_performance;
DROP POLICY IF EXISTS "Allow anon update component_performance" ON public.component_performance;
DROP POLICY IF EXISTS "Allow anon all sku_aliases"            ON public.sku_aliases;
-- sku_aliases had a single FOR ALL anon policy (read+write). Re-add anon READ
-- only, since matching may read it before sign-in:
DROP POLICY IF EXISTS "anon read sku_aliases" ON public.sku_aliases;
CREATE POLICY "anon read sku_aliases" ON public.sku_aliases
  FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Allow anon insert ticket_ppi" ON public.ticket_ppi;
DROP POLICY IF EXISTS "Allow anon update ticket_ppi" ON public.ticket_ppi;
-- (anon SELECT policies on component_prices / price_history / component_performance
--  / ticket_ppi are intentionally LEFT in place for the customer-facing panels.)

-- 2d. ticket_flags — drop the anon fallback now that the fleet is authenticated.
DROP POLICY IF EXISTS tf_read_anon  ON public.ticket_flags;
DROP POLICY IF EXISTS tf_write_anon ON public.ticket_flags;
-- (tf_read / tf_write for authenticated remain from the original schema.)


-- ============================================================================
-- PHASE 3 — ROTATE THE ANON KEY (do this LAST, in the Supabase dashboard).
-- The current anon key is burned: it is in git history and every shipped build.
-- Settings → API → "Roll" the anon (publishable) key, then update it in:
--   dashboard/app.js, index.html/app.js/main.js (the app), and rebuild + OTA.
-- After rotation, the old key is useless even to someone who kept a copy.
-- ============================================================================


-- ============================================================================
-- PHASE 4 (FOLLOW-UP) — TRUE per-technician scoping (the "T2 sees only their
-- own builds" rule) enforced by the DATABASE, not client JS.
-- Requires a stable identity column, because the current `technician` field is a
-- free-text NAME (unreliable to match to a user). Steps:
--   1. ALTER TABLE public.tickets ADD COLUMN technician_uid uuid REFERENCES auth.users(id);
--   2. Backfill technician_uid from your profiles table where names match, and
--      have the app set it on assignment going forward.
--   3. Replace "auth all tickets" SELECT with a tier-aware policy, e.g.:
--        CREATE POLICY "tickets tiered read" ON public.tickets FOR SELECT TO authenticated
--        USING (
--          (SELECT tier FROM public.profiles WHERE id = auth.uid()) >= 3   -- leads/admin: all
--          OR technician_uid = auth.uid()                                   -- techs: own only
--        );
--   Until Phase 4, all signed-in staff can read all tickets at the DB level
--   (the client still shows T2 only their own — UX, not a security boundary).
-- ============================================================================
