-- ════════════════════════════════════════════════════════════════════════════
--  Neo OS 1.12.5 — manual assigning restored (request 2026-11-16).
--  Runs after sql/service-direct-assign.sql.
--
--  As before the 1.11 work queue, whoever works on a build or a service ticket
--  can pick its technician from a dropdown:
--  * build_assign: anyone with a Builds role (desk, tech or lead) assigns, not
--    only the desk or a lead. Any active technician with the Builds tech role
--    can be chosen: the build-pool and senior-only (tier 4-5) gates are gone.
--    A reason is optional, also when moving a build.
--  * service_assign: the Service tech role assigns too; a reason is optional.
--
--  Each function is patched in place from its live definition, and the block
--  fails (changing nothing) if any expected text is missing.
-- ════════════════════════════════════════════════════════════════════════════
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.build_assign(text,text,text,text)'::regprocedure);
  n := replace(d, $r$not in ('desk', 'lead') then$r$, $r$not in ('desk', 'tech', 'lead') then$r$);
  n := replace(n, $r$if v_why is not null then$r$, $r$if v_why is not null and v_why not in ('no_pool', 'senior') then$r$);
  n := replace(n, $r$  if v_moving and v_reason is null then
    raise exception 'NEO_GATE: Say why you''re moving it from %.', coalesce(v_cur_name, v_cur);
  end if;
$r$, '');
  n := replace(n, $r$' by ' || v_me.full_name || ': ' || v_reason,$r$, $r$' by ' || v_me.full_name || coalesce(': ' || v_reason, '.'),$r$);
  if strpos(n, $r$'desk', 'tech', 'lead'$r$) = 0 or strpos(n, $r$not in ('no_pool', 'senior')$r$) = 0
     or strpos(n, 'Say why you''re moving it') > 0 or strpos(n, $r$v_me.full_name || ': ' || v_reason$r$) > 0 then
    raise exception 'build_assign: a replacement did not apply';
  end if;
  execute n;

  d := pg_get_functiondef('public.service_assign(text,text,text,text)'::regprocedure);
  n := replace(d, $r$not in ('desk', 'lead') then$r$, $r$not in ('desk', 'tech', 'lead') then$r$);
  n := replace(n, $r$  if v_job.assignee_email is not null and v_reason is null then
    raise exception 'NEO_GATE: Say why you''re moving it.';
  end if;
$r$, '');
  if strpos(n, $r$'desk', 'tech', 'lead'$r$) = 0 or strpos(n, 'Say why you''re moving it') > 0 then
    raise exception 'service_assign: a replacement did not apply';
  end if;
  execute n;
end $m$;

-- Rollback: re-run sql/build-direct-assign.sql (build_assign) and
-- sql/service-direct-assign.sql (service_assign).
