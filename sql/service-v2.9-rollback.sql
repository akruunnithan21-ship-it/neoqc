-- ════════════════════════════════════════════════════════════════════════════
--  Rollback of sql/service-v2.9.sql (Neo OS 1.13: handover and payments).
--  Refuses while any payment is stored or any ticket has a bill: those are
--  money records. Export them first if they really have to go.
--  Apps on 1.13 must go back too, or "Hand over" fails.
-- ════════════════════════════════════════════════════════════════════════════
begin;

do $m$
begin
  if to_regclass('public.service_payments') is not null and exists (select 1 from public.service_payments) then
    raise exception 'service_payments holds payments. Export them before removing the table.';
  end if;
  if exists (select 1 from public.service_jobs where bill_total is not null or collected_by_name is not null) then
    raise exception 'Some tickets have a bill or a collector recorded. Export them before removing the columns.';
  end if;
end $m$;

drop function if exists public.service_handover(text, text, text, numeric, jsonb, text, text, text, text);
drop table if exists public.service_payments;
alter table public.service_jobs drop constraint if exists service_jobs_collected_by_check;
alter table public.service_jobs drop constraint if exists service_jobs_bill_total_check;
alter table public.service_jobs drop column if exists collected_by_phone;
alter table public.service_jobs drop column if exists collected_by_name;
alter table public.service_jobs drop column if exists bill_total;

commit;
