-- ════════════════════════════════════════════════════════════════════════════
--  Neo Service 1.15 — server v2.11: the RMA steps, and the service-centre
--  directory (owner's brief, 24–25 Nov 2026, docs/redesign-2026-11/BRIEF.md).
--
--  1. The eight RMA steps shown on top of a part, each a check gate:
--       1 Ticket created            5 RMA Accepted
--       2 Component checked         6 Ready for collection / replacement received
--       3 Bill and component        7 Component collected, back with us
--         cross-verified            8 RMA completed / Dispatched
--       4 Submitted at vendor / RMA initiated
--     The stage machine is unchanged (same stages, same transitions). The
--     steps are read from the stage plus the facts this migration adds to
--     rma_cases, and rma_step() records them:
--       check      step 2: fault confirmed or no fault found (+ what was seen)
--       verify     step 3: invoice date, warranty valid till, no physical
--                  damage, the centre; or the problem that stops the claim
--                  (out of warranty, physical damage, tampered sticker or
--                  serial, invoice missing)
--       submitted  step 4: who submitted it, when, the centre's RMA/job no.
--       accepted   step 5: the centre accepted it (RMA no. required), where it
--                  stands (in repair, waiting for stock, model change, credit
--                  note) and the expected date
--       progress   step 5: a later status update
--       ready      step 6: ready at the centre (we collect: a 2-day clock), or
--                  coming back to us by courier
--     Every step writes a customer-facing line to the part's history (and so
--     to the ticket's timeline when it came from one), with the reason when a
--     gate fails.
--  2. "How does it go back?" is decided later: rma_create no longer has to be
--     told. return_confirmed says whether it was chosen; a part cannot be
--     back from the centre or ready for the customer until it is.
--  3. Leaving for the centre (ready_to_ship / with_vendor) needs the check and
--     the warranty check done. Brands that need no invoice (Intel, WD…) no
--     longer ask for one.
--  4. The directory: brands (rma_brands: warranty months, invoice needed),
--     service centres and brand portals (rma_vendors, with how to submit, the
--     invoice rule and how it comes back), and routes (rma_routes: brand +
--     part type + model → centre), seeded with the centres the owner named.
--  5. Three new photo/document roles: submission (the part as submitted),
--     job_sheet (the centre's receipt, job sheet or acknowledgement) and
--     delivery_doc (delivery challan, receipts or mails at the end). The two
--     documents are staff-only, like invoices.
--
--  Additive: new columns default to "not recorded", existing parts read as
--  before. After it: sql/service-v2.11-rollback.sql undoes it.
-- ════════════════════════════════════════════════════════════════════════════
begin;

do $guard$
begin
  if md5(pg_get_functiondef('public.tg_rma_cases_touch()'::regprocedure)) <> '5012bd1fedac8e358fa8edcf21379d76' then
    raise exception 'v2.11: tg_rma_cases_touch() is not the version this migration expects; not changing it';
  end if;
  if md5(pg_get_functiondef('public._rma_gate_problems(public.rma_cases, text)'::regprocedure)) <> '433a8fbe12b0f9d847570df4c895c83f' then
    raise exception 'v2.11: _rma_gate_problems() is not the version this migration expects; not changing it';
  end if;
  if md5(pg_get_functiondef('public.rma_create(jsonb)'::regprocedure)) <> '59da4fe7b951e08141695fc16ee1d92a' then
    raise exception 'v2.11: rma_create() is not the version this migration expects; not changing it';
  end if;
  if md5(pg_get_functiondef('public._vocab_list(text)'::regprocedure)) <> '37dc408e5e74bb57e8015bc4c01c78f5' then
    raise exception 'v2.11: _vocab_list() is not the version this migration expects; not changing it';
  end if;
end $guard$;

-- ── 1. The step facts on rma_cases ──────────────────────────────────────────
alter table public.rma_cases
  add column if not exists check_result       text,
  add column if not exists checked_at         timestamptz,
  add column if not exists checked_by         text,
  add column if not exists warranty_until     date,
  add column if not exists verify_problem     text,
  add column if not exists verified_at        timestamptz,
  add column if not exists verified_by        text,
  add column if not exists submitted_at       timestamptz,
  add column if not exists submitted_by       text,
  add column if not exists vendor_accepted_at timestamptz,
  add column if not exists vendor_progress    text,
  add column if not exists vendor_ready_at    timestamptz,
  add column if not exists vendor_ready_via   text,
  add column if not exists return_confirmed   boolean not null default true;

alter table public.rma_cases drop constraint if exists rma_cases_check_result_check;
alter table public.rma_cases add constraint rma_cases_check_result_check
  check (check_result in ('fault_confirmed', 'no_fault'));
alter table public.rma_cases drop constraint if exists rma_cases_verify_problem_check;
alter table public.rma_cases add constraint rma_cases_verify_problem_check
  check (verify_problem in ('out_of_warranty', 'physical_damage', 'tampered', 'invoice_missing'));
alter table public.rma_cases drop constraint if exists rma_cases_vendor_progress_check;
alter table public.rma_cases add constraint rma_cases_vendor_progress_check
  check (vendor_progress in ('in_repair', 'awaiting_stock', 'model_change', 'credit_note'));
alter table public.rma_cases drop constraint if exists rma_cases_vendor_ready_via_check;
alter table public.rma_cases add constraint rma_cases_vendor_ready_via_check
  check (vendor_ready_via in ('collect', 'courier'));
alter table public.rma_cases drop constraint if exists rma_cases_step_text_len;
alter table public.rma_cases add constraint rma_cases_step_text_len
  check (length(coalesce(checked_by, '')) <= 120 and length(coalesce(verified_by, '')) <= 120
         and length(coalesce(submitted_by, '')) <= 120);
-- The Details tab saves the return method with return_confirmed = true (the
-- same value as the default 'collect' would not count as a change), and can
-- correct the warranty date. Every other step fact is written by rma_step.
grant update (return_confirmed, warranty_until) on table public.rma_cases to authenticated;

-- ── 2. The vocabulary (written out in full; only media_role and vendor_kind
--       change) ─────────────────────────────────────────────────────────────
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

-- ── 3. Media roles: the part as submitted, the centre's documents, the end ──
alter table public.service_media drop constraint if exists service_media_role_check;
alter table public.service_media add constraint service_media_role_check
  check (role in ('condition','serial_label','invoice','damage','packing','unboxing','during','after',
                  'vendor_doc','return_condition','other','submission','job_sheet','delivery_doc'));
alter table public.service_media drop constraint if exists service_media_private_roles;
alter table public.service_media add constraint service_media_private_roles
  check (not customer_visible or coalesce(role, 'condition') not in
         ('invoice','serial_label','vendor_doc','job_sheet','delivery_doc'));

-- ── 4. Service centres and brand portals: how each one works ────────────────
alter table public.rma_vendors drop constraint if exists rma_vendors_kind_check;
alter table public.rma_vendors add constraint rma_vendors_kind_check
  check (kind in ('brand', 'distributor', 'service_centre', 'portal'));
alter table public.rma_vendors
  add column if not exists submit_how   text,
  add column if not exists invoice_rule text,
  add column if not exists return_how   text,
  add column if not exists notes        text;
alter table public.rma_vendors drop constraint if exists rma_vendors_submit_how_check;
alter table public.rma_vendors add constraint rma_vendors_submit_how_check
  check (submit_how in ('in_person', 'courier', 'portal'));
alter table public.rma_vendors drop constraint if exists rma_vendors_invoice_rule_check;
alter table public.rma_vendors add constraint rma_vendors_invoice_rule_check
  check (invoice_rule in ('with_part', 'checked_returned', 'not_needed'));
alter table public.rma_vendors drop constraint if exists rma_vendors_return_how_check;
alter table public.rma_vendors add constraint rma_vendors_return_how_check
  check (return_how in ('we_collect', 'courier_to_us', 'either'));
alter table public.rma_vendors drop constraint if exists rma_vendors_notes_len;
alter table public.rma_vendors add constraint rma_vendors_notes_len
  check (length(coalesce(notes, '')) <= 1000);

-- ── 5. Brands and routes (brand + part type + model → centre) ───────────────
create table if not exists public.rma_brands (
  id              bigserial primary key,
  name            text not null check (length(btrim(name)) between 1 and 80),
  warranty_months integer check (warranty_months between 0 and 240),
  invoice_needed  boolean not null default true,
  notes           text check (length(coalesce(notes, '')) <= 1000),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  created_by      text
);
create unique index if not exists rma_brands_name_key on public.rma_brands (lower(btrim(name)));

create table if not exists public.rma_routes (
  id           bigserial primary key,
  brand_id     bigint not null references public.rma_brands(id) on delete cascade,
  kind         text check (kind in ('pc','laptop','gpu','psu','ram','ssd','hdd','motherboard','cpu',
                                    'cooler','monitor','peripheral','other')),
  model_hint   text check (length(coalesce(model_hint, '')) <= 120),
  vendor_id    bigint not null references public.rma_vendors(id) on delete cascade,
  invoice_rule text check (invoice_rule in ('with_part', 'checked_returned', 'not_needed')),
  return_how   text check (return_how in ('we_collect', 'courier_to_us', 'either')),
  notes        text check (length(coalesce(notes, '')) <= 1000),
  created_at   timestamptz not null default now(),
  created_by   text
);
create unique index if not exists rma_routes_key
  on public.rma_routes (brand_id, coalesce(kind, ''), lower(btrim(coalesce(model_hint, ''))), vendor_id);
create index if not exists rma_routes_vendor_idx on public.rma_routes (vendor_id);

alter table public.rma_brands enable row level security;
alter table public.rma_routes enable row level security;
drop policy if exists rb_select on public.rma_brands;
create policy rb_select on public.rma_brands for select to authenticated
  using ((select public.rma_reader()) or (select public.svc_reader()));
drop policy if exists rb_insert on public.rma_brands;
create policy rb_insert on public.rma_brands for insert to authenticated
  with check ((select public.has_module('rma', 'desk')));
drop policy if exists rb_update on public.rma_brands;
create policy rb_update on public.rma_brands for update to authenticated
  using ((select public.has_module('rma', 'desk'))) with check ((select public.has_module('rma', 'desk')));
drop policy if exists rr_select on public.rma_routes;
create policy rr_select on public.rma_routes for select to authenticated
  using ((select public.rma_reader()) or (select public.svc_reader()));
drop policy if exists rr_insert on public.rma_routes;
create policy rr_insert on public.rma_routes for insert to authenticated
  with check ((select public.has_module('rma', 'desk')));
drop policy if exists rr_update on public.rma_routes;
create policy rr_update on public.rma_routes for update to authenticated
  using ((select public.has_module('rma', 'desk'))) with check ((select public.has_module('rma', 'desk')));
drop policy if exists rr_delete on public.rma_routes;
create policy rr_delete on public.rma_routes for delete to authenticated
  using ((select public.has_module('rma', 'desk')));

revoke all on table public.rma_brands, public.rma_routes from anon;
grant select, insert, update on table public.rma_brands to authenticated;
grant select, insert, update, delete on table public.rma_routes to authenticated;
revoke all on sequence public.rma_brands_id_seq, public.rma_routes_id_seq from anon;
grant usage on sequence public.rma_brands_id_seq, public.rma_routes_id_seq to authenticated;

-- ── 6. Seed: the centres and portals the owner named (25 Nov 2026) ──────────
insert into public.rma_vendors (name, public_name, kind, typical_tat_days, submit_how, invoice_rule, return_how, notes)
values
  ('Acro', 'Acro', 'service_centre', 14, 'in_person', 'with_part', 'we_collect',
   'Submit at their place. They re-check the part before accepting. Mostly replacements.'),
  ('F1 Info Services', 'F1 Info Services', 'service_centre', 14, 'in_person', 'checked_returned', 'either',
   'They check the invoice date and hand it back. Mostly repairs (motherboards, PSUs). MSI couriers it back to our office; ASUS must be collected.'),
  ('Gigabyte service centre', 'Gigabyte', 'service_centre', 14, 'in_person', 'checked_returned', 'we_collect',
   'Authorised Gigabyte centre. Checks the invoice and hands it back. We collect.'),
  ('Kaizen', 'Kaizen', 'service_centre', 14, 'in_person', 'checked_returned', 'we_collect',
   'Replaces RAM, SSD, HDD, PSU and sometimes coolers. Repairs GPUs and motherboards; if the fault comes back, a replacement of the same or another model (they call before using a different model).'),
  ('Smart Core', 'Intel', 'service_centre', 14, 'in_person', 'not_needed', 'we_collect',
   'Intel processors. No bill needed.'),
  ('Rashi Peripherals (RP Tech)', 'Rashi Peripherals', 'service_centre', 14, 'in_person', null, null,
   'NVIDIA, SanDisk and others.'),
  ('AMD warranty portal', 'AMD', 'portal', 14, 'portal', null, null,
   'Register the claim online. AMD checks the warranty and gives a deadline to submit at an authorised centre.'),
  ('SanDisk warranty portal', 'SanDisk', 'portal', 14, 'portal', null, null,
   'Register the claim online, then submit by the deadline they give.'),
  ('WD warranty portal', 'Western Digital', 'portal', 14, 'portal', 'not_needed', null,
   'Register the claim online, then submit by the deadline they give. No invoice needed.'),
  ('Samsung warranty portal', 'Samsung', 'portal', 14, 'portal', null, null,
   'Depends on the part type. Register online, then submit by the deadline they give.')
on conflict (name) do nothing;

insert into public.rma_brands (name, invoice_needed, created_by)
select b.name, b.name not in ('Intel', 'Western Digital'), 'v2.11 seed'
from (values
  ('Acer'), ('ADATA'), ('AMD'), ('Ant Esports'), ('Antec'), ('ASUS'), ('BenQ'), ('Colorful'),
  ('Cooler Master'), ('Corsair'), ('Creative'), ('Crucial'), ('Deepcool'), ('Dell'), ('G.Skill'),
  ('Galax'), ('Gigabyte'), ('HP'), ('Inno3D'), ('Intel'), ('Kingston'), ('Lenovo'), ('Lexar'), ('LG'),
  ('Lian Li'), ('Logitech'), ('Mercury'), ('MSI'), ('Nextron'), ('NVIDIA'), ('NZXT'), ('Palit'),
  ('PowerColor'), ('Samsung'), ('SanDisk'), ('Sapphire'), ('Seagate'), ('Seasonic'), ('Syrotech'),
  ('TeamGroup'), ('Thermaltake'), ('TP-Link'), ('Western Digital'), ('XPG'), ('Zotac')
) as b(name)
on conflict (lower(btrim(name))) do nothing;

insert into public.rma_routes (brand_id, kind, model_hint, vendor_id, return_how, notes, created_by)
select b.id, r.kind, null, v.id, r.return_how, r.notes, 'v2.11 seed'
from (values
  ('XPG', null, 'Acro', null, null),
  ('ADATA', null, 'Acro', null, 'Acro takes ADATA RAM and most ADATA parts.'),
  ('ADATA', 'ssd', 'Gigabyte service centre', null, 'Some ADATA SSD models only. Check the model, and add it to this route once known.'),
  ('G.Skill', null, 'Acro', null, null),
  ('Deepcool', null, 'Acro', null, null),
  ('Ant Esports', null, 'Acro', null, null),
  ('MSI', null, 'F1 Info Services', 'courier_to_us', 'MSI couriers it back to our office.'),
  ('Acer', null, 'F1 Info Services', null, null),
  ('ASUS', null, 'F1 Info Services', 'we_collect', 'ASUS must be collected.'),
  ('Gigabyte', null, 'Gigabyte service centre', null, null),
  ('Mercury', null, 'Kaizen', null, null),
  ('Cooler Master', null, 'Kaizen', null, null),
  ('Corsair', null, 'Kaizen', null, null),
  ('Colorful', null, 'Kaizen', null, null),
  ('Creative', null, 'Kaizen', null, null),
  ('Zotac', null, 'Kaizen', null, null),
  ('Syrotech', null, 'Kaizen', null, null),
  ('Lexar', null, 'Kaizen', null, null),
  ('Crucial', null, 'Kaizen', null, null),
  ('Sapphire', null, 'Kaizen', null, null),
  ('Nextron', null, 'Kaizen', null, null),
  ('Galax', null, 'Kaizen', null, null),
  ('Inno3D', null, 'Kaizen', null, null),
  ('Intel', 'cpu', 'Smart Core', null, null),
  ('NVIDIA', null, 'Rashi Peripherals (RP Tech)', null, null),
  ('SanDisk', null, 'Rashi Peripherals (RP Tech)', null, null),
  ('AMD', null, 'AMD warranty portal', null, null),
  ('SanDisk', null, 'SanDisk warranty portal', null, 'Some SanDisk parts are claimed online.'),
  ('Western Digital', null, 'WD warranty portal', null, null),
  ('Samsung', null, 'Samsung warranty portal', null, 'Depends on the part type.')
) as r(brand, kind, vendor, return_how, notes)
join public.rma_brands b on lower(btrim(b.name)) = lower(r.brand)
join public.rma_vendors v on v.name = r.vendor
on conflict do nothing;

-- ── 7. "How does it go back?" decided later ─────────────────────────────────
-- rma_create tells the insert trigger, for this transaction only, whether the
-- form chose a return method. Any other insert path keeps the old meaning
-- (chosen). A part that holds its ticket goes back with the device.
create or replace function public.tg_rma_cases_return_given()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  new.return_confirmed := new.holds_ticket
    or coalesce(nullif(current_setting('neo.rma_ret_given', true), ''), '1') = '1';
  return new;
end $$;
revoke all on function public.tg_rma_cases_return_given() from public, anon, authenticated;

drop trigger if exists trg_rma_cases_return_given on public.rma_cases;
create trigger trg_rma_cases_return_given before insert on public.rma_cases
  for each row execute function public.tg_rma_cases_return_given();

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
-- v2.11: no return method on the form = decided later (tg_rma_cases_return_given).
perform set_config('neo.rma_ret_given',
  case when nullif(btrim(coalesce(p ->> 'return_method', '')), '') is null then '0' else '1' end, true);
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

revoke all on function public.rma_create(jsonb) from public, anon;
grant execute on function public.rma_create(jsonb) to authenticated;

-- ── 8. The touch trigger: return method gate, submitted at / by ─────────────
create or replace function public.tg_rma_cases_touch()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
new.updated_at := now();
-- v2.11: setting the return method (by hand or by a server path) decides it.
if new.return_method is distinct from old.return_method then
new.return_confirmed := true;
end if;
if new.stage is distinct from old.stage then
if not public.rma_transition_ok(old.stage, new.stage) then
raise exception 'NEO_GATE: % is not a next step from %.',
public._rma_stage_label(new.stage), public._rma_stage_label(old.stage);
end if;
if new.stage_since is not distinct from old.stage_since then
new.stage_since := now();
end if;
-- v2.11: asked when the part is back or ready for the customer, never before.
if new.stage in ('back_from_vendor', 'ready_to_return') and not new.return_confirmed then
raise exception 'NEO_GATE: Choose how the part goes back to the customer: collected in store, couriered, or fitted back in their device.';
end if;
-- v2.11: step 4. rma_step('submitted') can correct who and when.
if new.stage = 'with_vendor' then
new.submitted_at := coalesce(new.submitted_at, now());
new.submitted_by := coalesce(new.submitted_by,
(select p.full_name from public.profiles p where p.id = auth.uid()), auth.email());
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

-- ── 9. The gates: check + warranty check before the centre; no invoice for
--       brands that need none; the return method when it comes back ────────
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
if p_case.check_result is distinct from 'fault_confirmed' then
v := array_append(v, 'Check the part first and confirm the fault is real.');
end if;
if p_case.verified_at is null or p_case.verify_problem is not null then
v := array_append(v, 'Verify the bill and the part first: warranty date, no physical damage.');
end if;
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
v := array_append(v, 'Choose the service centre.');
end if;
if p_case.kind in ('ssd', 'hdd') and p_case.data_handling is null then
v := array_append(v, 'Say what happens to the data on the drive: wiped by us, sent with the customer''s consent, or unreadable and the customer told.');
end if;
if p_case.purchase_source = 'elsewhere' then
v_doc := exists (select 1 from public.service_media m
where (m.rma_case_id = p_case.id
or (p_case.service_item_id is not null and m.service_item_id = p_case.service_item_id))
and m.role in ('invoice', 'vendor_doc'))
-- v2.11: brands that need no invoice (Intel, WD…).
or exists (select 1 from public.rma_brands b
where lower(btrim(b.name)) = lower(btrim(coalesce(p_case.brand, ''))) and not b.invoice_needed);
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
if not p_case.return_confirmed then
v := array_append(v, 'Choose how the part goes back to the customer.');
end if;
elsif p_to = 'ready_to_return' then
if not p_case.return_confirmed then
v := array_append(v, 'Choose how the part goes back to the customer.');
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

-- ── 10. rma_step: record steps 2–6 ──────────────────────────────────────────
create or replace function public.rma_step(p_case_id text, p_step text, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
v_me public.profiles := public._neo_me();
x jsonb := case when jsonb_typeof(coalesce(p, '{}'::jsonb)) = 'object' then p else '{}'::jsonb end;
v_who text := coalesce(nullif(btrim(coalesce(v_me.full_name, '')), ''), v_me.email);
v_case public.rma_cases;
v_proj public.rma_cases;
v_new public.rma_cases;
v_note text;
v_val text;
v_pdate date;
v_until date;
v_inv text;
v_vendor bigint;
v_no text;
v_by text;
v_at timestamptz;
v_exp timestamptz;
v_tat int;
v_to text;
v_problems text[];
v_party text;
v_what text;
v_body text;
v_visible boolean := true;
v_progress text;
begin
if not public.has_module('rma', 'desk') then
raise exception 'NEO_DENIED: You don''t have access to the RMA desk.';
end if;
if p_step is null or p_step not in ('check', 'verify', 'submitted', 'accepted', 'progress', 'ready') then
raise exception 'NEO_GATE: That is not one of the RMA steps.';
end if;
v_note := public._jtxt(x, 'note', 2000, 'The note');
perform public._rma_lock(array[p_case_id]);
select * into v_case from public.rma_cases where id = p_case_id;
if not found then raise exception 'NEO_GATE: That part no longer exists.'; end if;
if v_case.stage = 'closed' then
raise exception 'NEO_STALE: This RMA is closed. Reopen it to see how it ended.';
end if;
select public._rma_party(v_case.brand, vd.public_name, vd.kind), vd.typical_tat_days
into v_party, v_tat
from public.rma_vendors vd where vd.id = v_case.vendor_id;
v_party := coalesce(v_party, public._rma_party(v_case.brand, null, null), 'the manufacturer');
v_what := lower(public._item_kind_label(v_case.kind));

if p_step = 'check' then
-- Step 2: is the complaint real? A wrongly diagnosed part costs time and money.
if v_case.stage not in ('with_tech', 'received', 'testing') then
raise exception 'NEO_STALE: This part is at %. The check comes before the warranty claim.',
public._rma_stage_label(v_case.stage);
end if;
v_val := public._jtxt(x, 'result', 20);
if v_val is null or v_val not in ('fault_confirmed', 'no_fault') then
raise exception 'NEO_GATE: Say what the check found: the fault is real, or no fault found.';
end if;
if v_note is null then
raise exception 'NEO_GATE: Write what you tested and what you saw.';
end if;
update public.rma_cases
set check_result = v_val, checked_at = now(), checked_by = v_who, our_finding = v_note,
verified_at = null, verified_by = null, verify_problem = null,
stage = case when stage = 'received' then 'testing' else stage end
where id = p_case_id
returning * into v_new;
v_body := case v_val
when 'fault_confirmed' then 'We checked your ' || v_what || ' and confirmed the fault. Next we check the warranty.'
else 'We tested your ' || v_what || ' and it works correctly. We found no fault, so there is nothing to claim under warranty. We''ll talk to you about the next step.'
end;
perform public._rma_ev(p_case_id, 'step', v_body, true,
case when v_new.stage <> v_case.stage then v_case.stage end,
case when v_new.stage <> v_case.stage then v_new.stage end,
jsonb_build_object('step', 'check', 'result', v_val), 'staff', v_me.email, v_me.full_name);
perform public._rma_ev(p_case_id, 'note', 'Check: ' || v_note, false, null, null, '{}'::jsonb,
'staff', v_me.email, v_me.full_name);

elsif p_step = 'verify' then
-- Step 3: bill and part cross-verified.
if v_case.stage not in ('with_tech', 'received', 'testing', 'awaiting_docs', 'customer_decision') then
raise exception 'NEO_STALE: This part is at %. The warranty check comes before it goes to the centre.',
public._rma_stage_label(v_case.stage);
end if;
if v_case.check_result is distinct from 'fault_confirmed' then
raise exception 'NEO_GATE: Check the part first and confirm the fault is real.';
end if;
if v_case.stage = 'customer_decision' and v_case.vendor_result is not null then
raise exception 'NEO_GATE: This part is already back from the centre.';
end if;
v_val := public._jtxt(x, 'problem', 30);
if v_val is not null and v_val not in ('out_of_warranty', 'physical_damage', 'tampered', 'invoice_missing') then
raise exception 'NEO_GATE: Pick the problem from the list.';
end if;
v_pdate := public._jdate(x, 'purchase_date', 'The invoice date');
v_until := public._jdate(x, 'warranty_until', 'The warranty end date');
v_inv := public._jtxt(x, 'invoice_no', 60, 'The invoice number');
v_vendor := public._jint(x, 'vendor_id', 'The service centre', 1, 2147483647);
if v_vendor is not null and not exists (select 1 from public.rma_vendors where id = v_vendor and active) then
raise exception 'NEO_GATE: That service centre is not in the list. Pick one from the list.';
end if;
v_proj := v_case;
v_proj.purchase_date := coalesce(v_pdate, v_case.purchase_date);
v_proj.warranty_until := coalesce(v_until, v_case.warranty_until);
v_proj.invoice_no := coalesce(v_inv, v_case.invoice_no);
v_proj.vendor_id := coalesce(v_vendor, v_case.vendor_id);
v_proj.verified_at := now();
v_proj.verified_by := v_who;
v_proj.verify_problem := v_val;
if v_val is null then
if v_proj.warranty_until is not null and v_proj.warranty_until < (now() at time zone 'Asia/Kolkata')::date then
raise exception 'NEO_GATE: The warranty ended on %. Record it as out of warranty instead.',
to_char(v_proj.warranty_until, 'DD Mon YYYY');
end if;
if coalesce(public._jbool(x, 'condition_ok', 'The condition check'), false) is not true then
raise exception 'NEO_GATE: Confirm there is no physical damage and the warranty sticker and serial are intact, or record the problem.';
end if;
v_to := 'ready_to_ship';
v_problems := public._rma_gate_problems(v_proj, v_to);
if cardinality(v_problems) > 0 then
raise exception 'NEO_GATE: %', array_to_string(v_problems, ' ');
end if;
select public._rma_party(v_case.brand, vd.public_name, vd.kind) into v_party
from public.rma_vendors vd where vd.id = v_proj.vendor_id;
v_party := coalesce(v_party, public._rma_party(v_case.brand, null, null), 'the manufacturer');
v_body := 'Your ' || v_what || ' passed our warranty check. We''re preparing the claim with ' || v_party || '.';
else
if v_case.stage = 'with_tech' then
raise exception 'NEO_GATE: Mark the part received first, then record the problem.';
end if;
v_to := case when v_val = 'invoice_missing' and v_case.stage <> 'customer_decision' then 'awaiting_docs'
else 'customer_decision' end;
v_body := case v_val
when 'out_of_warranty' then 'The warranty on your ' || v_what || ' has ended'
|| coalesce(' (on ' || to_char(v_proj.warranty_until, 'DD Mon YYYY') || ')', '')
|| ', so ' || v_party || ' will not accept a claim. We can offer a paid repair or a replacement.'
when 'physical_damage' then 'Your ' || v_what || ' has physical damage, which the warranty does not cover, so '
|| v_party || ' will not accept a claim. We can offer a paid repair or a replacement.'
when 'tampered' then 'The warranty sticker or serial label on your ' || v_what || ' is damaged or missing, so '
|| v_party || ' will not accept a claim. We can offer a paid repair or a replacement.'
else 'We need the purchase invoice for your ' || v_what || ' to claim the warranty. Please send us a photo or a copy of it.'
end;
end if;
update public.rma_cases
set purchase_date = v_proj.purchase_date, warranty_until = v_proj.warranty_until,
invoice_no = v_proj.invoice_no, vendor_id = v_proj.vendor_id,
verified_at = v_proj.verified_at, verified_by = v_proj.verified_by, verify_problem = v_val,
stage = v_to
where id = p_case_id
returning * into v_new;
perform public._rma_ev(p_case_id, 'step', v_body, true,
case when v_new.stage <> v_case.stage then v_case.stage end,
case when v_new.stage <> v_case.stage then v_new.stage end,
jsonb_strip_nulls(jsonb_build_object('step', 'verify', 'problem', v_val)), 'staff', v_me.email, v_me.full_name);
if v_note is not null then
perform public._rma_ev(p_case_id, 'note', 'Warranty check: ' || v_note, false, null, null, '{}'::jsonb,
'staff', v_me.email, v_me.full_name);
end if;

elsif p_step = 'submitted' then
-- Step 4: the details of the hand-over (the move itself is rma_dispatch).
if v_case.stage <> 'with_vendor' then
raise exception 'NEO_STALE: This part is at %, not at the centre. Submit it first.',
public._rma_stage_label(v_case.stage);
end if;
v_by := public._jtxt(x, 'by', 120, 'Who submitted it');
v_at := public._jts(x, 'at', 'The submitted date');
v_no := public._jtxt(x, 'rma_no', 60, 'The RMA or job number');
if v_at is not null and v_at > now() + interval '1 day' then
raise exception 'NEO_GATE: The submitted date is in the future.';
end if;
update public.rma_cases
set submitted_by = coalesce(v_by, submitted_by), submitted_at = coalesce(v_at, submitted_at),
vendor_rma_no = coalesce(v_no, vendor_rma_no)
where id = p_case_id
returning * into v_new;
v_visible := false;
v_body := 'Submitted'
|| coalesce(' on ' || to_char(v_new.submitted_at at time zone 'Asia/Kolkata', 'DD Mon YYYY'), '')
|| coalesce(' by ' || v_new.submitted_by, '')
|| coalesce('. RMA / job no. ' || v_new.vendor_rma_no, '')
|| coalesce('. ' || v_note, '') || '.';
perform public._rma_ev(p_case_id, 'step', v_body, false, null, null,
jsonb_build_object('step', 'submitted'), 'staff', v_me.email, v_me.full_name);

elsif p_step in ('accepted', 'progress') then
-- Step 5: RMA Accepted, and its updates. This is where the waiting is.
if v_case.stage <> 'with_vendor' then
raise exception 'NEO_STALE: This part is at %, not at the centre.', public._rma_stage_label(v_case.stage);
end if;
if p_step = 'progress' and v_case.vendor_accepted_at is null then
raise exception 'NEO_GATE: Record that the centre accepted the claim first.';
end if;
v_no := public._jtxt(x, 'rma_no', 60, 'The RMA or job number');
if p_step = 'accepted' and coalesce(v_no, nullif(btrim(coalesce(v_case.vendor_rma_no, '')), '')) is null then
raise exception 'NEO_GATE: Type the centre''s RMA or job number from their acknowledgement.';
end if;
v_val := public._jtxt(x, 'progress', 20);
if v_val is null or v_val not in ('in_repair', 'awaiting_stock', 'model_change', 'credit_note') then
raise exception 'NEO_GATE: Say where the claim stands: in repair, waiting for stock, model change offered, or credit note.';
end if;
v_exp := public._jts(x, 'expected', 'The expected date');
if v_exp is not null and v_exp < now() - interval '1 day' then
raise exception 'NEO_GATE: The expected date is in the past.';
end if;
v_at := public._jts(x, 'at', 'The accepted date');
if v_at is not null and v_at > now() + interval '1 day' then
raise exception 'NEO_GATE: The accepted date is in the future.';
end if;
update public.rma_cases
set vendor_rma_no = coalesce(v_no, vendor_rma_no),
vendor_progress = v_val,
vendor_accepted_at = case when p_step = 'accepted' then coalesce(v_at, vendor_accepted_at, now())
else vendor_accepted_at end,
expected_back_at = coalesce(v_exp,
case when p_step = 'accepted' and expected_back_at is null
then now() + make_interval(days => coalesce(v_tat, 14)) end,
expected_back_at)
where id = p_case_id
returning * into v_new;
v_progress := case v_val
when 'in_repair'      then 'It is being repaired'
when 'awaiting_stock' then 'They are waiting for a replacement to come into stock'
when 'model_change'   then 'The same model is not available, so they have offered an equal model. We''ll call you to agree it'
else 'They will settle it with a credit note. We''ll call you about the options'
end || coalesce(', expected by ' || to_char(v_new.expected_back_at at time zone 'Asia/Kolkata', 'DD Mon'), '') || '.';
v_body := case when p_step = 'accepted'
then v_party || ' accepted the warranty claim for your ' || v_what || '. ' || v_progress
else 'Update from ' || v_party || ': ' || v_progress end;
perform public._rma_ev(p_case_id, 'step', v_body, true, null, null,
jsonb_build_object('step', p_step, 'progress', v_val), 'staff', v_me.email, v_me.full_name);
if v_note is not null then
perform public._rma_ev(p_case_id, 'note', v_note, false, null, null, '{}'::jsonb, 'staff', v_me.email, v_me.full_name);
end if;

else
-- Step 6: ready at the centre. We have 2 days to collect; after that the
-- delay is ours, even when the coordinator is away.
if v_case.stage <> 'with_vendor' then
raise exception 'NEO_STALE: This part is at %, not at the centre.', public._rma_stage_label(v_case.stage);
end if;
v_val := public._jtxt(x, 'via', 20);
if v_val is null or v_val not in ('collect', 'courier') then
raise exception 'NEO_GATE: Say how it comes back: we collect it, or they courier it to us.';
end if;
v_at := coalesce(public._jts(x, 'at', 'The date'), now());
if v_at > now() + interval '1 day' then
raise exception 'NEO_GATE: The date is in the future.';
end if;
v_exp := public._jts(x, 'expected', 'The expected date');
update public.rma_cases
set vendor_ready_at = v_at, vendor_ready_via = v_val,
vendor_accepted_at = coalesce(vendor_accepted_at, v_at),
expected_back_at = case when v_val = 'collect' then v_at + interval '2 days'
else coalesce(v_exp, v_at + interval '3 days') end
where id = p_case_id
returning * into v_new;
v_body := case when v_val = 'collect'
then 'Your ' || v_what || ' is ready at ' || v_party || '''s service centre. We''ll collect it within 2 days.'
else 'Your ' || v_what || ' is on its way back to us from ' || v_party || '''s service centre.' end;
perform public._rma_ev(p_case_id, 'step', v_body, true, null, null,
jsonb_build_object('step', 'ready', 'via', v_val), 'staff', v_me.email, v_me.full_name);
if v_note is not null then
perform public._rma_ev(p_case_id, 'note', v_note, false, null, null, '{}'::jsonb, 'staff', v_me.email, v_me.full_name);
end if;
end if;

return to_jsonb(v_new);
end $$;

revoke all on function public.rma_step(text, text, jsonb) from public, anon;
grant execute on function public.rma_step(text, text, jsonb) to authenticated;

commit;
