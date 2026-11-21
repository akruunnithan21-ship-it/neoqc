-- ════════════════════════════════════════════════════════════════════════════
--  Rollback of sql/service-v2.6.sql (Neo OS 1.13: the "Other" category).
--  Refuses while any ticket is still in the Other category: give those
--  tickets a listed category first, or their typed names would be lost.
--  Apps on 1.13 must go back too, or their "New category" intakes fail.
--  The two functions are put back exactly as they were read on 2026-11-21.
-- ════════════════════════════════════════════════════════════════════════════
begin;

do $m$
declare d text; n text;
begin
  if exists (select 1 from public.service_jobs where category = 'other') then
    raise exception 'Some tickets are still in the Other category. Give them a listed category first.';
  end if;

  d := pg_get_functiondef('public._svc_create(jsonb,profiles)'::regprocedure);
  n := replace(d, $r$v_type text; v_channel text; v_category text; v_cat_other text;$r$,
                  $r$v_type text; v_channel text; v_category text;$r$);
  n := replace(n, $r$
  v_cat_other := case when v_category = 'other' then public._jtxt(p, 'category_other', 60, 'The category name') end;$r$, '');
  n := replace(n, $r$client_request_id, category_other)$r$, $r$client_request_id)$r$);
  n := replace(n, $r$v_est, v_crid, v_cat_other);$r$, $r$v_est, v_crid);$r$);
  if strpos(n, 'category_other') > 0 or strpos(n, 'v_cat_other') > 0 then
    raise exception '_svc_create: a replacement did not apply';
  end if;
  execute n;
end $m$;

create or replace function public._svc_category_label(p text)
returns text
language sql immutable
set search_path to 'public'
as $function$
select case p
when 'repair'         then 'Repair'
when 'warranty_claim' then 'Warranty claim'
when 'upgrade'        then 'Upgrade'
when 'installation'   then 'Installation'
when 'data_recovery'  then 'Data recovery'
when 'os_software'    then 'OS / software'
when 'networking'     then 'Networking'
when 'maintenance'    then 'Maintenance'
when 'diagnosis_only' then 'Diagnosis only'
else coalesce(p, 'Service')
end
$function$;

do $v$
declare d text;
begin
  d := pg_get_functiondef('public._vocab_list(text)'::regprocedure);
  if strpos(d, $r$'diagnosis_only','other']$r$) = 0 then
    raise exception '_vocab_list: not the 1.13 definition';
  end if;
  execute replace(d, $r$'diagnosis_only','other']$r$, $r$'diagnosis_only']$r$);
end $v$;

alter table public.service_jobs drop constraint if exists service_jobs_category_check;
alter table public.service_jobs add constraint service_jobs_category_check
  check (category in ('repair','warranty_claim','upgrade','installation','data_recovery','os_software',
                      'networking','maintenance','diagnosis_only'));
alter table public.service_jobs drop constraint if exists service_jobs_category_other_check;
alter table public.service_jobs drop column if exists category_other;

commit;
