-- ════════════════════════════════════════════════════════════════════════════
--  Undo server v2.12 (sql/service-v2.12.sql): photos on notes. Restores the
--  v2.11 note functions and vocabulary. Notes keep their meta (harmless);
--  photos saved with the 'note' role become 'other'.
-- ════════════════════════════════════════════════════════════════════════════
begin;

drop function if exists public.service_add_note(text, text, boolean, bigint[]);
create function public.service_add_note(p_job_id text, p_body text, p_visible boolean default false)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
v_me public.profiles := public._neo_me();
v_body text := nullif(btrim(coalesce(p_body, '')), '');
begin
if not public.has_module('service', 'desk') then
raise exception 'NEO_DENIED: You don''t have access to change service tickets.';
end if;
if v_body is null then raise exception 'NEO_GATE: Write the note first.'; end if;
if length(v_body) > 4000 then raise exception 'NEO_GATE: The note is too long — keep it under 4000 characters.'; end if;
if not exists (select 1 from public.service_jobs where id = p_job_id) then
raise exception 'NEO_GATE: That ticket no longer exists.';
end if;
return to_jsonb(public._svc_ev(p_job_id, 'note', v_body, coalesce(p_visible, false), null, null, '{}'::jsonb,
'staff', v_me.email, v_me.full_name));
end $$;
revoke all on function public.service_add_note(text, text, boolean) from public, anon;
grant execute on function public.service_add_note(text, text, boolean) to authenticated;

drop function if exists public.rma_add_note(text, text, boolean, bigint[]);
create function public.rma_add_note(p_case_id text, p_body text, p_visible boolean default false)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
v_me public.profiles := public._neo_me();
v_body text := nullif(btrim(coalesce(p_body, '')), '');
begin
if not public.has_module('rma', 'desk') then
raise exception 'NEO_DENIED: You don''t have access to the RMA desk.';
end if;
if v_body is null then raise exception 'NEO_GATE: Write the note first.'; end if;
if length(v_body) > 4000 then raise exception 'NEO_GATE: The note is too long — keep it under 4000 characters.'; end if;
if not exists (select 1 from public.rma_cases where id = p_case_id) then
raise exception 'NEO_GATE: That part no longer exists.';
end if;
return to_jsonb(public._rma_ev(p_case_id, 'note', v_body, coalesce(p_visible, false), null, null, '{}'::jsonb,
'staff', v_me.email, v_me.full_name));
end $$;
revoke all on function public.rma_add_note(text, text, boolean) from public, anon;
grant execute on function public.rma_add_note(text, text, boolean) to authenticated;

update public.service_media set role = 'other' where role = 'note';
alter table public.service_media drop constraint if exists service_media_role_check;
alter table public.service_media add constraint service_media_role_check
  check (role in ('condition','serial_label','invoice','damage','packing','unboxing','during','after',
                  'vendor_doc','return_condition','other','submission','job_sheet','delivery_doc'));

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
'during','after','vendor_doc','return_condition','other',
'submission','job_sheet','delivery_doc']
when 'module'          then array['service','rma','qc','neohr']
when 'module_role'     then array['desk','tech','lead']
when 'field_kind'      then array['punch_in','punch_out','left_base','arrived','departed','note','photo']
when 'field_outcome'   then array['done','revisit_needed','parts_needed','customer_absent']
when 'field_source'    then array['desktop','neohr']
when 'field_module'    then array['service','rma','neohr']
when 'field_ref_type'  then array['service_job','rma_case','attendance','work_log','none']
when 'vendor_kind'     then array['brand','distributor','service_centre','portal']
else null
end
$$;

commit;
