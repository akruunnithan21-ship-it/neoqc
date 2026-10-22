-- =============================================================================
-- NEO TOKYO OPERATIONS — Work queue clock (OPTIONAL)        Target: Supabase
-- -----------------------------------------------------------------------------
-- Runs public.work_tick() every minute on the server with pg_cron, so offers
-- expire and overdue items are offered even when no Neo OS desktop is open.
-- NOT required: without it the apps drive the clock (every desktop calls
-- work_tick() each minute, phones on refresh) — the queue works either way.
--
-- Apply AFTER sql/work-queue.sql, as a separate step, only if pg_cron may be
-- enabled on the project (Database → Extensions; it needs the owner's OK).
-- Re-runnable: an existing 'neo-work-tick' job is removed, then scheduled again.
-- work_tick() takes an advisory lock, so a cron run and a desktop's call at the
-- same moment never both act (the second answers {ok: true, skipped: true}).
-- pg_cron runs it with no JWT, so it skips the staff check (auth.uid() is null).
--
-- To stop it:  select cron.unschedule(jobid) from cron.job where jobname = 'neo-work-tick';
-- =============================================================================

create extension if not exists pg_cron;

-- cron.unschedule('name') raises when there is no such job, so go by jobid.
select cron.unschedule(jobid) from cron.job where jobname = 'neo-work-tick';

select cron.schedule('neo-work-tick', '* * * * *', $c$select public.work_tick()$c$);
