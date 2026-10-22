-- =============================================================================
-- NEO TOKYO OPERATIONS — Work queue (v2.2): one queue for builds and service,
-- offers, staff presets, People admin, NeoHR sign-in and work logs
-- Migration name: work_queue_v2_2            Target: Postgres 17 on Supabase
-- Ships with Neo OS 1.11.0.
-- -----------------------------------------------------------------------------
-- DEPLOY ORDER
--   1. sql/service-v2.sql     (live)
--   2. sql/service-v2.1.sql   (live)
--   3. sql/work-queue.sql     (this file)
--   Re-running service-v2.sql puts back v2's own service_claim, service_create,
--   my_modules and service_tech_list. After ANY re-run of service-v2.sql,
--   re-run service-v2.1.sql and then this file. This file is re-runnable on
--   its own: a second run changes nothing that people edited since (staff
--   rows, roles, presets, claim clocks). The first run (staff_work still
--   empty) seeds the presets and applies them to every active staff member.
--   A later run seeds nothing (a deleted or renamed preset stays so) and gives
--   a preset only to active staff who have neither a staff_work row nor a
--   service / rma / qc role; anyone else without a row gets a pools-false row
--   and keeps their roles. People admin always leaves a staff_work row.
--   Optional, separately: sql/work-queue-cron.sql schedules work_tick() every
--   minute with pg_cron. Without it the apps drive the clock (the desktop calls
--   work_tick() every 60 s, phones on refresh).
--   Tests: sql/work-queue.tests.sql (one transaction, ends in ROLLBACK).
--
-- WHAT THIS DOES (owner decisions 2026-10-22)
--   * New PC builds (public.tickets) and service tickets (public.service_jobs)
--     wait in ONE queue. Anyone in the pool may claim what suits them.
--   * Every queued item has 4 hours to be claimed. After that the server offers
--     it to the best free technician (skill + load). An offer — from the app or
--     from a lead — must be accepted within 30 minutes; a decline (with a
--     reason) or silence ends it, skips that person for this item, alerts the
--     leads, and (once past the 4 hours) offers it to the next best person.
--   * Builds of tier 4-5 only for senior builders.
--   * Designation presets give people their module roles and work pools; the
--     owner edits people (tier 4+) in Neo OS. No names are hard-coded.
--   * NeoHR (the phone) signs in with the Neo OS email + PIN and syncs its work
--     logs; tier 3+ see everyone's.
--
-- OLD CLIENTS KEEP WORKING (v1.9.11 and 1.10.0 desktops, the website)
--   * Every new column is nullable or defaulted; old inserts name only old columns.
--   * A non-RPC UPDATE of a build silently KEEPS the server-owned columns
--     (technician, technician_email, assignment, queue and offer columns), so a
--     stale whole-row upsert from any PC can never undo a claim or an offer.
--     Consequence: old desktops can no longer change a build's technician
--     (their auto-assign and their technician select are ignored).
--   * A non-RPC INSERT of a build with a technician name becomes a 'legacy'
--     assignment, mapped to that person's email by first name (no match: the
--     name stays on the build, no email); with specs.__queued = true it enters
--     the queue; anything else (the website's quotes) is "not sent to the floor".
--   * updated_at written by a client is clamped to at most now() + 2 minutes and
--     never goes backwards; RPC writes always move it forward.
--   * service_claim keeps its exact v2 signature, answers and events, and now
--     also requires the caller's service pool ("You aren't in the service
--     pool."), and refuses — without writing anything — an item live-offered to
--     someone else: {ok:false, reason:'offered', by, by_email, to_name,
--     expires_at} (old apps read it as "taken by <name>"). A live offer to the
--     caller is accepted. So old clients can no longer take an item offered to
--     someone else, and people outside the pool can no longer claim at all.
--   * service_create ignores assign_self ("take it myself") for anyone outside
--     the service pool (the ticket queues instead).
--   * service_assign is unchanged: a lead's direct assignment (it ends any
--     live offer on the ticket).
--   * service_tech_list lists only service-pool members, with the same keys as
--     before plus the new ones; my_modules keeps its keys plus three new ones.
--   * get_ticket_public, find_builds, service_release and every other v2 / v2.1
--     behaviour is untouched.
--
-- CONVENTIONS (as service-v2.sql / service-v2.1.sql)
--   * Errors for people: NEO_<KIND>: <a human sentence>. Clients strip the prefix.
--   * Every API RPC is security definer, search_path = public, and starts with
--     v_me := public._neo_me() (work_tick: only when a JWT is present).
--   * Protected writes run under the transaction-local flags neo.assign / neo.rpc
--     (_flag_set / _flag_restore); neo.migrating covers this file's backfill.
--   * Locking: every RPC that changes one item locks it (select … for update)
--     and re-checks everything on the locked row. work_tick takes each batch
--     with FOR UPDATE SKIP LOCKED. _work_auto_offer takes the advisory lock
--     'neo_work_pick' before it picks; code holding it locks further items only
--     with SKIP LOCKED. A person's profile row is locked before their items
--     (claims and accepts take FOR SHARE on the caller first; a deactivation
--     takes FOR UPDATE, then tickets by id, then service_jobs by id).
--   * Emails on offers and in declined_emails are stored lower(btrim()).
--   * Clock times inside sentences are India time (Asia/Kolkata), HH24:MI.
--
-- Apply as ONE migration. Nothing here deletes customer data.
-- =============================================================================

set local lock_timeout = '15s';


-- =============================================================================
-- §1  TABLES
-- =============================================================================

-- Who works the queue, and how much they can hold. One row per person; a
-- person without a row reads as "in no pool, default capacity" everywhere.
create table if not exists public.staff_work (
  profile_id      uuid primary key references public.profiles(id) on delete cascade,
  build_pool      boolean not null default false,
  service_pool    boolean not null default false,
  build_level     text check (build_level in ('junior','senior')),
  capacity_points int not null default 6 check (capacity_points between 1 and 50),
  max_jobs        int not null default 4 check (max_jobs between 1 and 20),
  updated_by      text,
  updated_at      timestamptz not null default now()
);

-- What a designation gives someone (applied by People admin; never live-linked).
create table if not exists public.designation_presets (
  key             text primary key,
  designation     text not null,
  service_role    text check (service_role in ('desk','tech','lead')),
  rma_role        text check (rma_role in ('desk','tech','lead')),
  qc_role         text check (qc_role in ('desk','tech','lead')),
  build_pool      boolean not null default false,
  service_pool    boolean not null default false,
  build_level     text check (build_level in ('junior','senior')),
  capacity_points int check (capacity_points between 1 and 50),
  max_jobs        int check (max_jobs between 1 and 20),
  note            text,
  updated_by      text,
  updated_at      timestamptz not null default now()
);

-- "Needs a lead": a decline, an offer nobody answered, an item nobody can take.
create table if not exists public.work_alerts (
  id           bigint generated always as identity primary key,
  kind         text not null check (kind in ('declined','expired','no_candidate')),
  item_kind    text not null check (item_kind in ('build','service')),
  item_id      text not null,
  item_code    text,
  title        text,
  body         text not null,
  person_email text,
  person_name  text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  text
);
-- One open alert per item, kind and person (_work_alert inserts ON CONFLICT DO NOTHING).
create unique index if not exists work_alerts_open_key
  on public.work_alerts (item_kind, item_id, kind, (coalesce(person_email, ''))) where resolved_at is null;
create index if not exists work_alerts_item_idx on public.work_alerts (item_kind, item_id, created_at desc);

-- The queue history of every item, both kinds (service items also keep their
-- service_events rows).
create table if not exists public.work_events (
  id           bigint generated always as identity primary key,
  item_kind    text not null check (item_kind in ('build','service')),
  item_id      text not null,
  kind         text not null check (kind in ('queued','claim','offer','offer_withdrawn','accept','decline',
                                             'offer_expired','auto_offer','release','reassigned','legacy',
                                             'no_candidate')),
  actor_email  text,
  actor_name   text,
  target_email text,
  target_name  text,
  body         text not null,
  meta         jsonb not null default '{}'::jsonb,
  at           timestamptz not null default now()
);
create index if not exists work_events_item_idx on public.work_events (item_kind, item_id, at desc);

-- NeoHR work logs. The phone's Room database is the source; this is the synced
-- copy. employee_email is the history key: deleting a leaver's login keeps
-- their logs (profile_id goes null). Photos stay on the phone in this release.
create table if not exists public.work_logs (
  id             uuid primary key,
  profile_id     uuid references public.profiles(id) on delete set null,
  employee_email text not null,
  title          text not null check (char_length(title) between 1 and 300),
  description    text check (description is null or char_length(description) <= 5000),
  category       text not null default 'Work' check (char_length(category) between 1 and 60),
  location_name  text check (location_name is null or char_length(location_name) <= 200),
  latitude       double precision,
  longitude      double precision,
  created_at     timestamptz not null,
  updated_at     timestamptz not null,
  deleted_at     timestamptz,
  received_at    timestamptz not null default now()
);
create index if not exists work_logs_profile_idx on public.work_logs (profile_id, created_at desc);
create index if not exists work_logs_email_idx on public.work_logs (lower(employee_email), created_at desc);
create index if not exists work_logs_pull_idx on public.work_logs (profile_id, received_at, id);


-- =============================================================================
-- §1b ROW LEVEL SECURITY AND TABLE GRANTS — right after the tables, so they are
--      never open, even between the parts of a split deploy.
--      Supabase grants ALL on new public tables to anon and authenticated by
--      default: every table here is revoked and granted SELECT only. All
--      writes go through the definer RPCs and triggers.
-- =============================================================================

alter table public.staff_work enable row level security;
drop policy if exists sw_select on public.staff_work;
create policy sw_select on public.staff_work for select to authenticated
  using ((select public.my_tier()) >= 1);
revoke all on table public.staff_work from anon, authenticated;
grant select on table public.staff_work to authenticated;

alter table public.designation_presets enable row level security;
drop policy if exists dp_select on public.designation_presets;
create policy dp_select on public.designation_presets for select to authenticated
  using ((select public.my_tier()) >= 1);
revoke all on table public.designation_presets from anon, authenticated;
grant select on table public.designation_presets to authenticated;

-- Alerts: tier 3+, or the lead of that kind (builds: qc lead; service: service lead).
alter table public.work_alerts enable row level security;
drop policy if exists wa_select on public.work_alerts;
create policy wa_select on public.work_alerts for select to authenticated
  using ((select public.my_tier()) >= 3
         or (item_kind = 'build' and (select public.has_module('qc', 'lead')))
         or (item_kind = 'service' and (select public.has_module('service', 'lead'))));
revoke all on table public.work_alerts from anon, authenticated;
grant select on table public.work_alerts to authenticated;

-- History: whoever may read that kind of item (desk and up).
alter table public.work_events enable row level security;
drop policy if exists we_select on public.work_events;
create policy we_select on public.work_events for select to authenticated
  using ((item_kind = 'build' and (select public.has_module('qc', 'desk')))
         or (item_kind = 'service' and (select public.has_module('service', 'desk'))));
revoke all on table public.work_events from anon, authenticated;
grant select on table public.work_events to authenticated;

-- Work logs: your own, or everyone's for tier 3+.
alter table public.work_logs enable row level security;
drop policy if exists wl_select on public.work_logs;
create policy wl_select on public.work_logs for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.my_tier()) >= 3);
revoke all on table public.work_logs from anon, authenticated;
grant select on table public.work_logs to authenticated;

-- The identity sequences behind work_alerts / work_events: nobody but the definer code inserts.
do $$
declare v_seq text;
begin
  foreach v_seq in array array[pg_get_serial_sequence('public.work_alerts', 'id'),
                               pg_get_serial_sequence('public.work_events', 'id')] loop
    if v_seq is not null then
      execute format('revoke all on sequence %s from anon, authenticated', v_seq);
    end if;
  end loop;
end $$;

-- Realtime: the desktop listens to alerts ("Needs a lead", the rail dot).
-- RLS applies to what each subscriber receives. work_logs is never published.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'work_queue_v2_2: publication supabase_realtime not found; realtime for work_alerts skipped';
    return;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'work_alerts') then
    execute format('alter publication supabase_realtime add table public.%I', 'work_alerts');
  end if;
end $$;


-- =============================================================================
-- §2  NEW COLUMNS (all nullable or defaulted: old apps and the website insert
--     explicit column lists and never name these)
-- =============================================================================

alter table public.tickets add column if not exists technician_email text;
alter table public.tickets add column if not exists assigned_via text
  check (assigned_via in ('claim','manager','auto','legacy'));
alter table public.tickets add column if not exists assigned_at timestamptz;
alter table public.tickets add column if not exists assign_reason text;
alter table public.tickets add column if not exists queued_at timestamptz;
alter table public.tickets add column if not exists offered_to_email text;
alter table public.tickets add column if not exists offered_to_name text;
alter table public.tickets add column if not exists offer_kind text check (offer_kind in ('manager','auto'));
alter table public.tickets add column if not exists offer_by_email text;
alter table public.tickets add column if not exists offer_by_name text;
alter table public.tickets add column if not exists offer_reason text;
alter table public.tickets add column if not exists offered_at timestamptz;
alter table public.tickets add column if not exists offer_expires_at timestamptz;
alter table public.tickets add column if not exists declined_emails text[] not null default '{}';
alter table public.tickets add column if not exists auto_tried_at timestamptz;

create index if not exists tickets_tech_email_open_idx on public.tickets (lower(technician_email))
  where status is distinct from 'completed';
create index if not exists tickets_queue_idx on public.tickets (queued_at)
  where technician_email is null and status is distinct from 'completed';
create index if not exists tickets_offer_exp_idx on public.tickets (offer_expires_at) where offer_expires_at is not null;

alter table public.service_jobs add column if not exists offered_to_email text;
alter table public.service_jobs add column if not exists offered_to_name text;
alter table public.service_jobs add column if not exists offer_kind text check (offer_kind in ('manager','auto'));
alter table public.service_jobs add column if not exists offer_by_email text;
alter table public.service_jobs add column if not exists offer_by_name text;
alter table public.service_jobs add column if not exists offer_reason text;
alter table public.service_jobs add column if not exists offered_at timestamptz;
alter table public.service_jobs add column if not exists offer_expires_at timestamptz;
alter table public.service_jobs add column if not exists declined_emails text[] not null default '{}';
alter table public.service_jobs add column if not exists auto_tried_at timestamptz;

create index if not exists sj_offer_exp_idx on public.service_jobs (offer_expires_at) where offer_expires_at is not null;

-- service_jobs.assigned_via gains 'auto' (an accepted app offer). v2 declared
-- the CHECK inline on "add column", so its name came from Postgres: every pure
-- enumeration CHECK on assigned_via is dropped and one named check comes back.
-- A compound business rule that mentions the column stays. Re-runnable.
do $$
declare r record;
begin
  for r in
    select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
     where conrelid = 'public.service_jobs'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ~* '\massigned_via\M'
  loop
    if r.def !~* '\m(and|or)\M' then
      execute format('alter table public.%I drop constraint %I', 'service_jobs', r.conname);
    else
      raise notice 'work_queue_v2_2: left the compound check % (%) in place', r.conname, r.def;
    end if;
  end loop;
end $$;

alter table public.service_jobs add constraint service_jobs_assigned_via_check
  check (assigned_via in ('claim','manager','legacy','self','auto'));

-- service_events.kind gains 'offer' — only where an enumeration CHECK exists
-- (v2 adds one only if the live table already had one). Same folding as v2:
-- the union of the old values and this list, never narrower.
do $$
declare
  c record;
  r record;
  v_vals text[];
  v_list text;
  v_name text;
  v_found boolean;
begin
  for c in
    select * from (values
      ('service_events', 'kind', false, array[
        'stage','note','edit','media','claim','release','assign','rma','field','suggest','priority','offer'])
    ) as t(tbl, col, always_add, vals)
  loop
    v_name := c.tbl || '_' || c.col || '_v2_check';
    v_vals := c.vals;
    v_found := false;
    for r in
      select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
       where conrelid = format('public.%I', c.tbl)::regclass and contype = 'c'
    loop
      if (r.def ~* ('\m' || c.col || '\M\)?(::[a-z ]+)?\s*=\s*any\s*\(')
          or r.def ~* ('\m' || c.col || '\M\)?(::[a-z ]+)?\s+in\s*\('))
         and r.def !~* '\m(and|or)\M' then
        v_vals := v_vals || coalesce((select array_agg(m[1]) from regexp_matches(r.def, '''([^'']*)''', 'g') as m), '{}'::text[]);
        v_found := true;
        execute format('alter table public.%I drop constraint %I', c.tbl, r.conname);
      end if;
    end loop;
    continue when not (c.always_add or v_found);
    select string_agg(quote_literal(x), ', ' order by x) into v_list
      from (select distinct unnest(v_vals) as x) s where x is not null and x <> '';
    execute format('alter table public.%I add constraint %I check (%I in (%s)) not valid', c.tbl, v_name, c.col, v_list);
    begin
      execute format('alter table public.%I validate constraint %I', c.tbl, v_name);
    exception when check_violation then
      raise notice 'work_queue_v2_2: a legacy row in %.% has an unknown value; % applies to new writes only',
        c.tbl, c.col, v_name;
    end;
  end loop;
end $$;


-- =============================================================================
-- §3  HELPERS (internal: no client role may execute them)
-- =============================================================================

-- Every internal of this file is locked down the moment it exists: the
-- definitions below sit inside DO blocks (one statement each, so a deploy
-- split into parts can never cut one in two) that end by calling this. It is
-- an invoker function: run by anyone else it changes nothing.
do $wq$
begin
create or replace function public._work_lockdown()
returns void language plpgsql volatile set search_path = public as $$
declare r record;
begin
  for r in
    select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname ~ '^(_work_|_preset_apply$|_svc_apply_visit$|_svc_visit_event$|_svc_category_label$|_designation_key$|_build_tier$|_first_name$|_staff_for_short_name$|_ist_hm$|tg_tickets_work_|tg_service_jobs_zy_offer_|tg_service_jobs_work_gone$)'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;
perform public._work_lockdown();
end $wq$;

-- ── §3 part 1 of 4 (one statement: defined, then locked down) ──
do $wq$
begin

-- Presets are matched on a normalised designation: trimmed, one space, lower case.
create or replace function public._designation_key(p text)
returns text language sql immutable parallel safe set search_path = public as $$
  select lower(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')))
$$;

-- The build tier the desktop keeps in specs.__build.tier (1-5). Never raises:
-- junk, a missing key, a string or an out-of-range number read as 1..5.
create or replace function public._build_tier(p_specs jsonb)
returns int language plpgsql immutable set search_path = public as $$
declare v text; n numeric;
begin
  if p_specs is null or jsonb_typeof(p_specs) <> 'object' then return 1; end if;
  if jsonb_typeof(p_specs -> '__build') is distinct from 'object' then return 1; end if;
  v := btrim(coalesce(p_specs -> '__build' ->> 'tier', ''));
  if v !~ '^[0-9]{1,6}(\.[0-9]+)?$' then return 1; end if;
  n := floor(v::numeric);
  return least(5, greatest(1, n))::int;
end $$;

-- First word of a full name: what the build board shows as the technician.
create or replace function public._first_name(p_full text)
returns text language sql immutable set search_path = public as $$
  select split_part(regexp_replace(btrim(coalesce(p_full, '')), '\s+', ' ', 'g'), ' ', 1)
$$;

-- The one active staff member whose first name is the first word of p_name;
-- a row of nulls when nobody or more than one person matches.
create or replace function public._staff_for_short_name(p_name text)
returns public.profiles language plpgsql stable security definer set search_path = public as $$
declare
  v public.profiles;
  v_first text := lower(public._first_name(p_name));
  n int;
begin
  if v_first = '' then return v; end if;
  select count(*) into n from public.profiles p
   where p.active and coalesce(p.is_staff, false) and lower(public._first_name(p.full_name)) = v_first;
  if n <> 1 then return v; end if;
  select * into v from public.profiles p
   where p.active and coalesce(p.is_staff, false) and lower(public._first_name(p.full_name)) = v_first;
  return v;
end $$;

-- Capacity defaults by build level (points, jobs).
create or replace function public._work_defaults(p_level text, out capacity int, out max_jobs int)
language sql immutable set search_path = public as $$
  select case p_level when 'senior' then 8 when 'junior' then 5 else 6 end,
         case p_level when 'senior' then 5 when 'junior' then 3 else 4 end
$$;

-- A person's work settings with the defaults applied (LEFT JOIN: no row = no pool).
create or replace function public._work_settings(p_profile_id uuid,
  out build_pool boolean, out service_pool boolean, out build_level text, out capacity_points int, out max_jobs int)
language sql stable security definer set search_path = public as $$
  select coalesce(sw.build_pool, false), coalesce(sw.service_pool, false), sw.build_level,
         coalesce(sw.capacity_points, (public._work_defaults(sw.build_level)).capacity),
         coalesce(sw.max_jobs, (public._work_defaults(sw.build_level)).max_jobs)
    from (select p_profile_id as id) x
    left join public.staff_work sw on sw.profile_id = x.id
$$;

-- Load points: a build costs its tier, an on-site visit 2, other service 1.
create or replace function public._work_cost_build(p_specs jsonb)
returns int language sql immutable set search_path = public as $$
  select public._build_tier(p_specs)
$$;

create or replace function public._work_cost_service(p_type text)
returns int language sql immutable set search_path = public as $$
  select case when p_type = 'on_site' then 2 else 1 end
$$;

-- What a person holds now: open items assigned to them plus live offers to them.
create or replace function public._work_load(p_email text, out points int, out jobs int)
language sql stable security definer set search_path = public as $$
  with e as (select lower(btrim(coalesce(p_email, ''))) as em),
  items as (
    select public._work_cost_build(t.specs) as cost
      from public.tickets t, e
     where e.em <> '' and t.status is distinct from 'completed'
       and (lower(t.technician_email) = e.em
            or (t.offer_expires_at > now() and lower(t.offered_to_email) = e.em
                and lower(coalesce(t.technician_email, '')) <> e.em))
    union all
    select public._work_cost_service(s.service_type)
      from public.service_jobs s, e
     where e.em <> '' and s.stage <> 'closed'
       and (lower(s.assignee_email) = e.em
            or (s.offer_expires_at > now() and lower(s.offered_to_email) = e.em
                and lower(coalesce(s.assignee_email, '')) <> e.em))
  )
  select coalesce(sum(cost), 0)::int, count(*)::int from items
$$;

-- Why a person may NOT take an item of this kind: null (they may) or one of
-- 'not_staff' | 'no_role' | 'no_pool' | 'senior'. The one eligibility rule,
-- used by claims, offers, accepts, the picker and the feeds.
create or replace function public._work_why_not(p_kind text, p_item_tier int, p_profile_id uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  p public.profiles;
  s record;
begin
  select * into p from public.profiles where id = p_profile_id;
  if not found or not p.active or not coalesce(p.is_staff, false) then return 'not_staff'; end if;
  if public.role_rank(public._module_role_of(p.id, case when p_kind = 'build' then 'qc' else 'service' end)) < 2 then
    return 'no_role';
  end if;
  select * into s from public._work_settings(p.id);
  if (p_kind = 'build' and not s.build_pool) or (p_kind <> 'build' and not s.service_pool) then
    return 'no_pool';
  end if;
  if p_kind = 'build' and coalesce(p_item_tier, 1) >= 4 and s.build_level is distinct from 'senior' then
    return 'senior';
  end if;
  return null;
end $$;

-- The sentences the apps show (exact text). p_self: "You …" for the caller,
-- "They …" for someone else.
create or replace function public._work_why_text(p_kind text, p_code text, p_self boolean)
returns text language sql immutable set search_path = public as $$
  select case p_code
    when 'not_staff' then case when p_self then 'You don''t have an active staff account.'
                               else 'They don''t have an active staff account.' end
    when 'no_role'   then case when p_self then 'You don''t' else 'They don''t' end
                          || case when p_kind = 'build' then ' have the Builds technician role.'
                                  else ' have the Service technician role.' end
    when 'no_pool'   then case when p_self then 'You aren''t' else 'They aren''t' end
                          || case when p_kind = 'build' then ' in the build pool.' else ' in the service pool.' end
    when 'senior'    then 'This is a high-value build — only senior builders can take it.'
    else null
  end
$$;

-- Category words, identical to the JS model (shared/service-status.js CATEGORIES).
create or replace function public._svc_category_label(p text)
returns text language sql immutable set search_path = public as $$
  select case p
    when 'repair'         then 'Repair'
    when 'warranty_claim' then 'Warranty claim'
    when 'upgrade'        then 'Upgrade'
    when 'installation'   then 'Installation'
    when 'data_recovery'  then 'Data recovery'
    when 'os_software'    then 'OS / software'
    when 'networking'     then 'Networking'
    when 'maintenance'    then 'Maintenance'
    when 'diagnosis_only' then 'Diagnosis only'
    else coalesce(p, 'Service')
  end
$$;

-- A clock time in shop time, for sentences: "14:05".
create or replace function public._ist_hm(p timestamptz)
returns text language sql stable set search_path = public as $$
  select to_char(p at time zone 'Asia/Kolkata', 'HH24:MI')
$$;

create or replace function public._work_kind(p_kind text)
returns text language plpgsql immutable set search_path = public as $$
declare v text := lower(btrim(coalesce(p_kind, '')));
begin
  if v not in ('build', 'service') then
    raise exception 'NEO_GATE: Say which kind of work this is: build or service.';
  end if;
  return v;
end $$;

-- Does a live offer to someone else stop p_email from taking the item?
create or replace function public._work_offer_blocks(p_to text, p_expires timestamptz, p_email text)
returns boolean language sql stable set search_path = public as $$
  select coalesce(p_expires > now(), false) and p_to is not null
         and lower(p_to) <> lower(coalesce(p_email, ''))
$$;

-- The caller's own profile, locked FOR SHARE until the end of the transaction,
-- so a deactivation either waits for this claim / accept or makes it fail.
create or replace function public._work_me_lock(p_me public.profiles)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  perform 1 from public.profiles where id = p_me.id and active and coalesce(is_staff, false) for share;
  if not found then
    raise exception 'NEO_DENIED: Sign in with an active staff account to do this.';
  end if;
end $$;

create or replace function public._work_event(
  p_kind text, p_id text, p_ev text, p_body text,
  p_actor_email text default null, p_actor_name text default null,
  p_target_email text default null, p_target_name text default null,
  p_meta jsonb default '{}'::jsonb)
returns void language sql volatile security definer set search_path = public as $$
  insert into public.work_events (item_kind, item_id, kind, actor_email, actor_name, target_email, target_name, body, meta)
  values (p_kind, p_id, p_ev,
          nullif(lower(btrim(coalesce(p_actor_email, ''))), ''), p_actor_name,
          nullif(lower(btrim(coalesce(p_target_email, ''))), ''), p_target_name,
          coalesce(nullif(btrim(coalesce(p_body, '')), ''), p_ev), coalesce(p_meta, '{}'::jsonb))
$$;

-- An alert unless the same one is already open. Returns whether it was written.
create or replace function public._work_alert(
  p_alert text, p_kind text, p_id text, p_code text, p_title text, p_body text,
  p_person_email text default null, p_person_name text default null)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  insert into public.work_alerts (kind, item_kind, item_id, item_code, title, body, person_email, person_name)
  values (p_alert, p_kind, p_id, p_code, p_title, p_body,
          nullif(lower(btrim(coalesce(p_person_email, ''))), ''), p_person_name)
  on conflict (item_kind, item_id, kind, (coalesce(person_email, ''))) where resolved_at is null do nothing;
  return found;
end $$;

create or replace function public._work_alerts_resolve(p_kind text, p_id text, p_by text)
returns int language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  update public.work_alerts set resolved_at = now(), resolved_by = coalesce(nullif(btrim(coalesce(p_by, '')), ''), 'Neo OS')
   where item_kind = p_kind and item_id = p_id and resolved_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- The only writers of the offer columns (both under neo.assign).
create or replace function public._work_offer_set(
  p_kind text, p_id text, p_target public.profiles, p_offer_kind text,
  p_by_email text, p_by_name text, p_reason text)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  v_prev text;
  v_to text := lower(btrim(p_target.email));
  v_by text := nullif(lower(btrim(coalesce(p_by_email, ''))), '');
begin
  v_prev := public._flag_set('neo.assign');
  if p_kind = 'build' then
    update public.tickets
       set offered_to_email = v_to, offered_to_name = p_target.full_name, offer_kind = p_offer_kind,
           offer_by_email = v_by, offer_by_name = p_by_name, offer_reason = p_reason,
           offered_at = now(), offer_expires_at = now() + interval '30 minutes',
           declined_emails = array_remove(declined_emails, v_to),
           updated_at = greatest(now(), coalesce(updated_at, now()) + interval '1 millisecond')
     where id = p_id;
  else
    update public.service_jobs
       set offered_to_email = v_to, offered_to_name = p_target.full_name, offer_kind = p_offer_kind,
           offer_by_email = v_by, offer_by_name = p_by_name, offer_reason = p_reason,
           offered_at = now(), offer_expires_at = now() + interval '30 minutes',
           declined_emails = array_remove(declined_emails, v_to)
     where id = p_id;
  end if;
  perform public._flag_restore('neo.assign', v_prev);
end $$;

-- Clears the offer (and the auto-offer throttle, which belongs to it).
-- p_decline: also add this email to declined_emails (never a null).
create or replace function public._work_offer_clear(p_kind text, p_id text, p_decline text default null)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  v_prev text;
  v_d text := nullif(lower(btrim(coalesce(p_decline, ''))), '');
begin
  v_prev := public._flag_set('neo.assign');
  if p_kind = 'build' then
    update public.tickets
       set offered_to_email = null, offered_to_name = null, offer_kind = null, offer_by_email = null,
           offer_by_name = null, offer_reason = null, offered_at = null, offer_expires_at = null, auto_tried_at = null,
           declined_emails = case when v_d is null then declined_emails
                                  else array_append(array_remove(declined_emails, v_d), v_d) end,
           updated_at = greatest(now(), coalesce(updated_at, now()) + interval '1 millisecond')
     where id = p_id;
  else
    update public.service_jobs
       set offered_to_email = null, offered_to_name = null, offer_kind = null, offer_by_email = null,
           offer_by_name = null, offer_reason = null, offered_at = null, offer_expires_at = null, auto_tried_at = null,
           declined_emails = case when v_d is null then declined_emails
                                  else array_append(array_remove(declined_emails, v_d), v_d) end
     where id = p_id;
  end if;
  perform public._flag_restore('neo.assign', v_prev);
end $$;

-- The best free person for an item: eligible, not declined, not the one
-- already offered or holding it, with room (points + cost <= capacity, jobs +
-- 1 <= max). Most room first, then fewest jobs, then (tier 4-5 builds) senior,
-- then name. A row of nulls when nobody fits.
create or replace function public._work_pick(p_kind text, p_id text)
returns public.profiles language plpgsql stable security definer set search_path = public as $$
declare
  v public.profiles;
  v_tier int;
  v_cost int;
  v_declined text[];
  v_offered text;
  v_holder text;
begin
  if p_kind = 'build' then
    select public._build_tier(t.specs), public._work_cost_build(t.specs), t.declined_emails,
           lower(t.offered_to_email), lower(t.technician_email)
      into v_tier, v_cost, v_declined, v_offered, v_holder
      from public.tickets t where t.id = p_id;
  else
    select null::int, public._work_cost_service(s.service_type), s.declined_emails,
           lower(s.offered_to_email), lower(s.assignee_email)
      into v_tier, v_cost, v_declined, v_offered, v_holder
      from public.service_jobs s where s.id = p_id;
  end if;
  if not found then return v; end if;

  select p.* into v
    from public.profiles p
    cross join lateral public._work_settings(p.id) w
    cross join lateral public._work_load(p.email) l
   where p.active and coalesce(p.is_staff, false)
     and public._work_why_not(p_kind, v_tier, p.id) is null
     and not coalesce(lower(p.email) = any (coalesce(v_declined, '{}'::text[])), false)
     and lower(p.email) is distinct from v_offered
     and lower(p.email) is distinct from v_holder
     and l.points + v_cost <= w.capacity_points
     and l.jobs + 1 <= w.max_jobs
   order by (w.capacity_points - l.points) desc, l.jobs asc,
            case when p_kind = 'build' and coalesce(v_tier, 1) >= 4 and w.build_level = 'senior' then 0 else 1 end,
            p.full_name asc, p.email asc
   limit 1;
  return v;
end $$;

perform public._work_lockdown();
end $wq$;

-- ── §3 part 2 of 4 (one statement: defined, then locked down) ──
do $wq$
begin

-- The app's offer, for an open item whose 4 hours are up. The caller holds the
-- item's row lock. Always stamps auto_tried_at (step 2 of work_tick retries a
-- stuck item at most every 10 minutes). Nobody free: one 'no_candidate' alert
-- + event, unless one is open or was dismissed less than 30 minutes ago.
-- Returns null when the item is not open, else {offered, …}.
create or replace function public._work_auto_offer(p_kind text, p_id text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_t public.tickets;
  v_s public.service_jobs;
  v_pick public.profiles;
  v_open boolean;
  v_code text;
  v_title text;
  v_prev text;
  v_reason constant text := 'Not claimed in 4 hours — you have the most room.';
  v_body text;
begin
  perform pg_advisory_xact_lock(hashtext('neo_work_pick'));
  if p_kind = 'build' then
    select * into v_t from public.tickets where id = p_id;
    if not found then return null; end if;
    v_open := v_t.technician_email is null and btrim(coalesce(v_t.technician, '')) = ''
              and v_t.status is distinct from 'completed' and v_t.queued_at is not null
              and not coalesce(v_t.offer_expires_at > now(), false);
    v_code := upper(right(v_t.id, 6));
    v_title := v_t.customer_name;
  else
    select * into v_s from public.service_jobs where id = p_id;
    if not found then return null; end if;
    v_open := v_s.assignee_email is null and v_s.stage <> 'closed'
              and not coalesce(v_s.offer_expires_at > now(), false);
    v_code := v_s.public_code;
    v_title := coalesce(nullif(btrim(coalesce(v_s.device_label, '')), ''), public._svc_category_label(v_s.category));
  end if;
  if not v_open then return null; end if;

  v_prev := public._flag_set('neo.assign');
  if p_kind = 'build' then
    update public.tickets set auto_tried_at = now(),
           updated_at = greatest(now(), coalesce(updated_at, now()) + interval '1 millisecond')
     where id = p_id;
  else
    update public.service_jobs set auto_tried_at = now() where id = p_id;
  end if;
  perform public._flag_restore('neo.assign', v_prev);

  v_pick := public._work_pick(p_kind, p_id);
  if v_pick.id is not null then
    perform public._work_offer_set(p_kind, p_id, v_pick, 'auto', null, 'Neo OS', v_reason);
    v_body := 'Offered to ' || v_pick.full_name || ' by Neo OS: ' || v_reason;
    perform public._work_event(p_kind, p_id, 'auto_offer', v_body, null, 'Neo OS', v_pick.email, v_pick.full_name,
                               jsonb_build_object('expires_at', now() + interval '30 minutes', 'reason', v_reason));
    if p_kind = 'service' then
      perform public._svc_ev(p_id, 'offer', v_body, false, null, null,
        jsonb_build_object('offer_kind', 'auto', 'to_email', lower(v_pick.email), 'by_email', null,
                           'reason', v_reason, 'event', 'auto_offer'),
        'system', null, 'Neo OS');
    end if;
    return jsonb_build_object('offered', true, 'to_email', lower(v_pick.email), 'to_name', v_pick.full_name,
                              'expires_at', now() + interval '30 minutes');
  end if;

  if exists (select 1 from public.work_alerts a
              where a.item_kind = p_kind and a.item_id = p_id and a.kind = 'no_candidate'
                and (a.resolved_at is null or a.resolved_at > now() - interval '30 minutes')) then
    return jsonb_build_object('offered', false, 'stuck', true, 'alerted', false);
  end if;
  v_body := 'Nobody free can take ' || v_code || ' — offer it to someone or wait for room.';
  perform public._work_alert('no_candidate', p_kind, p_id, v_code, v_title, v_body);
  perform public._work_event(p_kind, p_id, 'no_candidate', v_body, null, 'Neo OS');
  return jsonb_build_object('offered', false, 'stuck', true, 'alerted', true);
end $$;

-- ONE work item, from p_me's point of view (the ITEM shape of work_queue).
-- Null when the row does not exist.
create or replace function public._work_item(p_kind text, p_id text, p_me public.profiles)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  t public.tickets;
  s public.service_jobs;
  v_em text := lower(coalesce(p_me.email, ''));
  v_open boolean; v_live boolean; v_to_me boolean; v_mine boolean;
  v_tier int; v_why text; v_role text; v_offer jsonb; v_due timestamptz; v_customer text;
begin
  if p_kind = 'build' then
    select * into t from public.tickets where id = p_id;
    if not found then return null; end if;
    v_tier := public._build_tier(t.specs);
    v_open := t.technician_email is null and btrim(coalesce(t.technician, '')) = ''
              and t.status is distinct from 'completed' and t.queued_at is not null;
    v_live := coalesce(t.offer_expires_at > now(), false) and t.offered_to_email is not null;
    v_to_me := v_live and lower(t.offered_to_email) = v_em;
    v_mine := v_em <> '' and lower(coalesce(t.technician_email, '')) = v_em;
    v_why := public._work_why_not('build', v_tier, p_me.id);
    v_due := case when v_open then t.queued_at + interval '4 hours' end;
    v_offer := case when v_live then jsonb_build_object(
                 'to_email', t.offered_to_email, 'to_name', t.offered_to_name, 'kind', t.offer_kind,
                 'by_name', t.offer_by_name, 'reason', t.offer_reason,
                 'offered_at', t.offered_at, 'expires_at', t.offer_expires_at) end;
    return jsonb_build_object(
      'kind', 'build', 'id', t.id, 'code', upper(right(t.id, 6)), 'title', t.customer_name,
      'sub', nullif(concat_ws(' · ', nullif(btrim(coalesce(t.specs ->> 'cpu', '')), ''),
                                     nullif(btrim(coalesce(t.specs ->> 'gpu', '')), '')), ''),
      'customer', t.customer_name, 'area', null, 'service_type', null, 'stage', t.status,
      'priority', case when t.deadline < now() + interval '48 hours' then 'urgent' else 'normal' end,
      'build_tier', v_tier, 'needs_senior', v_tier >= 4,
      'deadline', t.deadline, 'queued_at', t.queued_at, 'claim_due', v_due,
      'cost', public._work_cost_build(t.specs),
      'assignee_email', t.technician_email, 'assignee_name', nullif(btrim(coalesce(t.technician, '')), ''),
      'assigned_via', t.assigned_via, 'assigned_at', t.assigned_at,
      'offer', v_offer, 'declined_count', coalesce(cardinality(t.declined_emails), 0),
      'mine', v_mine, 'offered_to_me', v_to_me,
      'can_claim', v_open and (not v_live or v_to_me) and v_why is null,
      'why_not', case when not v_open then null
                      when v_why is not null then public._work_why_text('build', v_why, true)
                      when v_live and not v_to_me
                        then 'Offered to ' || coalesce(t.offered_to_name, t.offered_to_email)
                             || ' until ' || public._ist_hm(t.offer_expires_at) || '.'
                      else null end);
  end if;

  select * into s from public.service_jobs where id = p_id;
  if not found then return null; end if;
  v_open := s.assignee_email is null and s.stage <> 'closed';
  v_live := coalesce(s.offer_expires_at > now(), false) and s.offered_to_email is not null;
  v_to_me := v_live and lower(s.offered_to_email) = v_em;
  v_mine := v_em <> '' and lower(coalesce(s.assignee_email, '')) = v_em;
  v_why := public._work_why_not('service', null, p_me.id);
  v_role := public._module_role_of(p_me.id, 'service');
  v_due := case when v_open then coalesce(s.queued_at, s.created_at) + interval '4 hours' end;
  -- A pure technician sees a first name until the job is theirs; the desk and
  -- leads see the whole name. Never the phone or the address: the area only.
  v_customer := case when v_mine or v_role in ('desk', 'lead') then s.customer_name
                     else nullif(public._first_name(s.customer_name), '') end;
  v_offer := case when v_live then jsonb_build_object(
               'to_email', s.offered_to_email, 'to_name', s.offered_to_name, 'kind', s.offer_kind,
               'by_name', s.offer_by_name, 'reason', s.offer_reason,
               'offered_at', s.offered_at, 'expires_at', s.offer_expires_at) end;
  return jsonb_build_object(
    'kind', 'service', 'id', s.id, 'code', s.public_code,
    'title', coalesce(nullif(btrim(coalesce(s.device_label, '')), ''), public._svc_category_label(s.category)),
    'sub', public._svc_type_label(s.service_type) || ' · ' || public._svc_category_label(s.category),
    'customer', v_customer, 'area', s.site_area, 'service_type', s.service_type, 'stage', s.stage,
    'priority', s.priority, 'build_tier', null, 'needs_senior', false,
    'deadline', coalesce(s.visit_start, s.needed_by), 'queued_at', s.queued_at, 'claim_due', v_due,
    'cost', public._work_cost_service(s.service_type),
    'assignee_email', s.assignee_email, 'assignee_name', s.assignee,
    'assigned_via', s.assigned_via, 'assigned_at', s.assigned_at,
    'offer', v_offer, 'declined_count', coalesce(cardinality(s.declined_emails), 0),
    'mine', v_mine, 'offered_to_me', v_to_me,
    'can_claim', v_open and (not v_live or v_to_me) and v_why is null,
    'why_not', case when not v_open then null
                    when v_why is not null then public._work_why_text('service', v_why, true)
                    when v_live and not v_to_me
                      then 'Offered to ' || coalesce(s.offered_to_name, s.offered_to_email)
                           || ' until ' || public._ist_hm(s.offer_expires_at) || '.'
                    else null end);
end $$;

-- service_claim's visit rules, shared with the accept path (A15). Only the
-- visit/stage UPDATE (neo.rpc), no events. A no-op when there is no visit time
-- or the ticket is in-store. Returns {job, from, to, moved, old_start, start, when}.
create or replace function public._svc_apply_visit(p_job_id text, p_me public.profiles, p_start timestamptz, p_end timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v public.service_jobs;
  v_from text;
  v_to text;
  v_old timestamptz;
  v_moved boolean := false;
  v_prev text;
begin
  select * into v from public.service_jobs where id = p_job_id;
  if not found then return null; end if;
  v_from := v.stage;
  v_old := v.visit_start;
  if p_start is null or v.service_type not in ('on_site', 'remote') then
    return jsonb_build_object('job', to_jsonb(v), 'from', v_from, 'to', null, 'moved', false,
                              'old_start', v_old, 'start', null, 'when', null);
  end if;
  v_to := case when v.service_type = 'on_site' and v.stage in ('logged', 'revisit_needed') then 'scheduled'
               when v.service_type = 'remote' and v.stage = 'logged' then 'session_booked'
               else null end;
  -- The desk had already booked a time with the customer and the technician
  -- takes it at a different one: the stage does not change, so nothing else
  -- would tell the customer their visit moved.
  v_moved := v_to is null and v_from in ('scheduled', 'session_booked')
             and v_old is not null and p_start is distinct from v_old;
  v_prev := public._flag_set('neo.rpc');
  update public.service_jobs
     set visit_start = p_start,
         visit_end   = p_end,
         stage       = coalesce(v_to, stage),
         stage_since = case when v_to is not null then now() else stage_since end
   where id = p_job_id
  returning * into v;
  perform public._flag_restore('neo.rpc', v_prev);
  return jsonb_build_object('job', to_jsonb(v), 'from', v_from, 'to', v_to, 'moved', v_moved,
                            'old_start', v_old, 'start', p_start, 'when', public._ist(p_start));
end $$;

-- The customer-visible line for a booked or moved visit, with today's texts.
create or replace function public._svc_visit_event(p_job_id text, p_info jsonb, p_me public.profiles)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  v_to text := p_info ->> 'to';
  v_from text := p_info ->> 'from';
  v_when text := p_info ->> 'when';
begin
  if p_info is null then return; end if;
  if v_to is not null then
    perform public._svc_ev(p_job_id, 'stage',
      case when v_to = 'scheduled' then 'Visit booked for ' else 'Remote session booked for ' end || v_when || '.',
      true, v_from, v_to, '{}'::jsonb, 'staff', p_me.email, p_me.full_name);
  elsif coalesce((p_info ->> 'moved')::boolean, false) then
    -- A stage-kind line with no stage pair: the ticket stays where it is, so
    -- every timeline (v1.9.11's included) shows just the sentence.
    perform public._svc_ev(p_job_id, 'stage',
      case when v_from = 'scheduled' then 'Visit moved to ' else 'Remote session moved to ' end || v_when || '.',
      true, null, null, jsonb_build_object('visit_was', p_info -> 'old_start', 'visit_start', p_info -> 'start'),
      'staff', p_me.email, p_me.full_name);
  end if;
end $$;

perform public._work_lockdown();
end $wq$;

-- ── §3 part 3 of 4 (one statement: defined, then locked down) ──
do $wq$
begin

-- Accepting a live offer (work_respond, work_claim and service_claim come
-- here). Raises only for a bad visit time, before any write. A caller who is
-- no longer eligible (A4) gets {ok:false, reason:'not_eligible', why} and the
-- offer ends — that cleanup commits.
create or replace function public._work_accept(
  p_kind text, p_id text, p_me public.profiles,
  p_visit_start timestamptz default null, p_visit_end timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  t public.tickets;
  s public.service_jobs;
  v_em text := lower(p_me.email);
  v_live boolean; v_declined text[]; v_why text; v_txt text; v_code text; v_title text;
  v_okind text; v_by_email text; v_by_name text; v_reason text;
  v_prev_email text; v_prev_name text; v_unassigned boolean; v_due timestamptz;
  v_next jsonb; v_info jsonb; v_prev text; v_body text;
begin
  if p_visit_start is not null and p_visit_end is not null and p_visit_end < p_visit_start then
    raise exception 'NEO_GATE: The visit ends before it starts.';
  end if;

  if p_kind = 'build' then
    select * into t from public.tickets where id = p_id for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    v_live := coalesce(t.offer_expires_at > now(), false) and lower(t.offered_to_email) = v_em;
    v_declined := t.declined_emails;
    v_why := public._work_why_not('build', public._build_tier(t.specs), p_me.id);
    v_code := upper(right(t.id, 6)); v_title := t.customer_name;
    v_okind := t.offer_kind; v_by_email := t.offer_by_email; v_by_name := t.offer_by_name; v_reason := t.offer_reason;
    v_prev_email := lower(t.technician_email); v_prev_name := nullif(btrim(coalesce(t.technician, '')), '');
    v_unassigned := v_prev_email is null and v_prev_name is null;
    v_due := case when t.queued_at is not null then t.queued_at + interval '4 hours' end;
    if t.status = 'completed' then v_live := false; end if;
  else
    select * into s from public.service_jobs where id = p_id for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    v_live := coalesce(s.offer_expires_at > now(), false) and lower(s.offered_to_email) = v_em;
    v_declined := s.declined_emails;
    v_why := public._work_why_not('service', null, p_me.id);
    v_code := s.public_code;
    v_title := coalesce(nullif(btrim(coalesce(s.device_label, '')), ''), public._svc_category_label(s.category));
    v_okind := s.offer_kind; v_by_email := s.offer_by_email; v_by_name := s.offer_by_name; v_reason := s.offer_reason;
    v_prev_email := lower(s.assignee_email); v_prev_name := s.assignee;
    v_unassigned := v_prev_email is null;
    v_due := case when v_unassigned then coalesce(s.queued_at, s.created_at) + interval '4 hours' end;
    if s.stage = 'closed' then v_live := false; end if;
  end if;

  if not v_live then
    return jsonb_build_object('ok', false,
      'reason', case when coalesce(v_em = any (coalesce(v_declined, '{}'::text[])), false) then 'expired' else 'not_offered' end);
  end if;

  -- A4: re-checked on the locked row (the build tier, pools and roles may have
  -- changed since the offer was made).
  if v_why is not null then
    v_txt := public._work_why_text(p_kind, v_why, false);
    perform public._work_offer_clear(p_kind, p_id, v_em);
    v_body := 'Offer to ' || p_me.full_name || ' ended — ' || v_txt;
    perform public._work_event(p_kind, p_id, 'offer_withdrawn', v_body, null, 'Neo OS', p_me.email, p_me.full_name,
                               jsonb_build_object('why', v_why));
    if p_kind = 'service' then
      perform public._svc_ev(p_id, 'offer', v_body, false, null, null,
        jsonb_build_object('offer_kind', v_okind, 'to_email', v_em, 'by_email', v_by_email, 'reason', v_txt,
                           'event', 'offer_withdrawn'),
        'system', null, 'Neo OS');
    end if;
    perform public._work_alert('declined', p_kind, p_id, v_code, v_title, v_body, p_me.email, p_me.full_name);
    if v_unassigned and v_due is not null and now() >= v_due then
      v_next := public._work_auto_offer(p_kind, p_id);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'not_eligible',
                              'why', public._work_why_text(p_kind, v_why, true), 'next', v_next);
  end if;

  perform public._work_me_lock(p_me);

  v_prev := public._flag_set('neo.assign');
  if p_kind = 'build' then
    update public.tickets
       set technician = public._first_name(p_me.full_name), technician_email = v_em,
           assigned_via = v_okind, assigned_at = now(), assign_reason = v_reason, queued_at = null,
           offered_to_email = null, offered_to_name = null, offer_kind = null, offer_by_email = null,
           offer_by_name = null, offer_reason = null, offered_at = null, offer_expires_at = null,
           auto_tried_at = null, declined_emails = '{}',
           updated_at = greatest(now(), coalesce(updated_at, now()) + interval '1 millisecond')
     where id = p_id;
  else
    update public.service_jobs
       set assignee = p_me.full_name, assignee_email = p_me.email,
           assigned_via = v_okind, assigned_at = now(), assign_reason = v_reason, queued_at = null,
           offered_to_email = null, offered_to_name = null, offer_kind = null, offer_by_email = null,
           offer_by_name = null, offer_reason = null, offered_at = null, offer_expires_at = null,
           auto_tried_at = null, declined_emails = '{}'
     where id = p_id;
  end if;
  perform public._flag_restore('neo.assign', v_prev);

  if not v_unassigned then
    perform public._work_event(p_kind, p_id, 'reassigned',
      'Reassigned from ' || coalesce(v_prev_name, v_prev_email) || ' to ' || p_me.full_name || '.',
      v_by_email, coalesce(v_by_name, 'Neo OS'), p_me.email, p_me.full_name,
      jsonb_build_object('from_email', v_prev_email, 'from_name', v_prev_name));
    if p_kind = 'service' then
      perform public._svc_ev(p_id, 'release',
        'Unassigned by ' || coalesce(v_by_name, 'Neo OS') || ' (was ' || coalesce(v_prev_name, v_prev_email) || ')'
          || ': offered to ' || p_me.full_name || coalesce(' — ' || v_reason, ''),
        false, null, null,
        jsonb_build_object('tech_email', v_prev_email, 'by_email', v_by_email, 'reason', v_reason, 'via', 'manager'),
        'staff', v_by_email, coalesce(v_by_name, 'Neo OS'));
    end if;
  end if;

  if p_kind = 'service' then
    v_info := public._svc_apply_visit(p_id, p_me, p_visit_start, p_visit_end);
    perform public._svc_ev(p_id, 'assign',
      'Assigned to ' || p_me.full_name || ' by ' || coalesce(v_by_name, 'Neo OS')
        || case when not v_unassigned then ' (was ' || coalesce(v_prev_name, v_prev_email) || ')' else '' end
        || ' — offer accepted' || coalesce(': ' || v_reason, ''),
      false, null, null,
      jsonb_build_object('tech_email', p_me.email, 'via', v_okind, 'by_email', v_by_email, 'reason', v_reason),
      'staff', p_me.email, p_me.full_name);
    perform public._svc_visit_event(p_id, v_info, p_me);
  end if;

  perform public._work_event(p_kind, p_id, 'accept', p_me.full_name || ' accepted the offer.',
                             p_me.email, p_me.full_name, p_me.email, p_me.full_name,
                             jsonb_build_object('offer_kind', v_okind, 'by_email', v_by_email, 'reason', v_reason));
  perform public._work_alerts_resolve(p_kind, p_id, p_me.email);
  return jsonb_build_object('ok', true, 'item', public._work_item(p_kind, p_id, p_me))
         || case when p_kind = 'service' then jsonb_build_object('job', v_info -> 'job') else '{}'::jsonb end;
end $$;

-- An offer nobody answered (work_tick step 1). The caller holds the row lock.
-- Treated as a decline with the reason "No answer in 30 minutes".
create or replace function public._work_expire(p_kind text, p_id text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  t public.tickets;
  s public.service_jobs;
  v_to text; v_to_name text; v_okind text; v_by text; v_code text; v_title text;
  v_unassigned boolean; v_due timestamptz; v_next jsonb; v_body text;
  v_why constant text := 'No answer in 30 minutes';
begin
  if p_kind = 'build' then
    select * into t from public.tickets where id = p_id;
    if not found or t.offer_expires_at is null or t.offer_expires_at > now() then return null; end if;
    v_to := lower(t.offered_to_email); v_to_name := t.offered_to_name; v_okind := t.offer_kind; v_by := t.offer_by_email;
    v_code := upper(right(t.id, 6)); v_title := t.customer_name;
    v_unassigned := t.technician_email is null and btrim(coalesce(t.technician, '')) = ''
                    and t.status is distinct from 'completed';
    v_due := case when t.queued_at is not null then t.queued_at + interval '4 hours' end;
  else
    select * into s from public.service_jobs where id = p_id;
    if not found or s.offer_expires_at is null or s.offer_expires_at > now() then return null; end if;
    v_to := lower(s.offered_to_email); v_to_name := s.offered_to_name; v_okind := s.offer_kind; v_by := s.offer_by_email;
    v_code := s.public_code;
    v_title := coalesce(nullif(btrim(coalesce(s.device_label, '')), ''), public._svc_category_label(s.category));
    v_unassigned := s.assignee_email is null and s.stage <> 'closed';
    v_due := case when v_unassigned then coalesce(s.queued_at, s.created_at) + interval '4 hours' end;
  end if;

  perform public._work_offer_clear(p_kind, p_id, v_to);
  if v_to is not null then
    v_body := 'Offer to ' || coalesce(v_to_name, v_to) || ' expired: ' || v_why || '.';
    perform public._work_event(p_kind, p_id, 'offer_expired', v_body, null, 'Neo OS', v_to, v_to_name,
                               jsonb_build_object('offer_kind', v_okind, 'reason', v_why));
    if p_kind = 'service' then
      perform public._svc_ev(p_id, 'offer', v_body, false, null, null,
        jsonb_build_object('offer_kind', v_okind, 'to_email', v_to, 'by_email', v_by, 'reason', v_why,
                           'event', 'offer_expired'),
        'system', null, 'Neo OS');
    end if;
    perform public._work_alert('expired', p_kind, p_id, v_code, v_title,
      'No answer from ' || coalesce(v_to_name, v_to) || ' on ' || v_code || ' in 30 minutes.', v_to, v_to_name);
  end if;
  if v_unassigned and v_due is not null and now() >= v_due then
    v_next := public._work_auto_offer(p_kind, p_id);
  end if;
  return jsonb_build_object('expired', true, 'next', v_next);
end $$;

-- A build handed back (by its technician, a lead, or a deactivation). The
-- caller holds the row lock and has checked who may do it.
create or replace function public._work_release_build(p_id text, p_me public.profiles, p_reason text)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  t public.tickets;
  v_prev text;
  v_was text;
begin
  select * into t from public.tickets where id = p_id;
  v_was := lower(t.technician_email);
  v_prev := public._flag_set('neo.assign');
  update public.tickets
     set technician = null, technician_email = null, assigned_via = null, assigned_at = null, assign_reason = null,
         queued_at = now(),
         offered_to_email = null, offered_to_name = null, offer_kind = null, offer_by_email = null,
         offer_by_name = null, offer_reason = null, offered_at = null, offer_expires_at = null, auto_tried_at = null,
         declined_emails = case when v_was is null then '{}'::text[] else array[v_was] end,
         updated_at = greatest(now(), coalesce(updated_at, now()) + interval '1 millisecond')
   where id = p_id;
  perform public._flag_restore('neo.assign', v_prev);
  perform public._work_event('build', p_id, 'release',
    'Handed back by ' || p_me.full_name
      || case when v_was is distinct from lower(p_me.email)
              then ' (was ' || coalesce(nullif(btrim(coalesce(t.technician, '')), ''), v_was, 'nobody') || ')' else '' end
      || ': ' || p_reason,
    p_me.email, p_me.full_name, v_was, nullif(btrim(coalesce(t.technician, '')), ''),
    jsonb_build_object('reason', p_reason, 'from_email', v_was));
end $$;

-- Someone was switched off (staff_update): their items go back to the queue
-- and offers to them end. The profile is already updated and locked. Locks
-- tickets by id, then service_jobs by id.
create or replace function public._work_person_gone(p_t public.profiles, p_me public.profiles)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  r record;
  v_job public.service_jobs;
  v_em text := lower(p_t.email);
  v_name text := coalesce(nullif(btrim(coalesce(p_t.full_name, '')), ''), p_t.email);
  v_reason text := coalesce(nullif(btrim(coalesce(p_t.full_name, '')), ''), p_t.email) || ' is no longer active';
  v_prev text;
begin
  for r in
    select t.id, lower(t.technician_email) as tech, lower(t.offered_to_email) as offered
      from public.tickets t
     where t.status is distinct from 'completed'
       and (lower(t.technician_email) = v_em or lower(t.offered_to_email) = v_em)
     order by t.id
       for update
  loop
    if r.tech = v_em then
      perform public._work_release_build(r.id, p_me, v_reason);
    elsif r.offered = v_em then
      perform public._work_offer_clear('build', r.id);
      perform public._work_event('build', r.id, 'offer_withdrawn', 'Offer to ' || v_name || ' withdrawn — ' || v_reason || '.',
                                 p_me.email, p_me.full_name, v_em, p_t.full_name, '{}'::jsonb);
    end if;
  end loop;

  for r in
    select s.id from public.service_jobs s
     where s.stage <> 'closed'
       and (lower(s.assignee_email) = v_em or lower(s.offered_to_email) = v_em)
     order by s.id
       for update
  loop
    select * into v_job from public.service_jobs where id = r.id;
    if lower(v_job.assignee_email) = v_em then
      perform public._svc_unassign(v_job, p_me, v_reason, 'manager');
      v_prev := public._flag_set('neo.rpc');
      update public.service_jobs set declined_emails = array[v_em] where id = r.id;
      perform public._flag_restore('neo.rpc', v_prev);
      perform public._work_event('service', r.id, 'release',
        'Handed back by ' || p_me.full_name || ' (was ' || v_name || '): ' || v_reason,
        p_me.email, p_me.full_name, v_em, p_t.full_name, jsonb_build_object('reason', v_reason, 'from_email', v_em));
    elsif lower(v_job.offered_to_email) = v_em then
      perform public._work_offer_clear('service', r.id);
      perform public._work_event('service', r.id, 'offer_withdrawn', 'Offer to ' || v_name || ' withdrawn — ' || v_reason || '.',
                                 p_me.email, p_me.full_name, v_em, p_t.full_name, '{}'::jsonb);
      perform public._svc_ev(r.id, 'offer', 'Offer to ' || v_name || ' withdrawn — ' || v_reason || '.', false, null, null,
        jsonb_build_object('offer_kind', v_job.offer_kind, 'to_email', v_em, 'by_email', lower(p_me.email),
                           'reason', v_reason, 'event', 'offer_withdrawn'),
        'staff', p_me.email, p_me.full_name);
    end if;
  end loop;
end $$;

perform public._work_lockdown();
end $wq$;

-- ── §3 part 4 of 4 (one statement: defined, then locked down) ──
do $wq$
begin

-- A designation preset applied to one person (backfill, staff_update with
-- apply_preset, staff_apply_preset). For service / rma / qc a role upserts the
-- module row and a null role DELETES it; neohr is never touched. staff_work
-- gets the pools and level, capacity from the preset or the level default.
-- Returns false when no preset has that key (nothing changes).
create or replace function public._preset_apply(p_profile uuid, p_key text, p_by text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  v public.designation_presets;
  m text;
  v_role text;
begin
  select * into v from public.designation_presets where key = p_key;
  if not found then return false; end if;
  foreach m in array array['service', 'rma', 'qc'] loop
    v_role := case m when 'service' then v.service_role when 'rma' then v.rma_role else v.qc_role end;
    if v_role is null then
      delete from public.module_access where profile_id = p_profile and module = m;
    else
      insert into public.module_access (profile_id, module, role, granted_by, granted_at)
      values (p_profile, m, v_role, p_by, now())
      on conflict (profile_id, module) do update
         set role = excluded.role, granted_by = excluded.granted_by, granted_at = now();
    end if;
  end loop;
  insert into public.staff_work (profile_id, build_pool, service_pool, build_level, capacity_points, max_jobs,
                                 updated_by, updated_at)
  values (p_profile, v.build_pool, v.service_pool, v.build_level,
          coalesce(v.capacity_points, (public._work_defaults(v.build_level)).capacity),
          coalesce(v.max_jobs, (public._work_defaults(v.build_level)).max_jobs),
          p_by, now())
  on conflict (profile_id) do update
     set build_pool = excluded.build_pool, service_pool = excluded.service_pool, build_level = excluded.build_level,
         capacity_points = excluded.capacity_points, max_jobs = excluded.max_jobs,
         updated_by = excluded.updated_by, updated_at = now();
  return true;
end $$;

-- One People row (staff_list / staff_update).
create or replace function public._work_staff_entry(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'email', p.email, 'full_name', p.full_name, 'designation', p.designation,
    'department', p.department, 'tier', p.tier, 'active', p.active, 'is_staff', coalesce(p.is_staff, false),
    -- read through to_jsonb: a column the auth schema lacks reads as null
    'last_sign_in_at', (select to_jsonb(u) -> 'last_sign_in_at' from auth.users u where u.id = p.id),
    'roles', jsonb_build_object(
      'service', (select ma.role from public.module_access ma where ma.profile_id = p.id and ma.module = 'service'),
      'rma',     (select ma.role from public.module_access ma where ma.profile_id = p.id and ma.module = 'rma'),
      'qc',      (select ma.role from public.module_access ma where ma.profile_id = p.id and ma.module = 'qc')),
    'auto_lead', p.tier >= 3,
    'build_pool', w.build_pool, 'service_pool', w.service_pool, 'build_level', w.build_level,
    'capacity_points', w.capacity_points, 'max_jobs', w.max_jobs,
    'preset_key', (select dp.key from public.designation_presets dp where dp.key = public._designation_key(p.designation)),
    'open_items',
      (select count(*) from public.tickets t
        where lower(t.technician_email) = lower(p.email) and t.status is distinct from 'completed')
      + (select count(*) from public.service_jobs s
          where lower(s.assignee_email) = lower(p.email) and s.stage <> 'closed'))
    from public.profiles p
    cross join lateral public._work_settings(p.id) w
   where p.id = p_id
$$;

perform public._work_lockdown();
end $wq$;


-- =============================================================================
-- §4  TRIGGERS (security definer: they work the same for an old client's
--     direct write and an RPC, and call internals no client may execute)
-- =============================================================================

-- ── tickets BEFORE INSERT OR UPDATE: the server owns who has a build ────────
-- Never raises.
create or replace function public.tg_tickets_work_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_rpc boolean := coalesce(current_setting('neo.rpc', true), '') = '1'
                   or coalesce(current_setting('neo.assign', true), '') = '1';
  v_who public.profiles;
begin
  if coalesce(current_setting('neo.migrating', true), '') = '1' then return new; end if;

  if tg_op = 'UPDATE' then
    if not v_rpc then
      -- A whole-row upsert from v1.9.11 / 1.10.0 / a Testing Client PC
      -- carries stale values for these; they are kept, silently.
      new.technician := old.technician;
      new.technician_email := old.technician_email;
      new.assigned_via := old.assigned_via;
      new.assigned_at := old.assigned_at;
      new.assign_reason := old.assign_reason;
      new.queued_at := old.queued_at;
      new.offered_to_email := old.offered_to_email;
      new.offered_to_name := old.offered_to_name;
      new.offer_kind := old.offer_kind;
      new.offer_by_email := old.offer_by_email;
      new.offer_by_name := old.offer_by_name;
      new.offer_reason := old.offer_reason;
      new.offered_at := old.offered_at;
      new.offer_expires_at := old.offer_expires_at;
      new.declined_emails := old.declined_emails;
      new.auto_tried_at := old.auto_tried_at;
    end if;
    -- Finished: off the queue, no offer, alerts settled (whoever completes it).
    if new.status = 'completed' and old.status is distinct from 'completed' then
      new.queued_at := null;
      new.offered_to_email := null; new.offered_to_name := null; new.offer_kind := null;
      new.offer_by_email := null; new.offer_by_name := null; new.offer_reason := null;
      new.offered_at := null; new.offer_expires_at := null; new.auto_tried_at := null;
      new.declined_emails := '{}';
      perform public._work_alerts_resolve('build', new.id, 'Neo OS');
    end if;
    -- Two clocks write updated_at (the server's and each PC's): a PC clock
    -- ahead is clamped, and the value never goes backwards, so "newer wins"
    -- on the desktops always sees a server change as newer.
    new.updated_at := greatest(least(coalesce(new.updated_at, now()), now() + interval '2 minutes'),
                               coalesce(old.updated_at, '-infinity'::timestamptz) + interval '1 millisecond');
    return new;
  end if;

  -- INSERT
  if not v_rpc then
    new.technician_email := null; new.assigned_via := null; new.assigned_at := null; new.assign_reason := null;
    new.queued_at := null;
    new.offered_to_email := null; new.offered_to_name := null; new.offer_kind := null;
    new.offer_by_email := null; new.offer_by_name := null; new.offer_reason := null;
    new.offered_at := null; new.offer_expires_at := null; new.auto_tried_at := null;
    new.declined_emails := '{}';
    if btrim(coalesce(new.technician, '')) <> '' then
      -- An older Neo OS chose the technician: keep it, as a legacy assignment.
      v_who := public._staff_for_short_name(new.technician);
      new.technician_email := lower(v_who.email);
      new.assigned_via := 'legacy';
      new.assigned_at := now();
    elsif coalesce(new.specs ->> '__queued', '') = 'true' and new.status is distinct from 'completed' then
      -- v1.9.11's "everyone is full, waiting queue".
      new.queued_at := now();
    end if;
    -- Otherwise a quote: "not sent to the floor" until build_queue_send.
  end if;
  new.updated_at := least(coalesce(new.updated_at, now()), now() + interval '2 minutes');
  return new;
end $$;

drop trigger if exists trg_tickets_work_guard on public.tickets;
create trigger trg_tickets_work_guard before insert or update on public.tickets
  for each row execute function public.tg_tickets_work_guard();

-- ── tickets AFTER INSERT: the queue history of an old client's new build ────
create or replace function public.tg_tickets_work_added()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('neo.migrating', true), '') = '1' then return null; end if;
  if new.assigned_via = 'legacy' then
    perform public._work_event('build', new.id, 'legacy',
      'Assigned to ' || btrim(new.technician) || ' by an older Neo OS.', auth.email(), null,
      new.technician_email, btrim(new.technician), '{}'::jsonb);
  elsif new.queued_at is not null and new.technician_email is null then
    perform public._work_event('build', new.id, 'queued', 'Sent to the build queue by an older Neo OS.',
                               auth.email(), null, null, null, '{}'::jsonb);
  end if;
  return null;
end $$;

drop trigger if exists trg_tickets_work_added on public.tickets;
create trigger trg_tickets_work_added after insert on public.tickets
  for each row execute function public.tg_tickets_work_added();

-- ── tickets / service_jobs AFTER DELETE: nothing left for a lead to act on ──
create or replace function public.tg_tickets_work_gone()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._work_alerts_resolve('build', old.id, 'Neo OS');
  return null;
end $$;

drop trigger if exists trg_tickets_work_gone on public.tickets;
create trigger trg_tickets_work_gone after delete on public.tickets
  for each row execute function public.tg_tickets_work_gone();

create or replace function public.tg_service_jobs_work_gone()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._work_alerts_resolve('service', old.id, 'Neo OS');
  return null;
end $$;

drop trigger if exists trg_service_jobs_work_gone on public.service_jobs;
create trigger trg_service_jobs_work_gone after delete on public.service_jobs
  for each row execute function public.tg_service_jobs_work_gone();

-- ── service_jobs BEFORE UPDATE: the offer columns. Sorts after
--    trg_service_jobs_guard and before trg_service_jobs_zz_secret_purge.
--    Never raises.
create or replace function public.tg_service_jobs_zy_offer_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_rpc boolean := coalesce(current_setting('neo.rpc', true), '') = '1'
                   or coalesce(current_setting('neo.assign', true), '') = '1';
  v_closing boolean;
  v_assigning boolean;
begin
  if coalesce(current_setting('neo.migrating', true), '') = '1' then return new; end if;
  if not v_rpc then
    new.offered_to_email := old.offered_to_email;
    new.offered_to_name := old.offered_to_name;
    new.offer_kind := old.offer_kind;
    new.offer_by_email := old.offer_by_email;
    new.offer_by_name := old.offer_by_name;
    new.offer_reason := old.offer_reason;
    new.offered_at := old.offered_at;
    new.offer_expires_at := old.offer_expires_at;
    new.declined_emails := old.declined_emails;
    new.auto_tried_at := old.auto_tried_at;
  end if;
  v_closing := new.stage = 'closed' and old.stage is distinct from 'closed';
  v_assigning := new.assignee_email is distinct from old.assignee_email and new.assignee_email is not null;
  -- Whoever has it changed (a claim, a release, a lead's direct edit or
  -- service_assign) or it closed: any offer on it is over.
  if new.assignee_email is distinct from old.assignee_email or v_closing then
    new.offered_to_email := null; new.offered_to_name := null; new.offer_kind := null;
    new.offer_by_email := null; new.offer_by_name := null; new.offer_reason := null;
    new.offered_at := null; new.offer_expires_at := null; new.auto_tried_at := null;
  end if;
  if v_assigning or v_closing then
    new.declined_emails := '{}';
    perform public._work_alerts_resolve('service', new.id, 'Neo OS');
  end if;
  return new;
end $$;

drop trigger if exists trg_service_jobs_zy_offer_guard on public.service_jobs;
create trigger trg_service_jobs_zy_offer_guard before update on public.service_jobs
  for each row execute function public.tg_service_jobs_zy_offer_guard();

-- ── service_jobs BEFORE INSERT: a direct insert carries no offer ───────────
create or replace function public.tg_service_jobs_zy_offer_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('neo.migrating', true), '') = '1' then return new; end if;
  if not (coalesce(current_setting('neo.rpc', true), '') = '1'
          or coalesce(current_setting('neo.assign', true), '') = '1') then
    new.offered_to_email := null; new.offered_to_name := null; new.offer_kind := null;
    new.offer_by_email := null; new.offer_by_name := null; new.offer_reason := null;
    new.offered_at := null; new.offer_expires_at := null; new.auto_tried_at := null;
    new.declined_emails := '{}';
  end if;
  return new;
end $$;

drop trigger if exists trg_service_jobs_zy_offer_insert on public.service_jobs;
create trigger trg_service_jobs_zy_offer_insert before insert on public.service_jobs
  for each row execute function public.tg_service_jobs_zy_offer_insert();

-- The trigger functions above are internals too (and cannot be called directly anyway).
select public._work_lockdown();


-- =============================================================================
-- §5  PRESETS (exact live designations) AND THE BACKFILL
-- =============================================================================

-- One DO block, so the transaction-local neo.migrating flag and the
-- first-install decision cover every statement even if the runner autocommits.
do $$
declare
  r record;
  -- The one-time marker: this file creates staff_work empty and the backfill
  -- below gives every active staff member a row (People admin adds more), so
  -- it is empty only until the first run has finished.
  v_first boolean := not exists (select 1 from public.staff_work);
begin
  perform set_config('neo.migrating', '1', true);

  -- The presets, seeded on the first install only; the owner edits them in
  -- Neo OS afterwards. A re-run never brings back one the owner deleted or
  -- the old name of one they renamed.
  if v_first then
    insert into public.designation_presets
      (key, designation, service_role, rma_role, qc_role, build_pool, service_pool, build_level, updated_by)
    select public._designation_key(v.d), v.d, v.s, v.r, v.q, v.bp, v.sp, v.lvl, 'migration:work_queue'
      from (values
        ('Service Engineer & RMA Lead',                 'lead', 'lead', 'lead', true,  true,  'senior'),
        ('CEO, Founder',                                'lead', 'lead', 'lead', false, false, null),
        ('CTO, Founder',                                'lead', 'lead', 'lead', false, false, null),
        ('Service Department Head',                     'lead', 'lead', 'lead', false, false, null),
        ('Sales Head',                                  null,   null,   'desk', false, false, null),
        ('Sales Department Head',                       null,   null,   'desk', false, false, null),
        ('Senior System Integrator / Service Engineer', 'tech', 'tech', 'tech', true,  true,  'senior'),
        ('Service Engineer',                            'tech', 'tech', 'tech', true,  true,  'junior'),
        ('Technical Support / Service Team Lead',       'lead', 'tech', null,   false, true,  null),
        ('Help Desk Coordinator',                       'desk', 'desk', 'desk', false, false, null),
        ('Customer Success Executive',                  'desk', 'desk', null,   false, false, null),
        ('Procurement Head',                            null,   'desk', 'desk', false, false, null),
        ('Sales Executive',                             null,   null,   null,   false, false, null),
        ('Logistics Associate — Supply Chain',          null,   'desk', null,   false, false, null),
        ('Creative Associate — Marketing',              null,   null,   null,   false, false, null),
        ('Marketing Head',                              null,   null,   null,   false, false, null)
      ) as v(d, s, r, q, bp, sp, lvl)
    on conflict (key) do nothing;
  end if;

  -- Builds already assigned by name: the email of the one staff member with
  -- that first name (none for someone who has left — the name stays). Only
  -- rows never seen by this backfill (assigned_via is null): a re-run must not
  -- hand a leaver's old builds to a new hire who shares the first name.
  update public.tickets t
     set technician_email = lower(m.email)
    from (select t2.id, (public._staff_for_short_name(t2.technician)).email as email
            from public.tickets t2
           where t2.technician_email is null and t2.assigned_via is null
             and btrim(coalesce(t2.technician, '')) <> '') m
   where t.id = m.id and m.email is not null and t.technician_email is null;
  update public.tickets
     set assigned_via = 'legacy', assigned_at = coalesce(assigned_at, updated_at, created_at)
   where assigned_via is null
     and (technician_email is not null or btrim(coalesce(technician, '')) <> '');

  -- v1.9.11's waiting queue: the claim clock starts now (never reset on a re-run).
  update public.tickets
     set queued_at = now()
   where queued_at is null and status is distinct from 'completed'
     and technician_email is null and btrim(coalesce(technician, '')) = ''
     and coalesce(specs ->> '__queued', '') = 'true';

  -- Presets for active staff who have no staff_work row yet: the INSERT … ON
  -- CONFLICT DO NOTHING decides who, so a re-run changes no existing
  -- staff_work row. On a re-run, someone who already has a service / rma / qc
  -- role was set up by hand (People without the preset, a 1.10 desktop's
  -- module access, SQL): they keep the pools-false row and every role, so a
  -- re-run never changes an existing module_access row either. Someone with
  -- no matching preset keeps the pools-false row.
  for r in
    insert into public.staff_work (profile_id, updated_by)
    select p.id, 'migration:work_queue'
      from public.profiles p
     where p.active and coalesce(p.is_staff, false)
    on conflict (profile_id) do nothing
    returning profile_id
  loop
    if v_first or not exists (select 1 from public.module_access ma
                               where ma.profile_id = r.profile_id and ma.module in ('service', 'rma', 'qc')) then
      perform public._preset_apply(r.profile_id,
                                   public._designation_key((select p.designation from public.profiles p where p.id = r.profile_id)),
                                   'preset');
    end if;
  end loop;

  perform set_config('neo.migrating', '', true);
end $$;


-- =============================================================================
-- §6  REDEFINED v2 FUNCTIONS (exact v2 identity signatures; never dropped)
-- =============================================================================

-- v2's keys unchanged, plus the caller's pools and build level (false / null
-- unless the caller is active staff).
create or replace function public.my_modules()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
    'service', public.module_role('service'),
    'rma',     public.module_role('rma'),
    'qc',      public.module_role('qc'),
    'neohr',   public.module_role('neohr'),
    'tier',    public.my_tier(),
    'build_pool',   coalesce(w.build_pool, false),
    'service_pool', coalesce(w.service_pool, false),
    'build_level',  w.build_level)
    from (select 1) x
    left join lateral (select ws.*
                         from public.profiles p
                         cross join lateral public._work_settings(p.id) ws
                        where p.id = auth.uid() and p.active and coalesce(p.is_staff, false)) w on true
$$;

-- The technician picker: service-pool members with a service role of tech or
-- higher (the CEO / CTO / sales heads are no longer in it). v2's keys
-- unchanged, plus pools, level, load and capacity (defaults applied).
create or replace function public.service_tech_list()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_day_start timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'email', t.email, 'name', t.full_name, 'designation', t.designation, 'role', t.role,
             'open_count', (select count(*) from public.service_jobs sj
                             where lower(sj.assignee_email) = lower(t.email) and sj.stage <> 'closed'),
             'visits_today', (select count(*) from public.service_jobs sj
                               where lower(sj.assignee_email) = lower(t.email) and sj.stage <> 'closed'
                                 and sj.visit_start >= v_day_start and sj.visit_start < v_day_start + interval '1 day'),
             'in_queue_requested', (select count(*) from public.service_jobs sj
                                     where lower(sj.suggested_tech_email) = lower(t.email)
                                       and sj.assignee_email is null and sj.stage <> 'closed'),
             'service_pool', t.service_pool, 'build_pool', t.build_pool, 'build_level', t.build_level,
             'points', t.points, 'jobs', t.jobs, 'capacity_points', t.capacity_points, 'max_jobs', t.max_jobs)
           order by t.full_name, t.email)
      from (select p.email, p.full_name, p.designation, public._module_role_of(p.id, 'service') as role,
                   w.service_pool, w.build_pool, w.build_level, w.capacity_points, w.max_jobs, l.points, l.jobs
              from public.profiles p
              cross join lateral public._work_settings(p.id) w
              cross join lateral public._work_load(p.email) l
             where p.active and coalesce(p.is_staff, false)
               and public.role_rank(public._module_role_of(p.id, 'service')) >= 2
               and w.service_pool) t), '[]'::jsonb);
end $$;

-- v2's service_claim with the same answers and events, plus (A1 / C3): the
-- caller's service pool; the row locked first; a live offer to the caller is
-- accepted; one to someone else answers 'offered' and writes nothing; the
-- atomic UPDATE carries the offer rule too. The visit rules moved into
-- _svc_apply_visit / _svc_visit_event (identical texts and stage moves).
create or replace function public.service_claim(
  p_job_id text, p_visit_start timestamptz default null, p_visit_end timestamptz default null,
  p_reason text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_job public.service_jobs;
  v_new public.service_jobs;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_why text;
  v_info jsonb;
  v_when text;
  v_moved boolean;
  v_prev text;
begin
  if not public.has_module('service', 'tech') then
    raise exception 'NEO_DENIED: Only technicians can take tickets from the queue.';
  end if;
  v_why := public._work_why_not('service', null, v_me.id);
  if v_why is not null then
    raise exception 'NEO_GATE: %', public._work_why_text('service', v_why, true);
  end if;
  if v_reason is not null and length(v_reason) > 300 then
    raise exception 'NEO_GATE: The reason is too long — keep it under 300 characters.';
  end if;
  if p_visit_start is not null and p_visit_end is not null and p_visit_end < p_visit_start then
    raise exception 'NEO_GATE: The visit ends before it starts.';
  end if;

  perform public._work_me_lock(v_me);
  select * into v_job from public.service_jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_job.stage = 'closed' then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  -- A17: the caller already has it (a retry after a lost answer, or a
  -- double press) — that is a success, not "taken by you".
  if lower(coalesce(v_job.assignee_email, '')) = lower(v_me.email) then
    return jsonb_build_object('ok', true, 'already', true, 'job', to_jsonb(v_job));
  end if;
  if coalesce(v_job.offer_expires_at > now(), false) and lower(v_job.offered_to_email) = lower(v_me.email) then
    return public._work_accept('service', p_job_id, v_me, p_visit_start, p_visit_end);
  end if;
  if public._work_offer_blocks(v_job.offered_to_email, v_job.offer_expires_at, v_me.email) then
    return jsonb_build_object('ok', false, 'reason', 'offered', 'by', v_job.offered_to_name,
                              'by_email', v_job.offered_to_email, 'to_name', v_job.offered_to_name,
                              'expires_at', v_job.offer_expires_at);
  end if;

  v_prev := public._flag_set('neo.assign');
  update public.service_jobs
     set assignee = v_me.full_name, assignee_email = v_me.email, assigned_via = 'claim',
         assigned_at = now(), queued_at = null, assign_reason = v_reason
   where id = p_job_id and assignee_email is null and stage <> 'closed'
     and not public._work_offer_blocks(offered_to_email, offer_expires_at, v_me.email)
  returning * into v_new;
  perform public._flag_restore('neo.assign', v_prev);

  -- (Not FOUND: the PERFORM above has already reset it.)
  if v_new.id is null then
    return jsonb_build_object('ok', false, 'reason', 'taken', 'by', v_job.assignee,
                              'by_email', v_job.assignee_email, 'at', v_job.assigned_at);
  end if;

  v_info := public._svc_apply_visit(p_job_id, v_me, p_visit_start, p_visit_end);
  v_when := v_info ->> 'when';
  v_moved := coalesce((v_info ->> 'moved')::boolean, false);
  perform public._svc_ev(p_job_id, 'claim',
    'Taken by ' || v_me.full_name
      || case when v_moved then ' — visit moved from ' || public._ist((v_info ->> 'old_start')::timestamptz) || ' to ' || v_when
              else coalesce(' — visit ' || v_when, '') end
      || coalesce('. Reason: ' || v_reason, ''),
    false, null, null,
    jsonb_build_object('tech_email', v_me.email, 'via', 'claim', 'reason', v_reason,
                       'requested_for', v_info -> 'job' ->> 'suggested_tech_email', 'visit_start', p_visit_start)
      || case when v_moved then jsonb_build_object('visit_was', v_info -> 'old_start') else '{}'::jsonb end,
    'staff', v_me.email, v_me.full_name);
  perform public._svc_visit_event(p_job_id, v_info, v_me);
  perform public._work_event('service', p_job_id, 'claim', v_me.full_name || ' claimed it.',
                             v_me.email, v_me.full_name, v_me.email, v_me.full_name, '{}'::jsonb);

  return jsonb_build_object('ok', true, 'job', v_info -> 'job');
end $$;

-- v2's service_create, except that "take it myself" (assign_self) is dropped
-- for anyone outside the service pool (C3) — the ticket queues instead.
create or replace function public.service_create(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();     -- sales, desk, techs, leads may all create
  v_crid uuid;
  v_existing text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'NEO_GATE: The request is empty.';
  end if;
  if p ? 'assign_self' and not (public._work_settings(v_me.id)).service_pool then
    p := p - 'assign_self';
  end if;
  v_crid := public._juuid(p, 'client_request_id');
  if v_crid is not null then
    select id into v_existing from public.service_jobs where client_request_id = v_crid;
    if found then return public._svc_create_result(v_existing, true); end if;
  end if;
  begin
    return public._svc_create(p, v_me);
  exception when unique_violation then
    -- Two submits of the same form raced; the other one won. Hand back its ticket.
    if v_crid is not null then
      select id into v_existing from public.service_jobs where client_request_id = v_crid;
      if found then return public._svc_create_result(v_existing, true); end if;
    end if;
    raise;
  end;
end $$;


-- =============================================================================
-- §7  THE WORK QUEUE RPCs
-- =============================================================================

-- The feed: open items of the kinds the caller may read, live offers to the
-- caller, the caller's own open items, and (leads of a kind) every live offer
-- of that kind; alerts for leads (per kind).
create or replace function public.work_queue()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_db boolean := public.has_module('qc', 'desk');
  v_ds boolean := public.has_module('service', 'desk');
  v_lb boolean := public.has_module('qc', 'lead');
  v_ls boolean := public.has_module('service', 'lead');
  v_em text := lower(v_me.email);
  w record;
  l record;
  v_items jsonb;
  v_alerts jsonb;
begin
  if not (v_db or v_ds) then
    raise exception 'NEO_DENIED: The work queue is for the build and service teams.';
  end if;
  select * into w from public._work_settings(v_me.id);
  select * into l from public._work_load(v_me.email);

  with ids as (
    select 'build'::text as kind, t.id
      from public.tickets t
     where v_db and (
             (t.technician_email is null and btrim(coalesce(t.technician, '')) = ''
              and t.status is distinct from 'completed' and t.queued_at is not null)
          or (t.offer_expires_at > now() and t.status is distinct from 'completed'
              and (lower(t.offered_to_email) = v_em or v_lb))
          or (lower(t.technician_email) = v_em and t.status is distinct from 'completed'))
    union
    select 'service'::text, s.id
      from public.service_jobs s
     where v_ds and s.stage <> 'closed' and (
             s.assignee_email is null
          or (s.offer_expires_at > now() and (lower(s.offered_to_email) = v_em or v_ls))
          or lower(s.assignee_email) = v_em)
  ), items as (
    select public._work_item(ids.kind, ids.id, v_me) as j from ids
  ), sorted as (
    select j,
           case when (j ->> 'offered_to_me')::boolean then 0
                when j ->> 'claim_due' is not null then 1
                when (j ->> 'mine')::boolean then 2
                else 3 end as grp
      from items where j is not null
  )
  select coalesce(jsonb_agg(j order by grp,
                            case grp when 0 then (j -> 'offer' ->> 'expires_at')::timestamptz
                                     when 1 then (j ->> 'claim_due')::timestamptz
                                     when 2 then (j ->> 'deadline')::timestamptz
                                     else (j -> 'offer' ->> 'expires_at')::timestamptz end asc nulls last,
                            j ->> 'code'), '[]'::jsonb)
    into v_items
    from sorted;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'kind', a.kind, 'item_kind', a.item_kind, 'item_id', a.item_id, 'item_code', a.item_code,
           'title', a.title, 'body', a.body, 'person_name', a.person_name, 'created_at', a.created_at)
           order by a.created_at desc, a.id desc), '[]'::jsonb)
    into v_alerts
    from (select * from public.work_alerts a
           where a.resolved_at is null
             and ((a.item_kind = 'build' and v_lb) or (a.item_kind = 'service' and v_ls))
           order by a.created_at desc, a.id desc
           limit 50) a;

  return jsonb_build_object(
    'now', now(), 'claim_hours', 4, 'offer_minutes', 30,
    'me', jsonb_build_object(
      'email', v_me.email, 'name', v_me.full_name, 'designation', v_me.designation, 'tier', v_me.tier,
      'build_pool', w.build_pool, 'service_pool', w.service_pool, 'build_level', w.build_level,
      'capacity_points', w.capacity_points, 'max_jobs', w.max_jobs, 'points', l.points, 'jobs', l.jobs,
      'lead_builds', v_lb, 'lead_service', v_ls, 'desk_builds', v_db, 'desk_service', v_ds),
    'items', v_items,
    'alerts', v_alerts);
end $$;

-- Take an open item. Builds: one atomic UPDATE (with the offer rule in its
-- WHERE). Service: the eligibility check, then service_claim (its answer, plus
-- item). A live offer to the caller is accepted.
create or replace function public.work_claim(
  p_kind text, p_id text, p_visit_start timestamptz default null, p_visit_end timestamptz default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_kind text := public._work_kind(p_kind);
  v_em text := lower(v_me.email);
  t public.tickets;
  v_new public.tickets;
  v_why text;
  v_prev text;
  v_r jsonb;
  v_item jsonb;
begin
  if v_kind = 'service' then
    v_why := public._work_why_not('service', null, v_me.id);
    if v_why is not null then
      raise exception 'NEO_GATE: %', public._work_why_text('service', v_why, true);
    end if;
    v_r := public.service_claim(p_id, p_visit_start, p_visit_end, null);
    v_item := public._work_item('service', p_id, v_me);
    return v_r || case when v_item is not null and not (v_r ? 'item') then jsonb_build_object('item', v_item)
                       else '{}'::jsonb end;
  end if;

  perform public._work_me_lock(v_me);
  select * into t from public.tickets where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  v_why := public._work_why_not('build', public._build_tier(t.specs), v_me.id);
  if v_why is not null then
    raise exception 'NEO_GATE: %', public._work_why_text('build', v_why, true);
  end if;
  if coalesce(t.offer_expires_at > now(), false) and lower(t.offered_to_email) = v_em
     and t.status is distinct from 'completed' then
    return public._work_accept('build', p_id, v_me, null, null);
  end if;

  v_prev := public._flag_set('neo.assign');
  update public.tickets
     set technician = public._first_name(v_me.full_name), technician_email = v_em,
         assigned_via = 'claim', assigned_at = now(), assign_reason = null, queued_at = null,
         offered_to_email = null, offered_to_name = null, offer_kind = null, offer_by_email = null,
         offer_by_name = null, offer_reason = null, offered_at = null, offer_expires_at = null,
         auto_tried_at = null, declined_emails = '{}',
         updated_at = greatest(now(), coalesce(updated_at, now()) + interval '1 millisecond')
   where id = p_id and technician_email is null and btrim(coalesce(technician, '')) = ''
     and status is distinct from 'completed' and queued_at is not null
     and not public._work_offer_blocks(offered_to_email, offer_expires_at, v_em)
  returning * into v_new;
  perform public._flag_restore('neo.assign', v_prev);

  if v_new.id is null then
    -- The row is locked, so t is what is there now.
    if t.status = 'completed' then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
    if lower(coalesce(t.technician_email, '')) = v_em then
      return jsonb_build_object('ok', true, 'already', true, 'item', public._work_item('build', p_id, v_me));
    end if;
    if public._work_offer_blocks(t.offered_to_email, t.offer_expires_at, v_em) then
      return jsonb_build_object('ok', false, 'reason', 'offered', 'by', t.offered_to_name,
                                'to_name', t.offered_to_name, 'expires_at', t.offer_expires_at);
    end if;
    if t.technician_email is not null or btrim(coalesce(t.technician, '')) <> '' then
      return jsonb_build_object('ok', false, 'reason', 'taken', 'by', t.technician,
                                'by_email', t.technician_email, 'at', t.assigned_at);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'not_queued');
  end if;

  perform public._work_event('build', p_id, 'claim', v_me.full_name || ' claimed it.',
                             v_me.email, v_me.full_name, v_me.email, v_me.full_name, '{}'::jsonb);
  perform public._work_alerts_resolve('build', p_id, v_me.email);
  return jsonb_build_object('ok', true, 'item', public._work_item('build', p_id, v_me));
end $$;

-- A lead offers an item to a person (30 minutes to accept), or withdraws the
-- live offer (p_email empty). p_expected is the assignee the lead's screen
-- showed (null / '' = unassigned): anything else answers 'changed'.
create or replace function public.work_offer(
  p_kind text, p_id text, p_email text, p_reason text, p_expected text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_kind text := public._work_kind(p_kind);
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_expected text := nullif(lower(btrim(coalesce(p_expected, ''))), '');
  v_target public.profiles;
  t public.tickets;
  s public.service_jobs;
  v_cur text; v_cur_name text; v_cur_at timestamptz; v_closed boolean; v_live boolean;
  v_to text; v_to_name text; v_exp timestamptz; v_okind text; v_tier int; v_quote boolean;
  v_why text; v_txt text; v_body text; v_prev text;
begin
  if not public.has_module(case v_kind when 'build' then 'qc' else 'service' end, 'lead') then
    raise exception 'NEO_DENIED: Only a lead can offer work to a technician.';
  end if;
  if v_email is not null then
    if v_reason is null then raise exception 'NEO_GATE: Say why you''re offering it to them.'; end if;
    if length(v_reason) > 300 then
      raise exception 'NEO_GATE: The reason is too long — keep it under 300 characters.';
    end if;
    -- The person first, then the item: the same order as a deactivation.
    perform 1 from public.profiles where lower(email) = v_email for share;
  elsif v_reason is not null and length(v_reason) > 300 then
    raise exception 'NEO_GATE: The reason is too long — keep it under 300 characters.';
  end if;

  if v_kind = 'build' then
    select * into t from public.tickets where id = p_id for update;
    if not found then raise exception 'NEO_GATE: That build no longer exists.'; end if;
    v_cur := lower(t.technician_email); v_cur_name := nullif(btrim(coalesce(t.technician, '')), '');
    v_cur_at := coalesce(t.assigned_at, t.updated_at);
    v_closed := t.status = 'completed';
    v_live := coalesce(t.offer_expires_at > now(), false) and t.offered_to_email is not null;
    v_to := lower(t.offered_to_email); v_to_name := t.offered_to_name; v_exp := t.offer_expires_at; v_okind := t.offer_kind;
    v_tier := public._build_tier(t.specs);
    v_quote := v_cur is null and v_cur_name is null and t.queued_at is null;
  else
    select * into s from public.service_jobs where id = p_id for update;
    if not found then raise exception 'NEO_GATE: That ticket no longer exists.'; end if;
    v_cur := lower(s.assignee_email); v_cur_name := s.assignee;
    v_cur_at := coalesce(s.assigned_at, s.updated_at);
    v_closed := s.stage = 'closed';
    v_live := coalesce(s.offer_expires_at > now(), false) and s.offered_to_email is not null;
    v_to := lower(s.offered_to_email); v_to_name := s.offered_to_name; v_exp := s.offer_expires_at; v_okind := s.offer_kind;
    v_tier := null;
    v_quote := false;
  end if;

  -- Withdraw. The app's own offer: that person is skipped for this item (in
  -- declined_emails, without an alert), so the next pick moves on; a lead's
  -- offer just ends. Either way work_tick waits at least 10 minutes before the
  -- app offers the item again (auto_tried_at), so it cannot re-offer at once
  -- or win the race against this lead's next "offer to someone else".
  if v_email is null then
    if not v_live then
      return jsonb_build_object('ok', true, 'withdrawn', false, 'item', public._work_item(v_kind, p_id, v_me));
    end if;
    perform public._work_offer_clear(v_kind, p_id, case when v_okind = 'auto' then v_to end);
    v_prev := public._flag_set('neo.assign');
    if v_kind = 'build' then
      update public.tickets set auto_tried_at = now(),
             updated_at = greatest(now(), coalesce(updated_at, now()) + interval '1 millisecond')
       where id = p_id;
    else
      update public.service_jobs set auto_tried_at = now() where id = p_id;
    end if;
    perform public._flag_restore('neo.assign', v_prev);
    v_body := 'Offer to ' || coalesce(v_to_name, v_to) || ' withdrawn by ' || v_me.full_name || coalesce(': ' || v_reason, '');
    perform public._work_event(v_kind, p_id, 'offer_withdrawn', v_body, v_me.email, v_me.full_name, v_to, v_to_name,
                               jsonb_build_object('reason', v_reason, 'offer_kind', v_okind,
                                                  'skipped', coalesce(v_okind = 'auto', false)));
    if v_kind = 'service' then
      perform public._svc_ev(p_id, 'offer', v_body, false, null, null,
        jsonb_build_object('offer_kind', v_okind, 'to_email', v_to, 'by_email', lower(v_me.email),
                           'reason', v_reason, 'event', 'offer_withdrawn'),
        'staff', v_me.email, v_me.full_name);
    end if;
    return jsonb_build_object('ok', true, 'withdrawn', true, 'item', public._work_item(v_kind, p_id, v_me));
  end if;

  if v_closed then raise exception 'NEO_GATE: This one is finished.'; end if;
  -- Compare-and-set on who has it (A16 semantics).
  if v_cur is distinct from v_expected then
    return jsonb_build_object('ok', false, 'reason', 'changed', 'by', v_cur_name, 'by_email', v_cur, 'at', v_cur_at);
  end if;
  v_target := public._staff_by_email(v_email);
  if v_target.id is null then raise exception 'NEO_GATE: No active staff account with that email.'; end if;
  if v_cur = lower(v_target.email) then
    return jsonb_build_object('ok', true, 'unchanged', true, 'item', public._work_item(v_kind, p_id, v_me));
  end if;
  if v_live and v_to is distinct from lower(v_target.email) then
    return jsonb_build_object('ok', false, 'reason', 'offered', 'to_name', v_to_name, 'expires_at', v_exp);
  end if;
  v_why := public._work_why_not(v_kind, v_tier, v_target.id);
  if v_why is not null then
    v_txt := public._work_why_text(v_kind, v_why, false);
    raise exception 'NEO_GATE: % can''t take this — %', coalesce(v_target.full_name, v_target.email),
      lower(left(v_txt, 1)) || substr(v_txt, 2);
  end if;

  if v_quote then
    -- A build that was not sent to the floor goes into the queue with the offer.
    v_prev := public._flag_set('neo.assign');
    update public.tickets set queued_at = now(),
           updated_at = greatest(now(), coalesce(updated_at, now()) + interval '1 millisecond')
     where id = p_id;
    perform public._flag_restore('neo.assign', v_prev);
    perform public._work_event('build', p_id, 'queued', 'Sent to the build queue by ' || v_me.full_name || ' with an offer.',
                               v_me.email, v_me.full_name, null, null, '{}'::jsonb);
  end if;

  perform public._work_offer_set(v_kind, p_id, v_target, 'manager', v_me.email, v_me.full_name, v_reason);
  v_body := 'Offered to ' || v_target.full_name || ' by ' || v_me.full_name || ': ' || v_reason;
  perform public._work_event(v_kind, p_id, 'offer', v_body, v_me.email, v_me.full_name, v_target.email, v_target.full_name,
                             jsonb_build_object('reason', v_reason, 'expires_at', now() + interval '30 minutes',
                                                'reassign', v_cur is not null or v_cur_name is not null));
  if v_kind = 'service' then
    perform public._svc_ev(p_id, 'offer', v_body, false, null, null,
      jsonb_build_object('offer_kind', 'manager', 'to_email', lower(v_target.email), 'by_email', lower(v_me.email),
                         'reason', v_reason, 'event', 'offer'),
      'staff', v_me.email, v_me.full_name);
  end if;
  return jsonb_build_object('ok', true, 'item', public._work_item(v_kind, p_id, v_me));
end $$;

-- The offered person accepts or declines (a reason is required to decline).
create or replace function public.work_respond(
  p_kind text, p_id text, p_accept boolean, p_reason text default null,
  p_visit_start timestamptz default null, p_visit_end timestamptz default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_kind text := public._work_kind(p_kind);
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_em text := lower(v_me.email);
  t public.tickets;
  s public.service_jobs;
  v_live boolean; v_declined text[]; v_code text; v_title text; v_okind text; v_by text;
  v_unassigned boolean; v_due timestamptz; v_next jsonb; v_body text;
begin
  if p_accept is null then raise exception 'NEO_GATE: Say whether you take it or not.'; end if;
  if not p_accept then
    if v_reason is null then raise exception 'NEO_GATE: Say why you can''t take it.'; end if;
    if length(v_reason) > 300 then
      raise exception 'NEO_GATE: The reason is too long — keep it under 300 characters.';
    end if;
  end if;
  perform public._work_me_lock(v_me);
  if p_accept then
    return public._work_accept(v_kind, p_id, v_me, p_visit_start, p_visit_end);
  end if;

  if v_kind = 'build' then
    select * into t from public.tickets where id = p_id for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    v_live := coalesce(t.offer_expires_at > now(), false) and lower(t.offered_to_email) = v_em
              and t.status is distinct from 'completed';
    v_declined := t.declined_emails; v_code := upper(right(t.id, 6)); v_title := t.customer_name;
    v_okind := t.offer_kind; v_by := t.offer_by_email;
    v_unassigned := t.technician_email is null and btrim(coalesce(t.technician, '')) = '';
    v_due := case when t.queued_at is not null then t.queued_at + interval '4 hours' end;
  else
    select * into s from public.service_jobs where id = p_id for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    v_live := coalesce(s.offer_expires_at > now(), false) and lower(s.offered_to_email) = v_em and s.stage <> 'closed';
    v_declined := s.declined_emails; v_code := s.public_code;
    v_title := coalesce(nullif(btrim(coalesce(s.device_label, '')), ''), public._svc_category_label(s.category));
    v_okind := s.offer_kind; v_by := s.offer_by_email;
    v_unassigned := s.assignee_email is null;
    v_due := case when v_unassigned then coalesce(s.queued_at, s.created_at) + interval '4 hours' end;
  end if;
  if not v_live then
    return jsonb_build_object('ok', false,
      'reason', case when coalesce(v_em = any (coalesce(v_declined, '{}'::text[])), false) then 'expired' else 'not_offered' end);
  end if;

  perform public._work_offer_clear(v_kind, p_id, v_em);
  v_body := v_me.full_name || ' declined: ' || v_reason;
  perform public._work_event(v_kind, p_id, 'decline', v_body, v_me.email, v_me.full_name, v_me.email, v_me.full_name,
                             jsonb_build_object('reason', v_reason, 'offer_kind', v_okind, 'by_email', v_by));
  if v_kind = 'service' then
    perform public._svc_ev(p_id, 'offer', v_body, false, null, null,
      jsonb_build_object('offer_kind', v_okind, 'to_email', v_em, 'by_email', v_by, 'reason', v_reason, 'event', 'decline'),
      'staff', v_me.email, v_me.full_name);
  end if;
  perform public._work_alert('declined', v_kind, p_id, v_code, v_title,
                             v_me.full_name || ' declined ' || v_code || ': ' || v_reason, v_me.email, v_me.full_name);
  if v_unassigned and v_due is not null and now() >= v_due then
    v_next := public._work_auto_offer(v_kind, p_id);
  end if;
  return jsonb_build_object('ok', true, 'declined', true, 'next', v_next,
                            'item', public._work_item(v_kind, p_id, v_me));
end $$;

-- Hand an item back to the queue (reason required). Service: service_release
-- with all its rules, then the releaser is skipped for this cycle.
create or replace function public.work_release(p_kind text, p_id text, p_reason text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_kind text := public._work_kind(p_kind);
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  t public.tickets;
  s public.service_jobs;
  v_was text;
  v_was_name text;
  v_r jsonb;
  v_prev text;
begin
  if v_kind = 'service' then
    select * into s from public.service_jobs where id = p_id for update;
    if not found then raise exception 'NEO_GATE: That ticket no longer exists.'; end if;
    v_was := lower(s.assignee_email); v_was_name := s.assignee;
    v_r := public.service_release(p_id, p_reason);
    if v_was is not null then
      v_prev := public._flag_set('neo.rpc');
      update public.service_jobs set declined_emails = array[v_was] where id = p_id;
      perform public._flag_restore('neo.rpc', v_prev);
    end if;
    perform public._work_event('service', p_id, 'release',
      'Handed back by ' || v_me.full_name
        || case when v_was is distinct from lower(v_me.email) then ' (was ' || coalesce(v_was_name, v_was) || ')' else '' end
        || ': ' || v_reason,
      v_me.email, v_me.full_name, v_was, v_was_name, jsonb_build_object('reason', v_reason, 'from_email', v_was));
    return v_r || jsonb_build_object('item', public._work_item('service', p_id, v_me));
  end if;

  if v_reason is null then raise exception 'NEO_GATE: Say why you''re handing it back.'; end if;
  if length(v_reason) > 300 then
    raise exception 'NEO_GATE: The reason is too long — keep it under 300 characters.';
  end if;
  select * into t from public.tickets where id = p_id for update;
  if not found then raise exception 'NEO_GATE: That build no longer exists.'; end if;
  if t.status = 'completed' then raise exception 'NEO_GATE: This build is finished.'; end if;
  if t.technician_email is null and btrim(coalesce(t.technician, '')) = '' then
    raise exception 'NEO_STALE: Nobody has this build now — refresh.';
  end if;
  -- A name-only (legacy) build has no email to match: only a lead hands it back.
  if not (lower(coalesce(t.technician_email, '')) = lower(v_me.email) or public.has_module('qc', 'lead')) then
    raise exception 'NEO_DENIED: Only the technician who has this build, or a lead, can hand it back.';
  end if;
  perform public._work_release_build(p_id, v_me, v_reason);
  return jsonb_build_object('ok', true, 'item', public._work_item('build', p_id, v_me));
end $$;

-- A quote goes to the floor: its 4-hour claim clock starts.
create or replace function public.build_queue_send(p_ticket_id text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  t public.tickets;
  v_prev text;
begin
  if not public.has_module('qc', 'desk') then
    raise exception 'NEO_DENIED: Only the builds team can send a build to the floor.';
  end if;
  select * into t from public.tickets where id = p_ticket_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if t.status = 'completed' then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  if t.technician_email is not null or btrim(coalesce(t.technician, '')) <> '' then
    return jsonb_build_object('ok', false, 'reason', 'assigned');
  end if;
  if t.queued_at is not null then
    return jsonb_build_object('ok', true, 'already', true, 'item', public._work_item('build', p_ticket_id, v_me));
  end if;
  v_prev := public._flag_set('neo.assign');
  update public.tickets
     set queued_at = now(), updated_at = greatest(now(), coalesce(updated_at, now()) + interval '1 millisecond')
   where id = p_ticket_id;
  perform public._flag_restore('neo.assign', v_prev);
  perform public._work_event('build', p_ticket_id, 'queued', 'Sent to the build queue by ' || v_me.full_name || '.',
                             v_me.email, v_me.full_name, null, null, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'item', public._work_item('build', p_ticket_id, v_me));
end $$;

-- Leads: who holds what. Items and offers only of the kinds the caller leads;
-- last_seen_at / logs_today only for tier 3+.
create or replace function public.work_team()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_lb boolean := public.has_module('qc', 'lead');
  v_ls boolean := public.has_module('service', 'lead');
  v_hr boolean := public.my_tier() >= 3;
  v_lo timestamptz := ((now() at time zone 'Asia/Kolkata')::date)::timestamp at time zone 'Asia/Kolkata';
  v_hi timestamptz := ((now() at time zone 'Asia/Kolkata')::date + 1)::timestamp at time zone 'Asia/Kolkata';
  v_people jsonb;
  v_alerts jsonb;
begin
  if not (v_hr or v_lb or v_ls) then
    raise exception 'NEO_DENIED: Only leads can see the team.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'email', x.email, 'name', x.full_name, 'designation', x.designation, 'tier', x.tier,
           'build_pool', x.build_pool, 'service_pool', x.service_pool, 'build_level', x.build_level,
           'capacity_points', x.capacity_points, 'max_jobs', x.max_jobs, 'points', x.points, 'jobs', x.jobs,
           'qc_role', public._module_role_of(x.id, 'qc'), 'service_role', public._module_role_of(x.id, 'service'),
           'items', coalesce((
             select jsonb_agg(i.j order by i.at nulls last) from (
               select jsonb_build_object('kind', 'build', 'id', t.id, 'code', upper(right(t.id, 6)), 'title', t.customer_name,
                                         'stage', t.status, 'deadline', t.deadline, 'assigned_at', t.assigned_at,
                                         'cost', public._work_cost_build(t.specs)) as j, t.assigned_at as at
                 from public.tickets t
                where v_lb and lower(t.technician_email) = lower(x.email) and t.status is distinct from 'completed'
               union all
               select jsonb_build_object('kind', 'service', 'id', s.id, 'code', s.public_code,
                                         'title', coalesce(nullif(btrim(coalesce(s.device_label, '')), ''), public._svc_category_label(s.category)),
                                         'stage', s.stage, 'deadline', coalesce(s.visit_start, s.needed_by),
                                         'assigned_at', s.assigned_at, 'cost', public._work_cost_service(s.service_type)), s.assigned_at
                 from public.service_jobs s
                where v_ls and lower(s.assignee_email) = lower(x.email) and s.stage <> 'closed') i), '[]'::jsonb),
           'offers', coalesce((
             select jsonb_agg(o.j order by o.at) from (
               select jsonb_build_object('kind', 'build', 'id', t.id, 'code', upper(right(t.id, 6)), 'title', t.customer_name,
                                         'expires_at', t.offer_expires_at, 'offer_kind', t.offer_kind) as j, t.offer_expires_at as at
                 from public.tickets t
                where v_lb and t.offer_expires_at > now() and lower(t.offered_to_email) = lower(x.email)
                  and t.status is distinct from 'completed'
               union all
               select jsonb_build_object('kind', 'service', 'id', s.id, 'code', s.public_code,
                                         'title', coalesce(nullif(btrim(coalesce(s.device_label, '')), ''), public._svc_category_label(s.category)),
                                         'expires_at', s.offer_expires_at, 'offer_kind', s.offer_kind), s.offer_expires_at
                 from public.service_jobs s
                where v_ls and s.offer_expires_at > now() and lower(s.offered_to_email) = lower(x.email)
                  and s.stage <> 'closed') o), '[]'::jsonb),
           'last_seen_at', case when v_hr then greatest(
               (select max(fa.at) from public.field_activity fa where lower(fa.employee_email) = lower(x.email)),
               (select max(wl.created_at) from public.work_logs wl where lower(wl.employee_email) = lower(x.email))) end,
           'logs_today', case when v_hr then (
               select count(*) from public.work_logs wl
                where lower(wl.employee_email) = lower(x.email) and wl.deleted_at is null
                  and wl.created_at >= v_lo and wl.created_at < v_hi) end)
           order by x.full_name, x.email), '[]'::jsonb)
    into v_people
    from (select p.id, p.email, p.full_name, p.designation, p.tier,
                 w.build_pool, w.service_pool, w.build_level, w.capacity_points, w.max_jobs, l.points, l.jobs
            from public.profiles p
            cross join lateral public._work_settings(p.id) w
            cross join lateral public._work_load(p.email) l
           where p.active and coalesce(p.is_staff, false)
             and (w.build_pool or w.service_pool or l.jobs > 0)) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'kind', a.kind, 'item_kind', a.item_kind, 'item_id', a.item_id, 'item_code', a.item_code,
           'title', a.title, 'body', a.body, 'person_name', a.person_name, 'created_at', a.created_at)
           order by a.created_at desc, a.id desc), '[]'::jsonb)
    into v_alerts
    from (select * from public.work_alerts a
           where a.resolved_at is null
             and ((a.item_kind = 'build' and v_lb) or (a.item_kind = 'service' and v_ls))
           order by a.created_at desc, a.id desc
           limit 50) a;

  return jsonb_build_object('now', now(), 'people', v_people, 'alerts', v_alerts);
end $$;

-- An item's queue history, newest first (at most 100).
create or replace function public.work_events_for(p_kind text, p_id text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_kind text := public._work_kind(p_kind);
begin
  if not public.has_module(case v_kind when 'build' then 'qc' else 'service' end, 'desk') then
    raise exception 'NEO_DENIED: You don''t have access to this queue history.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', e.id, 'kind', e.kind, 'actor_email', e.actor_email, 'actor_name', e.actor_name,
             'target_email', e.target_email, 'target_name', e.target_name, 'body', e.body, 'meta', e.meta, 'at', e.at)
           order by e.at desc, e.id desc)
      from (select * from public.work_events e
             where e.item_kind = v_kind and e.item_id = p_id
             order by e.at desc, e.id desc
             limit 100) e), '[]'::jsonb);
end $$;

-- The clock. Called by every desktop each minute, by phones on refresh and by
-- pg_cron (no JWT). One runs at a time; the others answer skipped.
--   1. live offers past their 30 minutes end (a decline with "No answer in
--      30 minutes"), and an overdue item is offered to the next person;
--   2. open items past their 4 hours with no offer are offered (a stuck one is
--      retried at most every 10 minutes).
-- Each step takes at most 50 rows per table, tickets first, FOR UPDATE SKIP LOCKED.
create or replace function public.work_tick()
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  r record;
  v jsonb;
  v_expired int := 0;
  v_offered int := 0;
  v_stuck int := 0;
begin
  if auth.uid() is not null then perform public._neo_me(); end if;
  if not pg_try_advisory_xact_lock(hashtext('neo_work_tick')) then
    return jsonb_build_object('ok', true, 'skipped', true);
  end if;

  for r in
    select t.id from public.tickets t
     where t.offer_expires_at is not null and t.offer_expires_at <= now()
     order by t.offer_expires_at, t.id
     limit 50
       for update skip locked
  loop
    v := public._work_expire('build', r.id);
    if v is not null then
      v_expired := v_expired + 1;
      if coalesce((v -> 'next' ->> 'offered')::boolean, false) then v_offered := v_offered + 1;
      elsif coalesce((v -> 'next' ->> 'stuck')::boolean, false) then v_stuck := v_stuck + 1; end if;
    end if;
  end loop;
  for r in
    select s.id from public.service_jobs s
     where s.offer_expires_at is not null and s.offer_expires_at <= now()
     order by s.offer_expires_at, s.id
     limit 50
       for update skip locked
  loop
    v := public._work_expire('service', r.id);
    if v is not null then
      v_expired := v_expired + 1;
      if coalesce((v -> 'next' ->> 'offered')::boolean, false) then v_offered := v_offered + 1;
      elsif coalesce((v -> 'next' ->> 'stuck')::boolean, false) then v_stuck := v_stuck + 1; end if;
    end if;
  end loop;

  for r in
    select t.id from public.tickets t
     where t.technician_email is null and btrim(coalesce(t.technician, '')) = ''
       and t.status is distinct from 'completed'
       and t.queued_at is not null and t.queued_at + interval '4 hours' <= now()
       and t.offer_expires_at is null
       and (t.auto_tried_at is null or t.auto_tried_at <= now() - interval '10 minutes')
     order by t.queued_at, t.id
     limit 50
       for update skip locked
  loop
    v := public._work_auto_offer('build', r.id);
    if coalesce((v ->> 'offered')::boolean, false) then v_offered := v_offered + 1;
    elsif coalesce((v ->> 'stuck')::boolean, false) then v_stuck := v_stuck + 1; end if;
  end loop;
  for r in
    select s.id from public.service_jobs s
     where s.assignee_email is null and s.stage <> 'closed'
       and coalesce(s.queued_at, s.created_at) + interval '4 hours' <= now()
       and s.offer_expires_at is null
       and (s.auto_tried_at is null or s.auto_tried_at <= now() - interval '10 minutes')
     order by coalesce(s.queued_at, s.created_at), s.id
     limit 50
       for update skip locked
  loop
    v := public._work_auto_offer('service', r.id);
    if coalesce((v ->> 'offered')::boolean, false) then v_offered := v_offered + 1;
    elsif coalesce((v ->> 'stuck')::boolean, false) then v_stuck := v_stuck + 1; end if;
  end loop;

  return jsonb_build_object('ok', true, 'expired', v_expired, 'offered', v_offered, 'stuck', v_stuck);
end $$;

-- A lead dismisses an alert of a kind they lead.
create or replace function public.work_alert_resolve(p_id bigint)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  a public.work_alerts;
begin
  select * into a from public.work_alerts where id = p_id for update;
  if not found then raise exception 'NEO_GATE: That alert no longer exists.'; end if;
  if not (public.my_tier() >= 3
          or (a.item_kind = 'build' and public.has_module('qc', 'lead'))
          or (a.item_kind = 'service' and public.has_module('service', 'lead'))) then
    raise exception 'NEO_DENIED: Only a lead can dismiss this alert.';
  end if;
  if a.resolved_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  update public.work_alerts set resolved_at = now(), resolved_by = lower(v_me.email) where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Who I am for the queue (desktop and phone, once after sign-in).
create or replace function public.my_work_profile()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  w record;
  v_db boolean := public.has_module('qc', 'desk');
  v_ds boolean := public.has_module('service', 'desk');
begin
  select * into w from public._work_settings(v_me.id);
  return jsonb_build_object(
    'id', v_me.id, 'email', v_me.email, 'full_name', v_me.full_name, 'designation', v_me.designation,
    'department', v_me.department, 'tier', v_me.tier, 'modules', public.my_modules(),
    'build_pool', w.build_pool, 'service_pool', w.service_pool, 'build_level', w.build_level,
    'capacity_points', w.capacity_points, 'max_jobs', w.max_jobs,
    'team_view', public.my_tier() >= 3,
    'lead_builds', public.has_module('qc', 'lead'), 'lead_service', public.has_module('service', 'lead'),
    'desk_builds', v_db, 'desk_service', v_ds,
    -- 'work' exactly when work_queue() would answer (a pool flag alone never does).
    'home', case when v_db or v_ds then 'work' else 'logs' end);
end $$;


-- =============================================================================
-- §8  PEOPLE ADMIN (tier 4+)
--      Tier 5 may change anyone. Tier 4 only people whose CURRENT tier is <= 3
--      (new not-staff sign-ups included). On their own account anyone may
--      change only name, designation, department, pools, level, capacity and
--      apply a preset — never their tier, active, staff or roles.
-- =============================================================================

create or replace function public.staff_list()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare v_me public.profiles := public._neo_me();
begin
  if v_me.tier < 4 then raise exception 'NEO_DENIED: Only tier 4 and above can manage people.'; end if;
  return coalesce((
    select jsonb_agg(public._work_staff_entry(p.id)
                     order by coalesce(p.is_staff, false), not p.active, p.full_name, p.email)
      from public.profiles p), '[]'::jsonb);
end $$;

create or replace function public.staff_update(p_email text, p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_t public.profiles;
  v_self boolean;
  k text;
  m text;
  v_allowed constant text[] := array['full_name', 'designation', 'department', 'active', 'is_staff', 'tier',
                                     'build_pool', 'service_pool', 'build_level', 'capacity_points', 'max_jobs',
                                     'roles', 'apply_preset'];
  v_name text; v_desig text; v_dept text; v_active boolean; v_staff boolean; v_tier int;
  v_bpool boolean; v_spool boolean; v_level text; v_cap int; v_max int; v_roles jsonb; v_apply boolean;
  v_role text; v_cur_role text; v_was_on boolean; v_now_on boolean; v_applied boolean;
  v_work boolean;
begin
  if v_me.tier < 4 then raise exception 'NEO_DENIED: Only tier 4 and above can manage people.'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEO_GATE: The request is empty.'; end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any (v_allowed)) then
      raise exception 'NEO_GATE: "%" is not something you can change here.', k;
    end if;
  end loop;

  perform pg_advisory_xact_lock(hashtext('neo_staff_admin'));
  select * into v_t from public.profiles where lower(email) = lower(btrim(coalesce(p_email, ''))) for update;
  if not found then raise exception 'NEO_GATE: No account with that email.'; end if;
  v_self := v_t.id = v_me.id;
  if not v_self and v_me.tier < 5 and v_t.tier >= 4 then
    raise exception 'NEO_DENIED: Only the owner can change a tier 4 or 5 account.';
  end if;

  -- Read and check everything before the first write.
  if p ? 'full_name' then
    v_name := public._jtxt(p, 'full_name', 120, 'The name');
    if v_name is null then raise exception 'NEO_GATE: Enter their full name.'; end if;
  end if;
  if p ? 'designation' then v_desig := public._jtxt(p, 'designation', 120, 'The designation'); end if;
  if p ? 'department' then v_dept := public._jtxt(p, 'department', 60, 'The department'); end if;
  if p ? 'active' then
    v_active := public._jbool(p, 'active', 'Active');
    if v_active is null then raise exception 'NEO_GATE: Active must be yes or no.'; end if;
  end if;
  if p ? 'is_staff' then
    v_staff := public._jbool(p, 'is_staff', 'Staff');
    if v_staff is null then raise exception 'NEO_GATE: Staff must be yes or no.'; end if;
  end if;
  if p ? 'tier' then
    v_tier := public._jint(p, 'tier', 'The tier', 1, 5);
    if v_tier is null then raise exception 'NEO_GATE: Pick a tier from 1 to 5.'; end if;
  end if;
  if p ? 'build_pool' then
    v_bpool := public._jbool(p, 'build_pool', 'The build pool');
    if v_bpool is null then raise exception 'NEO_GATE: The build pool must be yes or no.'; end if;
  end if;
  if p ? 'service_pool' then
    v_spool := public._jbool(p, 'service_pool', 'The service pool');
    if v_spool is null then raise exception 'NEO_GATE: The service pool must be yes or no.'; end if;
  end if;
  if p ? 'build_level' then
    v_level := lower(public._jtxt(p, 'build_level', 10, 'The build level'));
    if v_level is not null and v_level not in ('junior', 'senior') then
      raise exception 'NEO_GATE: The build level is junior, senior or none.';
    end if;
  end if;
  if p ? 'capacity_points' then
    v_cap := public._jint(p, 'capacity_points', 'The capacity', 1, 50);
    if v_cap is null then raise exception 'NEO_GATE: Give a capacity from 1 to 50 points.'; end if;
  end if;
  if p ? 'max_jobs' then
    v_max := public._jint(p, 'max_jobs', 'The job limit', 1, 20);
    if v_max is null then raise exception 'NEO_GATE: Give a job limit from 1 to 20.'; end if;
  end if;
  if p ? 'roles' then
    v_roles := p -> 'roles';
    if jsonb_typeof(v_roles) <> 'object' then
      raise exception 'NEO_GATE: Roles must be given per module (service, rma, qc).';
    end if;
    for k in select jsonb_object_keys(v_roles) loop
      if k not in ('service', 'rma', 'qc') then
        raise exception 'NEO_GATE: "%" is not a module you can set here.', k;
      end if;
      if jsonb_typeof(v_roles -> k) not in ('null', 'string')
         or coalesce(nullif(lower(btrim(v_roles ->> k)), ''), 'desk') not in ('desk', 'tech', 'lead') then
        raise exception 'NEO_GATE: A role is desk, tech, lead or none.';
      end if;
    end loop;
  end if;
  if p ? 'apply_preset' then v_apply := coalesce(public._jbool(p, 'apply_preset', 'Apply the preset'), false); end if;

  -- Your own account: no tier, no switching yourself off, no roles.
  if v_self then
    if p ? 'tier' and v_tier is distinct from v_t.tier then
      raise exception 'NEO_DENIED: You can''t change your own tier.';
    end if;
    if (p ? 'active' and v_active is distinct from v_t.active)
       or (p ? 'is_staff' and v_staff is distinct from coalesce(v_t.is_staff, false)) then
      raise exception 'NEO_DENIED: You can''t switch off your own account.';
    end if;
    if p ? 'roles' then
      for k in select jsonb_object_keys(v_roles) loop
        select ma.role into v_cur_role from public.module_access ma where ma.profile_id = v_t.id and ma.module = k;
        if nullif(lower(btrim(coalesce(v_roles ->> k, ''))), '') is distinct from v_cur_role then
          raise exception 'NEO_DENIED: You can''t change your own roles.';
        end if;
      end loop;
    end if;
  end if;
  if p ? 'tier' and v_tier is distinct from v_t.tier then
    if v_me.tier < 5 then raise exception 'NEO_DENIED: Only the owner can change tiers.'; end if;
    if v_tier > v_me.tier then raise exception 'NEO_DENIED: You can''t give a tier above your own.'; end if;
  end if;

  v_was_on := v_t.active and coalesce(v_t.is_staff, false);

  -- 1. The profile (a definer write: clients have no UPDATE on these columns).
  update public.profiles
     set full_name   = case when p ? 'full_name' then v_name else full_name end,
         designation = case when p ? 'designation' then v_desig else designation end,
         department  = case when p ? 'department' then v_dept else department end,
         active      = case when p ? 'active' then v_active else active end,
         is_staff    = case when p ? 'is_staff' then v_staff else is_staff end,
         tier        = case when p ? 'tier' then v_tier else tier end,
         updated_at  = now()
   where id = v_t.id
  returning * into v_t;
  v_now_on := v_t.active and coalesce(v_t.is_staff, false);

  -- 2. The preset of the (new) designation.
  if coalesce(v_apply, false) then
    v_applied := public._preset_apply(v_t.id, public._designation_key(v_t.designation), lower(v_me.email));
  end if;

  -- 3. Keys given in this call win over the preset.
  v_work := p ? 'build_pool' or p ? 'service_pool' or p ? 'build_level' or p ? 'capacity_points' or p ? 'max_jobs';
  if v_work then
    insert into public.staff_work as sw (profile_id, build_pool, service_pool, build_level, capacity_points, max_jobs,
                                         updated_by, updated_at)
    values (v_t.id, coalesce(v_bpool, false), coalesce(v_spool, false), v_level,
            coalesce(v_cap, (public._work_defaults(v_level)).capacity),
            coalesce(v_max, (public._work_defaults(v_level)).max_jobs),
            lower(v_me.email), now())
    on conflict (profile_id) do update
       set build_pool      = case when p ? 'build_pool' then excluded.build_pool else sw.build_pool end,
           service_pool    = case when p ? 'service_pool' then excluded.service_pool else sw.service_pool end,
           build_level     = case when p ? 'build_level' then excluded.build_level else sw.build_level end,
           capacity_points = case when p ? 'capacity_points' then excluded.capacity_points else sw.capacity_points end,
           max_jobs        = case when p ? 'max_jobs' then excluded.max_jobs else sw.max_jobs end,
           updated_by      = excluded.updated_by,
           updated_at      = now();
  end if;
  if p ? 'roles' then
    foreach m in array array['service', 'rma', 'qc'] loop
      continue when not (v_roles ? m);
      v_role := nullif(lower(btrim(coalesce(v_roles ->> m, ''))), '');
      if v_role is null then
        delete from public.module_access where profile_id = v_t.id and module = m;
      else
        insert into public.module_access (profile_id, module, role, granted_by, granted_at)
        values (v_t.id, m, v_role, lower(v_me.email), now())
        on conflict (profile_id, module) do update
           set role = excluded.role, granted_by = excluded.granted_by, granted_at = now();
      end if;
    end loop;
  end if;
  -- Everyone People has touched keeps a staff_work row (the column defaults
  -- read exactly like "no row"), so a re-run of this file never applies a
  -- preset over what was set here by hand.
  insert into public.staff_work (profile_id, updated_by) values (v_t.id, lower(v_me.email))
  on conflict (profile_id) do nothing;

  -- 4. Switched off: what they held goes back to the queue, offers to them end.
  if v_was_on and not v_now_on then
    perform public._work_person_gone(v_t, v_me);
  end if;

  -- 5. Someone must still be able to manage tiers.
  if not exists (select 1 from public.profiles where tier = 5 and active and coalesce(is_staff, false)) then
    raise exception 'NEO_GATE: Neo OS needs at least one active tier-5 account.';
  end if;

  return public._work_staff_entry(v_t.id) || jsonb_build_object('preset_applied', v_applied);
end $$;

create or replace function public.staff_apply_preset(p_email text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_t public.profiles;
  v_key text;
  v_applied boolean;
begin
  if v_me.tier < 4 then raise exception 'NEO_DENIED: Only tier 4 and above can manage people.'; end if;
  perform pg_advisory_xact_lock(hashtext('neo_staff_admin'));
  select * into v_t from public.profiles where lower(email) = lower(btrim(coalesce(p_email, ''))) for update;
  if not found then raise exception 'NEO_GATE: No account with that email.'; end if;
  if v_t.id <> v_me.id and v_me.tier < 5 and v_t.tier >= 4 then
    raise exception 'NEO_DENIED: Only the owner can change a tier 4 or 5 account.';
  end if;
  v_key := public._designation_key(v_t.designation);
  v_applied := public._preset_apply(v_t.id, v_key, lower(v_me.email));
  -- No matching preset: still mark them as handled by People (see staff_update).
  insert into public.staff_work (profile_id, updated_by) values (v_t.id, lower(v_me.email))
  on conflict (profile_id) do nothing;
  return jsonb_build_object('ok', true, 'applied', v_applied, 'preset_key', case when v_applied then v_key end,
                            'person', public._work_staff_entry(v_t.id));
end $$;

create or replace function public.preset_list()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare v_me public.profiles := public._neo_me();
begin
  if not (v_me.tier >= 4 or public.has_module('service', 'lead') or public.has_module('rma', 'lead')
          or public.has_module('qc', 'lead') or public.has_module('neohr', 'lead')) then
    raise exception 'NEO_DENIED: Only leads can see the designation presets.';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(dp) || jsonb_build_object(
             'people', (select count(*) from public.profiles p
                         where p.active and coalesce(p.is_staff, false)
                           and public._designation_key(p.designation) = dp.key))
           order by dp.designation)
      from public.designation_presets dp), '[]'::jsonb);
end $$;

-- Add or change a preset; it is identified by its designation. Passing the
-- old "key" with a new designation renames it (the old row goes).
create or replace function public.preset_upsert(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_desig text; v_key text; v_old text; k text;
  v_s text; v_r text; v_q text; v_bp boolean; v_sp boolean; v_lvl text; v_cap int; v_max int; v_note text;
  v_row public.designation_presets;
  v_allowed constant text[] := array['key', 'designation', 'service_role', 'rma_role', 'qc_role', 'build_pool',
                                     'service_pool', 'build_level', 'capacity_points', 'max_jobs', 'note',
                                     'people', 'updated_by', 'updated_at'];
begin
  if v_me.tier < 4 then raise exception 'NEO_DENIED: Only tier 4 and above can manage people.'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEO_GATE: The request is empty.'; end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any (v_allowed)) then
      raise exception 'NEO_GATE: "%" is not part of a preset.', k;
    end if;
  end loop;
  v_desig := regexp_replace(coalesce(public._jtxt(p, 'designation', 120, 'The designation'), ''), '\s+', ' ', 'g');
  if v_desig = '' then raise exception 'NEO_GATE: Enter the designation.'; end if;
  v_key := public._designation_key(v_desig);
  v_s := lower(public._jtxt(p, 'service_role', 10, 'The service role'));
  v_r := lower(public._jtxt(p, 'rma_role', 10, 'The RMA role'));
  v_q := lower(public._jtxt(p, 'qc_role', 10, 'The builds role'));
  if coalesce(v_s, 'desk') not in ('desk', 'tech', 'lead') or coalesce(v_r, 'desk') not in ('desk', 'tech', 'lead')
     or coalesce(v_q, 'desk') not in ('desk', 'tech', 'lead') then
    raise exception 'NEO_GATE: A role is desk, tech, lead or none.';
  end if;
  v_bp := coalesce(public._jbool(p, 'build_pool', 'The build pool'), false);
  v_sp := coalesce(public._jbool(p, 'service_pool', 'The service pool'), false);
  v_lvl := lower(public._jtxt(p, 'build_level', 10, 'The build level'));
  if v_lvl is not null and v_lvl not in ('junior', 'senior') then
    raise exception 'NEO_GATE: The build level is junior, senior or none.';
  end if;
  v_cap := public._jint(p, 'capacity_points', 'The capacity', 1, 50);
  v_max := public._jint(p, 'max_jobs', 'The job limit', 1, 20);
  v_note := public._jtxt(p, 'note', 300, 'The note');
  v_old := nullif(btrim(coalesce(p ->> 'key', '')), '');

  insert into public.designation_presets as dp (key, designation, service_role, rma_role, qc_role, build_pool, service_pool,
                                                build_level, capacity_points, max_jobs, note, updated_by, updated_at)
  values (v_key, v_desig, v_s, v_r, v_q, v_bp, v_sp, v_lvl, v_cap, v_max, v_note, lower(v_me.email), now())
  on conflict (key) do update
     set designation = excluded.designation, service_role = excluded.service_role, rma_role = excluded.rma_role,
         qc_role = excluded.qc_role, build_pool = excluded.build_pool, service_pool = excluded.service_pool,
         build_level = excluded.build_level, capacity_points = excluded.capacity_points, max_jobs = excluded.max_jobs,
         note = excluded.note, updated_by = excluded.updated_by, updated_at = now()
  returning * into v_row;
  if v_old is not null and v_old <> v_key then
    delete from public.designation_presets where key = v_old;
  end if;
  return jsonb_build_object('ok', true, 'preset', to_jsonb(v_row));
end $$;

-- Deleting a preset changes nobody's roles (presets are applied, not linked).
create or replace function public.preset_delete(p_key text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  n int;
begin
  if v_me.tier < 4 then raise exception 'NEO_DENIED: Only tier 4 and above can manage people.'; end if;
  delete from public.designation_presets
   where key = btrim(coalesce(p_key, '')) or key = public._designation_key(p_key);
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'deleted', n > 0);
end $$;


-- =============================================================================
-- §9  NeoHR WORK LOGS (any active staff; tier 3+ read the team's)
-- =============================================================================

-- Up to 200 rows. Upsert row: {id, title, description, category,
-- location_name, latitude, longitude, created_at, updated_at, deleted:false}.
-- Delete row: {id, updated_at, deleted:true} (nothing else is read). Each row
-- is checked on its own: one bad row is rejected, never the batch.
create or replace function public.work_log_push(p_rows jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_em text := lower(v_me.email);
  e jsonb;
  v_raw text; v_id uuid; v_del boolean; v_upd timestamptz; v_cre timestamptz;
  v_title text; v_desc text; v_cat text; v_loc text; v_lat double precision; v_lng double precision;
  v_owner uuid; v_got uuid; v_exists boolean;
  v_acc jsonb := '[]'::jsonb; v_stale jsonb := '[]'::jsonb; v_rej jsonb := '[]'::jsonb;
  v_lo constant timestamptz := '2020-01-01T00:00:00Z';
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'NEO_GATE: Send the logs as a list.';
  end if;
  if jsonb_array_length(p_rows) > 200 then
    raise exception 'NEO_GATE: Send at most 200 logs at a time.';
  end if;

  for e in select value from jsonb_array_elements(p_rows) loop
    v_raw := case when jsonb_typeof(e) = 'object' then e ->> 'id' end;
    begin
      if jsonb_typeof(e) <> 'object' then raise exception 'not an object'; end if;
      v_id := (e ->> 'id')::uuid;
      if v_id is null then raise exception 'no id'; end if;
      v_del := coalesce((e ->> 'deleted')::boolean, false);
      v_upd := (e ->> 'updated_at')::timestamptz;
      if v_upd is null then raise exception 'no updated_at'; end if;

      if v_del then
        if v_upd < v_lo or v_upd > now() + interval '10 minutes' then
          v_rej := v_rej || jsonb_build_object('id', v_raw, 'reason', 'clock');
          continue;
        end if;
        select profile_id, true into v_owner, v_exists from public.work_logs where id = v_id for update;
        if not found then
          v_acc := v_acc || to_jsonb(v_raw);            -- nothing to delete: done
        elsif v_owner is distinct from v_me.id then
          v_rej := v_rej || jsonb_build_object('id', v_raw, 'reason', 'not_yours');
        else
          update public.work_logs
             set deleted_at = v_upd, updated_at = v_upd, received_at = now()
           where id = v_id and updated_at < v_upd;
          if found then v_acc := v_acc || to_jsonb(v_raw); else v_stale := v_stale || to_jsonb(v_raw); end if;
        end if;
        continue;
      end if;

      v_title := btrim(coalesce(e ->> 'title', ''));
      if char_length(v_title) < 1 or char_length(v_title) > 300 then raise exception 'title'; end if;
      v_desc := nullif(e ->> 'description', '');
      if v_desc is not null and char_length(v_desc) > 5000 then raise exception 'description'; end if;
      v_cat := coalesce(nullif(btrim(coalesce(e ->> 'category', '')), ''), 'Work');
      if char_length(v_cat) > 60 then raise exception 'category'; end if;
      v_loc := nullif(btrim(coalesce(e ->> 'location_name', '')), '');
      if v_loc is not null and char_length(v_loc) > 200 then raise exception 'location'; end if;
      v_lat := (e ->> 'latitude')::double precision;
      v_lng := (e ->> 'longitude')::double precision;
      if v_lat is null or v_lng is null or v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180 then
        v_lat := null; v_lng := null;
      end if;
      v_cre := (e ->> 'created_at')::timestamptz;
      if v_cre is null then raise exception 'no created_at'; end if;
      if v_cre < v_lo or v_cre > now() + interval '10 minutes'
         or v_upd < v_lo or v_upd > now() + interval '10 minutes' then
        v_rej := v_rej || jsonb_build_object('id', v_raw, 'reason', 'clock');
        continue;
      end if;

      v_got := null;
      insert into public.work_logs as wl (id, profile_id, employee_email, title, description, category, location_name,
                                          latitude, longitude, created_at, updated_at, deleted_at, received_at)
      values (v_id, v_me.id, v_em, v_title, v_desc, v_cat, v_loc, v_lat, v_lng, v_cre, v_upd, null, now())
      on conflict (id) do update
         set title = excluded.title, description = excluded.description, category = excluded.category,
             location_name = excluded.location_name, latitude = excluded.latitude, longitude = excluded.longitude,
             created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = null,
             received_at = now()
       where wl.profile_id = v_me.id and excluded.updated_at > wl.updated_at
      returning wl.id into v_got;
      if v_got is not null then
        v_acc := v_acc || to_jsonb(v_raw);
      else
        select profile_id into v_owner from public.work_logs where id = v_id;
        if v_owner is distinct from v_me.id then
          v_rej := v_rej || jsonb_build_object('id', v_raw, 'reason', 'not_yours');
        else
          v_stale := v_stale || to_jsonb(v_raw);
        end if;
      end if;
    exception when others then
      v_rej := v_rej || jsonb_build_object('id', v_raw, 'reason', 'invalid');
    end;
  end loop;

  return jsonb_build_object('ok', true, 'accepted', v_acc, 'stale', v_stale, 'rejected', v_rej);
end $$;

-- My own rows (tombstones included) received after the cursor, oldest first:
-- keyset (received_at, id) > (p_since, p_after); at most 1000 per call.
create or replace function public.work_log_pull(p_since timestamptz default null, p_after uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_rows jsonb;
  v_n int;
  v_more boolean := false;
  v_last_at timestamptz;
  v_last_id uuid;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'title', x.title, 'description', x.description, 'category', x.category,
           'location_name', x.location_name, 'latitude', x.latitude, 'longitude', x.longitude,
           'created_at', x.created_at, 'updated_at', x.updated_at, 'deleted', x.deleted_at is not null,
           'deleted_at', x.deleted_at, 'received_at', x.received_at)
           order by x.received_at, x.id), '[]'::jsonb),
         count(*),
         (array_agg(x.received_at order by x.received_at desc, x.id desc))[1],
         (array_agg(x.id order by x.received_at desc, x.id desc))[1]
    into v_rows, v_n, v_last_at, v_last_id
    from (select wl.*
            from public.work_logs wl
           where wl.profile_id = v_me.id
             and (p_since is null
                  or (wl.received_at, wl.id) > (p_since, coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)))
           order by wl.received_at, wl.id
           limit 1000) x;
  if v_n = 1000 then
    v_more := exists (select 1 from public.work_logs wl
                       where wl.profile_id = v_me.id and (wl.received_at, wl.id) > (v_last_at, v_last_id));
  end if;
  return jsonb_build_object('rows', v_rows,
                            'next_since', coalesce(v_last_at, p_since),
                            'next_after', coalesce(v_last_id, p_after),
                            'more', v_more);
end $$;

-- Tier 3+: everyone's (or one person's) logs for shop days p_from..p_to
-- (inclusive, at most 62 days), not deleted, newest first, at most 2000.
create or replace function public.work_log_team(p_from date, p_to date, p_email text default null)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from date := coalesce(p_from, coalesce(p_to, v_today));
  v_to date := coalesce(p_to, coalesce(p_from, v_today));
  v_lo timestamptz;
  v_hi timestamptz;
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_rows jsonb;
  v_n int;
begin
  if public.my_tier() < 3 then raise exception 'NEO_DENIED: Only tier 3 and above can see the team''s logs.'; end if;
  if v_to < v_from then raise exception 'NEO_GATE: The end date is before the start date.'; end if;
  if v_to - v_from > 61 then raise exception 'NEO_GATE: Ask for at most 62 days at a time.'; end if;
  v_lo := v_from::timestamp at time zone 'Asia/Kolkata';
  v_hi := (v_to + 1)::timestamp at time zone 'Asia/Kolkata';

  with page as (
    select wl.*, p.full_name
      from public.work_logs wl
      left join public.profiles p on p.id = wl.profile_id
     where wl.deleted_at is null and wl.created_at >= v_lo and wl.created_at < v_hi
       and (v_email is null or lower(wl.employee_email) = v_email)
     order by wl.created_at desc, wl.id
     limit 2001
  ), numbered as (
    select page.*, row_number() over (order by page.created_at desc, page.id) as rn from page
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'employee_email', n.employee_email,
           'employee_name', coalesce(nullif(btrim(coalesce(n.full_name, '')), ''), n.employee_email),
           'title', n.title, 'description', n.description, 'category', n.category,
           'location_name', n.location_name, 'latitude', n.latitude, 'longitude', n.longitude,
           'created_at', n.created_at, 'updated_at', n.updated_at,
           'day', (n.created_at at time zone 'Asia/Kolkata')::date)
           order by n.created_at desc, n.id) filter (where n.rn <= 2000), '[]'::jsonb),
         count(*)
    into v_rows, v_n
    from numbered n;
  return jsonb_build_object('from', v_from, 'to', v_to, 'rows', v_rows, 'more', v_n > 2000);
end $$;


-- =============================================================================
-- §10  FUNCTION PRIVILEGES
--      Postgres grants EXECUTE to PUBLIC by default and Supabase adds anon and
--      authenticated. Every function in this file is revoked from all three,
--      then granted exactly: the API to authenticated (each checks the caller
--      itself), everything to service_role, nothing to anon. my_modules,
--      service_tech_list, service_claim and service_create keep v2's grants.
-- =============================================================================

do $$
declare
  r record;
  v_all text[] := array[
    -- helpers and internals
    '_designation_key','_build_tier','_first_name','_staff_for_short_name','_work_defaults','_work_settings',
    '_work_cost_build','_work_cost_service','_work_load','_work_why_not','_work_why_text','_svc_category_label',
    '_ist_hm','_work_kind','_work_offer_blocks','_work_me_lock','_work_event','_work_alert','_work_alerts_resolve',
    '_work_offer_set','_work_offer_clear','_work_pick','_work_auto_offer','_work_item','_svc_apply_visit',
    '_svc_visit_event','_work_accept','_work_expire','_work_release_build','_work_person_gone','_preset_apply',
    '_work_staff_entry','_work_lockdown',
    -- triggers
    'tg_tickets_work_guard','tg_tickets_work_added','tg_tickets_work_gone','tg_service_jobs_work_gone',
    'tg_service_jobs_zy_offer_guard','tg_service_jobs_zy_offer_insert',
    -- API (v2 redefinitions first)
    'my_modules','service_tech_list','service_claim','service_create',
    'work_queue','work_claim','work_offer','work_respond','work_release','build_queue_send','work_team',
    'work_events_for','work_tick','work_alert_resolve','my_work_profile',
    'staff_list','staff_update','staff_apply_preset','preset_list','preset_upsert','preset_delete',
    'work_log_push','work_log_pull','work_log_team'];
  v_authenticated text[] := array[
    'my_modules','service_tech_list','service_claim','service_create',
    'work_queue','work_claim','work_offer','work_respond','work_release','build_queue_send','work_team',
    'work_events_for','work_tick','work_alert_resolve','my_work_profile',
    'staff_list','staff_update','staff_apply_preset','preset_list','preset_upsert','preset_delete',
    'work_log_push','work_log_pull','work_log_team'];
begin
  for r in
    select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as sig, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any (v_all)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname = any (v_authenticated) then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- =============================================================================
-- End of work_queue_v2_2. Run sql/work-queue.tests.sql next (it rolls back).
-- =============================================================================
