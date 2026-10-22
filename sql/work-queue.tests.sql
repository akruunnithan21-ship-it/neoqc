-- =============================================================================
-- work-queue.tests.sql — tests for the work_queue_v2_2 migration
-- -----------------------------------------------------------------------------
-- Run AFTER sql/service-v2.sql, sql/service-v2.1.sql and sql/work-queue.sql, as
-- the database owner (Supabase SQL editor or psql as postgres). Everything
-- happens inside one transaction that ends in ROLLBACK: nothing is left
-- behind, not even the helper schema.
--
-- Users are simulated the way PostgREST does it (SET ROLE + request.jwt.claims),
-- exactly as in sql/service-v2.tests.sql, with the same real profiles (owner,
-- desk, tech1, tech2, sales, plain) plus four more real ones this file needs:
-- two tier-4 accounts (ceo, cto), a tier-3 lead (head) and a third technician
-- (tech3). Their module rows and work settings are (re)written inside the
-- transaction, and everybody else is taken out of the work pools, so nothing
-- here depends on what someone set in People. Three throw-away logins
-- (@neotokyo.test) are created for the name-matching and new-hire checks.
--
-- Time: now() is the transaction's start time and does not move, so "four
-- hours later" and "thirty minutes later" are made by back-dating rows (as the
-- owner, under neo.migrating). Existing open items are parked for the length
-- of the transaction (auto_tried_at = now(), no offer) so work_tick only ever
-- acts on this file's items.
--
-- A failed assertion raises "FAIL: …" and aborts — the first error is the one
-- to read. Success ends with the row
--   result = 'work-queue tests: all passed'
-- just before the rollback. Test ids: builds t_wqt_*, service phones 90000003xx.
-- =============================================================================

begin;

-- ── 0. Scaffolding (as the owner) ────────────────────────────────────────────
create schema neo_wqt;
grant usage on schema neo_wqt to anon, authenticated;

create table neo_wqt.users (alias text primary key, id uuid not null, email text not null, tier int not null, name text not null);
create table neo_wqt.ctx (k text primary key, v text);
grant select on neo_wqt.users to anon, authenticated;
grant select, insert, update, delete on neo_wqt.ctx to anon, authenticated;

create function neo_wqt.put(p_k text, p_v text) returns void language plpgsql as $$
begin
  insert into neo_wqt.ctx (k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v;
end $$;

-- VOLATILE on purpose (see service-v2.tests.sql): a STABLE call in a WHERE is
-- evaluated under the snapshot the DO block started with.
create function neo_wqt.get(p_k text) returns text language plpgsql volatile as $$
declare v text;
begin
  select c.v into v from neo_wqt.ctx c where c.k = p_k;
  if not found or v is null then raise exception 'TEST BUG: nothing stored under "%"', p_k; end if;
  return v;
end $$;

create function neo_wqt.email(p_alias text) returns text language plpgsql volatile as $$
declare v text;
begin
  select u.email into v from neo_wqt.users u where u.alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  return v;
end $$;

create function neo_wqt.name(p_alias text) returns text language plpgsql volatile as $$
declare v text;
begin
  select u.name into v from neo_wqt.users u where u.alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  return v;
end $$;

-- What the build board shows for someone (the first word of their name).
create function neo_wqt.first(p_alias text) returns text language plpgsql volatile as $$
begin
  return split_part(neo_wqt.name(p_alias), ' ', 1);
end $$;

create function neo_wqt.login(p_alias text) returns void language plpgsql as $$
declare u neo_wqt.users;
begin
  select * into u from neo_wqt.users where alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', u.id::text, true);
  perform set_config('request.jwt.claim.email', u.email, true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', u.id, 'email', u.email, 'role', 'authenticated')::text, true);
end $$;

create function neo_wqt.login_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.email', '', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
end $$;

-- After "reset role": forget who was signed in (auth.uid() is null again).
create function neo_wqt.no_jwt() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.email', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

create function neo_wqt.assert(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_msg; end if;
end $$;

create function neo_wqt.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
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

-- One item of a work_queue() / work_team() feed, and where it sits.
create function neo_wqt.item(p_feed jsonb, p_kind text, p_id text) returns jsonb language sql immutable as $$
  select e.value from jsonb_array_elements(coalesce(p_feed -> 'items', '[]'::jsonb)) as e(value)
   where e.value ->> 'kind' = p_kind and e.value ->> 'id' = p_id limit 1
$$;
create function neo_wqt.pos(p_feed jsonb, p_kind text, p_id text) returns bigint language sql immutable as $$
  select e.n from jsonb_array_elements(coalesce(p_feed -> 'items', '[]'::jsonb)) with ordinality as e(value, n)
   where e.value ->> 'kind' = p_kind and e.value ->> 'id' = p_id limit 1
$$;
create function neo_wqt.person(p_team jsonb, p_email text) returns jsonb language sql immutable as $$
  select e.value from jsonb_array_elements(coalesce(p_team -> 'people', '[]'::jsonb)) as e(value)
   where lower(e.value ->> 'email') = lower(p_email) limit 1
$$;
create function neo_wqt.has_id(p_list jsonb, p_id text) returns boolean language sql immutable as $$
  select exists (select 1 from jsonb_array_elements(coalesce(p_list, '[]'::jsonb)) as e(value)
                  where (jsonb_typeof(e.value) = 'string' and e.value #>> '{}' = p_id)
                     or (jsonb_typeof(e.value) = 'object' and e.value ->> 'id' = p_id))
$$;
create function neo_wqt.reason_of(p_list jsonb, p_id text) returns text language sql immutable as $$
  select e.value ->> 'reason' from jsonb_array_elements(coalesce(p_list, '[]'::jsonb)) as e(value)
   where e.value ->> 'id' = p_id limit 1
$$;
-- The HH:MM a sentence shows for "now + p" (shop time).
create function neo_wqt.hm(p interval) returns text language sql stable as $$
  select to_char((now() + p) at time zone 'Asia/Kolkata', 'HH24:MI')
$$;

grant execute on all functions in schema neo_wqt to anon, authenticated;

-- Owner-only helpers (created after the grant above, so no client may call them).
-- Run SQL with every trigger standing aside (exact back-dating).
create function neo_wqt.raw(p_sql text) returns void language plpgsql as $$
begin
  perform set_config('neo.migrating', '1', true);
  execute p_sql;
  perform set_config('neo.migrating', '', true);
end $$;
-- A build exactly as given: p_queued_ago null = a quote; p_tech = a name-only assignment.
create function neo_wqt.mkbuild(p_id text, p_customer text, p_tier int, p_queued_ago interval,
                                p_tech text default null, p_tech_email text default null) returns void language plpgsql as $$
begin
  perform set_config('neo.migrating', '1', true);
  insert into public.tickets (id, type, customer_name, status, technician, technician_email, assigned_via, assigned_at,
                              queued_at, specs, created_at, updated_at)
  values (p_id, 'build', p_customer, 'building', p_tech, p_tech_email,
          case when p_tech is not null or p_tech_email is not null then 'legacy' end,
          case when p_tech is not null or p_tech_email is not null then now() - interval '1 day' end,
          case when p_queued_ago is null then null else now() - p_queued_ago end,
          jsonb_build_object('cpu', 'Ryzen 5 7600', 'gpu', 'RTX 4060',
                             '__build', jsonb_build_object('tier', p_tier, 'importance', 'medium')),
          now() - interval '2 days', now() - interval '1 hour');
  perform set_config('neo.migrating', '', true);
end $$;
-- Room in someone's load: capacity = current points + p_room, max jobs = current jobs + p_slots.
create function neo_wqt.room(p_alias text, p_room int, p_slots int default 5) returns void language plpgsql as $$
declare l record; v_id uuid;
begin
  select u.id into v_id from neo_wqt.users u where u.alias = p_alias;
  select * into l from public._work_load(neo_wqt.email(p_alias));
  update public.staff_work set capacity_points = greatest(1, least(50, l.points + p_room)),
                               max_jobs = greatest(1, least(20, l.jobs + p_slots))
   where profile_id = v_id;
  if not found then raise exception 'TEST SETUP: no staff_work row for %', p_alias; end if;
end $$;
revoke all on function neo_wqt.raw(text) from public, anon, authenticated;
revoke all on function neo_wqt.mkbuild(text, text, int, interval, text, text) from public, anon, authenticated;
revoke all on function neo_wqt.room(text, int, int) from public, anon, authenticated;


-- ── 1. Test users, their roles and work settings ────────────────────────────
insert into neo_wqt.users (alias, id, email, tier, name)
select a.alias, p.id, p.email, p.tier, p.full_name
  from (values ('owner', 'ananthakrishnan@neotokyo.in'), ('ceo', 'ajay.joy@neotokyo.in'),
               ('cto', 'rony.thomas@neotokyo.in'), ('head', 'jophy.joseph@neotokyo.in'),
               ('desk', 'anagha.kc@neotokyo.in'), ('tech1', 'athul.sudheer@neotokyo.in'),
               ('tech2', 'adhil.m@neotokyo.in'), ('tech3', 'amal.c@neotokyo.in'),
               ('sales', 'kiran.raj@neotokyo.in'), ('plain', 'arathy.shibu@neotokyo.in')) as a(alias, email)
  join public.profiles p on lower(p.email) = a.email;

do $$
declare v_missing text;
begin
  select string_agg(a.alias, ', ') into v_missing
    from (values ('owner'), ('ceo'), ('cto'), ('head'), ('desk'), ('tech1'), ('tech2'), ('tech3'), ('sales'), ('plain')) as a(alias)
   where not exists (select 1 from neo_wqt.users u where u.alias = a.alias);
  if v_missing is not null then raise exception 'TEST SETUP: no profile for %', v_missing; end if;
  if exists (select 1 from neo_wqt.users u join public.profiles p on p.id = u.id
              where not p.active or not coalesce(p.is_staff, false)) then
    raise exception 'TEST SETUP: every test user must be an active staff profile';
  end if;
  if (select tier from neo_wqt.users where alias = 'owner') <> 5 then raise exception 'TEST SETUP: owner must be tier 5'; end if;
  if exists (select 1 from neo_wqt.users where alias in ('ceo', 'cto') and tier <> 4) then
    raise exception 'TEST SETUP: ceo and cto must be tier 4';
  end if;
  if (select tier from neo_wqt.users where alias = 'head') <> 3 then raise exception 'TEST SETUP: head must be tier 3'; end if;
  if exists (select 1 from neo_wqt.users where alias in ('desk', 'tech1', 'tech2', 'tech3', 'plain') and tier >= 3) then
    raise exception 'TEST SETUP: desk, techs and plain must be below tier 3 (tier 3+ are leads automatically)';
  end if;
  if (select tier from neo_wqt.users where alias = 'sales') <> 1 then raise exception 'TEST SETUP: sales must be tier 1'; end if;
  if (select count(distinct lower(public._first_name(name))) from neo_wqt.users) <> 10 then
    raise exception 'TEST SETUP: the test users need ten different first names';
  end if;
  if exists (select 1 from public.tickets where id like 't\_wqt\_%')
     or exists (select 1 from public.service_jobs where public.norm_phone(customer_phone) like '9190000003__')
     or exists (select 1 from public.profiles where lower(email) like '%@neotokyo.test')
     or exists (select 1 from public.designation_presets where key like 'zq %') then
    raise exception 'TEST SETUP: test ids / phones / emails are already in use; change the test values in this file';
  end if;
end $$;

-- Throw-away logins: two people sharing a first name, one with a unique one,
-- and a new sign-up who is not staff yet (handle_new_user makes the profile).
insert into auth.users (id, email, raw_user_meta_data) values
  ('a1111111-0000-4000-8000-000000000001', 'zq.twin.one@neotokyo.test', '{"full_name":"Zqtwin One"}'),
  ('a1111111-0000-4000-8000-000000000002', 'zq.twin.two@neotokyo.test', '{"full_name":"Zqtwin Two"}'),
  ('a1111111-0000-4000-8000-000000000003', 'zq.solo@neotokyo.test', '{"full_name":"Zqsolo Person"}'),
  ('a1111111-0000-4000-8000-000000000004', 'zq.newhire@neotokyo.test', '{"full_name":"Zqnew Hire"}');
update public.profiles set active = true, is_staff = true, tier = 1, full_name = case email
         when 'zq.twin.one@neotokyo.test' then 'Zqtwin One' when 'zq.twin.two@neotokyo.test' then 'Zqtwin Two'
         else 'Zqsolo Person' end
 where email in ('zq.twin.one@neotokyo.test', 'zq.twin.two@neotokyo.test', 'zq.solo@neotokyo.test');
update public.profiles set full_name = 'Zqnew Hire', tier = 1, is_staff = false, active = true
 where email = 'zq.newhire@neotokyo.test';
-- Two of them sign in too (work logs: no real synced logs can be theirs).
insert into neo_wqt.users (alias, id, email, tier, name)
select a.alias, p.id, p.email, p.tier, p.full_name
  from (values ('solo', 'zq.solo@neotokyo.test'), ('twin1', 'zq.twin.one@neotokyo.test')) as a(alias, email)
  join public.profiles p on p.email = a.email;
do $$
begin
  if (select count(*) from neo_wqt.users where alias in ('solo', 'twin1')) <> 2 then
    raise exception 'TEST SETUP: the throw-away logins did not get profiles (handle_new_user)';
  end if;
  if (public._staff_for_short_name(neo_wqt.first('tech1'))).id is distinct from (select id from neo_wqt.users where alias = 'tech1') then
    raise exception 'TEST SETUP: tech1''s first name must belong to tech1 alone among active staff';
  end if;
end $$;

-- Exactly the roles this file expects, whatever People says today.
delete from public.module_access
 where profile_id in (select id from neo_wqt.users where alias in ('desk', 'tech1', 'tech2', 'tech3', 'sales', 'plain', 'ceo'));
insert into public.module_access (profile_id, module, role, granted_by)
select u.id, m.module, m.role, 'tests'
  from neo_wqt.users u
  join (values ('ceo', 'qc', 'lead'),
               ('desk', 'service', 'desk'), ('desk', 'qc', 'desk'), ('desk', 'rma', 'desk'),
               ('tech1', 'service', 'tech'), ('tech1', 'qc', 'tech'),
               ('tech2', 'service', 'tech'), ('tech2', 'qc', 'tech'),
               ('tech3', 'service', 'tech'), ('tech3', 'qc', 'tech'), ('tech3', 'neohr', 'desk'),
               ('plain', 'qc', 'desk')) as m(alias, module, role)
    on m.alias = u.alias;

-- Nobody else is in a pool for the length of this transaction; the three
-- technicians are, and the owner and leads are not (tier 3+ are leads, not
-- automatically in a pool).
update public.staff_work set build_pool = false, service_pool = false
 where profile_id not in (select id from neo_wqt.users where alias in ('tech1', 'tech2', 'tech3'));
insert into public.staff_work (profile_id, build_pool, service_pool, build_level, updated_by)
select u.id, u.alias in ('tech1', 'tech2', 'tech3'), u.alias in ('tech1', 'tech2', 'tech3'),
       case u.alias when 'tech1' then 'junior' when 'tech3' then 'junior' when 'tech2' then 'senior' end, 'tests'
  from neo_wqt.users u
on conflict (profile_id) do update
   set build_pool = excluded.build_pool, service_pool = excluded.service_pool, build_level = excluded.build_level;
select neo_wqt.room('tech1', 10), neo_wqt.room('tech2', 8), neo_wqt.room('tech3', 6);

-- Park every existing open item: no offers, and work_tick's step 2 skips them
-- for this whole transaction (auto_tried_at = now(), now() does not move).
select neo_wqt.raw($q$
  update public.tickets set auto_tried_at = now(), offered_to_email = null, offered_to_name = null, offer_kind = null,
         offer_by_email = null, offer_by_name = null, offer_reason = null, offered_at = null, offer_expires_at = null
   where status is distinct from 'completed'$q$);
select neo_wqt.raw($q$
  update public.service_jobs set auto_tried_at = now(), offered_to_email = null, offered_to_name = null, offer_kind = null,
         offer_by_email = null, offer_by_name = null, offer_reason = null, offered_at = null, offer_expires_at = null
   where stage <> 'closed'$q$);

-- The builds this file works on.
select neo_wqt.mkbuild('t_wqt_b1', 'Zq Build One', 2, interval '1 hour');      -- open, not due
select neo_wqt.mkbuild('t_wqt_b2', 'Zq Build Senior', 5, interval '1 hour');   -- tier 5: seniors only
select neo_wqt.mkbuild('t_wqt_b3', 'Zq Build Quote', 1, null);                 -- not sent to the floor
select neo_wqt.mkbuild('t_wqt_b4', 'Zq Build Late', 1, interval '5 hours');    -- past its 4 hours
select neo_wqt.mkbuild('t_wqt_b5', 'Zq Build Offer', 3, interval '1 hour');    -- for offers
select neo_wqt.mkbuild('t_wqt_b6', 'Zq Build Quote Offer', 1, null);
select neo_wqt.mkbuild('t_wqt_b7', 'Zq Build Tier Change', 3, interval '1 hour');
select neo_wqt.mkbuild('t_wqt_b8', 'Zq Build Pool Change', 2, interval '1 hour');
select neo_wqt.mkbuild('t_wqt_b9', 'Zq Build Legacy', 2, null, 'Jagathzq Vishnu', null);   -- name-only, a leaver
select neo_wqt.mkbuild('t_wqt_c1', 'Zq Build Completed Later', 1, interval '1 hour');
select neo_wqt.mkbuild('t_wqt_d1', 'Zq Build Deleted Later', 1, interval '5 hours');


-- ── 2. Schema facts, RLS, grants (as the owner) ─────────────────────────────
do $$
declare
  t text; f record; v_api text[] := array[
    'work_queue','work_claim','work_offer','work_respond','work_release','build_queue_send','work_team',
    'work_events_for','work_tick','work_alert_resolve','my_work_profile','my_modules','service_tech_list',
    'service_claim','service_create','staff_list','staff_update','staff_apply_preset','preset_list',
    'preset_upsert','preset_delete','work_log_push','work_log_pull','work_log_team'];
  v_internal text[] := array[
    '_designation_key','_build_tier','_first_name','_staff_for_short_name','_work_defaults','_work_settings',
    '_work_cost_build','_work_cost_service','_work_load','_work_why_not','_work_why_text','_svc_category_label',
    '_ist_hm','_work_kind','_work_offer_blocks','_work_me_lock','_work_event','_work_alert','_work_alerts_resolve',
    '_work_offer_set','_work_offer_clear','_work_pick','_work_auto_offer','_work_item','_svc_apply_visit',
    '_svc_visit_event','_work_accept','_work_expire','_work_release_build','_work_person_gone','_preset_apply',
    '_work_staff_entry','_work_lockdown','tg_tickets_work_guard','tg_tickets_work_added','tg_tickets_work_gone',
    'tg_service_jobs_work_gone','tg_service_jobs_zy_offer_guard','tg_service_jobs_zy_offer_insert'];
  n int;
begin
  foreach t in array array['staff_work', 'designation_presets', 'work_alerts', 'work_events', 'work_logs'] loop
    perform neo_wqt.assert((select relrowsecurity from pg_class where oid = format('public.%I', t)::regclass), t || ': RLS is on');
    perform neo_wqt.assert(not has_table_privilege('anon', format('public.%I', t), 'select')
                           and not has_table_privilege('anon', format('public.%I', t), 'insert'),
                           t || ': anon has no privilege');
    perform neo_wqt.assert(has_table_privilege('authenticated', format('public.%I', t), 'select')
                           and not has_table_privilege('authenticated', format('public.%I', t), 'insert')
                           and not has_table_privilege('authenticated', format('public.%I', t), 'update')
                           and not has_table_privilege('authenticated', format('public.%I', t), 'delete')
                           and not has_table_privilege('authenticated', format('public.%I', t), 'truncate'),
                           t || ': authenticated may only select');
  end loop;
  perform neo_wqt.assert(not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'work_logs'),
                         'work_logs is never published');
  perform neo_wqt.assert(exists (select 1 from pg_publication where pubname = 'supabase_realtime') = exists (
                           select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'work_alerts'),
                         'work_alerts is in realtime (when the publication exists)');

  -- every new column on the old tables is nullable or defaulted (old inserts name explicit columns)
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name in ('tickets', 'service_jobs') and is_nullable = 'NO' and column_default is null
     and column_name in ('technician_email','assigned_via','assigned_at','assign_reason','queued_at','offered_to_email',
                         'offered_to_name','offer_kind','offer_by_email','offer_by_name','offer_reason','offered_at',
                         'offer_expires_at','declined_emails','auto_tried_at');
  perform neo_wqt.assert(n = 0, 'new columns on tickets / service_jobs are nullable or defaulted');
  perform neo_wqt.assert(exists (select 1 from pg_constraint where conname = 'service_jobs_assigned_via_check'
                                   and pg_get_constraintdef(oid) like '%auto%' and pg_get_constraintdef(oid) like '%self%'),
                         'service_jobs.assigned_via accepts auto and keeps self');
  -- trigger order: v2 guard, then the offer guard, then v2.1's purge
  perform neo_wqt.assert('trg_service_jobs_guard' < 'trg_service_jobs_zy_offer_guard'
                         and 'trg_service_jobs_zy_offer_guard' < 'trg_service_jobs_zz_secret_purge'
                         and exists (select 1 from pg_trigger where tgname = 'trg_service_jobs_zy_offer_guard')
                         and exists (select 1 from pg_trigger where tgname = 'trg_tickets_work_guard')
                         and exists (select 1 from pg_trigger where tgname = 'trg_tickets_work_gone')
                         and exists (select 1 from pg_trigger where tgname = 'trg_service_jobs_work_gone'),
                         'the v2.2 triggers exist, in the right order');

  for f in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = any (v_api || v_internal) loop
    perform neo_wqt.assert(not has_function_privilege('anon', f.oid, 'execute'), 'anon cannot execute ' || f.proname);
    if f.proname = any (v_api) then
      perform neo_wqt.assert(has_function_privilege('authenticated', f.oid, 'execute'), 'authenticated may execute ' || f.proname);
      perform neo_wqt.assert(f.prosecdef and array_to_string(f.proconfig, ',') like '%search_path=public%',
                             f.proname || ' is security definer with search_path = public');
    else
      perform neo_wqt.assert(not has_function_privilege('authenticated', f.oid, 'execute'), 'authenticated cannot execute ' || f.proname);
    end if;
    if f.proname like 'tg\_%' then
      perform neo_wqt.assert(f.prosecdef and array_to_string(f.proconfig, ',') like '%search_path=public%',
                             f.proname || ' (a trigger) is security definer with search_path = public');
    end if;
  end loop;
  select count(*) into n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any (v_api || v_internal);
  perform neo_wqt.assert(n = cardinality(v_api) + cardinality(v_internal),
                         format('every v2.2 function exists exactly once (%s of %s)', n, cardinality(v_api) + cardinality(v_internal)));
  perform neo_wqt.assert((select count(*) from pg_proc where proname in ('my_modules', 'service_tech_list', 'service_claim')
                            and pronamespace = 'public'::regnamespace) = 3,
                         'A14: my_modules, service_tech_list and service_claim have one overload each');
  perform neo_wqt.assert((select pg_get_function_identity_arguments(oid) from pg_proc where proname = 'service_claim'
                            and pronamespace = 'public'::regnamespace)
                         = 'p_job_id text, p_visit_start timestamp with time zone, p_visit_end timestamp with time zone, p_reason text',
                         'A14: service_claim keeps its exact v2 signature');
  perform neo_wqt.assert((select pg_get_function_identity_arguments(oid) from pg_proc where proname = 'work_offer'
                            and pronamespace = 'public'::regnamespace) = 'p_kind text, p_id text, p_email text, p_reason text, p_expected text',
                         '9.1: work_offer takes p_expected');
  perform neo_wqt.assert((select pg_get_function_identity_arguments(oid) from pg_proc where proname = 'work_log_pull'
                            and pronamespace = 'public'::regnamespace) = 'p_since timestamp with time zone, p_after uuid',
                         '9.1: work_log_pull takes (p_since, p_after)');

  -- pure helpers
  perform neo_wqt.assert(public._build_tier('{"__build":{"tier":4}}') = 4 and public._build_tier('{"__build":{"tier":"5"}}') = 5
                         and public._build_tier('{"__build":{"tier":9}}') = 5 and public._build_tier('{"__build":{"tier":0}}') = 1
                         and public._build_tier('{"__build":{"tier":"x"}}') = 1 and public._build_tier('{"__build":"x"}') = 1
                         and public._build_tier('{}') = 1 and public._build_tier(null) = 1 and public._build_tier('[1]') = 1
                         and public._build_tier('{"__build":{"tier":3.7}}') = 3
                         and public._build_tier('{"__build":{"tier":99999999999999999999}}') = 1,
                         '_build_tier parses safely, clamps 1..5, defaults to 1');
  perform neo_wqt.assert(public._designation_key('  Service   Engineer ') = 'service engineer'
                         and public._designation_key(null) = '', '_designation_key normalises');
  perform neo_wqt.assert(public._first_name('  Adhil   M ') = 'Adhil' and public._first_name(null) = '', '_first_name');
  perform neo_wqt.assert((public._work_defaults('senior')).capacity = 8 and (public._work_defaults('senior')).max_jobs = 5
                         and (public._work_defaults('junior')).capacity = 5 and (public._work_defaults('junior')).max_jobs = 3
                         and (public._work_defaults(null)).capacity = 6 and (public._work_defaults(null)).max_jobs = 4,
                         '_work_defaults: senior 8/5, junior 5/3, none 6/4');
  perform neo_wqt.assert(public._work_cost_service('on_site') = 2 and public._work_cost_service('in_store') = 1
                         and public._work_cost_service('remote') = 1 and public._work_cost_build('{"__build":{"tier":3}}') = 3,
                         'load points: build = tier, on-site 2, other service 1');
  perform neo_wqt.assert((public._staff_for_short_name('Zqsolo')).email = 'zq.solo@neotokyo.test'
                         and (public._staff_for_short_name('zqsolo whatever')).email = 'zq.solo@neotokyo.test'
                         and (public._staff_for_short_name('Zqtwin')).id is null
                         and (public._staff_for_short_name('Zqnew')).id is null
                         and (public._staff_for_short_name('Nobodyzq')).id is null
                         and (public._staff_for_short_name('')).id is null,
                         '_staff_for_short_name: exactly one active staff match by first name, else nulls');
  perform neo_wqt.assert(public._work_why_text('build', 'no_role', true) = 'You don''t have the Builds technician role.'
                         and public._work_why_text('service', 'no_role', false) = 'They don''t have the Service technician role.'
                         and public._work_why_text('build', 'no_pool', true) = 'You aren''t in the build pool.'
                         and public._work_why_text('service', 'no_pool', false) = 'They aren''t in the service pool.'
                         and public._work_why_text('build', 'not_staff', false) = 'They don''t have an active staff account.'
                         and public._work_why_text('build', 'senior', true) = 'This is a high-value build — only senior builders can take it.',
                         'the §1 eligibility sentences');
  perform neo_wqt.assert(public._work_why_not('build', 5, (select id from neo_wqt.users where alias = 'tech1')) = 'senior'
                         and public._work_why_not('build', 3, (select id from neo_wqt.users where alias = 'tech1')) is null
                         and public._work_why_not('build', 5, (select id from neo_wqt.users where alias = 'tech2')) is null
                         and public._work_why_not('build', 1, (select id from neo_wqt.users where alias = 'sales')) = 'no_role'
                         and public._work_why_not('build', 1, (select id from neo_wqt.users where alias = 'head')) = 'no_pool'
                         and public._work_why_not('service', null, (select id from neo_wqt.users where alias = 'desk')) = 'no_role'
                         and public._work_why_not('service', null, (select id from profiles where email = 'zq.newhire@neotokyo.test')) = 'not_staff',
                         '_work_why_not: senior / role / pool / staff');
end $$;


-- ── 3. Anonymous visitors: nothing ───────────────────────────────────────────
select neo_wqt.login_anon();
do $$
declare t text;
begin
  foreach t in array array['staff_work', 'designation_presets', 'work_alerts', 'work_events', 'work_logs'] loop
    perform neo_wqt.expect_error(format('select count(*) from public.%I', t), '%permission denied%');
  end loop;
  perform neo_wqt.expect_error($q$select public.work_queue()$q$, '%permission denied%');
  perform neo_wqt.expect_error($q$select public.work_tick()$q$, '%permission denied%');
  perform neo_wqt.expect_error($q$select public.my_work_profile()$q$, '%permission denied%');
  perform neo_wqt.expect_error($q$select public.work_claim('build', 't_wqt_b1')$q$, '%permission denied%');
  perform neo_wqt.expect_error($q$select public.work_log_push('[]'::jsonb)$q$, '%permission denied%');
  perform neo_wqt.expect_error($q$select public.staff_list()$q$, '%permission denied%');
  perform neo_wqt.expect_error($q$select public.my_modules()$q$, '%permission denied%');
  perform neo_wqt.expect_error($q$select public._work_why_not('build', 1, null)$q$, '%permission denied%');
  -- the tracking page is untouched
  perform neo_wqt.assert((select count(*) from public.get_ticket_public('WQT_B1')) = 1
                         and (select technician from public.get_ticket_public('WQT_B1')) is null,
                         'get_ticket_public still answers anon');
end $$;


-- ── 4. Who sees the queue; my_modules / service_tech_list / my_work_profile ──
select neo_wqt.login('sales');
do $$
declare r jsonb;
begin
  perform neo_wqt.expect_error($q$select public.work_queue()$q$, '%NEO_DENIED: The work queue is for the build and service teams.%');
  r := public.my_work_profile();
  perform neo_wqt.assert(r ->> 'home' = 'logs' and not (r ->> 'team_view')::boolean and not (r ->> 'desk_builds')::boolean,
                         'my_work_profile: sales go to logs');
  r := public.my_modules();
  perform neo_wqt.assert(r ? 'service' and r ? 'rma' and r ? 'qc' and r ? 'neohr' and r ? 'tier'
                         and r ? 'build_pool' and r ? 'service_pool' and r ? 'build_level'
                         and not (r ->> 'build_pool')::boolean and r ->> 'build_level' is null,
                         'my_modules keeps v2''s keys and adds pools / level');
  perform neo_wqt.expect_error($q$select public.work_team()$q$, '%NEO_DENIED: Only leads can see the team.%');
  perform neo_wqt.expect_error($q$select public.work_claim('build', 't_wqt_b1')$q$,
                               '%NEO_GATE: You don''t have the Builds technician role.%');
  perform neo_wqt.expect_error($q$select public.work_claim('parcel', 't_wqt_b1')$q$, '%NEO_GATE: Say which kind of work%');
end $$;

select neo_wqt.login('tech1');
do $$
declare r jsonb; e jsonb;
begin
  r := public.my_modules();
  perform neo_wqt.assert((r ->> 'build_pool')::boolean and (r ->> 'service_pool')::boolean and r ->> 'build_level' = 'junior'
                         and r ->> 'qc' = 'tech' and r ->> 'service' = 'tech', 'my_modules reports tech1''s pools and level');
  r := public.my_work_profile();
  perform neo_wqt.assert(r ->> 'home' = 'work' and (r ->> 'desk_builds')::boolean and (r ->> 'desk_service')::boolean
                         and not (r ->> 'lead_builds')::boolean and not (r ->> 'team_view')::boolean
                         and r -> 'modules' ->> 'qc' = 'tech' and r ->> 'email' = neo_wqt.email('tech1')
                         and (r ->> 'capacity_points')::int >= 1 and r ? 'designation' and r ? 'department',
                         format('my_work_profile for a technician (%s)', r));
  r := public.service_tech_list();
  select e2.value into e from jsonb_array_elements(r) as e2(value) where lower(e2.value ->> 'email') = neo_wqt.email('tech1');
  perform neo_wqt.assert(e is not null and e ? 'name' and e ? 'designation' and e ? 'role' and e ? 'open_count'
                         and e ? 'visits_today' and e ? 'in_queue_requested' and e ? 'service_pool' and e ? 'build_pool'
                         and e ? 'build_level' and e ? 'points' and e ? 'jobs' and e ? 'capacity_points' and e ? 'max_jobs',
                         format('service_tech_list keeps v2''s keys and adds the new ones (%s)', e));
  perform neo_wqt.assert(not exists (select 1 from jsonb_array_elements(r) as x(value)
                                      where lower(x.value ->> 'email') in (neo_wqt.email('owner'), neo_wqt.email('head'),
                                                                           neo_wqt.email('desk'), neo_wqt.email('ceo'))),
                         'service_tech_list: only service-pool members (no owner / heads / desk)');
  r := public.work_queue();
  perform neo_wqt.assert(r ? 'now' and (r ->> 'claim_hours')::int = 4 and (r ->> 'offer_minutes')::int = 30
                         and r -> 'me' ->> 'email' = neo_wqt.email('tech1') and (r -> 'me' ->> 'build_pool')::boolean
                         and r -> 'me' ? 'points' and r -> 'me' ? 'capacity_points' and jsonb_typeof(r -> 'alerts') = 'array'
                         and jsonb_array_length(r -> 'alerts') = 0, 'work_queue: the frame and no alerts for a technician');
  e := neo_wqt.item(r, 'build', 't_wqt_b1');
  perform neo_wqt.assert(e is not null and (e ->> 'can_claim')::boolean and e ->> 'why_not' is null
                         and e ->> 'code' = 'WQT_B1' and e ->> 'title' = 'Zq Build One' and e ->> 'sub' = 'Ryzen 5 7600 · RTX 4060'
                         and (e ->> 'build_tier')::int = 2 and (e ->> 'cost')::int = 2 and not (e ->> 'needs_senior')::boolean
                         and (e ->> 'claim_due')::timestamptz = (e ->> 'queued_at')::timestamptz + interval '4 hours'
                         and e ->> 'offer' is null and not (e ->> 'mine')::boolean and e ->> 'service_type' is null,
                         format('work_queue: an open build (%s)', e));
  e := neo_wqt.item(r, 'build', 't_wqt_b2');
  perform neo_wqt.assert(not (e ->> 'can_claim')::boolean and (e ->> 'needs_senior')::boolean
                         and e ->> 'why_not' = 'This is a high-value build — only senior builders can take it.',
                         'work_queue: a tier-5 build tells a junior why not');
  perform neo_wqt.assert(neo_wqt.item(r, 'build', 't_wqt_b3') is null, 'a quote is not in the queue');
  perform neo_wqt.assert(neo_wqt.item(r, 'build', 't_wqt_b9') is null, 'a name-only (legacy) build is not open');
  perform neo_wqt.assert(neo_wqt.pos(r, 'build', 't_wqt_b4') < neo_wqt.pos(r, 'build', 't_wqt_b1'),
                         'open items: the most overdue first (claim_due ascending)');
end $$;

select neo_wqt.login('plain');      -- qc desk only (builds, no service)
do $$
declare r jsonb;
begin
  r := public.work_queue();
  perform neo_wqt.assert(neo_wqt.item(r, 'build', 't_wqt_b1') is not null
                         and not exists (select 1 from jsonb_array_elements(r -> 'items') as e(value) where e.value ->> 'kind' = 'service'),
                         'a builds-desk person sees builds and no service items');
  perform neo_wqt.assert(neo_wqt.item(r, 'build', 't_wqt_b1') ->> 'why_not' = 'You don''t have the Builds technician role.',
                         'the desk is told why it cannot claim');
end $$;


-- ── 5. Builds: claim, already, taken, senior, pool, send to the floor ───────
select neo_wqt.login('tech1');
do $$
declare r jsonb;
begin
  perform neo_wqt.expect_error($q$select public.work_claim('build', 't_wqt_b2')$q$,
                               '%NEO_GATE: This is a high-value build — only senior builders can take it.%');
  r := public.work_claim('build', 't_wqt_b1');
  perform neo_wqt.assert((r ->> 'ok')::boolean and (r -> 'item' ->> 'mine')::boolean
                         and r -> 'item' ->> 'assignee_email' = neo_wqt.email('tech1')
                         and r -> 'item' ->> 'assigned_via' = 'claim' and r -> 'item' ->> 'claim_due' is null,
                         format('tech1 claims an open build (%s)', r));
  r := public.work_claim('build', 't_wqt_b1');
  perform neo_wqt.assert((r ->> 'ok')::boolean and (r ->> 'already')::boolean, 'A17: claiming my own build again answers already');
  r := public.work_claim('build', 't_wqt_b3');
  perform neo_wqt.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'not_queued', 'a quote cannot be claimed (not_queued)');
  r := public.work_claim('build', 't_wqt_nope');
  perform neo_wqt.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'not_found', 'an unknown build: not_found');
  r := public.build_queue_send('t_wqt_nope');
  perform neo_wqt.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'not_found', 'C1: build_queue_send answers not_found');
end $$;

reset role;
do $$
declare t public.tickets;
begin
  perform neo_wqt.no_jwt();
  select * into t from public.tickets where id = 't_wqt_b1';
  perform neo_wqt.assert(t.technician = public._first_name(neo_wqt.name('tech1')) and t.technician_email = neo_wqt.email('tech1')
                         and t.assigned_via = 'claim' and t.assigned_at = now() and t.queued_at is null
                         and t.declined_emails = '{}' and t.updated_at >= now(),
                         'the claim wrote the short name, the email, the stamps and a newer updated_at');
  perform neo_wqt.assert((select count(*) from public.work_events where item_kind = 'build' and item_id = 't_wqt_b1' and kind = 'claim') = 1,
                         'one claim event (the repeat wrote none)');
end $$;

select neo_wqt.login('tech2');
do $$
declare r jsonb;
begin
  r := public.work_claim('build', 't_wqt_b1');
  perform neo_wqt.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'taken' and r ->> 'by_email' = neo_wqt.email('tech1')
                         and r ->> 'by' = neo_wqt.first('tech1'), 'a second claim: taken, naming the first');
  r := public.work_claim('build', 't_wqt_b2');
  perform neo_wqt.assert((r ->> 'ok')::boolean, 'a senior builder takes the tier-5 build');
end $$;

select neo_wqt.login('head');       -- tier 3: lead everywhere, in no pool
do $$
begin
  perform neo_wqt.expect_error($q$select public.work_claim('build', 't_wqt_b4')$q$, '%NEO_GATE: You aren''t in the build pool.%');
end $$;

select neo_wqt.login('plain');
do $$
declare r jsonb;
begin
  r := public.build_queue_send('t_wqt_b3');
  perform neo_wqt.assert((r ->> 'ok')::boolean and not (r ? 'already') and r -> 'item' ->> 'claim_due' is not null,
                         'the builds desk sends a quote to the floor');
  r := public.build_queue_send('t_wqt_b3');
  perform neo_wqt.assert((r ->> 'ok')::boolean and (r ->> 'already')::boolean, 'sending again: already');
  r := public.build_queue_send('t_wqt_b1');
  perform neo_wqt.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'assigned', 'a claimed build: assigned');
  r := public.build_queue_send('t_wqlegacy_nope_' || 'x');
  perform neo_wqt.assert(r ->> 'reason' = 'not_found', 'an unknown build: not_found');
end $$;

select neo_wqt.login('sales');
do $$
begin
  perform neo_wqt.expect_error($q$select public.build_queue_send('t_wqt_b6')$q$, '%NEO_DENIED%');
end $$;

reset role;
do $$
begin
  perform neo_wqt.no_jwt();
  perform neo_wqt.assert((select queued_at from public.tickets where id = 't_wqt_b3') = now(), 'build_queue_send started the claim clock');
  perform neo_wqt.assert((select count(*) from public.work_events where item_id = 't_wqt_b3' and kind = 'queued') = 1,
                         'one queued event');
  -- a completed build: closed
  perform neo_wqt.raw($q$update public.tickets set status = 'completed', queued_at = null where id = 't_wqt_c1'$q$);
end $$;
select neo_wqt.login('plain');
do $$
begin
  perform neo_wqt.assert(public.build_queue_send('t_wqt_c1') ->> 'reason' = 'closed', 'a completed build: closed');
end $$;


-- ── 6. Builds: hand back ─────────────────────────────────────────────────────
select neo_wqt.login('tech2');
do $$
begin
  perform neo_wqt.expect_error($q$select public.work_release('build', 't_wqt_b1', 'Not mine')$q$,
                               '%NEO_DENIED: Only the technician who has this build, or a lead, can hand it back.%');
  perform neo_wqt.expect_error($q$select public.work_release('build', 't_wqt_b9', 'Leaver')$q$,
                               '%NEO_DENIED: Only the technician who has this build, or a lead, can hand it back.%');
end $$;

select neo_wqt.login('tech1');
do $$
declare r jsonb;
begin
  perform neo_wqt.expect_error($q$select public.work_release('build', 't_wqt_b1', '  ')$q$, '%NEO_GATE: Say why you''re handing it back.%');
  perform neo_wqt.expect_error(format('select public.work_release(%L, %L, %L)', 'build', 't_wqt_b1', repeat('x', 301)),
                               '%NEO_GATE: The reason is too long%');
  r := public.work_release('build', 't_wqt_b1', 'Parts are late');
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'item' ->> 'assignee_email' is null
                         and r -> 'item' ->> 'claim_due' is not null and (r -> 'item' ->> 'declined_count')::int = 1
                         and (r -> 'item' ->> 'can_claim')::boolean,
                         format('the technician hands the build back (%s)', r));
  perform neo_wqt.expect_error($q$select public.work_release('build', 't_wqt_b1', 'Again')$q$, '%NEO_STALE: Nobody has this build now — refresh.%');
  perform neo_wqt.expect_error($q$select public.work_release('build', 't_wqt_c1', 'Done')$q$, '%NEO_GATE: This build is finished.%');
end $$;

select neo_wqt.login('head');
do $$
declare r jsonb;
begin
  r := public.work_release('build', 't_wqt_b9', 'The technician has left');
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'item' ->> 'assignee_name' is null,
                         'C12: a lead hands back a name-only (legacy) build — never NEO_STALE');
end $$;

reset role;
do $$
declare t public.tickets;
begin
  perform neo_wqt.no_jwt();
  select * into t from public.tickets where id = 't_wqt_b1';
  perform neo_wqt.assert(t.technician is null and t.technician_email is null and t.assigned_via is null and t.queued_at = now()
                         and t.declined_emails = array[neo_wqt.email('tech1')],
                         'release: back in the queue, the releaser skipped for this cycle');
  select * into t from public.tickets where id = 't_wqt_b9';
  perform neo_wqt.assert(t.technician is null and t.queued_at is not null and t.declined_emails = '{}',
                         'A13: releasing a name-only build leaves declined_emails empty (no null)');
  perform neo_wqt.assert((select body from public.work_events where item_id = 't_wqt_b9' and kind = 'release')
                         like 'Handed back by % (was Jagathzq Vishnu): The technician has left', 'the release event names who had it');
end $$;


-- ── 7. Builds: offers (lead), decline, accept, reassignment, withdraw ───────
select neo_wqt.login('tech1');
do $$
begin
  perform neo_wqt.expect_error(format('select public.work_offer(%L, %L, %L, %L)', 'build', 't_wqt_b5', neo_wqt.email('tech2'), 'x'),
                               '%NEO_DENIED: Only a lead can offer work to a technician.%');
end $$;

select neo_wqt.login('head');
do $$
declare r jsonb;
begin
  perform neo_wqt.expect_error(format('select public.work_offer(%L, %L, %L, %L)', 'build', 't_wqt_b5', neo_wqt.email('tech2'), ''),
                               '%NEO_GATE: Say why you''re offering it to them.%');
  perform neo_wqt.expect_error(format('select public.work_offer(%L, %L, %L, %L)', 'build', 't_wqt_b5', 'nobody@neotokyo.test', 'Hi'),
                               '%NEO_GATE: No active staff account with that email.%');
  perform neo_wqt.expect_error(format('select public.work_offer(%L, %L, %L, %L)', 'build', 't_wqt_b5', neo_wqt.email('sales'), 'Hi'),
                               '%NEO_GATE: ' || neo_wqt.name('sales') || ' can''t take this — they don''t have the Builds technician role.%');
  perform neo_wqt.expect_error(format('select public.work_offer(%L, %L, %L, %L)', 'build', 't_wqt_b4', neo_wqt.email('head'), 'Hi'),
                               '%can''t take this — they aren''t in the build pool.%');
  perform neo_wqt.expect_error(format('select public.work_offer(%L, %L, %L, %L, %L)', 'build', 't_wqt_b2', neo_wqt.email('tech1'), 'Hi',
                                      neo_wqt.email('tech2')),
                               '%can''t take this — this is a high-value build — only senior builders can take it.%');
  perform neo_wqt.expect_error(format('select public.work_offer(%L, %L, %L, %L)', 'build', 't_wqt_c1', neo_wqt.email('tech2'), 'Hi'),
                               '%NEO_GATE: This one is finished.%');
  perform neo_wqt.expect_error(format('select public.work_offer(%L, %L, %L, %L)', 'build', 't_wqt_gone', neo_wqt.email('tech2'), 'Hi'),
                               '%NEO_GATE: That build no longer exists.%');

  r := public.work_offer('build', 't_wqt_b5', neo_wqt.email('tech2'), 'You built the last one like it');
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'item' -> 'offer' ->> 'to_email' = neo_wqt.email('tech2')
                         and r -> 'item' -> 'offer' ->> 'kind' = 'manager'
                         and (r -> 'item' -> 'offer' ->> 'expires_at')::timestamptz = now() + interval '30 minutes'
                         and r -> 'item' -> 'offer' ->> 'by_name' = neo_wqt.name('head'),
                         format('a lead offers a build: 30 minutes (%s)', r));
  r := public.work_offer('build', 't_wqt_b5', neo_wqt.email('tech3'), 'Second thought');
  perform neo_wqt.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'offered' and r ->> 'to_name' = neo_wqt.name('tech2'),
                         '9.1: offering to someone else while an offer is live: offered (withdraw first)');
  r := public.work_offer('build', 't_wqt_b5', neo_wqt.email('tech3'), 'x', neo_wqt.email('tech1'));
  perform neo_wqt.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'changed', 'C8: p_expected that does not match: changed');
end $$;

select neo_wqt.login('tech1');
do $$
declare r jsonb; e jsonb;
begin
  r := public.work_claim('build', 't_wqt_b5');
  perform neo_wqt.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'offered' and r ->> 'to_name' = neo_wqt.name('tech2')
                         and r ->> 'by' = neo_wqt.name('tech2') and (r ->> 'expires_at')::timestamptz = now() + interval '30 minutes',
                         'A1: while an offer is live, nobody else may claim it');
  e := neo_wqt.item(public.work_queue(), 'build', 't_wqt_b5');
  perform neo_wqt.assert(not (e ->> 'can_claim')::boolean
                         and e ->> 'why_not' = 'Offered to ' || neo_wqt.name('tech2') || ' until ' || neo_wqt.hm(interval '30 minutes') || '.',
                         format('A11: why_not names the person and the India time (%s)', e ->> 'why_not'));
  r := public.work_respond('build', 't_wqt_b5', true);
  perform neo_wqt.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'not_offered', 'responding to someone else''s offer: not_offered');
end $$;

select neo_wqt.login('tech2');
do $$
declare r jsonb;
begin
  r := public.work_queue();
  perform neo_wqt.assert(neo_wqt.pos(r, 'build', 't_wqt_b5') = 1 and (neo_wqt.item(r, 'build', 't_wqt_b5') ->> 'offered_to_me')::boolean
                         and (neo_wqt.item(r, 'build', 't_wqt_b5') ->> 'can_claim')::boolean,
                         'an offer to me comes first in my feed');
  perform neo_wqt.assert((r -> 'me' ->> 'points')::int >= 3, 'a live offer counts toward my load');
  perform neo_wqt.expect_error($q$select public.work_respond('build', 't_wqt_b5', false, '')$q$, '%NEO_GATE: Say why you can''t take it.%');
  perform neo_wqt.expect_error(format('select public.work_respond(%L, %L, false, %L)', 'build', 't_wqt_b5', repeat('y', 301)),
                               '%NEO_GATE: The reason is too long%');
  r := public.work_respond('build', 't_wqt_b5', false, 'Two builds on the bench already');
  perform neo_wqt.assert((r ->> 'ok')::boolean and (r ->> 'declined')::boolean and r -> 'next' = 'null'::jsonb,
                         'a decline before the 4 hours: no automatic next offer');
  r := public.work_respond('build', 't_wqt_b5', true);
  perform neo_wqt.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'expired', 'after declining, the offer is expired for me');
end $$;

reset role;
do $$
declare t public.tickets;
begin
  perform neo_wqt.no_jwt();
  select * into t from public.tickets where id = 't_wqt_b5';
  perform neo_wqt.assert(t.offered_to_email is null and t.offer_expires_at is null and t.declined_emails = array[neo_wqt.email('tech2')],
                         'decline: the offer ends, the person is skipped');
  perform neo_wqt.assert(exists (select 1 from public.work_alerts where item_id = 't_wqt_b5' and kind = 'declined'
                                   and resolved_at is null and person_email = neo_wqt.email('tech2')
                                   and body = neo_wqt.name('tech2') || ' declined WQT_B5: Two builds on the bench already'),
                         'decline: leads get an alert with the reason');
  perform neo_wqt.assert((select count(*) from public.work_events where item_id = 't_wqt_b5' and kind in ('offer', 'decline')) = 2,
                         'offer and decline are in the history');
end $$;

select neo_wqt.login('head');
do $$
declare r jsonb;
begin
  r := public.work_offer('build', 't_wqt_b5', upper(neo_wqt.email('tech2')), 'Please — nobody else is free');
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'item' -> 'offer' ->> 'to_email' = neo_wqt.email('tech2'),
                         'a lead may offer again to someone who declined (emails stored lower-case)');
  perform neo_wqt.assert(neo_wqt.item(public.work_queue(), 'build', 't_wqt_b5') ->> 'declined_count' = '0',
                         'the new offer takes them off the declined list');
end $$;

select neo_wqt.login('tech2');
do $$
declare r jsonb;
begin
  r := public.work_claim('build', 't_wqt_b5');     -- claiming an item offered to me = accepting
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'item' ->> 'assigned_via' = 'manager'
                         and (r -> 'item' ->> 'mine')::boolean and r -> 'item' -> 'offer' = 'null'::jsonb,
                         format('claiming an item offered to me accepts it (%s)', r));
end $$;

reset role;
do $$
declare t public.tickets;
begin
  perform neo_wqt.no_jwt();
  select * into t from public.tickets where id = 't_wqt_b5';
  perform neo_wqt.assert(t.assign_reason = 'Please — nobody else is free' and t.declined_emails = '{}' and t.queued_at is null
                         and t.technician_email = neo_wqt.email('tech2'), 'accept: assign_reason is the offer reason');
  perform neo_wqt.assert(not exists (select 1 from public.work_alerts where item_id = 't_wqt_b5' and resolved_at is null),
                         'accept resolves the item''s alerts');
  perform neo_wqt.assert(exists (select 1 from public.work_events where item_id = 't_wqt_b5' and kind = 'accept'), 'accept event');
end $$;

-- Reassignment offer (compare-and-set on who has it), withdraw, a quote offered.
select neo_wqt.login('head');
do $$
declare r jsonb;
begin
  r := public.work_offer('build', 't_wqt_b5', neo_wqt.email('tech3'), 'Swap', null);
  perform neo_wqt.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'changed' and r ->> 'by_email' = neo_wqt.email('tech2'),
                         'C8: a screen that showed it unassigned gets changed, naming who has it');
  r := public.work_offer('build', 't_wqt_b5', neo_wqt.email('tech2'), 'Keep it', neo_wqt.email('tech2'));
  perform neo_wqt.assert((r ->> 'ok')::boolean and (r ->> 'unchanged')::boolean, 'offering to the current holder: unchanged');
  r := public.work_offer('build', 't_wqt_b5', neo_wqt.email('tech3'), 'Tech2 is off tomorrow', upper(neo_wqt.email('tech2')));
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'item' ->> 'assignee_email' = neo_wqt.email('tech2')
                         and r -> 'item' -> 'offer' ->> 'to_email' = neo_wqt.email('tech3'),
                         'a reassignment offer: the holder keeps it until the target accepts');
  r := public.work_offer('build', 't_wqt_b8', neo_wqt.email('tech1'), 'Quick one');
  r := public.work_offer('build', 't_wqt_b8', '', 'Changed my mind');
  perform neo_wqt.assert((r ->> 'ok')::boolean and (r ->> 'withdrawn')::boolean and r -> 'item' -> 'offer' = 'null'::jsonb,
                         'withdraw a live offer');
  r := public.work_offer('build', 't_wqt_b8', null, null);
  perform neo_wqt.assert((r ->> 'ok')::boolean and not (r ->> 'withdrawn')::boolean, 'withdraw with nothing live: withdrawn false');
  r := public.work_offer('build', 't_wqt_b6', neo_wqt.email('tech1'), 'Straight to you');
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'item' ->> 'queued_at' is not null,
                         'offering a build that was not sent to the floor queues it with the offer');
end $$;

select neo_wqt.login('tech3');
do $$
declare r jsonb;
begin
  r := public.work_queue();
  perform neo_wqt.assert((neo_wqt.item(r, 'build', 't_wqt_b5') ->> 'offered_to_me')::boolean
                         and not (neo_wqt.item(r, 'build', 't_wqt_b5') ->> 'can_claim')::boolean,
                         'a reassignment offer is in my feed (to accept, not to claim)');
  r := public.work_respond('build', 't_wqt_b5', true);
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'item' ->> 'assignee_email' = neo_wqt.email('tech3'),
                         'accepting a reassignment offer takes the build over');
end $$;

reset role;
do $$
begin
  perform neo_wqt.no_jwt();
  perform neo_wqt.assert(exists (select 1 from public.work_events where item_id = 't_wqt_b5' and kind = 'reassigned'
                                   and target_email = neo_wqt.email('tech3') and meta ->> 'from_email' = neo_wqt.email('tech2')),
                         'reassigned event names both');
  perform neo_wqt.assert((select technician from public.tickets where id = 't_wqt_b5') = public._first_name(neo_wqt.name('tech3')),
                         'the board shows the new short name');
  perform neo_wqt.assert(exists (select 1 from public.work_events where item_id = 't_wqt_b8' and kind = 'offer_withdrawn'
                                   and body like 'Offer to % withdrawn by %: Changed my mind'
                                   and meta ->> 'offer_kind' = 'manager' and not (meta ->> 'skipped')::boolean), 'withdraw event');
  perform neo_wqt.assert((select declined_emails from public.tickets where id = 't_wqt_b8') = '{}'::text[]
                         and (select auto_tried_at from public.tickets where id = 't_wqt_b8') = now(),
                         'withdrawing a lead''s offer skips nobody, and the app waits 10 minutes before offering it');
  perform neo_wqt.assert(exists (select 1 from public.work_events where item_id = 't_wqt_b6' and kind = 'queued'), 'queued with the offer');
end $$;


-- ── 8. A4: the accept re-checks eligibility (tier changed, pool removed) ────
select neo_wqt.login('head');
do $$
begin
  perform public.work_offer('build', 't_wqt_b7', neo_wqt.email('tech1'), 'Tier 3, fine for you');
  perform public.work_offer('build', 't_wqt_b8', neo_wqt.email('tech3'), 'Yours');
end $$;

-- The desktop re-saves the build as tier 5 (specs is client-writable).
select neo_wqt.login('desk');
do $$
begin
  update public.tickets set specs = jsonb_set(specs, '{__build,tier}', '5'::jsonb), updated_at = now() where id = 't_wqt_b7';
end $$;

select neo_wqt.login('tech1');
do $$
declare r jsonb;
begin
  r := public.work_respond('build', 't_wqt_b7', true);
  perform neo_wqt.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'not_eligible'
                         and r ->> 'why' = 'This is a high-value build — only senior builders can take it.',
                         format('A4: a junior cannot accept a build that became tier 5 (%s)', r));
end $$;

select neo_wqt.login('owner');
do $$
declare r jsonb;
begin
  r := public.staff_update(neo_wqt.email('tech3'), '{"build_pool": false}'::jsonb);
  perform neo_wqt.assert(not (r ->> 'build_pool')::boolean, 'the owner takes tech3 out of the build pool');
end $$;

select neo_wqt.login('tech3');
do $$
declare r jsonb;
begin
  r := public.work_respond('build', 't_wqt_b8', true);
  perform neo_wqt.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'not_eligible' and r ->> 'why' = 'You aren''t in the build pool.',
                         'A4: someone taken out of the pool cannot accept');
end $$;

reset role;
do $$
declare t public.tickets;
begin
  perform neo_wqt.no_jwt();
  select * into t from public.tickets where id = 't_wqt_b7';
  perform neo_wqt.assert(t.offered_to_email is null and t.technician_email is null and t.declined_emails = array[neo_wqt.email('tech1')],
                         'A4: the cleanup committed (offer ended, person skipped, still unassigned)');
  perform neo_wqt.assert(exists (select 1 from public.work_alerts where item_id = 't_wqt_b7' and kind = 'declined' and resolved_at is null
                                   and body like 'Offer to % ended — This is a high-value build%'),
                         'A4: leads are told why the offer ended');
  perform neo_wqt.assert(exists (select 1 from public.work_events where item_id = 't_wqt_b7' and kind = 'offer_withdrawn'), 'A4 event');
  update public.staff_work set build_pool = true where profile_id = (select id from neo_wqt.users where alias = 'tech3');
end $$;


-- ── 9. Old clients and the tickets guard ────────────────────────────────────
-- A v1.9.11 / 1.10.0 desktop saves a whole build row (PostgREST upsert) with
-- its own stale technician, a fast clock and every assignment column it has.
select neo_wqt.login('desk');
do $$
declare t public.tickets;
begin
  insert into public.tickets as tk (id, created_at, updated_at, type, customer_name, deadline, technician,
                                    missing_components_toggle, missing_components, build_checks, qc_checks, diagnostics,
                                    serials, specs, status, completed_at)
  values ('t_wqt_b5', now() - interval '2 days', now() + interval '3 hours', 'build', 'Zq Build Offer', null, 'Somebody Else',
          false, '', '{}', '{}', '{}', '{}', '{"cpu":"Ryzen 5 7600","__queued":true,"__build":{"tier":3}}', 'waiting_qc', null)
  on conflict (id) do update
     set created_at = excluded.created_at, updated_at = excluded.updated_at, type = excluded.type,
         customer_name = excluded.customer_name, deadline = excluded.deadline, technician = excluded.technician,
         missing_components_toggle = excluded.missing_components_toggle, missing_components = excluded.missing_components,
         build_checks = excluded.build_checks, qc_checks = excluded.qc_checks, diagnostics = excluded.diagnostics,
         serials = excluded.serials, specs = excluded.specs, status = excluded.status, completed_at = excluded.completed_at;
  select * into t from public.tickets where id = 't_wqt_b5';
  perform neo_wqt.assert(t.status = 'waiting_qc' and t.specs ->> 'cpu' = 'Ryzen 5 7600', 'the old upsert''s own fields land');
  perform neo_wqt.assert(t.technician = neo_wqt.first('tech3') and t.technician_email = neo_wqt.email('tech3')
                         and t.queued_at is null and t.assigned_via = 'manager',
                         'the old upsert cannot change who has the build (kept silently)');
  perform neo_wqt.assert(t.updated_at <= now() + interval '2 minutes', 'A10: a fast PC clock is clamped to now() + 2 minutes');

  -- a direct write of the server-owned columns: no error, nothing changes
  update public.tickets set technician_email = neo_wqt.email('desk'), offered_to_email = neo_wqt.email('desk'),
         offer_expires_at = now() + interval '1 day', declined_emails = array['x'], queued_at = now()
   where id = 't_wqt_b5';
  select * into t from public.tickets where id = 't_wqt_b5';
  perform neo_wqt.assert(t.technician_email = neo_wqt.email('tech3') and t.offered_to_email is null and t.declined_emails = '{}',
                         'a direct edit of the assignment / offer columns is ignored');

  -- a slow clock: updated_at never goes backwards
  update public.tickets set updated_at = now() - interval '5 days', status = 'qc_testing' where id = 't_wqt_b5';
  perform neo_wqt.assert((select updated_at from public.tickets where id = 't_wqt_b5') > t.updated_at,
                         'C2: updated_at only moves forward');

  -- v1.9.11 creates a build with a technician it picked: a legacy assignment
  insert into public.tickets (id, created_at, updated_at, type, customer_name, technician, specs, status)
  values ('t_wqt_old1', now(), now() + interval '1 day', 'build', 'Zq Old Desktop Build', neo_wqt.first('tech1'),
          '{"__queued":false}', 'awaiting');
  select * into t from public.tickets where id = 't_wqt_old1';
  perform neo_wqt.assert(t.assigned_via = 'legacy' and t.technician_email = neo_wqt.email('tech1') and t.queued_at is null
                         and t.updated_at <= now() + interval '2 minutes',
                         'an old insert with a name: legacy, mapped to the email; updated_at clamped');
  -- … the v1.9.11 waiting queue
  insert into public.tickets (id, type, customer_name, technician, specs, status)
  values ('t_wqt_old2', 'build', 'Zq Old Waiting Build', null, '{"__queued":true}', 'awaiting');
  perform neo_wqt.assert((select queued_at from public.tickets where id = 't_wqt_old2') = now(),
                         'an old insert with specs.__queued: in the queue');
  -- … and the website's qbCreateTicket (explicit columns, technician null): a quote
  insert into public.tickets (id, created_at, updated_at, type, customer_name, deadline, technician, status,
                              missing_components_toggle, missing_components, build_checks, qc_checks, diagnostics, serials, specs)
  values ('t_wqt_web1', now(), now(), 'build', 'Zq Website Quote', now() + interval '5 days', null, 'awaiting', true, '',
          '{"cpuRamSsd":false}', '{}', '{}', '{"motherboard":""}',
          '{"cpu":"i5","__build":{"salesExec":"kiran.raj@neotokyo.in","importance":"light","tier":1},"__procurement":{"received":false}}');
  select * into t from public.tickets where id = 't_wqt_web1';
  perform neo_wqt.assert(t.queued_at is null and t.technician_email is null and t.assigned_via is null,
                         'the website''s quote is not queued');
  -- a direct insert cannot smuggle in an assignment or an offer
  insert into public.tickets (id, type, customer_name, technician_email, assigned_via, queued_at, offered_to_email, offer_expires_at, status)
  values ('t_wqt_old3', 'build', 'Zq Smuggled', neo_wqt.email('desk'), 'claim', now(), neo_wqt.email('desk'), now() + interval '1 day', 'awaiting');
  select * into t from public.tickets where id = 't_wqt_old3';
  perform neo_wqt.assert(t.technician_email is null and t.assigned_via is null and t.queued_at is null and t.offered_to_email is null,
                         'a direct insert carries no assignment, queue or offer');
end $$;

reset role;
do $$
begin
  perform neo_wqt.no_jwt();
  perform neo_wqt.assert(exists (select 1 from public.work_events where item_id = 't_wqt_old1' and kind = 'legacy'),
                         'the legacy assignment is in the history');
  perform neo_wqt.assert(not exists (select 1 from public.work_events where item_id = 't_wqt_b5' and kind = 'legacy'),
                         'an upsert of an existing build writes no legacy event');
end $$;

-- Completion by an old client: off the queue, the offer ends, alerts settle.
select neo_wqt.login('head');
do $$
begin
  perform public.work_offer('build', 't_wqt_b6', '', null);
  perform public.work_offer('build', 't_wqt_b6', neo_wqt.email('tech2'), 'Before it ships');
  perform public.work_offer('build', 't_wqt_b3', neo_wqt.email('tech2'), 'Quick');
end $$;
select neo_wqt.login('tech2');
do $$
begin
  perform public.work_respond('build', 't_wqt_b3', false, 'No time');
end $$;
select neo_wqt.login('desk');
do $$
declare t public.tickets;
begin
  update public.tickets set status = 'completed', completed_at = now() where id = 't_wqt_b6';
  select * into t from public.tickets where id = 't_wqt_b6';
  perform neo_wqt.assert(t.offered_to_email is null and t.offer_expires_at is null and t.queued_at is null and t.declined_emails = '{}',
                         'completing a build clears its queue and offer columns');
  delete from public.tickets where id = 't_wqt_b3';
end $$;

reset role;
do $$
begin
  perform neo_wqt.no_jwt();
  perform neo_wqt.assert(exists (select 1 from public.work_alerts where item_id = 't_wqt_b3' and kind = 'declined'
                                   and resolved_at is not null and resolved_by = 'Neo OS'),
                         'C14: deleting a build resolves its alerts (Neo OS)');
end $$;


-- ── 10. work_tick: expiry, auto-offers, room, nobody free, throttle, dedupe ─
reset role;
select neo_wqt.no_jwt(), neo_wqt.room('tech1', 10), neo_wqt.room('tech2', 8), neo_wqt.room('tech3', 6);
-- Any staff member may run the clock (every desktop calls it each minute).
select neo_wqt.login('sales');
do $$
begin
  perform neo_wqt.put('tick1', public.work_tick()::text);
end $$;
reset role;
do $$
declare r jsonb; t public.tickets;
begin
  perform neo_wqt.no_jwt();
  -- t_wqt_b4 has waited 5 hours: the app offers it to whoever has the most room.
  r := neo_wqt.get('tick1')::jsonb;
  select * into t from public.tickets where id = 't_wqt_b4';
  perform neo_wqt.assert((r ->> 'offered')::int >= 1 and t.offered_to_email = neo_wqt.email('tech1') and t.offer_kind = 'auto'
                         and t.offer_by_name = 'Neo OS' and t.offer_by_email is null and t.auto_tried_at = now()
                         and t.offer_reason = 'Not claimed in 4 hours — you have the most room.',
                         format('step 2: an overdue build is offered to the person with most room (%s, %s)', r, t.offered_to_email));
  perform neo_wqt.assert(exists (select 1 from public.work_events where item_id = 't_wqt_b4' and kind = 'auto_offer'
                                   and target_email = neo_wqt.email('tech1')), 'auto_offer event');
  perform neo_wqt.assert((select count(*) from public.work_events where item_id = 't_wqt_d1' and kind = 'auto_offer') = 1,
                         'the other overdue build is offered too');

  -- 30 minutes pass without an answer (back-dated); tech2 has no free job slot.
  perform neo_wqt.raw($q$update public.tickets set offer_expires_at = now() - interval '1 minute' where id = 't_wqt_b4'$q$);
  perform neo_wqt.room('tech2', 20, 0);
  r := public.work_tick();
  select * into t from public.tickets where id = 't_wqt_b4';
  perform neo_wqt.assert((r ->> 'expired')::int = 1 and t.declined_emails = array[neo_wqt.email('tech1')]
                         and t.offered_to_email = neo_wqt.email('tech3') and t.offer_kind = 'auto',
                         format('step 1: the silent offer ends and the next free person (not the one without a slot) gets it (%s, %s)',
                                r, t.offered_to_email));
  perform neo_wqt.assert(exists (select 1 from public.work_alerts where item_id = 't_wqt_b4' and kind = 'expired' and resolved_at is null
                                   and person_email = neo_wqt.email('tech1')
                                   and body = 'No answer from ' || neo_wqt.name('tech1') || ' on WQT_B4 in 30 minutes.'),
                         'an expired offer alerts the leads');
  perform neo_wqt.assert(exists (select 1 from public.work_events where item_id = 't_wqt_b4' and kind = 'offer_expired'
                                   and body like '%No answer in 30 minutes.'), 'offer_expired event');
end $$;

select neo_wqt.login('tech3');
do $$
declare r jsonb;
begin
  r := public.work_respond('build', 't_wqt_b4', false, 'Out on a site visit');
  perform neo_wqt.assert((r ->> 'ok')::boolean and (r -> 'next' ->> 'offered')::boolean is false
                         and (r -> 'next' ->> 'stuck')::boolean and (r -> 'next' ->> 'alerted')::boolean,
                         format('a decline after the 4 hours goes straight to the next person — nobody is left (%s)', r));
end $$;

reset role;
do $$
declare r jsonb; v_n int;
begin
  perform neo_wqt.no_jwt();
  perform neo_wqt.assert((select count(*) from public.work_alerts where item_id = 't_wqt_b4' and kind = 'no_candidate' and resolved_at is null) = 1
                         and exists (select 1 from public.work_alerts where item_id = 't_wqt_b4' and kind = 'no_candidate'
                                       and body = 'Nobody free can take WQT_B4 — offer it to someone or wait for room.'),
                         'nobody free: one no_candidate alert');
  perform neo_wqt.assert((select count(*) from public.work_events where item_id = 't_wqt_b4' and kind = 'no_candidate') = 1, 'one no_candidate event');
  -- A3: retried at most every 10 minutes …
  r := public.work_tick();
  perform neo_wqt.assert((select count(*) from public.work_events where item_id = 't_wqt_b4' and kind = 'no_candidate') = 1
                         and (r ->> 'stuck')::int = 0 and (r ->> 'offered')::int = 0 and (r ->> 'expired')::int = 0,
                         format('A3: within 10 minutes the stuck item is not retried (%s)', r));
  -- … and an open alert is not repeated.
  perform neo_wqt.raw($q$update public.tickets set auto_tried_at = now() - interval '11 minutes' where id = 't_wqt_b4'$q$);
  r := public.work_tick();
  perform neo_wqt.assert((r ->> 'stuck')::int >= 1
                         and (select count(*) from public.work_events where item_id = 't_wqt_b4' and kind = 'no_candidate') = 1
                         and (select count(*) from public.work_alerts where item_id = 't_wqt_b4' and kind = 'no_candidate') = 1
                         and (select auto_tried_at from public.tickets where id = 't_wqt_b4') = now(),
                         format('A3: a retry while the alert is open writes nothing new, counts it stuck (%s)', r));
end $$;

select neo_wqt.login('head');
do $$
declare v_id bigint;
begin
  select id into v_id from public.work_alerts where item_id = 't_wqt_b4' and kind = 'no_candidate' and resolved_at is null;
  perform neo_wqt.assert((public.work_alert_resolve(v_id) ->> 'ok')::boolean, 'a lead dismisses the alert');
  perform neo_wqt.assert((public.work_alert_resolve(v_id) ->> 'already')::boolean, 'dismissing twice: already');
  perform neo_wqt.expect_error('select public.work_alert_resolve(-1)', '%NEO_GATE: That alert no longer exists.%');
end $$;

reset role;
do $$
declare r jsonb;
begin
  perform neo_wqt.no_jwt();
  perform neo_wqt.raw($q$update public.tickets set auto_tried_at = now() - interval '11 minutes' where id = 't_wqt_b4'$q$);
  r := public.work_tick();
  perform neo_wqt.assert((select count(*) from public.work_alerts where item_id = 't_wqt_b4' and kind = 'no_candidate') = 1,
                         'A3: a dismissed alert does not come back within 30 minutes');
  perform neo_wqt.raw($q$update public.work_alerts set resolved_at = now() - interval '31 minutes'
                          where item_id = 't_wqt_b4' and kind = 'no_candidate'$q$);
  perform neo_wqt.raw($q$update public.tickets set auto_tried_at = now() - interval '11 minutes' where id = 't_wqt_b4'$q$);
  r := public.work_tick();
  perform neo_wqt.assert((select count(*) from public.work_alerts where item_id = 't_wqt_b4' and kind = 'no_candidate') = 2
                         and (select count(*) from public.work_events where item_id = 't_wqt_b4' and kind = 'no_candidate') = 2,
                         'after 30 minutes a still-stuck item alerts again');
  -- room is points + cost <= capacity
  perform neo_wqt.room('tech1', 0);
  perform neo_wqt.raw($q$update public.tickets set declined_emails = '{}' where id = 't_wqt_b4'$q$);
  perform neo_wqt.room('tech2', 0, 5);
  perform neo_wqt.room('tech3', 0, 5);
  perform neo_wqt.assert((public._work_pick('build', 't_wqt_b4')).id is null, 'nobody with room is picked');
  perform neo_wqt.room('tech3', 1, 5);
  perform neo_wqt.assert((public._work_pick('build', 't_wqt_b4')).email = neo_wqt.email('tech3'), 'exactly enough room is enough');
  -- deleting an item resolves its alerts
  perform neo_wqt.assert(exists (select 1 from public.work_alerts where item_id = 't_wqt_b4' and resolved_at is null), 'b4 has open alerts');
  delete from public.tickets where id = 't_wqt_b4';
  perform neo_wqt.assert(not exists (select 1 from public.work_alerts where item_id = 't_wqt_b4' and resolved_at is null),
                         'C14: a deleted build leaves no open alert');
  perform neo_wqt.room('tech1', 10); perform neo_wqt.room('tech2', 8); perform neo_wqt.room('tech3', 6);
end $$;

-- A lead withdraws the app's offer on an overdue build: the next tick does not
-- offer it straight back to the same person (that person is skipped for the
-- item, and the app waits 10 minutes), and "withdraw, then offer to someone
-- else" is not beaten by a tick in between.
select neo_wqt.mkbuild('t_wqt_w1', 'Zq Build Withdrawn', 1, interval '5 hours');
do $$
declare r jsonb; t public.tickets;
begin
  perform neo_wqt.no_jwt();
  r := public.work_tick();
  select * into t from public.tickets where id = 't_wqt_w1';
  perform neo_wqt.assert(t.offer_kind = 'auto' and t.offered_to_email is not null and t.auto_tried_at = now(),
                         format('w1: the app offers the overdue build (%s, %s)', r, t.offered_to_email));
  perform neo_wqt.put('w1_first', t.offered_to_email);
end $$;

select neo_wqt.login('head');
do $$
declare r jsonb;
begin
  r := public.work_offer('build', 't_wqt_w1', '', '', null);
  perform neo_wqt.assert((r ->> 'ok')::boolean and (r ->> 'withdrawn')::boolean and r -> 'item' -> 'offer' = 'null'::jsonb,
                         format('w1: the lead withdraws the app''s offer (%s)', r));
end $$;

reset role;
do $$
declare r jsonb; t public.tickets; v_first text := neo_wqt.get('w1_first');
begin
  perform neo_wqt.no_jwt();
  select * into t from public.tickets where id = 't_wqt_w1';
  perform neo_wqt.assert(t.offered_to_email is null and t.declined_emails = array[v_first] and t.auto_tried_at = now(),
                         format('w1: the withdrawn person is skipped for the item and the throttle is stamped (%s, %s)',
                                t.declined_emails, t.auto_tried_at));
  perform neo_wqt.assert(exists (select 1 from public.work_events where item_id = 't_wqt_w1' and kind = 'offer_withdrawn'
                                   and target_email = v_first and meta ->> 'offer_kind' = 'auto' and (meta ->> 'skipped')::boolean),
                         'w1: offer_withdrawn event says the person is skipped');
  perform neo_wqt.assert(not exists (select 1 from public.work_alerts where item_id = 't_wqt_w1' and resolved_at is null),
                         'w1: a lead''s own withdrawal alerts nobody');
  r := public.work_tick();
  select * into t from public.tickets where id = 't_wqt_w1';
  perform neo_wqt.assert(t.offered_to_email is null
                         and (select count(*) from public.work_events where item_id = 't_wqt_w1' and kind = 'auto_offer') = 1,
                         format('w1: the next tick does not re-offer it at once (%s, %s)', r, t.offered_to_email));
  -- ten minutes later the app offers it again — to someone else
  perform neo_wqt.raw($q$update public.tickets set auto_tried_at = now() - interval '11 minutes' where id = 't_wqt_w1'$q$);
  r := public.work_tick();
  select * into t from public.tickets where id = 't_wqt_w1';
  perform neo_wqt.assert(t.offer_kind = 'auto' and t.offered_to_email is not null and t.offered_to_email <> v_first,
                         format('w1: after 10 minutes the app offers it to the next person, not the withdrawn one (%s, %s)',
                                r, t.offered_to_email));
  perform neo_wqt.put('w1_second', t.offered_to_email);
end $$;

-- Withdraw, a tick in between, then offer to someone else: the offer lands.
select neo_wqt.login('head');
do $$
declare r jsonb;
begin
  r := public.work_offer('build', 't_wqt_w1', null, 'Wrong person', null);
  perform neo_wqt.assert((r ->> 'withdrawn')::boolean, 'w1: second withdrawal');
end $$;
reset role;
do $$
declare r jsonb;
begin
  perform neo_wqt.no_jwt();
  r := public.work_tick();
  perform neo_wqt.assert((select offered_to_email from public.tickets where id = 't_wqt_w1') is null,
                         format('w1: a tick between withdraw and offer does not take the item (%s)', r));
end $$;
select neo_wqt.login('head');
do $$
declare r jsonb; t public.tickets;
begin
  r := public.work_offer('build', 't_wqt_w1', neo_wqt.get('w1_first'), 'Back from the site now', null);
  select * into t from public.tickets where id = 't_wqt_w1';
  perform neo_wqt.assert((r ->> 'ok')::boolean and t.offer_kind = 'manager' and t.offered_to_email = neo_wqt.get('w1_first')
                         and t.declined_emails = array[neo_wqt.get('w1_second')],
                         format('w1: a lead may still offer it by name to the skipped person (%s, %s)', r, t.declined_emails));
end $$;
reset role;
select neo_wqt.no_jwt();
delete from public.tickets where id = 't_wqt_w1';   -- its live offer must not count in later sections' loads


-- ── 11. Service: pool gate, offers, service_claim, accept with a visit ──────
select neo_wqt.login('desk');
do $$
declare r jsonb;
begin
  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'service_type', 'on_site', 'channel', 'phone', 'category', 'networking',
         'customer_name', 'Zqcustomer Onsite Person', 'customer_phone', '9000000301', 'reported_fault', 'Router keeps dropping',
         'site_address', '12 Test Street', 'site_area', 'Kakkanad'));
  perform neo_wqt.put('s1', r ->> 'id'); perform neo_wqt.put('s1_code', r ->> 'public_code');
  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'customer_name', 'Zqcustomer Bench', 'customer_phone', '9000000302',
         'reported_fault', 'No display', 'in_hand', true, 'items', jsonb_build_array(jsonb_build_object('kind', 'laptop', 'label', 'Zq Laptop'))));
  perform neo_wqt.put('s2', r ->> 'id');
  r := public.service_create(jsonb_build_object(
         'client_request_id', gen_random_uuid(), 'customer_name', 'Zqcustomer Third', 'customer_phone', '9000000303',
         'reported_fault', 'Slow', 'in_hand', true));
  perform neo_wqt.put('s3', r ->> 'id');
  r := public.work_queue();
  perform neo_wqt.assert(neo_wqt.item(r, 'service', neo_wqt.get('s1')) ->> 'customer' = 'Zqcustomer Onsite Person',
                         'the desk sees the whole name');
end $$;

select neo_wqt.login('tech1');
do $$
declare r jsonb; e jsonb;
begin
  r := public.work_queue();
  e := neo_wqt.item(r, 'service', neo_wqt.get('s1'));
  perform neo_wqt.assert(e ->> 'customer' = 'Zqcustomer' and e ->> 'area' = 'Kakkanad' and e ->> 'service_type' = 'on_site'
                         and (e ->> 'cost')::int = 2 and e ->> 'code' = neo_wqt.get('s1_code')
                         and e ->> 'sub' = 'On-site · Networking' and e ->> 'title' = 'Networking'
                         and e::text not like '%9000000301%' and e::text not like '%Test Street%'
                         and (e ->> 'can_claim')::boolean,
                         format('a technician sees a first name and the area, never the phone or address (%s)', e));
end $$;

reset role;
select neo_wqt.no_jwt();
update public.staff_work set service_pool = false where profile_id = (select id from neo_wqt.users where alias = 'tech3');

select neo_wqt.login('tech3');
do $$
declare r jsonb;
begin
  perform neo_wqt.expect_error(format('select public.service_claim(%L)', neo_wqt.get('s3')), '%NEO_GATE: You aren''t in the service pool.%');
  perform neo_wqt.expect_error(format('select public.work_claim(%L, %L)', 'service', neo_wqt.get('s3')),
                               '%NEO_GATE: You aren''t in the service pool.%');
  -- C3: "take it myself" at intake is dropped for someone outside the pool
  r := public.service_create(jsonb_build_object('client_request_id', gen_random_uuid(), 'customer_name', 'Zqcustomer Self',
                                                'customer_phone', '9000000304', 'reported_fault', 'x', 'in_hand', true, 'assign_self', true));
  perform neo_wqt.assert(r -> 'job' ->> 'assignee_email' is null and r -> 'job' ->> 'queued_at' is not null,
                         'C3: assign_self outside the service pool: the ticket queues');
end $$;

select neo_wqt.login('tech1');
do $$
declare r jsonb;
begin
  r := public.service_create(jsonb_build_object('client_request_id', gen_random_uuid(), 'customer_name', 'Zqcustomer Self Two',
                                                'customer_phone', '9000000305', 'reported_fault', 'x', 'in_hand', true, 'assign_self', true));
  perform neo_wqt.assert(lower(r -> 'job' ->> 'assignee_email') = neo_wqt.email('tech1') and r -> 'job' ->> 'assigned_via' = 'self',
                         'assign_self still works for a pool member');
end $$;

select neo_wqt.login('head');
do $$
declare r jsonb;
begin
  perform neo_wqt.expect_error(format('select public.work_offer(%L, %L, %L, %L)', 'service', neo_wqt.get('s1'), neo_wqt.email('desk'), 'x'),
                               '%can''t take this — they don''t have the Service technician role.%');
  perform neo_wqt.expect_error(format('select public.work_offer(%L, %L, %L, %L)', 'service', 's_wqt_gone', neo_wqt.email('tech2'), 'x'),
                               '%NEO_GATE: That ticket no longer exists.%');
  r := public.work_offer('service', neo_wqt.get('s1'), neo_wqt.email('tech2'), 'Closest to Kakkanad');
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'item' -> 'offer' ->> 'to_email' = neo_wqt.email('tech2'), 'a lead offers a service job');
  -- withdraw it (the app waits 10 minutes before offering a service job again), then offer it again
  r := public.work_offer('service', neo_wqt.get('s1'), null, 'Wrong person');
  perform neo_wqt.assert((r ->> 'withdrawn')::boolean and r -> 'item' -> 'offer' = 'null'::jsonb
                         and (select auto_tried_at from public.service_jobs where id = neo_wqt.get('s1')) = now()
                         and (select declined_emails from public.service_jobs where id = neo_wqt.get('s1')) = '{}'::text[]
                         and exists (select 1 from public.service_events where job_id = neo_wqt.get('s1') and kind = 'offer'
                                       and meta ->> 'event' = 'offer_withdrawn'),
                         format('withdrawing a lead''s service offer: throttled, nobody skipped (%s)', r));
  r := public.work_offer('service', neo_wqt.get('s1'), neo_wqt.email('tech2'), 'Closest to Kakkanad');
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'item' -> 'offer' ->> 'to_email' = neo_wqt.email('tech2'), 'and offered again');
end $$;

select neo_wqt.login('tech1');
do $$
declare r jsonb; j public.service_jobs;
begin
  -- an old client's service_claim on an item offered to someone else
  r := public.service_claim(neo_wqt.get('s1'), null, null, null);
  perform neo_wqt.assert(not (r ->> 'ok')::boolean and r ->> 'reason' = 'offered' and r ->> 'by' = neo_wqt.name('tech2')
                         and r ->> 'by_email' = neo_wqt.email('tech2') and r ->> 'to_name' = neo_wqt.name('tech2')
                         and (r ->> 'expires_at')::timestamptz = now() + interval '30 minutes',
                         format('A1: service_claim refuses an item offered to someone else (%s)', r));
  r := public.work_claim('service', neo_wqt.get('s1'));
  perform neo_wqt.assert(r ->> 'reason' = 'offered' and r ? 'item', 'work_claim(service) passes the answer through with the item');
  select * into j from public.service_jobs where id = neo_wqt.get('s1');
  perform neo_wqt.assert(j.assignee_email is null and j.offered_to_email = neo_wqt.email('tech2'), 'A1: and writes nothing');
  -- a direct (non-RPC) edit of the offer columns is put back silently
  update public.service_jobs set offered_to_email = neo_wqt.email('tech1'), declined_emails = array['x'],
         offer_expires_at = now() + interval '1 day' where id = neo_wqt.get('s1');
  select * into j from public.service_jobs where id = neo_wqt.get('s1');
  perform neo_wqt.assert(j.offered_to_email = neo_wqt.email('tech2') and j.declined_emails = '{}'
                         and j.offer_expires_at = now() + interval '30 minutes', 'the offer columns change only through the RPCs');
  perform neo_wqt.expect_error(format('select public.work_respond(%L, %L, true, null, %L::timestamptz, %L::timestamptz)', 'service',
                                      neo_wqt.get('s1'), now() + interval '2 hours', now() + interval '1 hour'),
                               '%NEO_GATE: The visit ends before it starts.%');
end $$;

select neo_wqt.login('tech2');
do $$
declare r jsonb;
begin
  perform neo_wqt.expect_error(format('select public.work_respond(%L, %L, true, null, %L::timestamptz, %L::timestamptz)', 'service',
                                      neo_wqt.get('s1'), now() + interval '2 hours', now() + interval '1 hour'),
                               '%NEO_GATE: The visit ends before it starts.%');
  r := public.work_respond('service', neo_wqt.get('s1'), true, null, now() + interval '1 day', now() + interval '1 day 2 hours');
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'job' ->> 'stage' = 'scheduled' and r -> 'job' ->> 'assigned_via' = 'manager'
                         and lower(r -> 'job' ->> 'assignee_email') = neo_wqt.email('tech2') and (r -> 'item' ->> 'mine')::boolean
                         and r -> 'item' ->> 'customer' = 'Zqcustomer Onsite Person',
                         format('accepting with a visit time books the visit (%s)', r));
end $$;

reset role;
do $$
declare v_job text;
begin
  perform neo_wqt.no_jwt();
  v_job := neo_wqt.get('s1');
  perform neo_wqt.assert(exists (select 1 from public.service_events where job_id = v_job and kind = 'offer' and not customer_visible
                                   and meta ->> 'event' = 'offer' and meta ->> 'offer_kind' = 'manager'
                                   and meta ->> 'to_email' = neo_wqt.email('tech2') and meta ->> 'by_email' = neo_wqt.email('head')
                                   and meta ->> 'reason' = 'Closest to Kakkanad'),
                         '§2.5: the offer is on the ticket''s internal timeline');
  perform neo_wqt.assert(exists (select 1 from public.service_events where job_id = v_job and kind = 'assign'
                                   and meta ->> 'via' = 'manager' and lower(meta ->> 'tech_email') = neo_wqt.email('tech2')
                                   and meta ->> 'by_email' = neo_wqt.email('head') and meta ->> 'reason' = 'Closest to Kakkanad'),
                         '§2.5: accepting writes an assign row (tech_activity counts it)');
  perform neo_wqt.assert(not exists (select 1 from public.service_events where job_id = v_job and kind = 'claim'),
                         'A15: accepting never writes a claim row');
  perform neo_wqt.assert(exists (select 1 from public.service_events where job_id = v_job and kind = 'stage' and customer_visible
                                   and to_stage = 'scheduled' and body like 'Visit booked for %'), 'the customer is told the visit time');
  perform neo_wqt.assert(exists (select 1 from public.work_events where item_kind = 'service' and item_id = v_job and kind = 'accept'),
                         'work_events has the service accept too');
  update public.staff_work set service_pool = true where profile_id = (select id from neo_wqt.users where alias = 'tech3');
  -- s2 has waited 5 hours: the app offers it
  perform neo_wqt.raw(format($q$update public.service_jobs set queued_at = now() - interval '5 hours' where id = %L$q$, neo_wqt.get('s2')));
  perform neo_wqt.room('tech1', 20); perform neo_wqt.room('tech2', 1); perform neo_wqt.room('tech3', 1);
  perform public.work_tick();
  perform neo_wqt.assert((select offered_to_email from public.service_jobs where id = neo_wqt.get('s2')) = neo_wqt.email('tech1')
                         and (select offer_kind from public.service_jobs where id = neo_wqt.get('s2')) = 'auto',
                         'step 2 offers an overdue service job');
  perform neo_wqt.assert(exists (select 1 from public.service_events where job_id = neo_wqt.get('s2') and kind = 'offer'
                                   and actor_kind = 'system' and meta ->> 'event' = 'auto_offer'),
                         'the app''s offer is on the timeline as the system');
end $$;

select neo_wqt.login('tech1');
do $$
declare r jsonb;
begin
  -- an old client accepts through service_claim
  r := public.service_claim(neo_wqt.get('s2'), null, null, null);
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'job' ->> 'assigned_via' = 'auto' and lower(r -> 'job' ->> 'assignee_email') = neo_wqt.email('tech1'),
                         format('A1: service_claim on an item offered to me accepts it (assigned_via auto) (%s)', r));
  r := public.work_claim('service', neo_wqt.get('s3'));
  perform neo_wqt.assert((r ->> 'ok')::boolean and (r -> 'item' ->> 'mine')::boolean and r -> 'job' ->> 'assigned_via' = 'claim',
                         'work_claim(service) claims through service_claim');
  r := public.work_claim('service', neo_wqt.get('s3'));
  perform neo_wqt.assert((r ->> 'ok')::boolean and (r ->> 'already')::boolean, 'claiming again: already');
  perform neo_wqt.expect_error(format('select public.work_release(%L, %L, %L)', 'service', neo_wqt.get('s3'), ''),
                               '%NEO_GATE: Say why you''re handing it back.%');
  r := public.work_release('service', neo_wqt.get('s3'), 'Need a part first');
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'job' ->> 'assignee_email' is null and r -> 'item' ->> 'claim_due' is not null,
                         'work_release(service) hands it back');
end $$;

reset role;
do $$
begin
  perform neo_wqt.no_jwt();
  perform neo_wqt.assert((select declined_emails from public.service_jobs where id = neo_wqt.get('s3')) = array[neo_wqt.email('tech1')],
                         'a service hand-back skips the releaser for this cycle');
  perform neo_wqt.assert((select count(*) from public.service_events where job_id = neo_wqt.get('s3') and kind = 'claim') = 1
                         and exists (select 1 from public.service_events where job_id = neo_wqt.get('s3') and kind = 'release'),
                         'service_claim / service_release events unchanged');
  perform neo_wqt.assert(exists (select 1 from public.work_events where item_kind = 'service' and item_id = neo_wqt.get('s3')
                                   and kind = 'release' and body like '%Need a part first'), 'work_events: release');
  perform neo_wqt.assert(exists (select 1 from public.work_events where item_kind = 'service' and item_id = neo_wqt.get('s3')
                                   and kind = 'claim'), 'work_events: claim (written by service_claim)');
end $$;

-- A lead's service_assign (v2, unchanged) ends a live offer.
select neo_wqt.login('head');
do $$
declare r jsonb;
begin
  perform public.work_offer('service', neo_wqt.get('s3'), neo_wqt.email('tech2'), 'Try this one');
  r := public.service_assign(neo_wqt.get('s3'), neo_wqt.email('tech3'), 'Tech3 has the part', null);
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'job' ->> 'offered_to_email' is null and r -> 'job' ->> 'declined_emails' = '[]',
                         'service_assign: the zy guard clears the offer and the declined list');
end $$;


-- ── 12. Leads: work_team, per-kind events and alerts ────────────────────────
reset role;
select neo_wqt.no_jwt();
-- tech2 becomes a tier-2 SERVICE lead (builds: still a tech)
update public.module_access set role = 'lead' where module = 'service' and profile_id = (select id from neo_wqt.users where alias = 'tech2');
select neo_wqt.mkbuild('t_wqt_b10', 'Zq Build Alert', 1, interval '1 hour');

select neo_wqt.login('head');
do $$
begin
  perform public.work_offer('build', 't_wqt_b10', neo_wqt.email('tech1'), 'For the alert test');
  perform public.work_offer('service', neo_wqt.get('s3'), '', null);
end $$;
select neo_wqt.login('tech1');
do $$
begin
  perform public.work_respond('build', 't_wqt_b10', false, 'Busy');
end $$;
-- offered again and declined again while the first alert is still open: one alert, no error (A2: ON CONFLICT DO NOTHING)
select neo_wqt.login('head');
do $$
begin
  perform public.work_offer('build', 't_wqt_b10', neo_wqt.email('tech1'), 'Please, it is small');
end $$;
select neo_wqt.login('tech1');
do $$
begin
  perform neo_wqt.assert((public.work_respond('build', 't_wqt_b10', false, 'Still busy') ->> 'declined')::boolean, 'a second decline works');
end $$;
reset role;
do $$
begin
  perform neo_wqt.no_jwt();
  perform neo_wqt.assert((select count(*) from public.work_alerts where item_id = 't_wqt_b10' and kind = 'declined' and resolved_at is null) = 1,
                         'A2: one open alert per item, kind and person');
end $$;
select neo_wqt.login('head');
do $$
begin
  perform public.work_offer('service', neo_wqt.get('s2'), neo_wqt.email('tech3'), 'Swap', neo_wqt.email('tech1'));
end $$;
select neo_wqt.login('tech3');
do $$
begin
  perform public.work_respond('service', neo_wqt.get('s2'), false, 'Not today');
end $$;

select neo_wqt.login('tech1');
do $$
begin
  perform neo_wqt.expect_error($q$select public.work_team()$q$, '%NEO_DENIED: Only leads can see the team.%');
  perform neo_wqt.assert((select count(*) from public.work_alerts) = 0, 'a technician reads no alerts');
end $$;

select neo_wqt.login('tech2');      -- tier-2 service lead
do $$
declare r jsonb; p jsonb; v_id bigint;
begin
  r := public.work_team();
  p := neo_wqt.person(r, neo_wqt.email('tech1'));
  perform neo_wqt.assert(p is not null and p ? 'qc_role' and p ? 'service_role' and p ->> 'qc_role' = 'tech'
                         and p ->> 'last_seen_at' is null and p ->> 'logs_today' is null
                         and not exists (select 1 from jsonb_array_elements(p -> 'items') as e(value) where e.value ->> 'kind' = 'build')
                         and exists (select 1 from jsonb_array_elements(p -> 'items') as e(value) where e.value ->> 'id' = neo_wqt.get('s2')),
                         format('A7: a tier-2 service lead sees service items only and no activity times (%s)', p));
  perform neo_wqt.assert(not exists (select 1 from jsonb_array_elements(r -> 'alerts') as e(value) where e.value ->> 'item_kind' = 'build')
                         and exists (select 1 from jsonb_array_elements(r -> 'alerts') as e(value) where e.value ->> 'item_id' = neo_wqt.get('s2')),
                         'C14: and only service alerts');
  perform neo_wqt.assert((select count(*) from public.work_alerts where item_kind = 'build') = 0
                         and (select count(*) from public.work_alerts where item_kind = 'service') >= 1,
                         'C14: RLS gives a service lead service alerts only');
  r := public.work_queue();
  perform neo_wqt.assert(not exists (select 1 from jsonb_array_elements(r -> 'alerts') as e(value) where e.value ->> 'item_kind' = 'build')
                         and (r -> 'me' ->> 'lead_service')::boolean and not (r -> 'me' ->> 'lead_builds')::boolean,
                         'work_queue alerts follow the same rule');
  select id into v_id from public.work_alerts where item_kind = 'service' and item_id = neo_wqt.get('s2') and resolved_at is null limit 1;
  perform neo_wqt.assert((public.work_alert_resolve(v_id) ->> 'ok')::boolean, 'a service lead dismisses a service alert');
end $$;

reset role;
do $$
declare v_id bigint;
begin
  perform neo_wqt.no_jwt();
  select id into v_id from public.work_alerts where item_kind = 'build' and item_id = 't_wqt_b10' and resolved_at is null;
  perform neo_wqt.put('build_alert', v_id::text);
end $$;
select neo_wqt.login('tech2');
do $$
begin
  perform neo_wqt.expect_error(format('select public.work_alert_resolve(%s)', neo_wqt.get('build_alert')),
                               '%NEO_DENIED: Only a lead can dismiss this alert.%');
end $$;

select neo_wqt.login('head');
do $$
declare r jsonb; p jsonb;
begin
  r := public.work_team();
  p := neo_wqt.person(r, neo_wqt.email('tech3'));
  perform neo_wqt.assert(p is not null and p ? 'last_seen_at' and (p ->> 'logs_today') is not null
                         and exists (select 1 from jsonb_array_elements(p -> 'items') as e(value) where e.value ->> 'id' = 't_wqt_b5'),
                         format('tier 3 sees every kind and the activity columns (%s)', p));
  perform neo_wqt.assert(neo_wqt.person(r, 'zq.solo@neotokyo.test') is null and neo_wqt.person(r, neo_wqt.email('tech1')) is not null,
                         'work_team: people in a pool or holding work only');
  perform neo_wqt.assert(exists (select 1 from jsonb_array_elements(r -> 'alerts') as e(value) where e.value ->> 'item_id' = 't_wqt_b10'),
                         'tier 3 sees build alerts');
end $$;

select neo_wqt.login('plain');      -- builds desk only
do $$
declare r jsonb;
begin
  r := public.work_events_for('build', 't_wqt_b5');
  perform neo_wqt.assert(jsonb_array_length(r) >= 3 and r -> 0 ? 'body' and r -> 0 ? 'kind' and r -> 0 ? 'at'
                         and (r -> 0 ->> 'at')::timestamptz >= (r -> 1 ->> 'at')::timestamptz,
                         'work_events_for: newest first');
  perform neo_wqt.expect_error(format('select public.work_events_for(%L, %L)', 'service', neo_wqt.get('s1')),
                               '%NEO_DENIED: You don''t have access to this queue history.%');
  perform neo_wqt.assert((select count(*) from public.work_events where item_kind = 'service') = 0
                         and (select count(*) from public.work_events where item_kind = 'build') > 0,
                         'A7: RLS — a builds desk reads build history only');
  perform neo_wqt.assert((select count(*) from public.work_alerts) = 0, 'a desk reads no alerts');
end $$;

select neo_wqt.login('desk');
do $$
begin
  perform neo_wqt.assert(jsonb_array_length(public.work_events_for('service', neo_wqt.get('s1'))) >= 2, 'the service desk reads service history');
  perform neo_wqt.assert((select count(*) from public.staff_work) > 0 and (select count(*) from public.designation_presets) >= 0,
                         'any staff member reads staff_work and the presets');
  perform neo_wqt.expect_error($q$insert into public.work_events (item_kind, item_id, kind, body) values ('build', 'x', 'claim', 'forged')$q$,
                               '%permission denied%');
  perform neo_wqt.expect_error($q$update public.staff_work set build_pool = true$q$, '%permission denied%');
  perform neo_wqt.expect_error($q$insert into public.work_alerts (kind, item_kind, item_id, body) values ('declined', 'build', 'x', 'y')$q$,
                               '%permission denied%');
  perform neo_wqt.expect_error($q$delete from public.designation_presets$q$, '%permission denied%');
end $$;


-- ── 13. People admin: hierarchy, self rules, presets, deactivation ─────────
select neo_wqt.login('head');
do $$
begin
  perform neo_wqt.expect_error($q$select public.staff_list()$q$, '%NEO_DENIED: Only tier 4 and above can manage people.%');
  perform neo_wqt.expect_error(format('select public.staff_update(%L, %L::jsonb)', neo_wqt.email('tech1'), '{"designation":"x"}'),
                               '%NEO_DENIED: Only tier 4 and above can manage people.%');
  perform neo_wqt.expect_error($q$select public.preset_upsert('{"designation":"Zq X"}'::jsonb)$q$, '%NEO_DENIED%');
  perform neo_wqt.assert(jsonb_array_length(public.preset_list()) >= 0, 'any lead may read the presets');
end $$;

select neo_wqt.login('plain');
do $$
begin
  perform neo_wqt.expect_error($q$select public.preset_list()$q$, '%NEO_DENIED: Only leads can see the designation presets.%');
end $$;

select neo_wqt.login('ceo');        -- tier 4
do $$
declare r jsonb; e jsonb;
begin
  r := public.staff_list();
  perform neo_wqt.assert(r -> 0 ->> 'is_staff' = 'false', 'staff_list: new not-staff sign-ups first');
  select x.value into e from jsonb_array_elements(r) as x(value) where x.value ->> 'email' = 'zq.newhire@neotokyo.test';
  perform neo_wqt.assert(e is not null and not (e ->> 'is_staff')::boolean and e ? 'last_sign_in_at' and e ? 'roles'
                         and e ? 'preset_key' and e ? 'open_items' and e ? 'auto_lead' and e ? 'capacity_points',
                         format('staff_list entry shape (%s)', e));
  select x.value into e from jsonb_array_elements(r) as x(value) where x.value ->> 'email' = neo_wqt.email('tech3');
  perform neo_wqt.assert((e ->> 'open_items')::int >= 1 and e -> 'roles' ->> 'qc' = 'tech' and e -> 'roles' ? 'rma',
                         'staff_list counts open items and lists explicit roles');

  perform neo_wqt.expect_error(format('select public.staff_update(%L, %L::jsonb)', neo_wqt.email('cto'), '{"designation":"x"}'),
                               '%NEO_DENIED: Only the owner can change a tier 4 or 5 account.%');
  perform neo_wqt.expect_error(format('select public.staff_update(%L, %L::jsonb)', neo_wqt.email('owner'), '{"active":false}'),
                               '%NEO_DENIED: Only the owner can change a tier 4 or 5 account.%');
  perform neo_wqt.expect_error(format('select public.staff_apply_preset(%L)', neo_wqt.email('owner')),
                               '%NEO_DENIED: Only the owner can change a tier 4 or 5 account.%');
  perform neo_wqt.expect_error(format('select public.staff_update(%L, %L::jsonb)', neo_wqt.email('tech1'), '{"tier":3}'),
                               '%NEO_DENIED: Only the owner can change tiers.%');
  perform neo_wqt.expect_error(format('select public.staff_update(%L, %L::jsonb)', neo_wqt.email('tech1'), '{"email":"x"}'),
                               '%NEO_GATE: "email" is not something you can change here.%');
  perform neo_wqt.expect_error(format('select public.staff_update(%L, %L::jsonb)', neo_wqt.email('tech1'), '{"build_level":"expert"}'),
                               '%NEO_GATE: The build level is junior, senior or none.%');
  perform neo_wqt.expect_error(format('select public.staff_update(%L, %L::jsonb)', neo_wqt.email('tech1'), '{"capacity_points":0}'),
                               '%NEO_GATE: The capacity must be a whole number between 1 and 50.%');
  perform neo_wqt.expect_error(format('select public.staff_update(%L, %L::jsonb)', neo_wqt.email('tech1'), '{"roles":{"neohr":"lead"}}'),
                               '%NEO_GATE: "neohr" is not a module you can set here.%');
  perform neo_wqt.expect_error(format('select public.staff_update(%L, %L::jsonb)', neo_wqt.email('tech1'), '{"roles":{"qc":"boss"}}'),
                               '%NEO_GATE: A role is desk, tech, lead or none.%');
  perform neo_wqt.expect_error(format('select public.staff_update(%L, %L::jsonb)', 'nobody@neotokyo.test', '{"designation":"x"}'),
                               '%NEO_GATE: No account with that email.%');
  -- self: name, designation, pools may change; tier / active / staff / roles may not
  r := public.staff_update(neo_wqt.email('ceo'), '{"department":"exec","build_pool":false}'::jsonb);
  perform neo_wqt.assert(r ->> 'department' = 'exec', 'a tier-4 may edit their own department and pools');
  perform neo_wqt.expect_error(format('select public.staff_update(%L, %L::jsonb)', neo_wqt.email('ceo'), '{"active":false}'),
                               '%NEO_DENIED: You can''t switch off your own account.%');
  perform neo_wqt.expect_error(format('select public.staff_update(%L, %L::jsonb)', neo_wqt.email('ceo'), '{"roles":{"qc":"desk"}}'),
                               '%NEO_DENIED: You can''t change your own roles.%');
  -- a tier-4 may change a tier-2 technician and a new sign-up
  r := public.staff_update(neo_wqt.email('tech1'), '{"designation":"Service Engineer","max_jobs":4}'::jsonb);
  perform neo_wqt.assert(r ->> 'designation' = 'Service Engineer' and (r ->> 'max_jobs')::int = 4, 'a tier-4 edits a tier-2');
  r := public.preset_upsert('{"designation":"Zq Field Engineer","service_role":"tech","rma_role":"desk","qc_role":null,
                              "build_pool":true,"service_pool":true,"build_level":"junior","note":"test preset"}'::jsonb);
  perform neo_wqt.assert((r ->> 'ok')::boolean and r -> 'preset' ->> 'key' = 'zq field engineer'
                         and r -> 'preset' ->> 'capacity_points' is null, 'preset_upsert derives the key');
  r := public.staff_update('zq.newhire@neotokyo.test',
                           '{"is_staff":true,"designation":"Zq Field Engineer","apply_preset":true}'::jsonb);
  perform neo_wqt.assert((r ->> 'is_staff')::boolean and (r ->> 'preset_applied')::boolean
                         and r -> 'roles' ->> 'service' = 'tech' and r -> 'roles' ->> 'rma' = 'desk' and r -> 'roles' ->> 'qc' is null
                         and (r ->> 'service_pool')::boolean and r ->> 'build_level' = 'junior'
                         and (r ->> 'capacity_points')::int = 5 and (r ->> 'max_jobs')::int = 3 and r ->> 'preset_key' = 'zq field engineer',
                         format('a new sign-up made staff with the preset (capacity from the level default) (%s)', r));
end $$;

select neo_wqt.login('owner');      -- tier 5
do $$
declare r jsonb; v_id uuid := (select id from neo_wqt.users where alias = 'tech3');
begin
  r := public.staff_update(neo_wqt.email('cto'), '{"tier":3}'::jsonb);
  perform neo_wqt.assert((r ->> 'tier')::int = 3 and (r ->> 'auto_lead')::boolean, 'the owner changes a tier-4 account''s tier');
  r := public.staff_update(neo_wqt.email('cto'), '{"tier":4}'::jsonb);
  perform neo_wqt.expect_error(format('select public.staff_update(%L, %L::jsonb)', neo_wqt.email('owner'), '{"tier":4}'),
                               '%NEO_DENIED: You can''t change your own tier.%');
  r := public.staff_update(neo_wqt.email('owner'), jsonb_build_object('tier', 5, 'full_name', neo_wqt.name('owner')));
  perform neo_wqt.assert((r ->> 'tier')::int = 5, 'sending your own unchanged tier is not a change');
  -- presets: explicit keys in the same call win, a null role deletes the row, neohr is never touched
  perform neo_wqt.assert(exists (select 1 from public.module_access where profile_id = v_id and module = 'qc')
                         and exists (select 1 from public.module_access where profile_id = v_id and module = 'neohr'), 'tech3 has qc and neohr rows');
  r := public.staff_update(neo_wqt.email('tech3'), '{"designation":"  zq   FIELD engineer ","apply_preset":true,
                                                    "build_level":"senior","roles":{"rma":"tech"}}'::jsonb);
  perform neo_wqt.assert((r ->> 'preset_applied')::boolean and r ->> 'preset_key' = 'zq field engineer'
                         and r -> 'roles' ->> 'service' = 'tech' and r -> 'roles' ->> 'rma' = 'tech' and r -> 'roles' ->> 'qc' is null
                         and r ->> 'build_level' = 'senior' and (r ->> 'capacity_points')::int = 5,
                         format('C7: apply_preset, then the explicit keys win (%s)', r));
  perform neo_wqt.assert((select role from public.module_access where profile_id = v_id and module = 'neohr') = 'desk',
                         'A5: a preset never touches neohr');
  r := public.staff_apply_preset(neo_wqt.email('tech3'));
  perform neo_wqt.assert((r ->> 'applied')::boolean and r ->> 'preset_key' = 'zq field engineer' and r -> 'person' ->> 'build_level' = 'junior',
                         'staff_apply_preset re-applies the preset');
  r := public.preset_upsert('{"key":"zq field engineer","designation":"Zq Field Engineer II","service_role":"tech"}'::jsonb);
  perform neo_wqt.assert(r -> 'preset' ->> 'key' = 'zq field engineer ii'
                         and not exists (select 1 from public.designation_presets where key = 'zq field engineer'),
                         'preset_upsert with the old key renames');
  r := public.staff_apply_preset(neo_wqt.email('tech3'));
  perform neo_wqt.assert(not (r ->> 'applied')::boolean and r ->> 'preset_key' is null, 'no preset for the designation: nothing applied');
  perform neo_wqt.assert((public.preset_delete('Zq Field Engineer II') ->> 'deleted')::boolean
                         and not (public.preset_delete('zq field engineer ii') ->> 'deleted')::boolean, 'preset_delete');
  perform neo_wqt.expect_error($q$select public.preset_upsert('{"designation":" "}'::jsonb)$q$, '%NEO_GATE: Enter the designation.%');
  perform neo_wqt.expect_error($q$select public.preset_upsert('{"designation":"Zq Y","qc_role":"boss"}'::jsonb)$q$,
                               '%NEO_GATE: A role is desk, tech, lead or none.%');
  -- put tech3 back as the tests expect
  perform public.staff_update(neo_wqt.email('tech3'), '{"roles":{"qc":"tech","service":"tech"},"build_pool":true,"service_pool":true}'::jsonb);
end $$;

-- Everyone People touches keeps a staff_work row, so a re-run of the migration
-- never applies a preset over roles set here by hand. The row holds the column
-- defaults, which read exactly like "no row".
reset role;
select neo_wqt.no_jwt();
insert into auth.users (id, email, raw_user_meta_data)
values ('a1111111-0000-4000-8000-000000000005', 'zq.marker@neotokyo.test', '{"full_name":"Zqmarker Person"}');
select neo_wqt.login('owner');
do $$
declare r jsonb; w public.staff_work;
begin
  r := public.staff_update('zq.marker@neotokyo.test', '{"is_staff":true,"designation":"Zq No Preset","roles":{"service":"desk"}}'::jsonb);
  select sw.* into w from public.staff_work sw join public.profiles p on p.id = sw.profile_id where p.email = 'zq.marker@neotokyo.test';
  perform neo_wqt.assert(w.profile_id is not null and not w.build_pool and not w.service_pool and w.build_level is null
                         and w.capacity_points = 6 and w.max_jobs = 4 and w.updated_by = lower(neo_wqt.email('owner'))
                         and r -> 'roles' ->> 'service' = 'desk' and (r ->> 'capacity_points')::int = 6 and r ->> 'preset_key' is null,
                         format('staff_update with no work keys still leaves a staff_work row, at the defaults (%s, %s)', row_to_json(w), r));
  perform neo_wqt.assert(not exists (select 1 from public.staff_work sw join public.profiles p on p.id = sw.profile_id
                                      where p.email = 'zq.twin.two@neotokyo.test'), 'TEST SETUP: twin two has no staff_work row');
  r := public.staff_apply_preset('zq.twin.two@neotokyo.test');
  perform neo_wqt.assert(not (r ->> 'applied')::boolean
                         and exists (select 1 from public.staff_work sw join public.profiles p on p.id = sw.profile_id
                                      where p.email = 'zq.twin.two@neotokyo.test' and sw.updated_by = lower(neo_wqt.email('owner'))),
                         format('staff_apply_preset with no matching preset still leaves a staff_work row (%s)', r));
end $$;

-- Deactivation: what they hold goes back to the queue, offers to them end.
reset role;
select neo_wqt.no_jwt();
select neo_wqt.mkbuild('t_wqt_e1', 'Zq Build Held', 1, interval '1 hour');
select neo_wqt.mkbuild('t_wqt_e2', 'Zq Build Offered', 1, interval '1 hour');
select neo_wqt.login('tech1');
do $$
begin
  perform neo_wqt.assert((public.work_claim('build', 't_wqt_e1') ->> 'ok')::boolean, 'tech1 holds e1');
end $$;
select neo_wqt.login('head');
do $$
begin
  perform public.work_offer('build', 't_wqt_e2', neo_wqt.email('tech1'), 'Before you go');
end $$;
select neo_wqt.login('owner');
do $$
declare r jsonb;
begin
  r := public.staff_update(neo_wqt.email('tech1'), '{"active":false}'::jsonb);
  perform neo_wqt.assert(not (r ->> 'active')::boolean and (r ->> 'open_items')::int = 0,
                         format('deactivating someone releases everything they held (%s)', r));
end $$;

reset role;
do $$
declare t public.tickets; v_name text := neo_wqt.name('tech1');
begin
  perform neo_wqt.no_jwt();
  select * into t from public.tickets where id = 't_wqt_e1';
  perform neo_wqt.assert(t.technician_email is null and t.queued_at = now() and t.declined_emails = array[neo_wqt.email('tech1')],
                         'the held build is back in the queue');
  perform neo_wqt.assert(exists (select 1 from public.work_events where item_id = 't_wqt_e1' and kind = 'release'
                                   and body like '%' || v_name || ' is no longer active'), 'release reason names them');
  perform neo_wqt.assert((select offered_to_email from public.tickets where id = 't_wqt_e2') is null
                         and exists (select 1 from public.work_events where item_id = 't_wqt_e2' and kind = 'offer_withdrawn'),
                         'the offer to them is withdrawn');
  perform neo_wqt.assert((select assignee_email from public.service_jobs where id = neo_wqt.get('s2')) is null
                         and (select declined_emails from public.service_jobs where id = neo_wqt.get('s2')) = array[neo_wqt.email('tech1')],
                         'their service job is released too');
end $$;

select neo_wqt.login('tech1');
do $$
begin
  perform neo_wqt.expect_error($q$select public.work_queue()$q$, '%NEO_DENIED: Sign in with an active staff account to do this.%');
  perform neo_wqt.expect_error($q$select public.work_claim('build', 't_wqt_e1')$q$, '%NEO_DENIED%');
end $$;

select neo_wqt.login('owner');
do $$
begin
  perform public.staff_update(neo_wqt.email('tech1'), '{"active":true}'::jsonb);
  perform neo_wqt.assert(exists (select 1 from public.profiles where tier = 5 and active and is_staff),
                         'there is still an active tier-5 account');
end $$;


-- ── 14. NeoHR work logs ──────────────────────────────────────────────────────
-- Pushed as the throw-away logins (solo, twin1), so no real synced log can be
-- counted; tech3 pushes one for the team view.
select neo_wqt.login('solo');
do $$
declare r jsonb;
begin
  perform neo_wqt.expect_error($q$select public.work_log_push('{"id":1}'::jsonb)$q$, '%NEO_GATE: Send the logs as a list.%');
  perform neo_wqt.expect_error(format('select public.work_log_push(%L::jsonb)',
                                      (select jsonb_agg(jsonb_build_object('id', gen_random_uuid())) from generate_series(1, 201))),
                               '%NEO_GATE: Send at most 200 logs at a time.%');
  r := public.work_log_push(jsonb_build_array(
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000001', 'title', ' Fixed the office switch ', 'description', 'Re-cabled',
                       'category', 'Networking', 'location_name', 'Kakkanad', 'latitude', 10.01, 'longitude', 76.34,
                       'created_at', '2026-01-14T18:29:59Z', 'updated_at', '2026-01-14T18:29:59Z', 'deleted', false),
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000002', 'title', 'Midnight log', 'category', '',
                       'latitude', 91, 'longitude', 76.34,
                       'created_at', '2026-01-14T18:30:00Z', 'updated_at', '2026-01-14T18:30:00Z'),
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000003', 'title', 'Today', 'created_at', now(), 'updated_at', now()),
    jsonb_build_object('id', 'not-a-uuid', 'title', 'x', 'created_at', now(), 'updated_at', now()),
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000004', 'title', '   ', 'created_at', now(), 'updated_at', now()),
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000005', 'title', 'Old clock', 'created_at', '2019-12-31T00:00:00Z',
                       'updated_at', now()),
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000006', 'title', 'Fast clock', 'created_at', now(),
                       'updated_at', now() + interval '11 minutes'),
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000007', 'title', 'No times'),
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000008', 'title', repeat('t', 301), 'created_at', now(), 'updated_at', now()),
    '"just a string"'::jsonb));
  perform neo_wqt.assert((r ->> 'ok')::boolean and jsonb_array_length(r -> 'accepted') = 3 and jsonb_array_length(r -> 'stale') = 0
                         and jsonb_array_length(r -> 'rejected') = 7, format('push: 3 accepted, 7 rejected (%s)', r));
  perform neo_wqt.assert(neo_wqt.reason_of(r -> 'rejected', 'not-a-uuid') = 'invalid'
                         and neo_wqt.reason_of(r -> 'rejected', 'b2222222-0000-4000-8000-000000000004') = 'invalid'
                         and neo_wqt.reason_of(r -> 'rejected', 'b2222222-0000-4000-8000-000000000005') = 'clock'
                         and neo_wqt.reason_of(r -> 'rejected', 'b2222222-0000-4000-8000-000000000006') = 'clock'
                         and neo_wqt.reason_of(r -> 'rejected', 'b2222222-0000-4000-8000-000000000007') = 'invalid'
                         and neo_wqt.reason_of(r -> 'rejected', 'b2222222-0000-4000-8000-000000000008') = 'invalid',
                         'A12: each bad row is rejected on its own, with a reason');
  -- older and equal updated_at are stale; newer wins
  r := public.work_log_push(jsonb_build_array(
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000001', 'title', 'Older edit',
                       'created_at', '2026-01-14T18:29:59Z', 'updated_at', '2026-01-14T18:00:00Z'),
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000002', 'title', 'Same time',
                       'created_at', '2026-01-14T18:30:00Z', 'updated_at', '2026-01-14T18:30:00Z'),
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000003', 'title', 'Today, edited', 'created_at', now(),
                       'updated_at', now() + interval '1 second')));
  perform neo_wqt.assert(jsonb_array_length(r -> 'stale') = 2 and neo_wqt.has_id(r -> 'accepted', 'b2222222-0000-4000-8000-000000000003'),
                         'last writer wins on updated_at: older and equal are stale');
  -- deletes: own and newer accepted, older stale, an unknown id accepted (nothing to do)
  r := public.work_log_push(jsonb_build_array(
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000002', 'updated_at', '2026-01-15T00:00:00Z', 'deleted', true),
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000001', 'updated_at', '2026-01-01T00:00:00Z', 'deleted', true),
    jsonb_build_object('id', 'b2222222-0000-4000-8000-0000000000ff', 'updated_at', now(), 'deleted', true)));
  perform neo_wqt.assert(neo_wqt.has_id(r -> 'accepted', 'b2222222-0000-4000-8000-000000000002')
                         and neo_wqt.has_id(r -> 'stale', 'b2222222-0000-4000-8000-000000000001')
                         and neo_wqt.has_id(r -> 'accepted', 'b2222222-0000-4000-8000-0000000000ff'),
                         format('C9: deletes (only id / updated_at / deleted are read) (%s)', r));
  r := public.work_log_pull(null, null);
  perform neo_wqt.assert(jsonb_array_length(r -> 'rows') = 3 and not (r ->> 'more')::boolean
                         and exists (select 1 from jsonb_array_elements(r -> 'rows') as e(value)
                                      where e.value ->> 'id' = 'b2222222-0000-4000-8000-000000000002' and (e.value ->> 'deleted')::boolean)
                         and exists (select 1 from jsonb_array_elements(r -> 'rows') as e(value)
                                      where e.value ->> 'id' = 'b2222222-0000-4000-8000-000000000001'
                                        and e.value ->> 'title' = 'Fixed the office switch' and e.value ->> 'category' = 'Networking'
                                        and (e.value ->> 'latitude')::float = 10.01
                                        and e.value ? 'created_at' and e.value ? 'updated_at' and e.value ? 'location_name'),
                         format('pull: my rows in the push shape, with the tombstone, titles trimmed (%s)', r));
  perform neo_wqt.assert(exists (select 1 from jsonb_array_elements(r -> 'rows') as e(value)
                                  where e.value ->> 'id' = 'b2222222-0000-4000-8000-000000000002'
                                    and e.value -> 'latitude' = 'null'::jsonb and e.value -> 'longitude' = 'null'::jsonb),
                         'A12: a latitude out of range drops the whole fix (not the row)');
  perform neo_wqt.assert(not exists (select 1 from public.work_logs where id = 'b2222222-0000-4000-8000-0000000000ff'),
                         'a delete of an unknown id creates nothing');
  -- a newer normal write brings a deleted row back
  r := public.work_log_push(jsonb_build_array(
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000002', 'title', 'Restored',
                       'created_at', '2026-01-14T18:30:00Z', 'updated_at', '2026-01-15T00:00:01Z')));
  perform neo_wqt.assert(neo_wqt.has_id(r -> 'accepted', 'b2222222-0000-4000-8000-000000000002')
                         and (select deleted_at from public.work_logs where id = 'b2222222-0000-4000-8000-000000000002') is null
                         and (select category from public.work_logs where id = 'b2222222-0000-4000-8000-000000000002') = 'Work',
                         '9.1: a newer non-deleted write clears deleted_at (and a blank category reads Work)');
  perform neo_wqt.assert((select count(*) from public.work_logs) = 3
                         and not exists (select 1 from public.work_logs where lower(employee_email) <> 'zq.solo@neotokyo.test'),
                         'RLS: below tier 3 you read only your own logs');
  perform neo_wqt.expect_error($q$insert into public.work_logs (id, employee_email, title, created_at, updated_at)
                                  values (gen_random_uuid(), 'x', 'x', now(), now())$q$, '%permission denied%');
  perform neo_wqt.expect_error($q$update public.work_logs set title = 'x'$q$, '%permission denied%');
  perform neo_wqt.expect_error($q$select public.work_log_team('2026-01-15', '2026-01-15')$q$,
                               '%NEO_DENIED: Only tier 3 and above can see the team''s logs.%');
end $$;

select neo_wqt.login('twin1');
do $$
declare r jsonb; v_batch jsonb; i int; v_since text; v_after text;
begin
  r := public.work_log_push(jsonb_build_array(
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000001', 'title', 'Hijack', 'created_at', now(), 'updated_at', now()),
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000003', 'updated_at', now() + interval '5 minutes', 'deleted', true)));
  perform neo_wqt.assert(neo_wqt.reason_of(r -> 'rejected', 'b2222222-0000-4000-8000-000000000001') = 'not_yours'
                         and neo_wqt.reason_of(r -> 'rejected', 'b2222222-0000-4000-8000-000000000003') = 'not_yours',
                         'someone else''s id: not_yours (upsert and delete)');
  perform neo_wqt.assert(not exists (select 1 from public.work_logs wl where wl.id = 'b2222222-0000-4000-8000-000000000001'),
                         'and they cannot even read it');
  -- 1001 rows pushed in one transaction share one received_at: the keyset still pages exactly
  for i in 0 .. 5 loop
    select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'title', 'Bulk ' || g, 'created_at', now() - interval '1 day',
                                        'updated_at', now() - interval '1 day'))
      into v_batch from generate_series(i * 200 + 1, least(1001, i * 200 + 200)) g;
    r := public.work_log_push(v_batch);
    perform neo_wqt.assert(jsonb_array_length(r -> 'accepted') = jsonb_array_length(v_batch), 'bulk push accepted');
  end loop;
  r := public.work_log_pull(null, null);
  perform neo_wqt.assert(jsonb_array_length(r -> 'rows') = 1000 and (r ->> 'more')::boolean and r ->> 'next_after' is not null
                         and r ->> 'next_since' is not null, 'pull pages at 1000 and says there is more');
  v_since := r ->> 'next_since'; v_after := r ->> 'next_after';
  r := public.work_log_pull(v_since::timestamptz, v_after::uuid);
  perform neo_wqt.assert(jsonb_array_length(r -> 'rows') = 1 and not (r ->> 'more')::boolean,
                         format('the next page has the last row (keyset on (received_at, id) survives ties) (%s)', r -> 'more'));
  r := public.work_log_pull((r ->> 'next_since')::timestamptz, (r ->> 'next_after')::uuid);
  perform neo_wqt.assert(jsonb_array_length(r -> 'rows') = 0 and not (r ->> 'more')::boolean, 'and then nothing');
end $$;

select neo_wqt.login('tech3');
do $$
declare r jsonb;
begin
  r := public.work_log_push(jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid(), 'title', 'Checked the queue', 'created_at', now(), 'updated_at', now())));
  perform neo_wqt.assert(jsonb_array_length(r -> 'accepted') = 1, 'tech3 logs something today');
end $$;

reset role;
select neo_wqt.no_jwt();
update public.work_logs set profile_id = null where id = 'b2222222-0000-4000-8000-000000000003';   -- the login was deleted
select neo_wqt.login('solo');
do $$
declare r jsonb;
begin
  r := public.work_log_push(jsonb_build_array(
    jsonb_build_object('id', 'b2222222-0000-4000-8000-000000000003', 'title', 'Mine?', 'created_at', now(), 'updated_at', now() + interval '2 minutes')));
  perform neo_wqt.assert(neo_wqt.reason_of(r -> 'rejected', 'b2222222-0000-4000-8000-000000000003') = 'not_yours',
                         'A9: a row whose login was deleted is nobody''s to change');
  perform neo_wqt.assert(jsonb_array_length(public.work_log_pull(null, null) -> 'rows') = 2, 'and it is no longer in my pull');
end $$;

select neo_wqt.login('head');
do $$
declare r jsonb; p jsonb;
begin
  r := public.work_log_team('2026-01-15', '2026-01-15', null);
  perform neo_wqt.assert(neo_wqt.has_id(r -> 'rows', 'b2222222-0000-4000-8000-000000000002')
                         and not neo_wqt.has_id(r -> 'rows', 'b2222222-0000-4000-8000-000000000001'),
                         'A11: 18:30 UTC is 00:00 the next day in India');
  r := public.work_log_team('2026-01-14', '2026-01-14', upper('zq.solo@neotokyo.test'));
  perform neo_wqt.assert(neo_wqt.has_id(r -> 'rows', 'b2222222-0000-4000-8000-000000000001')
                         and not neo_wqt.has_id(r -> 'rows', 'b2222222-0000-4000-8000-000000000002')
                         and jsonb_array_length(r -> 'rows') = 1
                         and r -> 'rows' -> 0 ->> 'employee_name' = 'Zqsolo Person' and r -> 'rows' -> 0 ->> 'day' = '2026-01-14'
                         and r ->> 'from' = '2026-01-14' and r ->> 'to' = '2026-01-14',
                         format('A11: 18:29:59 UTC is still the 14th; one person''s logs, with their name (%s)', r));
  r := public.work_log_team(((now() at time zone 'Asia/Kolkata')::date), ((now() at time zone 'Asia/Kolkata')::date), null);
  perform neo_wqt.assert(exists (select 1 from jsonb_array_elements(r -> 'rows') as e(value)
                                  where e.value ->> 'id' = 'b2222222-0000-4000-8000-000000000003'
                                    and e.value ->> 'employee_name' = 'zq.solo@neotokyo.test'),
                         'A9: a row with no profile is labelled with its stored email');
  perform neo_wqt.assert(not exists (select 1 from jsonb_array_elements(r -> 'rows') as e(value) where e.value ->> 'title' like 'Bulk%'),
                         'yesterday''s rows are not today''s');
  perform neo_wqt.expect_error($q$select public.work_log_team('2026-01-15', '2026-01-14')$q$, '%NEO_GATE: The end date is before the start date.%');
  perform neo_wqt.expect_error($q$select public.work_log_team('2026-01-01', '2026-03-04')$q$, '%NEO_GATE: Ask for at most 62 days at a time.%');
  r := public.work_log_team('2026-01-01', '2026-03-03', null);
  perform neo_wqt.assert(jsonb_typeof(r -> 'rows') = 'array' and not (r ->> 'more')::boolean, '62 days is allowed');
  perform neo_wqt.assert((select count(*) from public.work_logs where employee_email = 'zq.twin.one@neotokyo.test') = 1001,
                         'RLS: tier 3 reads everyone''s logs');
  r := public.work_team();
  p := neo_wqt.person(r, neo_wqt.email('tech3'));
  perform neo_wqt.assert((p ->> 'last_seen_at') is not null and (p ->> 'logs_today')::int >= 1,
                         format('work_team: last seen and today''s logs (IST) for tier 3 (%s)', p));
end $$;


-- ── 15. Done ─────────────────────────────────────────────────────────────────
reset role;
select 'work-queue tests: all passed' as result;

rollback;
