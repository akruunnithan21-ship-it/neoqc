-- ════════════════════════════════════════════════════════════════════════════
--  Undo server v2.11 (sql/service-v2.11.sql): the RMA steps and the
--  service-centre directory. Restores the v2.10 functions word for word and
--  drops what v2.11 added. Recorded step facts, brands and routes are lost;
--  the seeded centres stay in rma_vendors (cases may point at them) but go
--  back to kind 'service_centre'.
--  Photos saved with the v2.11 roles (submission, job_sheet, delivery_doc)
--  become 'other' first, so the old role CHECK can come back.
-- ════════════════════════════════════════════════════════════════════════════
begin;

drop function if exists public.rma_step(text, text, jsonb);
drop trigger if exists trg_rma_cases_return_given on public.rma_cases;
drop function if exists public.tg_rma_cases_return_given();

create or replace function public.rma_create(p jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
v_me public.profiles := public._neo_me();
v_desk boolean := public.has_module('rma', 'desk') or public.has_module('service', 'desk');
v_crid uuid;
v_existing text;
begin
if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEO_GATE: The request is empty.'; end if;
v_crid := public._juuid(p, 'client_request_id');
if v_crid is not null then
select id into v_existing from public.rma_intakes where client_request_id = v_crid;
if found then return public._rma_create_result(v_existing, true); end if;
end if;
begin
return public._rma_create(p, v_me, v_desk);
exception when unique_violation then
if v_crid is not null then
select id into v_existing from public.rma_intakes where client_request_id = v_crid;
if found then return public._rma_create_result(v_existing, true); end if;
end if;
raise;
end;
end $$;

create or replace function public.tg_rma_cases_touch()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
new.updated_at := now();
if new.stage is distinct from old.stage then
if not public.rma_transition_ok(old.stage, new.stage) then
raise exception 'NEO_GATE: % is not a next step from %.',
public._rma_stage_label(new.stage), public._rma_stage_label(old.stage);
end if;
if new.stage_since is not distinct from old.stage_since then
new.stage_since := now();
end if;
if new.stage = 'closed' then
if new.disposition is null then
raise exception 'NEO_GATE: Say how this ended — pick a disposition.';
end if;
if new.fee_status not in ('n_a','paid','waived') then
raise exception 'NEO_GATE: Settle the handling fee first — mark it paid, or ask a lead to waive it.';
end if;
new.closed_at := coalesce(new.closed_at, now());
new.closed_by := coalesce(new.closed_by, auth.email(), 'system');
end if;
end if;
return new;
end $$;

create or replace function public._rma_gate_problems(p_case public.rma_cases, p_to text)
returns text[]
language plpgsql stable security definer
set search_path = public
as $$
declare
v text[] := '{}';
v_doc boolean;
v_fee boolean;
begin
if p_to in ('ready_to_ship', 'with_vendor') then
if coalesce(btrim(p_case.serial), '') = '' then
v := array_append(v, 'Type the serial number as printed on the label.');
end if;
if not exists (select 1 from public.service_media m
where (m.rma_case_id = p_case.id
or (p_case.service_item_id is not null and m.service_item_id = p_case.service_item_id))
and m.role = 'serial_label') then
v := array_append(v, 'Add a photo of the serial label.');
end if;
if p_case.purchase_source = 'unknown' then
v := array_append(v, 'Find out where the part was bought.');
end if;
if p_case.vendor_id is null then
v := array_append(v, 'Choose the vendor.');
end if;
if p_case.kind in ('ssd', 'hdd') and p_case.data_handling is null then
v := array_append(v, 'Say what happens to the data on the drive: wiped by us, sent with the customer''s consent, or unreadable and the customer told.');
end if;
if p_case.purchase_source = 'elsewhere' then
v_doc := exists (select 1 from public.service_media m
where (m.rma_case_id = p_case.id
or (p_case.service_item_id is not null and m.service_item_id = p_case.service_item_id))
and m.role in ('invoice', 'vendor_doc'));
v_fee := p_case.fee_status in ('accepted','paid','waived');
if not v_doc and not v_fee then
v := array_append(v, 'Add the customer''s invoice (or a warranty-check screenshot) and get the handling fee accepted.');
elsif not v_doc then
v := array_append(v, 'Add the customer''s invoice (or a warranty-check screenshot).');
elsif not v_fee then
v := array_append(v, 'Get the handling fee accepted, or ask a lead to waive it.');
end if;
end if;
elsif p_to = 'back_from_vendor' then
if p_case.vendor_result is null then
v := array_append(v, 'Record what the vendor did.');
elsif p_case.vendor_result = 'replaced' and coalesce(btrim(p_case.replacement_serial), '') = '' then
v := array_append(v, 'Type the serial of the replacement part.');
end if;
elsif p_to = 'returning' then
if coalesce(btrim(p_case.return_awb), '') = '' then
v := array_append(v, 'Add the courier AWB number for the return.');
end if;
elsif p_to = 'closed' then
if p_case.disposition is null then
v := array_append(v, 'Say how this ended — pick a disposition.');
end if;
if p_case.fee_status not in ('n_a','paid','waived') then
v := array_append(v, 'Settle the handling fee first — mark it paid, or ask a lead to waive it.');
end if;
end if;
return v;
end $$;

create or replace function public._vocab_list(p_list text)
returns text[]
language sql immutable parallel safe
set search_path to 'public'
as $$
select case p_list
when 'service_type'    then array['in_store','on_site','remote']
when 'channel'         then array['walk_in','phone','whatsapp','website','courier','staff']
when 'category'        then array['repair','warranty_claim','upgrade','installation','data_recovery',
'os_software','networking','maintenance','diagnosis_only','other']
when 'priority'        then array['low','normal','high','urgent']
when 'data_consent'    then array['customer_backed_up','no_important_data','customer_accepts_risk','backup_ok','no_backup']
when 'remote_tool'     then array['anydesk','teamviewer','rustdesk','quick_assist','chrome_remote','other']
when 'item_kind'       then array['pc','laptop','gpu','psu','ram','ssd','hdd','motherboard','cpu',
'cooler','monitor','peripheral','other']
when 'purchase_source' then array['neo_tokyo','elsewhere','unknown']
when 'outcome'         then array['repaired','unrepairable','declined','no_fault_found',
'replaced_under_warranty','cancelled','resolved_on_site',
'resolved_remotely','returned_rma_pending']
when 'svc_stage'       then array['logged','received','diagnosing','quoted','approved','parts_to_order',
'parts_on_order','rma_raised','at_vendor','back_from_vendor','in_service',
'verifying','ready','closed','scheduled','en_route','on_site','work_done',
'revisit_needed','session_booked','in_session','resolved']
when 'rma_source'      then array['from_ticket','walk_in','courier','field','stock','website']
when 'sender_kind'     then array['customer','third_party_tech','our_tech','shop']
when 'diagnosed_by'    then array['us','third_party','customer']
when 'return_method'   then array['collect','courier','with_device']
when 'vendor_result'   then array['replaced','repaired','credit_note','rejected','lost','shipped_to_customer']
when 'fee_status'      then array['n_a','quoted','accepted','paid','waived']
when 'data_handling'   then array['wiped_by_us','customer_consents','unreadable_informed']
when 'ship_mode'       then array['courier','hand_delivery','vendor_pickup','bus_parcel']
when 'disposition'     then array['refitted','replaced','repaired','credit_note','rejected_returned',
'no_fault_found','out_of_warranty','withdrawn','converted_to_repair',
'restocked','scrapped_with_consent','lost_compensated']
when 'rma_stage'       then array['with_tech','logged','received','testing','awaiting_docs','ready_to_ship',
'with_vendor','back_from_vendor','customer_decision','ready_to_return',
'returning','closed']
when 'media_role'      then array['condition','serial_label','invoice','damage','packing','unboxing',
'during','after','vendor_doc','return_condition','other']
when 'module'          then array['service','rma','qc','neohr']
when 'module_role'     then array['desk','tech','lead']
when 'field_kind'      then array['punch_in','punch_out','left_base','arrived','departed','note','photo']
when 'field_outcome'   then array['done','revisit_needed','parts_needed','customer_absent']
when 'field_source'    then array['desktop','neohr']
when 'field_module'    then array['service','rma','neohr']
when 'field_ref_type'  then array['service_job','rma_case','attendance','work_log','none']
when 'vendor_kind'     then array['brand','distributor','service_centre']
else null
end
$$;

update public.service_media set role = 'other' where role in ('submission', 'job_sheet', 'delivery_doc');
alter table public.service_media drop constraint if exists service_media_role_check;
alter table public.service_media add constraint service_media_role_check
  check (role in ('condition','serial_label','invoice','damage','packing','unboxing','during','after',
                  'vendor_doc','return_condition','other'));
alter table public.service_media drop constraint if exists service_media_private_roles;
alter table public.service_media add constraint service_media_private_roles
  check (not customer_visible or coalesce(role, 'condition') not in ('invoice','serial_label','vendor_doc'));

drop table if exists public.rma_routes;
drop table if exists public.rma_brands;

update public.rma_vendors set kind = 'service_centre' where kind = 'portal';
alter table public.rma_vendors drop constraint if exists rma_vendors_kind_check;
alter table public.rma_vendors add constraint rma_vendors_kind_check
  check (kind in ('brand', 'distributor', 'service_centre'));
alter table public.rma_vendors drop constraint if exists rma_vendors_submit_how_check;
alter table public.rma_vendors drop constraint if exists rma_vendors_invoice_rule_check;
alter table public.rma_vendors drop constraint if exists rma_vendors_return_how_check;
alter table public.rma_vendors drop constraint if exists rma_vendors_notes_len;
alter table public.rma_vendors
  drop column if exists submit_how,
  drop column if exists invoice_rule,
  drop column if exists return_how,
  drop column if exists notes;

alter table public.rma_cases drop constraint if exists rma_cases_check_result_check;
alter table public.rma_cases drop constraint if exists rma_cases_verify_problem_check;
alter table public.rma_cases drop constraint if exists rma_cases_vendor_progress_check;
alter table public.rma_cases drop constraint if exists rma_cases_vendor_ready_via_check;
alter table public.rma_cases drop constraint if exists rma_cases_step_text_len;
alter table public.rma_cases
  drop column if exists check_result,
  drop column if exists checked_at,
  drop column if exists checked_by,
  drop column if exists warranty_until,
  drop column if exists verify_problem,
  drop column if exists verified_at,
  drop column if exists verified_by,
  drop column if exists submitted_at,
  drop column if exists submitted_by,
  drop column if exists vendor_accepted_at,
  drop column if exists vendor_progress,
  drop column if exists vendor_ready_at,
  drop column if exists vendor_ready_via,
  drop column if exists return_confirmed;

commit;
