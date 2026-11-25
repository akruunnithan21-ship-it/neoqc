-- ════════════════════════════════════════════════════════════════════════════
--  Undo server v2.14 (sql/service-v2.14.sql): drops the serial lookup and the
--  customer history functions. They only read, so nothing else changes.
-- ════════════════════════════════════════════════════════════════════════════
begin;
drop function if exists public.serial_history(text);
drop function if exists public.customer_history(text);
commit;
