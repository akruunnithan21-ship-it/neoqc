-- =============================================================================
-- service-v2.tests.sql — tests for the service_v2_rma migration
-- -----------------------------------------------------------------------------
-- Run AFTER sql/service-v2.sql, as the database owner (Supabase SQL editor or
-- psql as postgres). Everything happens inside one transaction that ends in
-- ROLLBACK: nothing is left behind, not even the helper schema.
--
-- Users are simulated the way PostgREST does it: SET ROLE authenticated plus
-- request.jwt.claims. Test users are real profiles picked by email; the module
-- rows they need are (re)written inside the transaction, so the tests never
-- depend on what an admin changed in Settings. All data is created here.
--
-- A failed assertion raises "FAIL: …" and aborts the transaction — the first
-- error is the one to read. Success ends with the row
--   result = 'service-v2 tests: all passed'
-- just before the rollback.
-- Phone numbers 90000001xx (stored normalised as 9190000001xx) and the Gulf
-- numbers +971 50 123 4567 and +974 5012 3456 (Qatar: 11 digits) are used
-- for test customers; one build ticket t_zzneotest_q7x9k2 is inserted for
-- the build search.
-- =============================================================================

begin;

-- ── 0. Scaffolding (as the owner) ────────────────────────────────────────────
create schema neo_test;
grant usage on schema neo_test to anon, authenticated;

create table neo_test.users (alias text primary key, id uuid not null, email text not null, tier int not null);
create table neo_test.ctx (k text primary key, v text);
grant select on neo_test.users to anon, authenticated;
grant select, insert, update, delete on neo_test.ctx to anon, authenticated;

create function neo_test.put(p_k text, p_v text) returns void language plpgsql as $$
begin
  insert into neo_test.ctx (k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v;
end $$;

-- VOLATILE on purpose, like ustage / jstage below: the planner evaluates a
-- STABLE call while estimating a WHERE clause, under the snapshot the DO
-- block started with, and so cannot see what that block stored a moment ago.
create function neo_test.get(p_k text) returns text language plpgsql volatile as $$
declare v text;
begin
  select c.v into v from neo_test.ctx c where c.k = p_k;
  if not found or v is null then raise exception 'TEST BUG: nothing stored under "%"', p_k; end if;
  return v;
end $$;

create function neo_test.email(p_alias text) returns text language plpgsql stable as $$
declare v text;
begin
  select u.email into v from neo_test.users u where u.alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  return v;
end $$;

-- Become a signed-in staff member (PostgREST style).
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

-- Become a visitor with no account.
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

-- Run p_sql and require an error whose message is LIKE p_like.
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

-- Make an RMA part ready to ship as the current user: a serial-label photo
-- row (as the desk's upload would write it) and the vendor (column grant).
create function neo_test.prep_ship(p_case text, p_vendor bigint) returns void language plpgsql as $$
begin
  insert into public.service_media (job_id, rma_case_id, path, phase, role, uploaded_by, uploaded_name)
  values (null, p_case, 'rma/' || p_case || '/test-label.jpg', 'intake', 'serial_label', 'test', 'Test');
  update public.rma_cases set vendor_id = p_vendor where id = p_case;
end $$;

-- The current stage of a part / a ticket (readable by the current user).
create function neo_test.ustage(p_case text) returns text language sql volatile as $$
  select stage from public.rma_cases where id = p_case
$$;
create function neo_test.jstage(p_job text) returns text language sql volatile as $$
  select stage from public.service_jobs where id = p_job
$$;

grant execute on all functions in schema neo_test to anon, authenticated;

-- ── 1. Test users and their module rows ─────────────────────────────────────
insert into neo_test.users (alias, id, email, tier)
select a.alias, p.id, p.email, p.tier
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
  if (select tier from neo_test.users where alias = 'owner') < 4 then
    raise exception 'TEST SETUP: the owner must be tier 4 or above';
  end if;
  if (select tier from neo_test.users where alias = 'sales') <> 1 then
    raise exception 'TEST SETUP: the sales user must be tier 1';
  end if;
  if exists (select 1 from neo_test.users where alias in ('desk', 'tech1', 'tech2', 'plain') and tier >= 3) then
    raise exception 'TEST SETUP: desk, tech and plain users must be below tier 3 (tier 3+ are leads automatically)';
  end if;

  if exists (select 1 from public.service_jobs where public.norm_phone(customer_phone) like '9190000001__'
                                                  or public.norm_phone(customer_phone) in ('971501234567', '97450123456'))
     or exists (select 1 from public.customers where phone_norm like '9190000001__'
                                                 or phone_norm in ('971501234567', '97450123456'))
     or exists (select 1 from public.rma_intakes where public.norm_phone(sender_phone) like '9190000001__')
     or exists (select 1 from public.rma_cases where public.norm_phone(owner_phone) like '9190000001__')
     or exists (select 1 from public.service_jobs where id in ('s_test_v1_0001', 's_test_v1_0002', 's_test_v1_0003',
                                                                's_test_v1_0004')
                                                     or public_code in ('NT-TESTV1AA', 'NT-TESTV1AB', 'NT-TESTV1AC',
                                                                        'NT-TESTV1AD'))
     or exists (select 1 from public.rma_vendors where name like 'ZZ Test Vendor%')
     or exists (select 1 from public.tickets where upper(right(id, 6)) = 'Q7X9K2') then
    raise exception 'TEST SETUP: test phones / ids are already in use; change the test values in this file';
  end if;
end $$;

-- Exactly the roles this script expects, whatever Settings says today.
delete from public.module_access
 where profile_id in (select id from neo_test.users where alias in ('desk', 'tech1', 'tech2', 'sales', 'plain'));
insert into public.module_access (profile_id, module, role, granted_by)
select u.id, m.module, m.role, 'tests'
  from neo_test.users u
  join (values ('desk', 'service', 'desk'), ('desk', 'rma', 'desk'),
               ('tech1', 'service', 'tech'), ('tech1', 'rma', 'tech'),
               ('tech2', 'service', 'tech'), ('tech2', 'rma', 'tech')) as m(alias, module, role)
    on m.alias = u.alias;

-- v2.2: pool gate — once sql/work-queue.sql is applied, service_claim and
-- service_tech_list need the caller's service pool. The users who claim here
-- get one, whatever People says today. Skipped before v2.2 (no such table).
do $$
begin
  if to_regclass('public.staff_work') is not null then
    execute $x$
      insert into public.staff_work (profile_id, build_pool, service_pool, updated_by)
      select u.id, true, true, 'tests' from neo_test.users u where u.alias in ('owner', 'tech1', 'tech2')
      on conflict (profile_id) do update set service_pool = true$x$;
  end if;
end $$;

-- A finished build for the build search (A20). Only the columns the repo's
-- tickets DDL defines; specs / serials hold what the build checklist records.
insert into public.tickets (id, type, customer_name, specs, serials, completed_at)
values ('t_zzneotest_q7x9k2', 'build', 'Test Build Customer',
        '{"cpu": "Ryzen 7 7700", "gpu": "RTX 4070", "__verify": {"note": "verified"}}'::jsonb,
        '{"gpu": "GPU-BUILD-778899", "psu": "PSU BUILD 4455"}'::jsonb,
        now() - interval '30 days');

-- Schema facts the apps rely on (as the owner).
do $$
begin
  perform neo_test.assert(not exists (select 1 from information_schema.columns
                                       where table_schema = 'public' and table_name = 'v_service_queue'
                                         and column_name in ('customer_phone', 'customer_name', 'site_address', 'customer_email')),
                          'v_service_queue exposes no phone, name or address');
  perform neo_test.assert(not exists (select 1 from information_schema.views
                                       where table_schema = 'public' and table_name = 'v_tech_activity'),
                          'A24: v_tech_activity is gone (replaced by the tech_activity RPC)');
  perform neo_test.assert(exists (select 1 from public.rma_vendors where name = 'ASUS' and typical_tat_days = 14)
                          and exists (select 1 from public.rma_vendors where name = 'Intel' and typical_tat_days = 21),
                          'vendor seed is present');
  -- A1: the country code is kept.
  perform neo_test.assert(public.norm_phone('+91 98470 12345') = '919847012345'
                          and public.norm_phone('098470 12345') = '919847012345'
                          and public.norm_phone('9847012345') = '919847012345'
                          and public.norm_phone('919847012345') = '919847012345'
                          and public.norm_phone('+971 50 123 4567') = '971501234567'
                          and public.norm_phone('12345') = '12345'
                          and public.norm_phone(null) = '', 'A1: norm_phone keeps the country code');
  -- The unified rule (A1'): a leading 00 (the international dialling prefix)
  -- is dropped once, before the 10 / 11-with-0 rules.
  perform neo_test.assert(public.norm_phone('00971 50 123 4567') = '971501234567'
                          and public.norm_phone('0091 98470 12345') = '919847012345'
                          and public.norm_phone('00974 5012 3456') = '97450123456'
                          and public.norm_phone('+974 5012 3456') = '97450123456'
                          and public.norm_phone('0098470 12345') = '919847012345'
                          and public.norm_phone('00') = '',
                          'A1'': norm_phone drops a leading 00 once, then applies the Indian rules');
  perform neo_test.assert(public.phone_ok('9847012345') and public.phone_ok('+971 50 123 4567')
                          and public.phone_ok('098470 12345') and public.phone_ok('00971 50 123 4567')
                          and not public.phone_ok('98470123456') and not public.phone_ok('12345')
                          and not public.phone_ok('1234567890123456') and not public.phone_ok(null),
                          'A1: a usable phone is 12-15 digits after normalising');
  perform neo_test.assert(public.phone_ok('+965 9999 8888') and public.phone_ok('+968 9123 4567')
                          and public.phone_ok('+973 3612 3456') and public.phone_ok('+974 5012 3456')
                          and public.phone_ok('00974 5012 3456')
                          and not public.phone_ok('+971 5012 3456') and not public.phone_ok('+966 5012 3456')
                          and not public.phone_ok('91847012345'),
                          'A1'': 11 digits are valid only for Kuwait, Oman, Bahrain and Qatar (965 / 968 / 973 / 974)');
  perform neo_test.assert(public.new_public_code('RM') ~ '^RM-[234679ACDEFGHJKLMNPQRTUVWXYZ]{8}$', 'new_public_code shape');
  perform neo_test.assert(public.new_text_id('rc') ~ '^rc_[0-9a-z]{13,}$', 'new_text_id shape');
  perform neo_test.assert(public.rma_transition_ok('ready_to_ship', 'with_vendor')
                          and not public.rma_transition_ok('received', 'with_vendor')
                          and not public.rma_transition_ok('closed', 'received'), 'rma_transition_ok follows the SPEC table');
  perform neo_test.assert(public.rma_transition_ok('with_tech', 'received') and public.rma_transition_ok('with_tech', 'ready_to_ship')
                          and public.rma_transition_ok('with_tech', 'closed') and not public.rma_transition_ok('with_tech', 'testing')
                          and public.rma_transition_ok('with_vendor', 'returning'),
                          'A8 / A10: with_tech and with_vendor -> returning are in the transition table');
  perform neo_test.assert(public.svc_stage_legal('remote', 'session_booked') and not public.svc_stage_legal('remote', 'rma_raised')
                          and not public.svc_stage_legal('on_site', 'in_service'), 'svc_stage_legal follows STAGES_BY_TYPE');
  perform neo_test.assert(exists (select 1 from information_schema.columns where table_schema = 'public'
                                   and table_name = 'rma_shipments' and column_name = 'carried_by')
                          and exists (select 1 from information_schema.columns where table_schema = 'public'
                                       and table_name = 'rma_cases' and column_name = 'replacement_serial_norm'),
                          'A9 / A15: rma_shipments.mode/carried_by and rma_cases.replacement_serial_norm exist');
  -- A13: the brand first; a vendor's public name only when it is not a distributor.
  perform neo_test.assert(public._rma_party('Zotac', 'Vendor Alpha', 'distributor') = 'Zotac'
                          and public._rma_party(null, 'Vendor Alpha', 'distributor') is null
                          and public._rma_party('  ', 'Vendor Alpha', 'distributor') is null
                          and public._rma_party(null, 'ASUS', 'brand') = 'ASUS'
                          and public._rma_party(null, 'ASUS Service Centre', 'service_centre') = 'ASUS Service Centre',
                          'A13: _rma_party never names a distributor');
  -- The ready-to-return words match the JS model (rmaCustomerLabel).
  perform neo_test.assert(public._rma_stage_customer('ready_to_return', 'with_device') = 'Being fitted back in your device'
                          and public._rma_stage_customer('ready_to_return', 'collect') = 'Ready to collect'
                          and public._rma_stage_customer('ready_to_return', 'courier') = 'Being packed for return',
                          '_rma_stage_customer words ready_to_return by return method');
end $$;


-- ── 2. Anonymous visitors see nothing but the two tracking lookups ──────────
select neo_test.login_anon();
do $$
declare t text; n bigint;
begin
  foreach t in array array['service_jobs', 'service_events', 'service_media', 'service_items', 'customers',
                           'module_access', 'rma_vendors', 'rma_intakes', 'rma_cases', 'rma_events', 'rma_shipments',
                           'rma_shipment_items', 'field_activity', 'v_service_queue', 'v_tech_day'] loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then raise exception 'FAIL: anon can read % row(s) of %', n, t; end if;
    exception when insufficient_privilege then null;
    end;
  end loop;
  perform neo_test.expect_error($q$select public.service_create('{"customer_name":"x"}'::jsonb)$q$, '%permission denied%');
  perform neo_test.expect_error($q$select public.rma_create('{}'::jsonb)$q$, '%permission denied%');
  perform neo_test.expect_error($q$select public.my_modules()$q$, '%permission denied%');
  perform neo_test.expect_error($q$select public.find_builds('Q7X9K2')$q$, '%permission denied%');
  perform neo_test.expect_error($q$select public.tech_activity(null, null)$q$, '%permission denied%');
  perform neo_test.assert(public.get_service_public('NT-ZZZZZZZZ', '0000') is null, 'get_service_public: unknown code gives null');
  perform neo_test.assert(public.get_rma_public('RM-ZZZZZZZZ', '0000') is null, 'get_rma_public: unknown code gives null');
end $$;


-- ── 3. Sales (tier 1): can raise requests, cannot read the tables ───────────
select neo_test.login('sales');
do $$
declare
  r jsonb; r2 jsonb; n bigint; v_id text; v_crid uuid := gen_random_uuid(); v_rcrid uuid := gen_random_uuid();
begin
  r := public.service_create(jsonb_build_object(
         'client_request_id', v_crid, 'service_type', 'on_site', 'channel', 'phone', 'category', 'networking',
         'customer_name', 'Test Onsite Customer', 'customer_phone', '+91 90000 00101',
         'fault_keys', jsonb_build_array('network_setup'), 'reported_fault', 'Office Wi-Fi keeps dropping',
         'site_address', '12 Test Street', 'site_area', 'Kakkanad', 'site_pincode', '682030',
         'site_maps_url', 'https://maps.google.com/?q=10.0159,76.3419', 'site_lat', 10.0159, 'site_lng', 76.3419,
         'window_start', now() + interval '1 day', 'window_end', now() + interval '1 day 6 hours',
         'window_note', 'Weekdays after 5 pm', 'est_minutes', 90,
         'suggested_tech_email', neo_test.email('tech1'), 'suggest_reason', 'Served them before'));
  v_id := r ->> 'id';
  perform neo_test.assert(r ->> 'stage' = 'logged', 'sales: an on-site request starts at logged');
  perform neo_test.assert((r ->> 'public_code') ~ '^NT-[234679ACDEFGHJKLMNPQRTUVWXYZ]{8}$', 'sales: NT code shape');
  perform neo_test.assert(r ->> 'customer_id' is not null, 'sales: the customer is linked');
  perform neo_test.assert(jsonb_typeof(r -> 'job') = 'null', 'sales does not get the ticket row back');
  perform neo_test.put('job_onsite', v_id);
  perform neo_test.put('code_onsite', r ->> 'public_code');

  select count(*) into n from public.service_jobs where id = v_id;
  perform neo_test.assert(n = 0, 'sales (tier 1) cannot read service_jobs');
  -- Nor list the files behind them (invoices, serial labels) in the bucket.
  select count(*) into n from storage.objects where bucket_id = 'service-media';
  perform neo_test.assert(n = 0, 'sales (tier 1) cannot list or download service-media files');

  r2 := public.service_create(jsonb_build_object('client_request_id', v_crid, 'customer_name', 'Someone Else',
                                                 'customer_phone', '9000000101', 'reported_fault', 'x'));
  perform neo_test.assert((r2 ->> 'duplicate')::boolean and r2 ->> 'id' = v_id, 'service_create is idempotent on client_request_id');

  r := public.service_my_requests();
  perform neo_test.assert(exists (select 1 from jsonb_array_elements(r -> 'jobs') as e(value)
                                   where e.value ->> 'public_code' = neo_test.get('code_onsite')),
                          'service_my_requests lists the sales request');

  -- A19: sales get the reduced lookup — known, a short name, the open count; nothing else.
  r := public.lookup_customer('9000000101');
  perform neo_test.assert((r ->> 'limited')::boolean and (r ->> 'known')::boolean
                          and r ->> 'display_name' = 'Test C.' and (r ->> 'open_count')::int = 1
                          and r ->> 'phone_norm' = '919000000101',
                          format('A19: reduced lookup for sales (got %s)', r::text));
  perform neo_test.assert(not (r ? 'open_jobs') and not (r ? 'customer') and not (r ? 'past_techs') and not (r ? 'open_rma')
                          and r::text not like '%NT-%',
                          'A19: the reduced lookup has no codes, ids, technicians or parts');
  r := public.lookup_customer('9000000199');
  perform neo_test.assert((r ->> 'limited')::boolean and not (r ->> 'known')::boolean and (r ->> 'open_count')::int = 0,
                          'A19: an unknown number reads as not known');
  perform neo_test.expect_error($q$select public.find_builds('Q7X9K2')$q$, '%NEO_DENIED%');

  perform neo_test.expect_error(format('select public.service_move(%L, %L, %L)', v_id, 'logged', 'scheduled'), '%NEO_DENIED%');
  perform neo_test.expect_error(format('select public.service_claim(%L)', v_id), '%NEO_DENIED%');

  r := public.service_tech_list();
  perform neo_test.assert(exists (select 1 from jsonb_array_elements(r) as e(value)
                                   where lower(e.value ->> 'email') = lower(neo_test.email('tech1'))
                                     and e.value ->> 'role' = 'tech'
                                     and (e.value ->> 'in_queue_requested')::int >= 1),
                          'service_tech_list shows the tech and the request waiting for them');
  perform neo_test.assert(not exists (select 1 from jsonb_array_elements(r) as e(value)
                                       where lower(e.value ->> 'email') = lower(neo_test.email('desk'))),
                          'service_tech_list leaves out desk-only staff');

  -- RMA: sales may only log an expected part, and never a field pull
  perform neo_test.expect_error($q$select public.rma_create('{"source":"website","sender_name":"S","sender_phone":"9000000102","in_hand":true,"units":[{"kind":"gpu","fault":"x"}]}'::jsonb)$q$,
                                '%NEO_DENIED%');
  perform neo_test.expect_error($q$select public.rma_create('{"source":"field","sender_name":"S","sender_phone":"9000000102","units":[{"kind":"gpu","fault":"x"}]}'::jsonb)$q$,
                                '%NEO_DENIED%');
  r := public.rma_create(jsonb_build_object(
         'client_request_id', v_rcrid, 'source', 'website', 'sender_kind', 'customer',
         'sender_name', 'Test Rma Sender', 'sender_phone', '9000000102', 'in_hand', false,
         'units', jsonb_build_array(
           jsonb_build_object('kind', 'ssd', 'brand', 'Samsung', 'model', '980 1TB',
                              'serial', 'SSD-TEST-0001', 'fault', 'Not detected', 'purchase_source', 'elsewhere'),
           jsonb_build_object('kind', 'ram', 'brand', 'Kingston', 'model', 'Fury 16GB',
                              'fault', 'Fails memtest', 'purchase_source', 'unknown'))));
  perform neo_test.assert(r -> 'units' -> 0 ->> 'stage' = 'logged', 'sales RMA: logged, not in hand');
  perform neo_test.assert(r -> 'units' -> 0 ->> 'kind' = 'ssd' and r -> 'units' -> 1 ->> 'kind' = 'ram',
                          'rma_create returns the units in payload order');
  perform neo_test.assert(r -> 'units' -> 0 ->> 'fee_status' = 'quoted'
                          and (r -> 'units' -> 0 ->> 'handling_fee')::numeric = 300,
                          'bought elsewhere: default handling fee 300, quoted');
  perform neo_test.put('code_unit_sales', r -> 'units' -> 0 ->> 'public_code');
  r2 := public.rma_create(jsonb_build_object('client_request_id', v_rcrid, 'source', 'website', 'sender_name', 'X',
                                             'sender_phone', '9000000102', 'units', jsonb_build_array(jsonb_build_object('fault', 'x'))));
  perform neo_test.assert((r2 ->> 'duplicate')::boolean and jsonb_array_length(r2 -> 'units') = 2
                          and r2 -> 'units' -> 0 ->> 'public_code' = r -> 'units' -> 0 ->> 'public_code'
                          and r2 -> 'units' -> 1 ->> 'public_code' = r -> 'units' -> 1 ->> 'public_code',
                          'an idempotent rma_create replay returns the same units, in order');
  select count(*) into n from public.rma_cases where id = r -> 'units' -> 0 ->> 'id';
  perform neo_test.assert(n = 0, 'sales cannot read rma_cases');
end $$;


-- ── 4. A tier-2 member with no module rows sees nothing ─────────────────────
select neo_test.login('plain');
do $$
declare r jsonb; n bigint;
begin
  r := public.my_modules();
  perform neo_test.assert(r ->> 'service' is null and r ->> 'rma' is null and (r ->> 'tier')::int < 3,
                          'plain: no module roles');
  select count(*) into n from public.service_jobs where id = neo_test.get('job_onsite');
  perform neo_test.assert(n = 0, 'plain tier-2 without module rows cannot read service_jobs');
  select count(*) into n from public.customers;
  perform neo_test.assert(n = 0, 'plain tier-2 cannot read customers');
  perform neo_test.expect_error(format('select public.service_move(%L, %L, %L)', neo_test.get('job_onsite'), 'logged', 'scheduled'),
                                '%NEO_DENIED%');
  perform neo_test.expect_error(format('select public.rma_receive(array[%L])', 'rc_none'), '%NEO_DENIED%');
end $$;


-- ── 5. Desk: create, look up, move; validation and guards ───────────────────
select neo_test.login('desk');
do $$
declare
  r jsonb; v_id text; v_job public.service_jobs; n bigint;
begin
  -- validation
  perform neo_test.expect_error($q$select public.service_create('{"customer_phone":"9000000103","reported_fault":"x"}'::jsonb)$q$,
                                '%NEO_GATE: Enter the customer''s name%');
  perform neo_test.expect_error($q$select public.service_create('{"customer_name":"A","customer_phone":"12345","reported_fault":"x"}'::jsonb)$q$,
                                '%NEO_GATE: Enter the customer''s phone number%');
  perform neo_test.expect_error($q$select public.service_create('{"customer_name":"A","customer_phone":"98470123456","reported_fault":"x"}'::jsonb)$q$,
                                '%NEO_GATE: Enter the customer''s phone number%');
  perform neo_test.expect_error($q$select public.service_create('{"customer_name":"A","customer_phone":"9000000103"}'::jsonb)$q$,
                                '%NEO_GATE: Describe the fault%');
  perform neo_test.expect_error($q$select public.service_create('{"customer_name":"A","customer_phone":"9000000103","reported_fault":"x","service_type":"on_site"}'::jsonb)$q$,
                                '%NEO_GATE: Add the site address%');
  perform neo_test.expect_error($q$select public.service_create('{"customer_name":"A","customer_phone":"9000000103","reported_fault":"x","priority":"asap"}'::jsonb)$q$,
                                '%NEO_GATE%');
  perform neo_test.expect_error($q$select public.service_create('{"customer_name":"A","customer_phone":"9000000103","reported_fault":"x","items":[{"kind":"pc","build_ticket_id":"t_does_not_exist"}]}'::jsonb)$q$,
                                '%NEO_GATE: Build%was not found%');

  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'service_type', 'in_store', 'channel', 'walk_in', 'category', 'repair',
         'customer_name', 'Test Store Customer', 'customer_phone', '9000000103', 'in_hand', true,
         'reported_fault', 'No display after a storm', 'fault_keys', jsonb_build_array('no_display'),
         'data_consent', 'backup_ok', 'assign_self', true,
         'items', jsonb_build_array(
           jsonb_build_object('kind', 'pc', 'label', 'Custom tower', 'serial', 'PC-TEST-0001', 'purchase_source', 'unknown',
                              'accessories', jsonb_build_array('Power cable'), 'powers_on', false),
           jsonb_build_object('kind', 'gpu', 'label', 'ASUS TUF RTX 4070', 'serial', 'GPU-TEST-0001',
                              'purchase_source', 'neo_tokyo'))));
  v_id := r ->> 'id';
  perform neo_test.assert(r ->> 'stage' = 'received', 'desk: in-store, in hand, starts at received');
  perform neo_test.assert(jsonb_array_length(r -> 'items') = 2, 'desk: two items created');
  perform neo_test.assert(jsonb_typeof(r -> 'job') = 'object', 'desk gets the ticket row back');

  select * into v_job from public.service_jobs where id = v_id;
  perform neo_test.assert(v_job.id is not null, 'desk can read the ticket');
  perform neo_test.assert(v_job.assignee_email is null and v_job.queued_at is not null,
                          'assign_self is ignored for a desk user; the ticket queues');
  perform neo_test.assert(v_job.device_label = 'Custom tower' and v_job.device_serial = 'PC-TEST-0001',
                          'the primary item is mirrored into device_label / device_serial');
  perform neo_test.assert(v_job.model_version = 2 and v_job.job_kind = 'repair_outside' and v_job.category = 'repair',
                          'a v2 ticket still carries a job_kind for old clients');
  perform neo_test.assert(v_job.intake ->> 'taken_by' is not null, 'the old intake record is written once');
  perform neo_test.assert(exists (select 1 from public.service_events e where e.job_id = v_id and e.kind = 'stage'
                                   and e.to_stage = 'received' and e.customer_visible),
                          'the creation event is written');
  perform neo_test.assert((select phone_norm from public.customers where id = v_job.customer_id) = '919000000103',
                          'A1: the customer book stores the number with its country code');
  perform neo_test.assert(v_job.customer_phone = '9000000103', 'A1: the ticket keeps the phone exactly as typed');
  perform neo_test.put('job_store', v_id);
  perform neo_test.put('code_store', r ->> 'public_code');
  perform neo_test.put('item_gpu', (select si.id from public.service_items si where si.job_id = v_id and si.kind = 'gpu'));

  -- a second open ticket for the same phone is flagged, not blocked
  r := public.service_create(jsonb_build_object('customer_name', 'Test Store Customer', 'customer_phone', '09000000103',
                                                'reported_fault', 'Second visit', 'in_hand', false));
  perform neo_test.assert(jsonb_array_length(r -> 'open_same_phone') >= 1, 'open_same_phone warns about the other open ticket');

  -- customer lookup (full shape for the desk)
  r := public.lookup_customer('+91 9000000103');
  perform neo_test.assert(r -> 'customer' ->> 'name' = 'Test Store Customer', 'lookup_customer finds the customer');
  perform neo_test.assert((r ->> 'jobs_total')::int = 2 and jsonb_array_length(r -> 'open_jobs') = 2,
                          'lookup_customer lists both open tickets');
  perform neo_test.assert(not (r ? 'limited') or not (r ->> 'limited')::boolean, 'the desk gets the full lookup');
  r := public.lookup_customer('12345');
  perform neo_test.assert(r -> 'customer' = 'null'::jsonb and r ->> 'phone_norm' = '12345'
                          and jsonb_array_length(r -> 'open_jobs') = 0, 'a short phone gives an empty lookup');

  -- moves
  r := public.service_move(v_id, 'received', 'diagnosing', null, true, '{}'::jsonb);
  perform neo_test.assert(r ->> 'stage' = 'diagnosing', 'desk can move received -> diagnosing');
  perform neo_test.expect_error(format('select public.service_move(%L, %L, %L)', v_id, 'received', 'diagnosing'),
                                '%NEO_STALE: Someone moved this ticket to Diagnosing already%');
  perform neo_test.expect_error(format('select public.service_move(%L, %L, %L)', v_id, 'diagnosing', 'rma_raised'),
                                '%NEO_RMA_HOLD: Raise the RMA from the Items tab%');
  perform neo_test.expect_error(format('select public.service_move(%L, %L, %L)', neo_test.get('job_onsite'), 'logged', 'in_service'),
                                '%NEO_GATE: On the bench is not a step for an on-site ticket%');
  perform neo_test.expect_error(format('select public.service_move(%L, %L, %L)', v_id, 'diagnosing', 'ready'),
                                '%NEO_GATE: Say what happened%');
  perform neo_test.expect_error(format('select public.service_move(%L, %L, %L, null, true, %L::jsonb)',
                                       v_id, 'diagnosing', 'parts_on_order', '{}'), '%NEO_GATE: Say who we are waiting on%');

  -- desk cannot claim; protected columns and priority rules hold
  perform neo_test.expect_error(format('select public.service_claim(%L)', neo_test.get('job_onsite')), '%NEO_DENIED%');
  perform neo_test.expect_error(format('update public.service_jobs set priority = %L where id = %L', 'urgent', v_id), '%NEO_DENIED%');
  perform neo_test.expect_error(format('update public.service_jobs set service_type = %L where id = %L', 'remote', v_id), '%NEO_DENIED%');
  perform neo_test.expect_error(format('select public.service_set_priority(%L, %L, %L)', v_id, 'high', 'Customer travelling'),
                                '%NEO_DENIED%');
  r := public.service_set_priority(neo_test.get('job_onsite'), 'high', 'Business with three machines');
  perform neo_test.assert(r -> 'job' ->> 'priority' = 'high', 'desk may set priority while a ticket is still logged');
  perform neo_test.assert(exists (select 1 from public.service_events e where e.job_id = neo_test.get('job_onsite')
                                   and e.kind = 'priority'),
                          'a priority change is recorded with kind priority');
  perform neo_test.assert(exists (select 1 from public.service_events e where e.job_id = neo_test.get('job_onsite')
                                   and e.kind = 'suggest'),
                          'the intake suggestion is recorded with kind suggest');

  -- history is append-only
  perform neo_test.expect_error(format('update public.service_events set body = %L where job_id = %L', 'x', v_id), '%permission denied%');
  perform neo_test.expect_error(format('delete from public.service_events where job_id = %L', v_id), '%permission denied%');

  -- a direct item edit (the Items tab) reaches the ticket's device columns
  update public.service_items set label = 'Custom tower (black)' where job_id = v_id and is_primary;
  perform neo_test.assert((select device_label from public.service_jobs where id = v_id) = 'Custom tower (black)',
                          'a primary item edit is mirrored to the ticket');

  -- A20: find a past build by receipt code, name or a recorded serial
  r := public.find_builds('#q7x9k2');
  perform neo_test.assert(jsonb_array_length(r) >= 1 and r -> 0 ->> 'id' = 't_zzneotest_q7x9k2'
                          and r -> 0 ->> 'code' = 'Q7X9K2' and r -> 0 ->> 'match' = 'code'
                          and r -> 0 ->> 'summary' = 'Ryzen 7 7700 · RTX 4070' and r -> 0 ->> 'customer_name' = 'Test Build Customer',
                          format('A20: find_builds by the 6-character code (got %s)', r::text));
  r := public.find_builds('gpu-build-778899');
  perform neo_test.assert(exists (select 1 from jsonb_array_elements(r) as e(value)
                                   where e.value ->> 'id' = 't_zzneotest_q7x9k2' and e.value ->> 'match' = 'serial'),
                          'A20: find_builds by a serial recorded on the build (case and dashes ignored)');
  r := public.find_builds('Test Build Cust');
  perform neo_test.assert(exists (select 1 from jsonb_array_elements(r) as e(value)
                                   where e.value ->> 'id' = 't_zzneotest_q7x9k2' and e.value ->> 'match' = 'name'),
                          'A20: find_builds by the customer''s name');
  perform neo_test.assert(jsonb_array_length(public.find_builds('%')) = 0 and jsonb_array_length(public.find_builds('')) = 0,
                          'A20: a lone % is literal and an empty search finds nothing');
  r := public.find_builds('Test');
  perform neo_test.assert(jsonb_array_length(r) <= 10, 'A20: at most 10 results');
end $$;


-- ── 5b. A1: a Gulf customer keeps their number ──────────────────────────────
do $$
declare r jsonb;
begin
  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'customer_name', 'Test Gulf Customer', 'customer_phone', '+971 50 123 4567',
         'in_hand', true, 'reported_fault', 'Laptop does not charge',
         'items', jsonb_build_array(jsonb_build_object('kind', 'laptop', 'label', 'Dell XPS 13'))));
  perform neo_test.put('code_gulf', r ->> 'public_code');
  perform neo_test.assert((select phone_norm from public.customers where id = (r ->> 'customer_id')::uuid) = '971501234567',
                          'A1: +971 50 123 4567 is stored as 971501234567');
  r := public.lookup_customer('971501234567');
  perform neo_test.assert(r -> 'customer' ->> 'name' = 'Test Gulf Customer' and jsonb_array_length(r -> 'open_jobs') = 1,
                          'A1: the Gulf number is found again by its normalised form');
  r := public.lookup_customer('00971 50 123 4567');
  perform neo_test.assert(r ->> 'phone_norm' = '971501234567' and r -> 'customer' ->> 'name' = 'Test Gulf Customer',
                          'A1'': the same number dialled with 00 is the same customer');

  -- Qatar (and Kuwait, Oman, Bahrain): a 3-digit code plus 8 digits is 11.
  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'customer_name', 'Test Qatar Customer', 'customer_phone', '00974 5012 3456',
         'in_hand', true, 'reported_fault', 'Keyboard keys stuck',
         'items', jsonb_build_array(jsonb_build_object('kind', 'laptop', 'label', 'Lenovo T14'))));
  perform neo_test.put('code_qatar', r ->> 'public_code');
  perform neo_test.assert((select phone_norm from public.customers where id = (r ->> 'customer_id')::uuid) = '97450123456',
                          'A1'': an 11-digit Qatar number is accepted and stored without the 00');
  r := public.lookup_customer('+974 5012 3456');
  perform neo_test.assert(r -> 'customer' ->> 'name' = 'Test Qatar Customer' and jsonb_array_length(r -> 'open_jobs') = 1,
                          'A1'': the Qatar number typed with + is the same customer');
  perform neo_test.expect_error($q$select public.service_create('{"customer_name":"A","customer_phone":"+971 5012 3456","reported_fault":"x"}'::jsonb)$q$,
                                '%NEO_GATE: Enter the customer''s phone number%');
end $$;

select neo_test.login_anon();
do $$
begin
  perform neo_test.assert(public.get_service_public(neo_test.get('code_gulf'), '4567') is not null,
                          'A1: the public page works with the last 4 digits of a Gulf number');
  perform neo_test.assert(public.get_service_public(neo_test.get('code_qatar'), '3456') is not null,
                          'A1'': the public page works with the last 4 digits of a Qatar number');
end $$;


-- ── 6. Queue: tech claims, a second claim is told it is taken ───────────────
select neo_test.login('tech1');
do $$
declare r jsonb; v_id text := neo_test.get('job_onsite');
begin
  perform neo_test.assert(exists (select 1 from public.v_service_queue q where q.id = v_id and q.lat = 10.02),
                          'v_service_queue shows the unclaimed ticket with a rounded location');
  r := public.service_claim(v_id, now() + interval '1 day 1 hour', now() + interval '1 day 3 hours', null);
  perform neo_test.assert((r ->> 'ok')::boolean and r -> 'job' ->> 'stage' = 'scheduled',
                          'claiming with a visit time moves on-site logged -> scheduled');
  perform neo_test.assert(r -> 'job' ->> 'assigned_via' = 'claim' and r -> 'job' ->> 'queued_at' is null,
                          'a claim stamps assigned_via and leaves the queue');
  perform neo_test.assert(exists (select 1 from public.v_tech_day d where d.id = v_id and d.customer_phone is not null),
                          'v_tech_day shows my ticket with the phone I need');
  perform neo_test.assert(not exists (select 1 from public.v_service_queue q where q.id = v_id), 'a claimed ticket leaves the queue view');
  perform neo_test.assert(exists (select 1 from public.service_events e where e.job_id = v_id and e.kind = 'stage'
                                   and e.to_stage = 'scheduled' and e.customer_visible and e.body like 'Visit booked for%'),
                          'the booked visit is told to the customer');
  -- A17: a retry of my own claim is a success, not "taken"
  r := public.service_claim(v_id);
  perform neo_test.assert((r ->> 'ok')::boolean and (r ->> 'already')::boolean
                          and lower(r -> 'job' ->> 'assignee_email') = lower(neo_test.email('tech1')),
                          'A17: claiming a ticket I already have answers ok');
  perform neo_test.assert((select count(*) from public.service_events e where e.job_id = v_id and e.kind = 'claim') = 1,
                          'A17: the repeated claim writes no second claim event');
end $$;

select neo_test.login('tech2');
do $$
declare r jsonb;
begin
  r := public.service_claim(neo_test.get('job_onsite'));
  perform neo_test.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'taken'
                          and lower(r ->> 'by_email') = lower(neo_test.email('tech1')),
                          'a second claim returns taken, naming the first technician');
end $$;


-- ── 6b. A16 assignment gate + compare-and-set; A18 check-out from scheduled ─
select neo_test.login('desk');
do $$
declare r jsonb;
begin
  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'service_type', 'on_site', 'channel', 'phone',
         'customer_name', 'Test Gate Customer', 'customer_phone', '9000000108', 'reported_fault', 'Printer offline',
         'site_area', 'Edappally'));
  perform neo_test.put('job_gate', r ->> 'id');
end $$;

select neo_test.login('owner');
do $$
declare r jsonb; v_id text := neo_test.get('job_gate');
begin
  perform neo_test.expect_error(format('select public.service_assign(%L, %L, %L, null)', v_id, neo_test.email('tech1'), 'Closer to them'),
                                '%NEO_GATE: Let the technicians claim on-site tickets first%6 hours%');
  r := public.service_assign(v_id, neo_test.email('tech1'), 'Emergency: the office network is down', null);
  perform neo_test.assert((r ->> 'ok')::boolean and r -> 'job' ->> 'assigned_via' = 'manager'
                          and lower(r -> 'job' ->> 'assignee_email') = lower(neo_test.email('tech1')),
                          'A16: an "Emergency:" reason lets a lead assign an unclaimed on-site ticket');
  r := public.service_assign(v_id, neo_test.email('tech2'), 'Swap', null);
  perform neo_test.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'changed'
                          and lower(r ->> 'by_email') = lower(neo_test.email('tech1')) and r ? 'at',
                          'A16: an assign based on a stale screen answers changed, naming who has it');
  perform neo_test.assert(lower((select assignee_email from public.service_jobs where id = v_id)) = lower(neo_test.email('tech1')),
                          'A16: the stale assign changed nothing');
end $$;

select neo_test.login('tech1');
do $$
declare r jsonb;
begin
  r := public.service_claim(neo_test.get('job_gate'));
  perform neo_test.assert((r ->> 'ok')::boolean and (r ->> 'already')::boolean,
                          'A17: claiming a ticket a lead already gave me answers ok');
end $$;

select neo_test.login('desk');
do $$
declare r jsonb;
begin
  r := public.service_move(neo_test.get('job_gate'), 'logged', 'scheduled', null, true,
                           jsonb_build_object('visit_start', now() + interval '1 hour', 'visit_end', now() + interval '2 hours'));
  perform neo_test.assert(r ->> 'stage' = 'scheduled', 'the desk books the visit');
end $$;

select neo_test.login('tech1');
do $$
declare r jsonb; v_id text := neo_test.get('job_gate'); v_job public.service_jobs;
begin
  r := public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'departed', 'outcome', 'done',
                                                       'ref_type', 'service_job', 'ref_id', v_id, 'at', now()));
  select * into v_job from public.service_jobs where id = v_id;
  perform neo_test.assert((r ->> 'applied')::boolean and r ->> 'stage' = 'work_done' and v_job.stage = 'work_done',
                          'A18: a check-out straight from scheduled finishes the visit');
  perform neo_test.assert(v_job.visit_count = 1, 'A18: the missing check-in still counts the visit');
  perform neo_test.assert(exists (select 1 from public.service_events e where e.job_id = v_id
                                   and e.body = 'Check-in was not recorded — assumed.' and not e.customer_visible),
                          'A18: the timeline says the check-in was assumed');
  r := public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'departed', 'outcome', 'done',
                                                       'ref_type', 'service_job', 'ref_id', v_id, 'at', now()));
  perform neo_test.assert(not (r ->> 'applied')::boolean and r ->> 'applied_note' like 'No change: ticket is at Work done%',
                          'A18: a second check-out after the visit is stored but changes nothing');
end $$;


-- ── 6c. Only the RPCs change who has a ticket; history is v1.9.11's shape ───
select neo_test.login('tech2');
do $$
declare v_id text := neo_test.get('job_gate');
begin
  -- job_gate is tech1's (a lead assigned it in 6b).
  perform neo_test.expect_error(format('update public.service_jobs set assignee_email = %L, assignee = %L where id = %L',
                                       neo_test.email('tech2'), 'Adhil', v_id),
                                '%NEO_DENIED: Take, hand back or assign the ticket with its own buttons%');
  perform neo_test.expect_error(format('update public.service_jobs set assignee = %L where id = %L', 'Adhil', v_id),
                                '%NEO_DENIED%');
  perform neo_test.expect_error(format('update public.service_jobs set assignee_email = null, assignee = null where id = %L', v_id),
                                '%NEO_DENIED%');
  perform neo_test.assert(lower((select assignee_email from public.service_jobs where id = v_id)) = lower(neo_test.email('tech1')),
                          'a technician cannot take a colleague''s ticket with a direct write');

  -- History: a direct row has v1.9.11's shape, in the writer's own name.
  insert into public.service_events (job_id, kind, actor_kind, actor_email, actor_name, body, customer_visible)
  values (v_id, 'note', 'staff', neo_test.email('tech2'), 'Adhil', 'Checked the spare router stock', false);
  perform neo_test.expect_error(format($q$insert into public.service_events (job_id, kind, actor_kind, actor_email, body, meta)
                                          values (%L, 'claim', 'staff', %L, 'Taken', jsonb_build_object('tech_email', %L))$q$,
                                       v_id, neo_test.email('tech2'), neo_test.email('tech2')),
                                '%row-level security%');
  perform neo_test.expect_error(format($q$insert into public.service_events (job_id, kind, actor_kind, actor_email, body, meta)
                                          values (%L, 'note', 'staff', %L, 'x', jsonb_build_object('tech_email', %L, 'by_email', %L))$q$,
                                       v_id, neo_test.email('tech2'), neo_test.email('tech1'), neo_test.email('tech1')),
                                '%row-level security%');
  perform neo_test.expect_error(format($q$insert into public.service_events (job_id, kind, actor_kind, actor_email, body)
                                          values (%L, 'note', 'staff', %L, 'Signed as someone else')$q$,
                                       v_id, neo_test.email('tech1')),
                                '%row-level security%');
end $$;

select neo_test.login('desk');
do $$
begin
  -- A direct insert carries only what v1.9.11 sends; the desk never assigns.
  perform neo_test.expect_error(format($q$insert into public.service_jobs (id, public_code, job_kind, origin, stage, customer_name,
                                            customer_phone, reported_fault, intake, details, subject, assignee, assignee_email)
                                          values ('s_test_direct_01', 'NT-TESTDRC1', 'repair_outside', 'counter', 'received', 'X',
                                                  '9000000113', 'x', '{}', '{}', '{}', 'Athul', %L)$q$, neo_test.email('tech1')),
                                '%NEO_DENIED: Create the ticket with New ticket%');
  perform neo_test.expect_error($q$insert into public.service_jobs (id, public_code, job_kind, origin, stage, customer_name,
                                     customer_phone, reported_fault, intake, details, subject, priority)
                                   values ('s_test_direct_02', 'NT-TESTDRC2', 'repair_outside', 'counter', 'received', 'X',
                                           '9000000113', 'x', '{}', '{}', '{}', 'urgent')$q$,
                                '%NEO_DENIED: Create the ticket with New ticket%');
  perform neo_test.expect_error(format('update public.service_jobs set assignee_email = %L, assignee = %L where id = %L',
                                       neo_test.email('sales'), 'Kiran', neo_test.get('job_store')),
                                '%NEO_DENIED%');
end $$;


-- ── 6d. Customer absent: the booked time is spent; the ticket waits to be rebooked ─
do $$
declare r jsonb;
begin
  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'service_type', 'on_site', 'channel', 'phone',
         'customer_name', 'Test Absent Customer', 'customer_phone', '9000000114', 'reported_fault', 'No internet',
         'site_area', 'Kaloor'));
  perform neo_test.put('job_absent', r ->> 'id');
end $$;

select neo_test.login('tech1');
do $$
declare r jsonb; v_id text := neo_test.get('job_absent'); v_job public.service_jobs;
begin
  r := public.service_claim(v_id, now() + interval '1 hour', now() + interval '2 hours', null);
  perform neo_test.assert((r ->> 'ok')::boolean and r -> 'job' ->> 'stage' = 'scheduled', 'customer absent: the visit is booked');
  r := public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'departed',
                                                       'outcome', 'customer_absent', 'ref_type', 'service_job', 'ref_id', v_id,
                                                       'at', now()));
  select * into v_job from public.service_jobs where id = v_id;
  perform neo_test.assert((r ->> 'applied')::boolean and v_job.stage = 'revisit_needed',
                          format('customer absent: the ticket waits for a new booking (got %s)', v_job.stage));
  perform neo_test.assert(v_job.visit_start is null and v_job.visit_end is null,
                          'customer absent: the spent visit time is cleared, so nothing reads it as a late visit');
  perform neo_test.assert(exists (select 1 from public.service_events e where e.job_id = v_id and e.customer_visible
                                   and e.body = 'We missed you at the visit — we''ll call you to book another time.'),
                          'customer absent: the customer is told we will call to rebook');
end $$;


-- ── 6e. A claim at another time than the desk booked tells the customer ─────
select neo_test.login('desk');
do $$
declare r jsonb; v_at timestamptz := date_trunc('hour', now()) + interval '1 day 2 hours';
begin
  perform neo_test.put('rebook_at', v_at::text);
  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'service_type', 'on_site', 'channel', 'phone',
         'customer_name', 'Test Rebook Customer', 'customer_phone', '9000000117', 'reported_fault', 'Wi-Fi keeps dropping',
         'site_area', 'Panampilly Nagar'));
  perform neo_test.put('job_rebook', r ->> 'id');
  perform neo_test.put('code_rebook', r ->> 'public_code');
  r := public.service_move(r ->> 'id', 'logged', 'scheduled', null, true,
                           jsonb_build_object('visit_start', v_at, 'visit_end', v_at + interval '2 hours'));
  perform neo_test.assert(r ->> 'stage' = 'scheduled' and r ->> 'assignee_email' is null,
                          'the desk books a visit on an on-site ticket nobody has claimed yet');

  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'service_type', 'remote', 'channel', 'phone',
         'customer_name', 'Test Remote Rebook', 'customer_phone', '9000000118', 'reported_fault', 'Outlook will not open'));
  perform neo_test.put('job_rebook_remote', r ->> 'id');
  r := public.service_move(r ->> 'id', 'logged', 'session_booked', null, true,
                           jsonb_build_object('visit_start', v_at, 'visit_end', v_at + interval '1 hour'));
  perform neo_test.assert(r ->> 'stage' = 'session_booked', 'the desk books a remote session');

  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'service_type', 'on_site', 'channel', 'phone',
         'customer_name', 'Test Same Time Customer', 'customer_phone', '9000000119', 'reported_fault', 'Printer offline',
         'site_area', 'Kadavanthra'));
  perform neo_test.put('job_sametime', r ->> 'id');
  perform public.service_move(r ->> 'id', 'logged', 'scheduled', null, true,
                              jsonb_build_object('visit_start', v_at, 'visit_end', v_at + interval '2 hours'));
end $$;

select neo_test.login('tech1');
do $$
declare
  r jsonb; v_id text := neo_test.get('job_rebook'); v_job public.service_jobs; n bigint;
  v_was timestamptz := neo_test.get('rebook_at')::timestamptz;
  v_new timestamptz := neo_test.get('rebook_at')::timestamptz + interval '3 hours';
  v_words text := to_char(v_new at time zone 'Asia/Kolkata', 'Dy FMDD Mon, FMHH12:MI am');
begin
  r := public.service_claim(v_id, v_new, v_new + interval '2 hours', null);
  select * into v_job from public.service_jobs where id = v_id;
  perform neo_test.assert((r ->> 'ok')::boolean and v_job.stage = 'scheduled' and v_job.visit_start = v_new,
                          'a claim at a new time keeps the ticket scheduled and stores the new time');
  perform neo_test.assert(exists (select 1 from public.service_events e where e.job_id = v_id and e.kind = 'stage'
                                   and e.customer_visible and e.from_stage is null and e.to_stage is null
                                   and e.body = 'Visit moved to ' || v_words || '.'
                                   and (e.meta ->> 'visit_was')::timestamptz = v_was),
                          format('the customer is told the visit moved, in India time (expected "Visit moved to %s.")', v_words));
  perform neo_test.assert(exists (select 1 from public.service_events e where e.job_id = v_id and e.kind = 'claim'
                                   and not e.customer_visible and e.body like 'Taken by % — visit moved from % to ' || v_words),
                          'the internal claim line records the old and the new time');
  perform neo_test.assert(not exists (select 1 from public.service_events e where e.job_id = v_id
                                       and e.body like 'Visit booked for%' and e.actor_email = neo_test.email('tech1')),
                          'a moved visit is not announced as a new booking');
  -- A retry of the same claim (already mine) moves nothing and says nothing.
  r := public.service_claim(v_id, v_new + interval '1 hour', null, null);
  perform neo_test.assert((r ->> 'ok')::boolean and (r ->> 'already')::boolean
                          and (select visit_start from public.service_jobs where id = v_id) = v_new,
                          'a repeated claim keeps the time the first claim set');
  select count(*) into n from public.service_events e where e.job_id = v_id and e.body like 'Visit moved to%';
  perform neo_test.assert(n = 1, 'the visit-moved line is written once');

  -- Remote: the session moved.
  r := public.service_claim(neo_test.get('job_rebook_remote'), v_new, v_new + interval '1 hour', null);
  perform neo_test.assert((r ->> 'ok')::boolean and r -> 'job' ->> 'stage' = 'session_booked'
                          and exists (select 1 from public.service_events e where e.job_id = neo_test.get('job_rebook_remote')
                                       and e.customer_visible and e.body = 'Remote session moved to ' || v_words || '.'),
                          'a remote session claimed at a new time tells the customer the session moved');

  -- Same time as booked: nothing new for the customer.
  r := public.service_claim(neo_test.get('job_sametime'), v_was, v_was + interval '2 hours', null);
  perform neo_test.assert((r ->> 'ok')::boolean
                          and not exists (select 1 from public.service_events e where e.job_id = neo_test.get('job_sametime')
                                           and (e.body like '%moved%' or (e.customer_visible and e.actor_email = neo_test.email('tech1')))),
                          'a claim at the booked time writes no customer line');
end $$;

select neo_test.login_anon();
do $$
declare r jsonb;
begin
  r := public.get_service_public(neo_test.get('code_rebook'), '0117');
  perform neo_test.assert((r ->> 'visit_start')::timestamptz = neo_test.get('rebook_at')::timestamptz + interval '3 hours'
                          and exists (select 1 from jsonb_array_elements(r -> 'events') as e(value)
                                       where e.value ->> 'body' like 'Visit moved to %'),
                          'the tracking page shows the new time and the visit-moved line');
end $$;


-- ── 7. A lead may override with a reason (compare-and-set on the assignee) ──
select neo_test.login('owner');
do $$
declare r jsonb; v_id text := neo_test.get('job_onsite');
begin
  perform neo_test.expect_error(format('select public.service_assign(%L, %L, %L, %L)', v_id, neo_test.email('tech2'), '',
                                       neo_test.email('tech1')),
                                '%NEO_GATE: Say why%');
  perform neo_test.expect_error(format('select public.service_assign(%L, %L, %L, %L)', v_id, neo_test.email('sales'), 'Test',
                                       neo_test.email('tech1')),
                                '%NEO_GATE%can''t take service tickets%');
  r := public.service_assign(v_id, neo_test.email('tech2'), 'Nearer to the site', null);
  perform neo_test.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'changed',
                          'A16: expecting "unassigned" on a claimed ticket is refused as changed');
  r := public.service_assign(v_id, neo_test.email('tech2'), 'Nearer to the site', upper(neo_test.email('tech1')));
  perform neo_test.assert((r ->> 'ok')::boolean and lower(r -> 'job' ->> 'assignee_email') = lower(neo_test.email('tech2'))
                          and r -> 'job' ->> 'assigned_via' = 'manager', 'a lead assignment overrides the claim');
  perform neo_test.assert(exists (select 1 from public.service_events e where e.job_id = v_id and e.kind = 'assign'
                                   and lower(e.meta ->> 'from_email') = lower(neo_test.email('tech1'))),
                          'the assign event names the previous technician');
end $$;


-- ── 8. Release rules ────────────────────────────────────────────────────────
select neo_test.login('tech1');
do $$
begin
  perform neo_test.expect_error(format('select public.service_release(%L, %L)', neo_test.get('job_onsite'), 'Busy'),
                                '%NEO_DENIED%');
end $$;

select neo_test.login('tech2');
do $$
declare r jsonb; v_id text := neo_test.get('job_onsite');
begin
  perform neo_test.expect_error(format('select public.service_release(%L, %L)', v_id, ''),
                                '%NEO_GATE: Say why you''re handing it back%');
  r := public.service_release(v_id, 'Clashes with another visit');
  perform neo_test.assert((r ->> 'ok')::boolean and r -> 'job' ->> 'assignee_email' is null, 'the assignee can hand a ticket back');
  perform neo_test.assert(r -> 'job' ->> 'stage' = 'logged' and r -> 'job' ->> 'visit_start' is null
                          and r -> 'job' ->> 'queued_at' is not null,
                          'release from scheduled goes back to logged, clears the visit and re-queues');
end $$;

select neo_test.login('tech1');
do $$
declare r jsonb; v_id text := neo_test.get('job_onsite');
begin
  r := public.service_claim(v_id);
  perform neo_test.assert((r ->> 'ok')::boolean and r -> 'job' ->> 'stage' = 'logged', 'a claim without a visit time keeps the stage');
  r := public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'left_base',
                                                       'ref_type', 'service_job', 'ref_id', v_id, 'at', now(), 'source', 'desktop'));
  perform neo_test.assert((r ->> 'applied')::boolean and r ->> 'stage' = 'en_route', 'left_base moves the ticket to en_route');
  perform neo_test.expect_error(format('select public.service_release(%L, %L)', v_id, 'Car broke down'),
                                '%NEO_GATE: You''re on the way or on site%');
end $$;

select neo_test.login('owner');
do $$
declare r jsonb;
begin
  r := public.service_release(neo_test.get('job_onsite'), 'Reassigning after a breakdown');
  perform neo_test.assert((r ->> 'ok')::boolean and r -> 'job' ->> 'assignee_email' is null and r -> 'job' ->> 'stage' = 'en_route',
                          'a lead may release an en-route ticket');
end $$;


-- ── 9. Field activity is idempotent; tech_activity (A24) ────────────────────
select neo_test.login('tech1');
do $$
declare
  r jsonb; r2 jsonb; v_id text := neo_test.get('job_onsite'); v_crid uuid := gen_random_uuid(); n bigint;
  v_job public.service_jobs;
begin
  r := public.service_claim(v_id);
  perform neo_test.assert((r ->> 'ok')::boolean, 'the tech can claim again after the lead released it');

  r := public.record_field_activity(jsonb_build_object('client_request_id', v_crid, 'kind', 'arrived', 'ref_type', 'service_job',
                                                       'ref_id', v_id, 'at', now(), 'lat', 10.0159, 'lng', 76.3419,
                                                       'accuracy_m', 12, 'source', 'neohr'));
  perform neo_test.assert((r ->> 'applied')::boolean and r ->> 'stage' = 'on_site', 'arrived moves en_route -> on_site');
  r2 := public.record_field_activity(jsonb_build_object('client_request_id', v_crid, 'kind', 'arrived', 'ref_type', 'service_job',
                                                        'ref_id', v_id, 'at', now(), 'source', 'neohr'));
  perform neo_test.assert((r2 ->> 'duplicate')::boolean and r2 ->> 'id' = r ->> 'id', 'the same client_request_id is recorded once');

  select * into v_job from public.service_jobs where id = v_id;
  perform neo_test.assert(v_job.visit_count = 1, 'visit_count incremented exactly once');
  select count(*) into n from public.field_activity where client_request_id = v_crid;
  perform neo_test.assert(n = 1, 'one field_activity row for the repeated request');
  select count(*) into n from public.service_events e where e.job_id = v_id and e.kind = 'field' and e.to_stage = 'on_site';
  perform neo_test.assert(n = 1, 'one field event for the repeated request');

  perform neo_test.expect_error($q$select public.record_field_activity('{"kind":"arrived"}'::jsonb)$q$,
                                '%NEO_GATE: client_request_id is required%');
end $$;

select neo_test.login('tech2');
do $$
declare r jsonb;
begin
  r := public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'departed', 'outcome', 'done',
                                                       'ref_type', 'service_job', 'ref_id', neo_test.get('job_onsite'), 'at', now()));
  perform neo_test.assert(not (r ->> 'applied')::boolean and r ->> 'applied_note' like 'No change: this ticket is with%',
                          'another technician''s check-out is stored but does not move the ticket');
end $$;

select neo_test.login('tech1');
do $$
declare r jsonb; v_id text := neo_test.get('job_onsite');
begin
  r := public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'departed', 'outcome', 'done',
                                                       'ref_type', 'service_job', 'ref_id', v_id, 'at', now(),
                                                       'note', 'Replaced the router; the customer was impatient'));
  perform neo_test.assert((r ->> 'applied')::boolean and r ->> 'stage' = 'work_done', 'departed + done moves on_site -> work_done');
  perform neo_test.assert(not exists (select 1 from public.service_events e where e.job_id = v_id and e.customer_visible
                                       and e.body like '%impatient%'),
                          'a technician''s field note is never published to the customer');
  perform neo_test.assert(exists (select 1 from public.service_events e where e.job_id = v_id and not e.customer_visible
                                   and e.body like '%impatient%'),
                          'the field note is kept as an internal note');
  r := public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'arrived',
                                                       'ref_type', 'service_job', 'ref_id', v_id, 'at', now()));
  perform neo_test.assert(not (r ->> 'applied')::boolean and r ->> 'applied_note' like 'No change: ticket is at%',
                          'a check-in that does not fit the stage is recorded but changes nothing');

  -- A24: the activity report is an RPC; a technician sees only their own rows.
  r := public.tech_activity(null, null);
  perform neo_test.assert(exists (select 1 from jsonb_array_elements(r) as e(value)
                                   where e.value ->> 'employee_email' = lower(neo_test.email('tech1'))
                                     and (e.value ->> 'visits_arrived')::int >= 1 and (e.value ->> 'visits_done')::int >= 1
                                     and (e.value ->> 'claims')::int >= 1),
                          'tech_activity counts my claims, arrivals and finished visits');
  perform neo_test.assert(not exists (select 1 from jsonb_array_elements(r) as e(value)
                                       where e.value ->> 'employee_email' <> lower(neo_test.email('tech1'))),
                          'A24: a technician gets only their own activity rows');
  perform neo_test.expect_error($q$select public.tech_activity('2026-01-10', '2026-01-01')$q$, '%NEO_GATE%');
end $$;

select neo_test.login('owner');
do $$
declare r jsonb;
begin
  r := public.tech_activity((now() at time zone 'Asia/Kolkata')::date - 1, (now() at time zone 'Asia/Kolkata')::date + 1);
  perform neo_test.assert(exists (select 1 from jsonb_array_elements(r) as e(value)
                                   where e.value ->> 'employee_email' = lower(neo_test.email('tech2'))),
                          'A24: a lead sees everyone''s activity');
end $$;


-- ── 10. RMA from a ticket: the ticket follows its parts ─────────────────────
select neo_test.login('desk');
do $$
declare
  r jsonb; v_job text := neo_test.get('job_store'); v_ua text; v_ub text; v_va bigint; v_vb bigint; n bigint;
begin
  r := public.rma_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'source', 'from_ticket', 'service_job_id', v_job,
         'holds_ticket', true, 'in_hand', true,
         'units', jsonb_build_array(
           jsonb_build_object('kind', 'gpu', 'brand', 'ASUS', 'model', 'TUF RTX 4070', 'serial', 'GPU-TEST-0001',
                              'fault', 'Artifacts under load', 'diagnosed_by', 'us', 'purchase_source', 'neo_tokyo',
                              'service_item_id', neo_test.get('item_gpu')),
           jsonb_build_object('kind', 'psu', 'brand', 'Corsair', 'model', 'RM750', 'serial', 'PSU-TEST-0002',
                              'fault', 'Clicks and shuts off', 'diagnosed_by', 'us', 'purchase_source', 'neo_tokyo'))));
  perform neo_test.assert(jsonb_array_length(r -> 'units') = 2, 'rma_create from a ticket makes one case per part');
  v_ua := r -> 'units' -> 0 ->> 'id';
  v_ub := r -> 'units' -> 1 ->> 'id';
  perform neo_test.put('unit_a', v_ua);
  perform neo_test.put('unit_b', v_ub);
  perform neo_test.put('code_unit_a', r -> 'units' -> 0 ->> 'public_code');
  perform neo_test.assert(neo_test.jstage(v_job) = 'rma_raised', 'holding parts move the ticket to rma_raised');
  perform neo_test.assert((select count(*) from public.service_events e where e.job_id = v_job and e.kind = 'stage'
                            and e.meta ->> 'source' = 'rma_sync') = 1
                          and exists (select 1 from public.service_events e where e.job_id = v_job and e.kind = 'stage'
                                       and e.meta ->> 'source' = 'rma_sync' and e.customer_visible
                                       and e.body like 'Warranty claim raised: Graphics card (RM-%), Power supply (RM-%).'),
                          'rma_create moves the ticket once, naming every held part in one customer line');
  perform neo_test.assert((select return_method from public.rma_cases where id = v_ua) = 'with_device'
                          and (select fee_status from public.rma_cases where id = v_ua) = 'n_a',
                          'a held part from a ticket goes back with the device, with no fee');
  select count(*) into n from public.service_events e where e.job_id = v_job and e.kind = 'rma';
  perform neo_test.assert(n >= 2, 'RMA events are mirrored onto the ticket timeline');
  perform neo_test.assert(not exists (select 1 from public.service_events e where e.job_id = v_job and e.kind = 'rma'
                                       and (e.to_stage is not null or e.from_stage is not null)),
                          'A7: mirrored events carry no RMA stage keys');

  -- the ticket cannot leave the mirror stage or finish while the parts are out
  perform neo_test.expect_error(format('select public.service_move(%L, %L, %L)', v_job, 'rma_raised', 'in_service'),
                                '%NEO_RMA_HOLD: This ticket is waiting on RMA%update the app on this PC%');
  perform neo_test.expect_error(format('select public.service_move(%L, %L, %L, null, true, %L::jsonb)',
                                       v_job, 'rma_raised', 'ready', '{"outcome":"repaired"}'), '%NEO_RMA_HOLD%');
  -- (an old client's direct write gets the same answer)
  perform neo_test.expect_error(format('update public.service_jobs set stage = %L, outcome = %L where id = %L',
                                       'ready', 'repaired', v_job), '%NEO_RMA_HOLD%');

  -- RMA stage is RPC-only; descriptive columns are editable
  perform neo_test.expect_error(format('update public.rma_cases set stage = %L where id = %L', 'testing', v_ua), '%permission denied%');
  perform neo_test.expect_error(format('update public.rma_cases set fee_status = %L where id = %L', 'waived', v_ua), '%permission denied%');
  perform neo_test.expect_error(format('insert into public.rma_events (case_id, body) values (%L, %L)', v_ua, 'x'), '%permission denied%');

  -- gates
  perform neo_test.expect_error(format('select public.rma_move(%L, %L, %L)', v_ua, 'received', 'ready_to_ship'),
                                '%NEO_GATE%serial label%');
  perform neo_test.expect_error(format('select public.rma_move(%L, %L, %L)', v_ua, 'received', 'with_vendor'),
                                '%NEO_GATE: Use Dispatch%');

  -- The desk may add vendors (kind included). Vendor A is a DISTRIBUTOR: its
  -- name must never reach a customer (A13).
  insert into public.rma_vendors (name, public_name, kind, typical_tat_days)
  values ('ZZ Test Vendor A', 'Vendor Alpha', 'distributor', 10) returning id into v_va;
  insert into public.rma_vendors (name, public_name, kind, typical_tat_days)
  values ('ZZ Test Vendor B', 'Vendor Beta', 'brand', 20) returning id into v_vb;
  perform neo_test.put('vendor_a', v_va::text);
  perform neo_test.put('vendor_b', v_vb::text);

  perform neo_test.prep_ship(v_ua, v_va);
  perform neo_test.prep_ship(v_ub, v_vb);
  perform neo_test.expect_error(format('update public.service_media set customer_visible = true where rma_case_id = %L', v_ua),
                                '%service_media_private_roles%');

  r := public.rma_move(v_ua, 'received', 'ready_to_ship');
  perform neo_test.assert(r ->> 'stage' = 'ready_to_ship', 'gates pass once serial, label photo, source and vendor are there');
  r := public.rma_move(v_ub, 'received', 'ready_to_ship');
  perform neo_test.assert(neo_test.jstage(v_job) = 'rma_raised',
                          'the ticket stays at rma_raised while parts are being prepared');
end $$;


-- ── 11. Dispatch (A9): courier needs an AWB, hand delivery needs a carrier ───
do $$
declare
  r jsonb; v_job text := neo_test.get('job_store'); v_ua text := neo_test.get('unit_a'); v_ub text := neo_test.get('unit_b');
  v_sj public.service_jobs; v_ship bigint;
begin
  perform neo_test.expect_error(format('select public.rma_dispatch(array[%L, %L], %s, %L, %L, %L)',
                                       v_ua, v_ub, neo_test.get('vendor_a'), 'courier', 'DTDC', 'AWB-X'),
                                '%NEO_GATE%is set for%');
  perform neo_test.expect_error(format('select public.rma_dispatch(array[%L], %s, %L, %L)', v_ua, neo_test.get('vendor_a'), 'courier', 'DTDC'),
                                '%NEO_GATE: Enter the AWB%');
  perform neo_test.expect_error(format('select public.rma_dispatch(array[%L], %s, %L)', v_ub, neo_test.get('vendor_b'), 'hand_delivery'),
                                '%NEO_GATE: Say who carried it, or add a note%');

  r := public.rma_dispatch(array[v_ua], neo_test.get('vendor_a')::bigint, 'courier', 'DTDC', 'AWB-TEST-1', 150, null, null);
  v_ship := (r ->> 'shipment_id')::bigint;
  perform neo_test.assert(r -> 'units' -> 0 ->> 'stage' = 'with_vendor' and r ->> 'mode' = 'courier',
                          'dispatch moves the part to with_vendor');
  perform neo_test.assert(neo_test.jstage(v_job) = 'rma_raised', 'one part still at the shop keeps the ticket at rma_raised');
  perform neo_test.assert((select count(*) from public.service_events e where e.job_id = v_job and e.kind = 'rma'
                            and (e.meta ->> 'shipment_id')::bigint = v_ship and e.customer_visible) = 1,
                          'A9: one ticket-timeline line per ticket per dispatch');
  perform neo_test.assert(not exists (select 1 from public.service_events e
                                       join public.rma_events re on re.id::text = e.meta ->> 'rma_event_id'
                                      where re.case_id = v_ua and re.to_stage = 'with_vendor'),
                          'A9: the per-part dispatch events are not mirrored one by one');

  -- hand delivery: no AWB, but who carried it
  r := public.rma_dispatch(array[v_ub], neo_test.get('vendor_b')::bigint, 'hand_delivery', null, null, null, null, 'Test Runner');
  perform neo_test.assert(exists (select 1 from public.rma_shipments s where s.id = (r ->> 'shipment_id')::bigint
                                   and s.mode = 'hand_delivery' and s.carried_by = 'Test Runner' and s.awb is null),
                          'A9: a hand delivery is recorded without an AWB, with who carried it');
  select * into v_sj from public.service_jobs where id = v_job;
  perform neo_test.assert(v_sj.stage = 'at_vendor', 'both parts at vendors: the ticket is at_vendor');
  perform neo_test.assert(v_sj.waiting_party = 'ASUS and Corsair',
                          format('A13: waiting_party names the brands, never the distributor (got %s)', coalesce(v_sj.waiting_party, 'null')));
  perform neo_test.assert(v_sj.next_chase_at = (select expected_back_at from public.rma_cases where id = v_ua),
                          'next_chase_at is the earliest expected return');
  perform neo_test.assert(exists (select 1 from public.rma_shipments s join public.rma_shipment_items si on si.shipment_id = s.id
                                   where si.case_id = v_ua and s.direction = 'out_to_vendor' and s.awb = 'AWB-TEST-1'),
                          'dispatch records the outbound shipment');
  perform neo_test.assert(not exists (select 1 from public.service_events e where e.job_id = v_job and e.customer_visible
                                       and e.body like '%Vendor Alpha%'),
                          'A13: the distributor''s name is in no customer-visible line');
end $$;


-- ── 11b. A13: a part with no brand sent to a distributor names nobody ───────
do $$
declare r jsonb; v_u text;
begin
  r := public.rma_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'source', 'walk_in', 'sender_kind', 'customer',
         'sender_name', 'Test Nobrand Customer', 'sender_phone', '9000000116', 'in_hand', true,
         'units', jsonb_build_array(jsonb_build_object('kind', 'gpu', 'model', 'RTX 3050 6GB', 'serial', 'NB-TEST-0001',
                                                       'fault', 'Black screen', 'purchase_source', 'neo_tokyo'))));
  v_u := r -> 'units' -> 0 ->> 'id';
  perform neo_test.put('code_unit_nobrand', r -> 'units' -> 0 ->> 'public_code');
  perform neo_test.prep_ship(v_u, neo_test.get('vendor_a')::bigint);
  r := public.rma_move(v_u, 'received', 'ready_to_ship');
  r := public.rma_dispatch(array[v_u], neo_test.get('vendor_a')::bigint, 'courier', 'DTDC', 'AWB-NB-1', null, null, null);
  perform neo_test.assert(exists (select 1 from public.rma_events e where e.case_id = v_u and e.customer_visible
                                   and e.body like 'Sent to the manufacturer under warranty%')
                          and not exists (select 1 from public.rma_events e where e.case_id = v_u and e.customer_visible
                                           and e.body like '%Vendor Alpha%'),
                          'A13: a part with no brand sent to a distributor is "sent to the manufacturer"');
end $$;


-- ── 12. A2: mixed results — one back rejected, one still away ────────────────
do $$
declare r jsonb; v_job text := neo_test.get('job_store'); v_sj public.service_jobs;
begin
  r := public.rma_vendor_result(neo_test.get('unit_a'), 'rejected', 'Physical damage on the PCB', null, null, null, null);
  perform neo_test.assert(r ->> 'stage' = 'back_from_vendor', 'a vendor result moves the part back');
  select * into v_sj from public.service_jobs where id = v_job;
  perform neo_test.assert(v_sj.stage = 'at_vendor' and v_sj.waiting_party = 'Corsair',
                          format('A2: one back rejected, one away: the ticket stays at_vendor, naming who still has a part (got %s / %s)',
                                 v_sj.stage, coalesce(v_sj.waiting_party, 'null')));
  perform neo_test.expect_error(format('select public.service_move(%L, %L, %L)', v_job, 'at_vendor', 'in_service'),
                                '%NEO_RMA_HOLD: This ticket is waiting on RMA%');
  perform neo_test.expect_error(format('select public.rma_vendor_result(%L, %L)', neo_test.get('unit_b'), 'replaced'),
                                '%NEO_GATE: Type the serial of the replacement part%');
  r := public.rma_vendor_result(neo_test.get('unit_b'), 'replaced', null, 'PSU-NEW-7777', null, null, null);
  select * into v_sj from public.service_jobs where id = v_job;
  perform neo_test.assert(v_sj.stage = 'back_from_vendor' and v_sj.waiting_party is null,
                          'A2: both parts back: the ticket is back_from_vendor');
  perform neo_test.assert(exists (select 1 from public.rma_cases where id = neo_test.get('unit_b')
                                   and replacement_serial_norm = 'PSUNEW7777'),
                          'A15: the replacement serial is normalised for search');
end $$;


-- ── 13. Public tracking leaks nothing private ───────────────────────────────
select neo_test.login_anon();
do $$
declare r jsonb; v_txt text;
begin
  perform neo_test.assert(public.get_service_public(neo_test.get('code_store'), '0000') is null, 'wrong phone digits give null');
  r := public.get_service_public(lower(neo_test.get('code_store')), '0103');
  perform neo_test.assert(r is not null, 'get_service_public finds the ticket (the code is case-insensitive)');
  perform neo_test.assert(r ->> 'customer_name' = 'Test Store Customer', 'get_service_public keeps the full customer name');
  perform neo_test.assert(jsonb_array_length(r -> 'rma_units') = 2, 'get_service_public includes rma_units');
  perform neo_test.assert(exists (select 1 from jsonb_array_elements(r -> 'rma_units') as e(value)
                                   where e.value ->> 'label' like 'Graphics card%ASUS%'),
                          'an rma unit label is kind + brand + model');
  perform neo_test.assert(not exists (select 1 from jsonb_array_elements(r -> 'rma_units') as e(value)
                                       where jsonb_typeof(e.value -> 'holds_ticket') is distinct from 'boolean'
                                          or not (e.value ->> 'holds_ticket')::boolean),
                          'A23: rma_units says each part holds the ticket (holds_ticket is a boolean)');
  perform neo_test.assert((r -> 'events' -> 0 ->> 'at')::timestamptz >= (r -> 'events' -> -1 ->> 'at')::timestamptz,
                          'events are newest first');
  v_txt := r::text;
  perform neo_test.assert(v_txt not like '%GPU-TEST-0001%' and v_txt not like '%PSU-NEW-7777%' and v_txt not like '%9000000103%',
                          'get_service_public leaks no serial and no phone');
  perform neo_test.assert(v_txt not like '%Vendor Alpha%', 'A13: get_service_public never names the distributor');
  perform neo_test.assert(not (r ? 'customer_phone') and not (r ? 'diagnosis') and not (r ? 'customer_email'),
                          'get_service_public has no private keys');
  perform neo_test.assert(r ? 'stage' and r ? 'stage_since' and r ? 'waiting_party' and r ? 'device_label' and r ? 'job_kind'
                          and r ? 'customer_name' and r ? 'promised_at' and r ? 'outcome' and r ? 'handled_by'
                          and r ? 'events' and r ? 'service_type' and r ? 'visit_start' and r ? 'visit_end',
                          'get_service_public keeps every key the website reads and adds the new ones');
  perform neo_test.assert(jsonb_array_length(r -> 'events') >= 1, 'customer-visible events are included');

  r := public.get_rma_public(neo_test.get('code_unit_a'), '0103');
  perform neo_test.assert(r is not null and r ->> 'stage' = 'back_from_vendor',
                          'get_rma_public finds the part by the ticket customer''s phone');
  v_txt := r::text;
  perform neo_test.assert(v_txt not like '%GPU-TEST-0001%' and not (r ? 'serial') and not (r ? 'handling_fee')
                          and not (r ? 'vendor_rma_no') and not (r ? 'owner_phone') and v_txt not like '%Vendor Alpha%',
                          'get_rma_public returns no serial, fee, phone, vendor RMA number or distributor');
  perform neo_test.assert(r ->> 'linked_job_code' = neo_test.get('code_store') and r ->> 'vendor_result' = 'rejected',
                          'get_rma_public links the ticket and shows the vendor result');
  perform neo_test.assert(public.get_rma_public(neo_test.get('code_unit_a'), '9999') is null, 'get_rma_public: wrong phone gives null');
  r := public.get_rma_public(neo_test.get('code_unit_nobrand'), '0116');
  perform neo_test.assert(r is not null and r ->> 'stage' = 'with_vendor' and r ->> 'waiting_party' is null
                          and r::text not like '%Vendor Alpha%',
                          'A13: get_rma_public never falls back to a distributor''s name');
  r := public.get_rma_public(neo_test.get('code_unit_sales'), '0102');
  perform neo_test.assert(r is not null and r ->> 'stage' = 'logged' and r::text not like '%SSD-TEST-0001%',
                          'an expected part is trackable without its serial');
end $$;


-- ── 14. Closing the ticket settles the parts that went back in the device ───
select neo_test.login('desk');
do $$
declare r jsonb; v_job text := neo_test.get('job_store');
begin
  r := public.service_move(v_job, 'back_from_vendor', 'in_service');
  r := public.service_move(v_job, 'in_service', 'verifying');
  r := public.service_move(v_job, 'verifying', 'ready', null, true, '{"outcome":"repaired"}'::jsonb);
  perform neo_test.assert(r ->> 'stage' = 'ready' and r ->> 'outcome' = 'repaired' and r ->> 'ready_at' is not null,
                          'A2: the ticket moves on once every held part is back');
  r := public.service_move(v_job, 'ready', 'closed');
  perform neo_test.assert(r ->> 'stage' = 'closed' and r ->> 'outcome' = 'repaired' and r ->> 'closed_by' is not null,
                          'the ticket closes, carrying its outcome');
  perform neo_test.assert((select disposition from public.rma_cases where id = neo_test.get('unit_a')) = 'rejected_returned'
                          and (select disposition from public.rma_cases where id = neo_test.get('unit_b')) = 'refitted',
                          'A6: closing settles the rejected part as rejected_returned and the replaced one as refitted');
end $$;


-- ── 15. Releasing a held part (A5): the PC goes home, the part goes on ──────
do $$
declare r jsonb; v_job text; v_uc text;
begin
  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'customer_name', 'Test Hold Customer', 'customer_phone', '9000000104',
         'in_hand', true, 'reported_fault', 'Random restarts',
         'items', jsonb_build_array(jsonb_build_object('kind', 'pc', 'label', 'Office PC', 'purchase_source', 'unknown'))));
  v_job := r ->> 'id';
  perform neo_test.put('job_hold', v_job);
  perform neo_test.put('code_hold', r ->> 'public_code');
  perform public.service_move(v_job, 'received', 'diagnosing');
  r := public.rma_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'source', 'from_ticket', 'service_job_id', v_job,
         'holds_ticket', true, 'in_hand', true,
         'units', jsonb_build_array(jsonb_build_object('kind', 'psu', 'brand', 'Antec', 'model', '650W',
                                                       'fault', 'Restarts under load', 'purchase_source', 'elsewhere'))));
  v_uc := r -> 'units' -> 0 ->> 'id';
  perform neo_test.put('unit_c', v_uc);
  perform neo_test.assert(neo_test.jstage(v_job) = 'rma_raised', 'the second ticket follows its part to rma_raised');
  perform neo_test.expect_error(format('select public.service_move(%L, %L, %L, null, true, %L::jsonb)',
                                       v_job, 'rma_raised', 'ready', '{"outcome":"repaired"}'), '%NEO_RMA_HOLD%');
  perform neo_test.expect_error(format('select public.rma_release_hold(array[%L], %L)', v_uc, 'revisit_needed'),
                                '%NEO_GATE: Pick where the ticket goes now: ready to collect, or back on the bench%');
  perform neo_test.expect_error(format('select public.rma_release_hold(array[%L], %L, null, null, %L, null)', v_uc, 'ready', 'courier'),
                                '%NEO_GATE: Enter the address to courier the part back to%');

  r := public.rma_release_hold(array[v_uc], 'ready', 'returned_rma_pending', 'Customer needs the PC for exams');
  perform neo_test.assert(r -> 'job' ->> 'stage' = 'ready' and r -> 'job' ->> 'outcome' = 'returned_rma_pending',
                          'release_hold moves the ticket to ready / returned_rma_pending');
  perform neo_test.assert(not (r -> 'units' -> 0 ->> 'holds_ticket')::boolean
                          and r -> 'units' -> 0 ->> 'return_method' = 'collect'
                          and r -> 'units' -> 0 ->> 'stage' = 'received',
                          'the released part keeps going on its own, to be collected');
  perform neo_test.assert(exists (select 1 from public.service_events e where e.job_id = v_job and e.kind = 'stage'
                                   and e.to_stage = 'ready' and e.customer_visible
                                   and e.body like 'Collected; your power supply is still under warranty claim — track it as RM-%'),
                          'A5: the customer is told the part goes on, with its RM code');
  perform neo_test.assert(not exists (select 1 from public.service_events e where e.job_id = v_job and e.to_stage = 'back_from_vendor'),
                          'A5: release never claims the part came back');
  perform neo_test.assert(not exists (select 1 from public.service_events e where e.job_id = v_job and e.body like '%Back from%'),
                          'A5: no "back from" line appears');

  -- A4: a part can only hold a ticket the RMA link may still move
  perform neo_test.expect_error(format($q$select public.rma_create(jsonb_build_object('source', 'from_ticket', 'service_job_id', %L,
                                          'holds_ticket', true, 'in_hand', true,
                                          'units', jsonb_build_array(jsonb_build_object('kind', 'ram', 'fault', 'x'))))$q$, v_job),
                                '%NEO_GATE: The ticket is at Ready for collection. Send this part without holding the ticket%');

  -- fees: the desk quotes and records payment; only a lead waives
  perform neo_test.expect_error(format('select public.rma_set_fee(%L, null, %L, null, %L)', v_uc, 'waived', 'Goodwill'),
                                '%NEO_DENIED%');
  perform neo_test.expect_error(format('select public.rma_set_fee(%L, null, %L)', v_uc, 'paid'), '%NEO_GATE: Enter the bill number%');
  -- A zero fee accepted or paid is a waiver: the desk may not record one.
  perform neo_test.expect_error(format('select public.rma_set_fee(%L, 0, %L)', v_uc, 'accepted'),
                                '%NEO_DENIED: A zero fee is a waiver%');
  perform neo_test.expect_error(format('select public.rma_set_fee(%L, 0, %L, %L)', v_uc, 'paid', 'B-0001'),
                                '%NEO_DENIED: A zero fee is a waiver%');
  r := public.rma_set_fee(v_uc, 300, 'accepted', null, null);
  perform neo_test.assert(r ->> 'fee_status' = 'accepted', 'the desk records that the customer accepted the fee');

  -- An on-site ticket is released to a follow-up visit, never to "ready" (decision 2).
  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'service_type', 'on_site', 'customer_name', 'Test Site Hold',
         'customer_phone', '9000000109', 'reported_fault', 'Server PSU dead', 'site_area', 'Vyttila'));
  v_job := r ->> 'id';
  r := public.rma_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'source', 'from_ticket', 'service_job_id', v_job,
         'holds_ticket', true, 'in_hand', true,
         'units', jsonb_build_array(jsonb_build_object('kind', 'psu', 'brand', 'Seasonic', 'fault', 'Dead',
                                                       'purchase_source', 'neo_tokyo'))));
  perform neo_test.assert(neo_test.jstage(v_job) = 'rma_raised', 'an on-site ticket follows its part too');
  perform neo_test.expect_error(format('select public.rma_release_hold(array[%L], %L)', r -> 'units' -> 0 ->> 'id', 'ready'),
                                '%NEO_GATE: Pick where the ticket goes now: a follow-up visit%');
  r := public.rma_release_hold(array[r -> 'units' -> 0 ->> 'id'], 'revisit_needed', null, null, 'courier', '5 Test Lane, Kochi');
  perform neo_test.assert(r -> 'job' ->> 'stage' = 'revisit_needed' and r -> 'units' -> 0 ->> 'return_method' = 'courier',
                          'an on-site release goes to revisit_needed; the part can be couriered back');
end $$;

select neo_test.login('owner');
do $$
declare r jsonb;
begin
  perform neo_test.expect_error(format('select public.rma_set_fee(%L, 0, %L)', neo_test.get('unit_c'), 'accepted'),
                                '%NEO_GATE: A zero fee is a waiver — choose Waived and say why%');
  r := public.rma_set_fee(neo_test.get('unit_c'), null, 'waived', null, 'Regular customer');
  perform neo_test.assert(r ->> 'fee_status' = 'waived' and r ->> 'fee_note' = 'Regular customer', 'a lead can waive with a note');
end $$;

-- The tracking page knows the released part no longer holds the ticket, so
-- its headline follows the ticket (ready), not the part (A23).
select neo_test.login_anon();
do $$
declare r jsonb;
begin
  r := public.get_service_public(neo_test.get('code_hold'), '0104');
  perform neo_test.assert(r ->> 'stage' = 'ready' and jsonb_array_length(r -> 'rma_units') = 1
                          and r -> 'rma_units' -> 0 -> 'holds_ticket' = 'false'::jsonb,
                          'A23: a released part shows holds_ticket false on the public page');
end $$;


-- ── 16. A paid repair opened from an RMA ────────────────────────────────────
select neo_test.login('desk');
do $$
declare r jsonb; v_u text; v_code text;
begin
  r := public.rma_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'source', 'walk_in', 'sender_kind', 'customer',
         'sender_name', 'Test Walkin Customer', 'sender_phone', '9000000106', 'in_hand', true,
         'units', jsonb_build_array(jsonb_build_object('kind', 'motherboard', 'brand', 'MSI', 'model', 'B550',
                                                       'serial', 'MB-TEST-0001', 'fault', 'No POST',
                                                       'purchase_source', 'unknown'))));
  v_u := r -> 'units' -> 0 ->> 'id';
  perform neo_test.assert(r -> 'units' -> 0 ->> 'stage' = 'received', 'a walk-in part in hand starts at received');
  r := public.rma_move(v_u, 'received', 'customer_decision', 'Out of warranty — physical damage', false, '{}'::jsonb);
  r := public.rma_move(v_u, 'customer_decision', 'closed', null, true,
                       '{"disposition":"converted_to_repair","our_finding":"Burn marks near the 12V rail, vendor was right to reject"}'::jsonb);
  v_code := r ->> 'followup_job_code';
  perform neo_test.assert(exists (select 1 from public.service_jobs sj where sj.public_code = v_code
                                   and sj.reported_fault = 'No POST' and sj.diagnosis like 'Burn marks near the 12V rail%'),
                          'a paid repair carries the customer''s fault; our finding goes to the internal diagnosis');
  perform neo_test.assert(not exists (select 1 from public.service_events e join public.service_jobs sj on sj.id = e.job_id
                                       where sj.public_code = v_code and e.customer_visible and e.body like '%Burn marks%'),
                          'our internal finding never reaches the paid repair''s customer timeline');
  perform neo_test.assert(r ->> 'stage' = 'closed' and r ->> 'followup_job_id' is not null and v_code like 'NT-%',
                          'converted_to_repair opens a paid repair ticket');
  perform neo_test.assert(exists (select 1 from public.service_jobs sj where sj.public_code = v_code and sj.stage = 'received'
                                   and sj.channel = 'staff' and sj.category = 'repair' and sj.model_version = 2),
                          'the follow-up ticket is an in-store repair at received');
  perform neo_test.assert(exists (select 1 from public.service_items si join public.service_jobs sj on sj.id = si.job_id
                                   where sj.public_code = v_code and si.is_primary and si.serial = 'MB-TEST-0001'),
                          'the follow-up ticket carries the part as its item');
end $$;


-- ── 17. A8 with_tech; A10 shipped straight to the customer ──────────────────
do $$
declare r jsonb; v_f1 text; v_f2 text; v_f3 text; v_intake text;
begin
  r := public.rma_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'source', 'field', 'in_hand', true,
         'units', jsonb_build_array(
           jsonb_build_object('kind', 'gpu', 'brand', 'Zotac', 'model', 'RTX 3060', 'serial', 'FLD-TEST-0001',
                              'fault', 'Fans spin, no picture', 'purchase_source', 'neo_tokyo',
                              'owner_name', 'Test Field Owner', 'owner_phone', '9000000107'),
           jsonb_build_object('kind', 'ram', 'brand', 'Crucial', 'fault', 'Random BSOD', 'purchase_source', 'unknown',
                              'owner_name', 'Test Field Owner', 'owner_phone', '9000000107'),
           jsonb_build_object('kind', 'cooler', 'brand', 'Deepcool', 'fault', 'Pump noise', 'purchase_source', 'unknown',
                              'owner_name', 'Test Field Owner', 'owner_phone', '9000000107'))));
  v_f1 := r -> 'units' -> 0 ->> 'id';
  v_f2 := r -> 'units' -> 1 ->> 'id';
  v_f3 := r -> 'units' -> 2 ->> 'id';
  v_intake := r ->> 'intake_id';
  perform neo_test.assert(r -> 'units' -> 0 ->> 'stage' = 'with_tech' and r -> 'units' -> 2 ->> 'stage' = 'with_tech',
                          'A8: a field pull starts with our technician, not at logged');
  perform neo_test.assert((select received_at from public.rma_intakes where id = v_intake) is null,
                          'A8: a part still with our technician is not received at the counter');
  perform neo_test.assert((select sender_kind from public.rma_intakes where id = v_intake) = 'our_tech',
                          'A8: the sender of a field pull is our technician');

  r := public.rma_move(v_f1, 'with_tech', 'received', null, true, '{}'::jsonb);
  perform neo_test.assert(r ->> 'stage' = 'received' and (select received_at from public.rma_intakes where id = v_intake) is not null,
                          'A8: with_tech -> received through rma_move stamps the arrival');
  r := public.rma_receive(array[v_f2], 'Brought back by the technician');
  perform neo_test.assert(neo_test.ustage(v_f2) = 'received', 'A8: rma_receive also takes a part from with_tech');
  perform neo_test.expect_error(format('select public.rma_move(%L, %L, %L, null, true, %L::jsonb)', v_f3, 'with_tech', 'closed',
                                       '{"disposition":"no_fault_found"}'),
                                '%NEO_GATE: A part we never received can only be closed as withdrawn%');
  r := public.rma_move(v_f3, 'with_tech', 'closed', null, true, '{}'::jsonb);
  perform neo_test.assert(r ->> 'stage' = 'closed' and r ->> 'disposition' = 'withdrawn', 'A8: with_tech -> closed is a withdrawal');

  -- A10: the vendor ships the replacement straight to the customer
  perform neo_test.prep_ship(v_f1, neo_test.get('vendor_b')::bigint);
  r := public.rma_move(v_f1, 'received', 'ready_to_ship');
  r := public.rma_dispatch(array[v_f1], neo_test.get('vendor_b')::bigint, 'vendor_pickup', null, null, null,
                           'The vendor''s runner collected it', null);
  perform neo_test.assert(neo_test.ustage(v_f1) = 'with_vendor', 'A9: a vendor pickup needs only a note');
  r := public.rma_vendor_result(v_f1, 'shipped_to_customer', null, 'FLD-NEW-0002', null, null, null);
  perform neo_test.assert(r ->> 'stage' = 'returning' and r ->> 'return_method' = 'courier'
                          and r ->> 'vendor_result' = 'shipped_to_customer',
                          'A10: shipped_to_customer moves the part to returning, no AWB needed');
  r := public.rma_move(v_f1, 'returning', 'closed', 'The customer confirmed it arrived', true, '{"disposition":"replaced"}'::jsonb);
  perform neo_test.assert(r ->> 'stage' = 'closed' and r ->> 'disposition' = 'replaced',
                          'A10: returning -> closed once the customer confirms');
end $$;


-- ── 18. A6 close matrix, A11 drive data, A12 vendor document, A15 serial ────
do $$
declare
  r jsonb; v_job text; v_item_pc text; v_item_gpu text;
  u_rep text; u_rej text; u_lost text; u_fee text; u_whole text; u_free text;
  v_va bigint := neo_test.get('vendor_a')::bigint;
begin
  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'customer_name', 'Test Matrix Customer', 'customer_phone', '9000000110',
         'in_hand', true, 'reported_fault', 'Several faults',
         'items', jsonb_build_array(
           jsonb_build_object('kind', 'pc', 'label', 'Matrix tower', 'serial', 'PC-T6-0001', 'purchase_source', 'neo_tokyo'),
           jsonb_build_object('kind', 'gpu', 'label', 'MSI RTX 4060', 'serial', 'GPU-T6-0001', 'purchase_source', 'neo_tokyo'))));
  v_job := r ->> 'id';
  select id into v_item_pc from public.service_items where job_id = v_job and is_primary;
  select id into v_item_gpu from public.service_items where job_id = v_job and not is_primary;
  perform public.service_move(v_job, 'received', 'diagnosing');

  r := public.rma_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'source', 'from_ticket', 'service_job_id', v_job,
         'holds_ticket', true, 'in_hand', true,
         'units', jsonb_build_array(
           jsonb_build_object('kind', 'gpu', 'brand', 'MSI', 'serial', 'GPU-T6-0001', 'fault', 'Artifacts',
                              'purchase_source', 'neo_tokyo', 'service_item_id', v_item_gpu),
           jsonb_build_object('kind', 'ram', 'brand', 'G.Skill', 'serial', 'RAM-T6-0001', 'fault', 'Fails memtest',
                              'purchase_source', 'neo_tokyo'),
           jsonb_build_object('kind', 'cooler', 'brand', 'NZXT', 'serial', 'CLR-T6-0001', 'fault', 'Pump dead',
                              'purchase_source', 'neo_tokyo'),
           jsonb_build_object('kind', 'ssd', 'brand', 'Samsung', 'serial', 'SSD-T6-0001', 'fault', 'Read-only',
                              'purchase_source', 'elsewhere', 'handling_fee', 300))));
  u_rep := r -> 'units' -> 0 ->> 'id';
  u_rej := r -> 'units' -> 1 ->> 'id';
  u_lost := r -> 'units' -> 2 ->> 'id';
  u_fee := r -> 'units' -> 3 ->> 'id';
  -- The whole machine, raised WITHOUT asking to hold: sending the main item always holds (A4).
  r := public.rma_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'source', 'from_ticket', 'service_job_id', v_job,
         'holds_ticket', false, 'in_hand', true,
         'units', jsonb_build_array(jsonb_build_object('kind', 'pc', 'brand', 'Neo Tokyo', 'serial', 'PC-T6-0001',
                                                       'fault', 'Dead board', 'purchase_source', 'neo_tokyo',
                                                       'service_item_id', v_item_pc))));
  u_whole := r -> 'units' -> 0 ->> 'id';
  perform neo_test.assert((r -> 'units' -> 0 ->> 'holds_ticket')::boolean, 'A4: sending the main item always holds the ticket');
  -- A part that does NOT hold the ticket but was meant to go back inside it.
  r := public.rma_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'source', 'from_ticket', 'service_job_id', v_job,
         'holds_ticket', false, 'in_hand', true, 'return_method', 'with_device',
         'units', jsonb_build_array(jsonb_build_object('kind', 'psu', 'brand', 'Cooler Master', 'fault', 'Coil whine',
                                                       'purchase_source', 'unknown'))));
  u_free := r -> 'units' -> 0 ->> 'id';

  -- The GPU's serial label was photographed at intake, on its ticket item: that
  -- photo counts for the part's gate too (nobody unboxes it to take another).
  insert into public.service_media (job_id, service_item_id, path, phase, role, uploaded_by, uploaded_name)
  values (v_job, v_item_gpu, v_job || '/test-gpu-label.jpg', 'intake', 'serial_label', 'test', 'Test');
  perform neo_test.put('matrix_job', v_job);
  perform neo_test.put('matrix_item_gpu', v_item_gpu);
  perform neo_test.put('matrix_case_gpu', u_rep);
  update public.rma_cases set vendor_id = v_va where id = u_rep;
  perform neo_test.prep_ship(u_rej, v_va);
  perform neo_test.prep_ship(u_lost, v_va);
  perform neo_test.prep_ship(u_fee, v_va);
  perform neo_test.prep_ship(u_whole, v_va);

  -- A11: a drive does not ship until someone says what happens to its data
  perform neo_test.expect_error(format('select public.rma_move(%L, %L, %L)', u_fee, 'received', 'ready_to_ship'),
                                '%NEO_GATE%data on the drive%');
  update public.rma_cases set data_handling = 'wiped_by_us' where id = u_fee;
  perform neo_test.assert(exists (select 1 from public.rma_events e where e.case_id = u_fee and not e.customer_visible
                                   and e.body = 'Data on the drive: We wiped it'),
                          'A11: setting the drive-data answer writes an internal note');
  -- A12: an invoice OR a vendor document, and the fee accepted
  perform neo_test.expect_error(format('select public.rma_move(%L, %L, %L)', u_fee, 'received', 'ready_to_ship'),
                                '%NEO_GATE%Add the customer''s invoice (or a warranty-check screenshot) and get the handling fee accepted%');
  insert into public.service_media (job_id, rma_case_id, path, phase, role, uploaded_by, uploaded_name)
  values (null, u_fee, 'rma/' || u_fee || '/warranty-check.png', 'during', 'vendor_doc', 'test', 'Test');
  perform neo_test.expect_error(format('select public.rma_move(%L, %L, %L)', u_fee, 'received', 'ready_to_ship'),
                                '%NEO_GATE: Get the handling fee accepted%');
  r := public.rma_set_fee(u_fee, 300, 'accepted', null, null);
  r := public.rma_move(u_fee, 'received', 'ready_to_ship');
  perform neo_test.assert(r ->> 'stage' = 'ready_to_ship', 'A12: a warranty-check screenshot stands in for the invoice');

  r := public.rma_move(u_rep, 'received', 'ready_to_ship');
  r := public.rma_move(u_rej, 'received', 'ready_to_ship');
  r := public.rma_move(u_lost, 'received', 'ready_to_ship');
  r := public.rma_move(u_whole, 'received', 'ready_to_ship');
  r := public.rma_dispatch(array[u_rep, u_rej, u_lost, u_fee, u_whole], v_va, 'courier', 'Blue Dart', 'AWB-T6-1', null, null, null);
  perform neo_test.assert(neo_test.jstage(v_job) = 'at_vendor', 'five parts in one dispatch: the ticket is at_vendor');
  perform neo_test.assert((select count(*) from public.service_events e where e.job_id = v_job and e.kind = 'rma'
                            and (e.meta ->> 'shipment_id')::bigint = (r ->> 'shipment_id')::bigint) = 1,
                          'A9: five parts, one ticket line');

  r := public.rma_vendor_result(u_rep, 'repaired', null, null, null, null, null);
  r := public.rma_vendor_result(u_rej, 'rejected', 'Out of warranty', null, null, null, null);
  r := public.rma_vendor_result(u_lost, 'lost', 'Lost by the courier', null, null, null, null);
  r := public.rma_vendor_result(u_fee, 'repaired', null, null, null, null, null);
  r := public.rma_vendor_result(u_whole, 'replaced', null, 'PC-NEW-0001', null, null, null);
  -- A15: the replacement's serial reaches the ticket's item and device line
  perform neo_test.assert((select serial from public.service_items where id = v_item_pc) = 'PC-NEW-0001'
                          and (select device_serial from public.service_jobs where id = v_job) = 'PC-NEW-0001',
                          'A15: a replaced main item updates the item serial and the ticket''s device serial');
  perform neo_test.assert(exists (select 1 from public.rma_events e where e.case_id = u_whole and not e.customer_visible
                                   and e.body = 'Serial changed from PC-T6-0001 to PC-NEW-0001 (replacement)'),
                          'A15: the serial change is noted internally');
  perform neo_test.assert(neo_test.jstage(v_job) = 'back_from_vendor', 'every held part back: the ticket is back_from_vendor');

  r := public.service_move(v_job, 'back_from_vendor', 'in_service');
  r := public.service_move(v_job, 'in_service', 'verifying');
  r := public.service_move(v_job, 'verifying', 'ready', null, true, '{"outcome":"repaired"}'::jsonb);
  r := public.service_move(v_job, 'ready', 'closed');
  perform neo_test.assert(r ->> 'stage' = 'closed', 'the matrix ticket closes');

  perform neo_test.assert(neo_test.ustage(u_rep) = 'closed'
                          and (select disposition from public.rma_cases where id = u_rep) = 'refitted',
                          'A6: a held, repaired part is refitted');
  perform neo_test.assert(neo_test.ustage(u_whole) = 'closed'
                          and (select disposition from public.rma_cases where id = u_whole) = 'replaced',
                          'A6: the ticket''s main item comes back as replaced');
  perform neo_test.assert(neo_test.ustage(u_rej) = 'closed'
                          and (select disposition from public.rma_cases where id = u_rej) = 'rejected_returned',
                          'A6: a rejected part is rejected_returned');
  perform neo_test.assert(neo_test.ustage(u_lost) = 'customer_decision'
                          and exists (select 1 from public.rma_events e where e.case_id = u_lost and not e.customer_visible
                                       and e.body = 'Ticket closed — decision still pending'),
                          'A6: a lost part waiting on the customer stays open, with a note');
  perform neo_test.assert(neo_test.ustage(u_fee) = 'back_from_vendor'
                          and exists (select 1 from public.rma_events e where e.case_id = u_fee and not e.customer_visible
                                       and e.body = 'Ticket closed — fee still to settle'),
                          'A6: a part with a fee to settle stays open, with a note');
  perform neo_test.assert(neo_test.ustage(u_free) = 'received'
                          and (select return_method from public.rma_cases where id = u_free) = 'collect'
                          and exists (select 1 from public.rma_events e where e.case_id = u_free and e.customer_visible
                                       and e.body like 'Your power supply will be returned separately — track it as RM-%'),
                          'A6: a part that did not hold the ticket is returned separately');

  -- Releasing a part that still holds the CLOSED ticket lets the part go on by
  -- itself; the ticket stays closed with its outcome (both screens send a target).
  r := public.rma_release_hold(array[u_lost], 'ready', 'returned_rma_pending', null);
  perform neo_test.assert(r -> 'job' ->> 'stage' = 'closed' and r -> 'job' ->> 'outcome' = 'repaired'
                          and r -> 'job' ->> 'closed_at' is not null and r -> 'job' ->> 'closed_by' is not null,
                          format('a release never reopens a closed ticket (got %s / %s)', r -> 'job' ->> 'stage', r -> 'job' ->> 'outcome'));
  perform neo_test.assert(not (r -> 'units' -> 0 ->> 'holds_ticket')::boolean and r -> 'units' -> 0 ->> 'stage' = 'customer_decision',
                          'the released part goes on by itself');
  perform neo_test.assert(not exists (select 1 from public.service_events e where e.job_id = v_job and e.body like 'Collected;%'),
                          'a release on a closed ticket tells the customer nothing about collecting');
end $$;


-- ── 18b. A held part that never went to a vendor; "fitted back" wording ────
do $$
declare r jsonb; v_job text; v_gpu text; v_ram text; v_body text;
begin
  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'customer_name', 'Test Mixed Customer', 'customer_phone', '9000000115',
         'in_hand', true, 'reported_fault', 'Crashes in games',
         'items', jsonb_build_array(jsonb_build_object('kind', 'pc', 'label', 'Gaming tower', 'purchase_source', 'neo_tokyo'))));
  v_job := r ->> 'id';
  perform public.service_move(v_job, 'received', 'diagnosing');
  r := public.rma_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'source', 'from_ticket', 'service_job_id', v_job,
         'holds_ticket', true, 'in_hand', true,
         'units', jsonb_build_array(
           jsonb_build_object('kind', 'gpu', 'brand', 'Gigabyte', 'serial', 'GPU-T7-0001', 'fault', 'Artifacts',
                              'purchase_source', 'neo_tokyo'),
           jsonb_build_object('kind', 'ram', 'brand', 'Corsair', 'serial', 'RAM-T7-0001', 'fault', 'Fails memtest',
                              'purchase_source', 'neo_tokyo'))));
  v_gpu := r -> 'units' -> 0 ->> 'id';
  v_ram := r -> 'units' -> 1 ->> 'id';

  -- The RAM tests fine and goes back inside the PC; it never sees a vendor.
  r := public.rma_move(v_ram, 'received', 'testing');
  r := public.rma_move(v_ram, 'testing', 'ready_to_return');
  perform neo_test.assert(exists (select 1 from public.service_events e where e.job_id = v_job and e.kind = 'rma'
                                   and e.customer_visible and e.body like 'RAM (RM-%): Being fitted back in your device'),
                          'a held part going back inside the device reads "Being fitted back in your device"');

  perform neo_test.prep_ship(v_gpu, neo_test.get('vendor_b')::bigint);
  r := public.rma_move(v_gpu, 'received', 'ready_to_ship');
  r := public.rma_dispatch(array[v_gpu], neo_test.get('vendor_b')::bigint, 'courier', 'DTDC', 'AWB-T7-1', null, null, null);
  perform neo_test.assert(neo_test.jstage(v_job) = 'at_vendor', 'the GPU is away: the ticket is at_vendor');
  r := public.rma_vendor_result(v_gpu, 'replaced', null, 'GPU-T7-NEW1', null, null, null);
  perform neo_test.assert(neo_test.jstage(v_job) = 'back_from_vendor', 'the GPU is back: the ticket is back_from_vendor');
  select e.body into v_body from public.service_events e
   where e.job_id = v_job and e.kind = 'stage' and e.to_stage = 'back_from_vendor'
   order by e.at desc, e.id desc limit 1;
  perform neo_test.assert(v_body like 'Warranty claim update: %' and v_body like '%RAM (RM-%) — being fitted back in your device%',
                          format('a part that never went to a vendor is not "back from the manufacturer" (got %s)', coalesce(v_body, 'null')));
end $$;


-- ── 18c. An RMA-only member sees a part's ticket-item photos, nothing else ──
-- The matrix GPU's serial label (18) sits on its TICKET item, under <jobId>/.
-- A member with an RMA role and no service role may read that row and sign its
-- file, but no other photo of that ticket or of any other ticket, and may not
-- add, change or remove any of them.
select neo_test.login('desk');
do $$
declare r jsonb; v_other text; v_other_item text; v_job text := neo_test.get('matrix_job');
begin
  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'customer_name', 'Test Unrelated Customer', 'customer_phone', '9000000120',
         'in_hand', true, 'reported_fault', 'No display',
         'items', jsonb_build_array(jsonb_build_object('kind', 'pc', 'label', 'Office tower', 'purchase_source', 'unknown'))));
  v_other := r ->> 'id';
  select id into v_other_item from public.service_items where job_id = v_other and is_primary;
  perform neo_test.assert(v_other_item is not null, 'TEST SETUP: the unrelated ticket has an item');
  perform neo_test.put('other_job', v_other);
  insert into public.service_media (job_id, service_item_id, path, phase, role, uploaded_by, uploaded_name)
  values (v_other, v_other_item, v_other || '/test-other-label.jpg', 'intake', 'serial_label', 'test', 'Test'),
         (v_other, null, v_other || '/test-other-front.jpg', 'intake', 'condition', 'test', 'Test'),
         -- the matrix ticket's own photo of the whole machine, on no item
         (v_job, null, v_job || '/test-matrix-front.jpg', 'intake', 'condition', 'test', 'Test');
end $$;

-- As the owner: the files behind those rows, and an RMA-only role for the
-- plain member (taken away again at the end of this section).
reset role;
do $$
declare v_job text := neo_test.get('matrix_job'); v_other text := neo_test.get('other_job');
begin
  begin
    insert into storage.objects (bucket_id, name)
    select 'service-media', m.path from public.service_media m
     where m.path in (v_job || '/test-gpu-label.jpg', v_job || '/test-matrix-front.jpg',
                      v_other || '/test-other-label.jpg', v_other || '/test-other-front.jpg');
    perform neo_test.put('storage_rows', 'yes');
  exception when insufficient_privilege then
    raise warning 'service-v2 tests: could not add test files to storage.objects (%); the file checks of 18c are skipped', sqlerrm;
    perform neo_test.put('storage_rows', 'no');
  end;
end $$;
insert into public.module_access (profile_id, module, role, granted_by)
select u.id, 'rma', 'desk', 'tests' from neo_test.users u where u.alias = 'plain';

select neo_test.login('plain');
do $$
declare
  n bigint;
  v_job text := neo_test.get('matrix_job');
  v_item text := neo_test.get('matrix_item_gpu');
  v_case text := neo_test.get('matrix_case_gpu');
  v_other text := neo_test.get('other_job');
  v_label text := neo_test.get('matrix_job') || '/test-gpu-label.jpg';
begin
  perform neo_test.assert(public.rma_reader() and not public.svc_reader(),
                          'TEST SETUP: the plain member is an RMA reader with no service role');
  -- The read the RMA screen makes for a part: its own rows or its ticket item's.
  select count(*) into n from public.service_media m where m.rma_case_id = v_case or m.service_item_id = v_item;
  perform neo_test.assert(n = 1, format('an RMA-only member reads the part''s ticket-item photo (got %s rows)', n));
  perform neo_test.assert(exists (select 1 from public.service_media m where m.path = v_label and m.role = 'serial_label'),
                          'an RMA-only member sees the serial label photographed on the ticket item');
  select count(*) into n from public.service_media m where m.job_id = v_other;
  perform neo_test.assert(n = 0, 'an RMA-only member reads no photo of an unrelated ticket, not even its item''s serial label');
  select count(*) into n from public.service_media m where m.job_id = v_job and m.service_item_id is null;
  perform neo_test.assert(n = 0, 'an RMA-only member reads no photo of the part''s ticket that is on no item');
  select count(*) into n from public.service_jobs where id = v_job;
  perform neo_test.assert(n = 0, 'an RMA-only member still cannot read the ticket itself');
  select count(*) into n from public.service_items where id = v_item;
  perform neo_test.assert(n = 0, 'an RMA-only member still cannot read the ticket''s items');

  -- Read only: no remark, no removal, no new row on the ticket item.
  update public.service_media set remark = 'changed by an RMA-only member' where path = v_label;
  get diagnostics n = row_count;
  perform neo_test.assert(n = 0, 'an RMA-only member cannot change a ticket-item photo');
  delete from public.service_media where path = v_label;
  get diagnostics n = row_count;
  perform neo_test.assert(n = 0, 'an RMA-only member cannot remove a ticket-item photo');
  perform neo_test.expect_error(
    format('insert into public.service_media (job_id, service_item_id, path, phase, role, uploaded_by, uploaded_name) values (%L, %L, %L, %L, %L, %L, %L)',
           v_job, v_item, v_job || '/test-rma-only.jpg', 'intake', 'condition', 'test', 'Test'),
    '%row-level security%');

  -- The files: the label can be signed; nothing else of either ticket can.
  if neo_test.get('storage_rows') = 'yes' then
    select count(*) into n from storage.objects o where o.bucket_id = 'service-media' and o.name = v_label;
    perform neo_test.assert(n = 1, 'an RMA-only member can sign the ticket-item photo''s file');
    select count(*) into n from storage.objects o
     where o.bucket_id = 'service-media'
       and (split_part(o.name, '/', 1) = v_other or o.name = v_job || '/test-matrix-front.jpg');
    perform neo_test.assert(n = 0, 'an RMA-only member can sign no other file of that ticket or of an unrelated one');
    update storage.objects set metadata = '{}'::jsonb where bucket_id = 'service-media' and name = v_label;
    get diagnostics n = row_count;
    perform neo_test.assert(n = 0, 'an RMA-only member cannot change the ticket-item photo''s file');
  end if;
end $$;

-- Someone with no RMA role sees none of it.
select neo_test.login('sales');
do $$
declare n bigint; v_job text := neo_test.get('matrix_job');
begin
  select count(*) into n from public.service_media m where m.job_id = v_job;
  perform neo_test.assert(n = 0, 'sales (no module role) read no photo of a part''s ticket');
  select count(*) into n from storage.objects o where o.bucket_id = 'service-media' and split_part(o.name, '/', 1) = v_job;
  perform neo_test.assert(n = 0, 'sales (no module role) can sign no file of a part''s ticket');
end $$;

reset role;
delete from public.module_access
 where module = 'rma' and profile_id = (select u.id from neo_test.users u where u.alias = 'plain');


-- ── 19. v1.9.11 clients: direct writes with the old columns still work ──────
select neo_test.login('owner');
do $$
declare v_job public.service_jobs; v_item public.service_items;
begin
  insert into public.service_jobs (id, public_code, created_at, updated_at, job_kind, origin, stage, stage_since, received_at,
                                   customer_name, customer_phone, customer_email, device_label, device_serial,
                                   reported_fault, has_customer_data, build_ticket_id, intake, details, subject)
  values ('s_test_v1_0001', 'NT-TESTV1AA', now(), now(), 'warranty_rma', 'counter', 'received', now(), now(),
          'Test Legacy Customer', '9000000105', null, 'Old laptop', 'OLD-SER-1', 'Hinge broken', false, null,
          '{"accessories":"Charger","condition":"Scratches","powers_on_at_counter":true,"taken_by":"Test","taken_at":"2026-01-01T00:00:00Z"}'::jsonb,
          '{}'::jsonb, '{}'::jsonb);
  -- v1.9.11 writes its history rows in the signed-in person's name, no meta.
  insert into public.service_events (job_id, kind, actor_kind, actor_email, actor_name, to_stage, body, customer_visible, client_at)
  values ('s_test_v1_0001', 'stage', 'staff', neo_test.email('owner'), 'Test', 'received',
          'Received at counter. Reported fault: Hinge broken', true, now());
  insert into public.service_events (job_id, kind, actor_kind, actor_email, actor_name, body, customer_visible, client_at)
  values ('s_test_v1_0001', 'edit', 'staff', upper(neo_test.email('owner')), 'Test', 'Diagnosis recorded', false, now());

  select * into v_job from public.service_jobs where id = 's_test_v1_0001';
  perform neo_test.assert(v_job.model_version = 1 and v_job.service_type = 'in_store' and v_job.channel = 'walk_in'
                          and v_job.priority = 'normal', 'an old-client insert lands as a v1 in-store ticket');
  perform neo_test.assert(v_job.category = 'warranty_claim' and v_job.queued_at is not null and v_job.customer_id is not null,
                          'an old-client insert gets category, queued_at and a customer');
  select * into v_item from public.service_items where job_id = 's_test_v1_0001' and is_primary;
  perform neo_test.assert(v_item.label = 'Old laptop' and v_item.serial = 'OLD-SER-1', 'an old-client insert gets a primary item');

  update public.service_jobs set stage = 'diagnosing', stage_since = now(), updated_at = now() where id = 's_test_v1_0001';
  perform neo_test.assert(neo_test.jstage('s_test_v1_0001') = 'diagnosing', 'an old-client stage update works on a v1 row');
  update public.service_jobs set device_serial = 'OLD-SER-2', updated_at = now() where id = 's_test_v1_0001';
  perform neo_test.assert((select serial from public.service_items where job_id = 's_test_v1_0001' and is_primary) = 'OLD-SER-2',
                          'an old-client device edit reaches the primary item');
  update public.service_jobs set assignee_email = neo_test.email('tech1'), assignee = 'Athul', updated_at = now()
   where id = 's_test_v1_0001';
  select * into v_job from public.service_jobs where id = 's_test_v1_0001';
  perform neo_test.assert(v_job.assigned_via = 'legacy' and v_job.assigned_at is not null and v_job.queued_at is null,
                          'an old-client assignment is stamped legacy and leaves the queue');

  -- the legacy manual vendor flow on a v1 ticket with no parts still works
  update public.service_jobs set stage = 'rma_raised', stage_since = now(), updated_at = now() where id = 's_test_v1_0001';
  update public.service_jobs set stage = 'at_vendor', waiting_party = 'ASUS', stage_since = now(), updated_at = now()
   where id = 's_test_v1_0001';
  perform neo_test.assert(neo_test.jstage('s_test_v1_0001') = 'at_vendor', 'v1 tickets keep the manual vendor stages');
  perform neo_test.expect_error($q$update public.service_jobs set stage = 'bogus' where id = 's_test_v1_0001'$q$,
                                '%NEO_GATE%not a known ticket stage%');
  update public.service_jobs set stage = 'closed', outcome = 'replaced_under_warranty', closed_at = now(),
         closed_by = neo_test.email('owner'), updated_at = now()
   where id = 's_test_v1_0001';
  perform neo_test.assert(neo_test.jstage('s_test_v1_0001') = 'closed', 'an old-client close works on a v1 row');

  -- Close / reopen bookkeeping on an UNASSIGNED v1 ticket (an assigned one has
  -- no queue time to clear): the close takes it out of the queue, a reopen
  -- puts it back.
  insert into public.service_jobs (id, public_code, created_at, updated_at, job_kind, origin, stage, stage_since, received_at,
                                   customer_name, customer_phone, device_label, reported_fault, has_customer_data,
                                   intake, details, subject)
  values ('s_test_v1_0003', 'NT-TESTV1AC', now(), now(), 'repair_outside', 'counter', 'received', now(), now(),
          'Test Legacy Queue Customer', '9000000112', 'Old tower', 'Fan noise', false, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
  perform neo_test.assert((select queued_at from public.service_jobs where id = 's_test_v1_0003') is not null,
                          'an unassigned old-client ticket is in the queue');
  update public.service_jobs set stage = 'closed', outcome = 'repaired', closed_at = now(),
         closed_by = neo_test.email('owner'), updated_at = now()
   where id = 's_test_v1_0003';
  perform neo_test.assert((select queued_at from public.service_jobs where id = 's_test_v1_0003') is null,
                          'an old-client close clears the queue time');
  update public.service_jobs set stage = 'diagnosing', outcome = null, ready_at = null, closed_at = null, closed_by = null,
         stage_since = now(), updated_at = now()
   where id = 's_test_v1_0003';
  perform neo_test.assert((select queued_at from public.service_jobs where id = 's_test_v1_0003') is not null,
                          'an old-client reopen of an unassigned ticket puts it back in the queue');

  -- An old client typing a Qatar number (11 digits) with + still reaches the
  -- customer book: the insert trigger uses the same phone_ok as the RPCs.
  insert into public.service_jobs (id, public_code, created_at, updated_at, job_kind, origin, stage, stage_since, received_at,
                                   customer_name, customer_phone, device_label, reported_fault, has_customer_data,
                                   intake, details, subject)
  values ('s_test_v1_0004', 'NT-TESTV1AD', now(), now(), 'repair_outside', 'counter', 'received', now(), now(),
          'Test Qatar Again', '+974 5012 3456', 'Old laptop', 'Battery', false, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
  perform neo_test.assert((select cu.phone_norm from public.service_jobs sj join public.customers cu on cu.id = sj.customer_id
                            where sj.id = 's_test_v1_0004') = '97450123456',
                          'A1'': an old-client ticket with an 11-digit Qatar number joins the existing customer');

  -- an old-client media row and its "show customer" tick still work
  insert into public.service_media (job_id, path, phase, uploaded_by, uploaded_name)
  values ('s_test_v1_0001', 's_test_v1_0001/test.jpg', 'intake', neo_test.email('owner'), 'Test');
  update public.service_media set customer_visible = true where job_id = 's_test_v1_0001';
end $$;


-- ── 20. A14: a legacy ticket already at the vendor gets its part logged ─────
do $$
declare r jsonb; v_job public.service_jobs; v_u text;
begin
  insert into public.service_jobs (id, public_code, created_at, updated_at, job_kind, origin, stage, stage_since, received_at,
                                   customer_name, customer_phone, device_label, device_serial, reported_fault,
                                   has_customer_data, intake, details, subject)
  values ('s_test_v1_0002', 'NT-TESTV1AB', now(), now(), 'warranty_rma', 'counter', 'received', now(), now(),
          'Test Legacy Vendor Customer', '9000000111', 'Gaming PC', 'OLD-SER-3', 'GPU dead', false,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
  update public.service_jobs set stage = 'rma_raised', stage_since = now(), updated_at = now() where id = 's_test_v1_0002';
  update public.service_jobs set stage = 'at_vendor', waiting_party = 'Zotac service centre', stage_since = now(), updated_at = now()
   where id = 's_test_v1_0002';

  r := public.rma_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'source', 'from_ticket', 'service_job_id', 's_test_v1_0002',
         'holds_ticket', true, 'in_hand', false, 'return_method', 'with_device',
         'units', jsonb_build_array(jsonb_build_object('kind', 'gpu', 'brand', 'Zotac', 'model', 'RTX 3070',
                                                       'fault', 'No display', 'purchase_source', 'unknown',
                                                       'already_with_vendor', true, 'vendor_id', neo_test.get('vendor_b')::bigint,
                                                       'vendor_rma_no', 'ZT-998877'))));
  v_u := r -> 'units' -> 0 ->> 'id';
  perform neo_test.assert(r -> 'units' -> 0 ->> 'stage' = 'with_vendor', 'A14: the part is logged straight at with_vendor');
  perform neo_test.assert((select expected_back_at from public.rma_cases where id = v_u) > now() + interval '19 days',
                          'A14: expected back defaults to now + the vendor''s turnaround');
  select * into v_job from public.service_jobs where id = 's_test_v1_0002';
  perform neo_test.assert(v_job.stage = 'at_vendor' and v_job.waiting_party = 'Zotac',
                          format('A14: the ticket stays at_vendor and now names the brand (got %s)', coalesce(v_job.waiting_party, 'null')));
  perform neo_test.expect_error($q$select public.rma_create(jsonb_build_object('source', 'from_ticket', 'service_job_id', 's_test_v1_0002',
                                     'units', jsonb_build_array(jsonb_build_object('kind', 'gpu', 'fault', 'x', 'already_with_vendor', true))))$q$,
                                '%NEO_GATE: Part 1: choose the vendor it is with%');
end $$;


-- ── 21. Module access: tier 4+ grants, the next query sees it ───────────────
select neo_test.login('desk');
do $$
begin
  perform neo_test.expect_error(format('select public.module_access_set(%L, %L, %L)', neo_test.email('plain'), 'service', 'desk'),
                                '%NEO_DENIED%');
  perform neo_test.expect_error($q$select public.module_access_list()$q$, '%NEO_DENIED%');
  perform neo_test.expect_error(format('insert into public.module_access (profile_id, module, role) values (%L, %L, %L)',
                                       (select id from neo_test.users where alias = 'desk'), 'qc', 'lead'), '%permission denied%');
end $$;

select neo_test.login('owner');
do $$
declare r jsonb;
begin
  r := public.module_access_set(neo_test.email('plain'), 'service', 'desk');
  perform neo_test.assert((r ->> 'ok')::boolean and r ->> 'role' = 'desk', 'the owner grants a module role');
  r := public.module_access_list();
  perform neo_test.assert(exists (select 1 from jsonb_array_elements(r) as e(value)
                                   where lower(e.value ->> 'email') = lower(neo_test.email('plain'))
                                     and e.value ->> 'service' = 'desk'),
                          'module_access_list shows the new role');
end $$;

select neo_test.login('plain');
do $$
declare n bigint;
begin
  select count(*) into n from public.service_jobs where id = neo_test.get('job_hold');
  perform neo_test.assert(n = 1, 'a new desk role takes effect on the next query');
end $$;

select neo_test.login('owner');
do $$
declare r jsonb;
begin
  r := public.module_access_set(neo_test.email('plain'), 'service', null);
  perform neo_test.assert(r ->> 'role' is null, 'the owner removes the role');
end $$;

select neo_test.login('plain');
do $$
declare n bigint;
begin
  select count(*) into n from public.service_jobs where id = neo_test.get('job_hold');
  perform neo_test.assert(n = 0, 'removing the role removes access');
end $$;


-- ── 22. A24: anon holds no grant on any new table or view ───────────────────
reset role;
do $$
declare v_list text; t text;
begin
  select string_agg(table_name || ':' || privilege_type, ', ') into v_list
    from information_schema.role_table_grants
   where grantee = 'anon' and table_schema = 'public'
     and table_name in ('module_access', 'customers', 'service_items', 'rma_vendors', 'rma_intakes', 'rma_cases',
                        'rma_events', 'rma_shipments', 'rma_shipment_items', 'field_activity',
                        'v_service_queue', 'v_tech_day', 'service_jobs', 'service_events', 'service_media');
  perform neo_test.assert(v_list is null, format('A24: anon has no table grants on the new objects (found %s)', v_list));
  -- The same, asked of the privilege system directly (catches grants made by another role).
  foreach t in array array['module_access', 'customers', 'service_items', 'rma_vendors', 'rma_intakes', 'rma_cases',
                           'rma_events', 'rma_shipments', 'rma_shipment_items', 'field_activity',
                           'v_service_queue', 'v_tech_day'] loop
    perform neo_test.assert(not has_table_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                            and not has_any_column_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, REFERENCES'),
                            format('A24: anon has no privilege on %s', t));
    perform neo_test.assert((select c.relrowsecurity or c.relkind = 'v' from pg_class c
                              where c.oid = ('public.' || t)::regclass),
                            format('A24: %s has row level security on (or is a view)', t));
  end loop;
  perform neo_test.assert((select coalesce(bool_and(coalesce(c.reloptions::text, '') like '%security_invoker=true%'), false)
                             from pg_class c where c.oid in ('public.v_service_queue'::regclass, 'public.v_tech_day'::regclass)),
                          'A24: both views are security_invoker');
  perform neo_test.assert(not has_function_privilege('anon', 'public.find_builds(text)', 'EXECUTE')
                          and not has_function_privilege('anon', 'public.tech_activity(date, date)', 'EXECUTE')
                          and not has_function_privilege('anon', 'public.rma_dispatch(text[], bigint, text, text, text, numeric, text, text)', 'EXECUTE')
                          and has_function_privilege('anon', 'public.get_service_public(text, text)', 'EXECUTE')
                          and has_function_privilege('anon', 'public.get_rma_public(text, text)', 'EXECUTE'),
                          'A24: anon may call only the two tracking lookups');
  perform neo_test.assert(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                       where n.nspname = 'public' and p.proname in ('rma_dispatch', 'service_assign', 'rma_release_hold')
                                       group by p.proname having count(*) > 1),
                          'the widened RPCs have exactly one signature each (no PostgREST ambiguity)');
  -- The service-media files follow the module roles, not is_staff().
  perform neo_test.assert(not exists (select 1 from pg_policies
                                       where schemaname = 'storage' and tablename = 'objects'
                                         and (coalesce(qual, '') like '%''service-media''%' or coalesce(with_check, '') like '%''service-media''%')
                                         and (coalesce(qual, '') like '%is_staff%' or coalesce(with_check, '') like '%is_staff%')),
                          'storage: no service-media policy is left at is_staff()');
  perform neo_test.assert((select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
                            and policyname in ('svcmedia_select', 'svcmedia_insert', 'svcmedia_update', 'svcmedia_delete')) = 4,
                          'storage: the four service-media policies are in place');
  -- RMA readers READ a part's ticket-item photos and their files; no write is widened.
  perform neo_test.assert(coalesce((select qual from pg_policies where schemaname = 'public' and tablename = 'service_media'
                                      and policyname = 'sm_select'), '') like '%rma_item_media_visible%'
                          and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'service_media'
                                           and policyname <> 'sm_select'
                                           and coalesce(qual, '') || coalesce(with_check, '') like '%rma_item_media_visible%'),
                          'service_media: only the select policy lets RMA readers see ticket-item photos');
  perform neo_test.assert(coalesce((select qual from pg_policies where schemaname = 'storage' and tablename = 'objects'
                                      and policyname = 'svcmedia_select'), '') like '%rma_media_path_visible%'
                          and not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                                           and policyname <> 'svcmedia_select'
                                           and coalesce(qual, '') || coalesce(with_check, '') like '%rma_media_path_visible%'),
                          'storage: only the select policy lets RMA readers sign ticket-item photo files');
  perform neo_test.assert(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                       where n.nspname = 'public' and p.proname = '_rma_party' and p.pronargs <> 3),
                          'A13: only the kind-aware _rma_party exists');
end $$;


-- ── Done ────────────────────────────────────────────────────────────────────
reset role;
select 'service-v2 tests: all passed' as result;
rollback;
