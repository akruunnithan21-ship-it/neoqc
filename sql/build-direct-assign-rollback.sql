-- =============================================================================
-- Switch builds back to the technician queue — undoes sql/build-direct-assign.sql
-- Migration name: build_direct_assign_rollback        Target: Postgres 17 on Supabase
-- -----------------------------------------------------------------------------
-- Not applied. Run it only on the owner's decision to bring the build queue
-- back, and ship a desktop release with it (Neo OS 1.12.3 calls build_assign
-- and build_tech_list, which this removes; restore the 1.12.2 build buttons).
--
--   * Drops the no-queue trigger, build_assign and build_tech_list.
--   * Puts back the queue's build_queue_send exactly as in sql/work-queue.sql.
--   * Leaves work_events' widened kind check ('assign' rows may exist).
--   * Builds the desk assigned keep their technician (assigned_via 'manager').
--     Builds with nobody stay unassigned: the desk sends them to the queue.
-- Dry-run it again before applying: the live database will have moved on.
-- =============================================================================

set local lock_timeout = '15s';

do $bdr$
begin

drop trigger if exists trg_tickets_work_zz_direct on public.tickets;
drop function if exists public.tg_tickets_work_zz_direct();
drop function if exists public.build_assign(text, text, text, text);
drop function if exists public.build_tech_list();

-- build_queue_send as in sql/work-queue.sql (byte-identical body).
create or replace function public.build_queue_send(p_ticket_id text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $f$
declare
  v_me public.profiles := public._neo_me();
  t public.tickets;
  v_prev text;
begin
  if not public.has_module('qc', 'desk') then
    raise exception 'NEO_DENIED: Only the builds team can send a build to the floor.';
  end if;
  select * into t from public.tickets where id = p_ticket_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if t.status = 'completed' then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  if t.technician_email is not null or btrim(coalesce(t.technician, '')) <> '' then
    return jsonb_build_object('ok', false, 'reason', 'assigned');
  end if;
  if t.queued_at is not null then
    return jsonb_build_object('ok', true, 'already', true, 'item', public._work_item('build', p_ticket_id, v_me));
  end if;
  v_prev := public._flag_set('neo.assign');
  update public.tickets
     set queued_at = now(), updated_at = greatest(now(), coalesce(updated_at, now()) + interval '1 millisecond')
   where id = p_ticket_id;
  perform public._flag_restore('neo.assign', v_prev);
  perform public._work_event('build', p_ticket_id, 'queued', 'Sent to the build queue by ' || v_me.full_name || '.',
                             v_me.email, v_me.full_name, null, null, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'item', public._work_item('build', p_ticket_id, v_me));
end $f$;

perform public._work_lockdown();
end $bdr$;
