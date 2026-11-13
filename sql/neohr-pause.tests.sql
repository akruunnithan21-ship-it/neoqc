-- =============================================================================
-- neohr-pause.tests.sql — tests for the neohr_pause migration (sql/neohr-pause.sql)
-- -----------------------------------------------------------------------------
-- Run AFTER sql/neohr-pause.sql, as the database owner. Everything happens in
-- one transaction that ends in ROLLBACK: nothing is left behind.
--
-- Users are simulated the way PostgREST does it (SET ROLE + request.jwt.claims),
-- as in the other test files. Both users are throw-away logins
-- (zq.hpause.*@neotokyo.test) made here, so no real person's punch changes an
-- answer. Punches "now" are server-anchored with age_ms, so the file passes at
-- any time of day.
--
-- A failed assertion raises "FAIL: …" and aborts. Success ends with the row
--   result = 'neohr-pause tests: all passed'
-- just before the rollback.
-- =============================================================================

begin;

-- ── 0. Scaffolding (as the owner) ────────────────────────────────────────────
create schema neo_hpt;
grant usage on schema neo_hpt to anon, authenticated;
create table neo_hpt.users (alias text primary key, id uuid not null, email text not null);
grant select on neo_hpt.users to anon, authenticated;

create function neo_hpt.login(p_alias text) returns void language plpgsql as $$
declare u neo_hpt.users;
begin
  select * into u from neo_hpt.users where alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', u.id::text, true);
  perform set_config('request.jwt.claim.email', u.email, true);
  perform set_config('request.jwt.claims',
                     jsonb_build_object('sub', u.id, 'email', u.email, 'role', 'authenticated')::text, true);
end $$;
create function neo_hpt.no_jwt() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.email', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
create function neo_hpt.assert(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_msg; end if;
end $$;
create function neo_hpt.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like p_like then
      raise exception 'FAIL: expected an error like "%" but got "%" from: %', p_like, sqlerrm, p_sql;
    end if;
    return;
  end;
  raise exception 'FAIL: expected an error like "%" but it succeeded: %', p_like, p_sql;
end $$;
-- A punch / trip / point payload, timed p_ago_s seconds ago (server-anchored).
create function neo_hpt.pl(p_id text, p_kind text, p_ago_s int) returns jsonb language sql stable as $$
  select jsonb_build_object('id', p_id, 'kind', p_kind, 'at', now() - p_ago_s * interval '1 second',
                            'age_ms', p_ago_s * 1000, 'lat', 9.9816, 'lng', 76.2999, 'accuracy_m', 12)
$$;
create function neo_hpt.pt(p_id text, p_ago_s int) returns jsonb language sql stable as $$
  select jsonb_build_array(jsonb_build_object('id', p_id, 'at', now() - p_ago_s * interval '1 second',
                                              'lat', 9.9816, 'lng', 76.2999, 'accuracy_m', 12))
$$;


-- ── 1. Test users and settings ───────────────────────────────────────────────
do $$
begin
  if exists (select 1 from auth.users where lower(email) like 'zq.hpause.%@neotokyo.test') then
    raise exception 'TEST SETUP: zq.hpause.*@neotokyo.test logins already exist; change the test emails in this file';
  end if;
end $$;

insert into auth.users (id, email, raw_user_meta_data)
select x.id::uuid, x.email, jsonb_build_object('full_name', x.name)
  from (values ('d4444444-0000-4000-8000-000000000001', 'zq.hpause.fe@neotokyo.test', 'Zqp Field'),
               ('d4444444-0000-4000-8000-000000000002', 'zq.hpause.hr@neotokyo.test', 'Zqp Hr')) as x(id, email, name);
update public.profiles p
   set full_name = u.raw_user_meta_data ->> 'full_name', active = true, is_staff = true, created_at = '2020-01-01',
       tier = 2, department = x.dept, designation = x.des
  from auth.users u,
       (values ('zq.hpause.fe@neotokyo.test', 'service', 'Service Engineer'),
               ('zq.hpause.hr@neotokyo.test', 'hr', 'HR Executive')) as x(email, dept, des)
 where u.id = p.id and p.email = x.email;
insert into neo_hpt.users (alias, id, email)
select replace(split_part(p.email, '@', 1), 'zq.hpause.', ''), p.id, lower(p.email)
  from public.profiles p where p.email like 'zq.hpause.%@neotokyo.test';
select neo_hpt.assert((select count(*) from neo_hpt.users) = 2, 'setup: both profiles exist');

delete from public.module_access where profile_id in (select id from neo_hpt.users);
insert into public.module_access (profile_id, module, role, granted_by)
select u.id, m.module, m.role, 'tests'
  from neo_hpt.users u join (values ('fe', 'service', 'tech'), ('hr', 'neohr', 'lead')) as m(alias, module, role) on m.alias = u.alias;
delete from public.hr_person where profile_id in (select id from neo_hpt.users);
insert into public.hr_person (profile_id, track_location, ta_eligible, updated_by)
select u.id, u.alias = 'fe', true, 'tests' from neo_hpt.users u;
delete from public.hr_roster where profile_id in (select id from neo_hpt.users);
update public.hr_settings
   set office_lat = null, office_lng = null, attendance_from = '2020-01-01', last_purge_at = now(), weekly_off = '{}'
 where id = 1;


-- ── 2. The migration's own state ─────────────────────────────────────────────
select neo_hpt.assert((select paused_at is not null and pause_note is not null from public.hr_settings where id = 1),
                      'P1: the migration leaves NeoHR paused, with a note');
select neo_hpt.assert((select count(*) from pg_trigger
                        where tgname in ('trg_hr_pause_event', 'trg_hr_pause_trip', 'trg_hr_pause_point') and not tgisinternal) = 3,
                      'P2: all three pause triggers exist');
select neo_hpt.assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'public' and p.proname = '_hr_tracking') = 1,
                      'P3: _hr_tracking stays the only overload');
select neo_hpt.assert(not has_function_privilege('authenticated', 'public._hr_pause_guard_event()', 'execute')
                      and not has_function_privilege('anon', 'public._hr_pause_guard_point()', 'execute'),
                      'P4: clients cannot call the guard functions');


-- ── 3. Switched on (baseline): a punch-in and a route point are stored ───────
update public.hr_settings set paused_at = null where id = 1;
select neo_hpt.login('fe');
select public.hr_punch(neo_hpt.pl('d4444444-1111-4000-8000-000000000001', 'punch_in', 1200));
select public.location_push(neo_hpt.pt('d4444444-2222-4000-8000-000000000001', 900));
reset role; select neo_hpt.no_jwt();
select neo_hpt.assert(exists (select 1 from public.attendance_events where id = 'd4444444-1111-4000-8000-000000000001'),
                      'B1: switched on, a phone punch-in is stored');
select neo_hpt.assert(exists (select 1 from public.location_points where client_point_id = 'd4444444-2222-4000-8000-000000000001'),
                      'B2: switched on, a route point on duty is stored');


-- ── 4. Paused ────────────────────────────────────────────────────────────────
update public.hr_settings set paused_at = now() where id = 1;
select neo_hpt.login('fe');
do $$
declare r jsonb;
begin
  r := public.location_push(neo_hpt.pt('d4444444-2222-4000-8000-000000000002', 600));
  perform neo_hpt.assert((r ->> 'accepted')::int = 1 and jsonb_array_length(r -> 'rejected') = 0,
                         'A1: paused, a route point is answered as accepted (the phone clears it) ' || r::text);
end $$;
select neo_hpt.expect_error($q$select public.hr_punch(neo_hpt.pl('d4444444-1111-4000-8000-000000000002', 'break_start', 300))$q$,
                            'NEO_GATE: NeoHR attendance is paused%');
select neo_hpt.expect_error($q$select public.hr_trip_start(neo_hpt.pl('d4444444-3333-4000-8000-000000000001', 'on_site', 240)
                                                          || '{"note": "Customer site visit"}'::jsonb)$q$,
                            'NEO_GATE: NeoHR attendance is paused%');
-- A retry of the punch-in stored before the pause is still a plain duplicate.
select public.hr_punch(neo_hpt.pl('d4444444-1111-4000-8000-000000000001', 'punch_in', 1200));
-- Punch out still works, so today's session can be closed.
select public.hr_punch(neo_hpt.pl('d4444444-1111-4000-8000-000000000004', 'punch_out', 60));
-- Off duty now: a new punch-in is refused by the pause.
select neo_hpt.expect_error($q$select public.hr_punch(neo_hpt.pl('d4444444-1111-4000-8000-000000000003', 'punch_in', 0))$q$,
                            'NEO_GATE: NeoHR attendance is paused%');
reset role; select neo_hpt.no_jwt();

select neo_hpt.assert(not exists (select 1 from public.location_points where client_point_id = 'd4444444-2222-4000-8000-000000000002'),
                      'A2: paused, the route point was dropped');
select neo_hpt.assert(not exists (select 1 from public.attendance_events
                                   where id in ('d4444444-1111-4000-8000-000000000002', 'd4444444-1111-4000-8000-000000000003')),
                      'A3: paused, no break or punch-in was stored');
select neo_hpt.assert(not exists (select 1 from public.hr_trips where id = 'd4444444-3333-4000-8000-000000000001'),
                      'A4: paused, no trip was stored');
select neo_hpt.assert(exists (select 1 from public.attendance_events
                               where id = 'd4444444-1111-4000-8000-000000000004' and kind = 'punch_out' and source = 'phone'),
                      'A5: paused, a punch-out is still stored');
select neo_hpt.assert((select count(*) from public.attendance_events
                        where id = 'd4444444-1111-4000-8000-000000000001') = 1,
                      'A6: the retried punch-in was not stored twice');

-- The tracking answer: off while paused, with a reason 2.3.0 knows.
do $$
declare
  v_fe neo_hpt.users;
  r jsonb;
begin
  select * into v_fe from neo_hpt.users where alias = 'fe';
  r := public._hr_tracking(v_fe.email, v_fe.id, now(), '{"state": "on_duty"}'::jsonb);
  perform neo_hpt.assert(r ->> 'enabled' = 'false' and r ->> 'reason' = 'disabled',
                         'T1: paused, tracking is off with reason disabled ' || r::text);
  perform neo_hpt.assert(r ? 'interval_s' and r ? 'distance_m' and r ? 'session_start' and r ? 'cap_at'
                         and r ? 'remind_out_at' and r ? 'pause_at',
                         'T2: paused, the tracking answer keeps every key ' || r::text);
  update public.hr_settings set paused_at = null where id = 1;
  r := public._hr_tracking(v_fe.email, v_fe.id, now(), '{"state": "on_duty"}'::jsonb);
  perform neo_hpt.assert(r ->> 'enabled' = 'true', 'T3: switched on, a field engineer on duty records the route ' || r::text);
  update public.hr_settings set paused_at = now() where id = 1;
end $$;

-- HR's own corrections are not part of the pause.
insert into public.attendance_events (id, profile_id, employee_email, kind, at, time_source, source, note, created_by_email, verify)
select 'd4444444-1111-4000-8000-000000000009', u.id, u.email, 'punch_in', now() - interval '2 hours', 'hr', 'hr',
       'test correction', 'tests', 'hr'
  from neo_hpt.users u where u.alias = 'hr';
select neo_hpt.assert(exists (select 1 from public.attendance_events where id = 'd4444444-1111-4000-8000-000000000009'),
                      'H1: paused, an HR correction (source hr) is still stored');


-- ── Done ─────────────────────────────────────────────────────────────────────
reset role;
select neo_hpt.no_jwt();
select 'neohr-pause tests: all passed' as result;

rollback;
