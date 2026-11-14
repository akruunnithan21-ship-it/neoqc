-- =============================================================================
-- NEO TOKYO OPERATIONS — Builds leave the technician queue: the Builds desk
-- assigns each build directly (owner decision 2026-11-13)
-- Migration name: build_direct_assign_part01      Target: Postgres 17 on Supabase
-- Ships with Neo OS 1.12.3. Database first, then the desktop and the website.
-- -----------------------------------------------------------------------------
-- WHAT THIS DOES
--   * A build never waits in a queue. Nobody claims it, the 4-hour clock never
--     starts, the app never offers it, and nobody has 30 minutes to accept it.
--   * The Builds desk (qc role 'desk') or a QC lead (tier 3+ are leads of
--     every module) picks the technician with build_assign(). The build is
--     theirs at once. Technicians can't assign, not even to themselves (that
--     would be a claim). Tier 4-5 builds still go only to senior builders
--     (_work_why_not, unchanged).
--     Taking a build from one technician and giving it to another needs a
--     reason, which goes into the build's history.
--   * build_tech_list(): the people the desk can choose from, with their load.
--     work_team() stays for leads only (it carries NeoHR data).
--   * Handing a build back (work_release, a deactivation) leaves it with no
--     technician, for the desk to assign again; it does not go to a queue.
--   * Service is unchanged: its queue, offers and clock work as before.
--
-- HOW (one trigger does the enforcing, so every path is covered)
--   tg_tickets_work_zz_direct runs on every insert/update of a build, after
--   trg_tickets_work_guard (trigger names fire in alphabetical order):
--     - queued_at is always null, so work_tick's 4-hour step, _work_expire's
--       re-offer and the Work screen's "Open queue" never see a build;
--     - writing a new offer raises NEO_GATE (work_offer from Neo OS 1.12.2 and
--       older, and the app's own offer, which can no longer happen);
--     - a new claim raises NEO_GATE (backstop: work_claim already finds no
--       queued build).
--   build_queue_send now answers {ok:false, reason:'no_queue', message} and
--   writes nothing. 1.12.2 shows the message; its background send for a new
--   build retries quietly every 15 s until that PC updates (no toasts).
--
-- OLD CLIENTS (1.12.2 and older desktops, until they update)
--   * Everything except giving out builds works as before.
--   * They cannot give a build a technician: "Offer to…" and "Send to build
--     queue" show the message above. Update to 1.12.3.
--
-- RE-RUN RULES
--   * Re-runnable. After ANY re-run of sql/work-queue.sql (which puts back the
--     queue's build_queue_send), re-run this file.
--   * sql/work-queue.tests.sql tests the build queue, so its build sections
--     fail while this is live. That is expected. Run it only after
--     sql/build-direct-assign-rollback.sql, inside one rolled-back transaction.
--   * Switch back to the queue: sql/build-direct-assign-rollback.sql.
--
-- Tests: sql/build-direct-assign.tests.sql (one transaction, ends in ROLLBACK).
-- Nothing here deletes data. The one build waiting in the queue today comes
-- out of it (queued_at cleared, with a line in its history).
-- =============================================================================

set local lock_timeout = '15s';

do $bd$
declare
  r record;
  v_prev text;
begin

-- ── 1. History: a direct assignment has its own kind ─────────────────────────
-- Widened, never narrowed: the rollback leaves it, because rows may use it.
-- The CHECK was declared inline, so its name came from Postgres: every check
-- on work_events.kind is dropped and one named check comes back.
for r in
  select c.conname from pg_constraint c
   where c.conrelid = 'public.work_events'::regclass and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ~* '\mkind\M' and pg_get_constraintdef(c.oid) ~ 'no_candidate'
loop
  execute format('alter table public.work_events drop constraint %I', r.conname);
end loop;
alter table public.work_events add constraint work_events_kind_check
  check (kind in ('queued','claim','offer','offer_withdrawn','accept','decline',
                  'offer_expired','auto_offer','release','reassigned','legacy',
                  'no_candidate','assign'));

-- ── 2. The rule: builds have no queue, no claims and no offers ───────────────
create or replace function public.tg_tickets_work_zz_direct()
returns trigger language plpgsql security definer set search_path = public as $f$
begin
  if coalesce(current_setting('neo.migrating', true), '') = '1' then return new; end if;
  new.queued_at := null;
  if new.offered_to_email is not null
     and (tg_op = 'INSERT'
          or new.offered_to_email is distinct from old.offered_to_email
          or new.offer_expires_at is distinct from old.offer_expires_at) then
    raise exception 'NEO_GATE: Builds aren''t offered any more: the Builds desk assigns them. Update Neo OS to 1.12.3 and use Assign in the build.';
  end if;
  if new.assigned_via = 'claim'
     and (tg_op = 'INSERT'
          or old.assigned_via is distinct from 'claim'
          or new.technician_email is distinct from old.technician_email) then
    raise exception 'NEO_GATE: Builds aren''t claimed any more: the Builds desk assigns them.';
  end if;
  return new;
end $f$;

drop trigger if exists trg_tickets_work_zz_direct on public.tickets;
create trigger trg_tickets_work_zz_direct before insert or update on public.tickets
  for each row execute function public.tg_tickets_work_zz_direct();

-- ── 3. build_queue_send: there is no queue to send to ────────────────────────
create or replace function public.build_queue_send(p_ticket_id text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $f$
declare
  v_me public.profiles := public._neo_me();
begin
  if not public.has_module('qc', 'desk') then
    raise exception 'NEO_DENIED: Only the builds team can send a build to the floor.';
  end if;
  return jsonb_build_object('ok', false, 'reason', 'no_queue',
    'message', 'Builds don''t go to a queue any more: the Builds desk assigns a technician in the build. Update Neo OS to 1.12.3 to do that.');
end $f$;

-- ── 4. build_tech_list: who the desk can give a build to ─────────────────────
-- The build pool (and anyone still holding builds), with their load. The same
-- keys as work_team()'s people, so the desktop's eligibility check is shared.
create or replace function public.build_tech_list()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $f$
declare
  v_me public.profiles := public._neo_me();
begin
  -- The desk role itself or a lead: a technician outranks the desk in
  -- role_rank, but must not hand builds to themselves (that is a claim).
  if coalesce(public.module_role('qc'), '') not in ('desk', 'lead') then
    raise exception 'NEO_DENIED: Only the Builds desk can assign builds.';
  end if;
  return jsonb_build_object('now', now(), 'people', coalesce((
    select jsonb_agg(jsonb_build_object(
             'email', x.email, 'name', x.full_name, 'designation', x.designation, 'tier', x.tier,
             'build_pool', x.build_pool, 'build_level', x.build_level,
             'capacity_points', x.capacity_points, 'max_jobs', x.max_jobs, 'points', x.points, 'jobs', x.jobs,
             'qc_role', public._module_role_of(x.id, 'qc'),
             'builds', (select count(*) from public.tickets t
                         where lower(t.technician_email) = lower(x.email) and t.status is distinct from 'completed'))
           order by x.full_name, x.email)
      from (select p.id, p.email, p.full_name, p.designation, p.tier,
                   w.build_pool, w.build_level, w.capacity_points, w.max_jobs, l.points, l.jobs
              from public.profiles p
              cross join lateral public._work_settings(p.id) w
              cross join lateral public._work_load(p.email) l
             where p.active and coalesce(p.is_staff, false)
               and (w.build_pool or exists (select 1 from public.tickets t
                                             where lower(t.technician_email) = lower(p.email)
                                               and t.status is distinct from 'completed'))) x), '[]'::jsonb));
end $f$;

-- ── 5. build_assign: the desk gives a build to a technician ──────────────────
-- p_expected: the technician email the caller saw ('' or null = nobody), so a
-- change made meanwhile on another PC is never overwritten (as work_offer).
-- {ok:true, item} | {ok:true, unchanged:true, item} | {ok:false, reason:'changed', by, by_email, at}
create or replace function public.build_assign(
  p_ticket_id text, p_email text, p_reason text default null, p_expected text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $f$
declare
  v_me public.profiles := public._neo_me();
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_expected text := nullif(lower(btrim(coalesce(p_expected, ''))), '');
  v_target public.profiles;
  t public.tickets;
  v_cur text; v_cur_name text; v_cur_at timestamptz;
  v_why text; v_txt text; v_prev text; v_moving boolean;
begin
  -- The desk role itself or a lead: a technician outranks the desk in
  -- role_rank, but must not hand builds to themselves (that is a claim).
  if coalesce(public.module_role('qc'), '') not in ('desk', 'lead') then
    raise exception 'NEO_DENIED: Only the Builds desk can assign builds.';
  end if;
  if v_email is null then raise exception 'NEO_GATE: Choose who builds it.'; end if;
  if v_reason is not null and length(v_reason) > 300 then
    raise exception 'NEO_GATE: The reason is too long — keep it under 300 characters.';
  end if;

  -- The person first, then the build: the same order as a deactivation.
  perform 1 from public.profiles where lower(email) = v_email for share;
  select * into t from public.tickets where id = p_ticket_id for update;
  if not found then raise exception 'NEO_GATE: That build no longer exists.'; end if;
  if t.status = 'completed' then raise exception 'NEO_GATE: This build is finished.'; end if;

  v_cur := lower(t.technician_email);
  v_cur_name := nullif(btrim(coalesce(t.technician, '')), '');
  v_cur_at := coalesce(t.assigned_at, t.updated_at);
  if v_cur is distinct from v_expected then
    return jsonb_build_object('ok', false, 'reason', 'changed', 'by', v_cur_name, 'by_email', v_cur, 'at', v_cur_at);
  end if;

  v_target := public._staff_by_email(v_email);
  if v_target.id is null then raise exception 'NEO_GATE: No active staff account with that email.'; end if;
  if v_cur = lower(v_target.email) then
    return jsonb_build_object('ok', true, 'unchanged', true, 'item', public._work_item('build', p_ticket_id, v_me));
  end if;
  v_why := public._work_why_not('build', public._build_tier(t.specs), v_target.id);
  if v_why is not null then
    v_txt := public._work_why_text('build', v_why, false);
    raise exception 'NEO_GATE: % can''t take this — %', coalesce(v_target.full_name, v_target.email),
      lower(left(v_txt, 1)) || substr(v_txt, 2);
  end if;
  v_moving := v_cur is not null or v_cur_name is not null;
  if v_moving and v_reason is null then
    raise exception 'NEO_GATE: Say why you''re moving it from %.', coalesce(v_cur_name, v_cur);
  end if;

  v_prev := public._flag_set('neo.assign');
  update public.tickets
     set technician = public._first_name(v_target.full_name), technician_email = lower(v_target.email),
         assigned_via = 'manager', assigned_at = now(), assign_reason = v_reason, queued_at = null,
         offered_to_email = null, offered_to_name = null, offer_kind = null, offer_by_email = null,
         offer_by_name = null, offer_reason = null, offered_at = null, offer_expires_at = null,
         auto_tried_at = null, declined_emails = '{}',
         updated_at = greatest(now(), coalesce(updated_at, now()) + interval '1 millisecond')
   where id = p_ticket_id;
  perform public._flag_restore('neo.assign', v_prev);

  if v_moving then
    perform public._work_event('build', p_ticket_id, 'reassigned',
      'Moved from ' || coalesce(v_cur_name, v_cur) || ' to ' || v_target.full_name || ' by ' || v_me.full_name || ': ' || v_reason,
      v_me.email, v_me.full_name, v_target.email, v_target.full_name,
      jsonb_build_object('from_email', v_cur, 'from_name', v_cur_name, 'reason', v_reason, 'direct', true));
  else
    perform public._work_event('build', p_ticket_id, 'assign',
      'Assigned to ' || v_target.full_name || ' by ' || v_me.full_name || coalesce(': ' || v_reason, '.'),
      v_me.email, v_me.full_name, v_target.email, v_target.full_name,
      jsonb_build_object('reason', v_reason));
  end if;
  perform public._work_alerts_resolve('build', p_ticket_id, v_me.email);
  return jsonb_build_object('ok', true, 'item', public._work_item('build', p_ticket_id, v_me));
end $f$;

-- ── 6. Grants (the internals are locked by _work_lockdown) ───────────────────
revoke all on function public.build_tech_list() from public, anon, authenticated;
revoke all on function public.build_assign(text, text, text, text) from public, anon, authenticated;
grant execute on function public.build_tech_list() to authenticated, service_role;
grant execute on function public.build_assign(text, text, text, text) to authenticated, service_role;

-- ── 7. Today's builds come out of the queue ──────────────────────────────────
-- Any build still waiting or offered: no queue, no offer, alerts settled, and
-- a line in its history. (The trigger above already clears queued_at on any
-- write; this makes it so for rows nobody touches.)
for r in
    select t.id from public.tickets t
     where t.queued_at is not null or t.offered_to_email is not null
     order by t.id
       for update
  loop
    v_prev := public._flag_set('neo.assign');
    update public.tickets
       set queued_at = null, auto_tried_at = null, declined_emails = '{}',
           offered_to_email = null, offered_to_name = null, offer_kind = null, offer_by_email = null,
           offer_by_name = null, offer_reason = null, offered_at = null, offer_expires_at = null,
           updated_at = greatest(now(), coalesce(updated_at, now()) + interval '1 millisecond')
     where id = r.id;
    perform public._flag_restore('neo.assign', v_prev);
    perform public._work_event('build', r.id, 'release',
      'Taken out of the build queue: the Builds desk now assigns builds directly.',
      null, 'Neo OS', null, null, jsonb_build_object('reason', 'build_direct_assign'));
    perform public._work_alerts_resolve('build', r.id, 'Neo OS');
  end loop;
  -- Open build alerts with nothing left to act on.
  update public.work_alerts set resolved_at = now(), resolved_by = 'Neo OS'
   where item_kind = 'build' and resolved_at is null;

perform public._work_lockdown();
end $bd$;

-- =============================================================================
-- End of build_direct_assign_part01. Run sql/build-direct-assign.tests.sql next
-- (it rolls back).
-- =============================================================================
