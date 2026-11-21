-- =============================================================================
-- tracker-build-public.tests.sql — tests for sql/tracker-build-public.sql
-- -----------------------------------------------------------------------------
-- Run AFTER sql/tracker-build-public.sql, as the database owner (Supabase SQL
-- editor or psql as postgres). Everything happens inside one transaction that
-- ends in ROLLBACK: nothing is left behind.
--
-- The lookups run as anon (SET ROLE), the way the public website calls them.
-- A failed assertion raises "FAIL: …" and aborts. Success ends with the row
--   result = 'tracker-build-public tests: all passed'
-- just before the rollback. Test ids start with t_zztest so they cannot meet a
-- real ticket; phone numbers 90000003xx are not real.
-- =============================================================================

begin;

-- The work-queue triggers stand aside for fixture rows (as in a migration).
select set_config('neo.migrating', '1', true);

insert into public.tickets (id, type, customer_name, technician, status, customer_phone, deadline, diagnostics, serials)
values
  -- A: phone on file, completed, with QC data and an event log
  ('t_zztest01qz7k2p', 'build', 'Arjun R Kumar', 'Athul Sudheer', 'completed', '+91 90000 00301',
   now() + interval '1 day',
   jsonb_build_object(
     'cpuTempMax', 79, 'gpuTempMax', '71', 'cinebench', 31250, 'ramStress', 'passed',
     'cpuTempLog', (select jsonb_agg(40 + i * 0.3) from generate_series(1, 150) i),
     'consoleLog', jsonb_build_array('[SYS] secret console line'),
     'componentPassport', jsonb_build_object(
        'cpu', jsonb_build_object('model', 'Ryzen 7 9700X', 'cores', 8, 'threads', 16, 'tempMaxDuringTest', 79),
        'ram', jsonb_build_object('totalGB', 32, 'ddrGen', 'DDR5', 'errorsDuringPrime95', 0),
        'storage', jsonb_build_object('model', 'WD SN850X 1TB', 'sizeGB', 1000, 'lifeRemaining', 100)),
     'prime95', jsonb_build_object('overallResult', 'pass', 'durationActualSec', 3600,
        'workers', jsonb_build_array(jsonb_build_object('id', 1, 'errors', 0), jsonb_build_object('id', 2, 'errors', 0))),
     'portScan', jsonb_build_object('usbControllers', jsonb_build_array('{}'::jsonb, '{}'::jsonb), 'audioEndpoints', jsonb_build_array('Speakers')),
     'eventLog', jsonb_build_array(
        jsonb_build_object('timestamp', '2026-11-18T05:00:00.000Z', 'event', 'Ticket created for Arjun R Kumar (New PC Build)', 'user', 'Athul'),
        jsonb_build_object('timestamp', '2026-11-19T06:00:00.000Z', 'event', 'Status changed: "Awaiting Components" → "Build Commenced"', 'user', 'Athul'),
        jsonb_build_object('timestamp', '2026-11-19T07:00:00.000Z', 'event', '⚑ Flag raised (gpu): internal note', 'user', 'Athul'),
        jsonb_build_object('timestamp', '2026-11-20T08:00:00.000Z', 'event', 'Status changed: "Awaiting QC" → "QC Stress Testing"', 'user', 'Athul'))),
   jsonb_build_object('motherboard', 'SERIAL-SHOULD-NOT-LEAK')),
  -- B: no phone on file (made before this release)
  ('t_zztest02lg8m3n', 'build', 'Old Customer', 'Vishnu', 'building', null, null, '{}'::jsonb, '{}'::jsonb),
  -- C: phone on file, used for the throttle
  ('t_zztest03wx4v9r', 'build', 'Throttle Test', null, 'awaiting', '9000000399', null, '{}'::jsonb, '{}'::jsonb);

select set_config('neo.migrating', '', true);

create temporary table _res (k text primary key, v jsonb);
grant all on _res to anon;

set local role anon;
insert into _res values
  ('a_ok',      public.get_build_public('QZ7K2P', '0301')),
  ('a_lower',   public.get_build_public(' qz7k2p ', '0301')),
  ('a_wrong',   public.get_build_public('QZ7K2P', '9999')),
  ('a_badpin',  public.get_build_public('QZ7K2P', '03x1')),
  ('a_short',   public.get_build_public('Z7K2P', '0301')),
  ('b_any',     public.get_build_public('LG8M3N', '1111')),
  ('none',      public.get_build_public('ZZZZZZ', '0301'));
reset role;

do $$
declare r jsonb;
begin
  select v into r from _res where k = 'a_ok';
  if r is null then raise exception 'FAIL: right code + digits returned null'; end if;
  if (r ->> 'full')::boolean is not true then raise exception 'FAIL: phone match should give the full view: %', r; end if;
  if r ->> 'code' <> 'QZ7K2P' then raise exception 'FAIL: code should be QZ7K2P, got %', r ->> 'code'; end if;
  if r ->> 'first_name' <> 'Arjun' then raise exception 'FAIL: first name only, got %', r ->> 'first_name'; end if;
  if r ->> 'technician' <> 'Athul' then raise exception 'FAIL: technician first name only, got %', r ->> 'technician'; end if;
  if r::text ~* 'SERIAL-SHOULD-NOT-LEAK|secret console|internal note|customer_phone|90000' then
    raise exception 'FAIL: private data leaked: %', r;
  end if;
  if jsonb_array_length(r -> 'steps') <> 3 then raise exception 'FAIL: expected 3 steps (created, building, qc_testing), got %', r -> 'steps'; end if;
  if r -> 'steps' -> 0 ->> 'step' <> 'qc_testing' then raise exception 'FAIL: newest step first, got %', r -> 'steps' -> 0; end if;
  if (r -> 'qc' ->> 'gpu_temp_max')::numeric <> 71 then raise exception 'FAIL: string numbers are read: %', r -> 'qc'; end if;
  if r -> 'qc' -> 'prime95' ->> 'minutes' <> '60' then raise exception 'FAIL: prime95 minutes: %', r -> 'qc' -> 'prime95'; end if;
  if jsonb_array_length(r -> 'qc' -> 'cpu_temps') > 61 then raise exception 'FAIL: temperature series not thinned'; end if;
  if (r -> 'qc' -> 'ports' ->> 'usb_controllers')::int <> 2 then raise exception 'FAIL: port counts: %', r -> 'qc' -> 'ports'; end if;

  select v into r from _res where k = 'a_lower';
  if r is null or r ->> 'code' <> 'QZ7K2P' then raise exception 'FAIL: lower case and spaces should still match'; end if;

  if (select v from _res where k = 'a_wrong') is not null then raise exception 'FAIL: wrong digits must return null'; end if;
  if (select v from _res where k = 'a_badpin') is not null then raise exception 'FAIL: non-digit pin must return null'; end if;
  if (select v from _res where k = 'a_short') is not null then raise exception 'FAIL: a 5-character code must return null'; end if;
  if (select v from _res where k = 'none') is not null then raise exception 'FAIL: unknown code must return null'; end if;

  select v into r from _res where k = 'b_any';
  if r is null then raise exception 'FAIL: a ticket without a phone gives the limited view'; end if;
  if (r ->> 'full')::boolean is not false then raise exception 'FAIL: limited view expected: %', r; end if;
  if r ? 'first_name' or r ? 'technician' or r ? 'qc' then raise exception 'FAIL: limited view shows no name, technician or QC: %', r; end if;
end $$;

-- Throttle: 8 misses lock the code, and the right digits are refused too.
set local role anon;
do $$
declare i int; r jsonb;
begin
  for i in 1..8 loop
    r := public.get_build_public('WX4V9R', lpad(i::text, 4, '0'));
    if r is not null then raise exception 'FAIL: miss % returned data', i; end if;
  end loop;
  r := public.get_build_public('WX4V9R', '0399');
  if r is null or (r ->> 'locked')::boolean is not true then raise exception 'FAIL: 9th try should be locked, got %', r; end if;
  r := public.get_build_public('QZ7K2P', '0301');
  if r ->> 'code' is distinct from 'QZ7K2P' then raise exception 'FAIL: the lock must be per code, got %', r; end if;
end $$;
reset role;

-- anon cannot read the failure log or the helpers.
do $$
begin
  if has_table_privilege('anon', 'public.tracker_lookup_failures', 'select') then
    raise exception 'FAIL: anon can read tracker_lookup_failures';
  end if;
  if has_function_privilege('anon', 'public._tracker_num(jsonb)', 'execute') then
    raise exception 'FAIL: anon can call _tracker_num';
  end if;
end $$;

select 'tracker-build-public tests: all passed' as result;

rollback;
