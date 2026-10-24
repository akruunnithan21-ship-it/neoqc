-- =============================================================================
-- NEO TOKYO OPERATIONS — HR v2.4: field staff, verified punches, punch
-- reasons, away punches, punch selfies, on-site / RMA trips
-- Migration names: neohr_hr_v2_4_part01 … neohr_hr_v2_4_part10 (the parts
-- below, in order)                              Target: Postgres 17 on Supabase
-- Ships with NeoHR 2.3.0 and Neo OS 1.12.1 (contract version 5, §15).
-- -----------------------------------------------------------------------------
-- A DELTA ON TOP OF v2.3 (the precedent is service-v2.1.sql)
-- DEPLOY ORDER
--   1. sql/service-v2.sql, sql/service-v2.1.sql      (live)
--   2. sql/work-queue.sql                            (live, v2.2)
--   3. sql/neohr-hr.sql                              (live, v2.3)
--   4. sql/neohr-hr-v2.4.sql                         (this file)
--   5. sql/neohr-hr-v2.4-overview.sql                (neo_overview, §1.7)
--   Apply this file after neohr-hr.sql — and again after ANY re-run of
--   neohr-hr.sql or of work-queue.sql: it redefines functions of both
--   (listed below), and a re-run of neohr-hr.sql also gives authenticated its
--   select on attendance_events back. This file is re-runnable on its own:
--   a second run keeps every person's switches, request, trip and photo (the
--   field-staff seed only runs while hr_person.track_location still defaults
--   to true, i.e. the first time).
--   ROLLBACK = re-run sql/neohr-hr.sql. That is safe because every function
--   redefined here keeps exactly its v2.3 / v2.2 arguments and return type
--   and stays the only one of its name (rule R1, tested). The v2.4 tables and
--   columns stay (v2.3 never reads them); the new RPCs stay callable.
--   Tests: sql/neohr-hr-v2.4.tests.sql (one transaction, ends in ROLLBACK);
--   sql/neohr-hr.tests.sql passes on top of this file too.
--
-- THREAT MODEL
--   Anyone can sign in with the anon key from the APK plus an email / PIN and
--   call any RPC with any JSON. The phone's own checks (fake-GPS flag, fix
--   accuracy, camera only, the reason sheets) stop casual misuse only. What
--   the server controls itself: the place and the distance to the office (it
--   computes them from the fix), received_at against the punch time, when the
--   selfie arrived against when the punch arrived, the auth session id and
--   its user agent, byte-identical photos, per-day caps, and HR's own look at
--   the photos (hr_punch_checks). A non-field punch the server cannot place at
--   the shop never counts until HR approves it — whatever the payload says.
--
-- WHAT THIS DOES (owner decisions D1–D16, NEOHR-2.3-SPEC §1)
--   * Field staff (D1): hr_person.track_location IS the switch ("Field staff —
--     route, trips and travel allowance"). Seeded once: active staff in the
--     service pool (exactly 5 people, the owner among them); everyone else and
--     every new person is not field staff (defaults false). Only field staff
--     record a route, take trips and get travel allowance.
--   * Verified punches (D2, D3, D5, D6, D9): every punch keeps what the server
--     made of it — place (office / away / unknown / unset), metres to the
--     office, verify (ok / weak_fix / no_fix / mock / old_app / restored / hr),
--     flags (sent_late, new_login, odd_client, no_ticket, ticket_not_mine,
--     selfie_skip, selfie_time, mock_route, emulator, request_failed), the
--     reason the phone sent. A field
--     engineer's late or away punch-in with a reason becomes a punch_reason
--     request (On-site / RMA away from the shop excuse the late mark at once);
--     a non-field punch in / out the server cannot place at the shop becomes
--     an away_punch request, and that session counts only once HR approves.
--   * Selfies (D9): one small JPEG per punch in / out, in the database
--     (hr_punch_selfies, ≤ 60 KB, ≤ 8 a day, the store capped at 200 MB),
--     seen only by approvers (every full view logged), deleted after
--     retention_days.
--   * Trips (D7, D8): hr_trip_start / hr_trip_end while punched in; a trip
--     ends at End trip or with its session; its km is measured on the route
--     points of its window and is the travel allowance basis.
--   * End of day (D4): punch requests carry due_at; past_eod is lazy (no cron).
--   * Approvers (D10): a neohr lead, never on their own request; a tier 4 / 5
--     account's requests only by tier 4+ (_hr_can_decide).
--
-- RULES (tested in sql/neohr-hr-v2.4.tests.sql)
--   R1 every redefined function keeps its identity arguments and return type
--      and stays the only overload; _hr_ctx is not redefined; _hr_punch_apply
--      keeps its 9 arguments; _hr_purge(p_max_rows int) keeps its signature.
--   R2 hr_punch never raises because of a v2.4 key: they are read leniently
--      (_hr_punch_extras: bad → dropped, listed in check.dropped); the
--      request, the trip and the trip ends run in their own sub-blocks. Only
--      v2.3's checks and the new 30-a-day cap refuse a punch.
--   R3 NEO_DENIED comes only from _neo_me() in anything new; business
--      refusals are NEO_GATE (hr_request_decide's too: 2.2.0 wipes its queue
--      on NEO_DENIED).
--   R4 part 01 redefines _hr_lockdown with the whole v2.4 API before anything
--      new exists; every DO block ends with it; new tables have RLS and no
--      client grant at all; authenticated loses its select on
--      attendance_events (no client reads it; the coordinates stay inside).
--   R5 every attendance writer takes the person's advisory lock; writes only
--      in volatile code, never in a STABLE helper.
--   R6 caps: 30 phone punches a person a day; photos 2000–60000 bytes, 8 a
--      person a day, refused once the store passes 200 MB. Nothing new is in
--      supabase_realtime.
--
-- REDEFINED (v2.3 neohr-hr.sql unless marked)
--   _hr_lockdown, _hr_tracking, location_push, hr_settings_get, hr_person_set,
--   hr_punch, _hr_punch_apply, hr_my_day, hr_my_month, hr_register, hr_route,
--   hr_dashboard, hr_board, _hr_live, _hr_day_calc, _hr_days,
--   hr_request_decide, hr_request_cancel, hr_requests_list, _hr_req_json,
--   hr_ta_report, hr_ta_approve, _hr_purge, hr_correct,
--   my_work_profile (work-queue.sql v2.2)
-- NEW
--   _hr_is_field, _hr_dash_view, _hr_place, _hr_can_decide, _hr_decide_gate,
--   _hr_sees, _hr_selfie_brief, _hr_unverified, _hr_day_totals,
--   _hr_is_late_punch, _hr_punch_extras, _hr_punch_core, _hr_punch_check,
--   _hr_punch_request, _hr_session_at, _hr_trip_eff, _hr_trip_measure,
--   _hr_trip_json, _hr_trip_sync, _hr_trip_begin, _hr_day_trips,
--   _hr_month_trip_km, _hr_trip_km_days, _hr_req_acts, _hr_dash_hr, _hr_msg,
--   hr_selfie_put, hr_selfie_get, hr_punch_checks, hr_punch_request_decide,
--   hr_trip_start, hr_trip_end
--   (neo_overview / neo_overview_list: sql/neohr-hr-v2.4-overview.sql; their
--   grants are in _hr_lockdown's API list below)
--
-- CONVENTIONS (as v2.3): NEO_GATE: <a human sentence>; every API RPC is
-- security definer, search_path = public, and starts with v_me :=
-- public._neo_me(); India time everywhere (_hr_today / _hr_at, never
-- current_date); internals sit in DO blocks that end with _hr_lockdown().
-- Nothing here deletes customer data.
-- =============================================================================

set local lock_timeout = '5s';


-- ── part 01: the API list (before anything new exists) ──────────────────────
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
    'hr_holiday_set', 'hr_dashboard', 'record_field_activity', 'tech_activity',
    -- v2.4
    'hr_selfie_put', 'hr_selfie_get', 'hr_punch_checks', 'hr_punch_request_decide', 'hr_trip_start', 'hr_trip_end',
    'neo_overview', 'neo_overview_list', 'my_work_profile'];
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
perform public._hr_lockdown();
end $hr$;


-- ── part 02: columns, constraints, the new tables (each with RLS, no grant) ─
do $hr$
begin
  -- What the server made of each punch (all nullable: v2.3 rows stay as they are).
  alter table public.attendance_events add column if not exists place text;
  alter table public.attendance_events add column if not exists office_m int;
  alter table public.attendance_events add column if not exists fix_at timestamptz;
  alter table public.attendance_events add column if not exists fix_age_ms int;
  alter table public.attendance_events add column if not exists mock boolean;
  alter table public.attendance_events add column if not exists verify text;
  alter table public.attendance_events add column if not exists flags text[];
  alter table public.attendance_events add column if not exists device_flags jsonb;
  alter table public.attendance_events add column if not exists reason_kind text;
  alter table public.attendance_events add column if not exists reason_text text;
  alter table public.attendance_events add column if not exists reason_ref text;
  alter table public.attendance_events add column if not exists request_id uuid;
  alter table public.attendance_events add column if not exists selfie_skip text;
  alter table public.attendance_events add column if not exists app_code int;
  alter table public.attendance_events add column if not exists auth_session uuid;
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_events'::regclass and conname = 'attendance_events_place_check') then
    alter table public.attendance_events add constraint attendance_events_place_check check (place is null or place in ('office', 'away', 'unknown', 'unset'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_events'::regclass and conname = 'attendance_events_verify_check') then
    alter table public.attendance_events add constraint attendance_events_verify_check check (verify is null or verify in ('ok', 'weak_fix', 'no_fix', 'mock', 'old_app', 'restored', 'hr'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_events'::regclass and conname = 'attendance_events_reason_kind_check') then
    alter table public.attendance_events add constraint attendance_events_reason_kind_check check (reason_kind is null or reason_kind in ('late', 'on_site', 'rma', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_events'::regclass and conname = 'attendance_events_reason_text_check') then
    alter table public.attendance_events add constraint attendance_events_reason_text_check check (reason_text is null or char_length(reason_text) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_events'::regclass and conname = 'attendance_events_reason_ref_check') then
    alter table public.attendance_events add constraint attendance_events_reason_ref_check check (reason_ref is null or char_length(reason_ref) <= 20);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.attendance_events'::regclass and conname = 'attendance_events_selfie_skip_check') then
    alter table public.attendance_events add constraint attendance_events_selfie_skip_check check (selfie_skip is null or selfie_skip in ('camera_error', 'no_front_camera'));
  end if;
  -- No client reads attendance_events directly (every reader is a definer RPC):
  -- the punch coordinates, fixes and reasons stay inside.
  revoke select on table public.attendance_events from authenticated;

  -- Requests a punch makes (punch_reason, away_punch).
  alter table public.hr_requests drop constraint if exists hr_requests_kind_check;
  alter table public.hr_requests add constraint hr_requests_kind_check check (kind in ('late_start', 'early_leave', 'flexible_day', 'field_day', 'missed_punch', 'leave', 'punch_reason', 'away_punch'));
  alter table public.hr_requests add column if not exists event_id uuid;
  alter table public.hr_requests add column if not exists due_at timestamptz;
  alter table public.hr_requests add column if not exists reason_kind text;
  alter table public.hr_requests add column if not exists place text;
  alter table public.hr_requests add column if not exists office_m int;
  if not exists (select 1 from pg_constraint where conrelid = 'public.hr_requests'::regclass and conname = 'hr_requests_reason_kind_check') then
    alter table public.hr_requests add constraint hr_requests_reason_kind_check check (reason_kind is null or reason_kind in ('late', 'on_site', 'rma', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.hr_requests'::regclass and conname = 'hr_requests_place_check') then
    alter table public.hr_requests add constraint hr_requests_place_check check (place is null or place in ('office', 'away', 'unknown', 'unset'));
  end if;
  create unique index if not exists hrq_event_idx on public.hr_requests (event_id) where event_id is not null;

  -- One photo per punch in / out. The bytes are already compressed (no TOAST
  -- compression); the md5 makes a re-used photo visible.
  create table if not exists public.hr_punch_selfies (
    event_id       uuid primary key,
    profile_id     uuid references public.profiles(id) on delete set null,
    employee_email text not null check (employee_email = lower(employee_email)),
    event_at       timestamptz not null,
    taken_at       timestamptz,
    jpeg           bytea not null,
    thumb          bytea check (thumb is null or octet_length(thumb) <= 8192),
    bytes          int not null check (bytes between 2000 and 60000),
    width          int check (width is null or width between 1 and 10000),
    height         int check (height is null or height between 1 and 10000),
    md5            text not null,
    late           boolean not null default false,
    received_at    timestamptz not null default now()
  );
  alter table public.hr_punch_selfies alter column jpeg set storage external;
  alter table public.hr_punch_selfies alter column thumb set storage external;
  create unique index if not exists hrps_md5_idx on public.hr_punch_selfies (md5);
  create index if not exists hrps_email_idx on public.hr_punch_selfies (employee_email, event_at);
  create index if not exists hrps_event_at_idx on public.hr_punch_selfies (event_at);
  alter table public.hr_punch_selfies enable row level security;
  revoke all on table public.hr_punch_selfies from anon, authenticated;

  -- Every full view of a punch photo (hr_selfie_get).
  create table if not exists public.hr_selfie_views (
    id           bigint generated always as identity primary key,
    viewer_email text not null,
    event_id     uuid not null,
    at           timestamptz not null default now()
  );
  create index if not exists hrsv_event_idx on public.hr_selfie_views (event_id);
  create index if not exists hrsv_at_idx on public.hr_selfie_views (at);
  alter table public.hr_selfie_views enable row level security;
  revoke all on table public.hr_selfie_views from anon, authenticated;

  -- On-site / RMA trips (field staff). ended_at is what a writer stored; the
  -- effective end (_hr_trip_eff) is never later than the trip's session.
  create table if not exists public.hr_trips (
    id             uuid primary key,
    profile_id     uuid references public.profiles(id) on delete set null,
    employee_email text not null check (employee_email = lower(employee_email)),
    kind           text not null check (kind in ('on_site', 'rma')),
    ref_code       text check (ref_code is null or char_length(ref_code) <= 20),
    ref_id         text,
    ref_title      text check (ref_title is null or char_length(ref_title) <= 200),
    note           text check (note is null or char_length(note) <= 200),
    started_at     timestamptz not null,
    start_source   text not null default 'phone' check (start_source in ('phone', 'punch_in', 'hr')),
    start_lat      double precision,
    start_lng      double precision,
    start_acc      double precision,
    ended_at       timestamptz,
    end_source     text check (end_source is null or end_source in ('phone', 'punch_out', 'cap', 'next_trip', 'hr')),
    end_reason     text check (end_reason is null or end_reason in ('tapped', 'punch_out', 'cap', 'next_trip', 'hr')),
    end_lat        double precision,
    end_lng        double precision,
    end_acc        double precision,
    km             numeric(8,2),
    moving_min     int,
    stops          int,
    fp             text,
    final          boolean not null default false,
    flags          text[] not null default '{}',
    received_at    timestamptz not null default now(),
    voided_at      timestamptz,
    voided_by      text,
    void_reason    text check (void_reason is null or char_length(void_reason) <= 500),
    constraint hr_trips_note_or_ref check (ref_code is not null or char_length(coalesce(note, '')) >= 3)
  );
  create index if not exists hrt_email_start_idx on public.hr_trips (employee_email, started_at);
  alter table public.hr_trips enable row level security;
  revoke all on table public.hr_trips from anon, authenticated;

  if pg_get_serial_sequence('public.hr_selfie_views', 'id') is not null then
    execute format('revoke all on sequence %s from anon, authenticated', pg_get_serial_sequence('public.hr_selfie_views', 'id'));
  end if;
  perform public._hr_lockdown();
end $hr$;


-- ── part 03: helpers nothing older calls (no behaviour changes yet) ─────────
do $hr$
begin
-- D1: field staff = hr_person.track_location (no row: not field staff).
create or replace function public._hr_is_field(p_profile uuid)
returns boolean language sql stable set search_path = public as $$
  select coalesce((select hp.track_location from public.hr_person hp where hp.profile_id = p_profile), false)
$$;

-- §6: which dashboard a person gets — the first that matches, from the
-- profile's OWN tier and roles (never the caller's): head (tier 3+) · hr
-- (a NeoHR lead role) · field (field staff) · desk (department support /
-- service desk / front desk) · supply (department procurement, logistics) ·
-- desk (a service / RMA / Builds desk role) · sales (department sales, or
-- "sales" in the designation) · basic. The departments come before the desk
-- role: procurement and logistics staff often hold a desk role for their
-- tickets and still get the supply dashboard (a change to the spec's order).
create or replace function public._hr_dash_view(p_profile uuid)
returns text language plpgsql stable set search_path = public as $$
declare
  v public.profiles;
  v_dept text;
begin
  select * into v from public.profiles p where p.id = p_profile;
  if v.id is null then return 'basic'; end if;
  if coalesce(v.tier, 0) >= 3 then return 'head'; end if;
  if exists (select 1 from public.module_access ma where ma.profile_id = v.id and ma.module = 'neohr' and ma.role = 'lead') then
    return 'hr';
  end if;
  if public._hr_is_field(v.id) then return 'field'; end if;
  v_dept := lower(btrim(coalesce(v.department, '')));
  if v_dept in ('support', 'service desk', 'front desk') then return 'desk'; end if;
  if v_dept in ('procurement', 'logistics') then return 'supply'; end if;
  if exists (select 1 from public.module_access ma
              where ma.profile_id = v.id and ma.module in ('service', 'rma', 'qc') and ma.role = 'desk') then
    return 'desk';
  end if;
  if v_dept = 'sales' or coalesce(v.designation, '') ilike '%sales%' then return 'sales'; end if;
  return 'basic';
end $$;

-- §1.3.3 — where a fix puts a punch: {place, office_m, verify}. No office
-- point → unset. No fix (or no accuracy) → unknown / no_fix. Accuracy over
-- 100 m → office (weak_fix) only when the centre is within the radius, else
-- unknown (weak_fix); 50–100 m → by distance, weak_fix; ≤ 50 m → by
-- distance, ok. office_m = metres to the office point, rounded.
create or replace function public._hr_place(p_lat double precision, p_lng double precision, p_acc double precision)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_set public.hr_settings;
  v_d float8;
  v_verify text;
  v_place text;
begin
  select * into v_set from public.hr_settings where id = 1;
  if p_lat is not null and p_lng is not null and v_set.office_lat is not null then
    v_d := public._hr_hav(p_lat, p_lng, v_set.office_lat, v_set.office_lng);
  end if;
  v_verify := case when p_lat is null or p_lng is null or p_acc is null then 'no_fix'
                   when p_acc <= 50 then 'ok'
                   else 'weak_fix' end;
  v_place := case when v_set.office_lat is null then 'unset'
                  when v_verify = 'no_fix' then 'unknown'
                  when p_acc > 100 then case when v_d <= v_set.office_radius_m then 'office' else 'unknown' end
                  when v_d <= v_set.office_radius_m then 'office'
                  else 'away' end;
  return jsonb_build_object('place', v_place, 'office_m', case when v_d is not null then round(v_d)::int end, 'verify', v_verify);
end $$;

-- D10 — may p_decider decide a request of p_requester (an email)? Not their
-- own; a tier 4 / 5 account's only by tier 4+; and only a NeoHR lead (tier 3+
-- always are). Both decide RPCs, can_decide and the waiting counts use it.
create or replace function public._hr_can_decide(p_decider uuid, p_requester text)
returns boolean language plpgsql stable set search_path = public as $$
declare
  v_d public.profiles;
  v_tier int;
  v_id uuid;
begin
  select * into v_d from public.profiles p where p.id = p_decider and p.active and coalesce(p.is_staff, false);
  if v_d.id is null then return false; end if;
  if lower(btrim(coalesce(p_requester, ''))) = lower(v_d.email) then return false; end if;
  select p.id, p.tier into v_id, v_tier from public.profiles p
   where lower(p.email) = lower(btrim(coalesce(p_requester, ''))) order by p.active desc limit 1;
  if v_id = v_d.id then return false; end if;
  if coalesce(v_tier, 0) >= 4 and coalesce(v_d.tier, 0) < 4 then return false; end if;
  return coalesce(public._module_role_of(v_d.id, 'neohr'), '') = 'lead';
end $$;

-- The refusals of _hr_can_decide for a lead, as sentences (R3: NEO_GATE).
create or replace function public._hr_decide_gate(p_me public.profiles, r public.hr_requests)
returns void language plpgsql stable set search_path = public as $$
declare v_tier int;
begin
  if r.employee_email = lower(p_me.email) or (r.profile_id is not null and r.profile_id = p_me.id) then
    raise exception 'NEO_GATE: Someone else has to approve or change your own attendance, duty or travel allowance.';
  end if;
  select p.tier into v_tier from public.profiles p where lower(p.email) = r.employee_email order by p.active desc limit 1;
  if coalesce(v_tier, 0) >= 4 and coalesce(p_me.tier, 0) < 4 then
    raise exception 'NEO_GATE: Requests from a tier 4 or 5 account are decided by tier 4 and above.';
  end if;
end $$;

-- What p_me may do with a request — hr_requests_list's rows and
-- hr_my_day.requests (one rule for both): can_decide = an approver (p_appr),
-- pending, _hr_can_decide (D10); can_cancel = never an away punch; the owner
-- while pending, or approved and not started yet (not a missed punch); an
-- approver someone else's pending or approved one (not an approved missed
-- punch).
create or replace function public._hr_req_acts(r public.hr_requests, p_me public.profiles, p_appr boolean)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'can_decide', coalesce(p_appr, false) and r.status = 'pending' and public._hr_can_decide(p_me.id, r.employee_email),
    'can_cancel', r.kind <> 'away_punch'
                  and ((r.employee_email = lower(p_me.email)
                        and (r.status = 'pending'
                             or (r.status = 'approved' and r.kind <> 'missed_punch' and r.date_from > public._hr_today(now()))))
                       or (coalesce(p_appr, false) and r.employee_email <> lower(p_me.email) and r.status in ('pending', 'approved')
                           and not (r.status = 'approved' and r.kind = 'missed_punch'))))
$$;

-- Photo visibility: the person themselves, or a NeoHR lead — a tier 4 / 5
-- account's photos only to tier 4+.
create or replace function public._hr_sees(p_viewer uuid, p_subject text)
returns boolean language plpgsql stable set search_path = public as $$
declare
  v_v public.profiles;
  v_tier int;
begin
  select * into v_v from public.profiles p where p.id = p_viewer and p.active and coalesce(p.is_staff, false);
  if v_v.id is null then return false; end if;
  if lower(v_v.email) = lower(btrim(coalesce(p_subject, ''))) then return true; end if;
  if coalesce(public._module_role_of(v_v.id, 'neohr'), '') <> 'lead' then return false; end if;
  select p.tier into v_tier from public.profiles p where lower(p.email) = lower(btrim(coalesce(p_subject, ''))) order by p.active desc limit 1;
  return coalesce(v_tier, 0) <= 3 or coalesce(v_v.tier, 0) >= 4;
end $$;

-- A punch's photo for a viewer: {thumb_b64 (only when the viewer may see it),
-- has_thumb (there is a thumb the viewer may see), late, taken_at, w, h,
-- seen_by_me, seen_by_any} or null (no photo).
create or replace function public._hr_selfie_brief(p_event_id uuid, p_viewer uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
           'thumb_b64', case when x.vis then replace(encode(s.thumb, 'base64'), E'\n', '') end,
           'has_thumb', x.vis,
           'late', s.late, 'taken_at', s.taken_at, 'w', s.width, 'h', s.height,
           'seen_by_me', exists (select 1 from public.hr_selfie_views v
                                  where v.event_id = s.event_id
                                    and lower(v.viewer_email) = (select lower(p.email) from public.profiles p where p.id = p_viewer)),
           'seen_by_any', exists (select 1 from public.hr_selfie_views v where v.event_id = s.event_id))
    from public.hr_punch_selfies s
    cross join lateral (select s.thumb is not null and public._hr_sees(p_viewer, s.employee_email) as vis) x
   where s.event_id = p_event_id
$$;

-- §1.3 — a phone punch in / out that needs a look: not verified ok, any flag,
-- no photo 10 minutes on, the camera skipped, a late photo, or a non-field
-- punch away from the shop on a day that is not work from home.
create or replace function public._hr_unverified(e public.attendance_events, p_now timestamptz)
returns boolean language plpgsql stable set search_path = public as $$
declare
  s public.hr_punch_selfies;
  v_d date;
  v_duty text;
begin
  if e.id is null or e.kind not in ('punch_in', 'punch_out') or e.source <> 'phone' or e.voided_at is not null then
    return false;
  end if;
  select * into s from public.hr_punch_selfies x where x.event_id = e.id;
  if coalesce(e.verify, 'old_app') <> 'ok' or coalesce(cardinality(e.flags), 0) > 0 or e.selfie_skip is not null
     or (s.event_id is null and e.at < p_now - interval '10 minutes') or coalesce(s.late, false) then
    return true;
  end if;
  if not public._hr_is_field(e.profile_id) and coalesce(e.place, 'unknown') not in ('office', 'unset') then
    v_d := (e.at at time zone 'Asia/Kolkata')::date;
    select c.duty into v_duty from public._hr_ctx(e.profile_id, e.employee_email, v_d, v_d) c;
    return v_duty is distinct from 'wfh';
  end if;
  return false;
end $$;

-- Month totals of day records: an away_pending day counts under away_pending,
-- not as present, late or half day; worked hours leave pending minutes out
-- (the day records already do).
create or replace function public._hr_day_totals(p_days jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'present', count(*) filter (where d.value ->> 'status' = 'present' and not coalesce((d.value ->> 'away_pending')::boolean, false)),
    'late', count(*) filter (where d.value ->> 'status' = 'late' and not coalesce((d.value ->> 'away_pending')::boolean, false)),
    'half_day', count(*) filter (where d.value ->> 'status' = 'half_day' and not coalesce((d.value ->> 'away_pending')::boolean, false)),
    'away_pending', count(*) filter (where coalesce((d.value ->> 'away_pending')::boolean, false)),
    'absent', coalesce(sum((d.value ->> 'absent_units')::numeric), 0),
    'leave', coalesce(sum((d.value ->> 'leave_units')::numeric), 0),
    'off', count(*) filter (where d.value ->> 'status' = 'off'),
    'worked_hours', round(coalesce(sum((d.value ->> 'worked_min')::numeric), 0) / 60, 2))
    from jsonb_array_elements(coalesce(p_days, '[]'::jsonb)) as d(value)
$$;

-- §1.3.5 — late at punch time (the same rule on the phone): this punch_in
-- starts the FIRST session of its day (per the fold); floor((at − (shift
-- start + grace)) / 60) > 0 with that day's _hr_ctx; not a flexible day, not a
-- half-day leave, duty not field / leave / off, attendance required.
create or replace function public._hr_is_late_punch(p_email text, p_profile uuid, p_id uuid, p_at timestamptz)
returns boolean language plpgsql stable set search_path = public as $$
declare
  v_d date := (p_at at time zone 'Asia/Kolkata')::date;
  v_first jsonb;
  c record;
begin
  v_first := public._hr_day_sessions(p_email, v_d, now()) -> 0;
  if v_first is null or v_first ->> 'in_id' is distinct from p_id::text then return false; end if;
  select * into c from public._hr_ctx(p_profile, lower(btrim(p_email)), v_d, v_d);
  if c.flex_request or c.half_day_leave or c.duty in ('field', 'leave', 'off') then return false; end if;
  if not coalesce((select hp.attendance_required from public.hr_person hp where hp.profile_id = p_profile), true) then return false; end if;
  return floor(extract(epoch from p_at - (public._hr_at(v_d, c.shift_start) + make_interval(mins => c.grace_min))) / 60) > 0;
end $$;

-- The text after the NEO_<KIND>: prefix (for check.trip.message).
create or replace function public._hr_msg(p_err text)
returns text language sql immutable set search_path = public as $$
  select case when p_err ~ '^NEO_[A-Z]+: ' then regexp_replace(p_err, '^NEO_[A-Z]+: ', '') end
$$;

-- R2 — hr_punch's v2.4 keys, read leniently (never raises): a bad or
-- oversized value is dropped (or cut) and named in dropped[].
--   v (versionCode) · fix_age_ms · mock · restored · reason {kind, text, ref}
--   · selfie_skip · flags (device flags object) · trip {id, kind, ref_code, note}
create or replace function public._hr_punch_extras(p jsonb)
returns jsonb language plpgsql immutable set search_path = public as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_drop text[] := '{}';
  j jsonb;
  t text;
  v_kind text; v_text text; v_ref text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('dropped', '[]'::jsonb); end if;
  begin
    if p ? 'v' and jsonb_typeof(p -> 'v') <> 'null' then
      t := btrim(p ->> 'v');
      if jsonb_typeof(p -> 'v') in ('number', 'string') and t ~ '^[0-9]{1,9}$' then v_out := v_out || jsonb_build_object('v', t::int);
      else v_drop := array_append(v_drop, 'v'); end if;
    end if;
    if p ? 'fix_age_ms' and jsonb_typeof(p -> 'fix_age_ms') <> 'null' then
      t := btrim(p ->> 'fix_age_ms');
      if jsonb_typeof(p -> 'fix_age_ms') in ('number', 'string') and t ~ '^-?[0-9]{1,9}(\.[0-9]+)?$' then
        v_out := v_out || jsonb_build_object('fix_age_ms', round(t::numeric)::int);
      else v_drop := array_append(v_drop, 'fix_age_ms'); end if;
    end if;
    foreach t in array array['mock', 'restored'] loop
      if p ? t and jsonb_typeof(p -> t) <> 'null' then
        if jsonb_typeof(p -> t) = 'boolean' or lower(btrim(p ->> t)) in ('true', 'false') then
          v_out := v_out || jsonb_build_object(t, lower(btrim(p ->> t)) = 'true');
        else v_drop := array_append(v_drop, t); end if;
      end if;
    end loop;
    if p ? 'reason' and jsonb_typeof(p -> 'reason') <> 'null' then
      j := p -> 'reason';
      if jsonb_typeof(j) <> 'object' then
        v_drop := array_append(v_drop, 'reason');
      else
        v_kind := case when jsonb_typeof(j -> 'kind') = 'string' then lower(btrim(j ->> 'kind')) end;
        v_text := case when jsonb_typeof(j -> 'text') = 'string' then btrim(j ->> 'text', E' \t\r\n') end;
        v_ref := case when jsonb_typeof(j -> 'ref') = 'string' then upper(btrim(j ->> 'ref')) end;
        if j ? 'text' and jsonb_typeof(j -> 'text') not in ('string', 'null') then v_drop := array_append(v_drop, 'reason.text'); end if;
        if char_length(v_text) > 500 then v_text := left(v_text, 500); v_drop := array_append(v_drop, 'reason.text'); end if;
        if char_length(v_text) < 3 then v_text := null; end if;
        if v_ref = '' then v_ref := null; end if;
        if v_ref is not null and v_ref !~ '^(NT|RM)-[A-Z0-9]{4,12}$' then v_ref := null; v_drop := array_append(v_drop, 'reason.ref'); end if;
        if v_kind is null or v_kind not in ('late', 'on_site', 'rma', 'other') then
          if v_kind is not null or (j ? 'kind' and jsonb_typeof(j -> 'kind') <> 'null') then v_drop := array_append(v_drop, 'reason.kind'); end if;
          v_kind := case when v_text is not null then 'other' end;
        end if;
        if v_kind is not null then
          v_out := v_out || jsonb_build_object('reason', jsonb_build_object('kind', v_kind, 'text', v_text, 'ref', v_ref));
        end if;
      end if;
    end if;
    if p ? 'selfie_skip' and jsonb_typeof(p -> 'selfie_skip') <> 'null' then
      t := lower(btrim(p ->> 'selfie_skip'));
      if jsonb_typeof(p -> 'selfie_skip') = 'string' and t in ('camera_error', 'no_front_camera') then
        v_out := v_out || jsonb_build_object('selfie_skip', t);
      else v_drop := array_append(v_drop, 'selfie_skip'); end if;
    end if;
    if p ? 'flags' and jsonb_typeof(p -> 'flags') <> 'null' then
      if jsonb_typeof(p -> 'flags') = 'object' and char_length((p -> 'flags')::text) <= 2000 then
        v_out := v_out || jsonb_build_object('flags', p -> 'flags');
      else v_drop := array_append(v_drop, 'flags'); end if;
    end if;
    if p ? 'trip' and jsonb_typeof(p -> 'trip') <> 'null' then
      j := p -> 'trip';
      if jsonb_typeof(j) = 'object' and coalesce(j ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_out := v_out || jsonb_build_object('trip', jsonb_build_object(
          'id', lower(j ->> 'id'),
          'kind', case when jsonb_typeof(j -> 'kind') = 'string' then lower(btrim(j ->> 'kind')) end,
          'ref_code', case when jsonb_typeof(j -> 'ref_code') = 'string' then nullif(upper(btrim(j ->> 'ref_code')), '') end,
          'note', case when jsonb_typeof(j -> 'note') = 'string' then nullif(btrim(j ->> 'note', E' \t\r\n'), '') end));
      else
        v_drop := array_append(v_drop, 'trip');
        v_out := v_out || jsonb_build_object('trip', jsonb_build_object('id', null));
      end if;
    end if;
  exception when others then
    v_drop := array_append(v_drop, 'extras');
  end;
  return v_out || jsonb_build_object('dropped', to_jsonb(v_drop));
end $$;

-- The session (of the fold) that holds p_at — a closed one up to its
-- punch_out, an auto-closed one up to its cap — with end_at: its punch_out;
-- for one the server closed, its open break's start, else its last punch or
-- route point (≤ cap); null while it is open. Null when no session holds it.
create or replace function public._hr_session_at(p_email text, p_at timestamptz, p_now timestamptz)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_em text := lower(btrim(p_email));
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  s jsonb;
  v_lp timestamptz;
begin
  select x.value into s
    from jsonb_array_elements(public._hr_fold(public._hr_events(v_em, p_at - make_interval(hours => 2 * v_h),
                                                                p_at + make_interval(hours => v_h)), v_h, p_now) -> 'sessions') as x(value)
   where (x.value ->> 'start')::timestamptz <= p_at
     and (x.value ->> 'end' = 'open' or p_at <= coalesce((x.value ->> 'out')::timestamptz, (x.value ->> 'cap')::timestamptz))
   order by (x.value ->> 'start')::timestamptz desc
   limit 1;
  if s is null then return null; end if;
  if s ->> 'end' = 'out' then
    return s || jsonb_build_object('end_at', s -> 'out');
  elsif s ->> 'end' = 'auto' then
    if s ->> 'open_break' is not null then return s || jsonb_build_object('end_at', s -> 'open_break'); end if;
    select max(lp.at) into v_lp from public.location_points lp
     where lower(lp.employee_email) = v_em and lp.at >= (s ->> 'start')::timestamptz and lp.at <= (s ->> 'cap')::timestamptz;
    return s || jsonb_build_object('end_at', least((s ->> 'cap')::timestamptz,
                                                   greatest(coalesce((s ->> 'last_at')::timestamptz, (s ->> 'start')::timestamptz),
                                                            coalesce(v_lp, (s ->> 'start')::timestamptz))));
  end if;
  return s || jsonb_build_object('end_at', null);
end $$;

-- §1.5 — a trip's effective end, read-side only: least(the stored end, the
-- end of the session that holds started_at). → {sess, end_at (null while
-- open), open, end_reason}. A trip no session holds any more (its punch_in
-- was voided) ends where it started.
create or replace function public._hr_trip_eff(t public.hr_trips, p_now timestamptz)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  s jsonb;
  v_send timestamptz;
  v_end timestamptz;
begin
  s := public._hr_session_at(t.employee_email, t.started_at, p_now);
  if s is null then
    return jsonb_build_object('sess', null, 'end_at', coalesce(t.ended_at, t.started_at), 'open', false,
                              'end_reason', coalesce(t.end_reason, 'hr'));
  end if;
  v_send := (s ->> 'end_at')::timestamptz;
  v_end := case when t.ended_at is null then v_send when v_send is null then t.ended_at else least(t.ended_at, v_send) end;
  return jsonb_build_object('sess', s, 'end_at', v_end, 'open', t.ended_at is null and s ->> 'end' = 'open',
    'end_reason', case when t.ended_at is not null and (v_send is null or t.ended_at <= v_send) then t.end_reason
                       when s ->> 'end' = 'out' then 'punch_out'
                       when s ->> 'end' = 'auto' then 'cap' end);
end $$;

-- §1.5 — a trip's km, moving minutes and stops: _hr_track_points over the
-- runs of its session ∩ [started_at, effective end). Cached on the trip with
-- the fingerprint of its inputs (the longest shift, the points and the
-- punches in the window, the window itself), taken BEFORE the points are read
-- (as hr_day_km); recomputed when it differs. A final trip (_hr_purge) or a
-- voided one is never recomputed. Volatile: only volatile RPCs call it.
create or replace function public._hr_trip_measure(p_id uuid, p_now timestamptz)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  t public.hr_trips;
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  e jsonb; s jsonb;
  v_end timestamptz;
  v_fp text;
  v_pts jsonb;
  v_tr jsonb;
begin
  select * into t from public.hr_trips where id = p_id;
  if t.id is null then return null; end if;
  if t.final or t.voided_at is not null then
    return jsonb_build_object('km', coalesce(t.km, 0), 'moving_min', coalesce(t.moving_min, 0), 'stops', coalesce(t.stops, 0));
  end if;
  e := public._hr_trip_eff(t, p_now);
  s := nullif(e -> 'sess', 'null'::jsonb);
  v_end := coalesce((e ->> 'end_at')::timestamptz, p_now);
  v_fp := concat_ws(':', v_h, coalesce(e ->> 'end_at', 'open'),
    (select count(*) || ':' || coalesce(max(lp.received_at)::text, '-') from public.location_points lp
      where lower(lp.employee_email) = t.employee_email and lp.at >= t.started_at and lp.at < v_end),
    (select count(*) || ':' || count(x.voided_at) from public.attendance_events x
      where lower(x.employee_email) = t.employee_email
        and x.at >= t.started_at - make_interval(hours => v_h) and x.at <= v_end + make_interval(hours => v_h)));
  if t.fp is not distinct from v_fp and t.km is not null then
    return jsonb_build_object('km', t.km, 'moving_min', coalesce(t.moving_min, 0), 'stops', coalesce(t.stops, 0));
  end if;
  if s is null or v_end <= t.started_at then
    v_tr := jsonb_build_object('km', 0, 'moving_min', 0, 'stops', '[]'::jsonb);
  else
    select coalesce(jsonb_agg(x.pts order by x.ord), '[]'::jsonb) into v_pts
      from (select r.ord,
                   (select coalesce(jsonb_agg(jsonb_build_object('id', lp.client_point_id, 'at', lp.at, 'lat', lp.lat,
                                                                 'lng', lp.lng, 'accuracy_m', lp.accuracy_m)
                                              order by lp.at, lp.client_point_id), '[]'::jsonb)
                      from public.location_points lp
                     where lower(lp.employee_email) = t.employee_email
                       and lp.at >= greatest((r.value ->> 'from')::timestamptz, t.started_at)
                       and lp.at < least((r.value ->> 'to')::timestamptz, v_end)) as pts
              from jsonb_array_elements(public._hr_runs(jsonb_build_array(s))) with ordinality as r(value, ord)) x;
    v_tr := public._hr_track_points(v_pts);
  end if;
  update public.hr_trips
     set km = (v_tr ->> 'km')::numeric, moving_min = coalesce((v_tr ->> 'moving_min')::int, 0),
         stops = coalesce(jsonb_array_length(v_tr -> 'stops'), 0), fp = v_fp
   where id = t.id and not final;
  return jsonb_build_object('km', round((v_tr ->> 'km')::numeric, 2), 'moving_min', coalesce((v_tr ->> 'moving_min')::int, 0),
                            'stops', coalesce(jsonb_array_length(v_tr -> 'stops'), 0));
end $$;

-- A trip as the clients see it: {id, kind, ref_code, ref_title, note,
-- started_at, ended_at (effective; null while open), end_reason, km,
-- moving_min, stops, open, flags}. p_measure false: the cached figures only.
create or replace function public._hr_trip_json(t public.hr_trips, p_now timestamptz, p_measure boolean)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  e jsonb;
  m jsonb;
begin
  if t.id is null then return null; end if;
  e := public._hr_trip_eff(t, p_now);
  m := case when p_measure then public._hr_trip_measure(t.id, p_now) end;
  return jsonb_build_object('id', t.id, 'kind', t.kind, 'ref_code', t.ref_code, 'ref_title', t.ref_title, 'note', t.note,
    'started_at', t.started_at, 'ended_at', e -> 'end_at', 'end_reason', e -> 'end_reason',
    'km', coalesce(m -> 'km', to_jsonb(coalesce(t.km, 0))), 'moving_min', coalesce(m -> 'moving_min', to_jsonb(coalesce(t.moving_min, 0))),
    'stops', coalesce(m -> 'stops', to_jsonb(coalesce(t.stops, 0))), 'open', coalesce((e ->> 'open')::boolean, false),
    'flags', to_jsonb(coalesce(t.flags, '{}')));
end $$;

-- §1.5 — writers persist trip ends that come from the session (punch_out,
-- cap): every non-final trip started in [p_lo, p_hi] whose stored end is
-- unset or session-made gets its session's end now (null again if the
-- session is open again). A tapped / next_trip / HR end is never touched.
-- Called under the person's lock (hr_punch, hr_correct, the decide RPC,
-- _hr_purge).
create or replace function public._hr_trip_sync(p_email text, p_lo timestamptz, p_hi timestamptz, p_now timestamptz)
returns int language plpgsql volatile set search_path = public as $$
declare
  t public.hr_trips;
  s jsonb;
  v_end timestamptz;
  v_reason text;
  v_n int := 0;
begin
  for t in select * from public.hr_trips x
            where x.employee_email = lower(btrim(p_email)) and x.voided_at is null and not x.final
              and x.started_at >= p_lo and x.started_at <= p_hi
              and (x.ended_at is null or x.end_reason in ('punch_out', 'cap'))
            order by x.started_at loop
    s := public._hr_session_at(t.employee_email, t.started_at, p_now);
    continue when s is null;
    if s ->> 'end' = 'open' then
      v_end := null; v_reason := null;
    else
      v_end := (s ->> 'end_at')::timestamptz;
      v_reason := case when s ->> 'end' = 'out' then 'punch_out' else 'cap' end;
    end if;
    if v_end is distinct from t.ended_at or v_reason is distinct from t.end_reason then
      update public.hr_trips set ended_at = v_end, end_reason = v_reason, end_source = v_reason where id = t.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

-- §1.5 — start a trip for p_me (hr_trip_start, and hr_punch's p.trip): field
-- staff only; a session must hold p_at and p_at must not be in a break; no
-- ticket needs a note of 3+ characters; another trip whose window holds p_at
-- ends at p_at (next_trip), and a later trip already in the session ends this
-- one at its start. Flags: no_ticket, ticket_not_mine, sent_late.
-- → {ok, duplicate, trip}
create or replace function public._hr_trip_begin(p_me public.profiles, p_id uuid, p_kind text, p_at timestamptz, p_ref text, p_note text,
                                                 p_lat double precision, p_lng double precision, p_acc double precision, p_source text)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  v_em text := lower(p_me.email);
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  t public.hr_trips;
  o public.hr_trips;
  s jsonb;
  v_ref text := nullif(upper(btrim(coalesce(p_ref, ''))), '');
  v_note text := nullif(btrim(coalesce(p_note, ''), E' \t\r\n'), '');
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_ref_id text; v_title text; v_mine boolean := false;
  v_flags text[] := '{}';
  v_next timestamptz;
  e jsonb;
begin
  if p_id is null then raise exception 'NEO_GATE: id is required — make one UUID per trip and reuse it on every retry.'; end if;
  perform pg_advisory_xact_lock(hashtext('neo_hr_att:' || v_em));
  select * into t from public.hr_trips where id = p_id;
  if found then
    if t.employee_email <> v_em then raise exception 'NEO_GATE: That trip id is already used.'; end if;
    return jsonb_build_object('ok', true, 'duplicate', true, 'trip', public._hr_trip_json(t, now(), true));
  end if;
  if not public._hr_is_field(p_me.id) then raise exception 'NEO_GATE: Trips are for field staff.'; end if;
  if v_kind not in ('on_site', 'rma') then raise exception 'NEO_GATE: Say On-site or RMA.'; end if;
  if v_ref is not null and v_ref !~ '^(NT|RM)-[A-Z0-9]{4,12}$' then
    raise exception 'NEO_GATE: A job code looks like NT-7KQ2ACDE or RM-7KQ2PX4D.';
  end if;
  if v_ref is null and char_length(coalesce(v_note, '')) < 3 then
    raise exception 'NEO_GATE: Say where you''re going — at least 3 characters.';
  end if;
  if char_length(coalesce(v_note, '')) > 200 then raise exception 'NEO_GATE: The note is too long — keep it under 200 characters.'; end if;
  s := public._hr_session_at(v_em, p_at, now());
  if s is null or (s ->> 'end' = 'out' and p_at >= (s ->> 'out')::timestamptz)
     or (s ->> 'open_break' is not null and p_at >= (s ->> 'open_break')::timestamptz)
     or exists (select 1 from jsonb_array_elements(coalesce(s -> 'breaks', '[]'::jsonb)) as b(value)
                 where p_at >= (b.value ->> 'from')::timestamptz and p_at < (b.value ->> 'to')::timestamptz) then
    raise exception 'NEO_GATE: Punch in (or end your break) to start a trip.';
  end if;
  -- the ticket: a service job (NT-) or an RMA part (RM-) of mine
  if v_ref like 'NT-%' then
    select j.id, coalesce(nullif(btrim(coalesce(j.device_label, '')), ''), public._svc_category_label(j.category)),
           lower(coalesce(j.assignee_email, '')) = v_em
      into v_ref_id, v_title, v_mine
      from public.service_jobs j where upper(j.public_code) = v_ref limit 1;
  elsif v_ref like 'RM-%' then
    select c.id, nullif(btrim(concat_ws(' ', c.brand, c.model)), ''), lower(coalesce(c.handler_email, '')) = v_em
      into v_ref_id, v_title, v_mine
      from public.rma_cases c where upper(c.public_code) = v_ref limit 1;
  end if;
  if v_ref is null then v_flags := v_flags || 'no_ticket'::text;
  elsif not coalesce(v_mine, false) then v_flags := v_flags || 'ticket_not_mine'::text; end if;
  if now() - p_at > interval '10 minutes' then v_flags := v_flags || 'sent_late'::text; end if;
  -- one trip at a time: the trip whose window holds p_at ends at p_at …
  for o in select * from public.hr_trips x
            where x.employee_email = v_em and x.voided_at is null and not x.final
              and x.started_at <= p_at and x.started_at >= p_at - make_interval(hours => v_h)
            order by x.started_at loop
    e := public._hr_trip_eff(o, now());
    if e ->> 'end_at' is null or (e ->> 'end_at')::timestamptz > p_at then
      update public.hr_trips set ended_at = p_at, end_reason = 'next_trip', end_source = 'next_trip' where id = o.id;
    end if;
  end loop;
  -- … and a trip that already starts later in the same session ends this one
  select min(x.started_at) into v_next from public.hr_trips x
   where x.employee_email = v_em and x.voided_at is null and x.started_at > p_at
     and x.started_at <= coalesce((s ->> 'end_at')::timestamptz, 'infinity'::timestamptz);
  insert into public.hr_trips (id, profile_id, employee_email, kind, ref_code, ref_id, ref_title, note, started_at, start_source,
                               start_lat, start_lng, start_acc, ended_at, end_source, end_reason, flags)
  values (p_id, p_me.id, v_em, v_kind, v_ref, v_ref_id, left(v_title, 200), v_note, p_at, p_source,
          p_lat, p_lng, p_acc, v_next, case when v_next is not null then 'next_trip' end,
          case when v_next is not null then 'next_trip' end, v_flags)
  returning * into t;
  return jsonb_build_object('ok', true, 'duplicate', false, 'trip', public._hr_trip_json(t, now(), true));
end $$;

-- The trips of a person's shop day (the session day of started_at), measured.
create or replace function public._hr_day_trips(p_email text, p_day date, p_now timestamptz)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  v_em text := lower(btrim(p_email));
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  t public.hr_trips;
  v_out jsonb := '[]'::jsonb;
begin
  for t in select * from public.hr_trips x
            where x.employee_email = v_em and x.voided_at is null
              and x.started_at >= public._hr_at(p_day, '00:00') - make_interval(hours => v_h)
              and x.started_at < public._hr_at(p_day + 1, '00:00') + make_interval(hours => v_h)
            order by x.started_at loop
    if public._hr_session_day(v_em, t.started_at) = p_day then
      v_out := v_out || jsonb_build_array(public._hr_trip_json(t, p_now, true));
    end if;
  end loop;
  return v_out;
end $$;

-- §1.5 — the travel allowance basis: trip km of a month (trips on the session
-- day of started_at, days up to today, voided left out, each trip rounded to
-- 2 decimals, then summed). → {days: [{day, km}], km}
create or replace function public._hr_month_trip_km(p_email text, p_month date, p_now timestamptz)
returns jsonb language plpgsql volatile set search_path = public as $$
begin
  return public._hr_trip_km_days(p_email, date_trunc('month', p_month)::date,
                                 least((date_trunc('month', p_month) + interval '1 month')::date - 1, public._hr_today(p_now)), p_now);
end $$;

-- Trip km per session day of [p_from, p_to] (the same rule as a month:
-- trips on the session day of started_at, voided left out, each trip rounded
-- to 2 decimals). → {days: [{day, km}] (days with km > 0), km}
create or replace function public._hr_trip_km_days(p_email text, p_from date, p_to date, p_now timestamptz)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  v_em text := lower(btrim(p_email));
  v_from date := p_from;
  v_to date := p_to;
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  t public.hr_trips;
  v_d date;
  v_km numeric;
  v_map jsonb := '{}'::jsonb;
  v_sum numeric := 0;
begin
  if v_to < v_from then return jsonb_build_object('days', '[]'::jsonb, 'km', 0); end if;
  for t in select * from public.hr_trips x
            where x.employee_email = v_em and x.voided_at is null
              and x.started_at >= public._hr_at(v_from, '00:00') - make_interval(hours => v_h)
              and x.started_at < public._hr_at(v_to + 1, '00:00') + make_interval(hours => v_h)
            order by x.started_at loop
    v_d := public._hr_session_day(v_em, t.started_at);
    continue when v_d < v_from or v_d > v_to;
    v_km := round(coalesce((public._hr_trip_measure(t.id, p_now) ->> 'km')::numeric, 0), 2);
    v_map := v_map || jsonb_build_object(v_d::text, coalesce((v_map ->> v_d::text)::numeric, 0) + v_km);
    v_sum := v_sum + v_km;
  end loop;
  return jsonb_build_object('km', v_sum,
    'days', (select coalesce(jsonb_agg(jsonb_build_object('day', x.key::date, 'km', (x.value #>> '{}')::numeric) order by x.key), '[]'::jsonb)
               from jsonb_each(v_map) as x(key, value) where (x.value #>> '{}')::numeric > 0));
end $$;
perform public._hr_lockdown();
end $hr$;


-- ── part 04: field staff (D1) — the seed, the defaults and every function ──
--    whose "no row" answer flips from yes to no, in ONE part
do $hr$
declare
  v_n int;
  v_owner boolean;
begin
  -- (a) the first run only (track_location still defaults to true): every
  --     active staff profile without a row gets one; field staff = active
  --     staff in the service pool. Exactly 5 field rows with the owner among
  --     them, or the whole part is refused and nothing flips.
  if coalesce((select c.column_default from information_schema.columns c
                where c.table_schema = 'public' and c.table_name = 'hr_person' and c.column_name = 'track_location'), 'true') <> 'false' then
    insert into public.hr_person (profile_id, ta_eligible, track_location, updated_by)
    select p.id, f.field, f.field, 'neohr_hr_v2_4'
      from public.profiles p
      left join public.staff_work sw on sw.profile_id = p.id
      cross join lateral (select (p.active and coalesce(p.is_staff, false) and coalesce(sw.service_pool, false)) as field) f
     where p.active and coalesce(p.is_staff, false)
       and not exists (select 1 from public.hr_person hp where hp.profile_id = p.id)
    on conflict (profile_id) do nothing;
    select count(*), coalesce(bool_or(p.tier >= 5), false) into v_n, v_owner
      from public.hr_person hp
      join public.profiles p on p.id = hp.profile_id
     where hp.track_location and p.active and coalesce(p.is_staff, false);
    if v_n <> 5 or not v_owner then
      raise exception 'neohr_hr_v2_4: the field staff seed found % field rows (the owner among them: %), not exactly 5 with the owner — nothing was changed',
        v_n, v_owner;
    end if;
  end if;
  -- (b) a new person is not field staff and gets no travel allowance
  alter table public.hr_person alter column track_location set default false;
  alter table public.hr_person alter column ta_eligible set default false;

-- (c) every function whose missing-row answer was "yes"

-- §9.4.4 (v2.4: field staff only; while a trip is open it never pauses) —
-- what the phone needs to record (or not) the route. Same keys as v2.3.
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
  v_trip boolean;
  v_start timestamptz; v_cap timestamptz; v_send timestamptz;
begin
  select * into v_set from public.hr_settings where id = 1;
  v_track := public._hr_is_field(p_profile);
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
  v_trip := exists (select 1 from public.hr_trips t
                     where t.employee_email = lower(btrim(p_email)) and t.voided_at is null and t.ended_at is null
                       and t.started_at >= v_start and t.started_at <= p_now);
  return jsonb_build_object('enabled', v_on,
    'reason', case when v_on then null when not v_track then 'disabled' when c.duty = 'wfh' then 'wfh'
                   when v_state = 'on_break' then 'on_break' else 'off_duty' end,
    'interval_s', v_set.track_interval_s, 'distance_m', v_set.track_distance_m,
    'session_start', v_start, 'cap_at', v_cap,
    'remind_out_at', case when v_start < v_send + interval '30 minutes' then v_send + interval '30 minutes' end,
    'pause_at', case when v_trip then v_cap else least(v_cap, greatest(v_send, v_start) + interval '4 hours') end);
end $$;

-- §9.4.7 (v2.4: only field staff record a route; everyone else's points
-- answer 'disabled', which NeoHR 2.2.0 drops — correct) — route points, ≤ 500
-- at a time, each {id, at, age_ms?, lat, lng, accuracy_m?, speed_mps?,
-- bearing?}. Set-based (no per-point exception blocks): every item gets the
-- first reason that applies — invalid, clock, not_yours, (own duplicate:
-- accepted), disabled, wfh, on_break / off_duty (the runs of §9.5.2; a point
-- up to 60 s before a punch_in or break_end is stored at that event's time).
-- → {accepted, rejected:[{id, reason}]}
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
  v_track := public._hr_is_field(v_me.id);

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

-- Any active staff member: the settings, the default shift history, and me
-- {shift (today's), attendance_required, ta_eligible (and field staff),
-- tracking, field_staff, dash_view, days: today … today + 6}. Tier 4+ also get
-- people (per-person switches and shift rows) and selfie_store_bytes.
create or replace function public.hr_settings_get()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_now timestamptz := now();
  v_today date := public._hr_today(now());
  v_set public.hr_settings;
  v_hp public.hr_person;
  v_field boolean := public._hr_is_field(v_me.id);
  v_view text;
  c record;
  v_out jsonb;
begin
  select * into v_set from public.hr_settings where id = 1;
  select * into v_hp from public.hr_person where profile_id = v_me.id;
  select * into c from public._hr_ctx(v_me.id, lower(v_me.email), v_today, v_today);
  begin
    v_view := public._hr_dash_view(v_me.id);
  exception when others then v_view := null;
  end;
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
      'ta_eligible', coalesce(v_hp.ta_eligible, false) and v_field,
      'tracking', public._hr_tracking(lower(v_me.email), v_me.id, v_now, public._hr_state(lower(v_me.email), v_now)),
      'field_staff', v_field,
      'dash_view', v_view,
      'days', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'duty', d.duty,
                        'shift_start', to_char(d.shift_start, 'HH24:MI'), 'shift_end', to_char(d.shift_end, 'HH24:MI'),
                        'grace_min', d.grace_min, 'holiday', d.holiday, 'flex_request', d.flex_request,
                        'half_day_leave', d.half_day_leave) order by d.day), '[]'::jsonb)
                 from public._hr_ctx(v_me.id, lower(v_me.email), v_today, v_today + 6) d)));
  if v_me.tier >= 4 then
    v_out := v_out || jsonb_build_object('selfie_store_bytes', pg_total_relation_size('public.hr_punch_selfies'), 'people', (
      select coalesce(jsonb_agg(jsonb_build_object('email', lower(p.email), 'name', p.full_name, 'tier', p.tier,
               'designation', p.designation, 'self', p.id = v_me.id,
               'can_edit', (p.id = v_me.id and v_me.tier >= 5) or (p.id <> v_me.id and (v_me.tier >= 5 or p.tier <= 3)),
               'ta_eligible', coalesce(hp.ta_eligible, false), 'track_location', coalesce(hp.track_location, false),
               'field_staff', coalesce(hp.track_location, false),
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

-- §9.4.6 — tier 4+, the staff hierarchy (a tier 4 changes only tier 1–3
-- accounts) and S19 (only a tier 5 may change their own row). Keys: the shift
-- keys (+ effective_from; null = use the default) and ta_eligible,
-- track_location (field staff), attendance_required (at once). v2.4:
-- switching track_location switches ta_eligible with it, unless the same
-- change sets ta_eligible itself.
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
    if not (p ? 'ta_eligible') then v_ta := v_tr; end if;
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

-- A month of my own days (up to today) with totals: absent and leave are
-- numbers (halves count); km is the sum of the day km values. v2.4: days gain
-- trip_km; totals gain away_pending and trip_km (an away-pending day is not
-- present, late or half day); travel allowance = trip km × rate, for field
-- staff with ta_eligible.
create or replace function public.hr_my_month(p_month date default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_now timestamptz := now();
  v_today date := public._hr_today(now());
  v_m date := date_trunc('month', coalesce(p_month, public._hr_today(now())))::date;
  v_to date;
  v_days jsonb;
  v_tk jsonb;
  v_set public.hr_settings;
  v_elig boolean;
  v_km numeric;
  v_trip_km numeric;
  v_ap public.hr_ta_approvals;
  v_rate numeric;
begin
  v_to := least((v_m + interval '1 month')::date - 1, v_today);
  v_days := case when v_to >= v_m then public._hr_days(v_me.email, v_m, v_to, v_now) else '[]'::jsonb end;
  v_tk := public._hr_month_trip_km(v_me.email, v_m, v_now);
  select coalesce(jsonb_agg(d.value || jsonb_build_object('trip_km',
           coalesce((select (t.value ->> 'km')::numeric from jsonb_array_elements(v_tk -> 'days') as t(value)
                      where (t.value ->> 'day')::date = (d.value ->> 'day')::date), 0)) order by d.ord), '[]'::jsonb)
    into v_days
    from jsonb_array_elements(v_days) with ordinality as d(value, ord);
  select * into v_set from public.hr_settings where id = 1;
  v_elig := coalesce((select hp.ta_eligible from public.hr_person hp where hp.profile_id = v_me.id), false) and public._hr_is_field(v_me.id);
  v_rate := case when v_elig then v_set.ta_rate_per_km else 0 end;
  select coalesce(sum((d.value ->> 'km')::numeric), 0) into v_km from jsonb_array_elements(v_days) as d(value);
  v_trip_km := coalesce((v_tk ->> 'km')::numeric, 0);
  select * into v_ap from public.hr_ta_approvals a where a.profile_id = v_me.id and a.month = v_m;
  return jsonb_build_object('now', v_now, 'email', lower(v_me.email), 'month', v_m, 'days', v_days,
    'totals', public._hr_day_totals(v_days) || jsonb_build_object(
        'km', v_km,
        'trip_km', v_trip_km,
        'ta', jsonb_build_object(
                'eligible', v_elig, 'rate', case when v_ap.month is not null then v_ap.rate else v_rate end,
                'amount', case when v_ap.month is not null then v_ap.amount
                               when v_rate is not null then round(v_trip_km * v_rate, 2) end,
                'approved', case when v_ap.month is not null then
                                   jsonb_build_object('by', v_ap.approved_by_name, 'at', v_ap.approved_at, 'km', v_ap.km) end)));
end $$;

-- §9.7 (v2.4: the basis is TRIP km) — a month's travel allowance per person
-- (approvers): field staff (and anyone approved that month). km = trip km
-- (or the approved snapshot), live_km = trip km now, changed = they differ,
-- day_km = the whole days' km; days [{day, km (trip), day_km}].
create or replace function public.hr_ta_report(p_month date default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_now timestamptz := now();
  v_today date := public._hr_today(now());
  v_m date := date_trunc('month', coalesce(p_month, public._hr_today(now())))::date;
  v_set public.hr_settings;
  r record;
  v_mk jsonb; v_tk jsonb; v_km numeric; v_rate numeric; v_elig boolean; v_ap public.hr_ta_approvals; v_days jsonb;
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
            where (p.active and coalesce(p.is_staff, false) and public._hr_is_field(p.id))
               or exists (select 1 from public.hr_ta_approvals a where a.profile_id = p.id and a.month = v_m)
            order by lower(p.email), p.id loop
    v_mk := public._hr_month_km(r.email, v_m, v_now);
    v_tk := public._hr_month_trip_km(r.email, v_m, v_now);
    v_km := coalesce((v_tk ->> 'km')::numeric, 0);
    v_elig := coalesce((select hp.ta_eligible from public.hr_person hp where hp.profile_id = r.id), false) and public._hr_is_field(r.id);
    v_rate := case when v_elig then v_set.ta_rate_per_km else 0 end;
    select * into v_ap from public.hr_ta_approvals a where a.profile_id = r.id and a.month = v_m;
    select coalesce(jsonb_agg(jsonb_build_object('day', x.day, 'km', coalesce(x.tkm, 0), 'day_km', coalesce(x.dkm, 0)) order by x.day), '[]'::jsonb)
      into v_days
      from (select coalesce(a.day, b.day) as day, b.km as tkm, a.km as dkm
              from (select (d.value ->> 'day')::date as day, (d.value ->> 'km')::numeric as km
                      from jsonb_array_elements(v_mk -> 'days') as d(value)) a
              full join (select (d.value ->> 'day')::date as day, (d.value ->> 'km')::numeric as km
                           from jsonb_array_elements(v_tk -> 'days') as d(value)) b on a.day = b.day) x;
    v_people := v_people || jsonb_build_array(jsonb_build_object(
      'email', lower(r.email), 'name', r.full_name, 'self', r.id = v_me.id, 'eligible', v_elig, 'days', v_days,
      'km', case when v_ap.month is not null then v_ap.km else v_km end,
      'rate', case when v_ap.month is not null then v_ap.rate else v_rate end,
      'amount', case when v_ap.month is not null then v_ap.amount when v_rate is not null then round(v_km * v_rate, 2) end,
      'live_km', v_km,
      'day_km', coalesce((v_mk ->> 'km')::numeric, 0),
      'changed', v_ap.month is not null and v_km <> v_ap.km,
      'approved', case when v_ap.month is not null then
                         jsonb_build_object('by', v_ap.approved_by_name, 'at', v_ap.approved_at, 'note', v_ap.note) end,
      'can_approve', r.id <> v_me.id and v_closed and v_set.ta_rate_per_km is not null and v_elig and v_ap.month is null));
  end loop;
  select coalesce(jsonb_agg(x.value order by x.value ->> 'name', x.value ->> 'email'), '[]'::jsonb) into v_people
    from jsonb_array_elements(v_people) as x(value);
  return jsonb_build_object('now', v_now, 'month', v_m, 'closed', v_closed, 'rate', v_set.ta_rate_per_km, 'people', v_people);
end $$;

-- §9.7 (v2.4: trip km; field staff with ta_eligible) — approve a finished
-- month for one person, snapshotting km / rate / amount. p_expected_km = the
-- km the approver saw (a 1.12 desktop sends the report row's km, which is now
-- trip km); a different live figure answers {ok:false, reason:'changed', km}
-- and writes nothing.
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
  if not (coalesce((select hp.ta_eligible from public.hr_person hp where hp.profile_id = v_t.id), false) and public._hr_is_field(v_t.id)) then
    raise exception 'NEO_GATE: % isn''t eligible for travel allowance.', v_t.full_name;
  end if;
  if char_length(coalesce(v_note, '')) > 300 then raise exception 'NEO_GATE: The note is too long — keep it under 300 characters.'; end if;
  v_km := coalesce((public._hr_month_trip_km(v_t.email, v_m, now()) ->> 'km')::numeric, 0);
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
perform public._hr_lockdown();
end $hr$;


-- ── part 05: the day record, the live board, the reads ──────────────────────
do $hr$
begin
-- §9.4.1 / §9.6.5 (v2.4 keys added). Pure: everything comes in p, so
-- tests/fixtures/hr-day.json and hr-day-v24.json run it directly.
--   p = {day, now, max_session_h, shift:{start,end,grace_min,half_day_min},
--        duty, holiday, attendance_required, flex_request, half_day_leave,
--        events:[{id,kind,at,rcv}] + points_at:[…]   (folded here), or
--        sessions + orphans (already folded; a session may carry last_point_at),
--        km, km_gaps, tracked_from (optional: a day before it with no punch
--        that would otherwise be absent or not_in_yet is 'not_tracked' —
--        before attendance_from or before the person's account; leave, a
--        half-day leave's leave half and off still count there),
--        v2.4: excused_in:[event id] (punch_ins whose late mark is excused),
--        pending_ids:[event id] (punches with a pending away_punch),
--        pending_reason (a punch_reason is pending on the day)}
-- Minutes are whole minutes, rounded down. A worked session ends at its
-- punch_out; an auto-closed one at its open break's start, else at its latest
-- event or point (<= cap); an open one at now (or its open break's start).
-- v2.4: the first session's punch_in in excused_in → late_raw_min keeps the
-- computed late, late_min = 0, late_excused (never 'late'). A session whose
-- punch_in or punch_out is in pending_ids counts nowhere until HR approves:
-- its minutes go to pending_min (not worked_min / break_min), the session
-- says pending, the day says away_pending (the status words are unchanged;
-- half_day is judged on worked + pending minutes, so a day waiting for HR
-- reads present / late as it will once approved).
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
  v_exc jsonb := case when jsonb_typeof(p -> 'excused_in') = 'array' then p -> 'excused_in' else '[]'::jsonb end;
  v_pend jsonb := case when jsonb_typeof(p -> 'pending_ids') = 'array' then p -> 'pending_ids' else '[]'::jsonb end;
  v_flex boolean;
  f jsonb; v_sess jsonb; v_orph jsonb; s jsonb;
  v_st timestamptz; v_cap timestamptz; v_ob timestamptz; v_lp timestamptz; v_wend timestamptz;
  v_bs float8; v_obs float8; v_ws float8;
  v_wsum float8 := 0; v_bsum float8 := 0; v_psum float8 := 0;
  v_n int := 0;
  v_first timestamptz; v_first_in text; v_last jsonb; v_lastout timestamptz;
  v_open boolean := false; v_missed boolean := false; v_irr boolean; v_ispend boolean; v_away boolean := false;
  v_list jsonb := '[]'::jsonb;
  v_late int := 0; v_late_raw int := 0; v_excused boolean := false; v_early int := 0; v_worked int; v_status text;
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
    v_ispend := (v_pend ? coalesce(s ->> 'in_id', '')) or (s ->> 'out_id' is not null and v_pend ? (s ->> 'out_id'));
    if v_ispend then
      v_psum := v_psum + v_ws;
      v_away := true;
    else
      v_wsum := v_wsum + v_ws;
      v_bsum := v_bsum + v_bs + v_obs;
    end if;
    if v_first is null then v_first_in := s ->> 'in_id'; end if;
    v_first := coalesce(v_first, v_st);
    v_open := v_open or s ->> 'end' = 'open';
    v_last := s;
    v_list := v_list || jsonb_build_array(jsonb_build_object(
      'in', v_st, 'out', (s ->> 'out')::timestamptz, 'cap_at', v_cap,
      'breaks', coalesce(s -> 'breaks', '[]'::jsonb)
                || case when v_ob is not null then jsonb_build_array(jsonb_build_object('from', v_ob, 'to', null)) else '[]'::jsonb end,
      'worked_min', floor(v_ws / 60)::int, 'break_min', floor((v_bs + v_obs) / 60)::int,
      'open', s ->> 'end' = 'open', 'missed_out', s ->> 'end' = 'auto', 'pending', v_ispend));
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
    v_late_raw := v_late;
    if v_first_in is not null and v_exc ? v_first_in then
      v_excused := true;
      v_late := 0;
    end if;
    -- the status word counts the pending minutes as well (a day whose session
    -- waits on an away punch is not a half day; away_pending keeps it out of
    -- the totals until HR decides); worked_min / pending_min stay apart
    v_status := case when v_open then 'open'
                     when floor((v_wsum + v_psum) / 60) < v_half or v_hdl then 'half_day'
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
    'leave_units', v_leave, 'absent_units', v_absent,
    'late_raw_min', v_late_raw, 'late_excused', v_excused, 'pending_min', floor(v_psum / 60)::int,
    'away_pending', v_away, 'pending_reason', coalesce((p ->> 'pending_reason')::boolean, false));
end $$;

-- The day records of [p_from, p_to] for one person: one fold, one context
-- query, km per day (cache rules of §9.5.6). p_marks adds clock_marks (the
-- number of the day's punches whose time is not verified, or whose phone clock
-- was off by more than 5 minutes) — approvers only. v2.4: excused_in (a field
-- engineer's On-site / RMA punch_in away from the shop, or a punch_in with an
-- approved punch_reason), pending_ids (punches with a pending away_punch) and
-- pending_reason go into _hr_day_calc.
create or replace function public._hr_days(p_email text, p_from date, p_to date, p_now timestamptz, p_marks boolean default false)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  v_em text := lower(btrim(p_email));
  v_prof uuid;
  v_req boolean;
  v_field boolean;
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  v_tf date;
  v_lo timestamptz; v_hi timestamptz;
  v_ev jsonb; f jsonb; c record;
  v_sess jsonb; v_orph jsonb; v_km jsonb; v_rec jsonb; v_marks int;
  v_exc jsonb; v_pend jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  if p_to < p_from then return v_out; end if;
  select p.id into v_prof from public.profiles p where lower(p.email) = v_em order by p.active desc limit 1;
  v_req := coalesce((select hp.attendance_required from public.hr_person hp where hp.profile_id = v_prof), true);
  v_field := public._hr_is_field(v_prof);
  v_tf := greatest((select s.attendance_from from public.hr_settings s where s.id = 1),
                   (select (p.created_at at time zone 'Asia/Kolkata')::date from public.profiles p where p.id = v_prof));
  v_lo := public._hr_at(p_from, '00:00') - make_interval(hours => v_h);
  v_hi := public._hr_at(p_to + 1, '00:00') + make_interval(hours => v_h);
  v_ev := public._hr_events(v_em, v_lo, v_hi);
  f := public._hr_fold(v_ev, v_h, p_now);
  select coalesce(jsonb_agg(e.id::text), '[]'::jsonb) into v_exc
    from public.attendance_events e
   where lower(e.employee_email) = v_em and e.voided_at is null and e.kind = 'punch_in' and e.at >= v_lo and e.at <= v_hi
     and ((v_field and e.reason_kind in ('on_site', 'rma') and e.place = 'away')
          or exists (select 1 from public.hr_requests q where q.event_id = e.id and q.kind = 'punch_reason' and q.status = 'approved'));
  select coalesce(jsonb_agg(q.event_id::text), '[]'::jsonb) into v_pend
    from public.hr_requests q
   where lower(q.employee_email) = v_em and q.kind = 'away_punch' and q.status = 'pending' and q.event_id is not null
     and q.date_from between p_from - 1 and p_to + 1;
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
      'sessions', v_sess, 'orphans', v_orph, 'km', v_km -> 'km', 'km_gaps', v_km -> 'km_gaps',
      'excused_in', v_exc, 'pending_ids', v_pend,
      'pending_reason', exists (select 1 from public.hr_requests q
                                 where lower(q.employee_email) = v_em and q.kind = 'punch_reason' and q.status = 'pending'
                                   and c.day between q.date_from and q.date_to)));
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

-- §9.6.6 — one person on the board (and in hr_dashboard's counts). Before
-- attendance_from (or before the person's account existed) a day with no
-- session is not_tracked, as in the day record (_hr_days' tracked_from).
-- v2.4 adds field_staff, trip (the open trip {id, kind, ref_code, ref_title,
-- started_at} or null) and punch_check (today's first punch_in {id, at, place,
-- office_m, verify, flags, selfie, selfie_skip, source} or null; an 'hr'
-- source punch never has a photo). The status words are v2.3's.
create or replace function public._hr_live(p_prof public.profiles, p_now timestamptz)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  v_em text := lower(p_prof.email);
  v_today date := public._hr_today(p_now);
  v_tf date := greatest((select s.attendance_from from public.hr_settings s where s.id = 1),
                        (p_prof.created_at at time zone 'Asia/Kolkata')::date);
  st jsonb; v_open jsonb; c record; v_req boolean; v_rec jsonb; v_tr jsonb; v_os jsonb; v_closed jsonb;
  v_status text; v_since timestamptz; v_lp timestamptz; v_stale boolean := false;
  v_trip jsonb; v_pc jsonb;
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
    select jsonb_build_object('id', t.id, 'kind', t.kind, 'ref_code', t.ref_code, 'ref_title', t.ref_title, 'started_at', t.started_at)
      into v_trip
      from public.hr_trips t
     where t.employee_email = v_em and t.voided_at is null and t.ended_at is null
       and t.started_at >= (v_open ->> 'start')::timestamptz and t.started_at <= p_now
     order by t.started_at desc limit 1;
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
  select jsonb_build_object('id', e.id, 'at', e.at, 'place', e.place, 'office_m', e.office_m, 'verify', e.verify,
                            'flags', to_jsonb(coalesce(e.flags, '{}')),
                            'selfie', exists (select 1 from public.hr_punch_selfies sf where sf.event_id = e.id),
                            'selfie_skip', e.selfie_skip, 'source', e.source)
    into v_pc
    from public.attendance_events e
   where lower(e.employee_email) = v_em and e.kind = 'punch_in' and e.voided_at is null
     and e.at >= public._hr_at(v_today, '00:00') and e.at < public._hr_at(v_today + 1, '00:00')
   order by e.at, e.received_at, e.id
   limit 1;
  return jsonb_build_object('email', v_em, 'name', p_prof.full_name, 'designation', p_prof.designation,
    'status', v_status, 'since', v_since, 'state', st ->> 'state', 'duty', c.duty, 'holiday', c.holiday,
    'shift', jsonb_build_object('start', to_char(c.shift_start, 'HH24:MI'), 'end', to_char(c.shift_end, 'HH24:MI')),
    'first_in', v_rec -> 'first_in', 'worked_min', coalesce(v_rec -> 'worked_min', '0'::jsonb),
    'break_min', coalesce(v_rec -> 'break_min', '0'::jsonb), 'missed_out', coalesce(v_rec -> 'missed_out', 'false'::jsonb),
    'flex', coalesce(v_rec -> 'flex', 'false'::jsonb), 'late_min', coalesce(v_rec -> 'late_min', '0'::jsonb),
    'km', coalesce(v_rec -> 'km', '0'::jsonb), 'on_site', v_os, 'last_point_at', v_lp, 'stale', v_stale,
    'tracking', coalesce((v_tr ->> 'enabled')::boolean, false), 'attendance_required', v_req,
    'clock_marks', coalesce(v_rec -> 'clock_marks', '0'::jsonb),
    'field_staff', public._hr_is_field(p_prof.id), 'trip', v_trip, 'punch_check', v_pc,
    'late_excused', coalesce(v_rec -> 'late_excused', 'false'::jsonb), 'away_pending', coalesce(v_rec -> 'away_pending', 'false'::jsonb));
end $$;

-- A request as the clients see it. v2.4 adds event_id, due_at, past_eod
-- (pending and past due_at), the punch it came from (punch_at, punch_kind,
-- place, office_m, verify, flags), its selfie (_hr_selfie_brief: the thumb
-- only for someone who may see it, and only while the request is pending —
-- a decided one says has_thumb and the full photo comes from hr_selfie_get),
-- reason_kind and kind_label (the kind in words, for clients that do not
-- know a kind).
create or replace function public._hr_req_json(r public.hr_requests)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  e public.attendance_events;
  v_sf jsonb;
begin
  if r.event_id is not null then
    select * into e from public.attendance_events x where x.id = r.event_id;
    v_sf := public._hr_selfie_brief(r.event_id, auth.uid());
    if r.status is distinct from 'pending' then v_sf := v_sf - 'thumb_b64'; end if;
  end if;
  return jsonb_build_object('id', r.id, 'email', r.employee_email,
    'name', (select p.full_name from public.profiles p where lower(p.email) = r.employee_email order by p.active desc limit 1),
    'kind', r.kind,
    'kind_label', case r.kind when 'late_start' then 'Late start' when 'early_leave' then 'Early leave'
                              when 'flexible_day' then 'Flexible day (on-site / RMA)' when 'field_day' then 'Field day'
                              when 'missed_punch' then 'Missed punch' when 'leave' then 'Leave'
                              when 'punch_reason' then 'Punch-in reason' when 'away_punch' then 'Away from shop' end,
    'date_from', r.date_from, 'date_to', r.date_to, 'half_day', r.half_day, 'leave_type', r.leave_type,
    'reason', r.reason, 'ref_code', r.ref_code, 'missed_at', r.missed_at, 'missed_kind', r.missed_kind, 'status', r.status,
    'decided_by_name', r.decided_by_name, 'decided_at', r.decided_at, 'decision_note', r.decision_note,
    'cancelled_by_name', r.cancelled_by_name, 'cancelled_at', r.cancelled_at, 'cancel_note', r.cancel_note,
    'created_at', r.created_at,
    'event_id', r.event_id, 'due_at', r.due_at,
    'past_eod', r.status = 'pending' and r.due_at is not null and now() > r.due_at,
    'punch_at', e.at, 'punch_kind', e.kind, 'place', coalesce(r.place, e.place), 'office_m', coalesce(r.office_m, e.office_m),
    'verify', e.verify, 'flags', case when e.id is not null then to_jsonb(coalesce(e.flags, '{}')) end,
    'selfie', v_sf,
    'reason_kind', r.reason_kind);
end $$;

-- §9.4.5 — a day: the day record, its punches (voided included), visits,
-- km, the requests touching it; for your own day also tracking and who viewed
-- your route. Someone else's day: approvers only (with clock marks). v2.4:
-- each punch gains place, office_m, verify, flags, reason_kind, reason_text,
-- reason_ref, selfie (a photo arrived), selfie_late, selfie_skip, request_id
-- (still no coordinates); the day gains trips[] and field_staff (the
-- person's); each request gains can_decide / can_cancel (as hr_requests_list).
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
                                   end end,
                   'place', e.place, 'office_m', e.office_m, 'verify', e.verify, 'flags', to_jsonb(coalesce(e.flags, '{}')),
                   'reason_kind', e.reason_kind, 'reason_text', e.reason_text, 'reason_ref', e.reason_ref,
                   'selfie', sf.event_id is not null, 'selfie_late', sf.late, 'selfie_skip', e.selfie_skip,
                   'request_id', e.request_id)
                 order by e.at, e.received_at, e.id), '[]'::jsonb)
                 from public.attendance_events e
                 left join public.hr_punch_selfies sf on sf.event_id = e.id
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
    'requests', (select coalesce(jsonb_agg(public._hr_req_json(q) || public._hr_req_acts(q, v_me, v_appr) order by q.created_at), '[]'::jsonb)
                   from public.hr_requests q where lower(q.employee_email) = v_em and v_d between q.date_from and q.date_to),
    'trips', public._hr_day_trips(v_em, v_d, v_now),
    'field_staff', public._hr_is_field(v_t.id));
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

-- §9.4.5 — a day's route: points (≤ 2000, evenly thinned, display only),
-- stops with a place hint, moving / gap segments, km, visits. Someone else's
-- route: approvers only, and the view is recorded in hr_route_views. v2.4
-- adds trips[] (as hr_my_day) so a map can light up each trip's window.
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
                            'visits', v_vis, 'trips', public._hr_day_trips(v_em, v_d, v_now));
end $$;

-- The register (approvers): day records per person for up to 62 days (days
-- after today are not returned), for every active staff member or one person.
-- People are computed in email order (each person's days in date order) —
-- the order every reader writes cached day km in, so two readers never
-- deadlock — and answered in name order. v2.4: each person gains totals
-- (_hr_day_totals: an away-pending day is not present, late or half day);
-- each day gains trip_km (a person's trips are measured after their days).
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
  v_days jsonb;
  v_tk jsonb;
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
    v_days := public._hr_days(r.email, v_from, least(v_to, v_today), v_now, true);
    -- each day gains trip_km (the travel allowance basis, as hr_my_month's days)
    v_tk := public._hr_trip_km_days(r.email, v_from, least(v_to, v_today), v_now);
    select coalesce(jsonb_agg(d.value || jsonb_build_object('trip_km',
             coalesce((select (t.value ->> 'km')::numeric from jsonb_array_elements(v_tk -> 'days') as t(value)
                        where (t.value ->> 'day')::date = (d.value ->> 'day')::date), 0)) order by d.ord), '[]'::jsonb)
      into v_days
      from jsonb_array_elements(v_days) with ordinality as d(value, ord);
    v_people := v_people || jsonb_build_array(jsonb_build_object('email', lower(r.email), 'name', r.full_name,
      'designation', r.designation, 'self', r.id = v_me.id, 'field_staff', public._hr_is_field(r.id),
      'days', v_days, 'totals', public._hr_day_totals(v_days)));
  end loop;
  select coalesce(jsonb_agg(x.value order by x.value ->> 'name', x.value ->> 'email'), '[]'::jsonb) into v_people
    from jsonb_array_elements(v_people) as x(value);
  return jsonb_build_object('now', v_now, 'from', v_from, 'to', v_to, 'people', v_people);
end $$;

-- §1.2 — hr_dashboard's hr block for an approver (and anyone else who needs
-- it): the v2.3 board counts and pending_requests (v2.3 kinds only, the ones
-- you may decide — _hr_can_decide, D10: never your own, a tier 4 / 5
-- account's only for tier 4+), plus on_leave, late_today, away_pending /
-- reasons_pending (the ones you may decide), past_eod (either, past due),
-- unverified_today (today's phone punches that need a look, not your own),
-- unseen_photos (today's photos of punches still standing that no approver
-- has opened, not your own) and on_trip.
create or replace function public._hr_dash_hr(p_me public.profiles, p_now timestamptz)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  v_em text := lower(p_me.email);
  v_today date := public._hr_today(p_now);
  v_live jsonb;
  v_out jsonb;
begin
  select coalesce(jsonb_agg(public._hr_live(p, p_now)), '[]'::jsonb) into v_live
    from public.profiles p where p.active and coalesce(p.is_staff, false);
  select jsonb_build_object(
           'on_duty', count(*) filter (where x.value ->> 'status' = 'on_duty'),
           'on_break', count(*) filter (where x.value ->> 'status' = 'on_break'),
           'on_site', count(*) filter (where x.value ->> 'status' = 'on_site'),
           'absent', count(*) filter (where x.value ->> 'status' = 'absent'),
           'not_in_yet', count(*) filter (where x.value ->> 'status' = 'not_in_yet'),
           'on_leave', count(*) filter (where x.value ->> 'status' = 'on_leave'),
           'late_today', count(*) filter (where coalesce((x.value ->> 'late_min')::int, 0) > 0),
           'on_trip', count(*) filter (where jsonb_typeof(x.value -> 'trip') = 'object'))
    into v_out
    from jsonb_array_elements(v_live) as x(value);
  select v_out || jsonb_build_object(
           'pending_requests', count(*) filter (where q.kind in ('late_start', 'early_leave', 'flexible_day', 'field_day', 'missed_punch', 'leave')
                                                  and public._hr_can_decide(p_me.id, q.employee_email)),
           'away_pending', count(*) filter (where q.kind = 'away_punch' and public._hr_can_decide(p_me.id, q.employee_email)),
           'reasons_pending', count(*) filter (where q.kind = 'punch_reason' and public._hr_can_decide(p_me.id, q.employee_email)),
           'past_eod', count(*) filter (where q.kind in ('punch_reason', 'away_punch') and q.due_at < p_now
                                          and public._hr_can_decide(p_me.id, q.employee_email)))
    into v_out
    from public.hr_requests q
   where q.status = 'pending';
  v_out := v_out || jsonb_build_object(
    'unverified_today', (select count(*) from public.attendance_events e
                          where e.at >= public._hr_at(v_today, '00:00') and e.at < public._hr_at(v_today + 1, '00:00')
                            and e.kind in ('punch_in', 'punch_out') and e.employee_email <> v_em
                            and public._hr_sees(p_me.id, e.employee_email) and public._hr_unverified(e, p_now)),
    'unseen_photos', (select count(*) from public.hr_punch_selfies s
                       where s.event_at >= public._hr_at(v_today, '00:00') and s.event_at < public._hr_at(v_today + 1, '00:00')
                         and s.employee_email <> v_em and public._hr_sees(p_me.id, s.employee_email)
                         and exists (select 1 from public.attendance_events e where e.id = s.event_id and e.voided_at is null)
                         and not exists (select 1 from public.hr_selfie_views v where v.event_id = s.event_id)));
  return v_out;
end $$;

-- §9.9.2 — the phone's dashboard: me (any active staff), hr (approvers only).
-- v2.4: me gains field_staff; hr is _hr_dash_hr (v2.3's keys keep their
-- meaning: pending_requests counts only the v2.3 kinds).
create or replace function public.hr_dashboard()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_now timestamptz := now();
  v_em text := lower(v_me.email);
  st jsonb; v_open jsonb; v_d date; v_rec jsonb; v_out jsonb;
begin
  st := public._hr_state(v_em, v_now);
  v_open := nullif(st -> 'open', 'null'::jsonb);
  v_d := coalesce((v_open ->> 'day')::date, public._hr_today(v_now));
  v_rec := public._hr_days(v_em, v_d, v_d, v_now) -> 0;
  v_out := jsonb_build_object('now', v_now,
    'me', jsonb_build_object('state', st ->> 'state', 'since', st -> 'since', 'worked_min', v_rec -> 'worked_min',
                             'break_min', v_rec -> 'break_min', 'km', v_rec -> 'km', 'flex', v_rec -> 'flex',
                             'late_min', v_rec -> 'late_min', 'missed_out', v_rec -> 'missed_out',
                             'tracking', public._hr_tracking(v_em, v_me.id, v_now, st),
                             'field_staff', public._hr_is_field(v_me.id)));
  if public.has_module('neohr', 'lead') then
    v_out := v_out || jsonb_build_object('hr', public._hr_dash_hr(v_me, v_now));
  end if;
  return v_out;
end $$;

-- The live board (approvers): every active staff member, their live status
-- (§9.6.6), today's numbers, on-site job, last point time (no coordinates).
-- v2.4: pending_requests still counts only the v2.3 kinds (1.12 desktops);
-- punch_requests counts the pending punch_reason / away_punch; each row
-- carries _hr_live's field_staff, trip and punch_check.
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
                                 where q.employee_email = lower(p.email) and q.status = 'pending'
                                   and q.kind in ('late_start', 'early_leave', 'flexible_day', 'field_day', 'missed_punch', 'leave')),
           'punch_requests', (select count(*) from public.hr_requests q
                               where q.employee_email = lower(p.email) and q.status = 'pending'
                                 and q.kind in ('punch_reason', 'away_punch')))
         order by p.full_name, p.email), '[]'::jsonb)
    into v_people
    from public.profiles p
   where p.active and coalesce(p.is_staff, false);
  return jsonb_build_object('now', v_now, 'people', v_people,
    'counts', (select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb)
                 from (select y.value ->> 'status' as status, count(*) as n
                         from jsonb_array_elements(v_people) as y(value) group by 1) x));
end $$;
perform public._hr_lockdown();
end $hr$;


-- ── part 06: verified punches (D2, D3, D5, D6, D9) ──────────────────────────
do $hr$
begin
-- §1.3.8 — what the server made of a punch: {place, office_m, verify, flags,
-- request {ok: true, id, kind, status} | {ok: false, message} (the request
-- could not be made: the punch carries the request_failed flag, so HR sees it
-- in To check) | null, trip, needs_selfie, dropped}. p_trip / p_dropped come
-- from this call; a replay reads everything from the stored row (its trip:
-- the one this punch started).
create or replace function public._hr_punch_check(p_ev public.attendance_events, p_trip jsonb, p_dropped jsonb)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('place', p_ev.place, 'office_m', p_ev.office_m, 'verify', p_ev.verify,
    'flags', to_jsonb(coalesce(p_ev.flags, '{}')),
    'request', coalesce((select jsonb_build_object('ok', true, 'id', q.id, 'kind', q.kind, 'status', q.status)
                           from public.hr_requests q where q.id = p_ev.request_id),
                        case when p_ev.request_id is null and 'request_failed' = any (coalesce(p_ev.flags, '{}'))
                             then jsonb_build_object('ok', false,
                                                     'message', 'HR could not be asked about this punch — it is marked for HR to check.') end),
    'trip', coalesce(p_trip, (select jsonb_build_object('ok', true, 'id', t.id) from public.hr_trips t
                               where t.employee_email = p_ev.employee_email and t.start_source = 'punch_in'
                                 and t.started_at = p_ev.at and t.voided_at is null limit 1)),
    'needs_selfie', p_ev.kind in ('punch_in', 'punch_out') and p_ev.source = 'phone' and p_ev.selfie_skip is null
                    and not exists (select 1 from public.hr_punch_selfies s where s.event_id = p_ev.id),
    'dropped', coalesce(p_dropped, '[]'::jsonb))
$$;

-- §1.3.6 — the request a punch makes (or null), inserted with a fresh id, one
-- per punch (unique event_id), linked on the punch. Its reason is always 3–500
-- characters (a server sentence when none came), date_from = date_to = the
-- session day, due_at = greatest(that day's shift end, the punch + 2 h).
--   field staff, punch_in with a reason: On-site / RMA away from the shop →
--     none (_hr_days excuses the late mark); On-site / RMA elsewhere → a
--     punch_reason only when late; Late / typed → a punch_reason when late or
--     away / unknown (else kept on the punch only). No reason: nothing.
--   everyone else, punch in / out, office point set, duty not wfh / field:
--     away / unknown place, no fix, a fake location, a restored row, sent
--     late or no camera → an away_punch, whatever the payload says.
create or replace function public._hr_punch_request(p_ev public.attendance_events, p_field boolean)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  v_set public.hr_settings;
  v_day date;
  c record;
  v_kind text;
  v_late boolean;
  v_text text;
  r public.hr_requests;
begin
  if p_ev.kind not in ('punch_in', 'punch_out') or p_ev.source <> 'phone' or p_ev.voided_at is not null then return null; end if;
  select * into v_set from public.hr_settings where id = 1;
  v_day := public._hr_session_day(p_ev.employee_email, p_ev.at);
  select * into c from public._hr_ctx(p_ev.profile_id, p_ev.employee_email, v_day, v_day);
  if p_field then
    if p_ev.kind <> 'punch_in' or p_ev.reason_kind is null then return null; end if;
    v_late := public._hr_is_late_punch(p_ev.employee_email, p_ev.profile_id, p_ev.id, p_ev.at);
    if p_ev.reason_kind in ('on_site', 'rma') then
      if p_ev.place = 'away' or not v_late then return null; end if;
    elsif not (v_late or p_ev.place in ('away', 'unknown')) then
      return null;
    end if;
    v_kind := 'punch_reason';
    v_text := coalesce(p_ev.reason_text, case p_ev.reason_kind when 'late' then 'Late — no reason typed'
                                                               when 'on_site' then 'On-site visit'
                                                               when 'rma' then 'RMA trip'
                                                               else 'No reason typed' end);
  else
    if v_set.office_lat is null or c.duty in ('wfh', 'field') then return null; end if;
    if not (coalesce(p_ev.place, 'unknown') in ('away', 'unknown') or p_ev.verify in ('no_fix', 'mock', 'restored')
            or 'sent_late' = any (coalesce(p_ev.flags, '{}')) or p_ev.selfie_skip is not null) then
      return null;
    end if;
    v_kind := 'away_punch';
    v_text := coalesce(p_ev.reason_text,
                case when p_ev.verify = 'old_app' and coalesce(p_ev.place, 'unknown') <> 'office' then 'No reason sent (NeoHR 2.2)'
                     when p_ev.verify = 'mock' then 'The phone reported a fake location'
                     when p_ev.verify = 'restored' then 'Sent from a restored backup'
                     when 'sent_late' = any (coalesce(p_ev.flags, '{}'))
                       then 'Sent ' || greatest(10, round(extract(epoch from p_ev.received_at - p_ev.at) / 60))::int || ' min after the punch time'
                     when p_ev.selfie_skip is not null then 'Camera not available'
                     when p_ev.place = 'away' then 'Away from the shop — no reason given'
                     else 'Location not verified — no reason given' end);
  end if;
  insert into public.hr_requests (id, profile_id, employee_email, kind, date_from, date_to, reason, ref_code, event_id, due_at,
                                  reason_kind, place, office_m)
  values (gen_random_uuid(), p_ev.profile_id, p_ev.employee_email, v_kind, v_day, v_day, left(v_text, 500), p_ev.reason_ref, p_ev.id,
          greatest(public._hr_at(v_day, coalesce(c.shift_end, '18:30')), p_ev.at + interval '2 hours'),
          p_ev.reason_kind, p_ev.place, p_ev.office_m)
  on conflict (event_id) where event_id is not null do nothing
  returning * into r;
  if r.id is null then select * into r from public.hr_requests q where q.event_id = p_ev.id; end if;
  update public.attendance_events set request_id = r.id where id = p_ev.id;
  return jsonb_build_object('id', r.id, 'kind', r.kind, 'status', r.status);
end $$;

-- §9.4.2 / §9.4.3 + §1.3 — one punch for p_email, shared by hr_punch and (via
-- _hr_punch_apply, p_x = {}) the legacy record_field_activity: lock, id
-- (replay → the STORED check / someone else's), fields, time anchoring
-- (§9.3.3), the two-sided check, the 30-a-day cap, the place and the flags,
-- insert, then the request, the trip and the trip ends (each in its own
-- sub-block: they never undo the punch), and the answer with its check.
create or replace function public._hr_punch_core(p_email text, p_id uuid, p_kind text, p_at timestamptz, p_age_ms numeric,
                                                 p_lat double precision, p_lng double precision, p_acc double precision, p_note text,
                                                 p_x jsonb)
returns jsonb language plpgsql volatile set search_path = public as $$
declare
  v_em text := lower(btrim(p_email));
  v_x jsonb := case when jsonb_typeof(p_x) = 'object' then p_x else '{}'::jsonb end;
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  v_ev public.attendance_events;
  v_prof public.profiles;
  v_field boolean;
  v_at timestamptz; v_dev timestamptz; v_src text; v_msg text; v_d date;
  v_new boolean := v_x ? 'v';
  v_fix_age int; v_fix_at timestamptz;
  v_lat float8 := p_lat; v_lng float8 := p_lng; v_acc float8 := p_acc;
  v_pl jsonb; v_place text; v_om int; v_verify text;
  v_mock boolean; v_restored boolean;
  v_rkind text; v_rtext text; v_rref text; v_skip text;
  v_flags text[] := '{}';
  v_sid uuid; v_sat timestamptz; v_ua text; v_prev uuid;
  v_trip jsonb; v_req jsonb; j jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('neo_hr_att:' || v_em));
  select * into v_ev from public.attendance_events where id = p_id;
  if found then
    if v_ev.employee_email <> v_em then raise exception 'NEO_GATE: That punch id is already used.'; end if;
    return public._hr_punch_answer(v_ev, true) || jsonb_build_object('check', public._hr_punch_check(v_ev, null, '[]'::jsonb));
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
  -- R6: at most 30 phone punches a person per India day
  v_d := (v_at at time zone 'Asia/Kolkata')::date;
  if (select count(*) from public.attendance_events e
       where lower(e.employee_email) = v_em and e.source = 'phone'
         and e.at >= public._hr_at(v_d, '00:00') and e.at < public._hr_at(v_d + 1, '00:00')) >= 30 then
    raise exception 'NEO_GATE: Too many punches today — ask HR to correct the day.';
  end if;
  select * into v_prof from public.profiles p where lower(p.email) = v_em order by p.active desc limit 1;
  v_field := public._hr_is_field(v_prof.id);
  -- what came with it (already read leniently by hr_punch; read safely again)
  begin
    v_mock := case when jsonb_typeof(v_x -> 'mock') = 'boolean' then (v_x ->> 'mock')::boolean end;
    v_restored := case when jsonb_typeof(v_x -> 'restored') = 'boolean' then (v_x ->> 'restored')::boolean end;
    v_fix_age := case when coalesce(v_x ->> 'fix_age_ms', '') ~ '^-?[0-9]{1,9}$' then (v_x ->> 'fix_age_ms')::int end;
    j := case when jsonb_typeof(v_x -> 'reason') = 'object' then v_x -> 'reason' end;
    v_rkind := case when j ->> 'kind' in ('late', 'on_site', 'rma', 'other') then j ->> 'kind' end;
    v_rtext := case when char_length(j ->> 'text') between 3 and 500 then j ->> 'text' end;
    v_rref := case when coalesce(j ->> 'ref', '') ~ '^(NT|RM)-[A-Z0-9]{4,12}$' then j ->> 'ref' end;
    v_skip := case when v_x ->> 'selfie_skip' in ('camera_error', 'no_front_camera') then v_x ->> 'selfie_skip' end;
    if p_kind not in ('punch_in', 'punch_out') then v_rkind := null; v_rtext := null; v_rref := null; v_skip := null; end if;
  exception when others then
    v_mock := null; v_restored := null; v_fix_age := null; v_rkind := null; v_rtext := null; v_rref := null; v_skip := null;
  end;
  -- the fix and the place (§1.3.2–3): a 2.3 payload's fix counts only when it
  -- was taken from 30 s after to 120 s before the tap (fix_age_ms, the
  -- phone's elapsed clock — no wall clock involved)
  begin
    if v_new and (v_fix_age is null or v_fix_age < -30000 or v_fix_age > 120000) then
      v_lat := null; v_lng := null; v_acc := null;
    elsif v_new then
      v_fix_at := v_at - v_fix_age * interval '1 millisecond';
    end if;
    v_pl := public._hr_place(v_lat, v_lng, v_acc);
    v_place := v_pl ->> 'place';
    v_om := (v_pl ->> 'office_m')::int;
    v_verify := v_pl ->> 'verify';
    if not v_new then v_verify := 'old_app'; end if;
    if coalesce(v_restored, false) then v_verify := 'restored'; end if;
    if coalesce(v_mock, false) then v_verify := 'mock'; v_place := 'unknown'; v_om := null; end if;
  exception when others then
    v_place := 'unknown'; v_om := null; v_verify := coalesce(v_verify, 'no_fix');
  end;
  -- the flags only the server can set (§1.3.4)
  begin
    if now() - v_at > interval '10 minutes' then v_flags := v_flags || 'sent_late'::text; end if;
    if v_rkind in ('on_site', 'rma') then
      if v_rref is null then
        v_flags := v_flags || 'no_ticket'::text;
      elsif not (exists (select 1 from public.service_jobs sj where upper(sj.public_code) = v_rref and lower(coalesce(sj.assignee_email, '')) = v_em)
                 or exists (select 1 from public.rma_cases rc where upper(rc.public_code) = v_rref and lower(coalesce(rc.handler_email, '')) = v_em)) then
        v_flags := v_flags || 'ticket_not_mine'::text;
      end if;
    end if;
    if v_skip is not null then v_flags := v_flags || 'selfie_skip'::text; end if;
    -- what the phone reported about itself (p.flags, kept in device_flags):
    -- fake-GPS route points it dropped since the last punch, an emulator
    if coalesce(v_x -> 'flags' ->> 'mock_route_points', '') ~ '^[0-9]{1,6}$' and (v_x -> 'flags' ->> 'mock_route_points')::int > 0 then
      v_flags := v_flags || 'mock_route'::text;
    end if;
    if v_x -> 'flags' -> 'emulator' = 'true'::jsonb then v_flags := v_flags || 'emulator'::text; end if;
  exception when others then null;
  end;
  begin
    v_sid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
    if v_sid is not null then
      select s.created_at, s.user_agent into v_sat, v_ua from auth.sessions s where s.id = v_sid;
      select e.auth_session into v_prev from public.attendance_events e
       where lower(e.employee_email) = v_em and e.source = 'phone' and e.auth_session is not null
         and e.received_at > now() - interval '30 days'
       order by e.received_at desc limit 1;
      if (v_sat is not null and v_sat > now() - interval '12 hours') or (v_prev is not null and v_prev <> v_sid) then
        v_flags := v_flags || 'new_login'::text;
      end if;
      if v_ua is not null and lower(v_ua) not like 'okhttp/%' then v_flags := v_flags || 'odd_client'::text; end if;
    end if;
  exception when others then v_sid := null;
  end;
  insert into public.attendance_events (id, profile_id, employee_email, kind, at, device_at, time_source,
                                        lat, lng, accuracy_m, source, note, created_by_email,
                                        place, office_m, fix_at, fix_age_ms, mock, verify, flags, device_flags,
                                        reason_kind, reason_text, reason_ref, selfie_skip, app_code, auth_session)
  values (p_id, v_prof.id, v_em, p_kind, v_at, v_dev, v_src, p_lat, p_lng, p_acc, 'phone', p_note, v_em,
          v_place, v_om, v_fix_at, v_fix_age, case when v_new then coalesce(v_mock, false) end, v_verify, v_flags,
          case when jsonb_typeof(v_x -> 'flags') = 'object' then v_x -> 'flags' end,
          v_rkind, v_rtext, v_rref, v_skip, case when v_new and coalesce(v_x ->> 'v', '') ~ '^[0-9]{1,9}$' then (v_x ->> 'v')::int end, v_sid)
  returning * into v_ev;
  perform public._hr_invalidate(v_em, v_at);
  -- the request (never undoes the punch; a failure is reported in check.request
  -- and marks the punch request_failed, so it is never silently counted)
  begin
    v_req := public._hr_punch_request(v_ev, v_field);
  exception when others then
    v_req := jsonb_build_object('ok', false);
    raise log 'neohr _hr_punch_request failed for punch %: % (%)', v_ev.id, sqlerrm, sqlstate;
  end;
  if v_req ->> 'ok' = 'false' then
    begin
      update public.attendance_events set flags = coalesce(flags, '{}') || 'request_failed'::text
       where id = v_ev.id and not ('request_failed' = any (coalesce(flags, '{}')));
    exception when others then null;
    end;
  end if;
  -- a trip started with the punch_in (p.trip)
  if p_kind = 'punch_in' and v_x ? 'trip' then
    begin
      if jsonb_typeof(v_x -> 'trip') <> 'object' or coalesce(v_x -> 'trip' ->> 'id', '') = '' then
        v_trip := jsonb_build_object('ok', false, 'message', 'The trip was not started — start it with the trip button.');
      else
        j := public._hr_trip_begin(v_prof, (v_x -> 'trip' ->> 'id')::uuid, v_x -> 'trip' ->> 'kind', v_at,
                                   v_x -> 'trip' ->> 'ref_code', v_x -> 'trip' ->> 'note', p_lat, p_lng, p_acc, 'punch_in');
        v_trip := jsonb_build_object('ok', true, 'id', j -> 'trip' -> 'id');
      end if;
    exception when others then
      v_trip := jsonb_build_object('ok', false, 'message', coalesce(public._hr_msg(sqlerrm), 'The trip was not started — start it with the trip button.'));
    end;
  end if;
  -- the session ends of the trips around it (a punch_out ends its open trips)
  if p_kind in ('punch_in', 'punch_out') then
    begin
      perform public._hr_trip_sync(v_em, v_at - make_interval(hours => v_h), v_at + make_interval(hours => v_h), now());
    exception when others then null;
    end;
  end if;
  select * into v_ev from public.attendance_events where id = p_id;
  return public._hr_punch_answer(v_ev, false)
         || jsonb_build_object('check', public._hr_punch_check(v_ev, v_trip, coalesce(v_x -> 'dropped', '[]'::jsonb)));
end $$;

-- §9.4.2 / §9.4.3 — one punch for p_email, shared by hr_punch and the legacy
-- record_field_activity (v2.4: the same 9 arguments; it goes through
-- _hr_punch_core with no v2.4 keys, so a legacy punch is an old_app punch and
-- gets the same place, flags and request rules).
create or replace function public._hr_punch_apply(p_email text, p_id uuid, p_kind text, p_at timestamptz, p_age_ms numeric,
                                                  p_lat double precision, p_lng double precision, p_acc double precision, p_note text)
returns jsonb language plpgsql volatile set search_path = public as $$
begin
  return public._hr_punch_core(p_email, p_id, p_kind, p_at, p_age_ms, p_lat, p_lng, p_acc, p_note, '{}'::jsonb);
end $$;

-- §9.4.3 + §1.3 — p = {id, kind, at, age_ms?, lat?, lng?, accuracy_m?, note?,
-- v2.4 (all optional, read leniently): v, fix_age_ms, mock, restored,
-- reason {kind, text, ref}, selfie_skip, flags, trip {id, kind, ref_code,
-- note}} → {ok, duplicate, now, id, state, since, day, tracking, check}
-- (+ voided:true for a replay of a voided id). Any 'source' key is ignored.
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
  -- a restored row is never server-anchored (its elapsed clock is from another boot)
  if public._hr_punch_extras(p) -> 'restored' = 'true'::jsonb then v_age := null; end if;
  return public._hr_punch_core(v_me.email, v_id, v_kind, v_at, v_age, v_lat::float8, v_lng::float8, v_acc::float8, v_note,
                               public._hr_punch_extras(p));
end $$;
perform public._hr_lockdown();
end $hr$;


-- ── part 07: deciding, cancelling, listing, correcting ─────────────────────
do $hr$
begin
-- §9.6.2 — approve or reject (approvers, never their own; a tier 4 / 5
-- account's only by tier 4+). v2.4 (R3): every refusal here is NEO_GATE, and
-- a punch_reason / away_punch is decided only by hr_punch_request_decide
-- (NeoHR 2.3 / Neo OS 1.12.1). Approving a missed_punch adds the 'hr' punch,
-- checked now like an HR correction (_hr_check_ops); when it needs another
-- punch voided too, hr_correct with request_id approves it with that change.
-- A full-day leave or a field day writes the roster for its working days. A
-- request no longer pending answers 'decided' with whoever decided it (or
-- cancelled it, when it was cancelled).
create or replace function public.hr_request_decide(p_id uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  r public.hr_requests;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_eid uuid;
begin
  if not public.has_module('neohr', 'lead') then
    raise exception 'NEO_GATE: Only a head or a NeoHR lead can approve requests.';
  end if;
  select * into r from public.hr_requests where id = p_id;
  if not found then raise exception 'NEO_GATE: That request no longer exists.'; end if;
  if r.kind in ('punch_reason', 'away_punch') then
    raise exception 'NEO_GATE: Update NeoHR / Neo OS to decide punch reasons.';
  end if;
  perform public._hr_decide_gate(v_me, r);
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
      insert into public.attendance_events (id, profile_id, employee_email, kind, at, device_at, time_source, source, note, created_by_email, verify)
      values (v_eid, r.profile_id, r.employee_email, r.missed_kind, r.missed_at, null, 'hr', 'hr', left(r.reason, 500), lower(v_me.email), 'hr');
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

-- §1.3 — decide a punch_reason or an away_punch (NeoHR 2.3, Neo OS 1.12.1;
-- any other kind goes on to hr_request_decide). Approvers, never their own;
-- a tier 4 / 5 account's only by tier 4+.
--   punch_reason: approve → the late mark is excused; reject → it stays.
--   away_punch: approve → the punch counts; reject (a note is required) →
--     the punch is voided ('HR rejected the away punch: <note>'); with
--     p_correct_at, an hr punch of the same kind is added at that time when
--     the day's punches allow it, else correct = {ok:false, message} (open
--     Correct… to fix the day).
-- → {ok, request, day (the session day's record), correct}
create or replace function public.hr_punch_request_decide(p_id uuid, p_approve boolean, p_note text default null,
                                                          p_correct_at timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  r public.hr_requests;
  e public.attendance_events;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_day date;
  v_eid uuid;
  v_msg text;
  v_corr jsonb;
begin
  if not public.has_module('neohr', 'lead') then
    raise exception 'NEO_GATE: Only a head or a NeoHR lead can approve requests.';
  end if;
  select * into r from public.hr_requests where id = p_id;
  if not found then raise exception 'NEO_GATE: That request no longer exists.'; end if;
  if r.kind not in ('punch_reason', 'away_punch') then
    return public.hr_request_decide(p_id, p_approve, p_note);
  end if;
  perform public._hr_decide_gate(v_me, r);
  if p_approve is null then raise exception 'NEO_GATE: Say approve or reject.'; end if;
  if char_length(coalesce(v_note, '')) > 300 then raise exception 'NEO_GATE: The note is too long — keep it under 300 characters.'; end if;
  if not p_approve and r.kind = 'away_punch' and v_note is null then
    raise exception 'NEO_GATE: Say why — the person sees your note.';
  end if;
  if not p_approve and p_correct_at is not null
     and (p_correct_at < timestamptz '2020-01-01 00:00:00+00' or p_correct_at > now() + interval '10 minutes') then
    raise exception 'NEO_GATE: That time can''t be right — check the date.';
  end if;
  perform pg_advisory_xact_lock(hashtext('neo_hr_att:' || r.employee_email));
  select * into r from public.hr_requests where id = p_id for update;
  if r.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'decided', 'status', r.status,
                              'by', case when r.status = 'cancelled' then r.cancelled_by_name else r.decided_by_name end,
                              'at', case when r.status = 'cancelled' then r.cancelled_at else r.decided_at end);
  end if;
  if r.event_id is not null then select * into e from public.attendance_events x where x.id = r.event_id; end if;
  v_day := r.date_from;
  if r.kind = 'away_punch' and e.id is not null then
    if not p_approve and e.voided_at is null then
      update public.attendance_events
         set voided_at = now(), voided_by = lower(v_me.email), void_reason = left('HR rejected the away punch: ' || v_note, 500)
       where id = e.id;
      perform public._hr_invalidate(r.employee_email, e.at);
      if p_correct_at is not null then
        v_eid := gen_random_uuid();
        v_msg := public._hr_check_ops(r.employee_email, '{}'::uuid[],
                                      jsonb_build_array(jsonb_build_object('id', v_eid::text, 'kind', e.kind, 'at', p_correct_at)));
        if v_msg is null then
          insert into public.attendance_events (id, profile_id, employee_email, kind, at, device_at, time_source, source, note,
                                                created_by_email, verify)
          values (v_eid, r.profile_id, r.employee_email, e.kind, p_correct_at, null, 'hr', 'hr',
                  left('HR entered the right time: ' || v_note, 500), lower(v_me.email), 'hr');
          perform public._hr_invalidate(r.employee_email, p_correct_at);
          v_corr := jsonb_build_object('ok', true, 'event', jsonb_build_object('id', v_eid, 'kind', e.kind, 'at', p_correct_at));
        else
          v_corr := jsonb_build_object('ok', false, 'message', v_msg);
        end if;
      end if;
      begin
        perform public._hr_trip_sync(r.employee_email, least(e.at, coalesce(p_correct_at, e.at)) - make_interval(hours => v_h),
                                     greatest(e.at, coalesce(p_correct_at, e.at)) + make_interval(hours => v_h), now());
      exception when others then null;
      end;
    else
      perform public._hr_invalidate(r.employee_email, e.at);
    end if;
  end if;
  update public.hr_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by_email = lower(v_me.email), decided_by_name = v_me.full_name, decided_at = now(), decision_note = v_note
   where id = p_id
  returning * into r;
  return jsonb_build_object('ok', true, 'request', public._hr_req_json(r),
                            'day', public._hr_days(r.employee_email, v_day, v_day, now(), true) -> 0,
                            'correct', v_corr);
end $$;

-- §9.6.3 — the owner: a pending request any time, an approved one before it
-- starts. An approver (never on their own): pending or approved, with a note.
-- Cancelling removes the roster rows the request made. v2.4: an away punch
-- is never cancelled (HR decides it; a cancel would make it count unseen); a
-- punch reason may be cancelled by its owner while pending (the late mark
-- stays).
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
  if r.kind = 'away_punch' and r.status in ('pending', 'approved') then
    raise exception 'NEO_GATE: HR decides an away punch — ask them.';
  end if;
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

-- 'mine' (my requests), 'pending' (approvers: everyone's pending), 'all'
-- (approvers: everyone's in a date range, default the last 31 days to 90
-- ahead) — all three keep to the v2.3 kinds for NeoHR 2.2 / Neo OS 1.12
-- (spec §9). 'mine_v4', 'pending_v4' / 'all_v4' (NeoHR 2.3, Neo OS 1.12.1):
-- the same with punch_reason and away_punch; pending_v4 / all_v4 pending
-- first, past end of day first, then the oldest. An unknown scope keeps the
-- v2.3 sentence (newer clients fall back on it). can_decide / can_cancel:
-- _hr_req_acts (an away punch is never can_cancel).
create or replace function public.hr_requests_list(p_scope text default 'mine', p_from date default null, p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_em text := lower(v_me.email);
  v_appr boolean := public.has_module('neohr', 'lead');
  v_today date := public._hr_today(now());
  v_scope text := lower(coalesce(nullif(btrim(p_scope), ''), 'mine'));
  v_old constant text[] := array['late_start', 'early_leave', 'flexible_day', 'field_day', 'missed_punch', 'leave'];
  v_v4 boolean;
  v_out jsonb;
begin
  if v_scope not in ('mine', 'pending', 'all', 'mine_v4', 'pending_v4', 'all_v4') then
    raise exception 'NEO_GATE: The scope is mine, pending or all.';
  end if;
  if v_scope not in ('mine', 'mine_v4') and not v_appr then
    raise exception 'NEO_DENIED: Only a head or a NeoHR lead can see everyone''s requests.';
  end if;
  v_v4 := v_scope in ('pending_v4', 'all_v4');
  select coalesce(jsonb_agg(public._hr_req_json(q) || public._hr_req_acts(q, v_me, v_appr)
         order by case when q.status = 'pending' then 0 else 1 end,
                  case when v_v4 and q.status = 'pending' and q.due_at is not null and q.due_at < now() then 0 else 1 end,
                  case when v_v4 then q.created_at end asc,
                  q.created_at desc), '[]'::jsonb)
    into v_out
    from (select * from public.hr_requests q
           where case v_scope
                   when 'mine' then q.employee_email = v_em and q.kind = any (v_old)
                                    and (p_from is null or q.date_to >= p_from) and (p_to is null or q.date_from <= p_to)
                   when 'mine_v4' then q.employee_email = v_em
                                       and (p_from is null or q.date_to >= p_from) and (p_to is null or q.date_from <= p_to)
                   when 'pending' then q.status = 'pending' and q.kind = any (v_old)
                   when 'pending_v4' then q.status = 'pending'
                   when 'all' then q.kind = any (v_old)
                                   and q.date_to >= coalesce(p_from, v_today - 31) and q.date_from <= coalesce(p_to, v_today + 90)
                   else q.date_to >= coalesce(p_from, v_today - 31) and q.date_from <= coalesce(p_to, v_today + 90)
                 end
           order by q.created_at desc
           limit 500) q;
  return jsonb_build_object('now', now(), 'scope', v_scope, 'requests', v_out);
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
-- v2.4: a voided punch takes its pending punch_reason / away_punch with it
-- (cancelled: 'The punch was corrected by HR'); an added punch_in that
-- replaces a voided punch_in of the same session day keeps its reason and
-- place (and an approved punch reason moves to it); trip ends follow.
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
  v_h int := coalesce((select s.max_session_h from public.hr_settings s where s.id = 1), 16);
  v_ops jsonb; o jsonb; v_note text; v_kind text; v_at timestamptz; v_id uuid; v_msg text;
  v_rid uuid;
  r public.hr_requests;
  v_void uuid[] := '{}';
  v_add jsonb := '[]'::jsonb;
  v_order uuid[] := '{}';
  v_dayof jsonb := '{}'::jsonb;
  v_ev public.attendance_events;
  v_old public.attendance_events;
  y jsonb;
  v_lo timestamptz; v_hi timestamptz;
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
  -- v2.4: a voided punch takes its pending punch reason / away punch with it
  update public.hr_requests
     set status = 'cancelled', cancelled_by_email = lower(v_me.email), cancelled_by_name = v_me.full_name, cancelled_at = now(),
         cancel_note = 'The punch was corrected by HR'
   where event_id = any (v_void) and status = 'pending' and kind in ('punch_reason', 'away_punch');
  insert into public.attendance_events (id, profile_id, employee_email, kind, at, device_at, time_source, source, note, created_by_email, verify)
  select (y.value ->> 'id')::uuid, v_t.id, v_em, y.value ->> 'kind', (y.value ->> 'at')::timestamptz, null, 'hr', 'hr',
         y.value ->> 'note', lower(v_me.email), 'hr'
    from jsonb_array_elements(v_add) as y(value);
  select v_dayof || coalesce(jsonb_object_agg(y.value ->> 'id', public._hr_session_day(v_em, (y.value ->> 'at')::timestamptz)), '{}'::jsonb)
    into v_dayof
    from jsonb_array_elements(v_add) as y(value);
  -- v2.4: a punch_in that replaces a voided punch_in of the same session day keeps its reason and place
  for y in select x.value from jsonb_array_elements(v_add) as x(value) where x.value ->> 'kind' = 'punch_in' loop
    select e.* into v_old from public.attendance_events e
     where e.id = any (v_void) and e.kind = 'punch_in'
       and (v_dayof ->> e.id::text)::date = (v_dayof ->> (y ->> 'id'))::date
     order by e.at limit 1;
    if v_old.id is not null and (v_old.reason_kind is not null or v_old.place is not null) then
      update public.attendance_events
         set reason_kind = v_old.reason_kind, reason_ref = v_old.reason_ref, reason_text = v_old.reason_text,
             place = v_old.place, office_m = v_old.office_m
       where id = (y ->> 'id')::uuid;
      update public.hr_requests set event_id = (y ->> 'id')::uuid
       where event_id = v_old.id and kind = 'punch_reason' and status = 'approved';
    end if;
  end loop;
  -- the cached km of every day touched, earliest first (the order readers cache in)
  perform public._hr_invalidate(v_em, e.at)
     from public.attendance_events e where e.id = any (v_order)
    order by e.at;
  -- v2.4: trip ends follow the sessions
  select min(e.at), max(e.at) into v_lo, v_hi from public.attendance_events e where e.id = any (v_order);
  if v_lo is not null then
    begin
      perform public._hr_trip_sync(v_em, v_lo - make_interval(hours => v_h), v_hi + make_interval(hours => v_h), now());
    exception when others then null;
    end;
  end if;
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


-- ── part 08: punch photos and HR's look at the day's punches (D5, D9) ───────
do $hr$
begin
-- p = {event_id, taken_at, jpeg_b64, thumb_b64?, w, h} — the photo of one of
-- my phone punches in / out (not voided, within retention_days). The punch
-- not here yet → {ok:false, wait:true} (send it again after the punch). The
-- same punch again → {ok:true, duplicate:true} (never replaced). JPEG,
-- 2000–60000 bytes; the thumb a JPEG ≤ 8 KB. late = it arrived more than 10
-- minutes after its punch; a taken_at outside [the tap − 2 min, + 10 min]
-- flags the punch (selfie_time). Caps (R6): 8 photos a person a day, and
-- nothing while the store is over 200 MB. → {ok, duplicate, late}
create or replace function public.hr_selfie_put(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_em text := lower(v_me.email);
  v_today date := public._hr_today(now());
  v_ret int := coalesce((select s.retention_days from public.hr_settings s where s.id = 1), 90);
  v_eid uuid;
  e public.attendance_events;
  v_b64 text; v_tb64 text;
  v_jpeg bytea; v_thumb bytea;
  v_md5 text;
  v_taken timestamptz;
  v_w int; v_h int;
  v_late boolean;
  v_ref timestamptz;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEO_GATE: The request is empty.'; end if;
  v_eid := public._juuid(p, 'event_id');
  if v_eid is null then raise exception 'NEO_GATE: Say which punch the photo is for.'; end if;
  perform pg_advisory_xact_lock(hashtext('neo_hr_att:' || v_em));
  select * into e from public.attendance_events where id = v_eid;
  if not found then return jsonb_build_object('ok', false, 'wait', true); end if;
  if e.employee_email <> v_em then raise exception 'NEO_GATE: That punch is someone else''s.'; end if;
  if e.kind not in ('punch_in', 'punch_out') or e.source <> 'phone' then
    raise exception 'NEO_GATE: A photo goes with a punch in or a punch out.';
  end if;
  if e.voided_at is not null then raise exception 'NEO_GATE: That punch was removed.'; end if;
  if e.at < public._hr_at(v_today - v_ret, '00:00') then raise exception 'NEO_GATE: That punch is too old for a photo.'; end if;
  if exists (select 1 from public.hr_punch_selfies s where s.event_id = v_eid) then
    return jsonb_build_object('ok', true, 'duplicate', true, 'late', (select s.late from public.hr_punch_selfies s where s.event_id = v_eid));
  end if;
  v_b64 := case when jsonb_typeof(p -> 'jpeg_b64') = 'string' then regexp_replace(p ->> 'jpeg_b64', '\s', '', 'g') end;
  if v_b64 is null or v_b64 = '' then raise exception 'NEO_GATE: The photo could not be read — take it again.'; end if;
  if length(v_b64) > 81000 or length(v_b64) < 2600 then raise exception 'NEO_GATE: The photo must be between 2 KB and 60 KB.'; end if;
  begin
    v_jpeg := decode(v_b64, 'base64');
  exception when others then
    raise exception 'NEO_GATE: The photo could not be read — take it again.';
  end;
  if octet_length(v_jpeg) < 2000 or octet_length(v_jpeg) > 60000 then raise exception 'NEO_GATE: The photo must be between 2 KB and 60 KB.'; end if;
  if substring(v_jpeg from 1 for 3) <> '\xffd8ff'::bytea then raise exception 'NEO_GATE: That is not a JPEG photo.'; end if;
  if jsonb_typeof(p -> 'thumb_b64') = 'string' and btrim(p ->> 'thumb_b64') <> '' then
    v_tb64 := regexp_replace(p ->> 'thumb_b64', '\s', '', 'g');
    begin
      v_thumb := case when length(v_tb64) <= 11000 then decode(v_tb64, 'base64') end;
    exception when others then v_thumb := null;
    end;
    if v_thumb is null or octet_length(v_thumb) > 8192 or octet_length(v_thumb) < 4 or substring(v_thumb from 1 for 3) <> '\xffd8ff'::bytea then
      raise exception 'NEO_GATE: The small photo must be a JPEG under 8 KB.';
    end if;
  end if;
  if (select count(*) from public.hr_punch_selfies s
       where s.employee_email = v_em and s.received_at >= public._hr_at(v_today, '00:00')) >= 8 then
    raise exception 'NEO_GATE: Too many photos today.';
  end if;
  if pg_total_relation_size('public.hr_punch_selfies') > 200 * 1024 * 1024 then
    raise exception 'NEO_GATE: The photo store is full — tell the owner.';
  end if;
  v_md5 := md5(v_jpeg);
  if exists (select 1 from public.hr_punch_selfies s where s.md5 = v_md5) then
    raise exception 'NEO_GATE: That photo was already used.';
  end if;
  begin
    v_taken := case when jsonb_typeof(p -> 'taken_at') = 'string' then (p ->> 'taken_at')::timestamptz end;
  exception when others then v_taken := null;
  end;
  v_w := case when coalesce(p ->> 'w', '') ~ '^[0-9]{1,5}$' and (p ->> 'w')::int between 1 and 10000 then (p ->> 'w')::int end;
  v_h := case when coalesce(p ->> 'h', '') ~ '^[0-9]{1,5}$' and (p ->> 'h')::int between 1 and 10000 then (p ->> 'h')::int end;
  v_late := now() > e.received_at + interval '10 minutes';
  begin
    insert into public.hr_punch_selfies (event_id, profile_id, employee_email, event_at, taken_at, jpeg, thumb, bytes, width, height, md5, late)
    values (v_eid, v_me.id, v_em, e.at, v_taken, v_jpeg, v_thumb, octet_length(v_jpeg), v_w, v_h, v_md5, v_late);
  exception when unique_violation then
    raise exception 'NEO_GATE: That photo was already used.';
  end;
  -- the phone's clock at the tap is device_at (or at): a photo taken far from it is flagged on the punch
  v_ref := coalesce(e.device_at, e.at);
  if v_taken is not null and (v_taken < v_ref - interval '2 minutes' or v_taken > v_ref + interval '10 minutes')
     and not ('selfie_time' = any (coalesce(e.flags, '{}'))) then
    update public.attendance_events set flags = coalesce(flags, '{}') || 'selfie_time'::text where id = v_eid;
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false, 'late', v_late);
end $$;

-- The full photo of a punch (approvers; a tier 4 / 5 account's only to tier
-- 4+). Every call is logged in hr_selfie_views. → {ok, event_id, at, jpeg_b64,
-- taken_at, w, h, late}
create or replace function public.hr_selfie_get(p_event_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  s public.hr_punch_selfies;
begin
  if not public.has_module('neohr', 'lead') then
    raise exception 'NEO_GATE: Only a head or a NeoHR lead can see punch photos.';
  end if;
  select * into s from public.hr_punch_selfies x where x.event_id = p_event_id;
  if not found then raise exception 'NEO_GATE: That photo is not there any more.'; end if;
  if not public._hr_sees(v_me.id, s.employee_email) then
    raise exception 'NEO_GATE: Only tier 4 and above can see the photos of a tier 4 or 5 account.';
  end if;
  insert into public.hr_selfie_views (viewer_email, event_id) values (lower(v_me.email), s.event_id);
  return jsonb_build_object('ok', true, 'event_id', s.event_id, 'at', s.event_at,
                            'jpeg_b64', replace(encode(s.jpeg, 'base64'), E'\n', ''),
                            'taken_at', s.taken_at, 'w', s.width, 'h', s.height, 'late', s.late);
end $$;

-- HR's look at a day (approvers; default today, India): every punch in / out
-- of that India day the caller may see — flagged / unverified first, then by
-- time — with the server's view of it, its request, its photo (thumb; full
-- size through hr_selfie_get) and which photo of the person came before it
-- (to compare: open it with hr_selfie_get — no second thumb here, it would
-- double what every poll sends). Thumbs are not logged as views (full photos
-- are).
-- → {now, day, punches:[{id, event_id (= id), email, name, field_staff, kind,
--    at, received_at, source, place, office_m, verify, flags, device_flags
--    (what the phone reported about itself), reason_kind, reason_text,
--    reason_ref, selfie_skip, unverified, request {id, kind, status} | null,
--    selfie {thumb_b64, has_thumb, late, taken_at, w, h, seen_by_me,
--    seen_by_any} | null, prev_selfie {event_id, event_at} | null}],
--    counts {punches, unverified}}
create or replace function public.hr_punch_checks(p_day date default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_now timestamptz := now();
  v_d date := coalesce(p_day, public._hr_today(now()));
  v_rows jsonb;
begin
  if not public.has_module('neohr', 'lead') then
    raise exception 'NEO_GATE: Only a head or a NeoHR lead can see the punch checks.';
  end if;
  select coalesce(jsonb_agg(x.j order by x.unv desc, x.at, x.id), '[]'::jsonb) into v_rows
    from (select e.id, e.at, public._hr_unverified(e, v_now) as unv,
                 jsonb_build_object('id', e.id, 'event_id', e.id, 'email', e.employee_email,
                   'name', (select p.full_name from public.profiles p where lower(p.email) = e.employee_email order by p.active desc limit 1),
                   'field_staff', public._hr_is_field(e.profile_id),
                   'kind', e.kind, 'at', e.at, 'received_at', e.received_at, 'source', e.source,
                   'place', e.place, 'office_m', e.office_m, 'verify', e.verify, 'flags', to_jsonb(coalesce(e.flags, '{}')),
                   'device_flags', e.device_flags,
                   'reason_kind', e.reason_kind, 'reason_text', e.reason_text, 'reason_ref', e.reason_ref, 'selfie_skip', e.selfie_skip,
                   'unverified', public._hr_unverified(e, v_now),
                   'request', (select jsonb_build_object('id', q.id, 'kind', q.kind, 'status', q.status)
                                 from public.hr_requests q where q.id = e.request_id),
                   'selfie', public._hr_selfie_brief(e.id, v_me.id),
                   'prev_selfie', (select jsonb_build_object('event_id', s.event_id, 'event_at', s.event_at)
                                     from public.hr_punch_selfies s
                                    where s.employee_email = e.employee_email and s.event_at < e.at
                                    order by s.event_at desc limit 1)) as j
            from public.attendance_events e
           where e.kind in ('punch_in', 'punch_out') and e.voided_at is null
             and e.at >= public._hr_at(v_d, '00:00') and e.at < public._hr_at(v_d + 1, '00:00')
             and public._hr_sees(v_me.id, e.employee_email)) x;
  return jsonb_build_object('now', v_now, 'day', v_d, 'punches', v_rows,
    'counts', jsonb_build_object('punches', jsonb_array_length(v_rows),
                                 'unverified', (select count(*) from jsonb_array_elements(v_rows) as r(value)
                                                 where (r.value ->> 'unverified')::boolean)));
end $$;
perform public._hr_lockdown();
end $hr$;


-- ── part 09: trips (D7, D8) and retention ──────────────────────────────────
do $hr$
begin
-- p = {id, kind (on_site | rma), at, age_ms?, ref_code? (NT-… / RM-…), note?,
-- lat?, lng?, accuracy_m?} — start a trip (field staff, while punched in and
-- not on a break). Idempotent by id. → {ok, duplicate, trip}
create or replace function public.hr_trip_start(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_id uuid;
  v_at timestamptz;
  v_dev timestamptz;
  v_age numeric;
  v_lat numeric; v_lng numeric; v_acc numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEO_GATE: The request is empty.'; end if;
  v_id := public._juuid(p, 'id');
  if v_id is null then raise exception 'NEO_GATE: id is required — make one UUID per trip and reuse it on every retry.'; end if;
  v_dev := public._jts(p, 'at', 'The time');
  if jsonb_typeof(p -> 'age_ms') = 'number' then v_age := (p ->> 'age_ms')::numeric; end if;
  if v_age is not null and v_age >= 0 and v_age <= 604800000 then
    v_at := now() - v_age * interval '1 millisecond';
  elsif v_dev is null then
    v_at := now();
  else
    if v_dev < timestamptz '2020-01-01 00:00:00+00' or v_dev > now() + interval '10 minutes' then
      raise exception 'NEO_GATE: The phone''s clock is wrong — turn on automatic date and time, then punch again.';
    end if;
    v_at := v_dev;
  end if;
  begin
    v_lat := public._jnum(p, 'lat', 'The latitude');
    v_lng := public._jnum(p, 'lng', 'The longitude');
    v_acc := public._jnum(p, 'accuracy_m', 'The accuracy');
  exception when others then v_lat := null; v_lng := null; v_acc := null;
  end;
  if v_lat is null or v_lng is null or v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180 then
    v_lat := null; v_lng := null; v_acc := null;
  end if;
  if v_acc is not null and v_acc < 0 then v_acc := null; end if;
  return public._hr_trip_begin(v_me, v_id, public._jtxt(p, 'kind', 20, 'Kind'), v_at, public._jtxt(p, 'ref_code', 20, 'The job code'),
                               public._jtxt(p, 'note', 400, 'The note'), v_lat::float8, v_lng::float8, v_acc::float8, 'phone');
end $$;

-- p = {id, at, age_ms?, lat?, lng?, accuracy_m?} — end my trip. An unknown or
-- voided id → {ok:false, unknown:true}. The end is clamped to [the start +
-- 1 s, the end of its session]; an end the session made (punch-out, cap,
-- the next trip) that is later than the tap is replaced by the tap; a trip
-- already ended by a tap answers duplicate. → {ok, duplicate, trip}
create or replace function public.hr_trip_end(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  v_em text := lower(v_me.email);
  v_id uuid;
  v_at timestamptz;
  v_dev timestamptz;
  v_age numeric;
  v_lat numeric; v_lng numeric; v_acc numeric;
  t public.hr_trips;
  e jsonb;
  v_send timestamptz;
  v_flags text[];
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEO_GATE: The request is empty.'; end if;
  v_id := public._juuid(p, 'id');
  if v_id is null then raise exception 'NEO_GATE: id is required — make one UUID per trip and reuse it on every retry.'; end if;
  v_dev := public._jts(p, 'at', 'The time');
  if jsonb_typeof(p -> 'age_ms') = 'number' then v_age := (p ->> 'age_ms')::numeric; end if;
  if v_age is not null and v_age >= 0 and v_age <= 604800000 then
    v_at := now() - v_age * interval '1 millisecond';
  elsif v_dev is null then
    v_at := now();
  else
    if v_dev < timestamptz '2020-01-01 00:00:00+00' or v_dev > now() + interval '10 minutes' then
      raise exception 'NEO_GATE: The phone''s clock is wrong — turn on automatic date and time, then punch again.';
    end if;
    v_at := v_dev;
  end if;
  begin
    v_lat := public._jnum(p, 'lat', 'The latitude');
    v_lng := public._jnum(p, 'lng', 'The longitude');
    v_acc := public._jnum(p, 'accuracy_m', 'The accuracy');
  exception when others then v_lat := null; v_lng := null; v_acc := null;
  end;
  if v_lat is null or v_lng is null or v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180 then
    v_lat := null; v_lng := null; v_acc := null;
  end if;
  perform pg_advisory_xact_lock(hashtext('neo_hr_att:' || v_em));
  select * into t from public.hr_trips where id = v_id;
  if not found or t.employee_email <> v_em or t.voided_at is not null then
    return jsonb_build_object('ok', false, 'unknown', true);
  end if;
  if t.ended_at is not null and t.end_reason in ('tapped', 'hr') then
    return jsonb_build_object('ok', true, 'duplicate', true, 'trip', public._hr_trip_json(t, now(), true));
  end if;
  e := public._hr_trip_eff(t, now());
  v_send := (nullif(e -> 'sess', 'null'::jsonb) ->> 'end_at')::timestamptz;
  v_at := greatest(t.started_at + interval '1 second', least(v_at, coalesce(v_send, 'infinity'::timestamptz)));
  if t.ended_at is not null and t.ended_at <= v_at then
    return jsonb_build_object('ok', true, 'duplicate', true, 'trip', public._hr_trip_json(t, now(), true));
  end if;
  v_flags := coalesce(t.flags, '{}');
  if now() - v_at > interval '10 minutes' and not ('sent_late' = any (v_flags)) then v_flags := v_flags || 'sent_late'::text; end if;
  update public.hr_trips
     set ended_at = v_at, end_source = 'phone', end_reason = 'tapped',
         end_lat = v_lat::float8, end_lng = v_lng::float8, end_acc = case when v_lat is not null then v_acc::float8 end,
         flags = v_flags
   where id = t.id
  returning * into t;
  return jsonb_build_object('ok', true, 'duplicate', false, 'trip', public._hr_trip_json(t, now(), true));
end $$;

-- §9.8 (v2.4 adds trips and photos) — retention. Cutoff = today (India) −
-- retention_days.
--  1) A point may belong to the session of its India day or of the day before
--     (a session may run past midnight): every such (person, day) before the
--     cutoff that holds a punch_in gets a FINAL hr_day_km row from _hr_track.
--     A day without one has no session to keep a km for, and is never tracked.
--  1b) v2.4: every trip that started before the cutoff gets its session end
--     and its final km (before its points go), oldest first whoever it
--     belongs to; its coordinates are cleared.
--  2) A point goes once each of its two days is final or holds no punch_in,
--     in batches of 5000 — but never while it lies inside a trip that is not
--     final yet (v2.4: a bounded call finalises at most 50 trips).
--  3) Punch coordinates before the cutoff are nulled — in attendance_events
--     and in the pre-v2.3 punch rows field_activity still holds.
--  3b) v2.4: punch photos of punches before the cutoff, and their view log.
--  4) last_purge_at is set only when nothing older than the cutoff is left.
-- p_max_rows given (location_push's fallback, inside a phone's request): only
-- the oldest p_max_rows expired points are looked at, at most 20 of their
-- days are made final (oldest first) and only those points are deleted — a
-- bounded amount of work per call, and every call's work stays done (a final
-- row is never recomputed, a deleted point never comes back), so a backlog
-- shrinks call after call (trips: at most 50 a call). Without it (the cron):
-- everything, in one go. Final rows are written in (email, day) order, the
-- order readers cache in.
create or replace function public._hr_purge(p_max_rows int default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_set public.hr_settings;
  v_cut date;
  v_cut_ts timestamptz;
  v_scan int := case when p_max_rows is null then null else greatest(p_max_rows, 1) end;
  v_days int := case when p_max_rows is null then null else 20 end;
  r record;
  t public.hr_trips;
  v_t jsonb;
  v_n int := 0;
  v_k int;
  v_finals int := 0;
  v_trips int := 0;
  v_selfies int := 0;
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
  -- 1b. trips before the cutoff: their session end, their final km, no
  --     coordinates — the oldest first, whoever they belong to
  for t in select * from public.hr_trips x
            where x.started_at < v_cut_ts and not x.final
            order by x.started_at, x.id
            limit case when p_max_rows is null then null else 50 end loop
    if t.voided_at is null then
      perform pg_advisory_xact_lock(hashtext('neo_hr_att:' || t.employee_email));
      perform public._hr_trip_sync(t.employee_email, t.started_at, t.started_at, now());
      perform public._hr_trip_measure(t.id, now());
    end if;
    update public.hr_trips
       set final = true, start_lat = null, start_lng = null, start_acc = null, end_lat = null, end_lng = null, end_acc = null
     where id = t.id;
    v_trips := v_trips + 1;
  end loop;
  -- 2. the points each of whose two days is final or holds no punch_in — and
  --    never a point inside a trip that is not final yet (a bounded call may
  --    have left that trip for the next one: its km is measured on them)
  loop
    delete from public.location_points
     where id in (select x.id
                    from (select lp.id, lp.at, lower(lp.employee_email) as em, (lp.at at time zone 'Asia/Kolkata')::date as d
                            from public.location_points lp
                           where lp.at < v_cut_ts
                           order by lp.at
                           limit coalesce(v_scan, 5000)) x
                   where (exists (select 1 from public.hr_day_km h where h.employee_email = x.em and h.day = x.d and h.final)
                          or not public._hr_has_in(x.em, x.d))
                     and (exists (select 1 from public.hr_day_km h where h.employee_email = x.em and h.day = x.d - 1 and h.final)
                          or not public._hr_has_in(x.em, x.d - 1))
                     and not exists (select 1 from public.hr_trips tr
                                      where tr.employee_email = x.em and not tr.final and tr.voided_at is null
                                        and tr.started_at <= x.at
                                        and tr.started_at >= x.at - make_interval(hours => coalesce(v_set.max_session_h, 16))
                                        and coalesce(tr.ended_at, tr.started_at + make_interval(hours => coalesce(v_set.max_session_h, 16))) >= x.at));
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
  -- 3b. punch photos (by the punch's time, never the phone's taken_at) and who viewed them
  delete from public.hr_punch_selfies where coalesce(event_at, received_at) < v_cut_ts;
  get diagnostics v_selfies = row_count;
  delete from public.hr_selfie_views where at < v_cut_ts;
  -- 4.
  v_left := exists (select 1 from public.location_points lp where lp.at < v_cut_ts);
  if not v_left then
    update public.hr_settings set last_purge_at = now() where id = 1;
  end if;
  return jsonb_build_object('cutoff', v_cut, 'deleted', v_n, 'finals', v_finals, 'done', not v_left,
                            'trip_finals', v_trips, 'selfies_deleted', v_selfies);
end $$;
perform public._hr_lockdown();
end $hr$;


-- ── part 10: "me" for the clients (work-queue.sql's my_work_profile) ───────
do $hr$
begin
-- Who I am for the queue (desktop and phone, once after sign-in). v2.4 adds
-- field_staff, dash_view (_hr_dash_view) and hr_approver (a NeoHR lead) —
-- each fail-safe (an error there answers null, never a failed sign-in).
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
  v_field boolean;
  v_view text;
  v_appr boolean;
begin
  select * into w from public._work_settings(v_me.id);
  begin
    v_field := public._hr_is_field(v_me.id);
  exception when others then v_field := null;
  end;
  begin
    v_view := public._hr_dash_view(v_me.id);
  exception when others then v_view := null;
  end;
  begin
    v_appr := public.has_module('neohr', 'lead');
  exception when others then v_appr := null;
  end;
  return jsonb_build_object(
    'id', v_me.id, 'email', v_me.email, 'full_name', v_me.full_name, 'designation', v_me.designation,
    'department', v_me.department, 'tier', v_me.tier, 'modules', public.my_modules(),
    'build_pool', w.build_pool, 'service_pool', w.service_pool, 'build_level', w.build_level,
    'capacity_points', w.capacity_points, 'max_jobs', w.max_jobs,
    -- the Team tab and everyone's logs: a neohr lead (tier 3+ always are)
    'team_view', public.has_module('neohr', 'lead'),
    'lead_builds', public.has_module('qc', 'lead'), 'lead_service', public.has_module('service', 'lead'),
    'desk_builds', v_db, 'desk_service', v_ds,
    -- 'work' exactly when work_queue() would answer (a pool flag alone never does).
    'home', case when v_db or v_ds then 'work' else 'logs' end,
    'field_staff', v_field, 'dash_view', v_view, 'hr_approver', v_appr);
end $$;
perform public._hr_lockdown();
end $hr$;


-- =============================================================================
-- FUNCTION PRIVILEGES — once more over everything: _hr_* internals to
-- service_role only; the API (v2.3's, v2.4's, my_work_profile, neo_overview*)
-- to authenticated and service_role; nothing to anon.
-- =============================================================================

select public._hr_lockdown();

-- =============================================================================
-- End of neohr_hr_v2_4. Run sql/neohr-hr-v2.4.tests.sql next (it rolls back).
-- =============================================================================
