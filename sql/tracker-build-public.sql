-- =============================================================================
-- tracker-build-public.sql — "Track your build" behind the customer's phone digits
-- -----------------------------------------------------------------------------
-- Run in the Supabase SQL editor as the database owner, AFTER
-- database-hardening.sql. Idempotent: safe to run twice.
-- Rollback: sql/tracker-build-public-rollback.sql
-- Tests:    sql/tracker-build-public.tests.sql (ends in ROLLBACK)
--
-- Why: get_ticket_public(code) hands anyone who has a 6-character code the
-- customer's full name and the whole diagnostics JSON (event log with staff
-- names, console log, serial-adjacent data). Repairs and warranty parts already
-- ask for the last 4 phone digits; builds now do too.
--
-- What it adds
--   1. tickets.customer_phone (nullable). The website's quote builder writes it
--      from this release on. Tickets made before it have none.
--   2. get_build_public(code, phone4): the build tracker's only door. Same
--      discipline as get_service_public: one null for every failure, and a
--      curated list of fields. Never serials, prices, specs, the event log's
--      free text, the console log, staff emails or the phone itself.
--        - a phone on file  → its last 4 digits must match → the full view
--        - no phone on file → a limited view (status, dates, progress only;
--          no name, no technician, no QC report), so older tickets keep working
--   3. tracker_lookup_failures + a throttle: 8 misses on one code within
--      15 minutes closes that code for 15 minutes (right digits included), so
--      the 10,000 possible digits cannot be walked. The answer is the same
--      {"locked": true} for codes that exist and codes that don't.
--
-- Deploy order: run this file, THEN deploy the website. get_ticket_public is
-- left in place so the old page keeps working during the switch; revoke it
-- once the new page is live (last statement, commented out).
-- =============================================================================

begin;

-- ── 1. The phone column ──────────────────────────────────────────────────────
alter table public.tickets add column if not exists customer_phone text;
comment on column public.tickets.customer_phone is
  'Customer mobile as typed at the sales desk. Only its last 4 digits are compared (get_build_public); it is never returned to the public.';

-- ── 2. Failed-lookup log for the throttle ────────────────────────────────────
create table if not exists public.tracker_lookup_failures (
  code_key text not null,
  at timestamptz not null default now()
);
create index if not exists tracker_lookup_failures_key_at
  on public.tracker_lookup_failures (code_key, at desc);
alter table public.tracker_lookup_failures enable row level security;
-- No policies on purpose: only the SECURITY DEFINER function below touches it.
revoke all on public.tracker_lookup_failures from anon, authenticated;

-- ── 3. Helpers ───────────────────────────────────────────────────────────────
-- A JSON value as a number, or null (the desktop app has stored numbers both
-- as JSON numbers and as strings over the years).
create or replace function public._tracker_num(v jsonb)
returns numeric
language sql immutable
set search_path = public
as $$
  select case
    when v is null then null
    when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric
    when jsonb_typeof(v) = 'string' and btrim(v #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' then btrim(v #>> '{}')::numeric
    else null
  end
$$;

-- The desktop app's "Status changed" labels (getStatusLabelText) → status keys.
-- The website's labels are accepted too.
create or replace function public._build_status_from_label(p_label text)
returns text
language sql immutable
set search_path = public
as $$
  select case lower(btrim(coalesce(p_label, '')))
    when 'awaiting components' then 'awaiting'
    when 'build commenced'     then 'building'
    when 'in assembly'         then 'building'
    when 'awaiting qc'         then 'waiting_qc'
    when 'qc stress testing'   then 'qc_testing'
    when 'qc & testing'        then 'qc_testing'
    when 'qc pass / completed' then 'completed'
    when 'completed'           then 'completed'
    else null
  end
$$;

-- Supabase's default privileges grant new functions to anon and authenticated
-- directly, so revoking from PUBLIC alone is not enough.
revoke all on function public._tracker_num(jsonb) from public, anon, authenticated;
revoke all on function public._build_status_from_label(text) from public, anon, authenticated;

-- ── 4. The lookup ────────────────────────────────────────────────────────────
create or replace function public.get_build_public(code text, phone4 text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_code  text := lower(btrim(coalesce($1, '')));
  v_p4    text := btrim(coalesce($2, ''));
  v_key   text;
  v_t     public.tickets;
  v_n     int;
  v_full  boolean;
  v_d     jsonb;
  v_log   jsonb;
  v_steps jsonb;
  v_qc    jsonb := null;
  v_cp    jsonb;
  v_p95   jsonb;
  v_ports jsonb;
  v_temps jsonb;
  v_len   int;
  v_every int;
begin
  if v_code !~ '^[0-9a-z]{6}$' or v_p4 !~ '^[0-9]{4}$' then return null; end if;
  v_key := 'build:' || v_code;

  if (select count(*) from public.tracker_lookup_failures f
       where f.code_key = v_key and f.at > now() - interval '15 minutes') >= 8 then
    return jsonb_build_object('locked', true);
  end if;

  -- A ticket with a phone on file whose last 4 digits match.
  select t.* into v_t
    from public.tickets t
   where right(lower(t.id), 6) = v_code
     and length(regexp_replace(coalesce(t.customer_phone, ''), '[^0-9]', '', 'g')) >= 4
     and right(regexp_replace(t.customer_phone, '[^0-9]', '', 'g'), 4) = v_p4
   order by t.created_at desc
   limit 1;
  get diagnostics v_n = row_count;

  if v_n = 1 then
    v_full := true;
  else
    -- An older ticket with no phone on file: the limited view.
    select t.* into v_t
      from public.tickets t
     where right(lower(t.id), 6) = v_code
       and length(regexp_replace(coalesce(t.customer_phone, ''), '[^0-9]', '', 'g')) < 4
     order by t.created_at desc
     limit 1;
    get diagnostics v_n = row_count;
    if v_n = 1 then
      v_full := false;
    else
      insert into public.tracker_lookup_failures (code_key) values (v_key);
      delete from public.tracker_lookup_failures where at < now() - interval '1 day';
      return null;
    end if;
  end if;

  v_d := case when jsonb_typeof(v_t.diagnostics) = 'object' then v_t.diagnostics else '{}'::jsonb end;
  v_log := case when jsonb_typeof(v_d -> 'eventLog') = 'array' then v_d -> 'eventLog' else '[]'::jsonb end;

  -- Progress moments from the event log: times and step keys only, never the
  -- free text or who did it.
  select coalesce(jsonb_agg(s order by s ->> 'at' desc), '[]'::jsonb) into v_steps
    from (
      select jsonb_build_object('at', e ->> 'timestamp', 'step', 'created') as s
        from jsonb_array_elements(v_log) e
       where jsonb_typeof(e) = 'object' and e ->> 'event' like 'Ticket created for %'
      union all
      select jsonb_build_object('at', e ->> 'timestamp', 'step', 'parts_in')
        from jsonb_array_elements(v_log) e
       where jsonb_typeof(e) = 'object' and e ->> 'event' like 'Parts constraint resolved%'
      union all
      select jsonb_build_object('at', e ->> 'timestamp',
               'step', public._build_status_from_label(substring(e ->> 'event' from '→ "([^"]+)"')))
        from jsonb_array_elements(v_log) e
       where jsonb_typeof(e) = 'object' and e ->> 'event' like 'Status changed:%'
         and public._build_status_from_label(substring(e ->> 'event' from '→ "([^"]+)"')) is not null
    ) x
   where s ->> 'at' ~ '^\d{4}-\d{2}-\d{2}T';

  if v_full then
    v_cp := case when jsonb_typeof(v_d -> 'componentPassport') = 'object' then v_d -> 'componentPassport' else '{}'::jsonb end;
    v_p95 := case when jsonb_typeof(v_d -> 'prime95') = 'object' then v_d -> 'prime95' else '{}'::jsonb end;
    v_ports := case when jsonb_typeof(v_d -> 'portScan') = 'object' then v_d -> 'portScan' else '{}'::jsonb end;

    -- The CPU temperature during the run, thinned to about 60 points.
    v_len := case when jsonb_typeof(v_d -> 'cpuTempLog') = 'array' then jsonb_array_length(v_d -> 'cpuTempLog') else 0 end;
    if v_len > 1 then
      v_every := greatest(1, ceil(v_len / 60.0)::int);
      select jsonb_agg(round(n, 1) order by i) into v_temps
        from (
          select i, coalesce(public._tracker_num(e), public._tracker_num(e -> 'temp'),
                             public._tracker_num(e -> 'value'), public._tracker_num(e -> 'c')) as n
            from jsonb_array_elements(v_d -> 'cpuTempLog') with ordinality as a(e, i)
           where (i - 1) % v_every = 0
        ) z
       where n is not null and n between 0 and 130;
    end if;

    v_qc := jsonb_strip_nulls(jsonb_build_object(
      'cpu_temp_max', public._tracker_num(v_d -> 'cpuTempMax'),
      'cpu_temp_avg', public._tracker_num(v_d -> 'cpuTempAvg'),
      'gpu_temp_max', public._tracker_num(v_d -> 'gpuTempMax'),
      'cinebench',    public._tracker_num(v_d -> 'cinebench'),
      'ram_stress',   case when v_d ->> 'ramStress' in ('passed', 'true') then 'passed'
                           when v_d ->> 'ramStress' in ('failed', 'false') then 'failed' end,
      'cpu', case when jsonb_typeof(v_cp -> 'cpu') = 'object' then jsonb_strip_nulls(jsonb_build_object(
               'model', left(v_cp -> 'cpu' ->> 'model', 80),
               'cores', public._tracker_num(v_cp -> 'cpu' -> 'cores'),
               'threads', public._tracker_num(v_cp -> 'cpu' -> 'threads'),
               'temp_max', public._tracker_num(v_cp -> 'cpu' -> 'tempMaxDuringTest'),
               'throttled', case when jsonb_typeof(v_cp -> 'cpu' -> 'throttled') = 'boolean' then (v_cp -> 'cpu' -> 'throttled') end)) end,
      'gpu', case when jsonb_typeof(v_cp -> 'gpu') = 'object' then jsonb_strip_nulls(jsonb_build_object(
               'model', left(v_cp -> 'gpu' ->> 'model', 80),
               'vram', left(v_cp -> 'gpu' ->> 'vram', 20),
               'temp_max', public._tracker_num(v_cp -> 'gpu' -> 'tempMaxDuringTest'),
               'throttled', case when jsonb_typeof(v_cp -> 'gpu' -> 'throttled') = 'boolean' then (v_cp -> 'gpu' -> 'throttled') end)) end,
      'ram', case when jsonb_typeof(v_cp -> 'ram') = 'object' then jsonb_strip_nulls(jsonb_build_object(
               'total_gb', public._tracker_num(v_cp -> 'ram' -> 'totalGB'),
               'gen', left(v_cp -> 'ram' ->> 'ddrGen', 10),
               'errors', public._tracker_num(v_cp -> 'ram' -> 'errorsDuringPrime95'))) end,
      'storage', case when jsonb_typeof(v_cp -> 'storage') = 'object' then jsonb_strip_nulls(jsonb_build_object(
               'model', left(v_cp -> 'storage' ->> 'model', 80),
               'size_gb', public._tracker_num(v_cp -> 'storage' -> 'sizeGB'),
               'life_remaining', public._tracker_num(v_cp -> 'storage' -> 'lifeRemaining'))) end,
      'prime95', case when v_p95 ->> 'overallResult' in ('pass', 'fail', 'aborted') then jsonb_strip_nulls(jsonb_build_object(
               'result', v_p95 ->> 'overallResult',
               'minutes', round(public._tracker_num(v_p95 -> 'durationActualSec') / 60),
               'errors', (select sum(coalesce(public._tracker_num(w -> 'errors'), 0))
                            from jsonb_array_elements(case when jsonb_typeof(v_p95 -> 'workers') = 'array'
                                                           then v_p95 -> 'workers' else '[]'::jsonb end) w))) end,
      'ports', case when v_ports <> '{}'::jsonb then jsonb_strip_nulls(jsonb_build_object(
               'usb_controllers', case when jsonb_typeof(v_ports -> 'usbControllers') = 'array' then jsonb_array_length(v_ports -> 'usbControllers') end,
               'video_outputs', case when jsonb_typeof(v_ports -> 'videoOutputs') = 'array' then jsonb_array_length(v_ports -> 'videoOutputs') end,
               'audio_endpoints', case when jsonb_typeof(v_ports -> 'audioEndpoints') = 'array' then jsonb_array_length(v_ports -> 'audioEndpoints') end)) end,
      'cpu_temps', v_temps));
    if v_qc = '{}'::jsonb then v_qc := null; end if;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'code',          upper(right(v_t.id, 6)),
    'full',          v_full,
    'status',        v_t.status,
    'type',          v_t.type,
    'first_name',    case when v_full then nullif(split_part(btrim(coalesce(v_t.customer_name, '')), ' ', 1), '') end,
    'technician',    case when v_full then nullif(split_part(btrim(coalesce(v_t.technician, '')), ' ', 1), '') end,
    'created_at',    v_t.created_at,
    'deadline',      v_t.deadline,
    'completed_at',  v_t.completed_at,
    'parts_waiting', case when v_t.status = 'awaiting' then coalesce(v_t.missing_components_toggle, false) end,
    'steps',         v_steps,
    'qc',            v_qc));
end $$;

revoke all on function public.get_build_public(text, text) from public;
grant execute on function public.get_build_public(text, text) to anon, authenticated;

commit;

-- ── 5. After the new page is live (run on its own) ───────────────────────────
-- revoke execute on function public.get_ticket_public(text) from anon, authenticated;
