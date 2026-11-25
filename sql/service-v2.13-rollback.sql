-- ════════════════════════════════════════════════════════════════════════════
--  Undo server v2.13 (sql/service-v2.13.sql): QC after a service. Drops the
--  four RPCs, the helpers and the service_qc table (its rows are lost). The
--  'qc' lines already written to tickets' history stay; they read as notes.
-- ════════════════════════════════════════════════════════════════════════════
begin;
drop function if exists public.service_qc_finish(bigint, boolean, jsonb, text);
drop function if exists public.service_qc_start(bigint);
drop function if exists public.service_qc_cancel(bigint, text);
drop function if exists public.service_qc_send(text, jsonb, text, numeric, integer, text);
drop function if exists public._service_qc_goal_words(jsonb);
drop function if exists public._service_qc_goals(jsonb);
drop table if exists public.service_qc;
commit;
