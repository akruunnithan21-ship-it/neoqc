-- ════════════════════════════════════════════════════════════════════════════
--  Neo OS 1.13 — server v2.7: the tracking page shows the estimate (owner's
--  request, 2026-11-21: "WhatsApp and tracking page").
--
--  get_service_public returns est_minutes as well — the estimate the counter
--  saw when the ticket was made (the longest of the picked problems' times,
--  or the desk's own estimate for a problem not in the list). Nothing else in
--  the answer changes, so a page that does not read it is unaffected.
--
--  Written out in full: the live definition read on 2026-11-21 plus one line.
--  The block refuses to run if the live function has changed since (md5 of
--  pg_get_functiondef), and then changes nothing.
--  After it: sql/service-v2.7-rollback.sql undoes it.
-- ════════════════════════════════════════════════════════════════════════════
begin;

do $g$
begin
  if md5(pg_get_functiondef('public.get_service_public(text,text)'::regprocedure)) <> 'b00b2d442c4fc5ce0855b653d8b49529' then
    raise exception 'get_service_public changed since 2026-11-21: re-read it and update this file';
  end if;
end $g$;

create or replace function public.get_service_public(code text, phone4 text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $$
declare
v_code text := upper(btrim(coalesce($1, '')));
v_p4 text := btrim(coalesce($2, ''));
v_job public.service_jobs;
begin
if v_code = '' or v_p4 !~ '^[0-9]{4}$' then return null; end if;
select * into v_job from public.service_jobs sj
where sj.public_code = v_code
and right(regexp_replace(coalesce(sj.customer_phone, ''), '[^0-9]', '', 'g'), 4) = v_p4;
if not found then return null; end if;
return jsonb_build_object(
'public_code',   v_job.public_code,
'stage',         v_job.stage,
'stage_since',   v_job.stage_since,
'waiting_party', v_job.waiting_party,
'device_label',  v_job.device_label,
'job_kind',      v_job.job_kind,
'customer_name', v_job.customer_name,
'promised_at',   v_job.promised_at,
'outcome',       v_job.outcome,
'handled_by',    nullif(split_part(btrim(coalesce(v_job.assignee, '')), ' ', 1), ''),
'created_at',    v_job.created_at,
'received_at',   v_job.received_at,
'ready_at',      v_job.ready_at,
'closed_at',     v_job.closed_at,
'service_type',  v_job.service_type,
'visit_start',   v_job.visit_start,
'visit_end',     v_job.visit_end,
'est_minutes',   v_job.est_minutes,
'events', coalesce((
select jsonb_agg(jsonb_build_object('at', e.at, 'body', e.body, 'to_stage', e.to_stage) order by e.at desc)
from (select se.at, se.body, se.to_stage from public.service_events se
where se.job_id = v_job.id and se.customer_visible
order by se.at desc limit 100) e), '[]'::jsonb),
'rma_units', coalesce((
select jsonb_agg(jsonb_build_object(
'public_code', rc.public_code,
'label', public._rma_label(rc.kind, rc.brand, rc.model),
'kind', rc.kind,
'stage', rc.stage,
'return_method', rc.return_method,
'disposition', rc.disposition,
'stage_since', rc.stage_since,
'holds_ticket', rc.holds_ticket,
'waiting_party', case when rc.stage = 'with_vendor' then public._rma_party(rc.brand, vd.public_name, vd.kind) end)
order by rc.created_at, rc.intake_seq, rc.id)
from public.rma_cases rc
left join public.rma_vendors vd on vd.id = rc.vendor_id
where rc.service_job_id = v_job.id), '[]'::jsonb));
end $$;

commit;
