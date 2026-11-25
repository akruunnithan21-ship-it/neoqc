-- ════════════════════════════════════════════════════════════════════════════
--  Neo Service 1.17 — server v2.14: the serial lookup and the customer history
--  (owner's brief §5 "RMA history library" and §6 "Customers database",
--  24 Nov 2026; built 25 Nov 2026).
--
--  serial_history(p_serial)
--    Everything we know about one part by its serial (spaces and dashes don't
--    matter): earlier RMA claims for it (as the claimed part or the
--    replacement we got back), service tickets where it was booked in, and
--    Neo Tokyo builds it went into. A repeat fault is found in seconds and
--    the new claim can copy the brand, model, invoice and warranty.
--    Owner's decision: once a claim's warranty has ended it is hidden from
--    this lookup (only counted), but it stays in the customer's history.
--
--  customer_history(p_phone)
--    One customer, everything: their record, every service ticket (service
--    history is never purged), every RMA part including claims whose warranty
--    has ended, and the builds they bought from us.
--
--  Read-only. Both need Service or RMA access (svc_reader / rma_reader), like
--  lookup_customer and find_builds. Nothing is written.
-- ════════════════════════════════════════════════════════════════════════════
begin;

create or replace function public.serial_history(p_serial text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
v_me public.profiles := public._neo_me();
v_sn text := upper(regexp_replace(coalesce(p_serial, ''), '[^A-Za-z0-9]', '', 'g'));
v_rma jsonb;
v_hidden int;
v_jobs jsonb;
v_builds jsonb;
begin
if not (public.svc_reader() or public.rma_reader()) then
raise exception 'NEO_DENIED: You don''t have access to look up serials.';
end if;
if length(v_sn) < 4 then
return jsonb_build_object('serial', v_sn, 'rma', '[]'::jsonb, 'hidden_rma', 0, 'jobs', '[]'::jsonb, 'builds', '[]'::jsonb);
end if;
if length(v_sn) > 64 then raise exception 'NEO_GATE: That serial is too long.'; end if;

select coalesce(jsonb_agg(jsonb_build_object(
'id', rc.id, 'public_code', rc.public_code, 'kind', rc.kind, 'brand', rc.brand, 'model', rc.model,
'serial', rc.serial, 'replacement_serial', rc.replacement_serial,
'matched', case when rc.serial_norm = v_sn then 'serial' else 'replacement' end,
'stage', rc.stage, 'disposition', rc.disposition, 'vendor_result', rc.vendor_result,
'fault', rc.fault, 'our_finding', rc.our_finding,
'purchase_source', rc.purchase_source, 'invoice_no', rc.invoice_no, 'purchase_date', rc.purchase_date,
'build_ticket_id', rc.build_ticket_id, 'warranty_until', rc.warranty_until,
'vendor_id', rc.vendor_id, 'vendor_name', coalesce(v.public_name, v.name),
'owner_name', rc.owner_name, 'owner_phone', rc.owner_phone,
'sender_name', ri.sender_name, 'sender_phone', ri.sender_phone,
'created_at', rc.created_at, 'closed_at', rc.closed_at)
order by rc.created_at desc)
filter (where rc.stage <> 'closed' or rc.warranty_until is null or rc.warranty_until >= current_date), '[]'::jsonb),
count(*) filter (where rc.stage = 'closed' and rc.warranty_until is not null and rc.warranty_until < current_date)
into v_rma, v_hidden
from public.rma_cases rc
left join public.rma_intakes ri on ri.id = rc.intake_id
left join public.rma_vendors v on v.id = rc.vendor_id
where rc.serial_norm = v_sn or rc.replacement_serial_norm = v_sn;

select coalesce(jsonb_agg(x.o order by x.created_at desc), '[]'::jsonb) into v_jobs
from (select jsonb_build_object(
'id', sj.id, 'public_code', sj.public_code, 'service_type', sj.service_type, 'stage', sj.stage,
'outcome', sj.outcome, 'device_label', sj.device_label,
'item_label', (select si.label from public.service_items si where si.job_id = sj.id and si.serial_norm = v_sn limit 1),
'item_kind', (select si.kind from public.service_items si where si.job_id = sj.id and si.serial_norm = v_sn limit 1),
'customer_name', sj.customer_name, 'customer_phone', sj.customer_phone,
'reported_fault', sj.reported_fault, 'created_at', sj.created_at, 'closed_at', sj.closed_at) as o,
sj.created_at
from public.service_jobs sj
where exists (select 1 from public.service_items si where si.job_id = sj.id and si.serial_norm = v_sn)
or upper(regexp_replace(coalesce(sj.device_serial, ''), '[^A-Za-z0-9]', '', 'g')) = v_sn
order by sj.created_at desc
limit 20) x;

-- Builds: the same serial match as find_builds (part serials, the bench's
-- verification and procurement records), only for real-looking serials.
if length(v_sn) >= 6 and v_sn ~ '[0-9]' then
select coalesce(jsonb_agg(jsonb_build_object(
'id', b.id, 'code', upper(right(b.id, 6)), 'customer_name', b.customer_name,
'customer_phone', b.customer_phone, 'created_at', b.created_at,
'completed_at', b.completed_at, 'handed_over_at', b.handed_over_at,
'summary', nullif(concat_ws(' · ', nullif(btrim(b.specs ->> 'cpu'), ''), nullif(btrim(b.specs ->> 'gpu'), '')), ''))
order by b.created_at desc nulls last), '[]'::jsonb)
into v_builds
from (select t.id, t.customer_name, t.customer_phone, t.created_at, t.completed_at, t.handed_over_at, t.specs
from public.tickets t
where strpos(upper(regexp_replace(coalesce(t.serials, 'null'::jsonb)::text, '[^A-Za-z0-9"]', '', 'g')), v_sn) > 0
or strpos(upper(regexp_replace(coalesce(t.specs -> '__verify', 'null'::jsonb)::text, '[^A-Za-z0-9"]', '', 'g')), v_sn) > 0
or strpos(upper(regexp_replace(coalesce(t.specs -> '__procurement', 'null'::jsonb)::text, '[^A-Za-z0-9"]', '', 'g')), v_sn) > 0
order by t.created_at desc nulls last
limit 10) b;
else
v_builds := '[]'::jsonb;
end if;

return jsonb_build_object('serial', v_sn, 'rma', v_rma, 'hidden_rma', coalesce(v_hidden, 0),
'jobs', v_jobs, 'builds', v_builds);
end $$;
revoke all on function public.serial_history(text) from public, anon;
grant execute on function public.serial_history(text) to authenticated;

create or replace function public.customer_history(p_phone text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
v_me public.profiles := public._neo_me();
v_norm text := public.norm_phone(p_phone);
v_cust public.customers;
v_id uuid;
v_jobs jsonb;
v_rma jsonb;
v_builds jsonb;
begin
if not (public.svc_reader() or public.rma_reader()) then
raise exception 'NEO_DENIED: You don''t have access to customer history.';
end if;
if not public.phone_ok(p_phone) then
raise exception 'NEO_GATE: That phone number is not complete.';
end if;
select * into v_cust from public.customers where phone_norm = v_norm;
v_id := v_cust.id;

-- Every service ticket (service history is never purged).
select coalesce(jsonb_agg(jsonb_build_object(
'id', sj.id, 'public_code', sj.public_code, 'service_type', sj.service_type, 'stage', sj.stage,
'outcome', sj.outcome, 'device_label', sj.device_label, 'reported_fault', sj.reported_fault,
'work_done', sj.work_done, 'assignee', sj.assignee, 'bill_total', sj.bill_total,
'customer_name', sj.customer_name, 'created_at', sj.created_at, 'closed_at', sj.closed_at)
order by sj.created_at desc), '[]'::jsonb)
into v_jobs
from public.service_jobs sj
where public.norm_phone(sj.customer_phone) = v_norm or (v_id is not null and sj.customer_id = v_id);

-- Every RMA part they sent or own, including claims whose warranty has ended.
select coalesce(jsonb_agg(jsonb_build_object(
'id', rc.id, 'public_code', rc.public_code, 'kind', rc.kind, 'brand', rc.brand, 'model', rc.model,
'serial', rc.serial, 'stage', rc.stage, 'disposition', rc.disposition, 'vendor_result', rc.vendor_result,
'fault', rc.fault, 'warranty_until', rc.warranty_until,
'warranty_over', rc.warranty_until is not null and rc.warranty_until < current_date,
'service_job_id', rc.service_job_id, 'created_at', rc.created_at, 'closed_at', rc.closed_at)
order by rc.created_at desc), '[]'::jsonb)
into v_rma
from public.rma_cases rc
join public.rma_intakes ri on ri.id = rc.intake_id
where public.norm_phone(rc.owner_phone) = v_norm
or public.norm_phone(ri.sender_phone) = v_norm
or (v_id is not null and ri.sender_customer_id = v_id);

-- Builds they bought from us.
select coalesce(jsonb_agg(jsonb_build_object(
'id', t.id, 'code', upper(right(t.id, 6)), 'customer_name', t.customer_name, 'status', t.status,
'created_at', t.created_at, 'completed_at', t.completed_at, 'handed_over_at', t.handed_over_at,
'summary', nullif(concat_ws(' · ', nullif(btrim(t.specs ->> 'cpu'), ''), nullif(btrim(t.specs ->> 'gpu'), '')), ''))
order by t.created_at desc nulls last), '[]'::jsonb)
into v_builds
from (select * from public.tickets t0
where t0.customer_phone is not null and public.norm_phone(t0.customer_phone) = v_norm
order by t0.created_at desc nulls last limit 50) t;

return jsonb_build_object(
'phone_norm', v_norm,
'customer', case when v_id is null then null else jsonb_build_object(
'id', v_cust.id, 'name', v_cust.name, 'email', v_cust.email, 'alt_phone', v_cust.alt_phone, 'kind', v_cust.kind,
'address', v_cust.address, 'area', v_cust.area, 'pincode', v_cust.pincode, 'landmark', v_cust.landmark,
'maps_url', v_cust.maps_url, 'notes', v_cust.notes, 'created_at', v_cust.created_at) end,
'jobs', v_jobs, 'rma', v_rma, 'builds', v_builds);
end $$;
revoke all on function public.customer_history(text) from public, anon;
grant execute on function public.customer_history(text) to authenticated;

commit;
