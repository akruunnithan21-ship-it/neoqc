-- =============================================================================
-- service-v2.1.tests.sql — tests for the service_v2_1_secrets migration
-- -----------------------------------------------------------------------------
-- Run AFTER sql/service-v2.sql and sql/service-v2.1.sql, as the database owner
-- (Supabase SQL editor or psql as postgres). Everything happens inside one
-- transaction that ends in ROLLBACK: nothing is left behind.
--
-- Users are simulated the way PostgREST does it (SET ROLE + request.jwt.claims),
-- exactly as in sql/service-v2.tests.sql, with the same six real profiles and
-- the module rows they need rewritten inside the transaction.
--
-- A failed assertion raises "FAIL: …" and aborts. Success ends with the row
--   result = 'service-v2.1 tests: all passed'
-- just before the rollback. Phone numbers 90000002xx are used for the test
-- customers; the test passwords are 'Zq-test-PIN 4471' and ' Zq-second-9902 ' (with its spaces: stored exactly as typed).
-- =============================================================================

begin;

-- ── 0. Scaffolding (as the owner) ────────────────────────────────────────────
create schema neo_test;
grant usage on schema neo_test to anon, authenticated;

create table neo_test.users (alias text primary key, id uuid not null, email text not null, tier int not null, name text);
create table neo_test.ctx (k text primary key, v text);
grant select on neo_test.users to anon, authenticated;
grant select, insert, update, delete on neo_test.ctx to anon, authenticated;

create function neo_test.put(p_k text, p_v text) returns void language plpgsql as $$
begin
  insert into neo_test.ctx (k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v;
end $$;

-- VOLATILE on purpose (see service-v2.tests.sql): a STABLE call in a WHERE is
-- evaluated under the snapshot the DO block started with.
create function neo_test.get(p_k text) returns text language plpgsql volatile as $$
declare v text;
begin
  select c.v into v from neo_test.ctx c where c.k = p_k;
  if not found or v is null then raise exception 'TEST BUG: nothing stored under "%"', p_k; end if;
  return v;
end $$;

create function neo_test.login(p_alias text) returns void language plpgsql as $$
declare u neo_test.users;
begin
  select * into u from neo_test.users where alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', u.id::text, true);
  perform set_config('request.jwt.claim.email', u.email, true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', u.id, 'email', u.email, 'role', 'authenticated')::text, true);
end $$;

create function neo_test.login_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.email', '', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
end $$;

create function neo_test.assert(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_msg; end if;
end $$;

create function neo_test.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
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

-- As the owner: is there a password row / what is the flag / how many lines
-- with this body. (The tests run as other roles, which cannot read the secret
-- table at all — that is the point — so these are SECURITY DEFINER.)
create function neo_test.secret_of(p_job text) returns text language sql volatile security definer as $$
  select secret from public.service_secrets where job_id = p_job
$$;
create function neo_test.flag_of(p_job text) returns boolean language sql volatile security definer as $$
  select has_device_password from public.service_jobs where id = p_job
$$;
create function neo_test.lines(p_job text, p_body text) returns bigint language sql volatile security definer as $$
  select count(*) from public.service_events
   where job_id = p_job and kind = 'edit' and not customer_visible and body = p_body
$$;
create function neo_test.leaks(p_job text, p_secret text) returns bigint language sql volatile security definer as $$
  select count(*) from public.service_events
   where job_id = p_job and (coalesce(body, '') like '%' || p_secret || '%' or meta::text like '%' || p_secret || '%')
$$;
create function neo_test.jstage(p_job text) returns text language sql volatile security definer as $$
  select stage from public.service_jobs where id = p_job
$$;

grant execute on all functions in schema neo_test to anon, authenticated;

-- ── 1. Test users and their module rows ─────────────────────────────────────
insert into neo_test.users (alias, id, email, tier, name)
select a.alias, p.id, p.email, p.tier, p.full_name
  from (values ('owner', 'ananthakrishnan@neotokyo.in'),
               ('desk',  'anagha.kc@neotokyo.in'),
               ('tech1', 'athul.sudheer@neotokyo.in'),
               ('tech2', 'adhil.m@neotokyo.in'),
               ('sales', 'kiran.raj@neotokyo.in'),
               ('plain', 'arathy.shibu@neotokyo.in')) as a(alias, email)
  join public.profiles p on lower(p.email) = a.email;

do $$
declare v_missing text;
begin
  select string_agg(a.email, ', ') into v_missing
    from (values ('owner', 'ananthakrishnan@neotokyo.in'), ('desk', 'anagha.kc@neotokyo.in'),
                 ('tech1', 'athul.sudheer@neotokyo.in'), ('tech2', 'adhil.m@neotokyo.in'),
                 ('sales', 'kiran.raj@neotokyo.in'), ('plain', 'arathy.shibu@neotokyo.in')) as a(alias, email)
   where not exists (select 1 from neo_test.users u where u.alias = a.alias);
  if v_missing is not null then raise exception 'TEST SETUP: no profile for %', v_missing; end if;
  if exists (select 1 from neo_test.users u join public.profiles p on p.id = u.id
              where not p.active or not coalesce(p.is_staff, false)) then
    raise exception 'TEST SETUP: every test user must be an active staff profile';
  end if;
  if (select tier from neo_test.users where alias = 'sales') <> 1 then
    raise exception 'TEST SETUP: the sales user must be tier 1';
  end if;
  if exists (select 1 from neo_test.users where alias in ('desk', 'tech1', 'tech2', 'plain') and tier >= 3) then
    raise exception 'TEST SETUP: desk, tech and plain users must be below tier 3 (tier 3+ are leads automatically)';
  end if;
  if exists (select 1 from public.service_jobs where public.norm_phone(customer_phone) like '9190000002__')
     or exists (select 1 from public.customers where phone_norm like '9190000002__')
     or exists (select 1 from public.service_jobs where id in ('s_test_v21_0001', 's_test_v21_0002')
                                                     or public_code in ('NT-TESTV21A', 'NT-TESTV21B')) then
    raise exception 'TEST SETUP: test phones / ids are already in use; change the test values in this file';
  end if;
end $$;

delete from public.module_access
 where profile_id in (select id from neo_test.users where alias in ('desk', 'tech1', 'tech2', 'sales', 'plain'));
insert into public.module_access (profile_id, module, role, granted_by)
select u.id, m.module, m.role, 'tests'
  from neo_test.users u
  join (values ('desk', 'service', 'desk'), ('desk', 'rma', 'desk'),
               ('tech1', 'service', 'tech'), ('tech1', 'rma', 'tech'),
               ('tech2', 'service', 'tech'), ('tech2', 'rma', 'tech')) as m(alias, module, role)
    on m.alias = u.alias;

-- Schema facts (as the owner).
do $$
begin
  perform neo_test.assert((select relrowsecurity from pg_class where oid = 'public.service_secrets'::regclass),
                          'service_secrets has RLS on');
  perform neo_test.assert(not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'service_secrets'),
                          'service_secrets has no policies (only the definer RPCs touch it)');
  perform neo_test.assert(not exists (select 1 from information_schema.role_table_grants
                                       where table_schema = 'public' and table_name = 'service_secrets'
                                         and grantee in ('anon', 'authenticated', 'PUBLIC')),
                          'service_secrets: no table grants for anon, authenticated or PUBLIC');
  perform neo_test.assert(not exists (select 1 from pg_publication_tables
                                       where schemaname = 'public' and tablename = 'service_secrets'),
                          'service_secrets is in no publication (never broadcast by realtime)');
  perform neo_test.assert(exists (select 1 from information_schema.columns
                                   where table_schema = 'public' and table_name = 'service_jobs'
                                     and column_name = 'has_device_password' and is_nullable = 'NO'
                                     and column_default = 'false'),
                          'service_jobs.has_device_password is boolean not null default false');
  perform neo_test.assert(has_function_privilege('authenticated', 'public.service_set_password(text, text)', 'EXECUTE')
                          and has_function_privilege('authenticated', 'public.service_get_password(text)', 'EXECUTE')
                          and has_function_privilege('service_role', 'public.service_get_password(text)', 'EXECUTE')
                          and not has_function_privilege('anon', 'public.service_set_password(text, text)', 'EXECUTE')
                          and not has_function_privilege('anon', 'public.service_get_password(text)', 'EXECUTE')
                          and not has_function_privilege('anon', 'public.tg_service_jobs_zz_secret_purge()', 'EXECUTE')
                          and not has_function_privilege('authenticated', 'public.tg_service_jobs_zz_secret_purge()', 'EXECUTE'),
                          'function grants: the two RPCs to authenticated, nothing to anon, the trigger to nobody');
  perform neo_test.assert(has_function_privilege('anon', 'public.get_service_public(text, text)', 'EXECUTE'),
                          'get_service_public is still open to anon (unchanged)');
  perform neo_test.assert((select array_agg(tgname::text order by tgname) from pg_trigger
                            where tgrelid = 'public.service_jobs'::regclass and not tgisinternal
                              and tgname in ('trg_service_jobs_guard', 'trg_service_jobs_zz_secret_purge'))
                          = array['trg_service_jobs_guard', 'trg_service_jobs_zz_secret_purge'],
                          'the purge trigger sorts after the guard (BEFORE triggers fire in name order)');
  perform neo_test.assert(public._vocab_list('data_consent')
                          @> array['customer_backed_up', 'no_important_data', 'customer_accepts_risk', 'backup_ok', 'no_backup']
                          and cardinality(public._vocab_list('data_consent')) = 5,
                          '_vocab_list(data_consent) has the three new answers and the two legacy ones');
  perform neo_test.assert(public._vocab_list('svc_stage') @> array['logged', 'closed', 'resolved']
                          and cardinality(public._vocab_list('svc_stage')) = 22
                          and cardinality(public._vocab_list('rma_stage')) = 12,
                          'the rest of _vocab_list survived the copy');
  perform neo_test.assert((select count(*) from pg_constraint
                            where conrelid = 'public.service_jobs'::regclass and contype = 'c'
                              and pg_get_constraintdef(oid) ~* '\mdata_consent\M') = 1,
                          'exactly one data_consent CHECK on service_jobs');
end $$;


-- ── 2. Anonymous visitors cannot touch any of it ────────────────────────────
select neo_test.login_anon();
do $$
begin
  perform neo_test.expect_error($q$select public.service_get_password('s_none')$q$, '%permission denied%');
  perform neo_test.expect_error($q$select public.service_set_password('s_none', 'x')$q$, '%permission denied%');
  perform neo_test.expect_error($q$select count(*) from public.service_secrets$q$, '%permission denied%');
end $$;


-- ── 3. Desk: a ticket with a new data answer, then its password ─────────────
select neo_test.login('desk');
do $$
declare r jsonb; v_id text; v_job public.service_jobs;
begin
  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'service_type', 'in_store', 'channel', 'walk_in', 'category', 'repair',
         'customer_name', 'Test Secret Customer', 'customer_phone', '9000000201', 'in_hand', true,
         'reported_fault', 'Will not boot', 'data_consent', 'customer_backed_up', 'has_customer_data', true,
         'items', jsonb_build_array(jsonb_build_object('kind', 'laptop', 'label', 'Test laptop', 'purchase_source', 'unknown'))));
  v_id := r ->> 'id';
  perform neo_test.put('job', v_id);
  perform neo_test.put('code', r ->> 'public_code');
  select * into v_job from public.service_jobs where id = v_id;
  perform neo_test.assert(v_job.data_consent = 'customer_backed_up' and v_job.has_customer_data,
                          'service_create takes the new answer customer_backed_up');
  perform neo_test.assert(not v_job.has_device_password, 'a new ticket has no password on file');
  perform neo_test.assert((r -> 'job' ->> 'has_device_password')::boolean = false, 'the created row carries the flag');

  -- nothing on file yet: the read says so and logs nothing
  r := public.service_get_password(v_id);
  perform neo_test.assert(r ? 'secret' and r -> 'secret' = 'null'::jsonb, 'get with nothing on file gives a null secret');
  perform neo_test.assert(neo_test.lines(v_id, 'Device password viewed by ' || (select name from neo_test.users where alias = 'desk')) = 0,
                          'a read of nothing is not logged as a view');
  -- removing nothing is a no-op
  r := public.service_set_password(v_id, '');
  perform neo_test.assert((r ->> 'unchanged')::boolean and neo_test.lines(v_id, 'Device password removed') = 0,
                          'clearing a password that is not there changes nothing');

  -- set it
  r := public.service_set_password(v_id, 'Zq-test-PIN 4471');
  perform neo_test.assert((r ->> 'ok')::boolean and (r ->> 'has_device_password')::boolean
                          and (r -> 'job' ->> 'has_device_password')::boolean, 'set: ok, flag returned');
  perform neo_test.assert(neo_test.flag_of(v_id), 'set: service_jobs.has_device_password is true');
  perform neo_test.assert(neo_test.secret_of(v_id) = 'Zq-test-PIN 4471', 'set: stored exactly as typed (spaces kept)');
  perform neo_test.assert((select has_device_password from public.service_jobs where id = v_id),
                          'desk sees the flag on the row it can read');
  perform neo_test.assert(neo_test.lines(v_id, 'Device password saved') = 1, 'set: one internal "Device password saved" line');
  perform neo_test.assert(r::text not like '%Zq-test-PIN%', 'the set answer never echoes the password');

  -- the desk cannot read or write the table directly
  perform neo_test.expect_error($q$select count(*) from public.service_secrets$q$, '%permission denied%');
  perform neo_test.expect_error(format('select secret from public.service_secrets where job_id = %L', v_id), '%permission denied%');
  perform neo_test.expect_error(format('insert into public.service_secrets (job_id, secret) values (%L, %L)', v_id, 'x'),
                                '%permission denied%');
  perform neo_test.expect_error(format('update public.service_secrets set secret = %L where job_id = %L', 'x', v_id),
                                '%permission denied%');
  perform neo_test.expect_error(format('delete from public.service_secrets where job_id = %L', v_id), '%permission denied%');

  -- a direct write of the flag is put back, not refused (an old client's cached row)
  update public.service_jobs set has_device_password = false, diagnosis = 'Checked the hinge' where id = v_id;
  perform neo_test.assert(neo_test.flag_of(v_id) and (select diagnosis from public.service_jobs where id = v_id) = 'Checked the hinge',
                          'a direct has_device_password write is ignored; the rest of the update lands');

  -- the desk reads it; the view is logged
  r := public.service_get_password(v_id);
  perform neo_test.assert(r ->> 'secret' = 'Zq-test-PIN 4471' and r ->> 'set_by_name' = (select name from neo_test.users where alias = 'desk')
                          and r ->> 'set_at' is not null, 'desk reads the password back with who set it');
  perform neo_test.assert(neo_test.lines(v_id, 'Device password viewed by ' || (select name from neo_test.users where alias = 'desk')) = 1,
                          'the desk''s view is logged');

  -- validation
  perform neo_test.expect_error(format('select public.service_set_password(%L, %L)', v_id, repeat('x', 501)),
                                '%NEO_GATE: That password is too long%');
  perform neo_test.expect_error($q$select public.service_set_password('s_does_not_exist', 'x')$q$, '%NEO_GATE: That ticket no longer exists%');
  perform neo_test.expect_error($q$select public.service_get_password('s_does_not_exist')$q$, '%NEO_GATE: That ticket no longer exists%');
  perform neo_test.assert(neo_test.secret_of(v_id) = 'Zq-test-PIN 4471', 'a refused write leaves the password as it was');
end $$;


-- ── 4. Technician: reads it (logged), changes it ────────────────────────────
select neo_test.login('tech1');
do $$
declare r jsonb; v_id text := neo_test.get('job'); v_name text := (select name from neo_test.users where alias = 'tech1');
begin
  r := public.service_get_password(v_id);
  perform neo_test.assert(r ->> 'secret' = 'Zq-test-PIN 4471', 'a technician reads the password');
  r := public.service_get_password(v_id);
  perform neo_test.assert(neo_test.lines(v_id, 'Device password viewed by ' || v_name) = 2, 'every read is logged, not just the first');
  perform neo_test.expect_error($q$select count(*) from public.service_secrets$q$, '%permission denied%');

  r := public.service_set_password(v_id, ' Zq-second-9902 ');
  perform neo_test.assert(neo_test.secret_of(v_id) = ' Zq-second-9902 ' and neo_test.flag_of(v_id),
                          'a technician changes it; the flag stays on');
  perform neo_test.assert(neo_test.lines(v_id, 'Device password saved') = 2, 'the change is logged as saved');
  r := public.service_get_password(v_id);
  perform neo_test.assert(r ->> 'set_by_name' = v_name, 'the read names who set it last');
end $$;


-- ── 5. Sales (tier 1) and a tier-2 member with no module rows: refused ───────
select neo_test.login('sales');
do $$
declare v_id text := neo_test.get('job');
begin
  perform neo_test.expect_error(format('select public.service_get_password(%L)', v_id), '%NEO_DENIED%');
  perform neo_test.expect_error(format('select public.service_set_password(%L, %L)', v_id, 'x'), '%NEO_DENIED%');
  perform neo_test.expect_error(format('select public.service_set_password(%L, %L)', v_id, ''), '%NEO_DENIED%');
  perform neo_test.expect_error($q$select count(*) from public.service_secrets$q$, '%permission denied%');
  perform neo_test.assert(neo_test.secret_of(v_id) = ' Zq-second-9902 ', 'sales changed nothing');
end $$;

select neo_test.login('plain');
do $$
declare v_id text := neo_test.get('job');
begin
  perform neo_test.expect_error(format('select public.service_get_password(%L)', v_id), '%NEO_DENIED%');
  perform neo_test.expect_error(format('select public.service_set_password(%L, %L)', v_id, 'x'), '%NEO_DENIED%');
end $$;


-- ── 6. Nothing public or logged ever holds the value ────────────────────────
select neo_test.login_anon();
do $$
declare r jsonb;
begin
  r := public.get_service_public(neo_test.get('code'), '0201');
  perform neo_test.assert(r is not null, 'the tracking page still finds the ticket');
  perform neo_test.assert(r::text not like '%Zq-%' and r::text not like '%password%' and not (r ? 'has_device_password'),
                          'get_service_public says nothing about a device password');
end $$;

select neo_test.login('desk');
do $$
declare v_id text := neo_test.get('job');
begin
  perform neo_test.assert(neo_test.leaks(v_id, 'Zq-test-PIN') = 0 and neo_test.leaks(v_id, 'Zq-second') = 0,
                          'no timeline line (body or meta) ever contains the password');
  perform neo_test.assert(not exists (select 1 from public.service_events where job_id = v_id and customer_visible
                                       and body ilike '%password%'),
                          'every password line is internal');
end $$;


-- ── 7. Remove, set again, then close: the password goes with the close ──────
select neo_test.login('desk');
do $$
declare r jsonb; v_id text := neo_test.get('job');
begin
  r := public.service_set_password(v_id, '   ');
  perform neo_test.assert(not (r ->> 'has_device_password')::boolean and not neo_test.flag_of(v_id)
                          and neo_test.secret_of(v_id) is null, 'a blank password removes it and clears the flag');
  perform neo_test.assert(neo_test.lines(v_id, 'Device password removed') = 1, 'the removal is logged');
  r := public.service_get_password(v_id);
  perform neo_test.assert(r -> 'secret' = 'null'::jsonb, 'after removal there is nothing to read');

  r := public.service_set_password(v_id, 'Zq-test-PIN 4471');
  perform neo_test.assert(neo_test.flag_of(v_id), 'set again');

  r := public.service_move(v_id, 'received', 'ready', null, true, '{"outcome":"repaired"}'::jsonb);
  perform neo_test.assert(neo_test.secret_of(v_id) = 'Zq-test-PIN 4471', 'ready is not closed: the password stays');
  r := public.service_move(v_id, 'ready', 'closed');
  perform neo_test.assert(r ->> 'stage' = 'closed', 'the ticket closes');
  perform neo_test.assert(neo_test.secret_of(v_id) is null, 'closing deletes the password');
  perform neo_test.assert(not neo_test.flag_of(v_id) and not (r ->> 'has_device_password')::boolean,
                          'closing clears has_device_password, in the same update');
  perform neo_test.assert(neo_test.lines(v_id, 'Device password deleted — ticket closed') = 1,
                          'the purge leaves one internal line');
  perform neo_test.assert((select actor_kind from public.service_events
                            where job_id = v_id and body = 'Device password deleted — ticket closed') = 'system',
                          'the purge line is written by the system');

  perform neo_test.expect_error(format('select public.service_set_password(%L, %L)', v_id, 'again'),
                                '%NEO_GATE: This ticket is closed%');
  r := public.service_get_password(v_id);
  perform neo_test.assert(r -> 'secret' = 'null'::jsonb, 'a closed ticket has nothing to read');
end $$;

-- A reopen does not bring it back, and a second close with nothing on file
-- writes no purge line.
select neo_test.login('owner');
do $$
declare r jsonb; v_id text := neo_test.get('job');
begin
  update public.service_jobs set stage = 'diagnosing', outcome = null, ready_at = null, closed_at = null, closed_by = null,
         stage_since = now(), updated_at = now()
   where id = v_id;
  perform neo_test.assert(neo_test.jstage(v_id) = 'diagnosing' and not neo_test.flag_of(v_id) and neo_test.secret_of(v_id) is null,
                          'a reopened ticket has no password');
  update public.service_jobs set stage = 'closed', outcome = 'repaired', closed_at = now(), updated_at = now() where id = v_id;
  perform neo_test.assert(neo_test.lines(v_id, 'Device password deleted — ticket closed') = 1,
                          'closing with nothing on file writes no second purge line');
end $$;


-- ── 8. A v1.9.11-style close (a bare UPDATE) purges too ─────────────────────
select neo_test.login('owner');
do $$
declare v_id text;
begin
  insert into public.service_jobs (id, public_code, created_at, updated_at, job_kind, origin, stage, stage_since, received_at,
                                   customer_name, customer_phone, device_label, reported_fault, has_customer_data,
                                   intake, details, subject)
  values ('s_test_v21_0001', 'NT-TESTV21A', now(), now(), 'repair_outside', 'counter', 'received', now(), now(),
          'Test Legacy Secret Customer', '9000000202', 'Old tower', 'No boot', false, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
  v_id := 's_test_v21_0001';
  perform neo_test.assert(not neo_test.flag_of(v_id), 'an old-client insert gets the default flag');
  perform public.service_set_password(v_id, 'Zq-legacy-1111');
  perform neo_test.assert(neo_test.flag_of(v_id), 'a password on a v1 ticket');
  update public.service_jobs set stage = 'closed', outcome = 'repaired', closed_at = now(), closed_by = 'owner', updated_at = now()
   where id = v_id;
  perform neo_test.assert(neo_test.secret_of(v_id) is null and not neo_test.flag_of(v_id),
                          'a direct (v1.9.11) close deletes the password and clears the flag');
  perform neo_test.assert(neo_test.lines(v_id, 'Device password deleted — ticket closed') = 1, 'and logs it');

  -- deleting a ticket takes its password with it (foreign key cascade)
  insert into public.service_jobs (id, public_code, created_at, updated_at, job_kind, origin, stage, stage_since, received_at,
                                   customer_name, customer_phone, device_label, reported_fault, has_customer_data,
                                   intake, details, subject)
  values ('s_test_v21_0002', 'NT-TESTV21B', now(), now(), 'repair_outside', 'counter', 'received', now(), now(),
          'Test Deleted Secret Customer', '9000000203', 'Old laptop', 'No boot', false, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
  perform public.service_set_password('s_test_v21_0002', 'Zq-deleted-2222');
  delete from public.service_jobs where id = 's_test_v21_0002';
  perform neo_test.assert(neo_test.secret_of('s_test_v21_0002') is null, 'deleting a ticket deletes its password');
end $$;


-- ── 9. Data answers: the three new ones and the two legacy ones ─────────────
select neo_test.login('desk');
do $$
declare r jsonb; v text; v_id text;
begin
  foreach v in array array['customer_backed_up', 'no_important_data', 'customer_accepts_risk', 'backup_ok', 'no_backup'] loop
    r := public.service_create(jsonb_build_object(
           'customer_name', 'Test Consent ' || v, 'customer_phone', '9000000210', 'reported_fault', 'x',
           'in_hand', true, 'data_consent', v, 'has_customer_data', v <> 'no_important_data'));
    perform neo_test.assert((select data_consent from public.service_jobs where id = r ->> 'id') = v,
                            'service_create accepts data_consent ' || v);
    v_id := r ->> 'id';
  end loop;
  perform neo_test.assert((select has_customer_data from public.service_jobs where id = v_id), 'has_customer_data rides along');
  perform neo_test.expect_error($q$select public.service_create('{"customer_name":"A","customer_phone":"9000000211","reported_fault":"x","data_consent":"we_back_it_up"}'::jsonb)$q$,
                                '%NEO_GATE: Data consent "we_back_it_up" is not one of the allowed values%');

  -- a direct edit (the Details panel, a v1.9.11 desk) of each value
  foreach v in array array['no_important_data', 'customer_accepts_risk', 'customer_backed_up', 'no_backup', 'backup_ok'] loop
    update public.service_jobs set data_consent = v where id = v_id;
    perform neo_test.assert((select data_consent from public.service_jobs where id = v_id) = v, 'a direct edit to ' || v || ' lands');
  end loop;
  update public.service_jobs set data_consent = null where id = v_id;
  perform neo_test.expect_error(format('update public.service_jobs set data_consent = %L where id = %L', 'we_back_it_up', v_id),
                                '%service_jobs_data_consent_check%');
end $$;


-- ── Done ────────────────────────────────────────────────────────────────────
reset role;
select 'service-v2.1 tests: all passed' as result;
rollback;
