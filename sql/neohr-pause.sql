-- =============================================================================
-- NEO TOKYO OPERATIONS — NeoHR pause: stop the phone collecting attendance
-- Migration name: neohr_pause_part01 (one part)  Target: Postgres 17 on Supabase
-- Ships with Neo OS 1.12.2 (which hides the NeoHR screen). Owner decision
-- 2026-11-13: switch NeoHR off for now.
-- -----------------------------------------------------------------------------
-- DEPLOY ORDER
--   1. sql/neohr-hr.sql, sql/neohr-hr-v2.4.sql, sql/neohr-hr-v2.4-overview.sql (live)
--   2. sql/neohr-pause.sql (this file), then the desktop OTA 1.12.2.
--   Re-runnable: a second run keeps the first pause time.
--   Tests: sql/neohr-pause.tests.sql (one transaction, ends in ROLLBACK).
--   ROLLBACK = switch NeoHR back on: sql/neohr-pause-rollback.sql.
--
-- WHAT THIS DOES
--   hr_settings.paused_at is the switch (null = NeoHR on). While it is set:
--   * Punches from the phone: punch_in, break_start and break_end are refused
--     with NEO_GATE (NeoHR 2.3.0 shows the sentence and drops the queued punch).
--     punch_out is still accepted, so anyone on duty can close today's session.
--     HR's own corrections (source 'hr') are untouched.
--   * Trips: a phone trip (start_source 'phone' or 'punch_in') is refused.
--     Ending a trip is still accepted.
--   * Route points: dropped as they arrive (location_push still answers them
--     as accepted, so phones clear their buffer instead of retrying).
--   * _hr_tracking answers enabled = false, reason 'disabled' (a reason 2.3.0
--     already knows), so phones stop recording the route at their next sync.
--   Reading stays as it is: past attendance, routes, requests, travel allowance
--   and the retention purge (pg_cron neo-hr-retention keeps deleting old data).
--   Work logs (work_log_push) are not part of the pause.
--
-- REDEFINED
--   _hr_tracking (from sql/neohr-hr-v2.4.sql): same arguments and result; one
--   added check of hr_settings.paused_at.
-- NEW
--   columns hr_settings.paused_at, paused_by, pause_note;
--   trigger functions _hr_pause_guard_event, _hr_pause_guard_trip,
--   _hr_pause_guard_point; triggers trg_hr_pause_event (attendance_events),
--   trg_hr_pause_trip (hr_trips), trg_hr_pause_point (location_points),
--   all BEFORE INSERT FOR EACH ROW.
-- DROPPED / TIGHTENED
--   New phone punch-ins, breaks, trips and route points while paused.
--   Rollback: sql/neohr-pause-rollback.sql.
--
-- OLD CLIENTS
--   NeoHR 2.3.0: Punch in shows "NeoHR attendance is paused …" and keeps the
--   person off duty; Punch out works; the route stops recording; past days
--   still show. Desktop 1.12.1: the NeoHR screen still opens and reads past
--   records; nothing on it writes punches. Desktop 1.12.2 hides the screen.
--
-- CONVENTIONS (as v2.4): NEO_GATE: <a human sentence>; internals sit in DO
-- blocks that end with _hr_lockdown(). Nothing here deletes any data.
-- =============================================================================

set local lock_timeout = '5s';

do $hr$
begin
  -- The switch.
  alter table public.hr_settings add column if not exists paused_at  timestamptz;
  alter table public.hr_settings add column if not exists paused_by  text;
  alter table public.hr_settings add column if not exists pause_note text;
  if not exists (select 1 from pg_constraint where conrelid = 'public.hr_settings'::regclass and conname = 'hr_settings_pause_note_len') then
    alter table public.hr_settings add constraint hr_settings_pause_note_len check (pause_note is null or char_length(pause_note) <= 300);
  end if;

  -- One sentence for every refusal (the phone shows what follows "NEO_GATE: ").
  create or replace function public._hr_pause_guard_event()
  returns trigger language plpgsql set search_path = public as $f$
  begin
    if new.source = 'phone' and new.kind in ('punch_in', 'break_start', 'break_end')
       and exists (select 1 from public.hr_settings s where s.id = 1 and s.paused_at is not null) then
      raise exception 'NEO_GATE: NeoHR attendance is paused for now. You can still punch out; punching in, breaks and trips are off until it is switched back on.';
    end if;
    return new;
  end $f$;

  create or replace function public._hr_pause_guard_trip()
  returns trigger language plpgsql set search_path = public as $f$
  begin
    if new.start_source in ('phone', 'punch_in')
       and exists (select 1 from public.hr_settings s where s.id = 1 and s.paused_at is not null) then
      raise exception 'NEO_GATE: NeoHR attendance is paused for now. You can still punch out; punching in, breaks and trips are off until it is switched back on.';
    end if;
    return new;
  end $f$;

  -- A route point is dropped, never refused: a refusal would make phones retry.
  create or replace function public._hr_pause_guard_point()
  returns trigger language plpgsql set search_path = public as $f$
  begin
    if exists (select 1 from public.hr_settings s where s.id = 1 and s.paused_at is not null) then
      return null;
    end if;
    return new;
  end $f$;

  drop trigger if exists trg_hr_pause_event on public.attendance_events;
  create trigger trg_hr_pause_event before insert on public.attendance_events
    for each row execute function public._hr_pause_guard_event();
  drop trigger if exists trg_hr_pause_trip on public.hr_trips;
  create trigger trg_hr_pause_trip before insert on public.hr_trips
    for each row execute function public._hr_pause_guard_trip();
  drop trigger if exists trg_hr_pause_point on public.location_points;
  create trigger trg_hr_pause_point before insert on public.location_points
    for each row execute function public._hr_pause_guard_point();

-- §9.4.4 (v2.4: field staff only; while a trip is open it never pauses) —
-- what the phone needs to record (or not) the route. Same keys as v2.3.
-- Pause (2026-11-13): while hr_settings.paused_at is set, enabled is false
-- with reason 'disabled'; every other key is worked out as before.
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
  v_track := public._hr_is_field(p_profile) and v_set.paused_at is null;
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

  -- Switch it on (a re-run keeps the first pause time).
  update public.hr_settings
     set paused_at = coalesce(paused_at, now()),
         paused_by = coalesce(paused_by, 'neohr_pause migration'),
         pause_note = coalesce(pause_note, 'Owner decision 2026-11-13: NeoHR switched off for now.')
   where id = 1;

  perform public._hr_lockdown();
end $hr$;
