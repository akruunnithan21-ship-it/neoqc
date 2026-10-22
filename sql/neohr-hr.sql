-- =============================================================================
-- NEO TOKYO OPERATIONS — Attendance, breaks, routes, travel allowance and the
-- HR module (v2.3)
-- Migration name: neohr_hr_v2_3              Target: Postgres 17 on Supabase
-- Ships with Neo OS 1.12.0 and NeoHR 2.2.0 (contract version 4, §14).
-- -----------------------------------------------------------------------------
-- DEPLOY ORDER
--   1. sql/service-v2.sql     (live)
--   2. sql/service-v2.1.sql   (live)
--   3. sql/work-queue.sql     (live, v2.2)
--   4. sql/neohr-hr.sql       (this file, v2.3)
--   5. sql/neohr-hr-cron.sql  (optional: the daily retention job)
--   service-v2.sql defines record_field_activity and tech_activity, which this
--   file redefines (punches go to attendance_events). Re-apply this file after
--   ANY re-run of service-v2.sql (and after re-running v2.1 / v2.2, as their
--   own headers say). This file is re-runnable on its own: a second run keeps
--   every setting, roster, request and punch people made since (seeds and the
--   legacy backfill are ON CONFLICT DO NOTHING).
--   Tests: sql/neohr-hr.tests.sql (one transaction, ends in ROLLBACK).
--
-- WHAT THIS DOES (owner decisions 2026-10-22, HR-SPEC §0 and §9)
--   * attendance_events is the ONLY attendance record: punch in / out and
--     breaks from the phone (hr_punch), HR corrections (hr_correct) and
--     approved missed punches. The tolerant fold (_hr_fold) turns them into
--     sessions; a session belongs to the India day of its punch_in, may run
--     past midnight, and is closed by the server at punch_in + max_session_h
--     (16 h) when nobody punched out ("missed_out").
--   * Route points (location_push) only while on duty and not on a break or a
--     work-from-home day — the server refuses the rest. They are read only
--     through hr_route / hr_my_day (no client grant on location_points) and
--     deleted after retention_days; each day's km stays in hr_day_km.
--   * One distance algorithm (_hr_track_points, §14 of the contract), shared
--     with the phone (Kotlin HrDistance) through tests/fixtures/hr-km.json.
--   * Day records (present, late, half day, absent, leave, off, open; flex
--     days never show late / early), requests to HR (late start, early leave,
--     flexible day, field day, missed punch, leave), the duty roster, public
--     holidays, the live board, the register, travel allowance per month.
--   * Approvers are has_module('neohr','lead') (tier 3+ automatically). Nobody
--     approves or changes their own attendance, duty or travel allowance.
--
-- OLD CLIENTS KEEP WORKING
--   * record_field_activity keeps its signature and answers. Its punch_in /
--     punch_out now go through the same sequence check as hr_punch into
--     attendance_events (no field_activity row); a refused punch answers
--     {applied:false, applied_note:<the sentence>}. Every other kind is v2.
--   * tech_activity keeps its signature and keys; its punch counts and first /
--     last times come from attendance_events.
--   * neo_dashboard and every v2.2 function are untouched (NeoHR 2.1.1 phones
--     are unaffected); the new hr_dashboard() serves NeoHR 2.2.
--
-- CONVENTIONS (as v2 / v2.1 / v2.2)
--   * Errors for people: NEO_<KIND>: <a human sentence>. Clients strip the prefix.
--   * Every API RPC is security definer, search_path = public, and starts with
--     v_me := public._neo_me().
--   * India time everywhere: "today" is (now() at time zone 'Asia/Kolkata')::date
--     (public._hr_today); a shift instant is (day + time) at time zone
--     'Asia/Kolkata' (public._hr_at). current_date is never used.
--   * Locks: every writer of a person's attendance takes
--     pg_advisory_xact_lock(hashtext('neo_hr_att:' || lower(email)));
--     location_push takes the SHARED lock on the same key.
--   * Every table here: RLS on, revoke all from anon and authenticated, select
--     granted as noted (location_points: to nobody). Writes only through the
--     definer RPCs. Internals (_hr_*) are defined inside DO blocks that end by
--     locking them down, so a deploy split into parts is never open between
--     parts.
--
-- Apply as ONE migration (or as the parts of pgtest/prep-any.mjs, in order).
-- Nothing here deletes customer data.
-- =============================================================================

set local lock_timeout = '15s';


-- =============================================================================
-- §1  TABLES (each followed by its row level security and grants)
-- =============================================================================

-- One row (id = 1). The shift fields are display copies of the default row of
-- hr_shift_history in force (India) on the day of the last shift change — not
-- a row that only starts later. The day records read hr_shift_history itself.
create table if not exists public.hr_settings (
  id               int primary key default 1 check (id = 1),
  shift_start      time not null default '09:30',
  shift_end        time not null default '18:30',
  grace_min        int not null default 10 check (grace_min between 0 and 120),
  weekly_off       int[] not null default '{0}' check (weekly_off <@ '{0,1,2,3,4,5,6}'::int[]),
  half_day_min     int not null default 240 check (half_day_min between 60 and 600),
  track_interval_s int not null default 120 check (track_interval_s between 30 and 600),
  track_distance_m int not null default 100 check (track_distance_m between 25 and 1000),
  retention_days   int not null default 90 check (retention_days between 30 and 365),
  ta_rate_per_km   numeric(8,2) check (ta_rate_per_km is null or ta_rate_per_km between 0 and 1000),
  office_lat       double precision check (office_lat is null or office_lat between -90 and 90),
  office_lng       double precision check (office_lng is null or office_lng between -180 and 180),
  office_radius_m  int not null default 150 check (office_radius_m between 50 and 2000),
  max_session_h    int not null default 16 check (max_session_h between 4 and 24),
  -- Days before this (and before a person's account existed) have no attendance
  -- record to speak of: with no punch they read 'not_tracked', not 'absent'.
  -- The first apply sets it to that day (India time); tier 4+ may change it.
  attendance_from  date not null default ((now() at time zone 'Asia/Kolkata')::date),
  last_purge_at    timestamptz,
  updated_by       text,
  updated_at       timestamptz not null default now(),
  constraint hr_settings_shift_order check (shift_end > shift_start),
  constraint hr_settings_office_pair check ((office_lat is null) = (office_lng is null))
);
alter table public.hr_settings enable row level security;
drop policy if exists hrs_select on public.hr_settings;
create policy hrs_select on public.hr_settings for select to authenticated
  using ((select public.my_tier()) >= 1);
revoke all on table public.hr_settings from anon, authenticated;
grant select on table public.hr_settings to authenticated;

-- Per-person switches. shift_start / shift_end / weekly_off are display copies
-- of the person's hr_shift_history row in force (India) on the day of their
-- last shift change (null when none was in force yet: the default applies).
create table if not exists public.hr_person (
  profile_id          uuid primary key references public.profiles(id) on delete cascade,
  shift_start         time,
  shift_end           time,
  weekly_off          int[] check (weekly_off is null or weekly_off <@ '{0,1,2,3,4,5,6}'::int[]),
  ta_eligible         boolean not null default true,
  track_location      boolean not null default true,
  attendance_required boolean not null default true,
  updated_by          text,
  updated_at          timestamptz not null default now()
);
alter table public.hr_person enable row level security;
drop policy if exists hrp_select on public.hr_person;
create policy hrp_select on public.hr_person for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.has_module('neohr', 'lead')));
revoke all on table public.hr_person from anon, authenticated;
grant select on table public.hr_person to authenticated;

-- Shift history: the shift for day d is the person's row with the greatest
-- effective_from <= d; a null field (or no row) falls back to the default row
-- (profile_id null) with the greatest effective_from <= d. A change made
-- today for tomorrow never rewrites yesterday's late marks.
create table if not exists public.hr_shift_history (
  id             bigint generated always as identity primary key,
  profile_id     uuid references public.profiles(id) on delete cascade,
  effective_from date not null,
  shift_start    time,
  shift_end      time,
  grace_min      int check (grace_min is null or grace_min between 0 and 120),
  weekly_off     int[] check (weekly_off is null or weekly_off <@ '{0,1,2,3,4,5,6}'::int[]),
  half_day_min   int check (half_day_min is null or half_day_min between 60 and 600),
  set_by_email   text,
  set_at         timestamptz not null default now()
);
create unique index if not exists hr_shift_history_key on public.hr_shift_history
  ((coalesce(profile_id, '00000000-0000-0000-0000-000000000000'::uuid)), effective_from);
alter table public.hr_shift_history enable row level security;
drop policy if exists hrsh_select on public.hr_shift_history;
create policy hrsh_select on public.hr_shift_history for select to authenticated
  using ((select public.has_module('neohr', 'lead'))
         or ((select public.my_tier()) >= 1 and (profile_id is null or profile_id = (select auth.uid()))));
revoke all on table public.hr_shift_history from anon, authenticated;
grant select on table public.hr_shift_history to authenticated;

-- THE attendance record. id = the phone's client id (idempotent). employee_email
-- (lower case) is the history key: deleting a login keeps the punches.
create table if not exists public.attendance_events (
  id               uuid primary key,
  profile_id       uuid references public.profiles(id) on delete set null,
  employee_email   text not null check (employee_email = lower(employee_email)),
  kind             text not null check (kind in ('punch_in', 'punch_out', 'break_start', 'break_end')),
  at               timestamptz not null,
  device_at        timestamptz,
  time_source      text not null default 'device' check (time_source in ('server', 'device', 'hr')),
  lat              double precision,
  lng              double precision,
  accuracy_m       double precision,
  source           text not null default 'phone' check (source in ('phone', 'hr')),
  note             text check (note is null or char_length(note) <= 500),
  created_by_email text,
  received_at      timestamptz not null default now(),
  voided_at        timestamptz,
  voided_by        text,
  void_reason      text check (void_reason is null or char_length(void_reason) <= 500)
);
create index if not exists ae_email_at_idx on public.attendance_events (lower(employee_email), at);
create index if not exists ae_profile_at_idx on public.attendance_events (profile_id, at);
alter table public.attendance_events enable row level security;
drop policy if exists ae_select on public.attendance_events;
create policy ae_select on public.attendance_events for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.has_module('neohr', 'lead')));
revoke all on table public.attendance_events from anon, authenticated;
grant select on table public.attendance_events to authenticated;

-- Route points. NO client grant at all: only the definer RPCs read them
-- (hr_route / hr_my_day, which log every view of someone else's route).
create table if not exists public.location_points (
  id              bigint generated always as identity primary key,
  client_point_id uuid not null unique,
  profile_id      uuid references public.profiles(id) on delete set null,
  employee_email  text not null check (employee_email = lower(employee_email)),
  at              timestamptz not null,
  device_at       timestamptz,
  time_source     text not null default 'device' check (time_source in ('server', 'device')),
  lat             double precision not null check (lat between -90 and 90),
  lng             double precision not null check (lng between -180 and 180),
  accuracy_m      double precision check (accuracy_m is null or accuracy_m >= 0),
  speed_mps       double precision,
  bearing         double precision,
  received_at     timestamptz not null default now()
);
create index if not exists lp_profile_at_idx on public.location_points (profile_id, at);
create index if not exists lp_email_at_idx on public.location_points (lower(employee_email), at);
create index if not exists lp_at_idx on public.location_points (at);
alter table public.location_points enable row level security;
revoke all on table public.location_points from anon, authenticated;

create table if not exists public.hr_requests (
  id                 uuid primary key default gen_random_uuid(),
  profile_id         uuid references public.profiles(id) on delete set null,
  employee_email     text not null check (employee_email = lower(employee_email)),
  kind               text not null check (kind in ('late_start', 'early_leave', 'flexible_day', 'field_day', 'missed_punch', 'leave')),
  date_from          date not null,
  date_to            date not null,
  half_day           boolean not null default false,
  leave_type         text check (leave_type in ('casual', 'sick', 'other')),
  reason             text not null check (char_length(reason) between 3 and 500),
  ref_code           text check (ref_code is null or char_length(ref_code) <= 20),
  missed_at          timestamptz,
  missed_kind        text check (missed_kind in ('punch_in', 'punch_out', 'break_start', 'break_end')),
  status             text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by_email   text,
  decided_by_name    text,
  decided_at         timestamptz,
  decision_note      text check (decision_note is null or char_length(decision_note) <= 300),
  cancelled_by_email text,
  cancelled_by_name  text,
  cancelled_at       timestamptz,
  cancel_note        text check (cancel_note is null or char_length(cancel_note) <= 300),
  created_at         timestamptz not null default now(),
  constraint hr_requests_dates check (date_to >= date_from and date_to - date_from <= 30),
  constraint hr_requests_leave_type check (kind <> 'leave' or leave_type is not null),
  constraint hr_requests_missed check (kind <> 'missed_punch' or (missed_at is not null and missed_kind is not null)),
  constraint hr_requests_half_day check (not half_day or (kind = 'leave' and date_from = date_to))
);
create index if not exists hrq_email_idx on public.hr_requests (lower(employee_email), date_from);
create index if not exists hrq_pending_idx on public.hr_requests (created_at) where status = 'pending';
alter table public.hr_requests enable row level security;
drop policy if exists hrq_select on public.hr_requests;
create policy hrq_select on public.hr_requests for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.has_module('neohr', 'lead')));
revoke all on table public.hr_requests from anon, authenticated;
grant select on table public.hr_requests to authenticated;

-- The duty roster. A row made by an approved leave / field day carries its
-- request (source_request_id) and the note 'Leave' / 'Field day' — never the
-- reason or the leave type.
create table if not exists public.hr_roster (
  profile_id        uuid not null references public.profiles(id) on delete cascade,
  day               date not null,
  duty              text not null check (duty in ('shop', 'field', 'off', 'leave', 'wfh')),
  note              text check (note is null or char_length(note) <= 200),
  set_by_email      text,
  set_at            timestamptz not null default now(),
  source_request_id uuid references public.hr_requests(id) on delete set null,
  primary key (profile_id, day)
);
create index if not exists hrr_request_idx on public.hr_roster (source_request_id) where source_request_id is not null;
create index if not exists hrr_day_idx on public.hr_roster (day);
alter table public.hr_roster enable row level security;
drop policy if exists hrr_select on public.hr_roster;
create policy hrr_select on public.hr_roster for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.has_module('neohr', 'lead')));
revoke all on table public.hr_roster from anon, authenticated;
grant select on table public.hr_roster to authenticated;

-- Travel allowance approvals: a snapshot of km, rate and amount for a month.
create table if not exists public.hr_ta_approvals (
  profile_id        uuid not null references public.profiles(id) on delete cascade,
  month             date not null check (extract(day from month) = 1),
  km                numeric(10,2) not null,
  rate              numeric(8,2) not null,
  amount            numeric(10,2) not null,
  approved_by_email text,
  approved_by_name  text,
  approved_at       timestamptz not null default now(),
  note              text check (note is null or char_length(note) <= 300),
  primary key (profile_id, month)
);
alter table public.hr_ta_approvals enable row level security;
drop policy if exists hrta_select on public.hr_ta_approvals;
create policy hrta_select on public.hr_ta_approvals for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.has_module('neohr', 'lead')));
revoke all on table public.hr_ta_approvals from anon, authenticated;
grant select on table public.hr_ta_approvals to authenticated;

-- km per person per past day: a cache while the day's points exist, THE
-- record (final = true) once _hr_purge deleted them. fp = the fingerprint of
-- the inputs the cached km was computed from (_hr_day_fp): a row whose inputs
-- changed since — even by a writer that committed while a reader was still
-- computing it — is recomputed on the next read, never trusted.
create table if not exists public.hr_day_km (
  profile_id     uuid references public.profiles(id) on delete set null,
  employee_email text not null check (employee_email = lower(employee_email)),
  day            date not null,
  km             numeric(10,2) not null,
  km_gaps        int not null default 0,
  points         int not null default 0,
  final          boolean not null default false,
  computed_at    timestamptz not null default now(),
  fp             text,
  primary key (employee_email, day)
);
alter table public.hr_day_km add column if not exists fp text;
alter table public.hr_day_km enable row level security;
drop policy if exists hrkm_select on public.hr_day_km;
create policy hrkm_select on public.hr_day_km for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.has_module('neohr', 'lead')));
revoke all on table public.hr_day_km from anon, authenticated;
grant select on table public.hr_day_km to authenticated;

create table if not exists public.hr_holidays (
  day          date primary key,
  name         text not null check (char_length(name) between 2 and 80),
  set_by_email text,
  set_at       timestamptz not null default now()
);
alter table public.hr_holidays enable row level security;
drop policy if exists hrh_select on public.hr_holidays;
create policy hrh_select on public.hr_holidays for select to authenticated
  using ((select public.my_tier()) >= 1);
revoke all on table public.hr_holidays from anon, authenticated;
grant select on table public.hr_holidays to authenticated;

-- Every view of someone else's route (hr_route). The person sees them.
create table if not exists public.hr_route_views (
  id            bigint generated always as identity primary key,
  viewer_email  text not null,
  subject_email text not null,
  day           date not null,
  at            timestamptz not null default now()
);
create index if not exists hrv_subject_idx on public.hr_route_views (lower(subject_email), day);
alter table public.hr_route_views enable row level security;
drop policy if exists hrv_select on public.hr_route_views;
create policy hrv_select on public.hr_route_views for select to authenticated
  using (lower(subject_email) = lower((select auth.email())) or (select public.my_tier()) >= 4);
revoke all on table public.hr_route_views from anon, authenticated;
grant select on table public.hr_route_views to authenticated;

-- The identity sequences: nobody but the definer code inserts.
do $$
declare v_seq text;
begin
  foreach v_seq in array array[pg_get_serial_sequence('public.hr_shift_history', 'id'),
                               pg_get_serial_sequence('public.location_points', 'id'),
                               pg_get_serial_sequence('public.hr_route_views', 'id')] loop
    if v_seq is not null then
      execute format('revoke all on sequence %s from anon, authenticated', v_seq);
    end if;
  end loop;
end $$;


-- =============================================================================
-- §2  SEEDS AND THE LEGACY BACKFILL (re-runnable: nothing is overwritten)
-- =============================================================================

insert into public.hr_settings (id) values (1) on conflict do nothing;

-- The default shift row everyone falls back to (effective since 2020).
insert into public.hr_shift_history (profile_id, effective_from, shift_start, shift_end, grace_min, weekly_off, half_day_min, set_by_email)
select null, date '2020-01-01', s.shift_start, s.shift_end, s.grace_min, s.weekly_off, s.half_day_min, 'migration'
  from public.hr_settings s
 where s.id = 1
on conflict do nothing;

-- attendance_events is the only attendance record: the punches NeoHR and the
-- desktop posted through record_field_activity before v2.3 move over (same
-- ids, so a replay of one of them is still answered once). No sequence check.
-- It runs again at the end of §7, in the statement that redefines
-- record_field_activity, for the punches posted in between.
insert into public.attendance_events (id, profile_id, employee_email, kind, at, device_at, time_source,
                                      lat, lng, accuracy_m, source, note, created_by_email, received_at)
select fa.client_request_id, p.id, lower(fa.employee_email), fa.kind, fa.at, fa.at, 'device',
       fa.lat, fa.lng, fa.accuracy_m, 'phone', 'migrated from field_activity',
       lower(fa.employee_email), fa.received_at
  from public.field_activity fa
  left join public.profiles p on lower(p.email) = lower(fa.employee_email)
 where fa.kind in ('punch_in', 'punch_out')
on conflict (id) do nothing;


-- =============================================================================
-- §3  INTERNALS (no client role may execute them)
--     Each DO block below is ONE statement (a split deploy never cuts one in
--     two) and ends by calling _hr_lockdown(), which revokes every _hr_*
--     function from public, anon and authenticated and grants the API exactly.
-- =============================================================================

-- ── §3 part 1: lockdown, India time, the fold ───────────────────────────────
do $hr$
begin
create or replace function public._hr_lockdown()
returns void language plpgsql volatile set search_path = public as $$
declare
  r record;
  v_api constant text[] := array[
    'hr_punch', 'hr_my_day', 'hr_my_month', 'location_push', 'hr_route', 'hr_request_create', 'hr_request_cancel',
    'hr_request_decide', 'hr_requests_list', 'hr_roster_set', 'hr_roster_get', 'hr_board', 'hr_register', 'hr_correct',
    'hr_settings_get', 'hr_settings_set', 'hr_person_set', 'hr_ta_report', 'hr_ta_approve', 'hr_ta_unapprove',
    'hr_holiday_set', 'hr_dashboard', 'record_field_activity', 'tech_activity'];
begin
  for r in
    select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as sig, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and (p.proname ~ '^_hr_' or p.proname = any (v_api))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname = any (v_api) then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- "Today" in the shop: India time, never current_date (the server runs in UTC,
-- so from 00:00 to 05:30 IST current_date is still yesterday).
create or replace function public._hr_today(p_now timestamptz default now())
returns date language sql stable set search_path = public as $$
  select (coalesce(p_now, now()) at time zone 'Asia/Kolkata')::date
$$;

-- The instant of a shop clock time on a shop day.
create or replace function public._hr_at(p_day date, p_t time)
returns timestamptz language sql immutable set search_path = public as $$
  select (p_day + p_t) at time zone 'Asia/Kolkata'
$$;

-- A staff profile by email (active or not), or a row of nulls.
create or replace function public._hr_staff(p_email text, p_active boolean default false)
returns public.profiles language plpgsql stable set search_path = public as $$
declare v public.profiles;
begin
  if nullif(btrim(coalesce(p_email, '')), '') is null then return v; end if;
  select * into v from public.profiles p
   where lower(p.email) = lower(btrim(p_email)) and coalesce(p.is_staff, false) and (p.active or not p_active)
   order by p.active desc limit 1;
  return v;
end $$;

-- S19: nobody approves or changes their own attendance, duty or allowance.
create or replace function public._hr_not_self(p_target uuid, p_me uuid)
returns void language plpgsql immutable set search_path = public as $$
begin
  if p_target is not null and p_target = p_me then
    raise exception 'NEO_DENIED: Someone else has to approve or change your own attendance, duty or travel allowance.';
  end if;
end $$;

-- A person's non-voided events in [p_lo, p_hi], in fold order.
create or replace function public._hr_events(p_email text, p_lo timestamptz, p_hi timestamptz)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'at', e.at, 'rcv', e.received_at,
                                               'ts', e.time_source, 'dev', e.device_at)
                            order by e.at, e.received_at, e.id), '[]'::jsonb)
    from public.attendance_events e
   where lower(e.employee_email) = lower(btrim(p_email)) and e.voided_at is null
     and e.at >= p_lo and e.at <= p_hi
$$;

-- THE fold (§9.4.1): events [{id, kind, at, rcv}] → sessions. Order (at,
-- received_at, id). off_duty → punch_in → on_duty ⇄ on_break → punch_out →
-- off_duty; a punch_out during a break ends the break. A session is closed by
-- the server at cap = punch_in + p_max_h hours when no punch_out came by then
-- (off duty from the cap on; a punch_out AT the cap still closes it). An event
-- the state does not allow is skipped and marks its session (or, outside a
-- session, its India day) irregular. Never raises. p_probe: report, for that
-- event id, whether it was allowed, the state before it, the cap of a session
-- auto-closed just before it, and whether the event after it was allowed.
-- skipped = the ids of every event the state did not allow (what hr_correct
-- compares before and after a change).
--   → {sessions:[{in_id,start,cap,end:'out'|'auto'|'open',out,out_id,breaks:[{from,to}],
--      open_break,last_at,irregular,day}], orphans:[{id,at,day}], skipped:[id], state, since, probe}
create or replace function public._hr_fold(p_ev jsonb, p_max_h int, p_now timestamptz, p_probe text default null)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  e jsonb;
  v_cap interval := make_interval(hours => coalesce(p_max_h, 16));
  v_state text := 'off_duty';
  v_since timestamptz;
  v_out jsonb := '[]'::jsonb;
  v_orph jsonb := '[]'::jsonb;
  v_skip jsonb := '[]'::jsonb;
  v_auto timestamptz;
  s_id text; s_start timestamptz; s_cap timestamptz; s_brk jsonb; s_bs timestamptz; s_last timestamptz; s_irr boolean;
  v_at timestamptz; v_kind text; v_id text; v_ok boolean; v_before text; v_auto_before timestamptz;
  v_probe jsonb;
  v_next boolean := false;
begin
  for e in
    select x.value from jsonb_array_elements(coalesce(p_ev, '[]'::jsonb)) as x(value)
     order by (x.value ->> 'at')::timestamptz, (x.value ->> 'rcv')::timestamptz nulls first, (x.value ->> 'id') collate "C"
  loop
    v_at := (e ->> 'at')::timestamptz;
    v_kind := e ->> 'kind';
    v_id := e ->> 'id';
    -- the open session ends at its cap
    if s_id is not null and (v_at > s_cap or (v_at = s_cap and v_kind <> 'punch_out')) then
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'in_id', s_id, 'start', s_start, 'cap', s_cap, 'end', 'auto', 'out', null, 'out_id', null, 'breaks', s_brk,
        'open_break', s_bs, 'last_at', s_last, 'irregular', s_irr, 'day', (s_start at time zone 'Asia/Kolkata')::date));
      s_id := null;
      v_state := 'off_duty';
      v_since := s_cap;
      v_auto := s_cap;
    end if;
    v_before := v_state;
    v_auto_before := v_auto;
    v_ok := case v_kind
              when 'punch_in' then v_state = 'off_duty'
              when 'break_start' then v_state = 'on_duty'
              when 'break_end' then v_state = 'on_break'
              when 'punch_out' then v_state in ('on_duty', 'on_break')
              else false end;
    if v_ok then
      if v_kind = 'punch_in' then
        s_id := v_id; s_start := v_at; s_cap := v_at + v_cap; s_brk := '[]'::jsonb; s_bs := null; s_irr := false;
        v_state := 'on_duty';
        v_auto := null;
      elsif v_kind = 'break_start' then
        s_bs := v_at;
        v_state := 'on_break';
      elsif v_kind = 'break_end' then
        s_brk := s_brk || jsonb_build_array(jsonb_build_object('from', s_bs, 'to', v_at));
        s_bs := null;
        v_state := 'on_duty';
      else
        if s_bs is not null then
          s_brk := s_brk || jsonb_build_array(jsonb_build_object('from', s_bs, 'to', v_at));
          s_bs := null;
        end if;
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'in_id', s_id, 'start', s_start, 'cap', s_cap, 'end', 'out', 'out', v_at, 'out_id', v_id, 'breaks', s_brk,
          'open_break', null, 'last_at', v_at, 'irregular', s_irr, 'day', (s_start at time zone 'Asia/Kolkata')::date));
        s_id := null;
        v_state := 'off_duty';
        v_auto := null;
      end if;
      s_last := v_at;
      v_since := v_at;
    elsif s_id is not null then
      s_irr := true;
      v_skip := v_skip || to_jsonb(v_id);
    else
      v_orph := v_orph || jsonb_build_array(jsonb_build_object('id', v_id, 'at', v_at,
                                                               'day', (v_at at time zone 'Asia/Kolkata')::date));
      v_skip := v_skip || to_jsonb(v_id);
    end if;
    if v_next then
      v_probe := v_probe || jsonb_build_object('next_id', v_id, 'next_ok', v_ok);
      v_next := false;
    end if;
    if v_id = p_probe then
      v_probe := jsonb_build_object('ok', v_ok, 'before', v_before, 'auto_cap', v_auto_before, 'next_id', null, 'next_ok', null);
      v_next := true;
    end if;
  end loop;
  if s_id is not null then
    if p_now >= s_cap then
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'in_id', s_id, 'start', s_start, 'cap', s_cap, 'end', 'auto', 'out', null, 'out_id', null, 'breaks', s_brk,
        'open_break', s_bs, 'last_at', s_last, 'irregular', s_irr, 'day', (s_start at time zone 'Asia/Kolkata')::date));
      v_state := 'off_duty';
      v_since := s_cap;
    else
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'in_id', s_id, 'start', s_start, 'cap', s_cap, 'end', 'open', 'out', null, 'out_id', null, 'breaks', s_brk,
        'open_break', s_bs, 'last_at', s_last, 'irregular', s_irr, 'day', (s_start at time zone 'Asia/Kolkata')::date));
    end if;
  end if;
  return jsonb_build_object('sessions', v_out, 'orphans', v_orph, 'skipped', v_skip, 'state', v_state, 'since', v_since,
                            'probe', v_probe);
end $$;

-- The runs of sessions (§9.5.2): every stretch on duty and not on a break,
-- [punch_in | break_end, break_start | punch_out | cap) → [{from, to, day}].
create or replace function public._hr_runs(p_sessions jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  s jsonb; b jsonb; v_cur timestamptz; v_end timestamptz; v_out jsonb := '[]'::jsonb;
begin
  for s in select x.value from jsonb_array_elements(coalesce(p_sessions, '[]'::jsonb)) as x(value)
            order by (x.value ->> 'start')::timestamptz loop
    v_cur := (s ->> 'start')::timestamptz;
    for b in select y.value from jsonb_array_elements(coalesce(s -> 'breaks', '[]'::jsonb)) as y(value)
              order by (y.value ->> 'from')::timestamptz loop
      if (b ->> 'from')::timestamptz > v_cur then
        v_out := v_out || jsonb_build_array(jsonb_build_object('from', v_cur, 'to', (b ->> 'from')::timestamptz, 'day', s ->> 'day'));
      end if;
      v_cur := (b ->> 'to')::timestamptz;
    end loop;
    v_end := coalesce((s ->> 'open_break')::timestamptz,
                      case when s ->> 'end' = 'out' then (s ->> 'out')::timestamptz else (s ->> 'cap')::timestamptz end);
    if v_end > v_cur then
      v_out := v_out || jsonb_build_array(jsonb_build_object('from', v_cur, 'to', v_end, 'day', s ->> 'day'));
    end if;
  end loop;
  return v_out;
end $$;

-- Haversine metres (§9.5.3 f): R = 6371008.8, float8.
create or replace function public._hr_hav(p_lat1 float8, p_lng1 float8, p_lat2 float8, p_lng2 float8)
returns float8 language sql immutable set search_path = public as $$
  select 2 * 6371008.8 * asin(least(1, sqrt(power(sin(radians(p_lat2 - p_lat1) / 2), 2)
                                            + cos(radians(p_lat1)) * cos(radians(p_lat2)) * power(sin(radians(p_lng2 - p_lng1) / 2), 2))))
$$;
perform public._hr_lockdown();
end $hr$;

-- ── §3 part 2: distance and stops (one algorithm, shared with the phone) ────
do $hr$
begin
-- §9.5.3 — p_runs = [[{id, at, lat, lng, accuracy_m}, …], …]; each run is
-- measured alone and the results are summed (nothing counts between runs).
--  a) drop accuracy > 50 (null = 50 everywhere);
--  b) one fix per instant: smallest accuracy, then smallest id;
--  c) speed filter: keep p when hav(ref, p) / Δt <= 45 m/s (ref = p); else
--     reject it; at the third reject in a row keep the first of them as a
--     jump (ref = it) and re-test the other two against it;
--  d) stops: from fix i, the longest run of consecutive fixes all within 75 m
--     of fix i; spanning >= 300 s it is a stop (centroid for display only)
--     and scanning goes on after it, else from i + 1;
--  e) distance from an anchor (the first fix): a stop fix other than the
--     stop's first is skipped; a jump moves the anchor and adds 0; otherwise
--     d = hav(anchor, q) is added when d >= max(15, (acc_anchor + acc_q) / 2)
--     and q becomes the anchor (else the anchor STAYS). An added step with
--     Δt > 600 s and d > 1000 m is a 'gap' segment and adds 1 to km_gaps;
--  g) km = round(round(total_m)::bigint / 1000.0, 2).
-- → {total_m, km, km_gaps, kept:[id], stops:[{arrived,left,minutes,lat,lng}],
--    segments:[{from,to,km,minutes,mode}], moving_min, path:[{at,lat,lng}]}
create or replace function public._hr_track_points(p_runs jsonb)
returns jsonb language plpgsql immutable set search_path = public as $$
declare
  r jsonb;
  ids text[]; ts timestamptz[]; la float8[]; lo float8[]; ac float8[];
  n int; m int; i int; j int; p int; a int; ref int; v_st int;
  k int[]; jmp boolean[]; q int[]; rej int[];
  stopf boolean[]; stopfirst int[];
  d float8; dt float8; v float8; sl float8; sg float8;
  seg_from timestamptz; seg_m float8;
  v_total float8 := 0;
  v_gaps int := 0;
  v_move float8 := 0;
  v_kept jsonb := '[]'::jsonb;
  v_stops jsonb := '[]'::jsonb;
  v_segs jsonb := '[]'::jsonb;
  v_path jsonb := '[]'::jsonb;
begin
  for r in select x.value from jsonb_array_elements(coalesce(p_runs, '[]'::jsonb)) as x(value) loop
    continue when jsonb_typeof(r) is distinct from 'array';
    -- a) + b)
    select coalesce(array_agg(y.id order by y.at), '{}'), coalesce(array_agg(y.at order by y.at), '{}'),
           coalesce(array_agg(y.lat order by y.at), '{}'), coalesce(array_agg(y.lng order by y.at), '{}'),
           coalesce(array_agg(y.acc order by y.at), '{}')
      into ids, ts, la, lo, ac
      from (select distinct on (z.at) z.id, z.at, z.lat, z.lng, z.acc
              from (select pt.value ->> 'id' as id, (pt.value ->> 'at')::timestamptz as at,
                           (pt.value ->> 'lat')::float8 as lat, (pt.value ->> 'lng')::float8 as lng,
                           coalesce((pt.value ->> 'accuracy_m')::float8, 50) as acc
                      from jsonb_array_elements(r) as pt(value)) z
             where z.acc <= 50
             order by z.at, z.acc, z.id collate "C") y;
    n := coalesce(array_length(ids, 1), 0);
    continue when n = 0;

    -- c) speed filter with the three-reject re-anchor
    k := array[1]; jmp := array[false]; ref := 1; rej := '{}';
    q := case when n > 1 then array(select g from generate_series(2, n) as g) else '{}'::int[] end;
    while cardinality(q) > 0 loop
      p := q[1];
      q := q[2:];
      dt := extract(epoch from ts[p] - ts[ref]);
      v := public._hr_hav(la[ref], lo[ref], la[p], lo[p]) / dt;
      if v <= 45 then
        k := k || p; jmp := jmp || false; ref := p; rej := '{}';
      else
        rej := rej || p;
        if cardinality(rej) = 3 then
          k := k || rej[1]; jmp := jmp || true; ref := rej[1];
          q := rej[2:3] || q;
          rej := '{}';
        end if;
      end if;
    end loop;
    m := cardinality(k);

    -- d) stops on the kept fixes
    stopf := array_fill(false, array[m]);
    stopfirst := array_fill(0, array[m]);
    i := 1;
    while i <= m loop
      j := i;
      while j < m loop
        exit when public._hr_hav(la[k[i]], lo[k[i]], la[k[j + 1]], lo[k[j + 1]]) > 75;
        j := j + 1;
      end loop;
      if extract(epoch from ts[k[j]] - ts[k[i]]) >= 300 then
        sl := 0; sg := 0;
        for a in i .. j loop
          sl := sl + la[k[a]];
          sg := sg + lo[k[a]];
          if a > i then stopf[a] := true; end if;
        end loop;
        v_stops := v_stops || jsonb_build_array(jsonb_build_object(
          'arrived', ts[k[i]], 'left', ts[k[j]], 'minutes', floor(extract(epoch from ts[k[j]] - ts[k[i]]) / 60)::int,
          'lat', sl / (j - i + 1), 'lng', sg / (j - i + 1)));
        stopfirst[i] := jsonb_array_length(v_stops);
        i := j + 1;
      else
        i := i + 1;
      end if;
    end loop;

    -- e) distance (and the display segments)
    a := 1;
    seg_from := ts[k[1]];
    seg_m := 0;
    if stopfirst[1] > 0 then seg_from := (v_stops -> (stopfirst[1] - 1) ->> 'left')::timestamptz; end if;
    for p in 2 .. m loop
      continue when stopf[p];
      if jmp[p] then
        if ts[k[a]] > seg_from then
          v_segs := v_segs || jsonb_build_array(jsonb_build_object('from', seg_from, 'to', ts[k[a]],
            'km', round(round(seg_m)::numeric / 1000, 2), 'minutes', floor(extract(epoch from ts[k[a]] - seg_from) / 60)::int, 'mode', 'moving'));
          v_move := v_move + extract(epoch from ts[k[a]] - seg_from);
        end if;
        a := p;
        seg_from := ts[k[p]];
        seg_m := 0;
      else
        d := public._hr_hav(la[k[a]], lo[k[a]], la[k[p]], lo[k[p]]);
        if d >= greatest(15, (ac[k[a]] + ac[k[p]]) / 2) then
          dt := extract(epoch from ts[k[p]] - ts[k[a]]);
          if dt > 600 and d > 1000 then
            v_gaps := v_gaps + 1;
            if ts[k[a]] > seg_from then
              v_segs := v_segs || jsonb_build_array(jsonb_build_object('from', seg_from, 'to', ts[k[a]],
                'km', round(round(seg_m)::numeric / 1000, 2), 'minutes', floor(extract(epoch from ts[k[a]] - seg_from) / 60)::int, 'mode', 'moving'));
              v_move := v_move + extract(epoch from ts[k[a]] - seg_from);
            end if;
            v_segs := v_segs || jsonb_build_array(jsonb_build_object('from', ts[k[a]], 'to', ts[k[p]],
              'km', round(round(d)::numeric / 1000, 2), 'minutes', floor(dt / 60)::int, 'mode', 'gap'));
            seg_from := ts[k[p]];
            seg_m := 0;
          else
            seg_m := seg_m + d;
          end if;
          v_total := v_total + d;
          a := p;
        end if;
      end if;
      v_st := stopfirst[p];
      if v_st > 0 then
        if ts[k[p]] > seg_from then
          v_segs := v_segs || jsonb_build_array(jsonb_build_object('from', seg_from, 'to', ts[k[p]],
            'km', round(round(seg_m)::numeric / 1000, 2), 'minutes', floor(extract(epoch from ts[k[p]] - seg_from) / 60)::int, 'mode', 'moving'));
          v_move := v_move + extract(epoch from ts[k[p]] - seg_from);
        end if;
        seg_from := (v_stops -> (v_st - 1) ->> 'left')::timestamptz;
        seg_m := 0;
      end if;
    end loop;
    if ts[k[m]] > seg_from then
      v_segs := v_segs || jsonb_build_array(jsonb_build_object('from', seg_from, 'to', ts[k[m]],
        'km', round(round(seg_m)::numeric / 1000, 2), 'minutes', floor(extract(epoch from ts[k[m]] - seg_from) / 60)::int, 'mode', 'moving'));
      v_move := v_move + extract(epoch from ts[k[m]] - seg_from);
    end if;
    -- (one aggregate: appending to a jsonb array point by point is quadratic)
    select v_kept || coalesce(jsonb_agg(to_jsonb(ids[k[g]]) order by g), '[]'::jsonb),
           v_path || coalesce(jsonb_agg(jsonb_build_object('at', ts[k[g]], 'lat', la[k[g]], 'lng', lo[k[g]]) order by g), '[]'::jsonb)
      into v_kept, v_path
      from generate_series(1, m) as g;
  end loop;
  return jsonb_build_object('total_m', v_total, 'km', round(round(v_total)::bigint / 1000.0, 2), 'km_gaps', v_gaps,
                            'kept', v_kept, 'stops', v_stops, 'segments', v_segs,
                            'moving_min', floor(v_move / 60)::int, 'path', v_path);
end $$;
perform public._hr_lockdown();
end $hr$;

-- ── §3 part 3: the day context, tracks and km ───────────────────────────────
do $hr$
begin
-- Per day of [p_from, p_to] for one person: duty (§9.6.4: roster row, else a
-- holiday or a weekly off → 'off', else 'shop'), the shift of that day
-- (§9.4.6: the person's history row, null fields from the default row), and
-- the approved requests that make it flexible or a half-day leave.
create or replace function public._hr_ctx(p_profile uuid, p_email text, p_from date, p_to date)
returns table (day date, duty text, duty_source text, duty_note text, request_id uuid, holiday text,
               shift_start time, shift_end time, grace_min int, weekly_off int[], half_day_min int,
               flex_request boolean, half_day_leave boolean)
language sql stable set search_path = public as $$
  select d.day,
         coalesce(r.duty, case when h.name is not null then 'off'
                               when extract(dow from d.day)::int = any (coalesce(sh.weekly_off, '{}')) then 'off'
                               else 'shop' end),
         case when r.duty is not null then 'roster'
              when h.name is not null then 'holiday'
              when extract(dow from d.day)::int = any (coalesce(sh.weekly_off, '{}')) then 'weekly_off'
              else 'default' end,
         r.note, r.source_request_id, h.name,
         sh.shift_start, sh.shift_end, sh.grace_min, sh.weekly_off, sh.half_day_min,
         exists (select 1 from public.hr_requests q
                  where lower(q.employee_email) = lower(p_email) and q.status = 'approved'
                    and q.kind in ('late_start', 'early_leave', 'flexible_day', 'field_day')
                    and d.day between q.date_from and q.date_to),
         exists (select 1 from public.hr_requests q
                  where lower(q.employee_email) = lower(p_email) and q.status = 'approved'
                    and q.kind = 'leave' and q.half_day and d.day between q.date_from and q.date_to)
    from (select g::date as day from generate_series(p_from, p_to, interval '1 day') as g) d
    left join public.hr_roster r on r.profile_id = p_profile and r.day = d.day
    left join public.hr_holidays h on h.day = d.day
    cross join lateral (
      select coalesce(ph.shift_start, dh.shift_start, s.shift_start) as shift_start,
             coalesce(ph.shift_end, dh.shift_end, s.shift_end) as shift_end,
             coalesce(ph.grace_min, dh.grace_min, s.grace_min) as grace_min,
             coalesce(ph.weekly_off, dh.weekly_off, s.weekly_off) as weekly_off,
             coalesce(ph.half_day_min, dh.half_day_min, s.half_day_min) as half_day_min
        from public.hr_settings s
        left join lateral (select x.* from public.hr_shift_history x
                            where p_profile is not null and x.profile_id = p_profile and x.effective_from <= d.day
                            order by x.effective_from desc limit 1) ph on true
        left join lateral (select x.* from public.hr_shift_history x
                            where x.profile_id is null and x.effective_from <= d.day
                            order by x.effective_from desc limit 1) dh on true
       where s.id = 1
    ) sh
   order by d.day
$$;

-- The sessions of one shop day (folded from max_session_h before the day to
-- max_session_h after it: a session that starts that day is then exact).
create or replace function public._hr_day_sessions(p_email text, p_day date, p_now timestamptz)
returns jsonb language plpgsql stable set search_path = public as $$
declare v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16); f jsonb;
begin
  f := public._hr_fold(public._hr_events(p_email, public._hr_at(p_day, '00:00') - make_interval(hours => v_h),
                                         public._hr_at(p_day + 1, '00:00') + make_interval(hours => v_h)), v_h, p_now);
  return coalesce((select jsonb_agg(x.value order by (x.value ->> 'start')::timestamptz)
                     from jsonb_array_elements(f -> 'sessions') as x(value) where (x.value ->> 'day')::date = p_day), '[]'::jsonb);
end $$;

-- The track of given sessions: their runs, each run's stored points, measured.
create or replace function public._hr_track_sessions(p_email text, p_sessions jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
declare v_runs jsonb := public._hr_runs(p_sessions); v_pts jsonb; v_n int;
begin
  select coalesce(jsonb_agg(x.pts order by x.ord), '[]'::jsonb), coalesce(sum(jsonb_array_length(x.pts)), 0)
    into v_pts, v_n
    from (select r.ord,
                 (select coalesce(jsonb_agg(jsonb_build_object('id', lp.client_point_id, 'at', lp.at, 'lat', lp.lat,
                                                               'lng', lp.lng, 'accuracy_m', lp.accuracy_m)
                                            order by lp.at, lp.client_point_id), '[]'::jsonb)
                    from public.location_points lp
                   where lower(lp.employee_email) = lower(p_email)
                     and lp.at >= (r.value ->> 'from')::timestamptz and lp.at < (r.value ->> 'to')::timestamptz) as pts
            from jsonb_array_elements(v_runs) with ordinality as r(value, ord)) x;
  return public._hr_track_points(v_pts) || jsonb_build_object('points', v_n, 'runs', jsonb_array_length(v_runs),
                                                               'sessions', jsonb_array_length(coalesce(p_sessions, '[]'::jsonb)));
end $$;

-- §9.5.1: the track of a person's shop day, and its km (always computed live).
create or replace function public._hr_track(p_email text, p_day date)
returns jsonb language sql stable set search_path = public as $$
  select public._hr_track_sessions(p_email, public._hr_day_sessions(p_email, p_day, now()))
$$;

create or replace function public._hr_km(p_email text, p_day date)
returns numeric language sql stable set search_path = public as $$
  select (public._hr_track(p_email, p_day) ->> 'km')::numeric
$$;

-- The fingerprint of what a day's km is computed from: the longest shift, and
-- how many route points, punches and voided punches lie in the window the
-- day's sessions are folded from (_hr_day_sessions). Points and punches are
-- only ever added or voided while a day can still be recomputed (_hr_purge
-- deletes a point only once every day it may belong to is final — or holds no
-- punch_in, so no session and 0 km either way), so any change to a day's
-- inputs changes its fingerprint. Two index range counts.
create or replace function public._hr_day_fp(p_email text, p_day date, p_h int)
returns text language sql stable set search_path = public as $$
  select concat_ws(':', p_h,
    (select count(*) from public.location_points lp
      where lower(lp.employee_email) = lower(btrim(p_email))
        and lp.at >= public._hr_at(p_day, '00:00') and lp.at < public._hr_at(p_day + 1, '00:00') + make_interval(hours => p_h)),
    (select count(*) || ':' || count(e.voided_at) from public.attendance_events e
      where lower(e.employee_email) = lower(btrim(p_email))
        and e.at >= public._hr_at(p_day, '00:00') - make_interval(hours => p_h)
        and e.at <= public._hr_at(p_day + 1, '00:00') + make_interval(hours => p_h)))
$$;

-- §9.5.6: today, and a day with an open session, are always computed live; a
-- past day uses its hr_day_km row while the row's fingerprint still matches,
-- else it is computed again and cached (final = false). A final row (written
-- by _hr_purge) is never recomputed. The fingerprint is taken BEFORE the
-- sessions and points are read: a change committed in between leaves a row
-- whose fingerprint is older than its km — recomputed next time — and never a
-- stale km under a current fingerprint. (location_push, hr_correct and an
-- approved missed punch also delete the row; the fingerprint is what makes a
-- row written by a reader that raced them harmless.)
create or replace function public._hr_day_km(p_email text, p_day date, p_now timestamptz, p_sessions jsonb)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  v_em text := lower(btrim(p_email));
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  v_row public.hr_day_km;
  v_have boolean;
  v_fp text;
  v_sess jsonb;
  v_t jsonb;
begin
  if p_day >= public._hr_today(p_now)
     or exists (select 1 from jsonb_array_elements(coalesce(p_sessions, '[]'::jsonb)) as s(value) where s.value ->> 'end' = 'open') then
    if jsonb_array_length(coalesce(p_sessions, '[]'::jsonb)) = 0 then
      return jsonb_build_object('km', 0, 'km_gaps', 0, 'final', false);
    end if;
    v_t := public._hr_track_sessions(v_em, p_sessions);
    return jsonb_build_object('km', (v_t ->> 'km')::numeric, 'km_gaps', (v_t ->> 'km_gaps')::int, 'final', false);
  end if;
  select * into v_row from public.hr_day_km where employee_email = v_em and day = p_day;
  v_have := found;
  if v_have and v_row.final then
    return jsonb_build_object('km', v_row.km, 'km_gaps', v_row.km_gaps, 'final', true);
  end if;
  if not v_have and jsonb_array_length(coalesce(p_sessions, '[]'::jsonb)) = 0 then
    return jsonb_build_object('km', 0, 'km_gaps', 0, 'final', false);
  end if;
  v_fp := public._hr_day_fp(v_em, p_day, v_h);
  if v_have and v_row.fp is not distinct from v_fp then
    return jsonb_build_object('km', v_row.km, 'km_gaps', v_row.km_gaps, 'final', false);
  end if;
  v_sess := public._hr_day_sessions(v_em, p_day, p_now);
  if jsonb_array_length(v_sess) = 0 then
    delete from public.hr_day_km where employee_email = v_em and day = p_day and not final;
    return jsonb_build_object('km', 0, 'km_gaps', 0, 'final', false);
  end if;
  v_t := public._hr_track_sessions(v_em, v_sess);
  insert into public.hr_day_km as h (profile_id, employee_email, day, km, km_gaps, points, final, computed_at, fp)
  values ((select p.id from public.profiles p where lower(p.email) = v_em order by p.active desc limit 1), v_em, p_day,
          (v_t ->> 'km')::numeric, (v_t ->> 'km_gaps')::int, (v_t ->> 'points')::int, false, now(), v_fp)
  on conflict (employee_email, day) do update
    set km = excluded.km, km_gaps = excluded.km_gaps, points = excluded.points, computed_at = excluded.computed_at,
        fp = excluded.fp
    where not h.final;
  return jsonb_build_object('km', (v_t ->> 'km')::numeric, 'km_gaps', (v_t ->> 'km_gaps')::int, 'final', false);
end $$;

-- A change at p_at can change the session of that India day or of the day
-- before (a session may run past midnight): drop both non-final km rows. Row
-- locks are always taken in (email, day) order — the day before first — the
-- order every reader caches in, so a writer and a reader never deadlock.
create or replace function public._hr_invalidate(p_email text, p_at timestamptz)
returns void language sql volatile set search_path = public as $$
  delete from public.hr_day_km
   where employee_email = lower(btrim(p_email)) and not final and day = (p_at at time zone 'Asia/Kolkata')::date - 1;
  delete from public.hr_day_km
   where employee_email = lower(btrim(p_email)) and not final and day = (p_at at time zone 'Asia/Kolkata')::date;
$$;
perform public._hr_lockdown();
end $hr$;

-- ── §3 part 4: the day record (pure) ────────────────────────────────────────
do $hr$
begin
-- §9.4.1 / §9.6.5. Pure: everything comes in p, so tests/fixtures/hr-day.json
-- runs it directly.
--   p = {day, now, max_session_h, shift:{start,end,grace_min,half_day_min},
--        duty, holiday, attendance_required, flex_request, half_day_leave,
--        events:[{id,kind,at,rcv}] + points_at:[…]   (folded here), or
--        sessions + orphans (already folded; a session may carry last_point_at),
--        km, km_gaps, tracked_from (optional: a day before it with no punch
--        that would otherwise be absent or not_in_yet is 'not_tracked' —
--        before attendance_from or before the person's account; leave, a
--        half-day leave's leave half and off still count there)}
-- Minutes are whole minutes, rounded down. A worked session ends at its
-- punch_out; an auto-closed one at its open break's start, else at its latest
-- event or point (<= cap); an open one at now (or its open break's start).
create or replace function public._hr_day_calc(p jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_day date := (p ->> 'day')::date;
  v_now timestamptz := coalesce((p ->> 'now')::timestamptz, now());
  v_today date;
  v_sh jsonb := coalesce(p -> 'shift', '{}'::jsonb);
  v_s0 timestamptz;
  v_s1 timestamptz;
  v_grace int := coalesce((v_sh ->> 'grace_min')::int, 10);
  v_half int := coalesce((v_sh ->> 'half_day_min')::int, 240);
  v_duty text := coalesce(p ->> 'duty', 'shop');
  v_req boolean := coalesce((p ->> 'attendance_required')::boolean, true);
  v_hdl boolean := coalesce((p ->> 'half_day_leave')::boolean, false);
  v_tf date := (p ->> 'tracked_from')::date;
  v_flex boolean;
  f jsonb; v_sess jsonb; v_orph jsonb; s jsonb;
  v_st timestamptz; v_cap timestamptz; v_ob timestamptz; v_lp timestamptz; v_wend timestamptz;
  v_bs float8; v_obs float8; v_ws float8;
  v_wsum float8 := 0; v_bsum float8 := 0;
  v_n int := 0;
  v_first timestamptz; v_last jsonb; v_lastout timestamptz;
  v_open boolean := false; v_missed boolean := false; v_irr boolean;
  v_list jsonb := '[]'::jsonb;
  v_late int := 0; v_early int := 0; v_worked int; v_status text;
  v_leave numeric := 0; v_absent numeric := 0;
begin
  v_today := (v_now at time zone 'Asia/Kolkata')::date;
  v_s0 := public._hr_at(v_day, coalesce((v_sh ->> 'start')::time, '09:30'));
  v_s1 := public._hr_at(v_day, coalesce((v_sh ->> 'end')::time, '18:30'));
  if p ? 'events' then
    f := public._hr_fold(p -> 'events', coalesce((p ->> 'max_session_h')::int, 16), v_now);
    select coalesce(jsonb_agg(x.value order by (x.value ->> 'start')::timestamptz), '[]'::jsonb) into v_sess
      from jsonb_array_elements(f -> 'sessions') as x(value) where (x.value ->> 'day')::date = v_day;
    select coalesce(jsonb_agg(x.value), '[]'::jsonb) into v_orph
      from jsonb_array_elements(f -> 'orphans') as x(value) where (x.value ->> 'day')::date = v_day;
  else
    v_sess := coalesce(p -> 'sessions', '[]'::jsonb);
    v_orph := coalesce(p -> 'orphans', '[]'::jsonb);
  end if;
  v_flex := v_duty = 'field' or coalesce((p ->> 'flex_request')::boolean, false) or v_hdl;
  v_irr := jsonb_array_length(v_orph) > 0;

  for s in select x.value from jsonb_array_elements(v_sess) as x(value) order by (x.value ->> 'start')::timestamptz loop
    v_n := v_n + 1;
    v_st := (s ->> 'start')::timestamptz;
    v_cap := (s ->> 'cap')::timestamptz;
    v_ob := (s ->> 'open_break')::timestamptz;
    v_irr := v_irr or coalesce((s ->> 'irregular')::boolean, false);
    select coalesce(sum(extract(epoch from (y.value ->> 'to')::timestamptz - (y.value ->> 'from')::timestamptz)), 0)
      into v_bs from jsonb_array_elements(coalesce(s -> 'breaks', '[]'::jsonb)) as y(value);
    v_obs := 0;
    if s ->> 'end' = 'out' then
      v_wend := (s ->> 'out')::timestamptz;
    elsif s ->> 'end' = 'auto' then
      if v_ob is not null then
        v_wend := v_ob;
      else
        v_lp := coalesce((s ->> 'last_point_at')::timestamptz,
                         (select max((t.value #>> '{}')::timestamptz) from jsonb_array_elements(coalesce(p -> 'points_at', '[]'::jsonb)) as t(value)
                           where (t.value #>> '{}')::timestamptz between v_st and v_cap));
        v_wend := least(v_cap, greatest(coalesce((s ->> 'last_at')::timestamptz, v_st), coalesce(v_lp, v_st)));
      end if;
    else
      if v_ob is not null then
        v_wend := v_ob;
        v_obs := greatest(0, extract(epoch from least(v_now, v_cap) - v_ob));
      else
        v_wend := least(v_now, v_cap);
      end if;
    end if;
    v_ws := greatest(0, extract(epoch from v_wend - v_st) - v_bs);
    v_wsum := v_wsum + v_ws;
    v_bsum := v_bsum + v_bs + v_obs;
    v_first := coalesce(v_first, v_st);
    v_open := v_open or s ->> 'end' = 'open';
    v_last := s;
    v_list := v_list || jsonb_build_array(jsonb_build_object(
      'in', v_st, 'out', (s ->> 'out')::timestamptz, 'cap_at', v_cap,
      'breaks', coalesce(s -> 'breaks', '[]'::jsonb)
                || case when v_ob is not null then jsonb_build_array(jsonb_build_object('from', v_ob, 'to', null)) else '[]'::jsonb end,
      'worked_min', floor(v_ws / 60)::int, 'break_min', floor((v_bs + v_obs) / 60)::int,
      'open', s ->> 'end' = 'open', 'missed_out', s ->> 'end' = 'auto'));
  end loop;
  v_worked := floor(v_wsum / 60)::int;
  if v_last is not null then
    v_missed := v_last ->> 'end' = 'auto';
    v_lastout := case when v_last ->> 'end' = 'out' then (v_last ->> 'out')::timestamptz end;
  end if;

  if v_n > 0 then
    if not (v_flex or v_duty in ('field', 'leave', 'off') or not v_req) then
      v_late := greatest(0, floor(extract(epoch from v_first - (v_s0 + make_interval(mins => v_grace))) / 60))::int;
      if v_lastout is not null then
        v_early := greatest(0, floor(extract(epoch from v_s1 - v_lastout) / 60))::int;
      end if;
    end if;
    v_status := case when v_open then 'open'
                     when v_worked < v_half or v_hdl then 'half_day'
                     when v_late > 0 then 'late'
                     else 'present' end;
    if v_hdl then v_leave := 0.5; end if;
  elsif v_duty = 'leave' then
    v_status := 'leave'; v_leave := 1;
  elsif v_hdl then
    v_status := 'leave'; v_leave := 0.5;
    if (v_day < v_today or (v_day = v_today and v_now >= v_s1)) and not (v_tf is not null and v_day < v_tf) then
      v_absent := 0.5;
    end if;
  elsif v_duty = 'off' then
    v_status := 'off';
  elsif not v_req then
    v_status := 'not_tracked';
  elsif v_tf is not null and v_day < v_tf then
    v_status := 'not_tracked';
  elsif v_day > v_today
     or (v_day = v_today and (v_now < v_s0 + make_interval(mins => v_grace) or (v_flex and v_now < v_s1))) then
    v_status := 'not_in_yet';
  else
    v_status := 'absent'; v_absent := 1;
  end if;

  return jsonb_build_object(
    'day', v_day, 'duty', v_duty, 'holiday', p -> 'holiday', 'shift', v_sh, 'status', v_status, 'flex', v_flex,
    'first_in', v_first, 'last_out', v_lastout, 'worked_min', v_worked, 'break_min', floor(v_bsum / 60)::int,
    'late_min', v_late, 'early_min', v_early, 'missed_out', v_missed, 'irregular', v_irr,
    'worked_on_duty', case when v_n > 0 and v_duty in ('off', 'leave') then v_duty end,
    'half_day_leave', v_hdl, 'open', v_open, 'sessions', v_list,
    'km', coalesce(p -> 'km', '0'::jsonb), 'km_gaps', coalesce(p -> 'km_gaps', '0'::jsonb),
    'leave_units', v_leave, 'absent_units', v_absent);
end $$;
perform public._hr_lockdown();
end $hr$;

-- ── §3 part 5: day records for a range, the state now, tracking, visits ─────
do $hr$
begin
-- The day records of [p_from, p_to] for one person: one fold, one context
-- query, km per day (cache rules of §9.5.6). p_marks adds clock_marks (the
-- number of the day's punches whose time is not verified, or whose phone clock
-- was off by more than 5 minutes) — approvers only.
create or replace function public._hr_days(p_email text, p_from date, p_to date, p_now timestamptz, p_marks boolean default false)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  v_em text := lower(btrim(p_email));
  v_prof uuid;
  v_req boolean;
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  v_tf date;
  v_ev jsonb; f jsonb; c record;
  v_sess jsonb; v_orph jsonb; v_km jsonb; v_rec jsonb; v_marks int;
  v_out jsonb := '[]'::jsonb;
begin
  if p_to < p_from then return v_out; end if;
  select p.id into v_prof from public.profiles p where lower(p.email) = v_em order by p.active desc limit 1;
  v_req := coalesce((select hp.attendance_required from public.hr_person hp where hp.profile_id = v_prof), true);
  v_tf := greatest((select s.attendance_from from public.hr_settings s where s.id = 1),
                   (select (p.created_at at time zone 'Asia/Kolkata')::date from public.profiles p where p.id = v_prof));
  v_ev := public._hr_events(v_em, public._hr_at(p_from, '00:00') - make_interval(hours => v_h),
                            public._hr_at(p_to + 1, '00:00') + make_interval(hours => v_h));
  f := public._hr_fold(v_ev, v_h, p_now);
  for c in select * from public._hr_ctx(v_prof, v_em, p_from, p_to) loop
    select coalesce(jsonb_agg(case when s.value ->> 'end' = 'auto' and s.value ->> 'open_break' is null
                                   then s.value || jsonb_build_object('last_point_at',
                                          (select max(lp.at) from public.location_points lp
                                            where lower(lp.employee_email) = v_em
                                              and lp.at >= (s.value ->> 'start')::timestamptz
                                              and lp.at <= (s.value ->> 'cap')::timestamptz))
                                   else s.value end
                              order by (s.value ->> 'start')::timestamptz), '[]'::jsonb)
      into v_sess
      from jsonb_array_elements(f -> 'sessions') as s(value) where (s.value ->> 'day')::date = c.day;
    select coalesce(jsonb_agg(o.value), '[]'::jsonb) into v_orph
      from jsonb_array_elements(f -> 'orphans') as o(value) where (o.value ->> 'day')::date = c.day;
    v_km := public._hr_day_km(v_em, c.day, p_now, v_sess);
    v_rec := public._hr_day_calc(jsonb_build_object(
      'day', c.day, 'now', p_now, 'max_session_h', v_h,
      'shift', jsonb_build_object('start', to_char(c.shift_start, 'HH24:MI'), 'end', to_char(c.shift_end, 'HH24:MI'),
                                  'grace_min', c.grace_min, 'half_day_min', c.half_day_min, 'weekly_off', to_jsonb(c.weekly_off)),
      'duty', c.duty, 'holiday', c.holiday, 'attendance_required', v_req,
      'flex_request', c.flex_request, 'half_day_leave', c.half_day_leave, 'tracked_from', v_tf,
      'sessions', v_sess, 'orphans', v_orph, 'km', v_km -> 'km', 'km_gaps', v_km -> 'km_gaps'));
    v_rec := v_rec || jsonb_build_object('duty_source', c.duty_source, 'roster_note', c.duty_note);
    if p_marks then
      select count(*) into v_marks
        from jsonb_array_elements(v_ev) as e(value), jsonb_array_elements(v_sess) as s(value)
       where (e.value ->> 'at')::timestamptz >= (s.value ->> 'start')::timestamptz
         and (e.value ->> 'at')::timestamptz <= coalesce((s.value ->> 'out')::timestamptz, (s.value ->> 'cap')::timestamptz)
         and (e.value ->> 'ts' = 'device'
              or (e.value ->> 'ts' = 'server'
                  and abs(extract(epoch from (e.value ->> 'dev')::timestamptz - (e.value ->> 'at')::timestamptz)) > 300));
      v_rec := v_rec || jsonb_build_object('clock_marks', v_marks);
    end if;
    v_out := v_out || jsonb_build_array(v_rec);
  end loop;
  return v_out;
end $$;

-- The state now: {state, since, open (the open session or null), sessions,
-- orphans} — folded from max_session_h before today.
create or replace function public._hr_state(p_email text, p_now timestamptz)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  f jsonb;
begin
  f := public._hr_fold(public._hr_events(p_email, public._hr_at(public._hr_today(p_now), '00:00') - make_interval(hours => v_h),
                                         'infinity'::timestamptz), v_h, p_now);
  return jsonb_build_object('state', f ->> 'state', 'since', f -> 'since',
    'open', (select x.value from jsonb_array_elements(f -> 'sessions') as x(value)
              where x.value ->> 'end' = 'open' order by (x.value ->> 'start')::timestamptz desc limit 1),
    'sessions', f -> 'sessions', 'orphans', f -> 'orphans');
end $$;

-- §9.4.4 — what the phone needs to record (or not) the route.
create or replace function public._hr_tracking(p_email text, p_profile uuid, p_now timestamptz, p_state jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_set public.hr_settings;
  v_track boolean;
  v_open jsonb := nullif(p_state -> 'open', 'null'::jsonb);
  v_state text := p_state ->> 'state';
  v_d date;
  c record;
  v_on boolean;
  v_start timestamptz; v_cap timestamptz; v_send timestamptz;
begin
  select * into v_set from public.hr_settings where id = 1;
  v_track := coalesce((select hp.track_location from public.hr_person hp where hp.profile_id = p_profile), true);
  v_d := coalesce((v_open ->> 'day')::date, public._hr_today(p_now));
  select * into c from public._hr_ctx(p_profile, p_email, v_d, v_d);
  v_on := v_track and v_state = 'on_duty' and c.duty is distinct from 'wfh';
  if v_open is null or v_state = 'off_duty' then
    return jsonb_build_object('enabled', v_on,
      'reason', case when v_on then null when not v_track then 'disabled' when c.duty = 'wfh' then 'wfh'
                     when v_state = 'on_break' then 'on_break' else 'off_duty' end,
      'interval_s', v_set.track_interval_s, 'distance_m', v_set.track_distance_m,
      'session_start', null, 'cap_at', null, 'remind_out_at', null, 'pause_at', null);
  end if;
  v_start := (v_open ->> 'start')::timestamptz;
  v_cap := (v_open ->> 'cap')::timestamptz;
  v_send := public._hr_at(v_d, c.shift_end);
  return jsonb_build_object('enabled', v_on,
    'reason', case when v_on then null when not v_track then 'disabled' when c.duty = 'wfh' then 'wfh'
                   when v_state = 'on_break' then 'on_break' else 'off_duty' end,
    'interval_s', v_set.track_interval_s, 'distance_m', v_set.track_distance_m,
    'session_start', v_start, 'cap_at', v_cap,
    'remind_out_at', case when v_start < v_send + interval '30 minutes' then v_send + interval '30 minutes' end,
    'pause_at', least(v_cap, greatest(v_send, v_start) + interval '4 hours'));
end $$;

-- §9.6.6 — on site: assignee of a job at stage on_site, whose latest applied
-- 'arrived' for it is at or after p_since (the session's punch_in), with no
-- later 'departed' of theirs. → {job_id, code, title, since} or null.
create or replace function public._hr_on_site(p_email text, p_since timestamptz)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('job_id', j.id, 'code', j.public_code,
                            'title', coalesce(nullif(btrim(coalesce(j.device_label, '')), ''), public._svc_category_label(j.category)),
                            'since', a.at)
    from public.service_jobs j
    cross join lateral (select max(fa.at) as at from public.field_activity fa
                         where fa.ref_type = 'service_job' and fa.ref_id = j.id and fa.kind = 'arrived'
                           and fa.applied and lower(fa.employee_email) = lower(p_email)) a
   where lower(j.assignee_email) = lower(p_email) and j.stage = 'on_site'
     and a.at is not null and a.at >= p_since
     and not exists (select 1 from public.field_activity d
                      where d.ref_type = 'service_job' and d.ref_id = j.id and d.kind = 'departed'
                        and lower(d.employee_email) = lower(p_email) and d.at > a.at)
   order by a.at desc
   limit 1
$$;

-- §9.6.6 — the on-site visits of a day, from the person's applied field
-- activity: each arrived pairs with the next departed of the same job.
create or replace function public._hr_visits(p_email text, p_day date, p_now timestamptz, p_sessions jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_lo timestamptz := public._hr_at(p_day, '00:00');
  v_hi timestamptz := public._hr_at(p_day + 1, '00:00');
  v_end timestamptz;
  r record;
  v_job text; v_left timestamptz; v_arr timestamptz; v_travel int; v_lim timestamptz;
  v_out jsonb := '[]'::jsonb;
begin
  select max(case when s.value ->> 'end' = 'out' then (s.value ->> 'out')::timestamptz
                  when s.value ->> 'end' = 'open' then (s.value ->> 'cap')::timestamptz
                  else (s.value ->> 'cap')::timestamptz end)
    into v_end from jsonb_array_elements(coalesce(p_sessions, '[]'::jsonb)) as s(value);
  v_hi := greatest(v_hi, coalesce(v_end, v_hi));
  for r in
    select fa.ref_id, fa.kind, fa.at, fa.outcome
      from public.field_activity fa
     where lower(fa.employee_email) = lower(p_email) and fa.applied and fa.ref_type = 'service_job'
       and fa.ref_id is not null and fa.kind in ('left_base', 'arrived', 'departed')
       and fa.at >= v_lo and fa.at < v_hi
     order by fa.ref_id, fa.at, fa.received_at, fa.id
  loop
    if v_job is distinct from r.ref_id then
      if v_arr is not null then
        select least(p_now, coalesce((s.value ->> 'out')::timestamptz, (s.value ->> 'cap')::timestamptz)) into v_lim
          from jsonb_array_elements(coalesce(p_sessions, '[]'::jsonb)) as s(value)
         where (s.value ->> 'start')::timestamptz <= v_arr
           and v_arr <= coalesce((s.value ->> 'out')::timestamptz, (s.value ->> 'cap')::timestamptz) limit 1;
        v_out := v_out || jsonb_build_array(jsonb_build_object('job_id', v_job, 'arrived', v_arr, 'departed', null,
          'minutes', greatest(0, floor(extract(epoch from coalesce(v_lim, p_now) - v_arr) / 60))::int, 'travel_min', v_travel,
          'outcome', null, 'assumed_arrival', false, 'open', true));
      end if;
      v_job := r.ref_id; v_left := null; v_arr := null; v_travel := null; v_lim := null;
    end if;
    if r.kind = 'left_base' then
      v_left := r.at;
    elsif r.kind = 'arrived' then
      if v_arr is not null then
        v_out := v_out || jsonb_build_array(jsonb_build_object('job_id', v_job, 'arrived', v_arr, 'departed', null,
          'minutes', null, 'travel_min', v_travel, 'outcome', null, 'assumed_arrival', false, 'open', false));
      end if;
      v_arr := r.at;
      v_travel := case when v_left is not null then floor(extract(epoch from r.at - v_left) / 60)::int end;
    elsif v_arr is not null then
      v_out := v_out || jsonb_build_array(jsonb_build_object('job_id', v_job, 'arrived', v_arr, 'departed', r.at,
        'minutes', floor(extract(epoch from r.at - v_arr) / 60)::int, 'travel_min', v_travel, 'outcome', r.outcome,
        'assumed_arrival', false, 'open', false));
      v_arr := null; v_travel := null;
    else
      v_out := v_out || jsonb_build_array(jsonb_build_object('job_id', v_job, 'arrived', null, 'departed', r.at,
        'minutes', null, 'travel_min', null, 'outcome', r.outcome, 'assumed_arrival', true, 'open', false));
    end if;
  end loop;
  if v_arr is not null then
    select least(p_now, coalesce((s.value ->> 'out')::timestamptz, (s.value ->> 'cap')::timestamptz)) into v_lim
      from jsonb_array_elements(coalesce(p_sessions, '[]'::jsonb)) as s(value)
     where (s.value ->> 'start')::timestamptz <= v_arr
       and v_arr <= coalesce((s.value ->> 'out')::timestamptz, (s.value ->> 'cap')::timestamptz) limit 1;
    v_out := v_out || jsonb_build_array(jsonb_build_object('job_id', v_job, 'arrived', v_arr, 'departed', null,
      'minutes', greatest(0, floor(extract(epoch from coalesce(v_lim, p_now) - v_arr) / 60))::int, 'travel_min', v_travel,
      'outcome', null, 'assumed_arrival', false, 'open', true));
  end if;
  return coalesce((
    select jsonb_agg(v.value || jsonb_build_object('code', j.public_code,
                       'title', coalesce(nullif(btrim(coalesce(j.device_label, '')), ''), public._svc_category_label(j.category)),
                       'site_area', j.site_area)
                     order by coalesce((v.value ->> 'arrived')::timestamptz, (v.value ->> 'departed')::timestamptz))
      from jsonb_array_elements(v_out) as v(value)
      left join public.service_jobs j on j.id = v.value ->> 'job_id'), '[]'::jsonb);
end $$;
perform public._hr_lockdown();
end $hr$;

-- ── §3 part 6: live status, the two-sided check, punching ───────────────────
do $hr$
begin
-- §9.6.6 — one person on the board (and in hr_dashboard's counts). Before
-- attendance_from (or before the person's account existed) a day with no
-- session is not_tracked, as in the day record (_hr_days' tracked_from).
create or replace function public._hr_live(p_prof public.profiles, p_now timestamptz)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  v_em text := lower(p_prof.email);
  v_today date := public._hr_today(p_now);
  v_tf date := greatest((select s.attendance_from from public.hr_settings s where s.id = 1),
                        (p_prof.created_at at time zone 'Asia/Kolkata')::date);
  st jsonb; v_open jsonb; c record; v_req boolean; v_rec jsonb; v_tr jsonb; v_os jsonb; v_closed jsonb;
  v_status text; v_since timestamptz; v_lp timestamptz; v_stale boolean := false;
begin
  st := public._hr_state(v_em, p_now);
  v_open := nullif(st -> 'open', 'null'::jsonb);
  select * into c from public._hr_ctx(p_prof.id, v_em, v_today, v_today);
  v_req := coalesce((select hp.attendance_required from public.hr_person hp where hp.profile_id = p_prof.id), true);
  v_rec := public._hr_days(v_em, coalesce((v_open ->> 'day')::date, v_today), coalesce((v_open ->> 'day')::date, v_today), p_now, true) -> 0;
  v_tr := public._hr_tracking(v_em, p_prof.id, p_now, st);
  if v_open is not null then
    if st ->> 'state' = 'on_break' then
      v_status := 'on_break'; v_since := (st ->> 'since')::timestamptz;
    else
      v_os := public._hr_on_site(v_em, (v_open ->> 'start')::timestamptz);
      if v_os is not null then
        v_status := 'on_site'; v_since := (v_os ->> 'since')::timestamptz;
      else
        v_status := 'on_duty'; v_since := (st ->> 'since')::timestamptz;
      end if;
    end if;
    select max(lp.at) into v_lp from public.location_points lp
     where lower(lp.employee_email) = v_em and lp.at >= (v_open ->> 'start')::timestamptz;
    v_stale := v_status in ('on_duty', 'on_site') and coalesce((v_tr ->> 'enabled')::boolean, false)
               and p_now - coalesce(v_lp, (v_open ->> 'start')::timestamptz) > interval '15 minutes';
  elsif c.duty = 'off' then
    v_status := 'off';
  elsif c.duty = 'leave' then
    v_status := 'on_leave';
  else
    select x.value into v_closed from jsonb_array_elements(st -> 'sessions') as x(value)
     where (x.value ->> 'day')::date = v_today and x.value ->> 'end' in ('out', 'auto')
     order by (x.value ->> 'start')::timestamptz desc limit 1;
    if v_closed is not null then
      v_status := 'off_duty';
      v_since := coalesce((v_closed ->> 'out')::timestamptz, (v_closed ->> 'cap')::timestamptz);
    elsif not v_req or (v_tf is not null and v_today < v_tf) then
      v_status := 'not_tracked';
    elsif p_now < public._hr_at(v_today, c.shift_start) + make_interval(mins => c.grace_min)
       or ((c.duty = 'field' or c.flex_request or c.half_day_leave) and p_now < public._hr_at(v_today, c.shift_end)) then
      v_status := 'not_in_yet';
    else
      v_status := 'absent';
    end if;
  end if;
  if v_lp is null then
    select max(lp.at) into v_lp from public.location_points lp where lower(lp.employee_email) = v_em;
  end if;
  return jsonb_build_object('email', v_em, 'name', p_prof.full_name, 'designation', p_prof.designation,
    'status', v_status, 'since', v_since, 'state', st ->> 'state', 'duty', c.duty, 'holiday', c.holiday,
    'shift', jsonb_build_object('start', to_char(c.shift_start, 'HH24:MI'), 'end', to_char(c.shift_end, 'HH24:MI')),
    'first_in', v_rec -> 'first_in', 'worked_min', coalesce(v_rec -> 'worked_min', '0'::jsonb),
    'break_min', coalesce(v_rec -> 'break_min', '0'::jsonb), 'missed_out', coalesce(v_rec -> 'missed_out', 'false'::jsonb),
    'flex', coalesce(v_rec -> 'flex', 'false'::jsonb), 'late_min', coalesce(v_rec -> 'late_min', '0'::jsonb),
    'km', coalesce(v_rec -> 'km', '0'::jsonb), 'on_site', v_os, 'last_point_at', v_lp, 'stale', v_stale,
    'tracking', coalesce((v_tr ->> 'enabled')::boolean, false), 'attendance_required', v_req,
    'clock_marks', coalesce(v_rec -> 'clock_marks', '0'::jsonb));
end $$;

-- §9.4.2 — the sentence (no prefix) for a punch of kind p_kind at p_at that
-- the state before it (p_before) does not allow; p_auto_cap = the cap of a
-- session the server closed just before it.
create or replace function public._hr_seq_sentence(p_kind text, p_before text, p_auto_cap timestamptz, p_at timestamptz)
returns text language sql immutable set search_path = public as $$
  select case p_kind
           when 'punch_in' then 'You''re already punched in.'
           when 'break_start' then case when p_before = 'on_break' then 'You''re already on a break.' else 'Punch in first.' end
           when 'break_end' then 'You''re not on a break.'
           else case when p_auto_cap is not null and p_at > p_auto_cap
                     then 'That shift was closed automatically — ask HR to add your punch-out.'
                     else 'You''re not punched in.' end
         end
$$;

-- §9.4.2 — the two-sided check for adding kind p_kind at p_at (id p_id,
-- received now): hr_punch and the legacy record_field_activity punch.
-- Returns null when it fits, else the sentence (no prefix).
create or replace function public._hr_check_add(p_email text, p_id uuid, p_kind text, p_at timestamptz)
returns text language plpgsql stable set search_path = public as $$
declare
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  v_rcv timestamptz := now();
  v_ev jsonb; v_next jsonb; f jsonb; pr jsonb;
begin
  v_ev := public._hr_events(p_email, p_at - make_interval(hours => 2 * v_h), p_at + make_interval(hours => v_h));
  select jsonb_build_object('id', e.id, 'kind', e.kind, 'at', e.at, 'rcv', e.received_at) into v_next
    from public.attendance_events e
   where lower(e.employee_email) = lower(btrim(p_email)) and e.voided_at is null
     and (e.at, e.received_at, e.id) > (p_at, v_rcv, p_id)
   order by e.at, e.received_at, e.id
   limit 1;
  if v_next is not null and not exists (select 1 from jsonb_array_elements(v_ev) as x(value) where x.value ->> 'id' = v_next ->> 'id') then
    v_ev := v_ev || jsonb_build_array(v_next);
  end if;
  v_ev := v_ev || jsonb_build_array(jsonb_build_object('id', p_id, 'kind', p_kind, 'at', p_at, 'rcv', v_rcv));
  f := public._hr_fold(v_ev, v_h, now(), p_id::text);
  pr := f -> 'probe';
  if not coalesce((pr ->> 'ok')::boolean, false) then
    return public._hr_seq_sentence(p_kind, pr ->> 'before', (pr ->> 'auto_cap')::timestamptz, p_at);
  end if;
  if pr ->> 'next_id' is not null and not (pr ->> 'next_ok')::boolean then
    return 'That doesn''t fit the day''s punches.';
  end if;
  return null;
end $$;

-- §9.4.2 as amended for HR corrections — a set of changes to one person's
-- punches, checked together: void the events p_void and add p_add
-- ([{id, kind, at}], received now). The changes fit when the fold of the
-- punches after them (1) takes every added punch and (2) skips no punch that
-- the fold took before them — nothing new is irregular (a punch that was
-- already skipped may stay skipped). Both folds read the same window: from
-- 2 × max_session_h before the earliest change (the state there) to 2 ×
-- max_session_h after the latest one (a difference the changes make shows as
-- a punch taken or skipped within max_session_h of them, or not at all).
-- So "remove this accidental out–in pair", "replace this punch" and "add the
-- forgotten punch-out, void the later one" are each ONE correction.
-- Returns null when they fit, else the sentence (no prefix).
create or replace function public._hr_check_ops(p_email text, p_void uuid[], p_add jsonb)
returns text language plpgsql stable set search_path = public as $$
declare
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  v_rcv timestamptz := now();
  v_void uuid[] := coalesce(p_void, '{}');
  v_add jsonb := coalesce(p_add, '[]'::jsonb);
  v_lo timestamptz; v_hi timestamptz;
  v_ev jsonb; v_new jsonb; b jsonb; a jsonb; pr jsonb; v_bad jsonb;
begin
  select min(x.t), max(x.t) into v_lo, v_hi
    from (select e.at as t from public.attendance_events e where e.id = any (v_void)
          union all
          select (o.value ->> 'at')::timestamptz from jsonb_array_elements(v_add) as o(value)) x;
  if v_lo is null then return null; end if;
  v_ev := public._hr_events(p_email, v_lo - make_interval(hours => 2 * v_h), v_hi + make_interval(hours => 2 * v_h));
  b := public._hr_fold(v_ev, v_h, now());
  select coalesce(jsonb_agg(x.value), '[]'::jsonb) into v_new
    from jsonb_array_elements(v_ev) as x(value) where not ((x.value ->> 'id')::uuid = any (v_void));
  select v_new || coalesce(jsonb_agg(jsonb_build_object('id', o.value ->> 'id', 'kind', o.value ->> 'kind',
                                                        'at', (o.value ->> 'at')::timestamptz, 'rcv', v_rcv)), '[]'::jsonb)
    into v_new
    from jsonb_array_elements(v_add) as o(value);
  a := public._hr_fold(v_new, v_h, now());
  -- 1. every added punch is taken (the earliest one that is not decides the sentence)
  select o.value into v_bad
    from jsonb_array_elements(v_add) as o(value)
   where (a -> 'skipped') ? (o.value ->> 'id')
   order by (o.value ->> 'at')::timestamptz, o.value ->> 'id'
   limit 1;
  if v_bad is not null then
    pr := public._hr_fold(v_new, v_h, now(), v_bad ->> 'id') -> 'probe';
    return public._hr_seq_sentence(v_bad ->> 'kind', pr ->> 'before', (pr ->> 'auto_cap')::timestamptz, (v_bad ->> 'at')::timestamptz);
  end if;
  -- 2. nothing the fold took before is skipped now
  if exists (select 1 from jsonb_array_elements_text(a -> 'skipped') as s(id) where not ((b -> 'skipped') ? s.id)) then
    return case when jsonb_array_length(v_add) = 0
                then 'Voiding that breaks the order of the day''s punches — fix the matching punch too.'
                else 'That doesn''t fit the day''s punches.' end;
  end if;
  return null;
end $$;
drop function if exists public._hr_check_void(public.attendance_events);

-- The shop day of the session an instant belongs to (else its own India day).
create or replace function public._hr_session_day(p_email text, p_at timestamptz)
returns date language plpgsql stable set search_path = public as $$
declare
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  v_d date;
begin
  select (x.value ->> 'day')::date into v_d
    from jsonb_array_elements(public._hr_fold(public._hr_events(p_email, p_at - make_interval(hours => 2 * v_h), p_at),
                                              v_h, now()) -> 'sessions') as x(value)
   where (x.value ->> 'start')::timestamptz <= p_at
     and p_at <= coalesce((x.value ->> 'out')::timestamptz, (x.value ->> 'cap')::timestamptz)
   order by (x.value ->> 'start')::timestamptz desc
   limit 1;
  return coalesce(v_d, (p_at at time zone 'Asia/Kolkata')::date);
end $$;

-- hr_punch's answer: the CURRENT state, the day record of the event's session
-- day, and the tracking object.
create or replace function public._hr_punch_answer(p_ev public.attendance_events, p_dup boolean)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  v_now timestamptz := now();
  v_em text := lower(p_ev.employee_email);
  v_prof uuid := (select p.id from public.profiles p where lower(p.email) = v_em order by p.active desc limit 1);
  st jsonb; v_d date; v_out jsonb;
begin
  st := public._hr_state(v_em, v_now);
  v_d := case when p_ev.voided_at is null then public._hr_session_day(v_em, p_ev.at)
              else (p_ev.at at time zone 'Asia/Kolkata')::date end;
  v_out := jsonb_build_object('ok', p_ev.voided_at is null, 'duplicate', p_dup, 'now', v_now, 'id', p_ev.id,
                              'state', st ->> 'state', 'since', st -> 'since',
                              'day', public._hr_days(v_em, v_d, v_d, v_now) -> 0,
                              'tracking', public._hr_tracking(v_em, v_prof, v_now, st));
  if p_ev.voided_at is not null then v_out := v_out || jsonb_build_object('voided', true); end if;
  return v_out;
end $$;

-- §9.4.2 / §9.4.3 — one punch for p_email, shared by hr_punch and the legacy
-- record_field_activity: lock, id (replay / someone else's), fields, time
-- anchoring (§9.3.3), the two-sided check, insert.
create or replace function public._hr_punch_apply(p_email text, p_id uuid, p_kind text, p_at timestamptz, p_age_ms numeric,
                                                  p_lat double precision, p_lng double precision, p_acc double precision, p_note text)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  v_em text := lower(btrim(p_email));
  v_ev public.attendance_events;
  v_at timestamptz; v_dev timestamptz; v_src text; v_msg text;
begin
  perform pg_advisory_xact_lock(hashtext('neo_hr_att:' || v_em));
  select * into v_ev from public.attendance_events where id = p_id;
  if found then
    if v_ev.employee_email <> v_em then raise exception 'NEO_GATE: That punch id is already used.'; end if;
    return public._hr_punch_answer(v_ev, true);
  end if;
  if p_kind is null or p_kind not in ('punch_in', 'punch_out', 'break_start', 'break_end') then
    raise exception 'NEO_GATE: Say what you''re punching: punch_in, punch_out, break_start or break_end.';
  end if;
  if p_age_ms is not null and p_age_ms >= 0 and p_age_ms <= 604800000 then
    v_at := now() - p_age_ms * interval '1 millisecond'; v_dev := p_at; v_src := 'server';
  elsif p_at is null then
    v_at := now(); v_dev := null; v_src := 'server';
  else
    if p_at < timestamptz '2020-01-01 00:00:00+00' or p_at > now() + interval '10 minutes' then
      raise exception 'NEO_GATE: The phone''s clock is wrong — turn on automatic date and time, then punch again.';
    end if;
    v_at := p_at; v_dev := p_at; v_src := 'device';
  end if;
  v_msg := public._hr_check_add(v_em, p_id, p_kind, v_at);
  if v_msg is not null then raise exception 'NEO_GATE: %', v_msg; end if;
  insert into public.attendance_events (id, profile_id, employee_email, kind, at, device_at, time_source,
                                        lat, lng, accuracy_m, source, note, created_by_email)
  values (p_id, (select p.id from public.profiles p where lower(p.email) = v_em order by p.active desc limit 1), v_em,
          p_kind, v_at, v_dev, v_src, p_lat, p_lng, p_acc, 'phone', p_note, v_em)
  returning * into v_ev;
  perform public._hr_invalidate(v_em, v_at);
  return public._hr_punch_answer(v_ev, false);
end $$;
perform public._hr_lockdown();
end $hr$;

-- ── §3 part 7: requests, settings, travel allowance, retention ──────────────
do $hr$
begin
create or replace function public._hr_req_json(r public.hr_requests)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('id', r.id, 'email', r.employee_email,
    'name', (select p.full_name from public.profiles p where lower(p.email) = r.employee_email order by p.active desc limit 1),
    'kind', r.kind, 'date_from', r.date_from, 'date_to', r.date_to, 'half_day', r.half_day, 'leave_type', r.leave_type,
    'reason', r.reason, 'ref_code', r.ref_code, 'missed_at', r.missed_at, 'missed_kind', r.missed_kind, 'status', r.status,
    'decided_by_name', r.decided_by_name, 'decided_at', r.decided_at, 'decision_note', r.decision_note,
    'cancelled_by_name', r.cancelled_by_name, 'cancelled_at', r.cancelled_at, 'cancel_note', r.cancel_note,
    'created_at', r.created_at)
$$;

-- A whole number in [lo, hi] or `NEO_GATE: <Label> must be between lo and hi.`
create or replace function public._hr_int(p jsonb, k text, p_label text, lo int, hi int)
returns int language plpgsql stable set search_path = public as $$
declare v numeric;
begin
  begin
    v := public._jnum(p, k, p_label);
  exception when others then v := null;
  end;
  if v is null or v <> trunc(v) or v < lo or v > hi then
    raise exception 'NEO_GATE: % must be between % and %.', p_label, lo, hi;
  end if;
  return v::int;
end $$;

-- A clock time like 09:30.
create or replace function public._hr_time(p jsonb, k text, p_label text)
returns time language plpgsql stable set search_path = public as $$
declare v text := public._jtxt(p, k, 8, p_label);
begin
  if v is null then return null; end if;
  if v !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then
    raise exception 'NEO_GATE: % must be a time like 09:30.', p_label;
  end if;
  return v::time;
end $$;

-- Weekly off days: 0 (Sunday) … 6 (Saturday), each at most once.
create or replace function public._hr_weekly(p jsonb, k text)
returns int[] language plpgsql stable set search_path = public as $$
declare v jsonb := p -> k; e jsonb; v_out int[] := '{}';
begin
  if v is null or jsonb_typeof(v) = 'null' then return null; end if;
  if jsonb_typeof(v) <> 'array' then
    raise exception 'NEO_GATE: Weekly off days are 0 (Sunday) to 6 (Saturday), each at most once.';
  end if;
  for e in select x.value from jsonb_array_elements(v) as x(value) loop
    if jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[0-6]$' or ((e #>> '{}')::int = any (v_out)) then
      raise exception 'NEO_GATE: Weekly off days are 0 (Sunday) to 6 (Saturday), each at most once.';
    end if;
    v_out := v_out || (e #>> '{}')::int;
  end loop;
  return (select coalesce(array_agg(x order by x), '{}') from unnest(v_out) as x);
end $$;

-- §9.4.6 — write a shift change (any of shift_start, shift_end, grace_min,
-- weekly_off, half_day_min) into hr_shift_history from effective_from
-- (default tomorrow, never before today) and refresh the display copies from
-- the row in force today (not the newest row, which may start later).
-- p_profile null = the default row. In a person's row a key given as null
-- stores null (that field then falls back to the default).
create or replace function public._hr_shift_write(p_profile uuid, p jsonb, p_by text)
returns date language plpgsql volatile set search_path = public as $$
declare
  v_today date := public._hr_today(now());
  v_eff date;
  b public.hr_shift_history;
  v_cur public.hr_shift_history;
  v_start time; v_end time; v_grace int; v_week int[]; v_half int;
  v_next date; v_bad date; v_who text;
begin
  if not (p ?| array['shift_start', 'shift_end', 'grace_min', 'weekly_off', 'half_day_min']) then return null; end if;
  v_eff := coalesce(public._jdate(p, 'effective_from', 'Effective from'), v_today + 1);
  if v_eff < v_today then raise exception 'NEO_GATE: Changes apply from today onwards.'; end if;
  select * into b from public.hr_shift_history x
   where x.profile_id is not distinct from p_profile and x.effective_from <= v_eff
   order by x.effective_from desc limit 1;
  v_start := b.shift_start; v_end := b.shift_end; v_grace := b.grace_min; v_week := b.weekly_off; v_half := b.half_day_min;
  if p ? 'shift_start' then v_start := public._hr_time(p, 'shift_start', 'Shift start'); end if;
  if p ? 'shift_end' then v_end := public._hr_time(p, 'shift_end', 'Shift end'); end if;
  if p ? 'grace_min' then
    v_grace := case when jsonb_typeof(p -> 'grace_min') = 'null' and p_profile is not null then null
                    else public._hr_int(p, 'grace_min', 'Grace', 0, 120) end;
  end if;
  if p ? 'half_day_min' then
    v_half := case when jsonb_typeof(p -> 'half_day_min') = 'null' and p_profile is not null then null
                   else public._hr_int(p, 'half_day_min', 'Half-day threshold', 60, 600) end;
  end if;
  if p ? 'weekly_off' then
    v_week := public._hr_weekly(p, 'weekly_off');
    if v_week is null and p_profile is null then
      raise exception 'NEO_GATE: Weekly off days are 0 (Sunday) to 6 (Saturday), each at most once.';
    end if;
  end if;
  if p_profile is null and (v_start is null or v_end is null or v_end <= v_start) then
    raise exception 'NEO_GATE: The shift must end after it starts.';
  end if;
  if p_profile is null then
    -- every later default row must still end after it starts
    if exists (select 1 from public.hr_shift_history x where x.profile_id is null and x.effective_from > v_eff
                 and x.shift_end <= x.shift_start) then
      raise exception 'NEO_GATE: The shift must end after it starts.';
    end if;
    -- …and so must the shift of everyone whose own row takes a start or an end
    -- from this one: every person row in effect on some day from v_eff until
    -- the next default row
    select min(x.effective_from) into v_next from public.hr_shift_history x
     where x.profile_id is null and x.effective_from > v_eff;
    select coalesce(nullif(btrim(pr.full_name), ''), pr.email) into v_who
      from public.hr_shift_history ph
      join public.profiles pr on pr.id = ph.profile_id
     where ph.profile_id is not null
       and (v_next is null or ph.effective_from < v_next)
       and ph.effective_from >= coalesce((select max(p2.effective_from) from public.hr_shift_history p2
                                           where p2.profile_id = ph.profile_id and p2.effective_from <= v_eff), '-infinity'::date)
       and coalesce(ph.shift_end, v_end) <= coalesce(ph.shift_start, v_start)
     order by pr.full_name, pr.email
     limit 1;
    if v_who is not null then
      raise exception 'NEO_GATE: The shift must end after it starts — with %''s own start or end time it would not. Change theirs first.', v_who;
    end if;
  else
    -- the person's shift on every day this row is in effect (until their next
    -- row): its null fields come from the default row of that day — the one at
    -- v_eff and every later one
    select min(x.effective_from) into v_next from public.hr_shift_history x
     where x.profile_id = p_profile and x.effective_from > v_eff;
    select x.effective_from into v_bad from public.hr_shift_history x
     where x.profile_id is null
       and x.effective_from >= coalesce((select max(d2.effective_from) from public.hr_shift_history d2
                                          where d2.profile_id is null and d2.effective_from <= v_eff), '-infinity'::date)
       and (v_next is null or x.effective_from < v_next)
       and coalesce(v_end, x.shift_end) <= coalesce(v_start, x.shift_start)
     order by x.effective_from
     limit 1;
    if found then
      if v_bad <= v_eff then raise exception 'NEO_GATE: The shift must end after it starts.'; end if;
      raise exception 'NEO_GATE: The shift must end after it starts — from % (the default shift changes then) it would not.',
        to_char(v_bad, 'DD Mon YYYY');
    end if;
  end if;
  insert into public.hr_shift_history as h (profile_id, effective_from, shift_start, shift_end, grace_min, weekly_off, half_day_min, set_by_email, set_at)
  values (p_profile, v_eff, v_start, v_end, v_grace, v_week, v_half, p_by, now())
  on conflict ((coalesce(profile_id, '00000000-0000-0000-0000-000000000000'::uuid)), effective_from) do update
    set shift_start = excluded.shift_start, shift_end = excluded.shift_end, grace_min = excluded.grace_min,
        weekly_off = excluded.weekly_off, half_day_min = excluded.half_day_min,
        set_by_email = excluded.set_by_email, set_at = excluded.set_at;
  -- §9.3.1 — the display copies are the row IN FORCE TODAY (India), the
  -- greatest effective_from <= today; never a row that only starts later (a
  -- change for tomorrow shows in the history, not as today's hours).
  select h.* into v_cur from public.hr_shift_history h
   where h.profile_id is not distinct from p_profile and h.effective_from <= v_today
   order by h.effective_from desc limit 1;
  if p_profile is null then
    -- (there is always one: the seed row from 2020-01-01)
    if v_cur.id is not null then
      update public.hr_settings s
         set shift_start = v_cur.shift_start, shift_end = v_cur.shift_end, grace_min = v_cur.grace_min,
             weekly_off = v_cur.weekly_off, half_day_min = v_cur.half_day_min
       where s.id = 1;
    end if;
  else
    insert into public.hr_person (profile_id) values (p_profile) on conflict do nothing;
    -- no own row in force today → empty copies (today follows the default)
    update public.hr_person hp
       set shift_start = v_cur.shift_start, shift_end = v_cur.shift_end, weekly_off = v_cur.weekly_off
     where hp.profile_id = p_profile;
  end if;
  return v_eff;
end $$;

-- The km of a person's month (the sum of the day km values, §9.5.3 g):
-- → {days:[{day, km}] (days with km), km}. Only days up to today.
create or replace function public._hr_month_km(p_email text, p_month date, p_now timestamptz)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  v_em text := lower(btrim(p_email));
  v_from date := date_trunc('month', p_month)::date;
  v_to date := least((date_trunc('month', p_month) + interval '1 month')::date - 1, public._hr_today(p_now));
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  f jsonb; v_day date; v_sess jsonb; v_km numeric; v_days jsonb := '[]'::jsonb; v_sum numeric := 0;
begin
  if v_to < v_from then return jsonb_build_object('days', v_days, 'km', 0); end if;
  f := public._hr_fold(public._hr_events(v_em, public._hr_at(v_from, '00:00') - make_interval(hours => v_h),
                                         public._hr_at(v_to + 1, '00:00') + make_interval(hours => v_h)), v_h, p_now);
  for v_day in select g::date from generate_series(v_from, v_to, interval '1 day') as g loop
    select coalesce(jsonb_agg(x.value order by (x.value ->> 'start')::timestamptz), '[]'::jsonb) into v_sess
      from jsonb_array_elements(f -> 'sessions') as x(value) where (x.value ->> 'day')::date = v_day;
    v_km := (public._hr_day_km(v_em, v_day, p_now, v_sess) ->> 'km')::numeric;
    if v_km > 0 then
      v_days := v_days || jsonb_build_array(jsonb_build_object('day', v_day, 'km', v_km));
      v_sum := v_sum + v_km;
    end if;
  end loop;
  return jsonb_build_object('days', v_days, 'km', v_sum);
end $$;

-- Does p_day (India) hold a punch_in of the person (non-voided)? Only such a
-- day can have a session — and so a km a point may count towards.
create or replace function public._hr_has_in(p_em text, p_day date)
returns boolean language sql stable set search_path = public as $$
  select exists (select 1 from public.attendance_events e
                  where lower(e.employee_email) = p_em and e.kind = 'punch_in' and e.voided_at is null
                    and e.at >= public._hr_at(p_day, '00:00') and e.at < public._hr_at(p_day + 1, '00:00'))
$$;

-- §9.8 — retention. Cutoff = today (India) − retention_days.
--  1) A point may belong to the session of its India day or of the day before
--     (a session may run past midnight): every such (person, day) before the
--     cutoff that holds a punch_in gets a FINAL hr_day_km row from _hr_track.
--     A day without one has no session to keep a km for, and is never tracked.
--  2) A point goes once each of its two days is final or holds no punch_in,
--     in batches of 5000.
--  3) Punch coordinates before the cutoff are nulled — in attendance_events
--     and in the pre-v2.3 punch rows field_activity still holds.
--  4) last_purge_at is set only when nothing older than the cutoff is left.
-- p_max_rows given (location_push's fallback, inside a phone's request): only
-- the oldest p_max_rows expired points are looked at, at most 20 of their
-- days are made final (oldest first) and only those points are deleted — a
-- bounded amount of work per call, and every call's work stays done (a final
-- row is never recomputed, a deleted point never comes back), so a backlog
-- shrinks call after call. Without it (the cron): everything, in one go.
-- Final rows are written in (email, day) order, the order readers cache in.
create or replace function public._hr_purge(p_max_rows int default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_set public.hr_settings;
  v_cut date;
  v_cut_ts timestamptz;
  v_scan int := case when p_max_rows is null then null else greatest(p_max_rows, 1) end;
  v_days int := case when p_max_rows is null then null else 20 end;
  r record;
  v_t jsonb;
  v_n int := 0;
  v_k int;
  v_finals int := 0;
  v_left boolean;
begin
  select * into v_set from public.hr_settings where id = 1;
  v_cut := public._hr_today(now()) - v_set.retention_days;
  v_cut_ts := public._hr_at(v_cut, '00:00');
  -- 1. final km rows
  for r in
    select c.em, c.day from (
      select d.em, d.day
        from (select distinct x.em, y.day
                from (select lower(lp.employee_email) as em, (lp.at at time zone 'Asia/Kolkata')::date as d
                        from public.location_points lp
                       where lp.at < v_cut_ts
                       order by lp.at
                       limit v_scan) x
                cross join lateral (values (x.d), (x.d - 1)) as y(day)) d
       where not exists (select 1 from public.hr_day_km h where h.employee_email = d.em and h.day = d.day and h.final)
         and public._hr_has_in(d.em, d.day)
       order by d.day, d.em
       limit v_days) c
     order by c.em, c.day
  loop
    v_t := public._hr_track(r.em, r.day);
    insert into public.hr_day_km as h (profile_id, employee_email, day, km, km_gaps, points, final, computed_at)
    values ((select p.id from public.profiles p where lower(p.email) = r.em order by p.active desc limit 1), r.em, r.day,
            coalesce((v_t ->> 'km')::numeric, 0), coalesce((v_t ->> 'km_gaps')::int, 0), coalesce((v_t ->> 'points')::int, 0),
            true, now())
    on conflict (employee_email, day) do update
      set km = excluded.km, km_gaps = excluded.km_gaps, points = excluded.points, final = true, computed_at = excluded.computed_at
      where not h.final;
    v_finals := v_finals + 1;
  end loop;
  -- 2. the points each of whose two days is final or holds no punch_in
  loop
    delete from public.location_points
     where id in (select x.id
                    from (select lp.id, lower(lp.employee_email) as em, (lp.at at time zone 'Asia/Kolkata')::date as d
                            from public.location_points lp
                           where lp.at < v_cut_ts
                           order by lp.at
                           limit coalesce(v_scan, 5000)) x
                   where (exists (select 1 from public.hr_day_km h where h.employee_email = x.em and h.day = x.d and h.final)
                          or not public._hr_has_in(x.em, x.d))
                     and (exists (select 1 from public.hr_day_km h where h.employee_email = x.em and h.day = x.d - 1 and h.final)
                          or not public._hr_has_in(x.em, x.d - 1)));
    get diagnostics v_k = row_count;
    v_n := v_n + v_k;
    exit when p_max_rows is not null or v_k < 5000;
  end loop;
  -- 3. punch coordinates
  update public.attendance_events
     set lat = null, lng = null, accuracy_m = null
   where at < v_cut_ts and (lat is not null or lng is not null or accuracy_m is not null);
  update public.field_activity
     set lat = null, lng = null, accuracy_m = null
   where kind in ('punch_in', 'punch_out') and at < v_cut_ts and (lat is not null or lng is not null or accuracy_m is not null);
  -- 4.
  v_left := exists (select 1 from public.location_points lp where lp.at < v_cut_ts);
  if not v_left then
    update public.hr_settings set last_purge_at = now() where id = 1;
  end if;
  return jsonb_build_object('cutoff', v_cut, 'deleted', v_n, 'finals', v_finals, 'done', not v_left);
end $$;
perform public._hr_lockdown();
end $hr$;


-- =============================================================================
-- §4  API — the phone (any active staff member, for themselves)
--     Defined inside DO blocks that end with _hr_lockdown(): granted to
--     authenticated (each checks its caller) and service_role, never anon.
-- =============================================================================

do $hr$
begin
-- §9.4.3 — p = {id, kind, at, age_ms?, lat?, lng?, accuracy_m?, note?}
-- → {ok, duplicate, now, id, state, since, day, tracking} (+ voided:true for a
-- replay of a voided id). Any 'source' key is ignored (always 'phone').
create or replace function public.hr_punch(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_id uuid;
  v_kind text;
  v_at timestamptz;
  v_age numeric;
  v_lat numeric; v_lng numeric; v_acc numeric;
  v_note text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEO_GATE: The request is empty.'; end if;
  v_id := public._juuid(p, 'id');
  if v_id is null then
    raise exception 'NEO_GATE: id is required — make one UUID per punch and reuse it on every retry.';
  end if;
  v_kind := lower(public._jtxt(p, 'kind', 20, 'Kind'));
  v_at := public._jts(p, 'at', 'The time');
  if jsonb_typeof(p -> 'age_ms') = 'number' then v_age := (p ->> 'age_ms')::numeric; end if;
  -- A bad GPS fix never makes a queued punch fail: it is dropped, the punch kept.
  v_lat := public._jnum(p, 'lat', 'The latitude');
  v_lng := public._jnum(p, 'lng', 'The longitude');
  v_acc := public._jnum(p, 'accuracy_m', 'The accuracy');
  if v_lat is null or v_lng is null or v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180 then
    v_lat := null; v_lng := null; v_acc := null;
  end if;
  if v_acc is not null and v_acc < 0 then v_acc := null; end if;
  v_note := public._jtxt(p, 'note', 500, 'The note');
  return public._hr_punch_apply(v_me.email, v_id, v_kind, v_at, v_age, v_lat::float8, v_lng::float8, v_acc::float8, v_note);
end $$;

-- §9.4.5 — a day: the day record, its punches (voided included), visits,
-- km, the requests touching it; for your own day also tracking and who viewed
-- your route. Someone else's day: approvers only (with clock marks).
create or replace function public.hr_my_day(p_day date default null, p_email text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_now timestamptz := now();
  v_appr boolean := public.has_module('neohr', 'lead');
  v_t public.profiles;
  v_self boolean;
  v_em text;
  v_d date := coalesce(p_day, public._hr_today(now()));
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  v_lo timestamptz;
  v_hi timestamptz;
  f jsonb; v_mine jsonb; v_other jsonb; v_out jsonb;
begin
  if nullif(btrim(coalesce(p_email, '')), '') is null or lower(btrim(p_email)) = lower(v_me.email) then
    v_t := v_me;
  else
    if not v_appr then raise exception 'NEO_DENIED: Only a head or a NeoHR lead can see someone else''s day.'; end if;
    v_t := public._hr_staff(p_email, false);
    if v_t.id is null then raise exception 'NEO_GATE: There is no staff account with that email.'; end if;
  end if;
  v_self := v_t.id = v_me.id;
  v_em := lower(v_t.email);
  v_lo := public._hr_at(v_d, '00:00');
  v_hi := public._hr_at(v_d + 1, '00:00');
  f := public._hr_fold(public._hr_events(v_em, v_lo - make_interval(hours => v_h), v_hi + make_interval(hours => v_h)), v_h, v_now);
  select coalesce(jsonb_agg(x.value order by (x.value ->> 'start')::timestamptz), '[]'::jsonb) into v_mine
    from jsonb_array_elements(f -> 'sessions') as x(value) where (x.value ->> 'day')::date = v_d;
  select coalesce(jsonb_agg(x.value), '[]'::jsonb) into v_other
    from jsonb_array_elements(f -> 'sessions') as x(value) where (x.value ->> 'day')::date < v_d;
  v_out := (public._hr_days(v_em, v_d, v_d, v_now, v_appr and not v_self) -> 0)
    || jsonb_build_object('now', v_now, 'email', v_em, 'name', v_t.full_name,
    'events', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', e.id, 'kind', e.kind, 'at', e.at, 'device_at', e.device_at, 'time_source', e.time_source,
                   'source', e.source, 'note', e.note, 'voided_at', e.voided_at, 'void_reason', e.void_reason,
                   'clock_mark', case when v_appr and not v_self then
                                   case when e.time_source = 'device' then '⏱ time not verified'
                                        when e.time_source = 'server' and e.device_at is not null
                                             and abs(extract(epoch from e.device_at - e.at)) > 300
                                        then '⏱ phone clock off by ' || round(abs(extract(epoch from e.device_at - e.at)) / 60) || ' min'
                                   end end)
                 order by e.at, e.received_at, e.id), '[]'::jsonb)
                 from public.attendance_events e
                where lower(e.employee_email) = v_em
                  and e.at >= v_lo - make_interval(hours => v_h) and e.at < v_hi + make_interval(hours => v_h)
                  and (exists (select 1 from jsonb_array_elements(v_mine) as s(value)
                                where e.at >= (s.value ->> 'start')::timestamptz
                                  and e.at <= coalesce((s.value ->> 'out')::timestamptz, (s.value ->> 'cap')::timestamptz))
                       or (e.at >= v_lo and e.at < v_hi
                           and not exists (select 1 from jsonb_array_elements(v_other) as s(value)
                                            where e.at >= (s.value ->> 'start')::timestamptz
                                              and e.at <= coalesce((s.value ->> 'out')::timestamptz, (s.value ->> 'cap')::timestamptz))))),
    'visits', public._hr_visits(v_em, v_d, v_now, v_mine),
    'requests', (select coalesce(jsonb_agg(public._hr_req_json(q) order by q.created_at), '[]'::jsonb)
                   from public.hr_requests q where lower(q.employee_email) = v_em and v_d between q.date_from and q.date_to));
  if v_self then
    v_out := v_out || jsonb_build_object(
      'tracking', public._hr_tracking(v_em, v_t.id, v_now, public._hr_state(v_em, v_now)),
      'viewed_by', (select coalesce(jsonb_agg(jsonb_build_object(
                       'name', coalesce((select p.full_name from public.profiles p where lower(p.email) = lower(w.viewer_email) limit 1), w.viewer_email),
                       'at', w.at) order by w.at desc), '[]'::jsonb)
                      from public.hr_route_views w where lower(w.subject_email) = v_em and w.day = v_d));
  end if;
  return v_out;
end $$;

-- A month of my own days (up to today) with totals: absent and leave are
-- numbers (halves count); km is the sum of the day km values.
create or replace function public.hr_my_month(p_month date default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_now timestamptz := now();
  v_today date := public._hr_today(now());
  v_m date := date_trunc('month', coalesce(p_month, public._hr_today(now())))::date;
  v_to date;
  v_days jsonb;
  v_set public.hr_settings;
  v_elig boolean;
  v_km numeric;
  v_ap public.hr_ta_approvals;
  v_rate numeric;
begin
  v_to := least((v_m + interval '1 month')::date - 1, v_today);
  v_days := case when v_to >= v_m then public._hr_days(v_me.email, v_m, v_to, v_now) else '[]'::jsonb end;
  select * into v_set from public.hr_settings where id = 1;
  v_elig := coalesce((select hp.ta_eligible from public.hr_person hp where hp.profile_id = v_me.id), true);
  v_rate := case when v_elig then v_set.ta_rate_per_km else 0 end;
  select coalesce(sum((d.value ->> 'km')::numeric), 0) into v_km from jsonb_array_elements(v_days) as d(value);
  select * into v_ap from public.hr_ta_approvals a where a.profile_id = v_me.id and a.month = v_m;
  return jsonb_build_object('now', v_now, 'email', lower(v_me.email), 'month', v_m, 'days', v_days,
    'totals', (select jsonb_build_object(
        'present', count(*) filter (where d.value ->> 'status' = 'present'),
        'late', count(*) filter (where d.value ->> 'status' = 'late'),
        'half_day', count(*) filter (where d.value ->> 'status' = 'half_day'),
        'absent', coalesce(sum((d.value ->> 'absent_units')::numeric), 0),
        'leave', coalesce(sum((d.value ->> 'leave_units')::numeric), 0),
        'off', count(*) filter (where d.value ->> 'status' = 'off'),
        'worked_hours', round(coalesce(sum((d.value ->> 'worked_min')::numeric), 0) / 60, 2),
        'km', v_km,
        'ta', jsonb_build_object(
                'eligible', v_elig, 'rate', case when v_ap.month is not null then v_ap.rate else v_rate end,
                'amount', case when v_ap.month is not null then v_ap.amount
                               when v_rate is not null then round(v_km * v_rate, 2) end,
                'approved', case when v_ap.month is not null then
                                   jsonb_build_object('by', v_ap.approved_by_name, 'at', v_ap.approved_at, 'km', v_ap.km) end))
      from jsonb_array_elements(v_days) as d(value)));
end $$;
perform public._hr_lockdown();
end $hr$;

do $hr$
begin
-- §9.4.7 — route points, ≤ 500 at a time, each {id, at, age_ms?, lat, lng,
-- accuracy_m?, speed_mps?, bearing?}. Set-based (no per-point exception
-- blocks): every item gets the first reason that applies — invalid, clock,
-- not_yours, (own duplicate: accepted), disabled, wfh, on_break / off_duty
-- (the runs of §9.5.2; a point up to 60 s before a punch_in or break_end is
-- stored at that event's time). → {accepted, rejected:[{id, reason}]}
create or replace function public.location_push(p_points jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_em text := lower(v_me.email);
  v_now timestamptz := now();
  v_today date := public._hr_today(now());
  v_set public.hr_settings;
  v_h int;
  v_track boolean;
  v_items jsonb;
  v_lo timestamptz; v_hi timestamptz;
  f jsonb;
  v_sess jsonb := '[]'::jsonb;
  v_runs jsonb := '[]'::jsonb;
  v_duty jsonb := '{}'::jsonb;
  v_cls jsonb;
  v_acc int;
  v_rej jsonb;
begin
  if p_points is null or jsonb_typeof(p_points) <> 'array' then raise exception 'NEO_GATE: Send a list of points.'; end if;
  if jsonb_array_length(p_points) > 500 then raise exception 'NEO_GATE: Send at most 500 points at a time.'; end if;
  if jsonb_array_length(p_points) = 0 then return jsonb_build_object('accepted', 0, 'rejected', '[]'::jsonb); end if;
  perform pg_advisory_xact_lock_shared(hashtext('neo_hr_att:' || v_em));
  select * into v_set from public.hr_settings where id = 1;
  v_h := coalesce(v_set.max_session_h, 16);
  v_track := coalesce((select hp.track_location from public.hr_person hp where hp.profile_id = v_me.id), true);

  -- 1. Read and check every item (text columns; regex and range checks — nothing here can raise).
  --    `at`: a UTC offset up to ±15:59 (what timestamptz accepts). Numbers: up
  --    to 12 digits, up to 40 decimals, an exponent of up to 2 digits — every
  --    double the phone sends as Postgres prints it (Double.toString of a Float
  --    accuracy like 3.9000000953674316 has 16; a 17-digit mantissa down to
  --    1e-23 fits) while nothing that passes can overflow or underflow float8
  --    (Postgres prints the JSON number 1e-400 with 400 decimals, and casting
  --    that raises).
  with raw as (
    select t.ord, r.id, r.at, r.lat, r.lng, r.accuracy_m, r.speed_mps, r.bearing,
           case when jsonb_typeof(t.e -> 'age_ms') = 'number' then (t.e ->> 'age_ms')::numeric end as age
      from jsonb_array_elements(p_points) with ordinality as t(e, ord)
      cross join lateral jsonb_to_record(case when jsonb_typeof(t.e) = 'object' then t.e else '{}'::jsonb end)
           as r(id text, at text, lat text, lng text, accuracy_m text, speed_mps text, bearing text)
  ), chk as (
    select raw.*,
           coalesce(raw.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) as id_ok,
           case when not coalesce(raw.at ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?([Zz]|[+-](0\d|1[0-5])(:?[0-5]\d)?)?$', false)
                  then false
                when substr(raw.at, 1, 4)::int not between 1900 and 2999 then false
                else substr(raw.at, 9, 2)::int
                     <= extract(day from make_date(substr(raw.at, 1, 4)::int, substr(raw.at, 6, 2)::int, 1) + interval '1 month - 1 day')
           end as at_ok,
           case when raw.lat ~ '^-?(\d{1,12}(\.\d{0,40})?|\.\d{1,40})([eE][-+]?\d{1,2})?$' then raw.lat::float8 end as latv,
           case when raw.lng ~ '^-?(\d{1,12}(\.\d{0,40})?|\.\d{1,40})([eE][-+]?\d{1,2})?$' then raw.lng::float8 end as lngv,
           case when raw.accuracy_m ~ '^-?(\d{1,12}(\.\d{0,40})?|\.\d{1,40})([eE][-+]?\d{1,2})?$' then raw.accuracy_m::float8 end as accv,
           case when raw.speed_mps ~ '^-?(\d{1,12}(\.\d{0,40})?|\.\d{1,40})([eE][-+]?\d{1,2})?$' then raw.speed_mps::float8 end as spdv,
           case when raw.bearing ~ '^-?(\d{1,12}(\.\d{0,40})?|\.\d{1,40})([eE][-+]?\d{1,2})?$' then raw.bearing::float8 end as brgv,
           coalesce(raw.age >= 0 and raw.age <= 604800000, false) as anchored
      from raw
  ), val as (
    select chk.*,
           case when chk.at_ok then chk.at::timestamptz end as dev,
           coalesce(chk.id_ok and chk.at_ok and chk.latv between -90 and 90 and chk.lngv between -180 and 180
                    and (chk.accuracy_m is null or coalesce(chk.accv >= 0, false)), false) as ok
      from chk
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'ord', val.ord, 'id', val.id, 'uid', case when val.id_ok then lower(val.id) end,
           'reason', case when not val.ok then 'invalid'
                          when not val.anchored and (val.dev < timestamptz '2020-01-01 00:00:00+00' or val.dev > v_now + interval '10 minutes')
                          then 'clock' end,
           'at', case when val.ok then case when val.anchored then v_now - val.age * interval '1 millisecond' else val.dev end end,
           'dev', val.dev, 'src', case when val.anchored then 'server' else 'device' end,
           'lat', val.latv, 'lng', val.lngv, 'acc', val.accv, 'spd', val.spdv, 'brg', val.brgv) order by val.ord), '[]'::jsonb)
    into v_items
    from val;

  -- 2. The person's sessions and runs around the accepted times.
  select min((i.value ->> 'at')::timestamptz), max((i.value ->> 'at')::timestamptz) into v_lo, v_hi
    from jsonb_array_elements(v_items) as i(value) where i.value ->> 'reason' is null;
  if v_lo is not null then
    f := public._hr_fold(public._hr_events(v_em, v_lo - make_interval(hours => 2 * v_h), v_hi + interval '1 minute'), v_h, v_now);
    v_sess := f -> 'sessions';
    v_runs := public._hr_runs(v_sess);
    select coalesce(jsonb_object_agg(c.day::text, c.duty), '{}'::jsonb) into v_duty
      from (select distinct (s.value ->> 'day')::date as d from jsonb_array_elements(v_sess) as s(value)) dd
      cross join lateral public._hr_ctx(v_me.id, v_em, dd.d, dd.d) c;
  end if;

  -- 3. Classify.
  select coalesce(jsonb_agg(z.j order by z.ord), '[]'::jsonb) into v_cls
    from (select (i.value ->> 'ord')::int as ord,
                 i.value || jsonb_build_object(
                   'final', coalesce(i.value ->> 'reason',
                              case when ex.employee_email is not null and ex.employee_email <> v_em then 'not_yours'
                                   when ex.employee_email is not null then 'dup'
                                   when not v_track then 'disabled'
                                   when v_duty ->> coalesce(rn.value ->> 'day', se.value ->> 'day') = 'wfh' then 'wfh'
                                   when rn.value is not null then null
                                   when se.value is not null then 'on_break'
                                   else 'off_duty' end),
                   'store_at', case when rn.value is not null
                                    then greatest((i.value ->> 'at')::timestamptz, (rn.value ->> 'from')::timestamptz) end,
                   'day', rn.value ->> 'day') as j
            from jsonb_array_elements(v_items) as i(value)
            left join public.location_points ex on ex.client_point_id = (i.value ->> 'uid')::uuid
            left join lateral (select r.value from jsonb_array_elements(v_runs) as r(value)
                                where i.value ->> 'reason' is null
                                  and (i.value ->> 'at')::timestamptz >= (r.value ->> 'from')::timestamptz - interval '60 seconds'
                                  and (i.value ->> 'at')::timestamptz < (r.value ->> 'to')::timestamptz
                                order by ((i.value ->> 'at')::timestamptz >= (r.value ->> 'from')::timestamptz) desc,
                                         (r.value ->> 'from')::timestamptz
                                limit 1) rn on true
            left join lateral (select s.value from jsonb_array_elements(v_sess) as s(value)
                                where i.value ->> 'reason' is null
                                  and (i.value ->> 'at')::timestamptz >= (s.value ->> 'start')::timestamptz
                                  and (i.value ->> 'at')::timestamptz < coalesce((s.value ->> 'out')::timestamptz, (s.value ->> 'cap')::timestamptz)
                                limit 1) se on true) z;

  -- 4. Store the accepted ones, all in one statement.
  insert into public.location_points (client_point_id, profile_id, employee_email, at, device_at, time_source,
                                      lat, lng, accuracy_m, speed_mps, bearing)
  select distinct on (x.value ->> 'uid') (x.value ->> 'uid')::uuid, v_me.id, v_em, (x.value ->> 'store_at')::timestamptz,
         (x.value ->> 'dev')::timestamptz, x.value ->> 'src', (x.value ->> 'lat')::float8, (x.value ->> 'lng')::float8,
         (x.value ->> 'acc')::float8, (x.value ->> 'spd')::float8, (x.value ->> 'brg')::float8
    from jsonb_array_elements(v_cls) as x(value)
   where x.value ->> 'final' is null
   order by x.value ->> 'uid', (x.value ->> 'ord')::int
  on conflict (client_point_id) do nothing;

  select count(*) filter (where x.value ->> 'final' is null or x.value ->> 'final' = 'dup'),
         coalesce(jsonb_agg(jsonb_build_object('id', x.value -> 'id', 'reason', x.value ->> 'final') order by (x.value ->> 'ord')::int)
                    filter (where x.value ->> 'final' is not null and x.value ->> 'final' <> 'dup'), '[]'::jsonb)
    into v_acc, v_rej
    from jsonb_array_elements(v_cls) as x(value);

  -- 5. A stored point of a past session day makes that day's cached km stale
  --    (row locks earliest day first: the order readers cache in).
  perform 1 from public.hr_day_km h
   where h.employee_email = v_em and not h.final and h.day < v_today
     and h.day in (select (x.value ->> 'day')::date from jsonb_array_elements(v_cls) as x(value) where x.value ->> 'final' is null)
   order by h.day
     for update;
  delete from public.hr_day_km h
   where h.employee_email = v_em and not h.final and h.day < v_today
     and h.day in (select (x.value ->> 'day')::date from jsonb_array_elements(v_cls) as x(value) where x.value ->> 'final' is null);

  -- 6. Retention without pg_cron: at most every 6 hours, by whoever pushes.
  if (v_set.last_purge_at is null or v_set.last_purge_at < v_now - interval '6 hours')
     and pg_try_advisory_xact_lock(hashtext('neo_hr_purge')) then
    perform public._hr_purge(5000);
  end if;
  return jsonb_build_object('accepted', v_acc, 'rejected', v_rej);
end $$;
perform public._hr_lockdown();
end $hr$;

do $hr$
begin
-- §9.4.5 — a day's route: points (≤ 2000, evenly thinned, display only),
-- stops with a place hint, moving / gap segments, km, visits. Someone else's
-- route: approvers only, and the view is recorded in hr_route_views.
create or replace function public.hr_route(p_email text default null, p_day date default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_now timestamptz := now();
  v_t public.profiles;
  v_em text;
  v_d date := coalesce(p_day, public._hr_today(now()));
  v_set public.hr_settings;
  v_sess jsonb; v_tr jsonb; v_rec jsonb; v_vis jsonb; v_path jsonb; v_pts jsonb; v_stops jsonb;
  v_n int;
begin
  if nullif(btrim(coalesce(p_email, '')), '') is null or lower(btrim(p_email)) = lower(v_me.email) then
    v_t := v_me;
  else
    if not public.has_module('neohr', 'lead') then
      raise exception 'NEO_DENIED: Only a head or a NeoHR lead can see someone else''s route.';
    end if;
    v_t := public._hr_staff(p_email, false);
    if v_t.id is null then raise exception 'NEO_GATE: There is no staff account with that email.'; end if;
  end if;
  v_em := lower(v_t.email);
  if v_t.id <> v_me.id then
    insert into public.hr_route_views (viewer_email, subject_email, day) values (lower(v_me.email), v_em, v_d);
  end if;
  select * into v_set from public.hr_settings where id = 1;
  v_sess := public._hr_day_sessions(v_em, v_d, v_now);
  v_tr := public._hr_track_sessions(v_em, v_sess);
  v_rec := public._hr_days(v_em, v_d, v_d, v_now) -> 0;
  v_vis := public._hr_visits(v_em, v_d, v_now, v_sess);
  v_path := coalesce(v_tr -> 'path', '[]'::jsonb);
  v_n := jsonb_array_length(v_path);
  if v_n > 2000 then
    select jsonb_agg(v_path -> (floor(g * (v_n - 1)::numeric / 1999))::int order by g) into v_pts
      from generate_series(0, 1999) as g;
  else
    v_pts := v_path;
  end if;
  select coalesce(jsonb_agg(s.value || jsonb_build_object('place_hint', coalesce(
           (select v.value ->> 'site_area' from jsonb_array_elements(v_vis) as v(value)
             where nullif(btrim(coalesce(v.value ->> 'site_area', '')), '') is not null
               and coalesce((v.value ->> 'arrived')::timestamptz, (v.value ->> 'departed')::timestamptz) <= (s.value ->> 'left')::timestamptz
               and coalesce((v.value ->> 'departed')::timestamptz, v_now) >= (s.value ->> 'arrived')::timestamptz
             limit 1),
           case when v_set.office_lat is not null
                     and public._hr_hav((s.value ->> 'lat')::float8, (s.value ->> 'lng')::float8, v_set.office_lat, v_set.office_lng) <= v_set.office_radius_m
                then 'Shop' end))
         order by (s.value ->> 'arrived')::timestamptz), '[]'::jsonb)
    into v_stops
    from jsonb_array_elements(coalesce(v_tr -> 'stops', '[]'::jsonb)) as s(value);
  return jsonb_build_object('now', v_now, 'email', v_em, 'name', v_t.full_name, 'day', v_d,
                            'points', v_pts, 'stops', v_stops, 'segments', coalesce(v_tr -> 'segments', '[]'::jsonb),
                            'km', v_rec -> 'km', 'km_gaps', v_rec -> 'km_gaps', 'moving_min', coalesce(v_tr -> 'moving_min', '0'::jsonb),
                            'visits', v_vis);
end $$;

-- §9.9.2 — the phone's dashboard: me (any active staff), hr (approvers only).
create or replace function public.hr_dashboard()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_now timestamptz := now();
  v_em text := lower(v_me.email);
  st jsonb; v_open jsonb; v_d date; v_rec jsonb; v_out jsonb; v_live jsonb;
begin
  st := public._hr_state(v_em, v_now);
  v_open := nullif(st -> 'open', 'null'::jsonb);
  v_d := coalesce((v_open ->> 'day')::date, public._hr_today(v_now));
  v_rec := public._hr_days(v_em, v_d, v_d, v_now) -> 0;
  v_out := jsonb_build_object('now', v_now,
    'me', jsonb_build_object('state', st ->> 'state', 'since', st -> 'since', 'worked_min', v_rec -> 'worked_min',
                             'break_min', v_rec -> 'break_min', 'km', v_rec -> 'km', 'flex', v_rec -> 'flex',
                             'late_min', v_rec -> 'late_min', 'missed_out', v_rec -> 'missed_out',
                             'tracking', public._hr_tracking(v_em, v_me.id, v_now, st)));
  if public.has_module('neohr', 'lead') then
    select coalesce(jsonb_agg(public._hr_live(p, v_now)), '[]'::jsonb) into v_live
      from public.profiles p where p.active and coalesce(p.is_staff, false);
    v_out := v_out || jsonb_build_object('hr', (
      select jsonb_build_object(
               'on_duty', count(*) filter (where x.value ->> 'status' = 'on_duty'),
               'on_break', count(*) filter (where x.value ->> 'status' = 'on_break'),
               'on_site', count(*) filter (where x.value ->> 'status' = 'on_site'),
               'absent', count(*) filter (where x.value ->> 'status' = 'absent'),
               'not_in_yet', count(*) filter (where x.value ->> 'status' = 'not_in_yet'),
               'pending_requests', (select count(*) from public.hr_requests q
                                     where q.status = 'pending' and q.employee_email <> v_em))
        from jsonb_array_elements(v_live) as x(value)));
  end if;
  return v_out;
end $$;
perform public._hr_lockdown();
end $hr$;


-- =============================================================================
-- §5  API — telling HR, and the heads' side (approvers = neohr lead, tier 3+)
-- =============================================================================

do $hr$
begin
-- §9.6.1 — p = {kind, date_from, date_to?, half_day?, leave_type?, reason,
-- ref_code?, missed_at?, missed_kind?, id?}. A missed_punch takes its dates
-- from missed_at. An optional client id makes a retry safe.
-- → {ok:true, duplicate, request}
create or replace function public.hr_request_create(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_em text := lower(v_me.email);
  v_today date := public._hr_today(now());
  v_id uuid;
  v_kind text; v_reason text; v_ref text; v_from date; v_to date; v_half boolean; v_type text;
  v_mkind text; v_mat timestamptz;
  v_ahead int;
  v_old public.hr_requests;
  v_new public.hr_requests;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEO_GATE: The request is empty.'; end if;
  v_id := public._juuid(p, 'id');
  if v_id is not null then
    select * into v_old from public.hr_requests where id = v_id;
    if found then
      if v_old.employee_email <> v_em then raise exception 'NEO_GATE: That request id is already used.'; end if;
      return jsonb_build_object('ok', true, 'duplicate', true, 'request', public._hr_req_json(v_old));
    end if;
  end if;
  v_kind := lower(public._jtxt(p, 'kind', 20, 'Kind'));
  if v_kind is null or v_kind not in ('late_start', 'early_leave', 'flexible_day', 'field_day', 'missed_punch', 'leave') then
    raise exception 'NEO_GATE: Say what you''re telling HR: late start, early leave, flexible day, field day, missed punch or leave.';
  end if;
  v_reason := public._jtxt(p, 'reason', 500, 'The reason');
  if v_reason is null or char_length(v_reason) < 3 then raise exception 'NEO_GATE: Say why — at least 3 characters.'; end if;
  v_ref := upper(public._jtxt(p, 'ref_code', 20, 'The job code'));
  if v_ref is not null and v_ref !~ '^(NT|RM)-[A-Z0-9]{4,12}$' then
    raise exception 'NEO_GATE: A job code looks like NT-7KQ2ACDE or RM-7KQ2PX4D.';
  end if;
  if v_kind = 'missed_punch' then
    v_mkind := lower(public._jtxt(p, 'missed_kind', 20, 'The missed punch'));
    if v_mkind is null or v_mkind not in ('punch_in', 'punch_out', 'break_start', 'break_end') then
      raise exception 'NEO_GATE: Say which punch you missed: punch in, punch out, break start or break end.';
    end if;
    v_mat := public._jts(p, 'missed_at', 'The missed punch time');
    if v_mat is null then raise exception 'NEO_GATE: Say when the missed punch was.'; end if;
    if v_mat > now() then raise exception 'NEO_GATE: The missed punch can''t be in the future.'; end if;
    v_from := (v_mat at time zone 'Asia/Kolkata')::date;
    v_to := v_from;
  else
    v_from := public._jdate(p, 'date_from', 'The start date');
    if v_from is null then raise exception 'NEO_GATE: Say which day.'; end if;
    v_to := coalesce(public._jdate(p, 'date_to', 'The end date'), v_from);
    if v_to < v_from then raise exception 'NEO_GATE: The end date is before the start date.'; end if;
    if v_to - v_from > 30 then raise exception 'NEO_GATE: Ask for at most 31 days at a time.'; end if;
  end if;
  v_half := coalesce(public._jbool(p, 'half_day', 'Half day'), false) and v_kind = 'leave';
  if v_kind = 'leave' then
    v_type := lower(public._jtxt(p, 'leave_type', 20, 'The leave type'));
    if v_type is null or v_type not in ('casual', 'sick', 'other') then
      raise exception 'NEO_GATE: Say what kind of leave: casual, sick or other.';
    end if;
    if v_half and v_to <> v_from then raise exception 'NEO_GATE: A half-day leave is for one day.'; end if;
  end if;
  if v_from < v_today - 7 then raise exception 'NEO_GATE: Tell HR within 7 days of the day.'; end if;
  v_ahead := case when v_kind = 'leave' then 90 else 31 end;
  if v_to > v_today + v_ahead then
    raise exception 'NEO_GATE: That''s too far ahead — ask closer to the date.';
  end if;
  perform pg_advisory_xact_lock(hashtext('neo_hr_att:' || v_em));
  if v_kind = 'leave' and exists (select 1 from public.hr_requests q
                                   where q.employee_email = v_em and q.kind = 'leave' and q.status in ('pending', 'approved')
                                     and q.date_from <= v_to and q.date_to >= v_from) then
    raise exception 'NEO_GATE: You already asked for leave on one of those days.';
  end if;
  insert into public.hr_requests (id, profile_id, employee_email, kind, date_from, date_to, half_day, leave_type, reason,
                                  ref_code, missed_at, missed_kind)
  values (coalesce(v_id, gen_random_uuid()), v_me.id, v_em, v_kind, v_from, v_to, v_half, v_type, v_reason,
          v_ref, v_mat, v_mkind)
  returning * into v_new;
  return jsonb_build_object('ok', true, 'duplicate', false, 'request', public._hr_req_json(v_new));
end $$;

-- §9.6.3 — the owner: a pending request any time, an approved one before it
-- starts. An approver (never on their own): pending or approved, with a note.
-- Cancelling removes the roster rows the request made.
create or replace function public.hr_request_cancel(p_id uuid, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_appr boolean := public.has_module('neohr', 'lead');
  v_today date := public._hr_today(now());
  r public.hr_requests;
  v_own boolean;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into r from public.hr_requests where id = p_id;
  if not found then raise exception 'NEO_GATE: That request no longer exists.'; end if;
  v_own := r.employee_email = lower(v_me.email);
  if not v_own and not v_appr then raise exception 'NEO_DENIED: You can only cancel your own requests.'; end if;
  if not v_own and v_note is null then raise exception 'NEO_GATE: Say why you''re cancelling it.'; end if;
  if char_length(coalesce(v_note, '')) > 300 then raise exception 'NEO_GATE: The note is too long — keep it under 300 characters.'; end if;
  perform pg_advisory_xact_lock(hashtext('neo_hr_att:' || r.employee_email));
  select * into r from public.hr_requests where id = p_id for update;
  if r.status not in ('pending', 'approved') then
    return jsonb_build_object('ok', false, 'reason', 'decided', 'status', r.status,
                              'by', case when r.status = 'cancelled' then r.cancelled_by_name else r.decided_by_name end,
                              'at', case when r.status = 'cancelled' then r.cancelled_at else r.decided_at end);
  end if;
  if r.status = 'approved' and r.kind = 'missed_punch' then
    raise exception 'NEO_GATE: Fix an added punch with Correct… instead.';
  end if;
  if v_own and r.status = 'approved' and r.date_from <= v_today then
    if v_appr then perform public._hr_not_self(r.profile_id, v_me.id); end if;
    raise exception 'NEO_GATE: It has already started — ask a head or a NeoHR lead to cancel it.';
  end if;
  update public.hr_requests
     set status = 'cancelled', cancelled_by_email = lower(v_me.email), cancelled_by_name = v_me.full_name,
         cancelled_at = now(), cancel_note = v_note
   where id = p_id
  returning * into r;
  delete from public.hr_roster where source_request_id = p_id;
  return jsonb_build_object('ok', true, 'request', public._hr_req_json(r));
end $$;

-- §9.6.2 — approve or reject (approvers, never their own). Approving a
-- missed_punch adds the 'hr' punch, checked now like an HR correction
-- (_hr_check_ops: it is taken, and nothing taken before is skipped); when it
-- needs another punch voided too, hr_correct with request_id approves it with
-- that change. A full-day leave or a field day writes the roster for its
-- working days. A request no longer pending answers 'decided' with whoever
-- decided it (or cancelled it, when it was cancelled).
create or replace function public.hr_request_decide(p_id uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  r public.hr_requests;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_eid uuid;
begin
  if not public.has_module('neohr', 'lead') then
    raise exception 'NEO_DENIED: Only a head or a NeoHR lead can approve requests.';
  end if;
  select * into r from public.hr_requests where id = p_id;
  if not found then raise exception 'NEO_GATE: That request no longer exists.'; end if;
  if r.employee_email = lower(v_me.email) then perform public._hr_not_self(v_me.id, v_me.id); end if;
  perform public._hr_not_self(r.profile_id, v_me.id);
  if p_approve is null then raise exception 'NEO_GATE: Say approve or reject.'; end if;
  if char_length(coalesce(v_note, '')) > 300 then raise exception 'NEO_GATE: The note is too long — keep it under 300 characters.'; end if;
  perform pg_advisory_xact_lock(hashtext('neo_hr_att:' || r.employee_email));
  select * into r from public.hr_requests where id = p_id for update;
  if r.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'decided', 'status', r.status,
                              'by', case when r.status = 'cancelled' then r.cancelled_by_name else r.decided_by_name end,
                              'at', case when r.status = 'cancelled' then r.cancelled_at else r.decided_at end);
  end if;
  if p_approve then
    if r.kind = 'missed_punch' then
      v_eid := gen_random_uuid();
      if public._hr_check_ops(r.employee_email, '{}'::uuid[],
                              jsonb_build_array(jsonb_build_object('id', v_eid::text, 'kind', r.missed_kind, 'at', r.missed_at))) is not null then
        raise exception 'NEO_GATE: That punch no longer fits the day — use Correct….';
      end if;
      insert into public.attendance_events (id, profile_id, employee_email, kind, at, device_at, time_source, source, note, created_by_email)
      values (v_eid, r.profile_id, r.employee_email, r.missed_kind, r.missed_at, null, 'hr', 'hr', left(r.reason, 500), lower(v_me.email));
      perform public._hr_invalidate(r.employee_email, r.missed_at);
    elsif (r.kind = 'leave' and not r.half_day) or r.kind = 'field_day' then
      insert into public.hr_roster as h (profile_id, day, duty, note, set_by_email, set_at, source_request_id)
      select r.profile_id, c.day, case when r.kind = 'leave' then 'leave' else 'field' end,
             case when r.kind = 'leave' then 'Leave' else 'Field day' end, lower(v_me.email), now(), r.id
        from public._hr_ctx(r.profile_id, r.employee_email, r.date_from, r.date_to) c
       where r.profile_id is not null and c.duty <> 'off'
      on conflict (profile_id, day) do update
        set duty = excluded.duty, note = excluded.note, set_by_email = excluded.set_by_email,
            set_at = excluded.set_at, source_request_id = excluded.source_request_id;
    end if;
  end if;
  update public.hr_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by_email = lower(v_me.email), decided_by_name = v_me.full_name, decided_at = now(), decision_note = v_note
   where id = p_id
  returning * into r;
  return jsonb_build_object('ok', true, 'request', public._hr_req_json(r));
end $$;

-- 'mine' (my requests), 'pending' (approvers: everyone's pending), 'all'
-- (approvers: everyone's in a date range, default the last 31 days to 90 ahead).
create or replace function public.hr_requests_list(p_scope text default 'mine', p_from date default null, p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_em text := lower(v_me.email);
  v_appr boolean := public.has_module('neohr', 'lead');
  v_today date := public._hr_today(now());
  v_scope text := lower(coalesce(nullif(btrim(p_scope), ''), 'mine'));
  v_out jsonb;
begin
  if v_scope not in ('mine', 'pending', 'all') then raise exception 'NEO_GATE: The scope is mine, pending or all.'; end if;
  if v_scope <> 'mine' and not v_appr then
    raise exception 'NEO_DENIED: Only a head or a NeoHR lead can see everyone''s requests.';
  end if;
  select coalesce(jsonb_agg(public._hr_req_json(q) || jsonb_build_object(
           'can_decide', v_appr and q.status = 'pending' and q.employee_email <> v_em,
           'can_cancel', (q.employee_email = v_em and (q.status = 'pending' or (q.status = 'approved' and q.kind <> 'missed_punch' and q.date_from > v_today)))
                         or (v_appr and q.employee_email <> v_em and q.status in ('pending', 'approved') and not (q.status = 'approved' and q.kind = 'missed_punch')))
         order by case when q.status = 'pending' then 0 else 1 end, q.created_at desc), '[]'::jsonb)
    into v_out
    from (select * from public.hr_requests q
           where case v_scope
                   when 'mine' then q.employee_email = v_em
                                    and (p_from is null or q.date_to >= p_from) and (p_to is null or q.date_from <= p_to)
                   when 'pending' then q.status = 'pending'
                   else q.date_to >= coalesce(p_from, v_today - 31) and q.date_from <= coalesce(p_to, v_today + 90)
                 end
           order by q.created_at desc
           limit 500) q;
  return jsonb_build_object('now', now(), 'scope', v_scope, 'requests', v_out);
end $$;
perform public._hr_lockdown();
end $hr$;

do $hr$
begin
-- The duty roster: approvers set a day's duty (null clears it), never their own.
create or replace function public.hr_roster_set(p_email text, p_day date, p_duty text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_t public.profiles;
  v_today date := public._hr_today(now());
  v_duty text := lower(nullif(btrim(coalesce(p_duty, '')), ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  c record;
begin
  if not public.has_module('neohr', 'lead') then
    raise exception 'NEO_DENIED: Only a head or a NeoHR lead can change the roster.';
  end if;
  v_t := public._hr_staff(p_email, true);
  if v_t.id is null then raise exception 'NEO_GATE: There is no active staff account with that email.'; end if;
  perform public._hr_not_self(v_t.id, v_me.id);
  if p_day is null then raise exception 'NEO_GATE: Say which day.'; end if;
  if p_day < v_today - 62 or p_day > v_today + 366 then
    raise exception 'NEO_GATE: Pick a day within the last 62 days or the next year.';
  end if;
  if v_duty is not null and v_duty not in ('shop', 'field', 'off', 'leave', 'wfh') then
    raise exception 'NEO_GATE: A duty is shop, field, off, leave or wfh (work from home).';
  end if;
  if char_length(coalesce(v_note, '')) > 200 then raise exception 'NEO_GATE: The note is too long — keep it under 200 characters.'; end if;
  if v_duty is null then
    delete from public.hr_roster where profile_id = v_t.id and day = p_day;
  else
    insert into public.hr_roster as h (profile_id, day, duty, note, set_by_email, set_at, source_request_id)
    values (v_t.id, p_day, v_duty, v_note, lower(v_me.email), now(), null)
    on conflict (profile_id, day) do update
      set duty = excluded.duty, note = excluded.note, set_by_email = excluded.set_by_email, set_at = excluded.set_at,
          source_request_id = null;
  end if;
  select * into c from public._hr_ctx(v_t.id, lower(v_t.email), p_day, p_day);
  return jsonb_build_object('ok', true, 'email', lower(v_t.email), 'day', p_day, 'duty', c.duty, 'source', c.duty_source,
                            'note', c.duty_note);
end $$;

-- The roster for up to 62 days (default: this week, Monday to Sunday): your
-- own, or everyone's (or one person's) for an approver. Holidays included.
create or replace function public.hr_roster_get(p_from date default null, p_to date default null, p_email text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_appr boolean := public.has_module('neohr', 'lead');
  v_today date := public._hr_today(now());
  v_from date;
  v_to date;
  v_t public.profiles;
  v_people jsonb;
begin
  v_from := coalesce(p_from, v_today - (extract(isodow from v_today)::int - 1));
  v_to := coalesce(p_to, v_from + 6);
  if v_to < v_from then raise exception 'NEO_GATE: The end date is before the start date.'; end if;
  if v_to - v_from > 61 then raise exception 'NEO_GATE: Ask for at most 62 days at a time.'; end if;
  if nullif(btrim(coalesce(p_email, '')), '') is not null and lower(btrim(p_email)) <> lower(v_me.email) then
    if not v_appr then raise exception 'NEO_DENIED: Only a head or a NeoHR lead can see someone else''s roster.'; end if;
    v_t := public._hr_staff(p_email, false);
    if v_t.id is null then raise exception 'NEO_GATE: There is no staff account with that email.'; end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('email', lower(p.email), 'name', p.full_name, 'designation', p.designation,
           'self', p.id = v_me.id,
           'days', (select coalesce(jsonb_agg(jsonb_build_object('day', c.day, 'duty', c.duty, 'source', c.duty_source,
                                                                 'note', c.duty_note, 'request_id', c.request_id, 'holiday', c.holiday)
                                              order by c.day), '[]'::jsonb)
                      from public._hr_ctx(p.id, lower(p.email), v_from, v_to) c))
         order by p.full_name, p.email), '[]'::jsonb)
    into v_people
    from public.profiles p
   where case when v_t.id is not null then p.id = v_t.id
              when v_appr then p.active and coalesce(p.is_staff, false)
              else p.id = v_me.id end;
  return jsonb_build_object('now', now(), 'from', v_from, 'to', v_to, 'people', v_people,
    'holidays', (select coalesce(jsonb_agg(jsonb_build_object('day', h.day, 'name', h.name) order by h.day), '[]'::jsonb)
                   from public.hr_holidays h where h.day between v_from and v_to));
end $$;

-- §9.6.8 — a public holiday (approvers). A null or empty name deletes it.
create or replace function public.hr_holiday_set(p_day date, p_name text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if not public.has_module('neohr', 'lead') then
    raise exception 'NEO_DENIED: Only a head or a NeoHR lead can change the roster.';
  end if;
  if p_day is null then raise exception 'NEO_GATE: Say which day.'; end if;
  if v_name is null then
    delete from public.hr_holidays where day = p_day;
  else
    if char_length(v_name) < 2 or char_length(v_name) > 80 then
      raise exception 'NEO_GATE: A holiday''s name is 2 to 80 characters.';
    end if;
    insert into public.hr_holidays as h (day, name, set_by_email, set_at) values (p_day, v_name, lower(v_me.email), now())
    on conflict (day) do update set name = excluded.name, set_by_email = excluded.set_by_email, set_at = excluded.set_at;
  end if;
  return jsonb_build_object('ok', true, 'day', p_day, 'name', v_name);
end $$;

-- The live board (approvers): every active staff member, their live status
-- (§9.6.6), today's numbers, on-site job, last point time (no coordinates).
create or replace function public.hr_board()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_now timestamptz := now();
  v_people jsonb;
begin
  if not public.has_module('neohr', 'lead') then
    raise exception 'NEO_DENIED: Only a head or a NeoHR lead can see the team''s attendance.';
  end if;
  select coalesce(jsonb_agg(public._hr_live(p, v_now) || jsonb_build_object(
           'self', p.id = v_me.id,
           'pending_requests', (select count(*) from public.hr_requests q
                                 where q.employee_email = lower(p.email) and q.status = 'pending'))
         order by p.full_name, p.email), '[]'::jsonb)
    into v_people
    from public.profiles p
   where p.active and coalesce(p.is_staff, false);
  return jsonb_build_object('now', v_now, 'people', v_people,
    'counts', (select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb)
                 from (select y.value ->> 'status' as status, count(*) as n
                         from jsonb_array_elements(v_people) as y(value) group by 1) x));
end $$;

-- The register (approvers): day records per person for up to 62 days (days
-- after today are not returned), for every active staff member or one person.
-- People are computed in email order (each person's days in date order) —
-- the order every reader writes cached day km in, so two readers never
-- deadlock — and answered in name order.
create or replace function public.hr_register(p_from date default null, p_to date default null, p_email text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_now timestamptz := now();
  v_today date := public._hr_today(now());
  v_to date := coalesce(p_to, public._hr_today(now()));
  v_from date := coalesce(p_from, coalesce(p_to, public._hr_today(now())));
  v_t public.profiles;
  r record;
  v_people jsonb := '[]'::jsonb;
begin
  if not public.has_module('neohr', 'lead') then
    raise exception 'NEO_DENIED: Only a head or a NeoHR lead can see the team''s attendance.';
  end if;
  if v_to < v_from then raise exception 'NEO_GATE: The end date is before the start date.'; end if;
  if v_to - v_from > 61 then raise exception 'NEO_GATE: Ask for at most 62 days at a time.'; end if;
  if nullif(btrim(coalesce(p_email, '')), '') is not null then
    v_t := public._hr_staff(p_email, false);
    if v_t.id is null then raise exception 'NEO_GATE: There is no staff account with that email.'; end if;
  end if;
  for r in select p.* from public.profiles p
            where case when v_t.id is not null then p.id = v_t.id else p.active and coalesce(p.is_staff, false) end
            order by lower(p.email), p.id loop
    v_people := v_people || jsonb_build_array(jsonb_build_object('email', lower(r.email), 'name', r.full_name,
      'designation', r.designation, 'self', r.id = v_me.id,
      'days', public._hr_days(r.email, v_from, least(v_to, v_today), v_now, true)));
  end loop;
  select coalesce(jsonb_agg(x.value order by x.value ->> 'name', x.value ->> 'email'), '[]'::jsonb) into v_people
    from jsonb_array_elements(v_people) as x(value);
  return jsonb_build_object('now', v_now, 'from', v_from, 'to', v_to, 'people', v_people);
end $$;

-- HR corrections (approvers, never their own). One change:
--   p = {action:'add', kind, at, id?, note} adds an 'hr' punch;
--   p = {action:'void', id, note} voids one.
-- Several changes, applied and checked together (one lock, one check):
--   p = {ops:[{action:'add', kind, at, id?} | {action:'void', id}, …] (1–10),
--        note, request_id?}
-- e.g. "remove this accidental out–in pair" = two voids; "replace this punch"
-- = a void and an add; a forgotten punch-out before a punch_out + punch_in
-- the next morning = add the real punch-out, void the morning punch_out.
-- The changes fit when every added punch is taken by the fold and nothing it
-- took before is skipped after them (_hr_check_ops). request_id: a pending
-- missed_punch of the same person — its punch (kind, missed_at, the reason as
-- its note) is one more add, and the request is approved with the changes.
-- → {ok, event (the first change), events (every change, in order), day (the
--    session day of the first change), days (every session day touched),
--    request (with request_id)}; a request no longer pending answers
--    {ok:false, reason:'decided', status, by, at} and changes nothing.
create or replace function public.hr_correct(p_email text, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_t public.profiles;
  v_em text;
  v_ops jsonb; o jsonb; v_note text; v_kind text; v_at timestamptz; v_id uuid; v_msg text;
  v_rid uuid;
  r public.hr_requests;
  v_void uuid[] := '{}';
  v_add jsonb := '[]'::jsonb;
  v_order uuid[] := '{}';
  v_dayof jsonb := '{}'::jsonb;
  v_ev public.attendance_events;
  v_out jsonb;
begin
  if not public.has_module('neohr', 'lead') then
    raise exception 'NEO_DENIED: Only a head or a NeoHR lead can correct attendance.';
  end if;
  v_t := public._hr_staff(p_email, false);
  if v_t.id is null then raise exception 'NEO_GATE: There is no staff account with that email.'; end if;
  perform public._hr_not_self(v_t.id, v_me.id);
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEO_GATE: The request is empty.'; end if;
  v_em := lower(v_t.email);
  v_ops := case when p ? 'ops' then p -> 'ops' else jsonb_build_array(p) end;
  if jsonb_typeof(v_ops) is distinct from 'array' or jsonb_array_length(v_ops) > 10
     or (jsonb_array_length(v_ops) = 0 and nullif(btrim(coalesce(p ->> 'request_id', '')), '') is null) then
    raise exception 'NEO_GATE: Send from 1 to 10 changes.';
  end if;
  for o in select x.value from jsonb_array_elements(v_ops) as x(value) loop
    if jsonb_typeof(o) is distinct from 'object'
       or coalesce(lower(public._jtxt(o, 'action', 10, 'The action')), '') not in ('add', 'void') then
      raise exception 'NEO_GATE: Say add or void.';
    end if;
  end loop;
  v_note := public._jtxt(p, 'note', 500, 'The note');
  if v_note is null or char_length(v_note) < 3 then raise exception 'NEO_GATE: Say why — HR corrections need a note.'; end if;
  v_rid := public._juuid(p, 'request_id');
  perform pg_advisory_xact_lock(hashtext('neo_hr_att:' || v_em));
  if v_rid is not null then
    select * into r from public.hr_requests where id = v_rid for update;
    if not found then raise exception 'NEO_GATE: That request no longer exists.'; end if;
    if r.employee_email <> v_em then raise exception 'NEO_GATE: That request is someone else''s.'; end if;
    if r.kind <> 'missed_punch' then raise exception 'NEO_GATE: Only a missed punch is approved with a correction.'; end if;
    if r.status <> 'pending' then
      return jsonb_build_object('ok', false, 'reason', 'decided', 'status', r.status,
        'by', case when r.status = 'cancelled' then r.cancelled_by_name else r.decided_by_name end,
        'at', case when r.status = 'cancelled' then r.cancelled_at else r.decided_at end);
    end if;
  end if;
  -- read and check every change before the first write
  for o in select x.value from jsonb_array_elements(v_ops) as x(value) loop
    if lower(btrim(o ->> 'action')) = 'add' then
      v_kind := lower(public._jtxt(o, 'kind', 20, 'Kind'));
      if v_kind is null or v_kind not in ('punch_in', 'punch_out', 'break_start', 'break_end') then
        raise exception 'NEO_GATE: Say what you''re punching: punch_in, punch_out, break_start or break_end.';
      end if;
      v_at := public._jts(o, 'at', 'The time');
      if v_at is null then raise exception 'NEO_GATE: Say when it happened.'; end if;
      if v_at < timestamptz '2020-01-01 00:00:00+00' or v_at > now() + interval '10 minutes' then
        raise exception 'NEO_GATE: That time can''t be right — check the date.';
      end if;
      v_id := coalesce(public._juuid(o, 'id'), gen_random_uuid());
      if exists (select 1 from public.attendance_events e where e.id = v_id)
         or exists (select 1 from jsonb_array_elements(v_add) as y(value) where y.value ->> 'id' = v_id::text) then
        raise exception 'NEO_GATE: That punch id is already used.';
      end if;
      v_add := v_add || jsonb_build_array(jsonb_build_object('id', v_id::text, 'kind', v_kind, 'at', v_at, 'note', v_note));
    else
      v_id := public._juuid(o, 'id');
      if v_id is null then raise exception 'NEO_GATE: Say which punch to void.'; end if;
      select * into v_ev from public.attendance_events e where e.id = v_id and e.employee_email = v_em;
      if not found then raise exception 'NEO_GATE: That punch was not found.'; end if;
      if v_ev.voided_at is not null or v_id = any (v_void) then raise exception 'NEO_GATE: That punch is already voided.'; end if;
      v_void := v_void || v_id;
    end if;
    v_order := v_order || v_id;
  end loop;
  -- a missed punch approved with the changes: its punch is one more add (the reason is its note, as hr_request_decide)
  if v_rid is not null then
    v_id := gen_random_uuid();
    v_add := v_add || jsonb_build_array(jsonb_build_object('id', v_id::text, 'kind', r.missed_kind, 'at', r.missed_at,
                                                           'note', left(r.reason, 500)));
    v_order := v_order || v_id;
  end if;
  v_msg := public._hr_check_ops(v_em, v_void, v_add);
  if v_msg is not null then raise exception 'NEO_GATE: %', v_msg; end if;
  -- the session day of every change: a voided punch's before it goes, an added one's once it is in
  select coalesce(jsonb_object_agg(e.id::text, public._hr_session_day(v_em, e.at)), '{}'::jsonb) into v_dayof
    from public.attendance_events e where e.id = any (v_void);
  update public.attendance_events set voided_at = now(), voided_by = lower(v_me.email), void_reason = v_note
   where id = any (v_void);
  insert into public.attendance_events (id, profile_id, employee_email, kind, at, device_at, time_source, source, note, created_by_email)
  select (y.value ->> 'id')::uuid, v_t.id, v_em, y.value ->> 'kind', (y.value ->> 'at')::timestamptz, null, 'hr', 'hr',
         y.value ->> 'note', lower(v_me.email)
    from jsonb_array_elements(v_add) as y(value);
  select v_dayof || coalesce(jsonb_object_agg(y.value ->> 'id', public._hr_session_day(v_em, (y.value ->> 'at')::timestamptz)), '{}'::jsonb)
    into v_dayof
    from jsonb_array_elements(v_add) as y(value);
  -- the cached km of every day touched, earliest first (the order readers cache in)
  perform public._hr_invalidate(v_em, e.at)
     from public.attendance_events e where e.id = any (v_order)
    order by e.at;
  if v_rid is not null then
    update public.hr_requests
       set status = 'approved', decided_by_email = lower(v_me.email), decided_by_name = v_me.full_name, decided_at = now(),
           decision_note = left(v_note, 300)
     where id = v_rid
    returning * into r;
  end if;
  -- every change in the order sent (a request's punch last)
  select jsonb_build_object('ok', true,
           'events', coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'at', e.at, 'source', e.source,
                                                           'time_source', e.time_source, 'note', e.note, 'voided_at', e.voided_at,
                                                           'void_reason', e.void_reason, 'created_by_email', e.created_by_email)
                                        order by u.ord), '[]'::jsonb))
    into v_out
    from unnest(v_order) with ordinality as u(id, ord)
    join public.attendance_events e on e.id = u.id;
  v_out := v_out || jsonb_build_object('event', v_out -> 'events' -> 0,
    'day', public._hr_days(v_em, (v_dayof ->> v_order[1]::text)::date, (v_dayof ->> v_order[1]::text)::date, now(), true) -> 0,
    'days', (select coalesce(jsonb_agg(public._hr_days(v_em, d.day, d.day, now(), true) -> 0 order by d.day), '[]'::jsonb)
               from (select distinct (x.value #>> '{}')::date as day from jsonb_each(v_dayof) as x(key, value)) d));
  if v_rid is not null then v_out := v_out || jsonb_build_object('request', public._hr_req_json(r)); end if;
  return v_out;
end $$;
perform public._hr_lockdown();
end $hr$;


-- =============================================================================
-- §6  API — settings (tier 4+) and travel allowance (approvers)
-- =============================================================================

do $hr$
begin
-- Any active staff member: the settings, the default shift history, and me
-- {shift (today's), attendance_required, ta_eligible, tracking}. Tier 4+ also
-- get people (per-person switches and shift rows) for the Settings screen.
create or replace function public.hr_settings_get()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_now timestamptz := now();
  v_today date := public._hr_today(now());
  v_set public.hr_settings;
  v_hp public.hr_person;
  c record;
  v_out jsonb;
begin
  select * into v_set from public.hr_settings where id = 1;
  select * into v_hp from public.hr_person where profile_id = v_me.id;
  select * into c from public._hr_ctx(v_me.id, lower(v_me.email), v_today, v_today);
  v_out := jsonb_build_object(
    'shift_start', to_char(v_set.shift_start, 'HH24:MI'), 'shift_end', to_char(v_set.shift_end, 'HH24:MI'),
    'grace_min', v_set.grace_min, 'weekly_off', to_jsonb(v_set.weekly_off), 'half_day_min', v_set.half_day_min,
    'track_interval_s', v_set.track_interval_s, 'track_distance_m', v_set.track_distance_m,
    'retention_days', v_set.retention_days, 'ta_rate_per_km', v_set.ta_rate_per_km,
    'office_lat', v_set.office_lat, 'office_lng', v_set.office_lng, 'office_radius_m', v_set.office_radius_m,
    'max_session_h', v_set.max_session_h, 'attendance_from', v_set.attendance_from, 'last_purge_at', v_set.last_purge_at,
    'updated_by', v_set.updated_by, 'updated_at', v_set.updated_at,
    'history', (select coalesce(jsonb_agg(jsonb_build_object('effective_from', h.effective_from,
                  'shift_start', to_char(h.shift_start, 'HH24:MI'), 'shift_end', to_char(h.shift_end, 'HH24:MI'),
                  'grace_min', h.grace_min, 'weekly_off', to_jsonb(h.weekly_off), 'half_day_min', h.half_day_min,
                  'set_by_email', h.set_by_email, 'set_at', h.set_at) order by h.effective_from desc), '[]'::jsonb)
                  from (select x.* from public.hr_shift_history x where x.profile_id is null
                         order by x.effective_from desc limit 20) h),
    'me', jsonb_build_object(
      'shift', jsonb_build_object('start', to_char(c.shift_start, 'HH24:MI'), 'end', to_char(c.shift_end, 'HH24:MI'),
                                  'grace_min', c.grace_min, 'weekly_off', to_jsonb(c.weekly_off), 'half_day_min', c.half_day_min),
      'attendance_required', coalesce(v_hp.attendance_required, true),
      'ta_eligible', coalesce(v_hp.ta_eligible, true),
      'tracking', public._hr_tracking(lower(v_me.email), v_me.id, v_now, public._hr_state(lower(v_me.email), v_now))));
  if v_me.tier >= 4 then
    v_out := v_out || jsonb_build_object('people', (
      select coalesce(jsonb_agg(jsonb_build_object('email', lower(p.email), 'name', p.full_name, 'tier', p.tier,
               'designation', p.designation, 'self', p.id = v_me.id,
               'can_edit', (p.id = v_me.id and v_me.tier >= 5) or (p.id <> v_me.id and (v_me.tier >= 5 or p.tier <= 3)),
               'ta_eligible', coalesce(hp.ta_eligible, true), 'track_location', coalesce(hp.track_location, true),
               'attendance_required', coalesce(hp.attendance_required, true),
               'shift', (select jsonb_build_object('effective_from', h.effective_from,
                                  'shift_start', to_char(h.shift_start, 'HH24:MI'), 'shift_end', to_char(h.shift_end, 'HH24:MI'),
                                  'grace_min', h.grace_min, 'weekly_off', to_jsonb(h.weekly_off), 'half_day_min', h.half_day_min)
                           from public.hr_shift_history h where h.profile_id = p.id and h.effective_from <= v_today
                          order by h.effective_from desc limit 1),
               'upcoming', (select coalesce(jsonb_agg(jsonb_build_object('effective_from', h.effective_from,
                                  'shift_start', to_char(h.shift_start, 'HH24:MI'), 'shift_end', to_char(h.shift_end, 'HH24:MI'),
                                  'grace_min', h.grace_min, 'weekly_off', to_jsonb(h.weekly_off), 'half_day_min', h.half_day_min)
                                  order by h.effective_from), '[]'::jsonb)
                              from public.hr_shift_history h where h.profile_id = p.id and h.effective_from > v_today))
             order by p.full_name, p.email), '[]'::jsonb)
        from public.profiles p
        left join public.hr_person hp on hp.profile_id = p.id
       where p.active and coalesce(p.is_staff, false)));
  end if;
  return v_out;
end $$;

-- §9.4.6 — tier 4+. Shift keys (shift_start, shift_end, grace_min,
-- weekly_off, half_day_min) take effective_from (default tomorrow) and write
-- the default shift row; the other keys apply at once.
create or replace function public.hr_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  k text;
  v_allowed constant text[] := array['shift_start', 'shift_end', 'grace_min', 'weekly_off', 'half_day_min', 'effective_from',
                                     'track_interval_s', 'track_distance_m', 'retention_days', 'ta_rate_per_km',
                                     'office_lat', 'office_lng', 'office_radius_m', 'max_session_h', 'attendance_from'];
  v_set public.hr_settings;
  v_from date;
  v_int int; v_dist int; v_ret int; v_rad int; v_maxh int;
  v_rate numeric; v_lat numeric; v_lng numeric;
  v_eff date;
begin
  if v_me.tier < 4 then raise exception 'NEO_DENIED: Only tier 4 and above can change attendance settings.'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEO_GATE: The request is empty.'; end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any (v_allowed)) then raise exception 'NEO_GATE: "%" is not a setting you can change here.', k; end if;
  end loop;
  select * into v_set from public.hr_settings where id = 1 for update;
  -- read and check everything before the first write
  v_int := case when p ? 'track_interval_s' then public._hr_int(p, 'track_interval_s', 'Tracking interval', 30, 600) end;
  v_dist := case when p ? 'track_distance_m' then public._hr_int(p, 'track_distance_m', 'Tracking distance', 25, 1000) end;
  v_ret := case when p ? 'retention_days' then public._hr_int(p, 'retention_days', 'Retention', 30, 365) end;
  v_rad := case when p ? 'office_radius_m' then public._hr_int(p, 'office_radius_m', 'Office radius', 50, 2000) end;
  v_maxh := case when p ? 'max_session_h' then public._hr_int(p, 'max_session_h', 'Longest shift', 4, 24) end;
  if p ? 'ta_rate_per_km' and jsonb_typeof(p -> 'ta_rate_per_km') <> 'null' then
    begin
      v_rate := public._jnum(p, 'ta_rate_per_km', 'Travel allowance rate');
    exception when others then v_rate := -1;
    end;
    if v_rate is null or v_rate < 0 or v_rate > 1000 then
      raise exception 'NEO_GATE: Travel allowance rate must be between 0 and 1000.';
    end if;
    v_rate := round(v_rate, 2);
  end if;
  if p ?| array['office_lat', 'office_lng'] then
    v_lat := public._jnum(p, 'office_lat', 'The office latitude');
    v_lng := public._jnum(p, 'office_lng', 'The office longitude');
    if (v_lat is null) <> (v_lng is null) then
      raise exception 'NEO_GATE: The office point needs both a latitude and a longitude.';
    end if;
    if v_lat is not null and (v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180) then
      raise exception 'NEO_GATE: That office point is not on the map.';
    end if;
  end if;
  if p ? 'attendance_from' then
    v_from := public._jdate(p, 'attendance_from', 'Attendance from');
    if v_from is null then raise exception 'NEO_GATE: Say from which day attendance counts.'; end if;
  end if;
  v_eff := public._hr_shift_write(null, p, lower(v_me.email));
  update public.hr_settings
     set track_interval_s = coalesce(v_int, track_interval_s),
         track_distance_m = coalesce(v_dist, track_distance_m),
         retention_days = coalesce(v_ret, retention_days),
         office_radius_m = coalesce(v_rad, office_radius_m),
         max_session_h = coalesce(v_maxh, max_session_h),
         attendance_from = coalesce(v_from, attendance_from),
         ta_rate_per_km = case when p ? 'ta_rate_per_km' then v_rate else ta_rate_per_km end,
         office_lat = case when p ?| array['office_lat', 'office_lng'] then v_lat else office_lat end,
         office_lng = case when p ?| array['office_lat', 'office_lng'] then v_lng else office_lng end,
         updated_by = lower(v_me.email), updated_at = now()
   where id = 1;
  -- Every session is folded with the current longest shift (runs end at its
  -- cap), so no cached day km survives a change of it (the final rows of
  -- purged days stay: they are the record). Locked in (email, day) order —
  -- the order readers cache in — then deleted.
  if v_maxh is not null and v_maxh is distinct from v_set.max_session_h then
    perform 1 from public.hr_day_km where not final order by employee_email, day for update;
    delete from public.hr_day_km where not final;
  end if;
  return public.hr_settings_get() || jsonb_build_object('ok', true, 'effective_from', v_eff);
end $$;

-- §9.4.6 — tier 4+, the staff hierarchy (a tier 4 changes only tier 1–3
-- accounts) and S19 (only a tier 5 may change their own row). Keys: the shift
-- keys (+ effective_from; null = use the default) and ta_eligible,
-- track_location, attendance_required (at once).
create or replace function public.hr_person_set(p_email text, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_t public.profiles;
  k text;
  v_allowed constant text[] := array['shift_start', 'shift_end', 'grace_min', 'weekly_off', 'half_day_min', 'effective_from',
                                     'ta_eligible', 'track_location', 'attendance_required'];
  v_ta boolean; v_tr boolean; v_ar boolean;
  v_eff date;
  v_hp public.hr_person;
begin
  if v_me.tier < 4 then raise exception 'NEO_DENIED: Only tier 4 and above can change attendance settings.'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEO_GATE: The request is empty.'; end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any (v_allowed)) then raise exception 'NEO_GATE: "%" is not a setting you can change here.', k; end if;
  end loop;
  v_t := public._hr_staff(p_email, false);
  if v_t.id is null then raise exception 'NEO_GATE: There is no staff account with that email.'; end if;
  if v_t.id = v_me.id and v_me.tier < 5 then perform public._hr_not_self(v_t.id, v_me.id); end if;
  if v_t.id <> v_me.id and v_me.tier < 5 and v_t.tier >= 4 then
    raise exception 'NEO_DENIED: Only the owner can change a tier 4 or 5 account.';
  end if;
  if p ? 'ta_eligible' then
    v_ta := public._jbool(p, 'ta_eligible', 'Travel allowance');
    if v_ta is null then raise exception 'NEO_GATE: Travel allowance must be yes or no.'; end if;
  end if;
  if p ? 'track_location' then
    v_tr := public._jbool(p, 'track_location', 'Route recording');
    if v_tr is null then raise exception 'NEO_GATE: Route recording must be yes or no.'; end if;
  end if;
  if p ? 'attendance_required' then
    v_ar := public._jbool(p, 'attendance_required', 'Attendance required');
    if v_ar is null then raise exception 'NEO_GATE: Attendance required must be yes or no.'; end if;
  end if;
  insert into public.hr_person (profile_id, updated_by) values (v_t.id, lower(v_me.email)) on conflict do nothing;
  v_eff := public._hr_shift_write(v_t.id, p, lower(v_me.email));
  update public.hr_person
     set ta_eligible = coalesce(v_ta, ta_eligible), track_location = coalesce(v_tr, track_location),
         attendance_required = coalesce(v_ar, attendance_required), updated_by = lower(v_me.email), updated_at = now()
   where profile_id = v_t.id
  returning * into v_hp;
  return jsonb_build_object('ok', true, 'email', lower(v_t.email), 'effective_from', v_eff,
    'person', jsonb_build_object('ta_eligible', v_hp.ta_eligible, 'track_location', v_hp.track_location,
                                 'attendance_required', v_hp.attendance_required,
                                 'shift_start', to_char(v_hp.shift_start, 'HH24:MI'), 'shift_end', to_char(v_hp.shift_end, 'HH24:MI'),
                                 'weekly_off', to_jsonb(v_hp.weekly_off)));
end $$;
perform public._hr_lockdown();
end $hr$;

do $hr$
begin
-- §9.7 — a month's travel allowance per person (approvers): days with km,
-- the month's km (sum of the day km values), rate (eligible × the settings
-- rate), amount; an approved month shows its snapshot plus live_km / changed.
create or replace function public.hr_ta_report(p_month date default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_now timestamptz := now();
  v_today date := public._hr_today(now());
  v_m date := date_trunc('month', coalesce(p_month, public._hr_today(now())))::date;
  v_set public.hr_settings;
  r record;
  v_mk jsonb; v_km numeric; v_rate numeric; v_elig boolean; v_ap public.hr_ta_approvals;
  v_people jsonb := '[]'::jsonb;
  v_closed boolean;
begin
  if not public.has_module('neohr', 'lead') then
    raise exception 'NEO_DENIED: Only a head or a NeoHR lead can see travel allowance.';
  end if;
  select * into v_set from public.hr_settings where id = 1;
  v_closed := v_m < date_trunc('month', v_today)::date;
  -- computed in email order (the order readers cache day km in), answered in name order
  for r in select p.* from public.profiles p
            where (p.active and coalesce(p.is_staff, false))
               or exists (select 1 from public.hr_ta_approvals a where a.profile_id = p.id and a.month = v_m)
            order by lower(p.email), p.id loop
    v_mk := public._hr_month_km(r.email, v_m, v_now);
    v_km := (v_mk ->> 'km')::numeric;
    v_elig := coalesce((select hp.ta_eligible from public.hr_person hp where hp.profile_id = r.id), true);
    v_rate := case when v_elig then v_set.ta_rate_per_km else 0 end;
    select * into v_ap from public.hr_ta_approvals a where a.profile_id = r.id and a.month = v_m;
    v_people := v_people || jsonb_build_array(jsonb_build_object(
      'email', lower(r.email), 'name', r.full_name, 'self', r.id = v_me.id, 'eligible', v_elig, 'days', v_mk -> 'days',
      'km', case when v_ap.month is not null then v_ap.km else v_km end,
      'rate', case when v_ap.month is not null then v_ap.rate else v_rate end,
      'amount', case when v_ap.month is not null then v_ap.amount when v_rate is not null then round(v_km * v_rate, 2) end,
      'live_km', v_km,
      'changed', v_ap.month is not null and v_km <> v_ap.km,
      'approved', case when v_ap.month is not null then
                         jsonb_build_object('by', v_ap.approved_by_name, 'at', v_ap.approved_at, 'note', v_ap.note) end,
      'can_approve', r.id <> v_me.id and v_closed and v_set.ta_rate_per_km is not null and v_elig and v_ap.month is null));
  end loop;
  select coalesce(jsonb_agg(x.value order by x.value ->> 'name', x.value ->> 'email'), '[]'::jsonb) into v_people
    from jsonb_array_elements(v_people) as x(value);
  return jsonb_build_object('now', v_now, 'month', v_m, 'closed', v_closed, 'rate', v_set.ta_rate_per_km, 'people', v_people);
end $$;

-- §9.7 — approve a finished month for one person, snapshotting km / rate /
-- amount. p_expected_km = the km the approver saw; a different live figure
-- answers {ok:false, reason:'changed', km} and writes nothing.
create or replace function public.hr_ta_approve(p_email text, p_month date, p_note text default null, p_expected_km numeric default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_t public.profiles;
  v_m date;
  v_set public.hr_settings;
  v_km numeric;
  v_amount numeric;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_ap public.hr_ta_approvals;
begin
  if not public.has_module('neohr', 'lead') then
    raise exception 'NEO_DENIED: Only a head or a NeoHR lead can approve travel allowance.';
  end if;
  v_t := public._hr_staff(p_email, false);
  if v_t.id is null then raise exception 'NEO_GATE: There is no staff account with that email.'; end if;
  if p_month is null then raise exception 'NEO_GATE: Say which month.'; end if;
  v_m := date_trunc('month', p_month)::date;
  perform public._hr_not_self(v_t.id, v_me.id);
  if v_m >= date_trunc('month', public._hr_today(now()))::date then
    raise exception 'NEO_GATE: Approve a month after it ends.';
  end if;
  select * into v_set from public.hr_settings where id = 1;
  if v_set.ta_rate_per_km is null then raise exception 'NEO_GATE: Set the travel allowance rate first.'; end if;
  if not coalesce((select hp.ta_eligible from public.hr_person hp where hp.profile_id = v_t.id), true) then
    raise exception 'NEO_GATE: % isn''t eligible for travel allowance.', v_t.full_name;
  end if;
  if char_length(coalesce(v_note, '')) > 300 then raise exception 'NEO_GATE: The note is too long — keep it under 300 characters.'; end if;
  v_km := (public._hr_month_km(v_t.email, v_m, now()) ->> 'km')::numeric;
  if v_km is distinct from p_expected_km then
    return jsonb_build_object('ok', false, 'reason', 'changed', 'km', v_km);
  end if;
  v_amount := round(v_km * v_set.ta_rate_per_km, 2);
  insert into public.hr_ta_approvals (profile_id, month, km, rate, amount, approved_by_email, approved_by_name, approved_at, note)
  values (v_t.id, v_m, v_km, v_set.ta_rate_per_km, v_amount, lower(v_me.email), v_me.full_name, now(), v_note)
  on conflict (profile_id, month) do nothing
  returning * into v_ap;
  if v_ap.profile_id is null then
    select * into v_ap from public.hr_ta_approvals a where a.profile_id = v_t.id and a.month = v_m;
    return jsonb_build_object('ok', false, 'reason', 'approved', 'by', v_ap.approved_by_name, 'at', v_ap.approved_at);
  end if;
  return jsonb_build_object('ok', true, 'km', v_ap.km, 'rate', v_ap.rate, 'amount', v_ap.amount);
end $$;

-- §9.7 — take an approval back: tier 4+, never your own, with a note.
create or replace function public.hr_ta_unapprove(p_email text, p_month date, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_t public.profiles;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_n int;
begin
  if v_me.tier < 4 then
    raise exception 'NEO_DENIED: Only tier 4 and above can take a travel allowance approval back.';
  end if;
  v_t := public._hr_staff(p_email, false);
  if v_t.id is null then raise exception 'NEO_GATE: There is no staff account with that email.'; end if;
  perform public._hr_not_self(v_t.id, v_me.id);
  if v_note is null then raise exception 'NEO_GATE: Say why you''re taking the approval back.'; end if;
  if p_month is null then raise exception 'NEO_GATE: Say which month.'; end if;
  delete from public.hr_ta_approvals where profile_id = v_t.id and month = date_trunc('month', p_month)::date;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'removed', v_n > 0);
end $$;
perform public._hr_lockdown();
end $hr$;


-- =============================================================================
-- §7  OLD CLIENTS — record_field_activity and tech_activity, redefined with
--     their exact v2 signatures (copied from sql/service-v2.sql; only the
--     marked v2.3 parts differ). Re-apply this file after any re-run of
--     service-v2.sql.
-- =============================================================================

do $hr$
begin
create or replace function public.record_field_activity(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_crid uuid;
  v_kind text; v_outcome text; v_at timestamptz;
  v_lat numeric; v_lng numeric; v_acc numeric;
  v_note text; v_media text; v_source text; v_module text; v_ref_type text; v_ref_id text;
  v_emp public.profiles; v_emp_email text; v_emp_name text; v_asked text;
  v_lead boolean := public.has_module('service', 'lead');
  v_id uuid;
  v_existing public.field_activity;
  v_job public.service_jobs;
  v_to text; v_stage text;
  v_applied boolean := false; v_applied_note text;
  v_implied boolean := false;
  v_absent boolean := false;
  v_vis boolean; v_body text; v_prev text;
  v_hr jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEO_GATE: The request is empty.'; end if;
  v_crid := public._juuid(p, 'client_request_id');
  if v_crid is null then
    raise exception 'NEO_GATE: client_request_id is required — make one UUID per action and reuse it on every retry.';
  end if;

  -- Idempotent: a retry of something already recorded returns what happened then.
  select * into v_existing from public.field_activity where client_request_id = v_crid;
  if found then
    if lower(v_existing.employee_email) <> lower(v_me.email) and not v_lead and v_me.tier < 3 then
      raise exception 'NEO_GATE: That request id was already used for someone else''s activity.';
    end if;
    return jsonb_build_object('id', v_existing.id, 'applied', v_existing.applied, 'applied_note', v_existing.applied_note,
      'duplicate', true,
      'stage', (select sj.stage from public.service_jobs sj
                 where v_existing.ref_type = 'service_job' and sj.id = v_existing.ref_id));
  end if;

  v_kind := public._vocab(public._jtxt(p, 'kind', 20, 'Kind'), 'field_kind', 'Activity kind');
  if v_kind is null then raise exception 'NEO_GATE: Say what happened (kind).'; end if;
  v_outcome := public._vocab(public._jtxt(p, 'outcome', 30, 'Outcome'), 'field_outcome', 'Visit outcome');
  v_at := coalesce(public._jts(p, 'at', 'The time'), now());
  -- A bad GPS fix must never make an offline replay fail forever: drop it, keep the record.
  v_lat := public._jnum(p, 'lat', 'The latitude');
  v_lng := public._jnum(p, 'lng', 'The longitude');
  v_acc := public._jnum(p, 'accuracy_m', 'The accuracy');
  if v_lat is null or v_lng is null or v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180 then
    v_lat := null; v_lng := null; v_acc := null;
  end if;
  if v_acc is not null and v_acc < 0 then v_acc := null; end if;
  v_note := public._jtxt(p, 'note', 2000, 'The note');
  v_media := public._jtxt(p, 'media_path', 500, 'The photo path');
  v_source := coalesce(public._vocab(public._jtxt(p, 'source', 20), 'field_source', 'Source'), 'desktop');
  v_module := coalesce(public._vocab(public._jtxt(p, 'module', 20), 'field_module', 'Module'), 'service');
  v_ref_type := coalesce(public._vocab(public._jtxt(p, 'ref_type', 20), 'field_ref_type', 'Reference type'), 'service_job');
  v_ref_id := public._jtxt(p, 'ref_id', 60, 'The reference id');

  -- v2.3 (neohr-hr.sql): attendance lives in attendance_events. A punch goes
  -- through hr_punch's lock, time rules and sequence check, always for the
  -- caller (employee_email is ignored), and writes no field_activity row.
  -- Its id is the client_request_id, so a replay is answered once.
  if v_kind in ('punch_in', 'punch_out') then
    begin
      v_hr := public._hr_punch_apply(v_me.email, v_crid, v_kind, public._jts(p, 'at', 'The time'), null,
                                     v_lat::double precision, v_lng::double precision, v_acc::double precision,
                                     left(v_note, 500));
    exception when raise_exception then
      if sqlerrm like 'NEO\_GATE: %' then
        return jsonb_build_object('id', v_crid, 'applied', false, 'applied_note', substr(sqlerrm, 11),
                                  'duplicate', false, 'stage', null);
      end if;
      raise;
    end;
    return jsonb_build_object('id', v_crid, 'applied', coalesce((v_hr ->> 'ok')::boolean, true),
                              'applied_note', case when v_hr ? 'voided' then 'HR voided this punch.' else 'Recorded.' end,
                              'duplicate', coalesce((v_hr ->> 'duplicate')::boolean, false), 'stage', null);
  end if;

  -- Always the signed-in person. A service lead may post for someone else
  -- (e.g. the assignee whose phone died); the desk may not.
  v_emp_email := v_me.email;
  v_emp_name := v_me.full_name;
  v_asked := public._jtxt(p, 'employee_email', 160, 'The employee');
  if v_asked is not null and lower(v_asked) <> lower(v_me.email) and v_lead then
    v_emp := public._staff_by_email(v_asked);
    if v_emp.id is not null then
      v_emp_email := v_emp.email;
      v_emp_name := v_emp.full_name;
    end if;
  end if;

  -- Record first: a duplicate racing this one hits the unique key and cannot
  -- apply the move a second time.
  insert into public.field_activity (client_request_id, employee_email, employee_name, module, ref_type, ref_id,
                                     kind, outcome, at, lat, lng, accuracy_m, note, media_path, source)
  values (v_crid, v_emp_email, v_emp_name, v_module, v_ref_type, v_ref_id, v_kind, v_outcome, v_at,
          v_lat::double precision, v_lng::double precision, v_acc::double precision, v_note, v_media, v_source)
  on conflict (client_request_id) do nothing
  returning id into v_id;
  if v_id is null then
    select * into v_existing from public.field_activity where client_request_id = v_crid;
    return jsonb_build_object('id', v_existing.id, 'applied', v_existing.applied,
                              'applied_note', v_existing.applied_note, 'duplicate', true, 'stage', null);
  end if;

  if v_ref_type = 'service_job' and v_ref_id is not null and v_kind in ('left_base', 'arrived', 'departed') then
    select * into v_job from public.service_jobs where id = v_ref_id for update;
    if not found then
      v_applied_note := 'No change: ticket not found.';
    elsif v_job.service_type <> 'on_site' then
      v_applied_note := 'No change: check-ins only move on-site tickets.';
      v_stage := v_job.stage;
    elsif not (v_lead or lower(coalesce(v_job.assignee_email, '')) = lower(v_emp_email)) then
      v_applied_note := case when v_job.assignee_email is null then 'No change: take the ticket from the queue first.'
                             else 'No change: this ticket is with ' || coalesce(v_job.assignee, v_job.assignee_email) || '.' end;
      v_stage := v_job.stage;
    else
      -- A18: a check-out is accepted from scheduled / en_route / on_site. From
      -- the first two the check-in was simply not pressed (no signal, forgot):
      -- the visit is counted and the timeline says it was assumed. A second
      -- check-out after the ticket moved past on_site changes nothing.
      v_implied := v_kind = 'departed' and v_outcome is not null and v_job.stage in ('scheduled', 'en_route');
      -- Nobody was there: the booked time is spent. SPEC-GAP: the SPEC sends the
      -- ticket back to scheduled, which kept the old slot, so the tracking page
      -- said "we are running late" and the board showed a late visit. It waits
      -- at revisit_needed with no visit time instead: the page says we'll call
      -- to book the follow-up, and the follow-up has a time budget of its own.
      v_absent := v_kind = 'departed' and v_outcome = 'customer_absent';
      v_to := case
        when v_kind = 'left_base' and v_job.stage in ('logged', 'scheduled', 'revisit_needed') then 'en_route'
        when v_kind = 'arrived' and v_job.stage in ('logged', 'scheduled', 'en_route', 'revisit_needed') then 'on_site'
        when v_kind = 'departed' and v_job.stage in ('scheduled', 'en_route', 'on_site') then
          case v_outcome when 'done'            then 'work_done'
                         when 'revisit_needed'  then 'revisit_needed'
                         when 'parts_needed'    then 'parts_to_order'
                         when 'customer_absent' then 'revisit_needed'
                         else null end
        else null end;
      if v_to is null then
        v_applied_note := case when v_kind = 'departed' and v_outcome is null and v_job.stage in ('scheduled', 'en_route', 'on_site')
                               then 'No change: say how the visit ended (outcome).'
                               else 'No change: ticket is at ' || public._svc_stage_label(v_job.stage) || '.' end;
        v_stage := v_job.stage;
      else
        v_prev := public._flag_set('neo.field');
        update public.service_jobs
           set stage = v_to,
               stage_since = case when v_to is distinct from stage then now() else stage_since end,
               visit_count = visit_count + case when v_to = 'on_site' or v_implied then 1 else 0 end,
               visit_start = case when v_absent then null else visit_start end,
               visit_end = case when v_absent then null else visit_end end
         where id = v_job.id;
        perform public._flag_restore('neo.field', v_prev);
        v_applied := true;
        v_stage := v_to;
        v_applied_note := case when v_to = v_job.stage then 'Recorded: ' || public._svc_stage_label(v_to) || '.'
                               else 'Moved to ' || public._svc_stage_label(v_to) || '.' end;
        if v_implied then
          perform public._svc_ev(v_job.id, 'field', 'Check-in was not recorded — assumed.', false, null, null,
            jsonb_build_object('field_activity_id', v_id, 'assumed', 'arrived', 'at', v_at, 'source', v_source),
            'staff', v_emp_email, v_emp_name);
        end if;
        v_vis := v_to in ('en_route', 'on_site', 'work_done') or v_absent;
        -- SPEC-GAP: a customer-visible move carries fixed customer wording; the
        -- technician's own note goes in a separate INTERNAL note, so a candid
        -- remark typed on a phone is never published to the tracking page.
        v_body := case when v_absent then 'We missed you at the visit — we''ll call you to book another time.'
                       else case v_to
                              when 'en_route'       then 'Our technician is on the way.'
                              when 'on_site'        then 'Our technician has arrived.'
                              when 'work_done'      then 'Work done on site. Tell us if anything is still wrong.'
                              when 'revisit_needed' then 'Visit ended — a follow-up visit is needed.'
                              when 'parts_to_order' then 'Visit ended — parts are needed.'
                            end
                  end;
        perform public._svc_ev(v_job.id, 'field', v_body, v_vis, v_job.stage, v_to,
          jsonb_build_object('field_activity_id', v_id, 'lat', v_lat, 'lng', v_lng, 'kind', v_kind,
                             'outcome', v_outcome, 'at', v_at, 'source', v_source),
          'staff', v_emp_email, v_emp_name);
        if v_note is not null then
          perform public._svc_ev(v_job.id, 'note', v_note, false, null, null,
                                 jsonb_build_object('field_activity_id', v_id), 'staff', v_emp_email, v_emp_name);
        end if;
      end if;
    end if;
  elsif v_kind in ('left_base', 'arrived', 'departed') then
    v_applied_note := 'Recorded. No ticket was named, so nothing moved.';
  else
    v_applied_note := 'Recorded.';
  end if;

  update public.field_activity set applied = v_applied, applied_note = v_applied_note where id = v_id;
  return jsonb_build_object('id', v_id, 'applied', v_applied, 'applied_note', v_applied_note,
                            'stage', v_stage, 'duplicate', false);
end $$;

create or replace function public.tech_activity(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_all boolean := public.has_module('service', 'lead') or public.has_module('neohr', 'lead');
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_to date := coalesce(p_to, v_today);
  v_from date := coalesce(p_from, coalesce(p_to, v_today) - 30);
  v_lo timestamptz;
  v_hi timestamptz;
begin
  if v_to < v_from then raise exception 'NEO_GATE: The end date is before the start date.'; end if;
  if v_to - v_from > 366 then raise exception 'NEO_GATE: Ask for at most a year at a time.'; end if;
  v_lo := v_from::timestamp at time zone 'Asia/Kolkata';
  v_hi := (v_to + 1)::timestamp at time zone 'Asia/Kolkata';

  return coalesce((
    with ev as (
      select lower(fa.employee_email) as employee_email,
             (fa.at at time zone 'Asia/Kolkata')::date as day,
             fa.kind, fa.outcome, fa.at, fa.employee_name as name, true as self_action
        from public.field_activity fa
       where fa.at >= v_lo and fa.at < v_hi and fa.kind not in ('punch_in', 'punch_out')
         and (v_all or lower(fa.employee_email) = lower(v_me.email))
      union all
      -- v2.3: punches come from attendance_events (non-voided), the only attendance record
      select ae.employee_email, (ae.at at time zone 'Asia/Kolkata')::date, ae.kind, null, ae.at, null, true
        from public.attendance_events ae
       where ae.voided_at is null and ae.at >= v_lo and ae.at < v_hi
         and (v_all or ae.employee_email = lower(v_me.email))
      union all
      select lower(se.meta ->> 'tech_email'),
             (se.at at time zone 'Asia/Kolkata')::date,
             'ev_' || se.kind, null, se.at, null,
             coalesce(lower(se.meta ->> 'by_email'), lower(se.meta ->> 'tech_email')) = lower(se.meta ->> 'tech_email')
        from public.service_events se
       where se.kind in ('claim', 'release', 'assign') and se.meta ? 'tech_email'
         and se.at >= v_lo and se.at < v_hi
         and (v_all or lower(se.meta ->> 'tech_email') = lower(v_me.email))
    ),
    agg as (
      select ev.employee_email,
             ev.day,
             coalesce(max(pr.full_name), max(ev.name)) as employee_name,
             count(*) filter (where ev.kind = 'ev_claim') as claims,
             count(*) filter (where ev.kind = 'ev_release' and ev.self_action) as releases,
             count(*) filter (where ev.kind = 'ev_release' and not ev.self_action) as released_by_lead,
             count(*) filter (where ev.kind = 'ev_assign') as manager_assigns,
             count(*) filter (where ev.kind = 'left_base') as visits_left,
             count(*) filter (where ev.kind = 'arrived') as visits_arrived,
             count(*) filter (where ev.kind = 'departed' and ev.outcome = 'done') as visits_done,
             count(*) filter (where ev.kind = 'departed' and ev.outcome = 'revisit_needed') as revisits,
             count(*) filter (where ev.kind = 'departed' and ev.outcome = 'parts_needed') as parts_needed,
             count(*) filter (where ev.kind = 'departed' and ev.outcome = 'customer_absent') as customer_absent,
             count(*) filter (where ev.kind = 'punch_in') as punch_ins,
             count(*) filter (where ev.kind = 'punch_out') as punch_outs,
             min(ev.at) as first_at,
             max(ev.at) as last_at
        from ev
        left join public.profiles pr on lower(pr.email) = ev.employee_email
       where ev.employee_email is not null
       group by ev.employee_email, ev.day
    )
    select jsonb_agg(to_jsonb(agg) order by agg.day desc, agg.employee_email) from agg), '[]'::jsonb);
end $$;

-- The legacy backfill (§2) once more, in the same statement that switches
-- record_field_activity over: a punch an old phone posted through the v2
-- function after the first backfill ran — between the parts of a split
-- deploy, or while service-v2.sql was re-run before this file — moves over
-- too. Same ids, ON CONFLICT DO NOTHING: nothing is copied twice.
insert into public.attendance_events (id, profile_id, employee_email, kind, at, device_at, time_source,
                                      lat, lng, accuracy_m, source, note, created_by_email, received_at)
select lf.client_request_id, lp.id, lower(lf.employee_email), lf.kind, lf.at, lf.at, 'device',
       lf.lat, lf.lng, lf.accuracy_m, 'phone', 'migrated from field_activity',
       lower(lf.employee_email), lf.received_at
  from public.field_activity lf
  left join public.profiles lp on lower(lp.email) = lower(lf.employee_email)
 where lf.kind in ('punch_in', 'punch_out')
on conflict (id) do nothing;
perform public._hr_lockdown();
end $hr$;


-- =============================================================================
-- §8  FUNCTION PRIVILEGES — once more over everything (each block above
--     already did it for what existed then): _hr_* internals to service_role
--     only; the API, record_field_activity and tech_activity to authenticated
--     and service_role; nothing to anon.
-- =============================================================================

select public._hr_lockdown();

-- =============================================================================
-- End of neohr_hr_v2_3. Run sql/neohr-hr.tests.sql next (it rolls back).
-- =============================================================================
