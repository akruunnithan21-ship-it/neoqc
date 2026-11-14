-- =============================================================================
-- build-direct-assign.tests.sql — tests for build_direct_assign_part01
-- (sql/build-direct-assign.sql)
-- -----------------------------------------------------------------------------
-- Run AFTER sql/build-direct-assign.sql, as the database owner. Everything
-- happens in one transaction that ends in ROLLBACK: nothing is left behind.
--
-- Users are simulated the way PostgREST does it (SET ROLE + request.jwt.claims),
-- as in the other test files. All six users are throw-away logins
-- (zq.bdesk.*@neotokyo.test) made here, and the builds are throw-away rows
-- (zq_bd_*), so no real person or build changes an answer.
--
-- A failed assertion raises "FAIL: …" and aborts. Success ends with the row
--   result = 'build-direct-assign tests: all passed'
-- just before the rollback.
-- =============================================================================

begin;

-- ── 0. Scaffolding (as the owner) ────────────────────────────────────────────
create schema neo_bdt;
grant usage on schema neo_bdt to anon, authenticated;
create table neo_bdt.users (alias text primary key, id uuid not null, email text not null);
grant select on neo_bdt.users to anon, authenticated;

create function neo_bdt.login(p_alias text) returns void language plpgsql as $$
declare u neo_bdt.users;
begin
  select * into u from neo_bdt.users where alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', u.id::text, true);
  perform set_config('request.jwt.claim.email', u.email, true);
  perform set_config('request.jwt.claims',
                     jsonb_build_object('sub', u.id, 'email', u.email, 'role', 'authenticated')::text, true);
end $$;
create function neo_bdt.no_jwt() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.email', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
create function neo_bdt.assert(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_msg; end if;
end $$;
create function neo_bdt.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
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
create function neo_bdt.em(p_alias text) returns text language sql stable as $$
  select email from neo_bdt.users where alias = p_alias
$$;
grant execute on all functions in schema neo_bdt to anon, authenticated;


-- ── 1. Test users, roles, pools and builds ───────────────────────────────────
do $$
begin
  if exists (select 1 from auth.users where lower(email) like 'zq.bdesk.%@neotokyo.test') then
    raise exception 'TEST SETUP: zq.bdesk.*@neotokyo.test logins already exist; change the test emails in this file';
  end if;
  if exists (select 1 from public.tickets where id like 'zq_bd_%') then
    raise exception 'TEST SETUP: zq_bd_* builds already exist; change the test ids in this file';
  end if;
end $$;

insert into auth.users (id, email, raw_user_meta_data)
select x.id::uuid, x.email, jsonb_build_object('full_name', x.name)
  from (values ('e5555555-0000-4000-8000-000000000001', 'zq.bdesk.desk@neotokyo.test',   'Zqbd Desk'),
               ('e5555555-0000-4000-8000-000000000002', 'zq.bdesk.plain@neotokyo.test',  'Zqbd Plain'),
               ('e5555555-0000-4000-8000-000000000003', 'zq.bdesk.jr@neotokyo.test',     'Zqbdjunior Tech'),
               ('e5555555-0000-4000-8000-000000000004', 'zq.bdesk.sr@neotokyo.test',     'Zqbdsenior Tech'),
               ('e5555555-0000-4000-8000-000000000005', 'zq.bdesk.nopool@neotokyo.test', 'Zqbdnopool Tech'),
               ('e5555555-0000-4000-8000-000000000006', 'zq.bdesk.lead@neotokyo.test',   'Zqbd Lead')) as x(id, email, name);
update public.profiles p
   set full_name = u.raw_user_meta_data ->> 'full_name', active = true, is_staff = true, created_at = '2020-01-01', tier = 2
  from auth.users u
 where u.id = p.id and p.email like 'zq.bdesk.%@neotokyo.test';
insert into neo_bdt.users (alias, id, email)
select replace(split_part(p.email, '@', 1), 'zq.bdesk.', ''), p.id, lower(p.email)
  from public.profiles p where p.email like 'zq.bdesk.%@neotokyo.test';
select neo_bdt.assert((select count(*) from neo_bdt.users) = 6, 'setup: all six profiles exist');

delete from public.module_access where profile_id in (select id from neo_bdt.users);
insert into public.module_access (profile_id, module, role, granted_by)
select u.id, m.module, m.role, 'tests'
  from neo_bdt.users u
  join (values ('desk', 'qc', 'desk'), ('plain', 'service', 'desk'),
               ('jr', 'qc', 'tech'), ('sr', 'qc', 'tech'), ('nopool', 'qc', 'tech'),
               ('lead', 'qc', 'lead')) as m(alias, module, role) on m.alias = u.alias;
insert into public.staff_work (profile_id, build_pool, service_pool, build_level, updated_by)
select u.id, u.alias in ('jr', 'sr'), false,
       case u.alias when 'jr' then 'junior' when 'sr' then 'senior' end, 'tests'
  from neo_bdt.users u
on conflict (profile_id) do update
   set build_pool = excluded.build_pool, service_pool = excluded.service_pool, build_level = excluded.build_level;

-- b1 small, b2 high-value (senior only), b3 finished, b4 a 1.12.2-style
-- "waiting queue" insert, b5 and b6 small.
insert into public.tickets (id, type, customer_name, status, specs, created_at, updated_at)
values ('zq_bd_b1', 'build', 'Zq Bd Small',    'awaiting',  '{"__build":{"tier":2}}'::jsonb, now() - interval '6 hours', now() - interval '6 hours'),
       ('zq_bd_b2', 'build', 'Zq Bd Senior',   'awaiting',  '{"__build":{"tier":4}}'::jsonb, now() - interval '6 hours', now() - interval '6 hours'),
       ('zq_bd_b3', 'build', 'Zq Bd Finished', 'completed', '{"__build":{"tier":1}}'::jsonb, now() - interval '6 hours', now() - interval '6 hours'),
       ('zq_bd_b4', 'build', 'Zq Bd Old Queue','awaiting',  '{"__build":{"tier":1},"__queued":true}'::jsonb, now(), now()),
       ('zq_bd_b5', 'build', 'Zq Bd Five',     'awaiting',  '{"__build":{"tier":1}}'::jsonb, now() - interval '6 hours', now() - interval '6 hours'),
       ('zq_bd_b6', 'build', 'Zq Bd Six',      'awaiting',  '{"__build":{"tier":1}}'::jsonb, now() - interval '6 hours', now() - interval '6 hours');


-- ── 2. The migration's own state ─────────────────────────────────────────────
select neo_bdt.assert(exists (select 1 from pg_trigger
                               where tgrelid = 'public.tickets'::regclass and tgname = 'trg_tickets_work_zz_direct'
                                 and not tgisinternal and tgenabled <> 'D'),
                      'M1: the no-queue trigger exists and is enabled');
select neo_bdt.assert('trg_tickets_work_guard' < 'trg_tickets_work_zz_direct'
                      and not exists (select 1 from pg_trigger
                                       where tgrelid = 'public.tickets'::regclass and not tgisinternal
                                         and (tgtype & 2) = 2            -- BEFORE
                                         and tgname > 'trg_tickets_work_zz_direct'),
                      'M2: no BEFORE trigger on tickets fires after the no-queue trigger');
select neo_bdt.assert(not has_function_privilege('authenticated', 'public.tg_tickets_work_zz_direct()', 'execute')
                      and not has_function_privilege('anon', 'public.tg_tickets_work_zz_direct()', 'execute'),
                      'M3: clients cannot call the trigger function');
select neo_bdt.assert(has_function_privilege('authenticated', 'public.build_assign(text, text, text, text)', 'execute')
                      and has_function_privilege('authenticated', 'public.build_tech_list()', 'execute')
                      and not has_function_privilege('anon', 'public.build_assign(text, text, text, text)', 'execute')
                      and not has_function_privilege('anon', 'public.build_tech_list()', 'execute'),
                      'M4: signed-in staff can call build_assign / build_tech_list; anon cannot');
select neo_bdt.assert(not exists (select 1 from public.tickets where queued_at is not null or offered_to_email is not null),
                      'M5: no build is queued or offered');
select neo_bdt.assert(not exists (select 1 from public.work_alerts where item_kind = 'build' and resolved_at is null),
                      'M6: no open build alerts');
select neo_bdt.assert((select count(*) from pg_constraint
                        where conrelid = 'public.work_events'::regclass and contype = 'c'
                          and pg_get_constraintdef(oid) ~ 'no_candidate') = 1
                      and (select pg_get_constraintdef(oid) from pg_constraint
                            where conrelid = 'public.work_events'::regclass and conname = 'work_events_kind_check') ~ '''assign''',
                      'M7: one kind check on work_events, and it allows assign');


-- ── 3. No queue, whatever writes the row ─────────────────────────────────────
select neo_bdt.assert((select queued_at is null from public.tickets where id = 'zq_bd_b4'),
                      'Q1: an old desktop''s "waiting queue" insert is not queued');
select neo_bdt.assert(not exists (select 1 from public.work_events where item_kind = 'build' and item_id = 'zq_bd_b4'),
                      'Q1b: and no "queued" history line is written');
do $$
declare v_prev text;
begin
  v_prev := public._flag_set('neo.assign');
  update public.tickets set queued_at = now() where id = 'zq_bd_b5';
  perform public._flag_restore('neo.assign', v_prev);
end $$;
select neo_bdt.assert((select queued_at is null from public.tickets where id = 'zq_bd_b5'),
                      'Q2: a server write of queued_at is cleared');

select neo_bdt.login('desk');
do $$
declare r jsonb;
begin
  r := public.build_queue_send('zq_bd_b5');
  perform neo_bdt.assert(r ->> 'ok' = 'false' and r ->> 'reason' = 'no_queue' and coalesce(r ->> 'message', '') like '%Builds desk%',
                         'Q3: build_queue_send answers no_queue with a message, got ' || r::text);
end $$;
reset role; select neo_bdt.no_jwt();
select neo_bdt.assert((select queued_at is null from public.tickets where id = 'zq_bd_b5')
                      and not exists (select 1 from public.work_events where item_kind = 'build' and item_id = 'zq_bd_b5'),
                      'Q3b: build_queue_send writes nothing');


-- ── 4. Who may assign ────────────────────────────────────────────────────────
select neo_bdt.login('plain');
select neo_bdt.expect_error($q$select public.build_tech_list()$q$, 'NEO_DENIED: Only the Builds desk%');
select neo_bdt.expect_error($q$select public.build_assign('zq_bd_b1', neo_bdt.em('jr'))$q$, 'NEO_DENIED: Only the Builds desk%');
select neo_bdt.login('jr');
select neo_bdt.expect_error($q$select public.build_assign('zq_bd_b1', neo_bdt.em('jr'))$q$, 'NEO_DENIED: Only the Builds desk%');
select neo_bdt.expect_error($q$select public.build_tech_list()$q$, 'NEO_DENIED: Only the Builds desk%');
reset role; select neo_bdt.no_jwt();
select neo_bdt.assert((select technician_email is null from public.tickets where id = 'zq_bd_b1'),
                      'D1: a technician cannot assign a build, not even to themselves');

select neo_bdt.login('desk');
do $$
declare r jsonb; v_people jsonb;
begin
  r := public.build_tech_list();
  v_people := r -> 'people';
  perform neo_bdt.assert(exists (select 1 from jsonb_array_elements(v_people) e
                                  where e ->> 'email' = neo_bdt.em('jr') and (e ->> 'build_pool')::boolean
                                    and e ->> 'qc_role' = 'tech' and e ->> 'build_level' = 'junior' and e ? 'points' and e ? 'builds'),
                         'L1: the list has the junior technician with role, level and load');
  perform neo_bdt.assert(exists (select 1 from jsonb_array_elements(v_people) e
                                  where e ->> 'email' = neo_bdt.em('sr') and e ->> 'build_level' = 'senior'),
                         'L2: the list has the senior technician');
  perform neo_bdt.assert(not exists (select 1 from jsonb_array_elements(v_people) e where e ->> 'email' = neo_bdt.em('nopool')),
                         'L3: someone outside the build pool, holding no builds, is not listed');
  perform neo_bdt.assert(not (r -> 'people' -> 0 ? 'last_seen_at') and not (r -> 'people' -> 0 ? 'logs_today'),
                         'L4: no NeoHR data in the list');
end $$;


-- ── 5. Assigning ─────────────────────────────────────────────────────────────
do $$
declare r jsonb;
begin
  r := public.build_assign('zq_bd_b1', neo_bdt.em('jr'), null, null);
  perform neo_bdt.assert(r ->> 'ok' = 'true' and not (r ? 'unchanged') and r ? 'item', 'A1: the desk assigns a build, got ' || r::text);
  r := public.build_assign('zq_bd_b1', upper(neo_bdt.em('jr')), null, neo_bdt.em('jr'));
  perform neo_bdt.assert(r ->> 'ok' = 'true' and (r ->> 'unchanged')::boolean, 'A2: the same person again is unchanged');
  r := public.build_assign('zq_bd_b1', neo_bdt.em('sr'), 'They are free', '');
  perform neo_bdt.assert(r ->> 'ok' = 'false' and r ->> 'reason' = 'changed' and r ->> 'by_email' = neo_bdt.em('jr'),
                         'A3: a stale screen gets "changed", got ' || r::text);
end $$;
select neo_bdt.expect_error($q$select public.build_assign('zq_bd_b1', neo_bdt.em('sr'), '  ', neo_bdt.em('jr'))$q$,
                            'NEO_GATE: Say why you''re moving it from Zqbdjunior.');
select neo_bdt.expect_error($q$select public.build_assign('zq_bd_b2', neo_bdt.em('jr'))$q$, 'NEO_GATE: Zqbdjunior Tech can''t take this — %senior%');
select neo_bdt.expect_error($q$select public.build_assign('zq_bd_b2', neo_bdt.em('nopool'))$q$, 'NEO_GATE: Zqbdnopool Tech can''t take this — %build pool%');
select neo_bdt.expect_error($q$select public.build_assign('zq_bd_b2', 'nobody.here@neotokyo.test')$q$, 'NEO_GATE: No active staff account%');
select neo_bdt.expect_error($q$select public.build_assign('zq_bd_b3', neo_bdt.em('jr'))$q$, 'NEO_GATE: This build is finished.');
select neo_bdt.expect_error($q$select public.build_assign('zq_bd_b2', '  ')$q$, 'NEO_GATE: Choose who builds it.');
select neo_bdt.expect_error($q$select public.build_assign('zq_bd_nope', neo_bdt.em('jr'))$q$, 'NEO_GATE: That build no longer exists.');
select neo_bdt.expect_error($q$select public.build_assign('zq_bd_b2', neo_bdt.em('sr'), repeat('x', 301))$q$, 'NEO_GATE: The reason is too long%');
do $$
declare r jsonb;
begin
  r := public.build_assign('zq_bd_b1', neo_bdt.em('sr'), 'Junior is out today', neo_bdt.em('jr'));
  perform neo_bdt.assert(r ->> 'ok' = 'true', 'A4: moving with a reason works, got ' || r::text);
  r := public.build_assign('zq_bd_b2', neo_bdt.em('sr'), null, null);
  perform neo_bdt.assert(r ->> 'ok' = 'true', 'A5: a high-value build goes to the senior builder, got ' || r::text);
end $$;
reset role; select neo_bdt.no_jwt();
select neo_bdt.assert((select technician_email = neo_bdt.em('sr') and technician = 'Zqbdsenior' and assigned_via = 'manager'
                              and assigned_at is not null and assign_reason = 'Junior is out today' and queued_at is null
                         from public.tickets where id = 'zq_bd_b1'),
                      'A6: the build row carries the new technician, by the desk, with the reason');
select neo_bdt.assert((select array_agg(kind order by id) = array['assign', 'reassigned']
                         from public.work_events where item_kind = 'build' and item_id = 'zq_bd_b1'),
                      'A7: history: assign, then reassigned');
select neo_bdt.assert((select body = 'Moved from Zqbdjunior to Zqbdsenior Tech by Zqbd Desk: Junior is out today'
                         from public.work_events where item_kind = 'build' and item_id = 'zq_bd_b1' and kind = 'reassigned'),
                      'A8: the move''s history line names both people and the reason');
select neo_bdt.assert((select body = 'Assigned to Zqbdsenior Tech by Zqbd Desk.'
                         from public.work_events where item_kind = 'build' and item_id = 'zq_bd_b2'),
                      'A9: a first assignment''s history line');

select neo_bdt.login('lead');
do $$
declare r jsonb;
begin
  r := public.build_assign('zq_bd_b6', neo_bdt.em('jr'), null, null);
  perform neo_bdt.assert(r ->> 'ok' = 'true', 'A10: a QC lead assigns too, got ' || r::text);
end $$;
reset role; select neo_bdt.no_jwt();


-- ── 6. No claims, no offers ──────────────────────────────────────────────────
select neo_bdt.login('jr');
do $$
declare r jsonb;
begin
  r := public.work_claim('build', 'zq_bd_b5', null, null);
  perform neo_bdt.assert(r ->> 'ok' = 'false', 'C1: a technician cannot claim a build, got ' || r::text);
end $$;
reset role; select neo_bdt.no_jwt();
select neo_bdt.assert((select technician_email is null from public.tickets where id = 'zq_bd_b5'), 'C1b: the build stays with nobody');
do $$
declare v_prev text;
begin
  v_prev := public._flag_set('neo.assign');
  begin
    update public.tickets set technician = 'Zqbdjunior', technician_email = neo_bdt.em('jr'), assigned_via = 'claim', assigned_at = now()
     where id = 'zq_bd_b5';
    raise exception 'FAIL: C2: a server-side claim write was not refused';
  exception when others then
    if sqlerrm not like 'NEO_GATE: Builds aren''t claimed any more%' then raise; end if;
  end;
  perform public._flag_restore('neo.assign', v_prev);
end $$;

select neo_bdt.login('lead');
select neo_bdt.expect_error($q$select public.work_offer('build', 'zq_bd_b5', neo_bdt.em('jr'), 'Please take it', null)$q$,
                            'NEO_GATE: Builds aren''t offered any more%');
select neo_bdt.expect_error($q$select public.work_offer('build', 'zq_bd_b6', neo_bdt.em('sr'), 'Please take it', neo_bdt.em('jr'))$q$,
                            'NEO_GATE: Builds aren''t offered any more%');
reset role; select neo_bdt.no_jwt();
select neo_bdt.assert(not exists (select 1 from public.tickets where id like 'zq_bd_%' and (offered_to_email is not null or queued_at is not null)),
                      'O1: no test build is offered or queued');
select neo_bdt.assert((select technician_email = neo_bdt.em('jr') from public.tickets where id = 'zq_bd_b6'),
                      'O2: a refused offer leaves the technician as they were');


-- ── 7. Handing back: to the desk, not to a queue ─────────────────────────────
select neo_bdt.login('jr');
do $$
declare r jsonb;
begin
  r := public.work_release('build', 'zq_bd_b6', 'Parts not here yet');
  perform neo_bdt.assert(r ->> 'ok' = 'true', 'R1: the technician hands a build back, got ' || r::text);
end $$;
reset role; select neo_bdt.no_jwt();
select neo_bdt.assert((select technician is null and technician_email is null and queued_at is null
                         from public.tickets where id = 'zq_bd_b6'),
                      'R2: a handed-back build has nobody and is not queued');


-- ── 8. The Work screen: builds only under "yours" ────────────────────────────
select neo_bdt.login('sr');
do $$
declare r jsonb;
begin
  r := public.work_queue();
  perform neo_bdt.assert(exists (select 1 from jsonb_array_elements(r -> 'items') e
                                  where e ->> 'kind' = 'build' and e ->> 'id' = 'zq_bd_b1' and (e ->> 'mine')::boolean),
                         'W1: the assigned build is in the technician''s own work');
  perform neo_bdt.assert(not exists (select 1 from jsonb_array_elements(r -> 'items') e
                                      where e ->> 'kind' = 'build' and e ->> 'id' in ('zq_bd_b4', 'zq_bd_b5', 'zq_bd_b6')),
                         'W2: builds with nobody are not on the Work screen');
end $$;
reset role; select neo_bdt.no_jwt();

select 'build-direct-assign tests: all passed' as result;
rollback;
