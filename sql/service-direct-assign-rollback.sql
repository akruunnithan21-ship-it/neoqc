-- Rollback for sql/service-direct-assign.sql (Neo OS 1.12.5): service tickets
-- go back to the work queue (claims, offers, automatic offers).
--
-- 1. This file: drops the no-claim/no-offer trigger and puts the pg_cron job
--    back.
-- 2. Then re-run, from sql/work-queue.sql, the work_tick() definition, and from
--    sql/service-v2.sql, the service_assign() definition (lead only, reason
--    always required, on-site wait). Both files are idempotent per function.
-- 3. Run sql/build-direct-assign.sql again afterwards if work-queue.sql was
--    re-run whole (see docs/MIGRATIONS.md, 1.12.3).

drop trigger if exists trg_service_jobs_zz_direct on public.service_jobs;
drop function if exists public.tg_service_jobs_zz_direct();

do $c$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and not exists (select 1 from cron.job where jobname = 'neo-work-tick') then
    perform cron.schedule('neo-work-tick', '* * * * *', 'select public.work_tick()');
  end if;
end $c$;
