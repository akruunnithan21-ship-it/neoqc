-- =============================================================================
-- NEO TOKYO OPERATIONS — Route point retention (OPTIONAL)    Target: Supabase
-- -----------------------------------------------------------------------------
-- Runs public._hr_purge() every day at 03:30 India time (22:00 UTC) with
-- pg_cron: route points older than hr_settings.retention_days (90 by default)
-- are deleted after each of their days got its final km row (hr_day_km), and
-- punch coordinates that old are cleared.
-- NOT required: without it retention still holds — location_push runs the
-- same purge (5000 points at a time) when the last one is more than 6 hours
-- old (hr_settings.last_purge_at).
--
-- Apply AFTER sql/neohr-hr.sql, as a separate step, only if pg_cron may be
-- enabled on the project (Database → Extensions; it needs the owner's OK).
-- Re-runnable: an existing 'neo-hr-retention' job is removed, then scheduled
-- again. pg_cron runs it as the job owner with no JWT; _hr_purge needs none.
--
-- To stop it:  select cron.unschedule(jobid) from cron.job where jobname = 'neo-hr-retention';
-- =============================================================================

create extension if not exists pg_cron;

-- cron.unschedule('name') raises when there is no such job, so go by jobid.
select cron.unschedule(jobid) from cron.job where jobname = 'neo-hr-retention';

select cron.schedule('neo-hr-retention', '0 22 * * *', $c$select public._hr_purge()$c$);
-- 22:00 UTC = 03:30 IST
