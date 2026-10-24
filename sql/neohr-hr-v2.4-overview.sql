-- =============================================================================
-- NEO TOKYO OPERATIONS — the dashboard numbers (HR SQL v2.4, NEOHR-2.3-SPEC §1.7)
-- Migration name: neohr_hr_v2_4_overview      Target: Postgres 17 on Supabase
-- Ships with NeoHR 2.3.0 and Neo OS 1.12.1 (contract version 5).
-- -----------------------------------------------------------------------------
-- DEPLOY ORDER
--   1. sql/service-v2.sql, sql/service-v2.1.sql, sql/work-queue.sql (v2.2),
--      sql/neohr-hr.sql (v2.3)                                     (all live)
--   2. sql/neohr-hr-v2.4.sql                  (attendance v2.4: punches, trips,
--      selfies, _hr_dash_view, _hr_is_field, _hr_lockdown with the new API)
--   3. sql/neohr-hr-v2.4-overview.sql         (this file)
--   Re-apply this file after any re-run of neohr-hr-v2.4.sql (or of the files
--   before it). It is re-runnable on its own and redefines nothing that
--   exists before it: it only creates the functions listed below.
--   Tests: sql/neohr-hr-v2.4-overview.tests.sql (one transaction, ROLLBACK).
--
-- WHAT THIS DOES
--   Two read RPCs for the dashboards (phone and desktop). neo_dashboard is
--   NOT touched (NeoHR 2.1 / 2.2 phones keep reading it).
--   * neo_overview()                        the numbers: one count per tile
--   * neo_overview_list(kind, scope, state) the items behind one tile
--   Both read ONE helper, _hr_ov_items(viewer), so a tile's number is always
--   the length of its list (the tests check every tile).
--
-- THREAT MODEL (as sql/neohr-hr-v2.4.sql): anyone can sign in with the anon
--   key from the APK and an email / PIN and call any RPC with any arguments.
--   So both RPCs work out who is asking (_neo_me) and what that person may
--   see; the helpers are internal (service_role only, never callable over
--   /rpc with someone else's id). Nothing here writes, except the per-day km
--   cache that the HR block (_hr_dash_hr → _hr_live) keeps, as hr_dashboard.
--
-- WHO SEES WHAT (a section the caller can't see is left out, never zeros)
--   builds   any Builds (qc) role, or tier 3+            (shop-wide)
--   service  any Service role, or tier 3+                (shop-wide)
--   rma      any RMA role, or tier 3+                    (shop-wide)
--   sales    sales staff (department sales, or "sales" in the designation),
--            or anyone who is the sales exec of an open build: OWN builds only
--   mine     per kind, for a pool member (builds: build pool; service and
--            RMA: service pool) or anyone holding / offered an item of it
--   hr       NeoHR leads (approvers; tier 3+ always are): exactly hr_dashboard().hr,
--            from the same helper (_hr_dash_hr), so the two never disagree
--
-- DEFINITIONS (D12: overdue = past its due time; late = not past due but
-- behind. Late and overdue never both: overdue wins.)
--   builds   open = status <> completed. assigned = technician_email set or
--            a technician name. in_queue = unassigned and queued_at set;
--            not_sent = unassigned and never queued (a quote). due = deadline;
--            overdue = deadline <= now; late = in the queue 4 h unclaimed.
--            waiting_parts = still awaiting and (missing components ticked or
--            procurement not checked in: specs.__procurement received,
--            undamaged and matches). Sales: specs.__build.salesExec is the
--            sales exec's EMAIL (a non-email value is matched to the full name).
--            Sales stages: waiting_parts | ready_to_build | building | qc.
--   service  open = stage <> closed. assigned = assignee_email set. Waiting on
--            the customer / a supplier and ready to collect exactly as
--            neo_dashboard (_svc_state). overdue = not in a done stage (ready,
--            closed, work_done, resolved — the set _svc_risk_ms uses) and
--            (promised_at <= now or needed_by <= now or a booked visit 30 min
--            past its start); due = the earliest of those instants. late =
--            _svc_state risk 2 (too long in its stage) or 4 h unclaimed.
--   rma      open = stage <> closed. assigned = handler_email set. at_vendor =
--            with_vendor; to_return = ready_to_return. overdue = with the
--            vendor past expected_back_at; late = _rma_risk_ms risk 2.
--
-- TILE → LIST (every count in neo_overview is the length of exactly this
-- neo_overview_list(kind, scope, state); kind is build | service | rma)
--   mine.<k>.items / offered / due_today / late / overdue
--                                → (k, mine, any / offered / due_today / late / overdue)
--   builds.open / assigned / in_queue / not_sent / late / overdue / waiting_parts
--                                → (build, all, any / assigned / … / waiting_parts)
--   builds.mine                  → (build, mine, any)
--   service.open / assigned / in_queue / waiting_customer / waiting_supplier /
--           ready_to_collect / late / overdue → (service, all, <the key>; open = any)
--   service.mine                 → (service, mine, any)
--   rma.open / assigned / in_queue / at_vendor / to_return / late / overdue
--                                → (rma, all, <the key>; open = any)
--   rma.mine                     → (rma, mine, any)
--   sales.open                   → (build, sales, any)
--   sales.by_stage.<s>           → (build, sales, stage:<s>)
--   sales.late / sales.overdue   → (build, sales, late / overdue)
--   scope mine = the items I hold; with state 'offered', the items offered to me.
--   kind 'all' lists every kind the caller may see (the "Late & overdue" page).
--
-- FUNCTIONS (all new; every one is _hr_-prefixed or listed in _hr_lockdown's
-- v_api by sql/neohr-hr-v2.4.sql, and this file grants the two RPCs itself too)
--   _hr_ov_gates, _hr_ov_when, _hr_ov_age, _hr_ov_items, neo_overview,
--   neo_overview_list
--   Calls from sql/neohr-hr-v2.4.sql: _hr_dash_view (view) and _hr_dash_hr
--   (the hr block).
--
-- CONVENTIONS (as v2 … v2.4): errors are NEO_GATE: <a sentence>; India time
--   everywhere (_hr_today / _hr_at, never current_date); every DO block ends
--   with perform public._hr_lockdown(); no table, no sequence, no grant to anon.
-- =============================================================================


-- ── part 1: the shared item helper and its small helpers ────────────────────
do $ov$
begin

-- What p_viewer may read, by kind, plus their work pools. Tier 3+ are leads
-- of every module (module_role), so they see every kind. A missing, inactive
-- or non-staff profile sees nothing.
create or replace function public._hr_ov_gates(p_viewer uuid,
  out builds boolean, out service boolean, out rma boolean, out sales boolean, out hr boolean,
  out build_pool boolean, out service_pool boolean)
language sql stable security definer set search_path = public as $$
  select coalesce(public.role_rank(public._module_role_of(p.id, 'qc')) >= 1, false),
         coalesce(public.role_rank(public._module_role_of(p.id, 'service')) >= 1, false),
         coalesce(public.role_rank(public._module_role_of(p.id, 'rma')) >= 1, false),
         coalesce(p.id is not null and (lower(btrim(coalesce(p.department, ''))) = 'sales'
                                        or coalesce(p.designation, '') ilike '%sales%'), false),
         coalesce(public.role_rank(public._module_role_of(p.id, 'neohr')) >= 3, false),
         coalesce(p.id is not null and w.build_pool, false),
         coalesce(p.id is not null and w.service_pool, false)
    from (select p_viewer as id) x
    left join public.profiles p on p.id = x.id and p.active and coalesce(p.is_staff, false)
    left join lateral public._work_settings(p.id) w on true
$$;

-- A time for a sentence, in shop time: "14:05" today, else "23 Oct 14:05".
create or replace function public._hr_ov_when(p_at timestamptz)
returns text language sql stable set search_path = public as $$
  select case when p_at is null then null
              when (p_at at time zone 'Asia/Kolkata')::date = public._hr_today(now())
                then to_char(p_at at time zone 'Asia/Kolkata', 'HH24:MI')
              else to_char(p_at at time zone 'Asia/Kolkata', 'FMDD Mon HH24:MI') end
$$;

-- How long since p_from, for a sentence: "40 min", "5 h", "3 days".
create or replace function public._hr_ov_age(p_from timestamptz, p_now timestamptz)
returns text language sql immutable set search_path = public as $$
  select case when m < 60 then m || ' min'
              when m < 2880 then (m / 60) || ' h'
              else (m / 1440) || ' days' end
    from (select greatest(0, floor(extract(epoch from (p_now - p_from)) / 60))::bigint as m) x
$$;

-- THE item list behind every dashboard number: every open build, service
-- ticket and RMA part p_viewer may see, one row each, with the flags the
-- tiles count. shop = it is in the viewer's shop-wide lists (the kind is
-- visible to them); a build seen only as its sales exec has shop = false.
-- why = the line the lists show (late / overdue reason, an offer, due today).
create or replace function public._hr_ov_items(p_viewer uuid)
returns table (kind text, id text, code text, title text, stage text, stage_label text, tech_email text, tech_name text,
               due timestamptz, since timestamptz, assigned boolean, in_queue boolean, not_sent boolean, mine boolean,
               offered boolean, due_today boolean, late boolean, overdue boolean, waiting_customer boolean,
               waiting_supplier boolean, ready_to_collect boolean, at_vendor boolean, to_return boolean,
               waiting_parts boolean, sales_mine boolean, sales_stage text, shop boolean, why text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_me public.profiles;
  g record;
  v_em text;
  v_nm text;
  v_now timestamptz := now();
  v_t numeric := floor(extract(epoch from now()) * 1000);
  v_lo timestamptz := public._hr_at(public._hr_today(now()), '00:00');
  v_hi timestamptz := public._hr_at(public._hr_today(now()) + 1, '00:00');
begin
  select * into v_me from public.profiles p where p.id = p_viewer and p.active and coalesce(p.is_staff, false);
  if not found then return; end if;
  v_em := lower(btrim(coalesce(v_me.email, '')));
  v_nm := lower(btrim(regexp_replace(coalesce(v_me.full_name, ''), '\s+', ' ', 'g')));
  select * into g from public._hr_ov_gates(v_me.id);

  -- builds: every build not completed (any other status reads as awaiting,
  -- as neo_dashboard). A name-only legacy assignment is resolved to the one
  -- active staff member with that first name, when there is exactly one.
  return query
  with b as (
    select t.id, t.customer_name, t.deadline, t.queued_at, t.assigned_at, t.created_at, t.offer_expires_at,
           case when t.status in ('building', 'waiting_qc', 'qc_testing') then t.status else 'awaiting' end as st,
           lower(btrim(coalesce(t.technician_email, ''))) as tem,
           nullif(btrim(coalesce(t.technician, '')), '') as tname,
           (t.technician_email is not null or btrim(coalesce(t.technician, '')) <> '') as asg,
           lower(btrim(coalesce(t.offered_to_email, ''))) as oem,
           coalesce(t.missing_components_toggle, false) as missing,
           coalesce(t.specs -> '__procurement' -> 'received' = 'true'::jsonb
                    and t.specs -> '__procurement' -> 'undamaged' = 'true'::jsonb
                    and t.specs -> '__procurement' -> 'matches' = 'true'::jsonb, false) as parts_in,
           lower(btrim(regexp_replace(coalesce(t.specs -> '__build' ->> 'salesExec', ''), '\s+', ' ', 'g'))) as se
      from public.tickets t
     where t.status is distinct from 'completed'
  ), f as (
    select b.*,
           (b.st = 'awaiting' and (b.missing or not b.parts_in)) as wparts,
           (b.se <> '' and v_em <> '' and (b.se = v_em or (position('@' in b.se) = 0 and b.se = v_nm))) as smine,
           (not b.asg and b.queued_at is not null) as inq,
           coalesce(b.deadline <= v_now, false) as od,
           (g.builds and v_em <> '' and b.tem = v_em) as mn,
           (g.builds and v_em <> '' and coalesce(b.offer_expires_at > v_now, false) and b.oem = v_em and b.tem <> v_em) as ofr
      from b
  ), x as (
    select f.*,
           (not f.od and f.inq and f.queued_at + interval '4 hours' <= v_now) as lt
      from f
     where g.builds or f.smine
  )
  select 'build'::text, x.id::text, upper(right(x.id, 6))::text, x.customer_name::text, x.st::text,
         case x.st when 'building' then 'Building' when 'waiting_qc' then 'Waiting for QC' when 'qc_testing' then 'QC testing'
                   else case when x.wparts then 'Waiting for parts' else 'Ready to build' end end,
         (case when x.tem <> '' then x.tem else lower(sn.email) end)::text,
         (case when x.tem <> '' then coalesce(tp.full_name, x.tname, x.tem) else coalesce(sn.full_name, x.tname) end)::text,
         x.deadline,
         case when x.asg then coalesce(x.assigned_at, x.created_at) when x.queued_at is not null then x.queued_at
              else x.created_at end,
         x.asg, x.inq, (not x.asg and x.queued_at is null), x.mn, x.ofr,
         coalesce(x.deadline >= v_lo and x.deadline < v_hi, false), x.lt, x.od,
         false, false, false, false, false, x.wparts, x.smine,
         case x.st when 'building' then 'building' when 'waiting_qc' then 'qc' when 'qc_testing' then 'qc'
                   else case when x.wparts then 'waiting_parts' else 'ready_to_build' end end,
         g.builds,
         case when x.od then 'Overdue — the deadline was ' || public._hr_ov_when(x.deadline) || '.'
              when x.lt then 'Late — nobody has claimed it in 4 hours.'
              when x.ofr then 'Offered to you — accept by ' || public._ist_hm(x.offer_expires_at) || '.'
              when x.deadline >= v_lo and x.deadline < v_hi then 'Due today at ' || public._ist_hm(x.deadline) || '.'
         end
    from x
    left join lateral (select pr.full_name from public.profiles pr
                        where x.tem <> '' and lower(pr.email) = x.tem order by pr.active desc limit 1) tp on true
    left join lateral (select s.email, s.full_name from public._staff_for_short_name(x.tname) s
                        where x.tem = '' and x.tname is not null) sn on true;

  -- service: every ticket not closed.
  return query
  with s0 as (
    select s.id, s.public_code, s.device_label, s.category, s.stage, s.stage_since, s.promised_at, s.needed_by,
           s.visit_start, s.queued_at, s.created_at, s.assignee, s.offer_expires_at,
           s.assignee_email is not null as asg,
           lower(btrim(coalesce(s.assignee_email, ''))) as aem,
           lower(btrim(coalesce(s.offered_to_email, ''))) as oem,
           st.ball, coalesce(st.risk, 0) as risk,
           s.stage in ('ready', 'closed', 'work_done', 'resolved') as done,
           case when s.stage in ('scheduled', 'en_route', 'session_booked') and s.visit_start is not null
                then s.visit_start + interval '30 minutes' end as vdue
      from public.service_jobs s
      cross join lateral public._svc_state(s, v_now) st
     where g.service and s.stage <> 'closed'
  ), s1 as (
    select s0.*,
           least(s0.promised_at, s0.needed_by, s0.vdue) as first_due,
           (not s0.done and (coalesce(s0.promised_at <= v_now, false) or coalesce(s0.needed_by <= v_now, false)
                             or coalesce(s0.vdue <= v_now, false))) as od,
           (not s0.asg and coalesce(s0.queued_at, s0.created_at) + interval '4 hours' <= v_now) as claim_late,
           (v_em <> '' and s0.aem = v_em) as mn,
           (v_em <> '' and coalesce(s0.offer_expires_at > v_now, false) and s0.oem = v_em and s0.aem <> v_em) as ofr
      from s0
  ), x as (
    select s1.*,
           coalesce(s1.first_due, s1.visit_start, s1.needed_by) as dd,
           (not s1.od and (s1.risk = 2 or s1.claim_late)) as lt
      from s1
  )
  select 'service'::text, x.id::text, x.public_code::text,
         coalesce(nullif(btrim(coalesce(x.device_label, '')), ''), public._svc_category_label(x.category))::text,
         x.stage::text, public._svc_stage_label(x.stage)::text,
         nullif(x.aem, '')::text,
         (case when x.aem <> '' then coalesce(tp.full_name, nullif(btrim(coalesce(x.assignee, '')), ''), x.aem) end)::text,
         x.dd, x.stage_since,
         x.asg, not x.asg, false, x.mn, x.ofr,
         coalesce(x.dd >= v_lo and x.dd < v_hi, false), x.lt, x.od,
         coalesce(x.ball = 'customer', false), coalesce(x.ball = 'third_party', false), x.stage = 'ready',
         false, false, false, false, null::text, true,
         case when x.od then case when x.promised_at = x.first_due then 'Overdue — promised for ' || public._hr_ov_when(x.promised_at) || '.'
                                  when x.needed_by = x.first_due then 'Overdue — needed by ' || public._hr_ov_when(x.needed_by) || '.'
                                  else 'Overdue — the visit was booked for ' || public._hr_ov_when(x.visit_start) || '.' end
              when x.lt and x.claim_late then 'Late — nobody has claimed it in 4 hours.'
              when x.lt then 'Late — ' || public._hr_ov_age(x.stage_since, v_now) || ' in this stage.'
              when x.ofr then 'Offered to you — accept by ' || public._ist_hm(x.offer_expires_at) || '.'
              when x.dd >= v_lo and x.dd < v_hi then 'Due today at ' || public._ist_hm(x.dd) || '.'
         end
    from x
    left join lateral (select pr.full_name from public.profiles pr
                        where x.aem <> '' and lower(pr.email) = x.aem order by pr.active desc limit 1) tp on true;

  -- RMA parts: every part not closed (no offers: RMA parts are claimed).
  return query
  with r0 as (
    select c.id, c.public_code, c.kind as part_kind, c.brand, c.model, c.stage, c.stage_since, c.expected_back_at,
           c.handler_name, c.handler_email is not null as asg,
           lower(btrim(coalesce(c.handler_email, ''))) as hem,
           (c.stage = 'with_vendor' and coalesce(c.expected_back_at <= v_now, false)) as od,
           public._rma_risk_ms(c.stage, c.return_method,
             greatest(0, v_t - floor(extract(epoch from c.stage_since) * 1000)),
             floor(extract(epoch from c.expected_back_at) * 1000) - v_t,
             floor(extract(epoch from c.expected_back_at) * 1000) - floor(extract(epoch from c.stage_since) * 1000),
             v.typical_tat_days) as risk
      from public.rma_cases c
      left join public.rma_vendors v on v.id = c.vendor_id
     where g.rma and c.stage <> 'closed'
  ), x as (
    select r0.*,
           case when r0.stage = 'with_vendor' then r0.expected_back_at end as dd,
           (not r0.od and coalesce(r0.risk, 0) = 2) as lt
      from r0
  )
  select 'rma'::text, x.id::text, x.public_code::text, public._rma_label(x.part_kind, x.brand, x.model)::text,
         x.stage::text, public._rma_stage_label(x.stage)::text,
         nullif(x.hem, '')::text,
         (case when x.hem <> '' then coalesce(tp.full_name, nullif(btrim(coalesce(x.handler_name, '')), ''), x.hem) end)::text,
         x.dd, x.stage_since,
         x.asg, not x.asg, false, (v_em <> '' and x.hem = v_em), false,
         coalesce(x.dd >= v_lo and x.dd < v_hi, false), x.lt, x.od,
         false, false, false, x.stage = 'with_vendor', x.stage = 'ready_to_return', false, false, null::text, true,
         case when x.od then 'Overdue — due back from the vendor by ' || public._hr_ov_when(x.expected_back_at) || '.'
              when x.lt then 'Late — ' || public._hr_ov_age(x.stage_since, v_now) || ' in this stage.'
              when x.dd >= v_lo and x.dd < v_hi then 'Due back today at ' || public._ist_hm(x.dd) || '.'
         end
    from x
    left join lateral (select pr.full_name from public.profiles pr
                        where x.hem <> '' and lower(pr.email) = x.hem order by pr.active desc limit 1) tp on true;
end $$;

perform public._hr_lockdown();
end $ov$;


-- ── part 2: the two RPCs ─────────────────────────────────────────────────────
do $ov$
begin

-- The dashboard numbers for the caller (any active staff member):
--   {now, view, mine?: {builds?, service?, rma?: {items, offered, due_today, late, overdue}},
--    builds?: {open, assigned, in_queue, not_sent, mine, late, overdue, waiting_parts},
--    service?: {open, assigned, in_queue, mine, waiting_customer, waiting_supplier, ready_to_collect, late, overdue},
--    rma?: {open, assigned, in_queue, mine, at_vendor, to_return, late, overdue},
--    sales?: {open, by_stage: {waiting_parts, ready_to_build, building, qc}, late, overdue},
--    hr?: exactly hr_dashboard().hr (_hr_dash_hr),
--    top: [at most 6 late / overdue items: overdue first, mine first, then by due]}
-- view = _hr_dash_view (null if it fails: the phone then picks the view itself).
create or replace function public.neo_overview()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  g record;
  v_view text;
  c jsonb;
  v_top jsonb;
  v_mine jsonb := '{}'::jsonb;
  v_out jsonb;
begin
  select * into g from public._hr_ov_gates(v_me.id);
  begin
    v_view := public._hr_dash_view(v_me.id);
  exception when others then
    v_view := null;
  end;

  with i as materialized (
    select * from public._hr_ov_items(v_me.id)
  ), k as (
    select kk.kind,
           jsonb_build_object(
             'shop', case kk.kind
               when 'build' then jsonb_build_object(
                 'open', count(*) filter (where i.shop),
                 'assigned', count(*) filter (where i.shop and i.assigned),
                 'in_queue', count(*) filter (where i.shop and i.in_queue),
                 'not_sent', count(*) filter (where i.shop and i.not_sent),
                 'mine', count(*) filter (where i.mine),
                 'late', count(*) filter (where i.shop and i.late),
                 'overdue', count(*) filter (where i.shop and i.overdue),
                 'waiting_parts', count(*) filter (where i.shop and i.waiting_parts))
               when 'service' then jsonb_build_object(
                 'open', count(*) filter (where i.shop),
                 'assigned', count(*) filter (where i.shop and i.assigned),
                 'in_queue', count(*) filter (where i.shop and i.in_queue),
                 'mine', count(*) filter (where i.mine),
                 'waiting_customer', count(*) filter (where i.shop and i.waiting_customer),
                 'waiting_supplier', count(*) filter (where i.shop and i.waiting_supplier),
                 'ready_to_collect', count(*) filter (where i.shop and i.ready_to_collect),
                 'late', count(*) filter (where i.shop and i.late),
                 'overdue', count(*) filter (where i.shop and i.overdue))
               else jsonb_build_object(
                 'open', count(*) filter (where i.shop),
                 'assigned', count(*) filter (where i.shop and i.assigned),
                 'in_queue', count(*) filter (where i.shop and i.in_queue),
                 'mine', count(*) filter (where i.mine),
                 'at_vendor', count(*) filter (where i.shop and i.at_vendor),
                 'to_return', count(*) filter (where i.shop and i.to_return),
                 'late', count(*) filter (where i.shop and i.late),
                 'overdue', count(*) filter (where i.shop and i.overdue)) end,
             'mine', jsonb_build_object(
               'items', count(*) filter (where i.mine),
               'offered', count(*) filter (where i.offered),
               'due_today', count(*) filter (where i.mine and i.due_today),
               'late', count(*) filter (where i.mine and i.late),
               'overdue', count(*) filter (where i.mine and i.overdue)),
             'sales', jsonb_build_object(
               'open', count(*) filter (where i.sales_mine),
               'by_stage', jsonb_build_object(
                 'waiting_parts', count(*) filter (where i.sales_mine and i.sales_stage = 'waiting_parts'),
                 'ready_to_build', count(*) filter (where i.sales_mine and i.sales_stage = 'ready_to_build'),
                 'building', count(*) filter (where i.sales_mine and i.sales_stage = 'building'),
                 'qc', count(*) filter (where i.sales_mine and i.sales_stage = 'qc')),
               'late', count(*) filter (where i.sales_mine and i.late),
               'overdue', count(*) filter (where i.sales_mine and i.overdue))) as c
      from (values ('build'), ('service'), ('rma')) as kk(kind)
      left join i on i.kind = kk.kind
     group by kk.kind
  )
  select (select jsonb_object_agg(k.kind, k.c) from k),
         (select coalesce(jsonb_agg(jsonb_build_object(
                    'kind', t.kind, 'id', t.id, 'code', t.code, 'title', t.title, 'stage', t.stage,
                    'stage_label', t.stage_label, 'tech_name', t.tech_name, 'tech_email', t.tech_email,
                    'due', t.due, 'since', t.since, 'late', t.late, 'overdue', t.overdue, 'why', t.why)
                  order by t.overdue desc, t.mine desc, t.due asc nulls last, t.since asc nulls last, t.code, t.id), '[]'::jsonb)
            from (select * from i
                   where (i.shop or i.sales_mine) and (i.late or i.overdue)
                   order by i.overdue desc, i.mine desc, i.due asc nulls last, i.since asc nulls last, i.code, i.id
                   limit 6) t)
    into c, v_top;

  v_out := jsonb_build_object('now', now(), 'view', v_view);
  if g.builds and (g.build_pool or (c #>> '{build,mine,items}')::int > 0 or (c #>> '{build,mine,offered}')::int > 0) then
    v_mine := v_mine || jsonb_build_object('builds', c -> 'build' -> 'mine');
  end if;
  if g.service and (g.service_pool or (c #>> '{service,mine,items}')::int > 0 or (c #>> '{service,mine,offered}')::int > 0) then
    v_mine := v_mine || jsonb_build_object('service', c -> 'service' -> 'mine');
  end if;
  if g.rma and (g.service_pool or (c #>> '{rma,mine,items}')::int > 0) then
    v_mine := v_mine || jsonb_build_object('rma', c -> 'rma' -> 'mine');
  end if;
  if v_mine <> '{}'::jsonb then v_out := v_out || jsonb_build_object('mine', v_mine); end if;
  if g.builds then v_out := v_out || jsonb_build_object('builds', c -> 'build' -> 'shop'); end if;
  if g.service then v_out := v_out || jsonb_build_object('service', c -> 'service' -> 'shop'); end if;
  if g.rma then v_out := v_out || jsonb_build_object('rma', c -> 'rma' -> 'shop'); end if;
  if g.sales or (c #>> '{build,sales,open}')::int > 0 then
    v_out := v_out || jsonb_build_object('sales', c -> 'build' -> 'sales');
  end if;
  -- the same block as hr_dashboard().hr (one definition: _hr_dash_hr, sql/neohr-hr-v2.4.sql)
  if g.hr then v_out := v_out || jsonb_build_object('hr', public._hr_dash_hr(v_me, now())); end if;
  return v_out || jsonb_build_object('top', v_top);
end $$;

-- The items behind one tile (see TILE → LIST in the header):
--   p_kind  build | service | rma | all        (builds = build)
--   p_scope all (the shop-wide list) | mine | sales (my customers' builds)
--   p_state any | assigned | in_queue | not_sent | late | overdue | due_today |
--           offered | waiting_customer | waiting_supplier | ready_to_collect |
--           at_vendor | to_return | waiting_parts | stage:<stage or sales stage>
-- → {items: [{kind, id, code, title, stage, stage_label, tech_name, tech_email,
--    due, since, late, overdue, why, sales_stage}], truncated, total}: at most
-- 300, overdue first, then late, then by due time.
create or replace function public.neo_overview_list(p_kind text, p_scope text default 'all', p_state text default 'any')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles := public._neo_me();
  g record;
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_scope text := coalesce(nullif(lower(btrim(coalesce(p_scope, ''))), ''), 'all');
  v_state text := coalesce(nullif(lower(btrim(coalesce(p_state, ''))), ''), 'any');
  v_stage text;
  v_n bigint;
  v_items jsonb;
begin
  v_kind := case v_kind when 'build' then 'build' when 'builds' then 'build' when 'service' then 'service'
                        when 'rma' then 'rma' when 'all' then 'all' end;
  if v_kind is null then
    raise exception 'NEO_GATE: Pick builds, service or RMA for this list.';
  end if;
  if v_scope not in ('all', 'mine', 'sales') then
    raise exception 'NEO_GATE: Pick all, mine or sales for this list.';
  end if;
  if v_state like 'stage:%' then
    v_stage := substr(v_state, 7);
    if v_stage !~ '^[a-z_]{1,40}$' then
      raise exception 'NEO_GATE: That stage is not one the list knows.';
    end if;
  elsif v_state not in ('any', 'assigned', 'in_queue', 'not_sent', 'late', 'overdue', 'due_today', 'offered',
                        'waiting_customer', 'waiting_supplier', 'ready_to_collect', 'at_vendor', 'to_return',
                        'waiting_parts') then
    raise exception 'NEO_GATE: That filter is not one the list knows.';
  end if;
  if v_scope = 'sales' and v_kind in ('service', 'rma') then
    raise exception 'NEO_GATE: The sales list shows builds only.';
  end if;
  select * into g from public._hr_ov_gates(v_me.id);
  if v_scope = 'all' and not (case v_kind when 'build' then g.builds when 'service' then g.service when 'rma' then g.rma
                                          else g.builds or g.service or g.rma end) then
    raise exception 'NEO_GATE: You can''t see this list.';
  end if;

  with f as materialized (
    select i.* from public._hr_ov_items(v_me.id) i
     where (v_kind = 'all' or i.kind = v_kind)
       and case v_scope when 'all' then i.shop
                        when 'mine' then i.mine or (v_state = 'offered' and i.offered)
                        else i.sales_mine end
       and case v_state when 'any' then true
                        when 'assigned' then i.assigned
                        when 'in_queue' then i.in_queue
                        when 'not_sent' then i.not_sent
                        when 'late' then i.late
                        when 'overdue' then i.overdue
                        when 'due_today' then i.due_today
                        when 'offered' then i.offered
                        when 'waiting_customer' then i.waiting_customer
                        when 'waiting_supplier' then i.waiting_supplier
                        when 'ready_to_collect' then i.ready_to_collect
                        when 'at_vendor' then i.at_vendor
                        when 'to_return' then i.to_return
                        when 'waiting_parts' then i.waiting_parts
                        else i.stage = v_stage or coalesce(i.sales_stage = v_stage, false) end
  )
  select (select count(*) from f),
         (select coalesce(jsonb_agg(jsonb_build_object(
                    'kind', t.kind, 'id', t.id, 'code', t.code, 'title', t.title, 'stage', t.stage,
                    'stage_label', t.stage_label, 'tech_name', t.tech_name, 'tech_email', t.tech_email,
                    'due', t.due, 'since', t.since, 'late', t.late, 'overdue', t.overdue, 'why', t.why,
                    'sales_stage', t.sales_stage)
                  order by t.overdue desc, t.late desc, t.due asc nulls last, t.since asc nulls last, t.code, t.id), '[]'::jsonb)
            from (select * from f
                   order by f.overdue desc, f.late desc, f.due asc nulls last, f.since asc nulls last, f.code, f.id
                   limit 300) t)
    into v_n, v_items;
  return jsonb_build_object('items', v_items, 'truncated', v_n > 300, 'total', v_n);
end $$;

-- The API: authenticated only (each checks the caller itself), never anon.
-- sql/neohr-hr-v2.4.sql lists both in _hr_lockdown's v_api, which grants the
-- same; this keeps them right even before that list knows them.
revoke all on function public.neo_overview() from public, anon, authenticated;
revoke all on function public.neo_overview_list(text, text, text) from public, anon, authenticated;
grant execute on function public.neo_overview() to authenticated, service_role;
grant execute on function public.neo_overview_list(text, text, text) to authenticated, service_role;

perform public._hr_lockdown();
end $ov$;

-- =============================================================================
-- End of neohr_hr_v2_4_overview. Run sql/neohr-hr-v2.4-overview.tests.sql next
-- (it rolls back).
-- =============================================================================
