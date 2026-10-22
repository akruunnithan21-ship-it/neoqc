-- =============================================================================
-- NEO TOKYO OPERATIONS — Service v2.1: data answers and the device password
-- Migration name: service_v2_1_secrets      Target: Postgres 17 on Supabase
-- Applied ON TOP of sql/service-v2.sql (already live). Run that one first.
-- -----------------------------------------------------------------------------
-- The owner's rule: the shop does not back up customer data and is not
-- responsible for it. The desk asks the customer to back up their own drives
-- on their own disks, and records what the customer said. It may also record
-- the device's password or PIN, if the customer uses one, for the technician.
--
-- What this does:
--   §1  _vocab_list('data_consent') and the service_jobs CHECK accept the three
--       new answers (customer_backed_up, no_important_data,
--       customer_accepts_risk). backup_ok / no_backup stay VALID — the
--       1.10.0-beta.1 build and old rows use them — but the apps stop offering
--       them.
--   §2  service_jobs.has_device_password: a harmless flag the board can read.
--   §3  service_secrets: one row per ticket holding the password. RLS on with
--       NO policies and no table grants, so nobody reads it directly; only the
--       two SECURITY DEFINER RPCs below touch it. Not in realtime.
--   §4  service_set_password / service_get_password. Every save, removal and
--       read writes an internal timeline line — never the value.
--   §5  A BEFORE UPDATE trigger deletes the password the moment a ticket
--       closes, whoever closes it (an RPC, a v1.9.11 desk, a lead's edit).
--
-- RULES (the same as service-v2.sql)
--   * v1.9.11 desktop clients keep working: the new column is defaulted, and
--     a stale has_device_password sent back by any client is quietly put back
--     rather than refused, so an old full-row write can never fail on it.
--   * Errors meant for people are raised as  NEO_<KIND>: <a human sentence>.
--   * Re-runnable: if not exists, create or replace, drop ... if exists.
--   * get_service_public is NOT touched: the customer's page never learns that
--     a password exists, let alone what it is.
--
-- RE-RUNNING service-v2.sql AFTER THIS FILE puts the old three-value
-- _vocab_list('data_consent') back (the column CHECK survives: v2's
-- "add column if not exists … check" is skipped for an existing column).
-- Re-run this file after it.
--
-- Apply as ONE migration. Nothing here deletes customer data; the only rows
-- it ever deletes are device passwords of tickets that are closed.
-- =============================================================================

set local lock_timeout = '15s';


-- =============================================================================
-- §1  DATA ANSWERS — five valid values, three offered
-- =============================================================================

-- The whole function, copied from service-v2.sql §1 with ONE line changed
-- (data_consent). tests/sql-parity.test.js reads the newest definition of it
-- across sql/service-v2.sql + sql/service-v2.*.sql and compares every list.
create or replace function public._vocab_list(p_list text)
returns text[]
language sql immutable parallel safe
set search_path = public
as $$
  select case p_list
    when 'service_type'    then array['in_store','on_site','remote']
    when 'channel'         then array['walk_in','phone','whatsapp','website','courier','staff']
    when 'category'        then array['repair','warranty_claim','upgrade','installation','data_recovery',
                                      'os_software','networking','maintenance','diagnosis_only']
    when 'priority'        then array['low','normal','high','urgent']
    when 'data_consent'    then array['customer_backed_up','no_important_data','customer_accepts_risk','backup_ok','no_backup']
    when 'remote_tool'     then array['anydesk','teamviewer','rustdesk','quick_assist','chrome_remote','other']
    when 'item_kind'       then array['pc','laptop','gpu','psu','ram','ssd','hdd','motherboard','cpu',
                                      'cooler','monitor','peripheral','other']
    when 'purchase_source' then array['neo_tokyo','elsewhere','unknown']
    when 'outcome'         then array['repaired','unrepairable','declined','no_fault_found',
                                      'replaced_under_warranty','cancelled','resolved_on_site',
                                      'resolved_remotely','returned_rma_pending']
    when 'svc_stage'       then array['logged','received','diagnosing','quoted','approved','parts_to_order',
                                      'parts_on_order','rma_raised','at_vendor','back_from_vendor','in_service',
                                      'verifying','ready','closed','scheduled','en_route','on_site','work_done',
                                      'revisit_needed','session_booked','in_session','resolved']
    when 'rma_source'      then array['from_ticket','walk_in','courier','field','stock','website']
    when 'sender_kind'     then array['customer','third_party_tech','our_tech','shop']
    when 'diagnosed_by'    then array['us','third_party','customer']
    when 'return_method'   then array['collect','courier','with_device']
    when 'vendor_result'   then array['replaced','repaired','credit_note','rejected','lost','shipped_to_customer']
    when 'fee_status'      then array['n_a','quoted','accepted','paid','waived']
    when 'data_handling'   then array['wiped_by_us','customer_consents','unreadable_informed']
    when 'ship_mode'       then array['courier','hand_delivery','vendor_pickup','bus_parcel']
    when 'disposition'     then array['refitted','replaced','repaired','credit_note','rejected_returned',
                                      'no_fault_found','out_of_warranty','withdrawn','converted_to_repair',
                                      'restocked','scrapped_with_consent','lost_compensated']
    when 'rma_stage'       then array['with_tech','logged','received','testing','awaiting_docs','ready_to_ship',
                                      'with_vendor','back_from_vendor','customer_decision','ready_to_return',
                                      'returning','closed']
    when 'media_role'      then array['condition','serial_label','invoice','damage','packing','unboxing',
                                      'during','after','vendor_doc','return_condition','other']
    when 'module'          then array['service','rma','qc','neohr']
    when 'module_role'     then array['desk','tech','lead']
    when 'field_kind'      then array['punch_in','punch_out','left_base','arrived','departed','note','photo']
    when 'field_outcome'   then array['done','revisit_needed','parts_needed','customer_absent']
    when 'field_source'    then array['desktop','neohr']
    when 'field_module'    then array['service','rma','neohr']
    when 'field_ref_type'  then array['service_job','rma_case','attendance','work_log','none']
    when 'vendor_kind'     then array['brand','distributor','service_centre']
    else null
  end
$$;

-- The column CHECK. Its name came from Postgres (v2 declared it inline on
-- "add column"), so it is found, not assumed: every CHECK on service_jobs that
-- mentions data_consent and nothing else goes, then one named check with the
-- five values comes back. A compound business rule that happens to mention
-- the column (AND / OR) is left alone. Re-running drops and re-adds the same
-- check. Every existing row holds one of the old three values or NULL, all of
-- which stay valid, so the re-add validates without surprises.
do $$
declare r record;
begin
  for r in
    select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
     where conrelid = 'public.service_jobs'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ~* '\mdata_consent\M'
  loop
    if r.def !~* '\m(and|or)\M' then
      execute format('alter table public.%I drop constraint %I', 'service_jobs', r.conname);
    else
      raise notice 'service_v2_1: left the compound check % (%) in place', r.conname, r.def;
    end if;
  end loop;
end $$;

alter table public.service_jobs add constraint service_jobs_data_consent_check
  check (data_consent in ('customer_backed_up','no_important_data','customer_accepts_risk','backup_ok','no_backup'));


-- =============================================================================
-- §2  service_jobs.has_device_password — whether a password is on file
-- =============================================================================

-- Only a yes/no, so it is safe on the board, in realtime and in to_jsonb(row).
-- It is maintained by the RPCs and the close trigger below (neo.rpc), never by
-- a client; §5 puts back any other change.
alter table public.service_jobs add column if not exists has_device_password boolean not null default false;


-- =============================================================================
-- §3  service_secrets — the password itself
-- =============================================================================

create table if not exists public.service_secrets (
  job_id       text primary key references public.service_jobs(id) on delete cascade,
  secret       text not null check (length(secret) between 1 and 500),
  set_by_email text,
  set_by_name  text,
  set_at       timestamptz default now()
);

-- RLS on and NO policies: a direct select / insert / update / delete by any
-- signed-in role finds nothing and may change nothing, even if a grant ever
-- came back by accident. The definer RPCs (owned by the table owner) are the
-- only way in. Policies someone added by hand are removed.
alter table public.service_secrets enable row level security;
do $$
declare r record;
begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'service_secrets' loop
    execute format('drop policy if exists %I on public.%I', r.policyname, 'service_secrets');
  end loop;
end $$;
-- Supabase grants ALL on new public tables to anon and authenticated by default.
revoke all on table public.service_secrets from anon, authenticated, public;

-- Never broadcast. (It is not added anywhere; this undoes a hand-made add.)
do $$
begin
  if exists (select 1 from pg_publication_tables
              where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'service_secrets') then
    execute format('alter publication supabase_realtime drop table public.%I', 'service_secrets');
  end if;
end $$;


-- =============================================================================
-- §4  THE TWO RPCs
-- =============================================================================

-- Save, change or remove a ticket's device password. An empty (or blank)
-- p_secret removes it. The value is stored exactly as typed (a password with
-- a space in it is still that password). Desk and up, open tickets only: a
-- closed ticket's password was deleted when it closed and must not come back.
create or replace function public.service_set_password(p_job_id text, p_secret text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_job public.service_jobs;
  v_new public.service_jobs;
  v_secret text := case when btrim(coalesce(p_secret, '')) = '' then null else p_secret end;
  v_had boolean;
  v_prev text;
begin
  if not public.has_module('service', 'desk') then
    raise exception 'NEO_DENIED: You don''t have access to change service tickets.';
  end if;
  select * into v_job from public.service_jobs where id = p_job_id for update;
  if not found then raise exception 'NEO_GATE: That ticket no longer exists.'; end if;
  if v_job.stage = 'closed' then
    raise exception 'NEO_GATE: This ticket is closed. Its device password was deleted when it closed.';
  end if;
  -- Checked here, not left to the column CHECK: a CHECK failure's DETAIL
  -- repeats the whole row, and the row holds the password.
  if v_secret is not null and length(v_secret) > 500 then
    raise exception 'NEO_GATE: That password is too long — keep it under 500 characters.';
  end if;

  v_had := exists (select 1 from public.service_secrets where job_id = p_job_id);
  if v_secret is null and not v_had then
    return jsonb_build_object('ok', true, 'unchanged', true, 'has_device_password', false, 'job', to_jsonb(v_job));
  end if;

  if v_secret is null then
    delete from public.service_secrets where job_id = p_job_id;
  else
    insert into public.service_secrets (job_id, secret, set_by_email, set_by_name, set_at)
    values (p_job_id, v_secret, v_me.email, v_me.full_name, now())
    on conflict (job_id) do update
       set secret = excluded.secret, set_by_email = excluded.set_by_email,
           set_by_name = excluded.set_by_name, set_at = excluded.set_at;
  end if;

  v_new := v_job;
  if v_job.has_device_password is distinct from (v_secret is not null) then
    v_prev := public._flag_set('neo.rpc');
    update public.service_jobs set has_device_password = (v_secret is not null)
     where id = p_job_id
    returning * into v_new;
    perform public._flag_restore('neo.rpc', v_prev);
  end if;

  perform public._svc_ev(p_job_id, 'edit',
    case when v_secret is null then 'Device password removed' else 'Device password saved' end,
    false, null, null, jsonb_build_object('device_password', case when v_secret is null then 'removed' else 'saved' end),
    'staff', v_me.email, v_me.full_name);
  return jsonb_build_object('ok', true, 'has_device_password', v_secret is not null, 'job', to_jsonb(v_new));
end $$;

-- Read a ticket's device password. Desk and up. Every read that returns a
-- password leaves "Device password viewed by <name>" on the internal timeline,
-- so who looked and when is never a question. A ticket with nothing on file
-- answers {secret: null} and logs nothing (nothing was seen).
create or replace function public.service_get_password(p_job_id text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_s public.service_secrets;
begin
  if not public.has_module('service', 'desk') then
    raise exception 'NEO_DENIED: You don''t have access to service tickets.';
  end if;
  if not exists (select 1 from public.service_jobs where id = p_job_id) then
    raise exception 'NEO_GATE: That ticket no longer exists.';
  end if;
  select * into v_s from public.service_secrets where job_id = p_job_id;
  if not found then
    return jsonb_build_object('secret', null, 'set_by_name', null, 'set_at', null);
  end if;
  perform public._svc_ev(p_job_id, 'edit',
    'Device password viewed by ' || coalesce(nullif(btrim(coalesce(v_me.full_name, '')), ''), v_me.email),
    false, null, null, jsonb_build_object('device_password', 'viewed'),
    'staff', v_me.email, v_me.full_name);
  return jsonb_build_object('secret', v_s.secret, 'set_by_name', v_s.set_by_name, 'set_at', v_s.set_at);
end $$;


-- =============================================================================
-- §5  THE CLOSE PURGE (and the flag's guard)
-- =============================================================================

-- BEFORE UPDATE triggers fire in name order, so "zz" runs after
-- trg_service_jobs_guard: a close the guard refuses never gets here, and one
-- it allows has already passed every rule by the time the password goes.
-- Deleting in the same statement as the close means there is no moment when a
-- closed ticket still holds a password, whoever closed it and however.
create or replace function public.tg_service_jobs_zz_secret_purge()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_had boolean;
  v_name text;
begin
  if current_setting('neo.migrating', true) = '1' then return new; end if;

  -- The flag follows service_secrets and nothing else. A client that sends it
  -- (an old build writing back a cached row) is not refused, just ignored.
  if new.has_device_password is distinct from old.has_device_password
     and coalesce(current_setting('neo.rpc', true), '') <> '1' then
    new.has_device_password := old.has_device_password;
  end if;

  if new.stage = 'closed' and old.stage is distinct from 'closed' then
    delete from public.service_secrets where job_id = new.id;
    v_had := found;
    new.has_device_password := false;
    if v_had then
      select full_name into v_name from public.profiles where id = auth.uid();
      perform public._svc_ev(new.id, 'edit', 'Device password deleted — ticket closed', false, null, null,
                             jsonb_build_object('device_password', 'deleted'),
                             'system', coalesce(auth.email(), 'system'), v_name);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_service_jobs_zz_secret_purge on public.service_jobs;
create trigger trg_service_jobs_zz_secret_purge before update on public.service_jobs
  for each row execute function public.tg_service_jobs_zz_secret_purge();

-- Tickets that closed before this file existed have nothing to purge (the
-- table is new); a flag left true on one would only ever be a manual edit.
do $$
declare v_prev text;
begin
  v_prev := public._flag_set('neo.rpc');
  update public.service_jobs sj set has_device_password = false
   where sj.has_device_password
     and not exists (select 1 from public.service_secrets s where s.job_id = sj.id);
  perform public._flag_restore('neo.rpc', v_prev);
end $$;


-- =============================================================================
-- §6  FUNCTION PRIVILEGES
--      Postgres grants EXECUTE to PUBLIC by default and Supabase adds anon and
--      authenticated. Revoke from all three; the two RPCs go to authenticated
--      (they check the module role themselves), the trigger to nobody.
--      _vocab_list keeps the grants service-v2.sql gave it (create or replace
--      does not touch privileges).
-- =============================================================================

do $$
declare
  r record;
  v_all text[] := array['service_set_password', 'service_get_password', 'tg_service_jobs_zz_secret_purge'];
  v_authenticated text[] := array['service_set_password', 'service_get_password'];
begin
  for r in
    select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as sig, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any (v_all)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname = any (v_authenticated) then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- =============================================================================
-- End of service_v2_1_secrets. Run sql/service-v2.1.tests.sql next (it rolls
-- back).
-- =============================================================================
