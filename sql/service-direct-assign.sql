-- ════════════════════════════════════════════════════════════════════════════
--  Neo OS 1.12.5 — service tickets leave the work queue (owner request
--  2026-11-16). The same move builds made in 1.12.3 (build-direct-assign.sql):
--  nobody claims a service ticket and nothing is offered. The Service desk or a
--  lead assigns each one and it is the technician's at once.
--
--  * trg_service_jobs_zz_direct refuses new service offers and claims on every
--    write path (runs after the zy offer guard: triggers fire by name).
--  * service_assign: the Service desk may assign too (was lead only); a reason
--    is needed only when moving a ticket from someone; the "let technicians
--    claim on-site tickets first" wait is gone (there is no claiming). A
--    technician never assigns (that would be a claim), as with builds.
--  * work_tick() does nothing now and its pg_cron job (neo-work-tick) is
--    removed: it only expired offers and made automatic offers.
--  * Any live service offer is cleared and open service alerts are settled.
--
--  Applied live as migration service_direct_assign.
--  Rollback: sql/service-direct-assign-rollback.sql.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. The rule: service tickets have no claims and no offers ───────────────
create or replace function public.tg_service_jobs_zz_direct()
returns trigger language plpgsql security definer set search_path = public as $f$
begin
  if coalesce(current_setting('neo.migrating', true), '') = '1' then return new; end if;
  if new.offered_to_email is not null
     and (tg_op = 'INSERT'
          or new.offered_to_email is distinct from old.offered_to_email
          or new.offer_expires_at is distinct from old.offer_expires_at) then
    raise exception 'NEO_GATE: Service tickets aren''t offered any more: the Service desk assigns them. Update Neo OS and use Assign.';
  end if;
  if new.assigned_via = 'claim' and new.assignee_email is not null
     and (tg_op = 'INSERT' or new.assignee_email is distinct from old.assignee_email) then
    raise exception 'NEO_GATE: Service tickets aren''t claimed any more: the Service desk assigns them.';
  end if;
  return new;
end $f$;

drop trigger if exists trg_service_jobs_zz_direct on public.service_jobs;
create trigger trg_service_jobs_zz_direct before insert or update on public.service_jobs
  for each row execute function public.tg_service_jobs_zz_direct();
revoke all on function public.tg_service_jobs_zz_direct() from public, anon, authenticated;

-- ── 2. service_assign: the desk assigns, a reason only when moving ──────────
create or replace function public.service_assign(p_job_id text, p_email text, p_reason text, p_expected text default null)
returns jsonb language plpgsql security definer set search_path = public as $f$
declare
  v_me public.profiles := public._neo_me();
  v_job public.service_jobs;
  v_new public.service_jobs;
  v_target public.profiles;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_expected text := nullif(lower(btrim(coalesce(p_expected, ''))), '');
  v_prev text;
begin
  -- The desk role itself or a lead: a technician outranks the desk in
  -- role_rank, but must not hand tickets to themselves (that is a claim).
  if coalesce(public.module_role('service'), '') not in ('desk', 'lead') then
    raise exception 'NEO_DENIED: Only the Service desk or a lead can assign tickets.';
  end if;
  if length(coalesce(v_reason, '')) > 300 then
    raise exception 'NEO_GATE: The reason is too long — keep it under 300 characters.';
  end if;
  select * into v_job from public.service_jobs where id = p_job_id for update;
  if not found then raise exception 'NEO_GATE: That ticket no longer exists.'; end if;
  if v_job.stage = 'closed' then raise exception 'NEO_GATE: This ticket is closed.'; end if;
  if nullif(lower(btrim(coalesce(v_job.assignee_email, ''))), '') is distinct from v_expected then
    return jsonb_build_object('ok', false, 'reason', 'changed', 'by', v_job.assignee,
      'by_email', v_job.assignee_email, 'at', coalesce(v_job.assigned_at, v_job.updated_at));
  end if;
  if v_job.assignee_email is not null and v_reason is null then
    raise exception 'NEO_GATE: Say why you''re moving it.';
  end if;
  v_reason := coalesce(v_reason, 'Assigned by ' || coalesce(v_me.full_name, v_me.email));
  if nullif(btrim(coalesce(p_email, '')), '') is null then
    if v_job.assignee_email is null then
      return jsonb_build_object('ok', true, 'unchanged', true, 'job', to_jsonb(v_job));
    end if;
    return jsonb_build_object('ok', true,
      'job', to_jsonb(public._svc_unassign(v_job, v_me, v_reason, 'manager')));
  end if;
  v_target := public._staff_by_email(p_email);
  if v_target.id is null or public.role_rank(public._module_role_of(v_target.id, 'service')) < 2 then
    raise exception 'NEO_GATE: % can''t take service tickets. Give them the Tech role in Module access first.',
      coalesce(v_target.full_name, btrim(p_email));
  end if;
  if lower(coalesce(v_job.assignee_email, '')) = lower(v_target.email) then
    return jsonb_build_object('ok', true, 'unchanged', true, 'job', to_jsonb(v_job));
  end if;
  v_prev := public._flag_set('neo.assign');
  update public.service_jobs
     set assignee = v_target.full_name, assignee_email = v_target.email, assigned_via = 'manager',
         assigned_at = now(), queued_at = null, assign_reason = v_reason
   where id = p_job_id
   returning * into v_new;
  perform public._flag_restore('neo.assign', v_prev);
  perform public._svc_ev(p_job_id, 'assign',
    'Assigned to ' || v_target.full_name || ' by ' || v_me.full_name
      || case when v_job.assignee_email is not null then ' (was ' || coalesce(v_job.assignee, v_job.assignee_email) || ')' else '' end
      || ': ' || v_reason,
    false, null, null,
    jsonb_build_object('tech_email', v_target.email, 'from_email', v_job.assignee_email,
      'by_email', v_me.email, 'reason', v_reason, 'via', 'manager'),
    'staff', v_me.email, v_me.full_name);
  perform public._work_alerts_resolve('service', p_job_id, v_me.email);
  return jsonb_build_object('ok', true, 'job', to_jsonb(v_new));
end $f$;

-- ── 3. No queue clock: work_tick does nothing, its cron job goes ─────────────
create or replace function public.work_tick()
returns jsonb language plpgsql security definer set search_path = public as $f$
begin
  return jsonb_build_object('ok', true, 'off', true);
end $f$;

do $c$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from cron.job where jobname = 'neo-work-tick') then
    perform cron.unschedule('neo-work-tick');
  end if;
end $c$;

-- ── 4. Settle what the queue left behind ─────────────────────────────────────
do $s$
begin
  perform set_config('neo.migrating', '1', true);
  update public.service_jobs
     set offered_to_email = null, offered_to_name = null, offer_kind = null,
         offer_by_email = null, offer_by_name = null, offer_reason = null,
         offered_at = null, offer_expires_at = null, auto_tried_at = null
   where offered_to_email is not null;
  update public.work_alerts set resolved_at = now(), resolved_by = 'Neo OS'
   where item_kind = 'service' and resolved_at is null;
  perform set_config('neo.migrating', '', true);
end $s$;
