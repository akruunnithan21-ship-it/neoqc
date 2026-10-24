-- =============================================================================
-- neohr-hr-v2.4-overview.tests.sql — tests for sql/neohr-hr-v2.4-overview.sql
-- (neo_overview, neo_overview_list and their helpers; NEOHR-2.3-SPEC §1.7)
-- -----------------------------------------------------------------------------
-- Run AFTER sql/service-v2.sql, service-v2.1.sql, work-queue.sql, neohr-hr.sql,
-- neohr-hr-v2.4.sql and neohr-hr-v2.4-overview.sql, as the database owner.
-- Everything happens inside one transaction that ends in ROLLBACK: nothing is
-- left behind, not even the helper schema.
--
-- Users are simulated the way PostgREST does it (SET ROLE + request.jwt.claims).
-- Every caller is a throw-away login (zq.ov.*@neotokyo.test) made here, one per
-- dashboard view, with exactly the roles, pools and field switch the test
-- needs. Live tickets may exist, so the checks are: the flags of this file's
-- own items (t_ovt_*, s_ovt_*, rc_ovt_*), every tile's count against the
-- length of its list (live items included), and differences before / after
-- for the HR counts.
--
-- Time: now() is the transaction's start and does not move. Where an answer
-- depends on the time of day (an item due "today", a punch after 09:40) the
-- expectation is computed with the same rule.
--
-- A failed assertion raises "FAIL: …" and aborts — the first error is the one
-- to read. Success ends with the row
--   result = 'neohr-hr-v2.4-overview tests: all passed'
-- just before the rollback.
-- =============================================================================

begin;

-- ── 0. Scaffolding (as the owner) ────────────────────────────────────────────
create schema neo_ovt;
grant usage on schema neo_ovt to anon, authenticated;

create table neo_ovt.users (alias text primary key, id uuid not null, email text not null, tier int not null, name text not null);
create table neo_ovt.ctx (k text primary key, v text);
-- Every tile of neo_overview and the list it opens (the TILE → LIST table of
-- the migration's header).
create table neo_ovt.tiles (path text[] primary key, kind text not null, scope text not null, state text not null);
grant select on neo_ovt.users, neo_ovt.tiles to anon, authenticated;
grant select, insert, update, delete on neo_ovt.ctx to anon, authenticated;

insert into neo_ovt.tiles (path, kind, scope, state)
select array['mine', k.sec, m.key], k.kind, 'mine', m.state
  from (values ('builds', 'build'), ('service', 'service'), ('rma', 'rma')) as k(sec, kind)
 cross join (values ('items', 'any'), ('offered', 'offered'), ('due_today', 'due_today'), ('late', 'late'),
                    ('overdue', 'overdue')) as m(key, state)
union all
select array['builds', x.key], 'build', case when x.key = 'mine' then 'mine' else 'all' end,
       case x.key when 'open' then 'any' when 'mine' then 'any' else x.key end
  from unnest(array['open', 'assigned', 'in_queue', 'not_sent', 'mine', 'late', 'overdue', 'waiting_parts']) as x(key)
union all
select array['service', x.key], 'service', case when x.key = 'mine' then 'mine' else 'all' end,
       case x.key when 'open' then 'any' when 'mine' then 'any' else x.key end
  from unnest(array['open', 'assigned', 'in_queue', 'mine', 'waiting_customer', 'waiting_supplier', 'ready_to_collect',
                    'late', 'overdue']) as x(key)
union all
select array['rma', x.key], 'rma', case when x.key = 'mine' then 'mine' else 'all' end,
       case x.key when 'open' then 'any' when 'mine' then 'any' else x.key end
  from unnest(array['open', 'assigned', 'in_queue', 'mine', 'at_vendor', 'to_return', 'late', 'overdue']) as x(key)
union all
select array['sales', 'open'], 'build', 'sales', 'any'
union all
select array['sales', 'by_stage', s], 'build', 'sales', 'stage:' || s
  from unnest(array['waiting_parts', 'ready_to_build', 'building', 'qc']) as s
union all
select array['sales', x], 'build', 'sales', x from unnest(array['late', 'overdue']) as x;

create function neo_ovt.put(p_k text, p_v text) returns void language plpgsql as $$
begin
  insert into neo_ovt.ctx (k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v;
end $$;
create function neo_ovt.get(p_k text) returns text language plpgsql volatile as $$
declare v text;
begin
  select c.v into v from neo_ovt.ctx c where c.k = p_k;
  if not found or v is null then raise exception 'TEST BUG: nothing stored under "%"', p_k; end if;
  return v;
end $$;
create function neo_ovt.email(p_alias text) returns text language plpgsql volatile as $$
declare v text;
begin
  select u.email into v from neo_ovt.users u where u.alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  return lower(v);
end $$;
create function neo_ovt.uid(p_alias text) returns uuid language plpgsql volatile as $$
declare v uuid;
begin
  select u.id into v from neo_ovt.users u where u.alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  return v;
end $$;
create function neo_ovt.login(p_alias text) returns void language plpgsql as $$
declare u neo_ovt.users;
begin
  select * into u from neo_ovt.users where alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', u.id::text, true);
  perform set_config('request.jwt.claim.email', u.email, true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', u.id, 'email', u.email, 'role', 'authenticated')::text, true);
end $$;
create function neo_ovt.no_jwt() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.email', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
create function neo_ovt.assert(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_msg; end if;
end $$;
create function neo_ovt.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
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
create function neo_ovt.keys(p jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(k, ',' order by k), '') from jsonb_object_keys(coalesce(p, '{}'::jsonb)) as k
$$;
-- One item of a list answer.
create function neo_ovt.item(p_list jsonb, p_id text) returns jsonb language sql immutable as $$
  select e.value from jsonb_array_elements(coalesce(p_list -> 'items', '[]'::jsonb)) as e(value)
   where e.value ->> 'id' = p_id limit 1
$$;
create function neo_ovt.ids(p_list jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(e.value ->> 'id' order by e.value ->> 'id'), '{}')
    from jsonb_array_elements(coalesce(p_list -> 'items', '[]'::jsonb)) as e(value)
   where e.value ->> 'id' like '%\_ovt\_%'
$$;
-- Every number under the ticket sections of an overview, as a path.
create function neo_ovt.leaves(p jsonb) returns setof text[] language sql immutable as $$
  with recursive w(path, v) as (
    select array[k], p -> k from jsonb_object_keys(p) as k where k in ('mine', 'builds', 'service', 'rma', 'sales')
    union all
    select w.path || e.key, e.value from w cross join lateral jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v
                                                                             else '{}'::jsonb end) as e
  )
  select w.path from w where jsonb_typeof(w.v) = 'number'
$$;
-- The tile check for the signed-in caller: every number of the overview is a
-- tile of neo_ovt.tiles, and every tile shown is exactly as long as its list;
-- in every list late and overdue never meet, overdue comes first, then late;
-- a shop-wide list of a section the caller doesn't get is refused.
create function neo_ovt.check_tiles(p_alias text) returns int language plpgsql as $$
declare
  r jsonb := public.neo_overview();
  t record; l jsonb; v_path text[]; n int := 0;
begin
  for v_path in select * from neo_ovt.leaves(r) loop
    perform neo_ovt.assert(exists (select 1 from neo_ovt.tiles where path = v_path),
                           format('%s: neo_overview has a number %s that no tile maps to a list', p_alias, array_to_string(v_path, '.')));
  end loop;
  for t in select * from neo_ovt.tiles order by path loop
    if r #> t.path is not null then
      l := public.neo_overview_list(t.kind, t.scope, t.state);
      perform neo_ovt.assert((r #>> t.path)::int = (l ->> 'total')::int
                             and jsonb_array_length(l -> 'items') = (l ->> 'total')::int
                             and not (l ->> 'truncated')::boolean,
                             format('%s: tile %s = %s but its list (%s, %s, %s) has %s items (total %s)', p_alias,
                                    array_to_string(t.path, '.'), r #>> t.path, t.kind, t.scope, t.state,
                                    jsonb_array_length(l -> 'items'), l ->> 'total'));
      perform neo_ovt.assert(not exists (select 1 from jsonb_array_elements(l -> 'items') e(value)
                                          where (e.value ->> 'late')::boolean and (e.value ->> 'overdue')::boolean),
                             format('%s: %s lists an item both late and overdue', p_alias, array_to_string(t.path, '.')));
      perform neo_ovt.assert(coalesce((select max(e.n) filter (where (e.value ->> 'overdue')::boolean)
                                         < min(e.n) filter (where not (e.value ->> 'overdue')::boolean)
                                         from jsonb_array_elements(l -> 'items') with ordinality e(value, n)), true)
                             and coalesce((select max(e.n) filter (where (e.value ->> 'late')::boolean)
                                             < min(e.n) filter (where not (e.value ->> 'late')::boolean and not (e.value ->> 'overdue')::boolean)
                                             from jsonb_array_elements(l -> 'items') with ordinality e(value, n)), true),
                             format('%s: %s lists overdue first, then late', p_alias, array_to_string(t.path, '.')));
      n := n + 1;
    elsif t.path[1] in ('builds', 'service', 'rma') and t.scope = 'all' then
      perform neo_ovt.expect_error(format('select public.neo_overview_list(%L, %L, %L)', t.kind, t.scope, t.state),
                                   'NEO_GATE: You can''t see this list.');
    end if;
  end loop;
  return n;
end $$;
grant execute on all functions in schema neo_ovt to anon, authenticated;

-- Owner-only helpers (created after the grant above, so no client may call them).
-- The flags of one item as p_viewer sees it (due_today apart: it depends on the hour).
create function neo_ovt.flags(p_viewer text, p_id text) returns text language sql volatile as $$
  select concat_ws(',', case when i.assigned then 'assigned' end, case when i.in_queue then 'in_queue' end,
                   case when i.not_sent then 'not_sent' end, case when i.mine then 'mine' end,
                   case when i.offered then 'offered' end, case when i.late then 'late' end,
                   case when i.overdue then 'overdue' end, case when i.waiting_customer then 'waiting_customer' end,
                   case when i.waiting_supplier then 'waiting_supplier' end, case when i.ready_to_collect then 'ready_to_collect' end,
                   case when i.at_vendor then 'at_vendor' end, case when i.to_return then 'to_return' end,
                   case when i.waiting_parts then 'waiting_parts' end, case when i.sales_mine then 'sales_mine' end,
                   case when i.shop then 'shop' end)
    from public._hr_ov_items(neo_ovt.uid(p_viewer)) i where i.id = p_id
$$;
create function neo_ovt.row(p_viewer text, p_id text) returns jsonb language sql volatile as $$
  select to_jsonb(i) from public._hr_ov_items(neo_ovt.uid(p_viewer)) i where i.id = p_id
$$;
-- A punch exactly as given (v2.4 columns included), bypassing hr_punch.
create function neo_ovt.ev(p_alias text, p_kind text, p_at timestamptz, p_verify text, p_place text,
                           p_flags text[] default '{}', p_skip text default null, p_voided boolean default false)
returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into public.attendance_events (id, profile_id, employee_email, kind, at, device_at, time_source, source,
                                        created_by_email, verify, place, flags, selfie_skip,
                                        voided_at, voided_by, void_reason)
  values (v, neo_ovt.uid(p_alias), neo_ovt.email(p_alias), p_kind, p_at, p_at, 'device', 'phone', neo_ovt.email(p_alias),
          p_verify, p_place, p_flags, p_skip,
          case when p_voided then now() end, case when p_voided then 'tests' end, case when p_voided then 'Zq test void' end);
  return v;
end $$;
-- A punch selfie for an event (a JPEG-shaped blob, unique per event).
create function neo_ovt.selfie(p_event uuid, p_late boolean default false) returns void language plpgsql as $$
declare
  e public.attendance_events;
  v_jpeg bytea;
begin
  select * into e from public.attendance_events where id = p_event;
  v_jpeg := '\xffd8ffe0'::bytea || decode(md5(p_event::text), 'hex') || decode(repeat('00', 3000), 'hex');
  insert into public.hr_punch_selfies (event_id, profile_id, employee_email, event_at, taken_at, jpeg, thumb, bytes,
                                       width, height, md5, late)
  values (e.id, e.profile_id, e.employee_email, e.at, e.at, v_jpeg,
          '\xffd8ffe0'::bytea || decode(md5('thumb' || p_event::text), 'hex') || decode(repeat('00', 200), 'hex'),
          octet_length(v_jpeg), 480, 640, md5(v_jpeg), p_late);
end $$;
revoke all on function neo_ovt.flags(text, text) from public, anon, authenticated;
revoke all on function neo_ovt.row(text, text) from public, anon, authenticated;
revoke all on function neo_ovt.ev(text, text, timestamptz, text, text, text[], text, boolean) from public, anon, authenticated;
revoke all on function neo_ovt.selfie(uuid, boolean) from public, anon, authenticated;


-- ── 1. Test users: one per dashboard view, and the people who hold the work ──
do $$
begin
  if exists (select 1 from public.profiles where lower(email) like 'zq.ov.%@neotokyo.test')
     or exists (select 1 from auth.users where lower(email) like 'zq.ov.%@neotokyo.test') then
    raise exception 'TEST SETUP: zq.ov.*@neotokyo.test logins already exist; change the test emails in this file';
  end if;
  if exists (select 1 from public.tickets where id like 't\_ovt\_%')
     or exists (select 1 from public.service_jobs where id like 's\_ovt\_%')
     or exists (select 1 from public.rma_cases where id like 'rc\_ovt\_%') then
    raise exception 'TEST SETUP: *_ovt_* ids are already in use';
  end if;
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c3333333-0000-4000-8000-000000000001', 'zq.ov.head@neotokyo.test', '{"full_name":"Zqovhead Lead"}'),
  ('c3333333-0000-4000-8000-000000000002', 'zq.ov.boss@neotokyo.test', '{"full_name":"Zqovboss One"}'),
  ('c3333333-0000-4000-8000-000000000003', 'zq.ov.boss2@neotokyo.test', '{"full_name":"Zqovbosstwo Two"}'),
  ('c3333333-0000-4000-8000-000000000004', 'zq.ov.hr@neotokyo.test', '{"full_name":"Zqovhr Person"}'),
  ('c3333333-0000-4000-8000-000000000005', 'zq.ov.field@neotokyo.test', '{"full_name":"Zqovfield Person"}'),
  ('c3333333-0000-4000-8000-000000000006', 'zq.ov.tech@neotokyo.test', '{"full_name":"Zqovtech Person"}'),
  ('c3333333-0000-4000-8000-000000000007', 'zq.ov.desk@neotokyo.test', '{"full_name":"Zqovdesk Person"}'),
  ('c3333333-0000-4000-8000-000000000008', 'zq.ov.supply@neotokyo.test', '{"full_name":"Zqovsupply Person"}'),
  ('c3333333-0000-4000-8000-000000000009', 'zq.ov.sales@neotokyo.test', '{"full_name":"Zqovsales Exec"}'),
  ('c3333333-0000-4000-8000-000000000010', 'zq.ov.basic@neotokyo.test', '{"full_name":"Zqovbasic Person"}'),
  ('c3333333-0000-4000-8000-000000000011', 'zq.ov.legacy@neotokyo.test', '{"full_name":"Zqovlegacy Person"}'),
  ('c3333333-0000-4000-8000-000000000012', 'zq.ov.home@neotokyo.test', '{"full_name":"Zqovhome Person"}'),
  ('c3333333-0000-4000-8000-000000000013', 'zq.ov.guest@neotokyo.test', '{"full_name":"Zqovguest Person"}');
update public.profiles p
   set full_name = u.raw_user_meta_data ->> 'full_name', active = true, is_staff = true, created_at = '2020-01-01',
       tier = case p.email when 'zq.ov.head@neotokyo.test' then 3 when 'zq.ov.boss@neotokyo.test' then 4
                           when 'zq.ov.boss2@neotokyo.test' then 4
                           when 'zq.ov.hr@neotokyo.test' then 2 when 'zq.ov.field@neotokyo.test' then 2
                           when 'zq.ov.tech@neotokyo.test' then 2 when 'zq.ov.legacy@neotokyo.test' then 2 else 1 end,
       department = case p.email when 'zq.ov.desk@neotokyo.test' then 'support' when 'zq.ov.supply@neotokyo.test' then 'procurement'
                                 when 'zq.ov.sales@neotokyo.test' then 'sales' when 'zq.ov.basic@neotokyo.test' then 'marketing'
                                 when 'zq.ov.hr@neotokyo.test' then 'hr' when 'zq.ov.head@neotokyo.test' then 'exec'
                                 else 'service' end,
       designation = case p.email when 'zq.ov.sales@neotokyo.test' then 'Zq Sales Executive' else 'Zq Tester' end
  from auth.users u
 where u.id = p.id and p.email like 'zq.ov.%@neotokyo.test' and p.email <> 'zq.ov.guest@neotokyo.test';
update public.profiles set full_name = 'Zqovguest Person', tier = 1, is_staff = false, active = true
 where email = 'zq.ov.guest@neotokyo.test';

insert into neo_ovt.users (alias, id, email, tier, name)
select split_part(split_part(lower(p.email), '@', 1), '.', 3), p.id, lower(p.email), p.tier, p.full_name
  from public.profiles p where lower(p.email) like 'zq.ov.%@neotokyo.test';

do $$
begin
  if (select count(*) from neo_ovt.users) <> 13 then
    raise exception 'TEST SETUP: the throw-away logins did not get profiles (handle_new_user): %', (select count(*) from neo_ovt.users);
  end if;
  if (public._staff_for_short_name('Zqovlegacy')).id is distinct from neo_ovt.uid('legacy') then
    raise exception 'TEST SETUP: "Zqovlegacy" must name the legacy login alone among active staff';
  end if;
end $$;

-- Exactly the roles, pools and field switch this file expects.
delete from public.module_access where profile_id in (select id from neo_ovt.users);
insert into public.module_access (profile_id, module, role, granted_by)
select u.id, m.module, m.role, 'tests'
  from neo_ovt.users u
  join (values ('hr', 'neohr', 'lead'),
               ('field', 'service', 'tech'), ('field', 'qc', 'tech'), ('field', 'rma', 'tech'),
               ('tech', 'service', 'tech'), ('tech', 'qc', 'tech'), ('tech', 'rma', 'tech'),
               ('desk', 'service', 'desk'), ('desk', 'rma', 'desk'),
               ('supply', 'qc', 'tech'), ('supply', 'rma', 'tech'),
               ('legacy', 'qc', 'tech')) as m(alias, module, role)
    on m.alias = u.alias;
delete from public.staff_work where profile_id in (select id from neo_ovt.users);
insert into public.staff_work (profile_id, build_pool, service_pool, build_level, updated_by)
select u.id, true, true, 'senior', 'tests' from neo_ovt.users u where u.alias in ('field', 'tech');
delete from public.hr_person where profile_id in (select id from neo_ovt.users);
insert into public.hr_person (profile_id, track_location, ta_eligible, attendance_required, updated_by)
select u.id, u.alias in ('field', 'tech'), u.alias in ('field', 'tech'), true, 'tests' from neo_ovt.users u where u.alias <> 'guest';

-- Pin the shift, the settings and the near holidays for this transaction (as
-- sql/neohr-hr.tests.sql does): 09:30–18:30, 10 minutes' grace, no weekly off.
delete from public.hr_shift_history
 where profile_id is null and effective_from > (select min(h.effective_from) from public.hr_shift_history h where h.profile_id is null);
update public.hr_shift_history set shift_start = '09:30', shift_end = '18:30', grace_min = 10, weekly_off = '{}', half_day_min = 240
 where profile_id is null;
update public.hr_settings
   set shift_start = '09:30', shift_end = '18:30', grace_min = 10, weekly_off = '{}', half_day_min = 240,
       max_session_h = 16, attendance_from = '2020-01-01'
 where id = 1;
delete from public.hr_holidays where day between public._hr_today() - 3 and public._hr_today() + 3;
delete from public.hr_roster where profile_id in (select id from neo_ovt.users);
delete from public.hr_shift_history where profile_id in (select id from neo_ovt.users);
-- home works from home today (rostered)
insert into public.hr_roster (profile_id, day, duty, note, set_by_email)
values (neo_ovt.uid('home'), public._hr_today(), 'wfh', 'Zq test', 'tests');


-- ── 2. Shape facts and grants (as the owner) ────────────────────────────────
do $$
declare
  f record; n int;
  v_api text[] := array['neo_overview', 'neo_overview_list'];
  v_all text[] := array['_hr_ov_gates', '_hr_ov_when', '_hr_ov_age', '_hr_ov_items', 'neo_overview', 'neo_overview_list'];
begin
  select count(*) into n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any (v_all);
  perform neo_ovt.assert(n = cardinality(v_all), format('every function of the file exists exactly once (%s of %s)', n, cardinality(v_all)));
  for f in select p.oid, p.proname, p.prosecdef, p.proconfig, p.provolatile from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = any (v_all) loop
    perform neo_ovt.assert(not has_function_privilege('anon', f.oid, 'execute'), 'anon cannot execute ' || f.proname);
    perform neo_ovt.assert(has_function_privilege('service_role', f.oid, 'execute'), 'service_role may execute ' || f.proname);
    perform neo_ovt.assert(array_to_string(f.proconfig, ',') like '%search_path=public%', f.proname || ' pins search_path = public');
    if f.proname = any (v_api) then
      perform neo_ovt.assert(has_function_privilege('authenticated', f.oid, 'execute'), 'authenticated may execute ' || f.proname);
      perform neo_ovt.assert(f.prosecdef, f.proname || ' is security definer');
    else
      perform neo_ovt.assert(not has_function_privilege('authenticated', f.oid, 'execute'), 'authenticated cannot execute ' || f.proname);
    end if;
  end loop;
  perform neo_ovt.assert((select pg_get_function_identity_arguments('public.neo_overview_list(text, text, text)'::regprocedure))
                           = 'p_kind text, p_scope text, p_state text'
                         and (select pg_get_function_result('public.neo_overview_list(text, text, text)'::regprocedure)) = 'jsonb'
                         and (select pg_get_function_result('public.neo_overview()'::regprocedure)) = 'jsonb'
                         and (select pg_get_function_identity_arguments('public._hr_ov_items(uuid)'::regprocedure)) = 'p_viewer uuid',
                         '§1.7: neo_overview(), neo_overview_list(p_kind, p_scope, p_state), _hr_ov_items(p_viewer)');
  perform neo_ovt.assert((select provolatile from pg_proc where oid = 'public._hr_ov_items(uuid)'::regprocedure) = 's'
                         and (select provolatile from pg_proc where oid = 'public.neo_overview_list(text, text, text)'::regprocedure) = 's',
                         '_hr_ov_items and neo_overview_list are STABLE (they write nothing)');
  perform neo_ovt.assert(strpos(pg_get_functiondef('public.neo_dashboard()'::regprocedure), '_hr_ov') = 0
                         and strpos(pg_get_functiondef('public.neo_dashboard()'::regprocedure), 'attendance') = 0,
                         '§1.7: neo_dashboard is untouched');
  -- the small helpers
  perform neo_ovt.assert(public._hr_ov_age(now() - interval '40 minutes', now()) = '40 min'
                         and public._hr_ov_age(now() - interval '5 hours', now()) = '5 h'
                         and public._hr_ov_age(now() - interval '47 hours', now()) = '47 h'
                         and public._hr_ov_age(now() - interval '3 days 2 hours', now()) = '3 days'
                         and public._hr_ov_age(now() + interval '1 hour', now()) = '0 min', '_hr_ov_age: min / h / days');
  perform neo_ovt.assert(public._hr_ov_when(now()) = to_char(now() at time zone 'Asia/Kolkata', 'HH24:MI')
                         and public._hr_ov_when(public._hr_at(public._hr_today() - 3, '14:05')) = to_char((public._hr_today() - 3)::timestamp, 'FMDD Mon') || ' 14:05'
                         and public._hr_ov_when(null) is null, '_hr_ov_when: HH:MM today, else "23 Oct 14:05" (shop time)');
end $$;


-- ── 3. The work (as the owner, every trigger standing aside so times are exact) ─
do $$
declare
  v_lo timestamptz := public._hr_at(public._hr_today(), '00:00');
  v_hi timestamptz := public._hr_at(public._hr_today() + 1, '00:00');
  v_fe text := neo_ovt.email('field');
  v_te text := neo_ovt.email('tech');
  v_se text := neo_ovt.email('sales');
  v_done jsonb := '{"received":true,"undamaged":true,"matches":true}'::jsonb;
begin
  perform set_config('neo.migrating', '1', true);
  perform set_config('neo.rma_nosync', '1', true);
  perform neo_ovt.put('lo', v_lo::text); perform neo_ovt.put('hi', v_hi::text);
  -- builds
  insert into public.tickets (id, type, customer_name, status, technician, technician_email, assigned_via, assigned_at,
                              queued_at, deadline, missing_components_toggle, specs, created_at, updated_at)
  values
    ('t_ovt_b1', 'build', 'Zq Ov Late Build', 'building', 'Zqovfield', v_fe, 'claim', now() - interval '1 day', null,
     now() - interval '1 hour', false, jsonb_build_object('__build', jsonb_build_object('tier', 2, 'salesExec', v_se)),
     now() - interval '3 days', now()),
    ('t_ovt_b2', 'build', 'Zq Ov Parts In', 'awaiting', 'Zqovtech', v_te, 'claim', now() - interval '1 day', null,
     now() + interval '30 days', false, jsonb_build_object('__procurement', v_done), now() - interval '3 days', now()),
    ('t_ovt_b3', 'build', 'Zq Ov Unclaimed', 'awaiting', null, null, null, null, now() - interval '5 hours',
     null, true, '{}'::jsonb, now() - interval '1 day', now()),
    ('t_ovt_b4', 'build', 'Zq Ov Unclaimed Past Deadline', 'awaiting', null, null, null, null, now() - interval '5 hours',
     now() - interval '2 hours', false, '{}'::jsonb, now() - interval '1 day', now()),
    ('t_ovt_b5', 'build', 'Zq Ov Quote', 'awaiting', null, null, null, null, null,
     null, false, jsonb_build_object('__procurement', v_done, '__build', jsonb_build_object('salesExec', '  zqovsales   EXEC ')),
     now() - interval '1 day', now()),
    ('t_ovt_b6', 'build', 'Zq Ov Legacy', 'waiting_qc', 'Zqovlegacy', null, 'legacy', now() - interval '2 days', null,
     null, false, jsonb_build_object('__build', jsonb_build_object('salesExec', ' ' || upper(v_se) || ' ')),
     now() - interval '3 days', now()),
    ('t_ovt_b9', 'build', 'Zq Ov Junk Specs', 'awaiting', null, null, null, null, null,
     null, null, '[1,2]'::jsonb, now() - interval '1 day', now()),
    ('t_ovt_b10', 'build', 'Zq Ov Due Tonight', 'qc_testing', 'Zqovfield', v_fe, 'claim', now() - interval '1 day', null,
     v_hi - interval '1 second', false, '{}'::jsonb, now() - interval '3 days', now()),
    ('t_ovt_b11', 'build', 'Zq Ov Someone Elses Sale', 'awaiting', null, null, null, null, null,
     null, false, jsonb_build_object('__build', jsonb_build_object('salesExec', 'zq.ov.nobody@neotokyo.test')),
     now() - interval '1 day', now()),
    ('t_ovt_b8', 'build', 'Zq Ov Done', 'completed', 'Zqovfield', v_fe, 'claim', now() - interval '9 days', null,
     now() - interval '5 days', false, jsonb_build_object('__build', jsonb_build_object('salesExec', v_se)),
     now() - interval '10 days', now());
  -- a build in the queue offered to field for the next 20 minutes
  insert into public.tickets (id, type, customer_name, status, queued_at, specs, created_at, updated_at,
                              offered_to_email, offered_to_name, offer_kind, offer_by_name, offered_at, offer_expires_at)
  values ('t_ovt_b7', 'build', 'Zq Ov Offered', 'awaiting', now() - interval '10 minutes', '{}'::jsonb,
          now() - interval '1 day', now(), v_fe, 'Zqovfield Person', 'manager', 'Zqovhead Lead', now() - interval '10 minutes',
          now() + interval '20 minutes');

  -- service tickets
  insert into public.service_jobs (id, public_code, model_version, service_type, stage, stage_since, customer_name, customer_phone,
                                   device_label, category, assignee, assignee_email, assigned_via, assigned_at, queued_at,
                                   promised_at, needed_by, visit_start, site_address, site_area, created_at)
  values
    ('s_ovt_s1', 'NT-OVTS0001', 2, 'in_store', 'diagnosing', now() - interval '3 days', 'Zqcustomer Ov One', '9000000461',
     'Zq Ov Slow Laptop', 'repair', 'Zqovfield Person', v_fe, 'claim', now() - interval '3 days', null,
     null, null, null, null, null, now() - interval '4 days'),
    ('s_ovt_s2', 'NT-OVTS0002', 2, 'in_store', 'quoted', now(), 'Zqcustomer Ov Two', '9000000462',
     'Zq Ov Promised PC', 'repair', 'Zqovfield Person', v_fe, 'claim', now() - interval '1 day', null,
     now() - interval '1 hour', null, null, null, null, now() - interval '2 days'),
    ('s_ovt_s3', 'NT-OVTS0003', 2, 'in_store', 'received', now() - interval '1 hour', 'Zqcustomer Ov Three', '9000000463',
     'Zq Ov Waiting PC', 'repair', null, null, null, null, now() - interval '6 hours',
     null, null, null, null, null, now() - interval '6 hours'),
    ('s_ovt_s4', 'NT-OVTS0004', 2, 'in_store', 'ready', now(), 'Zqcustomer Ov Four', '9000000464',
     'Zq Ov Ready PC', 'repair', 'Zqovtech Person', v_te, 'claim', now() - interval '2 days', null,
     null, now() - interval '1 day', null, null, null, now() - interval '3 days'),
    ('s_ovt_s5', 'NT-OVTS0005', 2, 'in_store', 'parts_on_order', now(), 'Zqcustomer Ov Five', '9000000465',
     'Zq Ov Parts PC', 'repair', 'Zqovtech Person', v_te, 'claim', now() - interval '2 days', null,
     null, now() - interval '1 hour', null, null, null, now() - interval '3 days'),
    ('s_ovt_s6', 'NT-OVTS0006', 2, 'on_site', 'scheduled', now() - interval '1 day', 'Zqcustomer Ov Six', '9000000466',
     null, 'networking', 'Zqovfield Person', v_fe, 'claim', now() - interval '1 day', null,
     null, null, now() - interval '40 minutes', '6 Zq Road', 'Zqarea', now() - interval '2 days'),
    ('s_ovt_s7', 'NT-OVTS0007', 2, 'on_site', 'scheduled', now(), 'Zqcustomer Ov Seven', '9000000467',
     null, 'installation', 'Zqovtech Person', v_te, 'claim', now(), null,
     null, null, now() + interval '2 hours', '7 Zq Road', 'Zqarea', now() - interval '1 day'),
    ('s_ovt_s9', 'NT-OVTS0009', 2, 'in_store', 'closed', now(), 'Zqcustomer Ov Nine', '9000000469',
     null, 'repair', 'Zqovfield Person', v_fe, 'claim', now() - interval '5 days', null,
     now() - interval '4 days', null, null, null, null, now() - interval '6 days'),
    ('s_ovt_s10', 'NT-OVTS0010', 2, 'on_site', 'work_done', now(), 'Zqcustomer Ov Ten', '9000000470',
     null, 'repair', 'Zqovfield Person', v_fe, 'claim', now() - interval '3 days', null,
     now() - interval '2 days', null, now() - interval '1 day', '10 Zq Road', 'Zqarea', now() - interval '4 days'),
    ('s_ovt_s11', 'NT-OVTS0011', 2, 'remote', 'resolved', now(), 'Zqcustomer Ov Eleven', '9000000471',
     null, 'os_software', 'Zqovtech Person', v_te, 'claim', now() - interval '3 days', null,
     null, now() - interval '1 day', null, null, null, now() - interval '4 days');
  -- a ticket in the queue offered to field for the next 20 minutes
  insert into public.service_jobs (id, public_code, model_version, service_type, stage, stage_since, customer_name, customer_phone,
                                   category, queued_at, created_at, offered_to_email, offered_to_name, offer_kind, offer_by_name,
                                   offered_at, offer_expires_at)
  values ('s_ovt_s8', 'NT-OVTS0008', 2, 'in_store', 'logged', now() - interval '10 minutes', 'Zqcustomer Ov Eight', '9000000468',
          'upgrade', now() - interval '10 minutes', now() - interval '10 minutes', v_fe, 'Zqovfield Person', 'manager',
          'Zqovhead Lead', now() - interval '10 minutes', now() + interval '20 minutes');

  -- RMA parts
  insert into public.rma_intakes (id, source, sender_kind) values ('ri_ovt_1', 'walk_in', 'customer');
  insert into public.rma_cases (id, public_code, intake_id, holds_ticket, kind, brand, model, stage, stage_since,
                                expected_back_at, return_method, handler_email, handler_name)
  values ('rc_ovt_r1', 'RM-OVTR0001', 'ri_ovt_1', false, 'gpu', 'Zqbrand', 'Zq 4060', 'with_vendor', now() - interval '20 days',
          now() - interval '1 day', 'collect', v_fe, 'Zqovfield Person'),
         ('rc_ovt_r2', 'RM-OVTR0002', 'ri_ovt_1', false, 'psu', null, null, 'with_vendor', now() - interval '2 days',
          now() + interval '5 days', 'collect', null, null),
         ('rc_ovt_r3', 'RM-OVTR0003', 'ri_ovt_1', false, 'ssd', null, null, 'testing', now() - interval '5 days',
          null, 'collect', v_te, 'Zqovtech Person'),
         ('rc_ovt_r4', 'RM-OVTR0004', 'ri_ovt_1', false, 'ram', null, null, 'ready_to_return', now(),
          null, 'collect', null, null),
         ('rc_ovt_r5', 'RM-OVTR0005', 'ri_ovt_1', false, 'cpu', null, null, 'closed', now(),
          null, 'collect', v_fe, 'Zqovfield Person');
  perform set_config('neo.rma_nosync', '', true);
  perform set_config('neo.migrating', '', true);
end $$;


-- ── 4. The definitions, item by item (as the owner, through the helper) ──────
do $$
declare
  v_hi timestamptz := neo_ovt.get('hi')::timestamptz;
  v_lo timestamptz := neo_ovt.get('lo')::timestamptz;
  v_edge text := case when v_hi - interval '1 second' <= now() then ',overdue' else '' end;   -- the last second of the day
  r jsonb;
  x record;
begin
  -- as the head: every kind, nothing of it theirs
  for x in select * from (values
      ('t_ovt_b1', 'assigned,overdue,shop'),
      ('t_ovt_b2', 'assigned,shop'),
      ('t_ovt_b3', 'in_queue,late,waiting_parts,shop'),
      ('t_ovt_b4', 'in_queue,overdue,waiting_parts,shop'),
      ('t_ovt_b5', 'not_sent,shop'),
      ('t_ovt_b6', 'assigned,shop'),
      ('t_ovt_b7', 'in_queue,waiting_parts,shop'),
      ('t_ovt_b9', 'not_sent,waiting_parts,shop'),
      ('t_ovt_b10', 'assigned' || v_edge || ',shop'),
      ('t_ovt_b11', 'not_sent,waiting_parts,shop'),
      ('s_ovt_s1', 'assigned,late,shop'),
      ('s_ovt_s2', 'assigned,overdue,waiting_customer,shop'),
      ('s_ovt_s3', 'in_queue,late,shop'),
      ('s_ovt_s4', 'assigned,waiting_customer,ready_to_collect,shop'),
      ('s_ovt_s5', 'assigned,overdue,waiting_supplier,shop'),
      ('s_ovt_s6', 'assigned,overdue,shop'),
      ('s_ovt_s7', 'assigned,shop'),
      ('s_ovt_s8', 'in_queue,shop'),
      ('s_ovt_s10', 'assigned,waiting_customer,shop'),
      ('s_ovt_s11', 'assigned,waiting_customer,shop'),
      ('rc_ovt_r1', 'assigned,overdue,at_vendor,shop'),
      ('rc_ovt_r2', 'in_queue,at_vendor,shop'),
      ('rc_ovt_r3', 'assigned,late,shop'),
      ('rc_ovt_r4', 'in_queue,to_return,shop')) as v(id, flags) loop
    perform neo_ovt.assert(neo_ovt.flags('head', x.id) = x.flags,
                           format('head sees %s as %s, expected %s', x.id, neo_ovt.flags('head', x.id), x.flags));
  end loop;
  perform neo_ovt.assert(neo_ovt.row('head', 't_ovt_b8') is null and neo_ovt.row('head', 's_ovt_s9') is null
                         and neo_ovt.row('head', 'rc_ovt_r5') is null, 'completed builds, closed tickets and closed parts are not open');
  -- no item anywhere is both late and overdue; a done stage is never overdue
  perform neo_ovt.assert(not exists (select 1 from public._hr_ov_items(neo_ovt.uid('head')) i where i.late and i.overdue),
                         'D12: late and overdue never meet (live items included)');
  perform neo_ovt.assert(not exists (select 1 from public._hr_ov_items(neo_ovt.uid('head')) i
                                      where i.kind = 'service' and i.stage in ('ready', 'work_done', 'resolved') and i.overdue),
                         'a service ticket in a done stage (ready, work_done, resolved) is never overdue');
  -- stages, labels, technicians, sales stages
  r := neo_ovt.row('head', 't_ovt_b6');
  perform neo_ovt.assert(r ->> 'tech_email' = neo_ovt.email('legacy') and r ->> 'tech_name' = 'Zqovlegacy Person'
                         and r ->> 'stage' = 'waiting_qc' and r ->> 'stage_label' = 'Waiting for QC' and r ->> 'sales_stage' = 'qc'
                         and r ->> 'code' = upper(right('t_ovt_b6', 6)) and r ->> 'title' = 'Zq Ov Legacy',
                         'a name-only legacy build resolves to the one staff member with that first name: ' || r::text);
  r := neo_ovt.row('head', 't_ovt_b1');
  perform neo_ovt.assert(r ->> 'tech_email' = neo_ovt.email('field') and r ->> 'tech_name' = 'Zqovfield Person'
                         and r ->> 'stage_label' = 'Building' and r ->> 'sales_stage' = 'building'
                         and (r ->> 'due')::timestamptz = now() - interval '1 hour'
                         and r ->> 'why' = 'Overdue — the deadline was ' || public._hr_ov_when(now() - interval '1 hour') || '.',
                         'an overdue build: its technician, stage and why: ' || r::text);
  perform neo_ovt.assert(neo_ovt.row('head', 't_ovt_b3') ->> 'why' = 'Late — nobody has claimed it in 4 hours.'
                         and neo_ovt.row('head', 't_ovt_b3') ->> 'stage_label' = 'Waiting for parts'
                         and neo_ovt.row('head', 't_ovt_b3') ->> 'sales_stage' = 'waiting_parts'
                         and neo_ovt.row('head', 't_ovt_b5') ->> 'stage_label' = 'Ready to build'
                         and neo_ovt.row('head', 't_ovt_b5') ->> 'sales_stage' = 'ready_to_build'
                         and (neo_ovt.row('head', 't_ovt_b3') ->> 'since')::timestamptz = now() - interval '5 hours'
                         and neo_ovt.row('head', 't_ovt_b4') ->> 'why' like 'Overdue — the deadline was %',
                         'builds: 4 h unclaimed is late; parts in or not; overdue beats late');
  r := neo_ovt.row('head', 's_ovt_s1');
  perform neo_ovt.assert(r ->> 'why' = 'Late — 3 days in this stage.' and r ->> 'stage_label' = 'Diagnosing'
                         and r ->> 'code' = 'NT-OVTS0001' and r ->> 'title' = 'Zq Ov Slow Laptop'
                         and r ->> 'tech_name' = 'Zqovfield Person', 'service late: too long in its stage: ' || r::text);
  perform neo_ovt.assert(neo_ovt.row('head', 's_ovt_s2') ->> 'why' = 'Overdue — promised for ' || public._hr_ov_when(now() - interval '1 hour') || '.'
                         and (neo_ovt.row('head', 's_ovt_s2') ->> 'due')::timestamptz = now() - interval '1 hour'
                         and neo_ovt.row('head', 's_ovt_s3') ->> 'why' = 'Late — nobody has claimed it in 4 hours.'
                         and neo_ovt.row('head', 's_ovt_s5') ->> 'why' = 'Overdue — needed by ' || public._hr_ov_when(now() - interval '1 hour') || '.'
                         and neo_ovt.row('head', 's_ovt_s6') ->> 'why' = 'Overdue — the visit was booked for ' || public._hr_ov_when(now() - interval '40 minutes') || '.'
                         and (neo_ovt.row('head', 's_ovt_s6') ->> 'due')::timestamptz = now() - interval '10 minutes'
                         and (neo_ovt.row('head', 's_ovt_s7') ->> 'due')::timestamptz = now() + interval '150 minutes'
                         and (neo_ovt.row('head', 's_ovt_s4') ->> 'due')::timestamptz = now() - interval '1 day'
                         and neo_ovt.row('head', 's_ovt_s4') ->> 'stage_label' = 'Ready for collection'
                         and neo_ovt.row('head', 's_ovt_s3') ->> 'tech_email' is null,
                         'service overdue: a broken promise, a needed-by time, a visit 30 min past its start; due = that instant');
  perform neo_ovt.assert(neo_ovt.row('head', 'rc_ovt_r1') ->> 'why' = 'Overdue — due back from the vendor by ' || public._hr_ov_when(now() - interval '1 day') || '.'
                         and neo_ovt.row('head', 'rc_ovt_r1') ->> 'title' = 'Graphics card · Zqbrand Zq 4060'
                         and neo_ovt.row('head', 'rc_ovt_r1') ->> 'stage_label' = 'With vendor'
                         and neo_ovt.row('head', 'rc_ovt_r3') ->> 'why' = 'Late — 5 days in this stage.'
                         and (neo_ovt.row('head', 'rc_ovt_r2') ->> 'due')::timestamptz = now() + interval '5 days'
                         and neo_ovt.row('head', 'rc_ovt_r4') ->> 'due' is null,
                         'RMA: overdue at the vendor past the expected date; late past the stage budget');
  -- due today (India day), computed with the same rule
  perform neo_ovt.assert((neo_ovt.row('head', 't_ovt_b10') ->> 'due_today')::boolean
                         and (neo_ovt.row('head', 't_ovt_b1') ->> 'due_today')::boolean = (now() - interval '1 hour' >= v_lo)
                         and (neo_ovt.row('head', 's_ovt_s7') ->> 'due_today')::boolean = (now() + interval '150 minutes' < v_hi)
                         and not (neo_ovt.row('head', 't_ovt_b2') ->> 'due_today')::boolean,
                         'due today = due inside today''s India day');

  -- as field: theirs and the offers to them
  for x in select * from (values
      ('t_ovt_b1', 'assigned,mine,overdue,shop'),
      ('t_ovt_b7', 'in_queue,offered,waiting_parts,shop'),
      ('t_ovt_b10', 'assigned,mine' || v_edge || ',shop'),
      ('t_ovt_b2', 'assigned,shop'),
      ('s_ovt_s1', 'assigned,mine,late,shop'),
      ('s_ovt_s8', 'in_queue,offered,shop'),
      ('s_ovt_s10', 'assigned,mine,waiting_customer,shop'),
      ('rc_ovt_r1', 'assigned,mine,overdue,at_vendor,shop'),
      ('rc_ovt_r3', 'assigned,late,shop')) as v(id, flags) loop
    perform neo_ovt.assert(neo_ovt.flags('field', x.id) = x.flags,
                           format('field sees %s as %s, expected %s', x.id, neo_ovt.flags('field', x.id), x.flags));
  end loop;
  perform neo_ovt.assert(neo_ovt.row('field', 't_ovt_b7') ->> 'why' = 'Offered to you — accept by ' || public._ist_hm(now() + interval '20 minutes') || '.'
                         and neo_ovt.row('field', 's_ovt_s8') ->> 'why' = 'Offered to you — accept by ' || public._ist_hm(now() + interval '20 minutes') || '.',
                         'an offer to me says until when');

  -- as sales: only the builds they sold (email, or their name), never the shop's
  perform neo_ovt.assert(neo_ovt.flags('sales', 't_ovt_b1') = 'assigned,overdue,sales_mine'
                         and neo_ovt.flags('sales', 't_ovt_b5') = 'not_sent,sales_mine'
                         and neo_ovt.flags('sales', 't_ovt_b6') = 'assigned,sales_mine'
                         and neo_ovt.row('sales', 't_ovt_b11') is null and neo_ovt.row('sales', 't_ovt_b3') is null
                         and neo_ovt.row('sales', 's_ovt_s1') is null and neo_ovt.row('sales', 'rc_ovt_r1') is null,
                         'sales: their own builds only (salesExec email in any case, or their full name), no service or RMA');
  -- the desk: service and RMA, no builds; basic: nothing; a non-staff id: nothing
  perform neo_ovt.assert(neo_ovt.row('desk', 't_ovt_b1') is null and neo_ovt.row('desk', 's_ovt_s1') is not null
                         and neo_ovt.row('desk', 'rc_ovt_r1') is not null
                         and neo_ovt.row('supply', 't_ovt_b1') is not null and neo_ovt.row('supply', 's_ovt_s1') is null
                         and neo_ovt.row('supply', 'rc_ovt_r1') is not null
                         and not exists (select 1 from public._hr_ov_items(neo_ovt.uid('basic')))
                         and not exists (select 1 from public._hr_ov_items(neo_ovt.uid('guest')))
                         and not exists (select 1 from public._hr_ov_items(null)),
                         'gating: builds need a Builds role, service a Service role, RMA an RMA role; nobody else sees any');
end $$;


-- ── 5. Who gets which section (per dashboard view) ──────────────────────────
select neo_ovt.login('head');
do $$
declare r jsonb := public.neo_overview();
begin
  perform neo_ovt.assert(neo_ovt.keys(r) = 'builds,hr,now,rma,service,top,view' and r ->> 'view' = 'head'
                         and (r ->> 'now')::timestamptz = now(),
                         'head (tier 3): every kind + hr, no mine (no pool, holds nothing), no sales: ' || neo_ovt.keys(r) || ' / ' || coalesce(r ->> 'view', 'null'));
  perform neo_ovt.assert(neo_ovt.keys(r -> 'builds') = 'assigned,in_queue,late,mine,not_sent,open,overdue,waiting_parts'
                         and neo_ovt.keys(r -> 'service') = 'assigned,in_queue,late,mine,open,overdue,ready_to_collect,waiting_customer,waiting_supplier'
                         and neo_ovt.keys(r -> 'rma') = 'assigned,at_vendor,in_queue,late,mine,open,overdue,to_return',
                         'the section keys: ' || (r - 'hr' - 'top')::text);
  perform neo_ovt.assert((r -> 'hr') ?& array['on_duty', 'on_break', 'on_site', 'absent', 'not_in_yet', 'pending_requests',
                                              'late_today', 'away_pending', 'reasons_pending', 'past_eod', 'unverified_today',
                                              'unseen_photos', 'on_trip'],
                         'the hr block has the §1.2 keys (it is hr_dashboard().hr): ' || (r -> 'hr')::text);
  perform neo_ovt.assert(jsonb_array_length(r -> 'top') between 1 and 6
                         and not exists (select 1 from jsonb_array_elements(r -> 'top') e(value)
                                          where not ((e.value ->> 'late')::boolean or (e.value ->> 'overdue')::boolean)
                                             or ((e.value ->> 'late')::boolean and (e.value ->> 'overdue')::boolean))
                         and coalesce((select max(e.n) filter (where (e.value ->> 'overdue')::boolean)
                                         < min(e.n) filter (where not (e.value ->> 'overdue')::boolean)
                                         from jsonb_array_elements(r -> 'top') with ordinality e(value, n)), true)
                         and (select neo_ovt.keys(e.value) from jsonb_array_elements(r -> 'top') e(value) limit 1)
                             = 'code,due,id,kind,late,overdue,since,stage,stage_label,tech_email,tech_name,title,why',
                         'top: at most 6, each late or overdue (never both), overdue first: ' || (r -> 'top')::text);
  perform neo_ovt.assert((r #>> '{builds,open}')::int = (r #>> '{builds,assigned}')::int + (r #>> '{builds,in_queue}')::int
                                                         + (r #>> '{builds,not_sent}')::int
                         and (r #>> '{service,open}')::int = (r #>> '{service,assigned}')::int + (r #>> '{service,in_queue}')::int
                         and (r #>> '{rma,open}')::int = (r #>> '{rma,assigned}')::int + (r #>> '{rma,in_queue}')::int,
                         'open = assigned + in the queue (+ not sent for builds)');
  perform neo_ovt.put('head_counts', r::text);
end $$;

select neo_ovt.login('boss');
do $$
declare r jsonb := public.neo_overview();
begin
  perform neo_ovt.assert(neo_ovt.keys(r) = 'builds,hr,now,rma,service,top,view' and r ->> 'view' = 'head',
                         'tier 4: the head view: ' || neo_ovt.keys(r));
end $$;

select neo_ovt.login('hr');
do $$
declare r jsonb := public.neo_overview();
begin
  perform neo_ovt.assert(neo_ovt.keys(r) = 'hr,now,top,view' and r ->> 'view' = 'hr' and r -> 'top' = '[]'::jsonb,
                         'a NeoHR lead (tier 2, no work roles): the hr view, hr block only: ' || neo_ovt.keys(r));
end $$;

select neo_ovt.login('field');
do $$
declare
  r jsonb := public.neo_overview();
  v_hi timestamptz := neo_ovt.get('hi')::timestamptz;
  v_lo timestamptz := neo_ovt.get('lo')::timestamptz;
begin
  perform neo_ovt.assert(neo_ovt.keys(r) = 'builds,mine,now,rma,service,top,view' and r ->> 'view' = 'field'
                         and neo_ovt.keys(r -> 'mine') = 'builds,rma,service'
                         and neo_ovt.keys(r -> 'mine' -> 'builds') = 'due_today,items,late,offered,overdue',
                         'field staff in both pools: mine per kind + the shop sections, no hr: ' || neo_ovt.keys(r) || ' ' || (r -> 'mine')::text);
  perform neo_ovt.assert((r #>> '{mine,builds,items}')::int = 2 and (r #>> '{mine,builds,offered}')::int = 1
                         and (r #>> '{mine,builds,overdue}')::int = 1 + case when v_hi - interval '1 second' <= now() then 1 else 0 end
                         and (r #>> '{mine,builds,due_today}')::int = 1 + case when now() - interval '1 hour' >= v_lo then 1 else 0 end
                         and (r #>> '{mine,service,items}')::int = 4 and (r #>> '{mine,service,offered}')::int = 1
                         and (r #>> '{mine,service,late}')::int = 1 and (r #>> '{mine,service,overdue}')::int = 2
                         and (r #>> '{mine,rma,items}')::int = 1 and (r #>> '{mine,rma,offered}')::int = 0
                         and (r #>> '{mine,rma,overdue}')::int = 1 and (r #>> '{mine,rma,late}')::int = 0
                         and (r #>> '{builds,mine}')::int = 2 and (r #>> '{service,mine}')::int = 4 and (r #>> '{rma,mine}')::int = 1,
                         'field: my items, offers, due today, late, overdue per kind: ' || (r -> 'mine')::text);
end $$;

select neo_ovt.login('desk');
do $$
declare r jsonb := public.neo_overview();
begin
  perform neo_ovt.assert(neo_ovt.keys(r) = 'now,rma,service,top,view' and r ->> 'view' = 'desk',
                         'a service + RMA desk (support): service and rma, no builds, no mine: ' || neo_ovt.keys(r) || ' / ' || coalesce(r ->> 'view', 'null'));
end $$;

select neo_ovt.login('supply');
do $$
declare r jsonb := public.neo_overview();
begin
  perform neo_ovt.assert(neo_ovt.keys(r) = 'builds,now,rma,top,view' and r ->> 'view' = 'supply',
                         'procurement with Builds and RMA roles (not desk): builds and rma, no mine: ' || neo_ovt.keys(r) || ' / ' || coalesce(r ->> 'view', 'null'));
end $$;

select neo_ovt.login('sales');
do $$
declare r jsonb := public.neo_overview();
begin
  perform neo_ovt.assert(neo_ovt.keys(r) = 'now,sales,top,view' and r ->> 'view' = 'sales'
                         and neo_ovt.keys(r -> 'sales') = 'by_stage,late,open,overdue'
                         and neo_ovt.keys(r -> 'sales' -> 'by_stage') = 'building,qc,ready_to_build,waiting_parts',
                         'sales: their builds only: ' || neo_ovt.keys(r));
  perform neo_ovt.assert((r #>> '{sales,open}')::int = 3 and (r #>> '{sales,by_stage,building}')::int = 1
                         and (r #>> '{sales,by_stage,ready_to_build}')::int = 1 and (r #>> '{sales,by_stage,qc}')::int = 1
                         and (r #>> '{sales,by_stage,waiting_parts}')::int = 0
                         and (r #>> '{sales,overdue}')::int = 1 and (r #>> '{sales,late}')::int = 0,
                         'sales: open by stage (waiting for parts, ready to build, building, QC), late, overdue: ' || (r -> 'sales')::text);
  perform neo_ovt.assert(jsonb_array_length(r -> 'top') = 1 and r -> 'top' -> 0 ->> 'id' = 't_ovt_b1',
                         'sales: the late / overdue of their builds: ' || (r -> 'top')::text);
end $$;

select neo_ovt.login('basic');
do $$
declare r jsonb := public.neo_overview();
begin
  perform neo_ovt.assert(neo_ovt.keys(r) = 'now,top,view' and r ->> 'view' = 'basic' and r -> 'top' = '[]'::jsonb,
                         'no role, no pool, no sales: now / view / top only (never zeros): ' || r::text);
end $$;

select neo_ovt.login('guest');
do $$
begin
  perform neo_ovt.expect_error('select public.neo_overview()', 'NEO_DENIED: Sign in with an active staff account to do this.');
  perform neo_ovt.expect_error('select public.neo_overview_list(''build'', ''all'', ''any'')',
                               'NEO_DENIED: Sign in with an active staff account to do this.');
end $$;


-- ── 6. Every tile = the length of its list, for every view ──────────────────
select neo_ovt.login('head');
do $$ begin perform neo_ovt.assert(neo_ovt.check_tiles('head') = 25, 'head: 25 tiles checked'); end $$;
select neo_ovt.login('boss');
do $$ begin perform neo_ovt.assert(neo_ovt.check_tiles('boss') = 25, 'boss: 25 tiles checked'); end $$;
select neo_ovt.login('hr');
do $$ begin perform neo_ovt.assert(neo_ovt.check_tiles('hr') = 0, 'hr: no ticket tiles'); end $$;
select neo_ovt.login('field');
do $$ begin perform neo_ovt.assert(neo_ovt.check_tiles('field') = 40, 'field: 40 tiles checked (15 mine + 25 shop)'); end $$;
select neo_ovt.login('tech');
do $$ begin perform neo_ovt.assert(neo_ovt.check_tiles('tech') = 40, 'tech: 40 tiles checked'); end $$;
select neo_ovt.login('desk');
do $$ begin perform neo_ovt.assert(neo_ovt.check_tiles('desk') = 17, 'desk: 17 tiles checked (service + rma)'); end $$;
select neo_ovt.login('supply');
do $$ begin perform neo_ovt.assert(neo_ovt.check_tiles('supply') = 16, 'supply: 16 tiles checked (builds + rma)'); end $$;
select neo_ovt.login('sales');
do $$ begin perform neo_ovt.assert(neo_ovt.check_tiles('sales') = 7, 'sales: 7 tiles checked'); end $$;
select neo_ovt.login('basic');
do $$ begin perform neo_ovt.assert(neo_ovt.check_tiles('basic') = 0, 'basic: no tiles'); end $$;
select neo_ovt.login('legacy');
do $$ begin perform neo_ovt.assert(neo_ovt.check_tiles('legacy') = 8, 'legacy (a Builds role, no pool): the builds row only'); end $$;


-- ── 7. The lists: scopes, states, kinds, order, refusals ────────────────────
select neo_ovt.login('field');
do $$
declare l jsonb;
begin
  l := public.neo_overview_list('build', 'mine', 'any');
  perform neo_ovt.assert(neo_ovt.ids(l) = array['t_ovt_b1', 't_ovt_b10'],
                         'scope mine: the builds I hold (not the one offered to me): ' || neo_ovt.ids(l)::text);
  l := public.neo_overview_list('builds', 'mine', 'offered');
  perform neo_ovt.assert(neo_ovt.ids(l) = array['t_ovt_b7'] and neo_ovt.item(l, 't_ovt_b7') ->> 'why' like 'Offered to you — accept by %',
                         'scope mine + offered: the builds offered to me ("builds" = "build"): ' || neo_ovt.ids(l)::text);
  l := public.neo_overview_list('service', 'mine', 'overdue');
  perform neo_ovt.assert(neo_ovt.ids(l) = array['s_ovt_s2', 's_ovt_s6'], 'my overdue service tickets: ' || neo_ovt.ids(l)::text);
  l := public.neo_overview_list('rma', 'mine', 'any');
  perform neo_ovt.assert(neo_ovt.ids(l) = array['rc_ovt_r1'] and neo_ovt.keys(l) = 'items,total,truncated'
                         and neo_ovt.keys(neo_ovt.item(l, 'rc_ovt_r1'))
                             = 'code,due,id,kind,late,overdue,sales_stage,since,stage,stage_label,tech_email,tech_name,title,why',
                         'my RMA parts, and the item keys: ' || l::text);
  l := public.neo_overview_list(' BUILD ', null, null);
  perform neo_ovt.assert((l ->> 'total')::int = (public.neo_overview() #>> '{builds,open}')::int,
                         'null scope / state read as all / any; the kind is trimmed and case-blind');
end $$;

select neo_ovt.login('head');
do $$
declare l jsonb; r jsonb := neo_ovt.get('head_counts')::jsonb;
begin
  l := public.neo_overview_list('all', 'all', 'overdue');
  perform neo_ovt.assert((l ->> 'total')::int = (r #>> '{builds,overdue}')::int + (r #>> '{service,overdue}')::int + (r #>> '{rma,overdue}')::int
                         and neo_ovt.ids(l) @> array['t_ovt_b1', 't_ovt_b4', 's_ovt_s2', 's_ovt_s5', 's_ovt_s6', 'rc_ovt_r1'],
                         'kind all: every kind the caller sees: ' || neo_ovt.ids(l)::text);
  l := public.neo_overview_list('build', 'all', 'any');
  perform neo_ovt.assert(coalesce((select max(e.n) filter (where (e.value ->> 'overdue')::boolean)
                                     < min(e.n) filter (where not (e.value ->> 'overdue')::boolean)
                                     from jsonb_array_elements(l -> 'items') with ordinality e(value, n)), true)
                         and (select e.n from jsonb_array_elements(l -> 'items') with ordinality e(value, n) where e.value ->> 'id' = 't_ovt_b3')
                             < (select e.n from jsonb_array_elements(l -> 'items') with ordinality e(value, n) where e.value ->> 'id' = 't_ovt_b7'),
                         'order: overdue, then late, then the rest by due time');
  l := public.neo_overview_list('build', 'all', 'stage:waiting_qc');
  perform neo_ovt.assert(neo_ovt.ids(l) = array['t_ovt_b6'], 'stage:<status> lists that build status: ' || neo_ovt.ids(l)::text);
  l := public.neo_overview_list('service', 'all', 'stage:diagnosing');
  perform neo_ovt.assert(neo_ovt.ids(l) @> array['s_ovt_s1'] and not neo_ovt.ids(l) @> array['s_ovt_s3'],
                         'stage:<stage> lists that service stage: ' || neo_ovt.ids(l)::text);
  l := public.neo_overview_list('build', 'all', 'assigned');
  perform neo_ovt.assert(neo_ovt.ids(l) @> array['t_ovt_b1', 't_ovt_b2', 't_ovt_b6', 't_ovt_b10']
                         and not neo_ovt.ids(l) && array['t_ovt_b3', 't_ovt_b5', 't_ovt_b7']
                         and neo_ovt.item(l, 't_ovt_b6') ->> 'tech_email' = neo_ovt.email('legacy'),
                         'assigned: by email or by name (grouped by tech_email): ' || neo_ovt.ids(l)::text);
  l := public.neo_overview_list('build', 'sales', 'any');
  perform neo_ovt.assert(l -> 'items' = '[]'::jsonb and (l ->> 'total')::int = 0, 'scope sales: only builds I sold (the head sold none)');
  -- refusals: a sentence, never a crash
  perform neo_ovt.expect_error('select public.neo_overview_list(''car'', ''all'', ''any'')', 'NEO_GATE: Pick builds, service or RMA for this list.');
  perform neo_ovt.expect_error('select public.neo_overview_list(null, ''all'', ''any'')', 'NEO_GATE: Pick builds, service or RMA for this list.');
  perform neo_ovt.expect_error('select public.neo_overview_list(''build'', ''everyone'', ''any'')', 'NEO_GATE: Pick all, mine or sales for this list.');
  perform neo_ovt.expect_error('select public.neo_overview_list(''build'', ''all'', ''soon'')', 'NEO_GATE: That filter is not one the list knows.');
  perform neo_ovt.expect_error('select public.neo_overview_list(''build'', ''all'', ''stage:Bad Stage!'')', 'NEO_GATE: That stage is not one the list knows.');
  perform neo_ovt.expect_error('select public.neo_overview_list(''build'', ''all'', ''stage:'')', 'NEO_GATE: That stage is not one the list knows.');
  perform neo_ovt.expect_error('select public.neo_overview_list(''service'', ''sales'', ''any'')', 'NEO_GATE: The sales list shows builds only.');
  perform neo_ovt.expect_error('select public.neo_overview_list(''rma'', ''sales'', ''late'')', 'NEO_GATE: The sales list shows builds only.');
end $$;

select neo_ovt.login('sales');
do $$
declare l jsonb;
begin
  l := public.neo_overview_list('build', 'sales', 'any');
  perform neo_ovt.assert(neo_ovt.ids(l) = array['t_ovt_b1', 't_ovt_b5', 't_ovt_b6']
                         and neo_ovt.item(l, 't_ovt_b5') ->> 'sales_stage' = 'ready_to_build', 'sales: my customers'' builds: ' || l::text);
  l := public.neo_overview_list('all', 'sales', 'stage:qc');
  perform neo_ovt.assert(neo_ovt.ids(l) = array['t_ovt_b6'], 'sales stage:qc (kind all = builds here): ' || neo_ovt.ids(l)::text);
  perform neo_ovt.expect_error('select public.neo_overview_list(''build'', ''all'', ''any'')', 'NEO_GATE: You can''t see this list.');
  perform neo_ovt.expect_error('select public.neo_overview_list(''all'', ''all'', ''late'')', 'NEO_GATE: You can''t see this list.');
end $$;

select neo_ovt.login('desk');
do $$
begin
  perform neo_ovt.expect_error('select public.neo_overview_list(''build'', ''all'', ''any'')', 'NEO_GATE: You can''t see this list.');
  perform neo_ovt.assert((public.neo_overview_list('build', 'mine', 'any') ->> 'total')::int = 0
                         and (public.neo_overview_list('all', 'all', 'any') ->> 'total')::int
                             = (public.neo_overview() #>> '{service,open}')::int + (public.neo_overview() #>> '{rma,open}')::int,
                         'the desk: their own (none) is fine; kind all = service + rma');
end $$;

-- More than 300 items: the list stops at 300 and says so; the count is the total.
reset role;
select neo_ovt.no_jwt();
do $$
begin
  perform set_config('neo.migrating', '1', true);
  insert into public.tickets (id, type, customer_name, status, queued_at, specs, created_at, updated_at)
  select 't_ovt_q' || lpad(g::text, 3, '0'), 'build', 'Zq Ov Queue ' || g, 'awaiting', now() - interval '1 hour', '{}'::jsonb,
         now() - interval '1 day', now()
    from generate_series(1, 301) as g;
  perform set_config('neo.migrating', '', true);
end $$;
select neo_ovt.login('head');
do $$
declare l jsonb := public.neo_overview_list('build', 'all', 'in_queue'); r jsonb := public.neo_overview();
begin
  perform neo_ovt.assert(jsonb_array_length(l -> 'items') = 300 and (l ->> 'truncated')::boolean
                         and (l ->> 'total')::int = (r #>> '{builds,in_queue}')::int and (l ->> 'total')::int > 300,
                         format('at most 300 items, truncated, total = the tile (%s / %s / %s)', jsonb_array_length(l -> 'items'),
                                l ->> 'total', r #>> '{builds,in_queue}'));
end $$;


-- ── 8. The HR block (NeoHR leads): D10, the waiting counts, today's checks ──
-- Before: each approver's numbers (live data may already count).
select neo_ovt.login('hr');
do $$ begin perform neo_ovt.put('hr0_hr', (public.neo_overview() -> 'hr')::text); end $$;
select neo_ovt.login('head');
do $$ begin perform neo_ovt.put('hr0_head', (public.neo_overview() -> 'hr')::text); end $$;
select neo_ovt.login('boss');
do $$ begin perform neo_ovt.put('hr0_boss', (public.neo_overview() -> 'hr')::text); end $$;
select neo_ovt.login('boss2');
do $$ begin perform neo_ovt.put('hr0_boss2', (public.neo_overview() -> 'hr')::text); end $$;

-- Today's punches, selfies, views, requests and trips (as the owner).
--   at   = half an hour ago (not before today's midnight)
--   e1   field in       ok                      selfie            → checked
--   e2   field out      ok, no selfie (camera)                    → unverified (selfie skipped)
--   e3   desk in        ok, at the shop         selfie, opened    → checked, seen
--   e4   supply in      ok, away (not field)    selfie            → unverified; away request q1
--   e5   sales in       weak fix                selfie            → unverified
--   e6   basic in       ok, at the shop         no selfie         → unverified when older than 10 min
--   e7   legacy in      ok, flags new_login     selfie            → unverified; reason q2
--   e8   tech in        ok, place unknown (field) selfie late     → unverified
--   e9   home in        ok, away, WFH today     selfie            → checked (WFH)
--   e10  hr in          mock                    selfie            → unverified (not for hr: their own)
--   e11  boss in        mock                    selfie            → unverified (tier 4: only for tier 4+, not boss)
--   e12  sales in       mock, VOIDED                              → never counted
--   e13  basic break    mock                                      → never counted (not a punch in / out)
reset role;
select neo_ovt.no_jwt();
do $$
declare
  v_at timestamptz := greatest(neo_ovt.get('lo')::timestamptz, now() - interval '30 minutes');
  e uuid;
begin
  perform neo_ovt.put('at', v_at::text);
  perform neo_ovt.put('late_from', public._hr_at(public._hr_today(), '09:41')::text);
  perform neo_ovt.put('staff_n', (select count(*) from public.profiles where active and coalesce(is_staff, false))::text);
  e := neo_ovt.ev('field', 'punch_in', v_at, 'ok', 'away');                       perform neo_ovt.selfie(e); perform neo_ovt.put('e1', e::text);
  e := neo_ovt.ev('field', 'punch_out', v_at + interval '5 minutes', 'ok', 'away', '{}', 'camera_error');
  e := neo_ovt.ev('desk', 'punch_in', v_at, 'ok', 'office');                      perform neo_ovt.selfie(e);
  insert into public.hr_selfie_views (viewer_email, event_id, at) values (neo_ovt.email('boss2'), e, now());
  e := neo_ovt.ev('supply', 'punch_in', v_at, 'ok', 'away');                      perform neo_ovt.selfie(e); perform neo_ovt.put('e4', e::text);
  e := neo_ovt.ev('sales', 'punch_in', v_at, 'weak_fix', 'office');               perform neo_ovt.selfie(e); perform neo_ovt.put('e5', e::text);
  e := neo_ovt.ev('basic', 'punch_in', v_at, 'ok', 'office');
  e := neo_ovt.ev('legacy', 'punch_in', v_at, 'ok', 'office', '{new_login}');     perform neo_ovt.selfie(e); perform neo_ovt.put('e7', e::text);
  e := neo_ovt.ev('tech', 'punch_in', v_at, 'ok', 'unknown');                     perform neo_ovt.selfie(e, true);
  e := neo_ovt.ev('home', 'punch_in', v_at, 'ok', 'away');                        perform neo_ovt.selfie(e);
  e := neo_ovt.ev('hr', 'punch_in', v_at, 'mock', 'unknown');                     perform neo_ovt.selfie(e); perform neo_ovt.put('e10', e::text);
  e := neo_ovt.ev('boss', 'punch_in', v_at, 'mock', 'unknown');                   perform neo_ovt.selfie(e); perform neo_ovt.put('e11', e::text);
  e := neo_ovt.ev('sales', 'punch_in', v_at + interval '1 minute', 'mock', 'unknown', '{}', null, true);
  e := neo_ovt.ev('basic', 'break_start', v_at + interval '1 minute', 'mock', 'unknown');

  -- requests: q1 away (supply, past its time), q2 reason (legacy), q3 a v2.3 late start (tech), q4 away (boss,
  -- tier 4), q5 a reason already approved (sales), q6 away (hr, past), q7 reason (field, past)
  insert into public.hr_requests (profile_id, employee_email, kind, date_from, date_to, reason, status, event_id, due_at,
                                  decided_by_email, decided_by_name, decided_at)
  values (neo_ovt.uid('supply'), neo_ovt.email('supply'), 'away_punch', public._hr_today(), public._hr_today(), 'Zq at the bank',
          'pending', neo_ovt.get('e4')::uuid, now() - interval '1 hour', null, null, null),
         (neo_ovt.uid('legacy'), neo_ovt.email('legacy'), 'punch_reason', public._hr_today(), public._hr_today(), 'Zq traffic',
          'pending', neo_ovt.get('e7')::uuid, now() + interval '2 hours', null, null, null),
         (neo_ovt.uid('tech'), neo_ovt.email('tech'), 'late_start', public._hr_today() + 1, public._hr_today() + 1, 'Zq doctor',
          'pending', null, null, null, null, null),
         (neo_ovt.uid('boss'), neo_ovt.email('boss'), 'away_punch', public._hr_today(), public._hr_today(), 'Zq client meeting',
          'pending', neo_ovt.get('e11')::uuid, now() + interval '1 hour', null, null, null),
         (neo_ovt.uid('sales'), neo_ovt.email('sales'), 'punch_reason', public._hr_today(), public._hr_today(), 'Zq bus late',
          'approved', neo_ovt.get('e5')::uuid, now() - interval '1 hour', neo_ovt.email('boss2'), 'Zqovbosstwo Two', now()),
         (neo_ovt.uid('hr'), neo_ovt.email('hr'), 'away_punch', public._hr_today(), public._hr_today(), 'Zq office supplies',
          'pending', neo_ovt.get('e10')::uuid, now() - interval '2 hours', null, null, null),
         (neo_ovt.uid('field'), neo_ovt.email('field'), 'punch_reason', public._hr_today(), public._hr_today(), 'Zq flat tyre',
          'pending', neo_ovt.get('e1')::uuid, now() - interval '3 hours', null, null, null);

  -- trips: tech's is open (inside the open session); legacy's ended; sales' began before the session;
  -- field punched out after starting one; desk's is voided
  insert into public.hr_trips (id, profile_id, employee_email, kind, note, started_at, start_source, ended_at, end_source, end_reason,
                               voided_at, voided_by, void_reason)
  values (gen_random_uuid(), neo_ovt.uid('tech'), neo_ovt.email('tech'), 'on_site', 'Zq open trip', v_at + interval '1 minute', 'phone',
          null, null, null, null, null, null),
         (gen_random_uuid(), neo_ovt.uid('legacy'), neo_ovt.email('legacy'), 'on_site', 'Zq ended trip', v_at + interval '1 minute', 'phone',
          v_at + interval '2 minutes', 'phone', 'tapped', null, null, null),
         (gen_random_uuid(), neo_ovt.uid('sales'), neo_ovt.email('sales'), 'rma', 'Zq old trip', v_at - interval '1 hour', 'phone',
          null, null, null, null, null, null),
         (gen_random_uuid(), neo_ovt.uid('field'), neo_ovt.email('field'), 'on_site', 'Zq trip before punch out', v_at + interval '1 minute', 'phone',
          null, null, null, null, null, null),
         (gen_random_uuid(), neo_ovt.uid('desk'), neo_ovt.email('desk'), 'on_site', 'Zq voided trip', v_at + interval '1 minute', 'phone',
          null, null, null, now(), 'tests', 'Zq test void');
end $$;

-- After: the differences each approver sees (D10: nobody counts their own; a
-- tier 4+ person's only for tier 4+).
create function neo_ovt.hr_delta(p_alias text, p_key text) returns int language plpgsql volatile as $$
begin
  return ((public.neo_overview() -> 'hr' ->> p_key)::int) - ((neo_ovt.get('hr0_' || p_alias)::jsonb ->> p_key)::int);
end $$;
grant execute on function neo_ovt.hr_delta(text, text) to authenticated;
create function neo_ovt.hr_check(p_alias text, p_pending int, p_away int, p_reasons int, p_eod int, p_unverified int,
                                 p_unseen int, p_trip int) returns void language plpgsql volatile as $$
declare
  v_old int := case when neo_ovt.get('at')::timestamptz < now() - interval '10 minutes' then 1 else 0 end;
  r jsonb := public.neo_overview() -> 'hr';
  b jsonb := neo_ovt.get('hr0_' || p_alias)::jsonb;
  d jsonb;
begin
  d := jsonb_build_object('pending_requests', (r ->> 'pending_requests')::int - (b ->> 'pending_requests')::int,
                          'away_pending', (r ->> 'away_pending')::int - (b ->> 'away_pending')::int,
                          'reasons_pending', (r ->> 'reasons_pending')::int - (b ->> 'reasons_pending')::int,
                          'past_eod', (r ->> 'past_eod')::int - (b ->> 'past_eod')::int,
                          'unverified_today', (r ->> 'unverified_today')::int - (b ->> 'unverified_today')::int,
                          'unseen_photos', (r ->> 'unseen_photos')::int - (b ->> 'unseen_photos')::int,
                          'on_trip', (r ->> 'on_trip')::int - (b ->> 'on_trip')::int);
  perform neo_ovt.assert(d = jsonb_build_object('pending_requests', p_pending, 'away_pending', p_away, 'reasons_pending', p_reasons,
                                                'past_eod', p_eod, 'unverified_today', p_unverified + v_old,
                                                'unseen_photos', p_unseen, 'on_trip', p_trip),
                         format('%s: the HR counts moved by %s, expected pending %s, away %s, reasons %s, past EOD %s, unverified %s, unseen %s, on trip %s',
                                p_alias, d, p_pending, p_away, p_reasons, p_eod, p_unverified + v_old, p_unseen, p_trip));
end $$;
grant execute on function neo_ovt.hr_check(text, int, int, int, int, int, int, int) to authenticated;

select neo_ovt.login('hr');       -- tier 2: not their own (q6, e10), not those of a tier 4 (q4, e11)
do $$ begin perform neo_ovt.hr_check('hr', 1, 1, 2, 2, 5, 6, 1); end $$;
select neo_ovt.login('head');     -- tier 3: those of hr too; still not those of a tier 4
do $$ begin perform neo_ovt.hr_check('head', 1, 2, 2, 3, 6, 7, 1); end $$;
select neo_ovt.login('boss');     -- tier 4: everybody but themselves
do $$ begin perform neo_ovt.hr_check('boss', 1, 2, 2, 3, 6, 7, 1); end $$;
select neo_ovt.login('boss2');    -- tier 4: boss as well
do $$ begin perform neo_ovt.hr_check('boss2', 1, 3, 2, 3, 7, 8, 1); end $$;

-- People late today (punched in at half past, after 09:40) and the statuses.
select neo_ovt.login('head');
do $$
declare
  r jsonb := public.neo_overview() -> 'hr';
  h jsonb := public.hr_dashboard() -> 'hr';
  k text;
begin
  if neo_ovt.get('at')::timestamptz >= neo_ovt.get('late_from')::timestamptz then
    perform neo_ovt.assert(neo_ovt.hr_delta('head', 'late_today') >= 1, 'late today counts people who punched in late: ' || r::text);
  end if;
  perform neo_ovt.assert((r ->> 'on_duty')::int + (r ->> 'on_break')::int + (r ->> 'on_site')::int + (r ->> 'absent')::int
                         + (r ->> 'not_in_yet')::int + coalesce((r ->> 'on_leave')::int, 0)
                         <= neo_ovt.get('staff_n')::int,
                         'one status per active staff member: ' || r::text);
  -- the same numbers as hr_dashboard().hr for every key both have (one meaning per number)
  if h ?& array['late_today', 'away_pending', 'reasons_pending', 'past_eod', 'unverified_today', 'unseen_photos', 'on_trip'] then
    for k in select jsonb_object_keys(h) loop
      if r ? k then
        perform neo_ovt.assert(r -> k = h -> k, format('hr.%s: neo_overview %s, hr_dashboard %s', k, r -> k, h -> k));
      end if;
    end loop;
  else
    for k in select x from unnest(array['on_duty', 'on_break', 'on_site', 'absent', 'not_in_yet']) as x loop
      perform neo_ovt.assert(r -> k = h -> k, format('hr.%s: neo_overview %s, hr_dashboard %s', k, r -> k, h -> k));
    end loop;
    raise notice 'hr_dashboard().hr has no v2.4 keys yet: compared the v2.3 status counts only';
  end if;
end $$;

-- Not an approver: no hr block, whatever happens today.
select neo_ovt.login('field');
do $$ begin perform neo_ovt.assert(not (public.neo_overview() ? 'hr'), 'no hr block for a non-approver'); end $$;


-- ── Done ─────────────────────────────────────────────────────────────────────
reset role;
select neo_ovt.no_jwt();
select 'neohr-hr-v2.4-overview tests: all passed' as result;

rollback;
