-- ════════════════════════════════════════════════════════════════════════════
--  Neo OS 1.13 — server v2.6: an "Other" service category with its own name
--  (owner's request, 2026-11-21: the New ticket form's "Not in the list?" lets
--  the desk type a category that the list does not have).
--
--  Additive. Every existing ticket and every older app keeps working: only a
--  1.13 intake sends category 'other', and only then category_other.
--  * service_jobs.category_other: the name the desk typed (1-60 characters).
--  * 'other' joins the category CHECK, _vocab_list('category') and
--    _svc_category_label ("Other").
--  * _svc_create stores p.category_other on an 'other' ticket. A missing name
--    is allowed (the ticket then reads "Other"): the app asks for one, and a
--    server that refused would turn a missing name into a lost intake.
--
--  _vocab_list and _svc_category_label are written out in full: they are the
--  live definitions read on 2026-11-21 plus 'other', and the block refuses to
--  run if either has changed since (md5 of pg_get_functiondef). _svc_create
--  is patched in place from its live definition, and refuses unless every
--  expected text is there exactly once. Any refusal changes nothing.
--
--  After it: sql/service-v2.6-rollback.sql undoes it.
-- ════════════════════════════════════════════════════════════════════════════
begin;

do $g$
begin
  if md5(pg_get_functiondef('public._vocab_list(text)'::regprocedure)) <> '3cc8368b6e0684760dbd7e693e54761f' then
    raise exception '_vocab_list changed since 2026-11-21: re-read it and update this file';
  end if;
  if md5(pg_get_functiondef('public._svc_category_label(text)'::regprocedure)) <> 'd1436dff2a029a5e4ea57d8c029dbe95' then
    raise exception '_svc_category_label changed since 2026-11-21: re-read it and update this file';
  end if;
end $g$;

alter table public.service_jobs add column if not exists category_other text;
alter table public.service_jobs drop constraint if exists service_jobs_category_other_check;
alter table public.service_jobs add constraint service_jobs_category_other_check
  check (category_other is null or char_length(btrim(category_other)) between 1 and 60);

alter table public.service_jobs drop constraint if exists service_jobs_category_check;
alter table public.service_jobs add constraint service_jobs_category_check
  check (category in ('repair','warranty_claim','upgrade','installation','data_recovery','os_software',
                      'networking','maintenance','diagnosis_only','other'));

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

create or replace function public._svc_category_label(p text)
returns text
language sql immutable
set search_path to 'public'
as $$
select case p
when 'repair'         then 'Repair'
when 'warranty_claim' then 'Warranty claim'
when 'upgrade'        then 'Upgrade'
when 'installation'   then 'Installation'
when 'data_recovery'  then 'Data recovery'
when 'os_software'    then 'OS / software'
when 'networking'     then 'Networking'
when 'maintenance'    then 'Maintenance'
when 'diagnosis_only' then 'Diagnosis only'
when 'other'          then 'Other'
else coalesce(p, 'Service')
end
$$;

-- _svc_create: read and store category_other.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public._svc_create(jsonb,profiles)'::regprocedure);
  if strpos(d, 'category_other') > 0 then
    raise exception '_svc_create: already has category_other';
  end if;
  n := replace(d, $r$v_type text; v_channel text; v_category text;$r$,
                  $r$v_type text; v_channel text; v_category text; v_cat_other text;$r$);
  n := replace(n, $r$v_category := coalesce(public._vocab(public._jtxt(p, 'category', 30), 'category', 'Category'), 'repair');$r$,
                  $r$v_category := coalesce(public._vocab(public._jtxt(p, 'category', 30), 'category', 'Category'), 'repair');
  v_cat_other := case when v_category = 'other' then public._jtxt(p, 'category_other', 60, 'The category name') end;$r$);
  n := replace(n, $r$accessories, condition_note, powers_on, data_consent, est_minutes, client_request_id)$r$,
                  $r$accessories, condition_note, powers_on, data_consent, est_minutes, client_request_id, category_other)$r$);
  n := replace(n, $r$v_acc, v_cond, v_powers, v_consent, v_est, v_crid);$r$,
                  $r$v_acc, v_cond, v_powers, v_consent, v_est, v_crid, v_cat_other);$r$);
  -- declared, assigned, inserted: 3 mentions, or a replacement missed and
  -- nothing is changed.
  if (length(n) - length(replace(n, 'v_cat_other', ''))) / length('v_cat_other') <> 3
     or strpos(n, 'client_request_id, category_other)') = 0 then
    raise exception '_svc_create: a replacement did not apply';
  end if;
  execute n;
end $m$;

commit;
