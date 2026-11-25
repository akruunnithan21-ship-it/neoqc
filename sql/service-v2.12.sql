-- ════════════════════════════════════════════════════════════════════════════
--  Neo Service 1.16 — server v2.12: photos on notes (owner's brief §7, 24 Nov
--  2026: "a Notes section in both, and notes can have images"; go-ahead
--  25 Nov 2026).
--
--  1. A new photo role, 'note': a photo taken for a note. Not a private role
--     (invoices and job sheets stay staff-only whatever the note says).
--  2. service_add_note / rma_add_note take an optional fourth argument,
--     p_media_ids: the photos uploaded for the note (up to 10). Each must
--     belong to the same ticket (or RMA part). The ids go into the note's
--     meta as media_ids, so the note and its photos are shown together.
--     A note's 'note' photos are seen by whoever can read the note: they take
--     the note's customer_visible.
--     The old three-argument call still works (the fourth defaults to none),
--     so apps before 1.16 are not affected. The functions are dropped and
--     created again (a new argument is a new signature; two versions side by
--     side would make every call ambiguous).
--
--  After it: sql/service-v2.12-rollback.sql undoes it.
-- ════════════════════════════════════════════════════════════════════════════
begin;

do $guard$
begin
  if md5(pg_get_functiondef('public._vocab_list(text)'::regprocedure)) <> '86fa9b0c340e2be9c56799c90e4d5961' then
    raise exception 'v2.12: _vocab_list() is not the version this migration expects; not changing it';
  end if;
  if md5(pg_get_functiondef('public.service_add_note(text, text, boolean)'::regprocedure)) <> '99d5344fa0da0b9afbbe1352038eefc7' then
    raise exception 'v2.12: service_add_note() is not the version this migration expects; not changing it';
  end if;
  if md5(pg_get_functiondef('public.rma_add_note(text, text, boolean)'::regprocedure)) <> 'd7adc9a11bec24b293f2bc058433206a' then
    raise exception 'v2.12: rma_add_note() is not the version this migration expects; not changing it';
  end if;
end $guard$;

-- ── 1. The 'note' photo role (the vocabulary written out in full; only
--       media_role changes) ──────────────────────────────────────────────────
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
'submission','job_sheet','delivery_doc','note']
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

alter table public.service_media drop constraint if exists service_media_role_check;
alter table public.service_media add constraint service_media_role_check
  check (role in ('condition','serial_label','invoice','damage','packing','unboxing','during','after',
                  'vendor_doc','return_condition','other','submission','job_sheet','delivery_doc','note'));

-- ── 2. Notes carry their photos ─────────────────────────────────────────────
drop function if exists public.service_add_note(text, text, boolean);
create function public.service_add_note(p_job_id text, p_body text, p_visible boolean default false,
                                        p_media_ids bigint[] default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
v_me public.profiles := public._neo_me();
v_body text := nullif(btrim(coalesce(p_body, '')), '');
v_ids bigint[];
v_n int;
begin
if not public.has_module('service', 'desk') then
raise exception 'NEO_DENIED: You don''t have access to change service tickets.';
end if;
if v_body is null then raise exception 'NEO_GATE: Write the note first.'; end if;
if length(v_body) > 4000 then raise exception 'NEO_GATE: The note is too long — keep it under 4000 characters.'; end if;
if not exists (select 1 from public.service_jobs where id = p_job_id) then
raise exception 'NEO_GATE: That ticket no longer exists.';
end if;
select array_agg(distinct x order by x) into v_ids from unnest(coalesce(p_media_ids, '{}'::bigint[])) as x where x is not null;
if coalesce(cardinality(v_ids), 0) > 10 then
raise exception 'NEO_GATE: A note can carry up to 10 photos.';
end if;
if v_ids is not null then
select count(*) into v_n from public.service_media m
where m.id = any(v_ids) and m.job_id = p_job_id and m.rma_case_id is null;
if v_n <> cardinality(v_ids) then
raise exception 'NEO_GATE: A photo for this note is not on this ticket. Upload it again.';
end if;
-- A note's photos are seen by whoever can read the note.
update public.service_media set customer_visible = coalesce(p_visible, false)
where id = any(v_ids) and role = 'note';
end if;
return to_jsonb(public._svc_ev(p_job_id, 'note', v_body, coalesce(p_visible, false), null, null,
case when v_ids is null then '{}'::jsonb else jsonb_build_object('media_ids', to_jsonb(v_ids)) end,
'staff', v_me.email, v_me.full_name));
end $$;

revoke all on function public.service_add_note(text, text, boolean, bigint[]) from public, anon;
grant execute on function public.service_add_note(text, text, boolean, bigint[]) to authenticated;

drop function if exists public.rma_add_note(text, text, boolean);
create function public.rma_add_note(p_case_id text, p_body text, p_visible boolean default false,
                                    p_media_ids bigint[] default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
v_me public.profiles := public._neo_me();
v_body text := nullif(btrim(coalesce(p_body, '')), '');
v_ids bigint[];
v_n int;
begin
if not public.has_module('rma', 'desk') then
raise exception 'NEO_DENIED: You don''t have access to the RMA desk.';
end if;
if v_body is null then raise exception 'NEO_GATE: Write the note first.'; end if;
if length(v_body) > 4000 then raise exception 'NEO_GATE: The note is too long — keep it under 4000 characters.'; end if;
if not exists (select 1 from public.rma_cases where id = p_case_id) then
raise exception 'NEO_GATE: That part no longer exists.';
end if;
select array_agg(distinct x order by x) into v_ids from unnest(coalesce(p_media_ids, '{}'::bigint[])) as x where x is not null;
if coalesce(cardinality(v_ids), 0) > 10 then
raise exception 'NEO_GATE: A note can carry up to 10 photos.';
end if;
if v_ids is not null then
select count(*) into v_n from public.service_media m
where m.id = any(v_ids) and m.rma_case_id = p_case_id;
if v_n <> cardinality(v_ids) then
raise exception 'NEO_GATE: A photo for this note is not on this part. Upload it again.';
end if;
update public.service_media set customer_visible = coalesce(p_visible, false)
where id = any(v_ids) and role = 'note';
end if;
return to_jsonb(public._rma_ev(p_case_id, 'note', v_body, coalesce(p_visible, false), null, null,
case when v_ids is null then '{}'::jsonb else jsonb_build_object('media_ids', to_jsonb(v_ids)) end,
'staff', v_me.email, v_me.full_name));
end $$;

revoke all on function public.rma_add_note(text, text, boolean, bigint[]) from public, anon;
grant execute on function public.rma_add_note(text, text, boolean, bigint[]) to authenticated;

commit;
