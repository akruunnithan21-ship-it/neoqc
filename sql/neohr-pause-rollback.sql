-- =============================================================================
-- NEO TOKYO OPERATIONS — undo the NeoHR pause (switch NeoHR back on)
-- Migration name: neohr_pause_rollback_part01   Target: Postgres 17 on Supabase
-- -----------------------------------------------------------------------------
-- Undoes sql/neohr-pause.sql exactly: drops its three triggers and their
-- functions, puts back _hr_tracking as sql/neohr-hr-v2.4.sql defines it, and
-- drops the hr_settings pause columns. Nothing else changes: punches, trips and
-- route points recorded before or during the pause stay as they are.
--
-- After this, NeoHR 2.3.0 punches in, takes trips and records the route again.
-- Desktop 1.12.2 still hides the NeoHR screen; bring it back with a desktop
-- release that shows it again (see modules.js PAUSED_MODULES).
-- =============================================================================

set local lock_timeout = '5s';

do $hr$
begin
  drop trigger if exists trg_hr_pause_event on public.attendance_events;
  drop trigger if exists trg_hr_pause_trip on public.hr_trips;
  drop trigger if exists trg_hr_pause_point on public.location_points;
  drop function if exists public._hr_pause_guard_event();
  drop function if exists public._hr_pause_guard_trip();
  drop function if exists public._hr_pause_guard_point();

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

  alter table public.hr_settings drop constraint if exists hr_settings_pause_note_len;
  alter table public.hr_settings drop column if exists pause_note;
  alter table public.hr_settings drop column if exists paused_by;
  alter table public.hr_settings drop column if exists paused_at;

  perform public._hr_lockdown();
end $hr$;
