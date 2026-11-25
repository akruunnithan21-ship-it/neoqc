-- ════════════════════════════════════════════════════════════════════════════
--  Neo Service 1.16 — server v2.13: QC after a service (owner's brief §10, 24
--  Nov 2026; decisions 25 Nov 2026, docs/redesign-2026-11/QC-SERVICE.md).
--
--  When a repaired PC is at Testing and the customer asks for it, the desk
--  sends the ticket to QC, the way a part goes to RMA: one service_qc row,
--  linked to the ticket. It holds:
--    goals      the customer's own goals, e.g. a game at their settings with a
--               target average FPS, or "this file renders without crashing";
--               zero goals means health + stability only
--    charge     paid or free, decided per ticket by the desk (amount if paid)
--    stability  15 minutes by default; 30 or 60 when the fault was crashes
--    results    what the bench PC measured (Testing Client, next round)
--  No serial numbers and no gates: it is the customer's PC, not a new build.
--
--  Writers are RPCs only:
--    service_qc_send    service desk, ticket at Testing, none open already
--    service_qc_cancel  service desk or QC desk
--    service_qc_start   QC desk (the tester at the bench)
--    service_qc_finish  QC desk: passed or failed, the results, and one line
--                       the customer reads on their tracking page
--  Every step writes a 'qc' line to the ticket's history.
--
--  Additive: a new table and four new functions. After it:
--  sql/service-v2.13-rollback.sql undoes it.
-- ════════════════════════════════════════════════════════════════════════════
begin;

create table if not exists public.service_qc (
  id                bigserial primary key,
  job_id            text not null references public.service_jobs(id) on delete cascade,
  status            text not null default 'queued'
                    check (status in ('queued', 'testing', 'passed', 'failed', 'cancelled')),
  goals             jsonb not null default '[]'::jsonb check (jsonb_typeof(goals) = 'array'),
  customer_words    text check (length(coalesce(customer_words, '')) <= 1000),
  charge            text not null default 'free' check (charge in ('paid', 'free')),
  amount            numeric check (amount is null or (amount > 0 and amount <= 1000000)),
  stability_minutes integer not null default 15 check (stability_minutes in (15, 30, 60)),
  results           jsonb not null default '{}'::jsonb check (jsonb_typeof(results) = 'object'),
  summary           text check (length(coalesce(summary, '')) <= 1000),
  requested_by      text,
  requested_by_name text,
  requested_at      timestamptz not null default now(),
  tested_by         text,
  tested_by_name    text,
  started_at        timestamptz,
  finished_at       timestamptz,
  cancel_reason     text check (length(coalesce(cancel_reason, '')) <= 500),
  updated_at        timestamptz not null default now()
);
-- One open QC per ticket.
create unique index if not exists service_qc_one_open on public.service_qc (job_id)
  where status in ('queued', 'testing');
create index if not exists service_qc_job_idx on public.service_qc (job_id);
create index if not exists service_qc_status_idx on public.service_qc (status, requested_at desc);

alter table public.service_qc enable row level security;
drop policy if exists sq_select on public.service_qc;
create policy sq_select on public.service_qc for select to authenticated
  using ((select public.svc_reader()) or (select public.has_module('qc', 'desk')));
revoke all on table public.service_qc from anon, authenticated;
grant select on table public.service_qc to authenticated;
revoke all on sequence public.service_qc_id_seq from anon, authenticated;

-- The goals, checked: up to 6, each a game (name, settings, target FPS) or a
-- piece of work (app, task, optional minutes). Returns the cleaned array.
create or replace function public._service_qc_goals(p jsonb)
returns jsonb
language plpgsql immutable
set search_path = public
as $$
declare
g jsonb;
out jsonb := '[]'::jsonb;
v_kind text;
v_fps numeric;
v_min numeric;
begin
if p is null or jsonb_typeof(p) = 'null' then return out; end if;
if jsonb_typeof(p) <> 'array' then raise exception 'NEO_GATE: The goals have the wrong shape.'; end if;
if jsonb_array_length(p) > 6 then raise exception 'NEO_GATE: Up to 6 goals.'; end if;
for g in select value from jsonb_array_elements(p) loop
if jsonb_typeof(g) <> 'object' then raise exception 'NEO_GATE: A goal has the wrong shape.'; end if;
v_kind := g ->> 'kind';
if v_kind = 'game' then
if nullif(btrim(coalesce(g ->> 'name', '')), '') is null then raise exception 'NEO_GATE: Name the game.'; end if;
v_fps := nullif(g ->> 'target_fps', '')::numeric;
if v_fps is null or v_fps < 1 or v_fps > 2000 then raise exception 'NEO_GATE: Give the target average FPS for %.', g ->> 'name'; end if;
out := out || jsonb_build_array(jsonb_build_object(
'kind', 'game',
'name', left(btrim(g ->> 'name'), 80),
'settings', left(btrim(coalesce(g ->> 'settings', '')), 120),
'target_fps', round(v_fps)));
elsif v_kind = 'work' then
if nullif(btrim(coalesce(g ->> 'app', '')), '') is null then raise exception 'NEO_GATE: Name the app for the work goal.'; end if;
if nullif(btrim(coalesce(g ->> 'task', '')), '') is null then raise exception 'NEO_GATE: Say what has to work in %.', g ->> 'app'; end if;
v_min := nullif(g ->> 'max_minutes', '')::numeric;
if v_min is not null and (v_min < 1 or v_min > 600) then raise exception 'NEO_GATE: The time target should be 1 to 600 minutes.'; end if;
out := out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
'kind', 'work',
'app', left(btrim(g ->> 'app'), 80),
'task', left(btrim(g ->> 'task'), 200),
'max_minutes', round(v_min))));
else
raise exception 'NEO_GATE: A goal is a game or a piece of work.';
end if;
end loop;
return out;
end $$;
revoke all on function public._service_qc_goals(jsonb) from public, anon, authenticated;

-- What the customer reads when a goal list is sent: "Valorant (1080p low, 450 fps)".
create or replace function public._service_qc_goal_words(p jsonb)
returns text
language sql immutable
set search_path = public
as $$
select coalesce(string_agg(case g ->> 'kind'
when 'game' then (g ->> 'name') || ' at ' || (g ->> 'target_fps') || ' fps'
|| coalesce(nullif(' (' || coalesce(g ->> 'settings', '') || ')', ' ()'), '')
else (g ->> 'app') || ': ' || (g ->> 'task') end, '; '), '')
from jsonb_array_elements(coalesce(p, '[]'::jsonb)) g
$$;
revoke all on function public._service_qc_goal_words(jsonb) from public, anon, authenticated;

create or replace function public.service_qc_send(p_job_id text, p_goals jsonb default '[]'::jsonb,
                                                  p_charge text default 'free', p_amount numeric default null,
                                                  p_minutes integer default 15, p_words text default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
v_me public.profiles := public._neo_me();
v_job public.service_jobs;
v_goals jsonb;
v_words text := nullif(btrim(coalesce(p_words, '')), '');
v_row public.service_qc;
v_said text;
begin
if not public.has_module('service', 'desk') then
raise exception 'NEO_DENIED: You don''t have access to change service tickets.';
end if;
select * into v_job from public.service_jobs where id = p_job_id for update;
if not found then raise exception 'NEO_GATE: That ticket no longer exists.'; end if;
if v_job.stage <> 'verifying' then
raise exception 'NEO_GATE: QC comes after the repair: move the ticket to Testing first.';
end if;
if exists (select 1 from public.service_qc q where q.job_id = p_job_id and q.status in ('queued', 'testing')) then
raise exception 'NEO_STALE: This ticket is already in QC.';
end if;
v_goals := public._service_qc_goals(p_goals);
if p_charge is null or p_charge not in ('paid', 'free') then
raise exception 'NEO_GATE: Say whether the QC test is paid or free.';
end if;
if p_charge = 'paid' and (p_amount is null or p_amount <= 0) then
raise exception 'NEO_GATE: Enter what the QC test costs.';
end if;
if coalesce(p_minutes, 15) not in (15, 30, 60) then
raise exception 'NEO_GATE: The stability test runs 15, 30 or 60 minutes.';
end if;
if v_words is not null and length(v_words) > 1000 then
raise exception 'NEO_GATE: The customer''s words are too long — keep them under 1000 characters.';
end if;
insert into public.service_qc (job_id, goals, customer_words, charge, amount, stability_minutes,
requested_by, requested_by_name)
values (p_job_id, v_goals, v_words, p_charge, case when p_charge = 'paid' then p_amount end, coalesce(p_minutes, 15),
v_me.email, v_me.full_name)
returning * into v_row;
v_said := public._service_qc_goal_words(v_goals);
perform public._svc_ev(p_job_id, 'qc',
'Your PC is going through our QC test' || case when v_said <> '' then ': ' || v_said else '' end || '.',
true, null, null, jsonb_build_object('qc_id', v_row.id, 'qc', 'sent'), 'staff', v_me.email, v_me.full_name);
return to_jsonb(v_row);
end $$;
revoke all on function public.service_qc_send(text, jsonb, text, numeric, integer, text) from public, anon;
grant execute on function public.service_qc_send(text, jsonb, text, numeric, integer, text) to authenticated;

create or replace function public.service_qc_cancel(p_id bigint, p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
v_me public.profiles := public._neo_me();
v_row public.service_qc;
v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
if not (public.has_module('service', 'desk') or public.has_module('qc', 'desk')) then
raise exception 'NEO_DENIED: You don''t have access to QC.';
end if;
select * into v_row from public.service_qc where id = p_id for update;
if not found then raise exception 'NEO_GATE: That QC job no longer exists.'; end if;
if v_row.status not in ('queued', 'testing') then
raise exception 'NEO_STALE: This QC job has already finished.';
end if;
if v_reason is not null and length(v_reason) > 500 then raise exception 'NEO_GATE: Keep the reason under 500 characters.'; end if;
update public.service_qc set status = 'cancelled', cancel_reason = v_reason, finished_at = now(), updated_at = now()
where id = p_id returning * into v_row;
perform public._svc_ev(v_row.job_id, 'qc', 'QC test cancelled' || coalesce(': ' || v_reason, '') || '.',
false, null, null, jsonb_build_object('qc_id', v_row.id, 'qc', 'cancelled'), 'staff', v_me.email, v_me.full_name);
return to_jsonb(v_row);
end $$;
revoke all on function public.service_qc_cancel(bigint, text) from public, anon;
grant execute on function public.service_qc_cancel(bigint, text) to authenticated;

create or replace function public.service_qc_start(p_id bigint)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
v_me public.profiles := public._neo_me();
v_row public.service_qc;
begin
if not public.has_module('qc', 'desk') then
raise exception 'NEO_DENIED: You don''t have access to QC.';
end if;
select * into v_row from public.service_qc where id = p_id for update;
if not found then raise exception 'NEO_GATE: That QC job no longer exists.'; end if;
if v_row.status = 'testing' then return to_jsonb(v_row); end if;
if v_row.status <> 'queued' then raise exception 'NEO_STALE: This QC job has already finished.'; end if;
update public.service_qc set status = 'testing', tested_by = v_me.email, tested_by_name = v_me.full_name,
started_at = now(), updated_at = now()
where id = p_id returning * into v_row;
perform public._svc_ev(v_row.job_id, 'qc', 'QC test started.', false, null, null,
jsonb_build_object('qc_id', v_row.id, 'qc', 'started'), 'staff', v_me.email, v_me.full_name);
return to_jsonb(v_row);
end $$;
revoke all on function public.service_qc_start(bigint) from public, anon;
grant execute on function public.service_qc_start(bigint) to authenticated;

create or replace function public.service_qc_finish(p_id bigint, p_passed boolean, p_results jsonb default '{}'::jsonb,
                                                    p_summary text default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
v_me public.profiles := public._neo_me();
v_row public.service_qc;
v_summary text := nullif(btrim(coalesce(p_summary, '')), '');
begin
if not public.has_module('qc', 'desk') then
raise exception 'NEO_DENIED: You don''t have access to QC.';
end if;
if p_passed is null then raise exception 'NEO_GATE: Say whether the QC test passed.'; end if;
if p_results is null or jsonb_typeof(p_results) <> 'object' then raise exception 'NEO_GATE: The results have the wrong shape.'; end if;
if length(p_results::text) > 65536 then raise exception 'NEO_GATE: The results are too large.'; end if;
if v_summary is null then raise exception 'NEO_GATE: Write the one line the customer reads.'; end if;
if length(v_summary) > 1000 then raise exception 'NEO_GATE: Keep the summary under 1000 characters.'; end if;
select * into v_row from public.service_qc where id = p_id for update;
if not found then raise exception 'NEO_GATE: That QC job no longer exists.'; end if;
if v_row.status not in ('queued', 'testing') then raise exception 'NEO_STALE: This QC job has already finished.'; end if;
update public.service_qc
set status = case when p_passed then 'passed' else 'failed' end,
results = p_results, summary = v_summary,
tested_by = coalesce(tested_by, v_me.email), tested_by_name = coalesce(tested_by_name, v_me.full_name),
started_at = coalesce(started_at, now()), finished_at = now(), updated_at = now()
where id = p_id returning * into v_row;
perform public._svc_ev(v_row.job_id, 'qc', v_summary, true, null, null,
jsonb_build_object('qc_id', v_row.id, 'qc', case when p_passed then 'passed' else 'failed' end),
'staff', v_me.email, v_me.full_name);
return to_jsonb(v_row);
end $$;
revoke all on function public.service_qc_finish(bigint, boolean, jsonb, text) from public, anon;
grant execute on function public.service_qc_finish(bigint, boolean, jsonb, text) to authenticated;

commit;
