-- ════════════════════════════════════════════════════════════════════════════
--  Rollback of sql/service-v2.8.sql (Neo OS 1.13: itemised quotes).
--  Refuses while any quote is stored: those are records of what customers
--  agreed to. Export them first if the table really has to go.
--  Apps on 1.13 must go back too, or "Send quote" fails.
-- ════════════════════════════════════════════════════════════════════════════
begin;

do $m$
begin
  if to_regclass('public.service_quotes') is not null and exists (select 1 from public.service_quotes) then
    raise exception 'service_quotes holds quotes. Export them before removing the table.';
  end if;
end $m$;

drop function if exists public.service_quote_decide(text, int[], text, text);
drop function if exists public.service_quote_send(text, text, jsonb, text, text, timestamptz);
drop function if exists public._inr(numeric);
drop table if exists public.service_quotes;

commit;
