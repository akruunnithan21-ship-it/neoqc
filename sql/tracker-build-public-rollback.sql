-- =============================================================================
-- tracker-build-public-rollback.sql — undo sql/tracker-build-public.sql
-- -----------------------------------------------------------------------------
-- Removes get_build_public, its helpers and the throttle table. The website's
-- build tracker then falls back to the limited view (status and dates only).
-- The customer_phone column is KEPT: it holds phone numbers the sales desk
-- typed in, and dropping it loses them. Drop it by hand only if you mean to.
-- =============================================================================

begin;

drop function if exists public.get_build_public(text, text);
drop function if exists public._build_status_from_label(text);
drop function if exists public._tracker_num(jsonb);
drop table if exists public.tracker_lookup_failures;

-- If get_ticket_public was revoked after the switch, give it back:
grant execute on function public.get_ticket_public(text) to anon, authenticated;

commit;

-- alter table public.tickets drop column if exists customer_phone;   -- loses data
