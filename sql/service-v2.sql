-- =============================================================================
-- NEO TOKYO OPERATIONS — Service v2 + RMA module
-- Migration name: service_v2_rma            Target: Postgres 17 on Supabase
-- -----------------------------------------------------------------------------
-- What this does, in one breath: gives the service desk per-module roles
-- (module_access), a customer book, multi-item tickets with on-site / remote
-- types and a claim queue, a full RMA module (one row per physical part), the
-- server-side link that makes a ticket follow its parts through the vendor, a
-- field-activity log for NeoHR, and the public tracking for both NT- and RM-
-- codes.
--
-- RULES THIS FILE HOLDS TO
--   * v1.9.11 desktop clients keep working. They INSERT/UPDATE service_jobs,
--     service_events and service_media directly with the old columns only.
--     Every new column is nullable or defaulted, and every trigger below is
--     written so an old-shaped write still lands (see §4 and §10).
--   * New tables are written through SECURITY DEFINER RPCs only. The two
--     exceptions are column-scoped UPDATE grants on plain descriptive fields.
--   * Every cross-table effect (RMA stage -> ticket stage -> both timelines)
--     happens in the same transaction as its cause.
--   * Errors meant for people are raised as  NEO_<KIND>: <a human sentence>.
--     The apps strip the prefix and show the sentence.
--   * Re-runnable: create ... if not exists, add column if not exists,
--     create or replace, drop ... if exists before create.
--
-- Transaction-local flags (set_config(name, '1', true)), all restored after use:
--   neo.rpc        a service RPC is writing protected columns
--   neo.assign     a claim / assign / release RPC is changing the assignee
--   neo.sync       the RMA link (rma_sync_ticket) is moving a ticket
--   neo.field      record_field_activity is moving a ticket
--   neo.item_sync  the primary item and the ticket's device columns are being
--                  mirrored (stops the two triggers ping-ponging)
--   neo.rma_nosync an RMA RPC is changing holds_ticket and moves the ticket
--                  itself, so the automatic sync must stay out of the way
--   neo.no_mirror  rma_dispatch writes ONE ticket-timeline entry per ticket
--                  itself, so the per-part mirror trigger stands aside
--   neo.migrating  this file's own backfill (triggers stand aside)
--
-- Phones (SPEC-AMENDMENTS A1): norm_phone() keeps the country code, so a
-- Gulf / NRI customer's number stays theirs. customer_phone values on
-- service_jobs stay exactly as typed; every match normalises both sides.
--
-- Apply as ONE migration. Nothing here deletes customer data.
-- =============================================================================

set local lock_timeout = '15s';

create extension if not exists pgcrypto with schema extensions;


-- =============================================================================
-- §1  PURE HELPERS (no table access) — created first because indexes and
--     column defaults below depend on them.
-- =============================================================================

-- Digits only, with the country code (the unified phone rule, A1'). Exact-match
-- lookups and the expression indexes all go through this one function, so
-- "+91 98470 12345", "098470 12345" and "9847012345" are the same customer
-- (919847012345), "+971 50 123 4567" and "00971 50 123 4567" both stay
-- 971501234567 instead of being cut down to someone else's Indian number.
-- The rule, identical in every copy (JS: NeoQcCatalog.normPhone in
-- shared/service-catalog.js, which NeoQcUI and the website delegate to):
--   digits only; a leading "00" (international dialling prefix) is dropped
--   once; then 10 digits -> 91 + d; 11 digits starting 0 -> 91 + last 10;
--   anything else stays as it is (already international, or short / invalid).
create or replace function public.norm_phone(p text)
returns text
language sql immutable parallel safe
set search_path = public
as $$
  select case
           when length(d) = 10                      then '91' || d
           when length(d) = 11 and left(d, 1) = '0' then '91' || right(d, 10)
           else d
         end
    from (select case when left(r, 2) = '00' then substr(r, 3) else r end as d
            from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as r) s0) s
$$;

-- Is this a phone we can track and message? 12-15 normalised digits, or 11
-- digits for Kuwait (965), Oman (968), Bahrain (973) and Qatar (974), whose
-- numbers are a 3-digit code plus 8. Nothing else: an Indian number typed
-- with one digit too many (11 digits, no leading 0) must still be refused.
-- Takes the number as typed (normalises it itself); JS: NeoQcCatalog.phoneOk
-- takes the normalised value, NeoQcCatalog.isValidPhone the typed one.
create or replace function public.phone_ok(p text)
returns boolean
language sql immutable parallel safe
set search_path = public
as $$
  select length(n) between 12 and 15
         or (length(n) = 11 and left(n, 3) in ('965', '968', '973', '974'))
    from (select public.norm_phone(p) as n) s
$$;

create or replace function public.role_rank(r text)
returns int
language sql immutable parallel safe
set search_path = public
as $$
  select case r when 'desk' then 1 when 'tech' then 2 when 'lead' then 3 else 0 end
$$;

-- The customer-facing code: prefix + 8 characters from a crypto source, with
-- the glyphs people misread over the phone (0/O, 1/I/L, 5/S, 8/B) removed.
-- Same alphabet as the desktop app's NT- codes. Callers loop until unique.
create or replace function public.new_public_code(p_prefix text)
returns text
language plpgsql volatile
set search_path = public
as $$
declare
  v_alpha constant text := '234679ACDEFGHJKLMNPQRTUVWXYZ';
  v_bytes bytea := extensions.gen_random_bytes(8);
  v_out text := '';
  i int;
begin
  for i in 0..7 loop
    v_out := v_out || substr(v_alpha, (get_byte(v_bytes, i) % 28) + 1, 1);
  end loop;
  return p_prefix || '-' || v_out;
end $$;

-- Same shape as the app's ids (s_<base36 epoch ms><5 random base36>), so rows
-- made by the server and by v1.9.11 read as siblings. Not a secret, so plain
-- random() is enough — and it keeps this usable as a column default without
-- needing the caller to reach the extensions schema.
create or replace function public.new_text_id(p_prefix text)
returns text
language plpgsql volatile
set search_path = public
as $$
declare
  v_digits constant text := '0123456789abcdefghijklmnopqrstuvwxyz';
  v_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_s text := '';
  i int;
begin
  if v_ms <= 0 then v_s := '0'; end if;
  while v_ms > 0 loop
    v_s := substr(v_digits, (v_ms % 36)::int + 1, 1) || v_s;
    v_ms := v_ms / 36;
  end loop;
  for i in 1..5 loop
    v_s := v_s || substr(v_digits, floor(random() * 36)::int + 1, 1);
  end loop;
  return p_prefix || '_' || v_s;
end $$;

-- Vocabulary, one place. Table CHECKs repeat the literals on purpose (a CHECK
-- should not change meaning when a function is replaced); RPCs validate input
-- through _vocab() so the error is a sentence, not a constraint name.
create or replace function public._vocab_list(p_list text)
returns text[]
language sql immutable parallel safe
set search_path = public
as $$
  select case p_list
    when 'service_type'    then array['in_store','on_site','remote']
    when 'channel'         then array['walk_in','phone','whatsapp','website','courier','staff']
    when 'category'        then array['repair','warranty_claim','upgrade','installation','data_recovery',
                                      'os_software','networking','maintenance','diagnosis_only']
    when 'priority'        then array['low','normal','high','urgent']
    when 'data_consent'    then array['backup_ok','no_backup','customer_backed_up']
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

create or replace function public._vocab(p_value text, p_list text, p_label text)
returns text
language plpgsql stable
set search_path = public
as $$
begin
  if p_value is null then return null; end if;
  if public._vocab_list(p_list) is null or not (p_value = any (public._vocab_list(p_list))) then
    raise exception 'NEO_GATE: % "%" is not one of the allowed values.', p_label, p_value;
  end if;
  return p_value;
end $$;

-- Ticket-type rules (SPEC §1.3 STAGES_BY_TYPE). The JS copy in
-- shared/service-status.js only decides which buttons to draw; this decides.
create or replace function public.svc_stage_legal(p_type text, p_stage text)
returns boolean
language sql immutable parallel safe
set search_path = public
as $$
  select case p_type
    when 'in_store' then p_stage = any (array['logged','received','diagnosing','quoted','approved','parts_to_order',
                                              'parts_on_order','rma_raised','at_vendor','back_from_vendor',
                                              'in_service','verifying','ready','closed'])
    when 'on_site'  then p_stage = any (array['logged','scheduled','en_route','on_site','work_done','revisit_needed',
                                              'quoted','approved','parts_to_order','parts_on_order','rma_raised',
                                              'at_vendor','back_from_vendor','closed'])
    when 'remote'   then p_stage = any (array['logged','session_booked','in_session','resolved','quoted','closed'])
    else false
  end
$$;

create or replace function public.svc_known_stage(p_stage text)
returns boolean
language sql immutable parallel safe
set search_path = public
as $$
  select p_stage is not null and p_stage = any (public._vocab_list('svc_stage'))
$$;

-- Legal RMA moves (SPEC §1.4 + A8, A10). with_vendor and back_from_vendor are
-- reachable only through rma_dispatch / rma_vendor_result (and with_vendor ->
-- returning only through rma_vendor_result 'shipped_to_customer'); rma_move
-- refuses those. The JS copy (RMA_TRANSITIONS) must stay identical.
-- Budgets (days, JS side): with_tech 1 (ball: shop), logged 3, received 1,
-- testing 2, awaiting_docs 3, ready_to_ship 3, with_vendor = vendor TAT,
-- back_from_vendor 1, customer_decision 3, ready_to_return 5/1/1, returning 4.
create or replace function public.rma_transition_ok(p_from text, p_to text)
returns boolean
language sql immutable parallel safe
set search_path = public
as $$
  select case p_from
    when 'with_tech'         then p_to in ('received','ready_to_ship','closed')
    when 'logged'            then p_to in ('received','closed')
    when 'received'          then p_to in ('testing','awaiting_docs','ready_to_ship','customer_decision','ready_to_return')
    when 'testing'           then p_to in ('awaiting_docs','ready_to_ship','customer_decision','ready_to_return')
    when 'awaiting_docs'     then p_to in ('testing','ready_to_ship','customer_decision','ready_to_return')
    when 'ready_to_ship'     then p_to in ('with_vendor','testing','awaiting_docs','ready_to_return')
    when 'with_vendor'       then p_to in ('back_from_vendor','customer_decision','returning')
    when 'back_from_vendor'  then p_to in ('testing','customer_decision','ready_to_return','closed')
    when 'customer_decision' then p_to in ('ready_to_ship','ready_to_return','closed')
    when 'ready_to_return'   then p_to in ('returning','closed')
    when 'returning'         then p_to in ('closed')
    else false
  end
$$;

-- ── Labels (messages and timeline bodies). Kept identical to the JS model. ──
create or replace function public._svc_stage_label(p text)
returns text language sql immutable set search_path = public as $$
  select case p
    when 'logged'           then 'Logged — not in hand yet'
    when 'received'         then 'Received at counter'
    when 'diagnosing'       then 'Diagnosing'
    when 'quoted'           then 'Quote sent — awaiting approval'
    when 'approved'         then 'Approved — queued for bench'
    when 'parts_to_order'   then 'Parts to order'
    when 'parts_on_order'   then 'Parts on order'
    when 'rma_raised'       then 'RMA raised — not shipped yet'
    when 'at_vendor'        then 'At vendor'
    when 'back_from_vendor' then 'Back from vendor'
    when 'in_service'       then 'On the bench'
    when 'verifying'        then 'Verifying / soak'
    when 'ready'            then 'Ready for collection'
    when 'closed'           then 'Closed'
    when 'scheduled'        then 'Visit scheduled'
    when 'en_route'         then 'Technician en route'
    when 'on_site'          then 'On site'
    when 'work_done'        then 'Work done — awaiting sign-off'
    when 'revisit_needed'   then 'Revisit needed'
    when 'session_booked'   then 'Remote session booked'
    when 'in_session'       then 'In remote session'
    when 'resolved'         then 'Resolved remotely — confirming'
    else coalesce(p, 'Unknown')
  end
$$;

create or replace function public._svc_type_label(p text)
returns text language sql immutable set search_path = public as $$
  select case p when 'in_store' then 'In-store' when 'on_site' then 'On-site' when 'remote' then 'Remote'
                else coalesce(p, 'Unknown') end
$$;

-- "an on-site ticket" reads better than "a On-site ticket".
create or replace function public._svc_type_phrase(p text)
returns text language sql immutable set search_path = public as $$
  select case p when 'in_store' then 'an in-store' when 'on_site' then 'an on-site' when 'remote' then 'a remote'
                else 'this' end
$$;

create or replace function public._svc_channel_label(p text)
returns text language sql immutable set search_path = public as $$
  select case p when 'walk_in' then 'Walk-in' when 'phone' then 'Phone' when 'whatsapp' then 'WhatsApp'
                when 'website' then 'Website' when 'courier' then 'Courier' when 'staff' then 'Staff'
                else coalesce(p, 'Unknown') end
$$;

create or replace function public._svc_outcome_label(p text)
returns text language sql immutable set search_path = public as $$
  select case p
    when 'repaired'                then 'Repaired and collected'
    when 'unrepairable'            then 'Returned unrepaired'
    when 'declined'                then 'Quote declined, item returned'
    when 'no_fault_found'          then 'No fault found, item returned'
    when 'replaced_under_warranty' then 'Replaced under warranty'
    when 'cancelled'               then 'Cancelled'
    when 'resolved_on_site'        then 'Fixed during our visit'
    when 'resolved_remotely'       then 'Fixed remotely'
    when 'returned_rma_pending'    then 'Returned to you — your part is still under warranty claim'
    else coalesce(p, '') end
$$;

create or replace function public._item_kind_label(p text)
returns text language sql immutable set search_path = public as $$
  select case p
    when 'pc' then 'Desktop PC' when 'laptop' then 'Laptop' when 'gpu' then 'Graphics card'
    when 'psu' then 'Power supply' when 'ram' then 'RAM' when 'ssd' then 'SSD' when 'hdd' then 'Hard drive'
    when 'motherboard' then 'Motherboard' when 'cpu' then 'Processor' when 'cooler' then 'Cooler'
    when 'monitor' then 'Monitor' when 'peripheral' then 'Peripheral' else 'Part' end
$$;

-- What a customer may see of a part: kind + brand + model. Never the serial.
create or replace function public._rma_label(p_kind text, p_brand text, p_model text)
returns text language sql immutable set search_path = public as $$
  select concat_ws(' · ', public._item_kind_label(p_kind),
                   nullif(btrim(concat_ws(' ', nullif(btrim(p_brand), ''), nullif(btrim(p_model), ''))), ''))
$$;

create or replace function public._rma_stage_label(p text)
returns text language sql immutable set search_path = public as $$
  select case p
    when 'with_tech'         then 'With our technician'
    when 'logged'            then 'Expected — not in hand'
    when 'received'          then 'Received'
    when 'testing'           then 'Testing'
    when 'awaiting_docs'     then 'Waiting on documents / approval'
    when 'ready_to_ship'     then 'Ready to ship to vendor'
    when 'with_vendor'       then 'With vendor'
    when 'back_from_vendor'  then 'Back from vendor'
    when 'customer_decision' then 'Waiting on customer decision'
    when 'ready_to_return'   then 'Ready to return'
    when 'returning'         then 'Returning by courier'
    when 'closed'            then 'Closed'
    else coalesce(p, 'Unknown') end
$$;

create or replace function public._rma_disposition_label(p text)
returns text language sql immutable set search_path = public as $$
  select case p
    when 'refitted'              then 'Fitted back in your device'
    when 'replaced'              then 'Replaced under warranty'
    when 'repaired'              then 'Repaired under warranty'
    when 'credit_note'           then 'Settled with the manufacturer by credit'
    when 'rejected_returned'     then 'Warranty claim declined — part returned'
    when 'no_fault_found'        then 'No fault found — part returned'
    when 'out_of_warranty'       then 'Out of warranty — part returned'
    when 'withdrawn'             then 'Claim withdrawn'
    when 'converted_to_repair'   then 'Moved to a paid repair'
    when 'restocked'             then 'Replaced from our stock'
    when 'scrapped_with_consent' then 'Disposed of with your consent'
    when 'lost_compensated'      then 'Settled for a lost part'
    else 'Closed' end
$$;

create or replace function public._rma_stage_customer(p text, p_return_method text default null)
returns text language sql immutable set search_path = public as $$
  select case p
    when 'with_tech'         then 'Your part is with our technician'
    when 'logged'            then 'We''re expecting your part'
    when 'received'          then 'Your part is with us'
    when 'testing'           then 'We''re checking the part'
    when 'awaiting_docs'     then 'Waiting for you — we need a document or your approval'
    when 'ready_to_ship'     then 'Warranty claim being prepared'
    when 'with_vendor'       then 'With the manufacturer under warranty'
    when 'back_from_vendor'  then 'Back from the manufacturer'
    when 'customer_decision' then 'Waiting for your decision'
    -- Same words as the JS model (rmaCustomerLabel): a held part going back
    -- inside the customer's own device is being refitted, not packed.
    when 'ready_to_return'   then case when p_return_method = 'collect'     then 'Ready to collect'
                                       when p_return_method = 'with_device' then 'Being fitted back in your device'
                                       else 'Being packed for return' end
    when 'returning'         then 'On its way back to you'
    when 'closed'            then 'Closed'
    else 'In progress' end
$$;

create or replace function public._rma_source_label(p text)
returns text language sql immutable set search_path = public as $$
  select case p when 'from_ticket' then 'From a service ticket' when 'walk_in' then 'Walk-in'
                when 'courier' then 'Courier' when 'field' then 'Collected on site'
                when 'stock' then 'Shop stock' when 'website' then 'Logged online'
                else coalesce(p, 'Unknown') end
$$;

create or replace function public._rma_result_word(p_result text)
returns text language sql immutable set search_path = public as $$
  select case p_result when 'replaced' then 'replaced' when 'repaired' then 'repaired'
                       when 'credit_note' then 'settled by credit note' when 'rejected' then 'claim declined'
                       when 'lost' then 'lost in transit'
                       when 'shipped_to_customer' then 'shipped straight to you' else null end
$$;

-- Who the CUSTOMER is told has their part (SPEC-AMENDMENTS A13): the part's
-- brand when we know it, else the vendor's public name — but never a
-- distributor's: its public name is usually its trading name, so a part with
-- no brand sent to a distributor reads as null and every caller says "the
-- manufacturer". The kind is a required argument so no caller can forget it.
drop function if exists public._rma_party (text, text);
create or replace function public._rma_party(p_brand text, p_vendor_public text, p_vendor_kind text)
returns text language sql immutable set search_path = public as $$
  select coalesce(nullif(btrim(coalesce(p_brand, '')), ''),
                  case when p_vendor_kind is distinct from 'distributor'
                       then nullif(btrim(coalesce(p_vendor_public, '')), '') end)
$$;

-- The drive-data answer in the plain words the UI uses (A11).
create or replace function public._rma_data_label(p text)
returns text language sql immutable set search_path = public as $$
  select case p when 'wiped_by_us' then 'We wiped it'
                when 'customer_consents' then 'Customer agreed to send it with data'
                when 'unreadable_informed' then 'Drive unreadable — customer informed'
                else coalesce(p, 'not set') end
$$;

-- Event bodies and messages speak shop time, not UTC: "Thu 23 Oct, 2:30 pm".
create or replace function public._ist(p timestamptz)
returns text language sql stable set search_path = public as $$
  select case when p is null then null
              else to_char(p at time zone 'Asia/Kolkata', 'Dy FMDD Mon, FMHH12:MI am') end
$$;

create or replace function public._inr(p numeric)
returns text language sql immutable set search_path = public as $$
  select case when p is null then '—'
              when p = trunc(p) then '₹' || to_char(p, 'FM999999990')
              else '₹' || to_char(p, 'FM999999990.00') end
$$;

-- ── Transaction-local flags: set returns the previous value, restore puts it
--    back, so a nested caller never clears a flag its outer caller relies on.
create or replace function public._flag_set(p_name text)
returns text language plpgsql volatile set search_path = public as $$
declare v_prev text := current_setting(p_name, true);
begin
  perform set_config(p_name, '1', true);
  return coalesce(v_prev, '');
end $$;

create or replace function public._flag_restore(p_name text, p_prev text)
returns void language plpgsql volatile set search_path = public as $$
begin
  perform set_config(p_name, coalesce(p_prev, ''), true);
end $$;

-- ── jsonb payload readers. Every RPC that takes a jsonb goes through these, so
--    a wrong shape becomes a sentence instead of a cast error, and an empty
--    string means "not given".
create or replace function public._jtxt(p jsonb, k text, maxlen int default 2000, label text default null)
returns text language plpgsql stable set search_path = public as $$
declare v text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or not (p ? k) or jsonb_typeof(p -> k) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p -> k) in ('object', 'array') then
    raise exception 'NEO_GATE: % has the wrong shape.', coalesce(label, k);
  end if;
  v := btrim(p ->> k, E' \t\r\n');
  if v = '' then return null; end if;
  if length(v) > maxlen then
    raise exception 'NEO_GATE: % is too long — keep it under % characters.', coalesce(label, k), maxlen;
  end if;
  return v;
end $$;

create or replace function public._jbool(p jsonb, k text, label text default null)
returns boolean language plpgsql stable set search_path = public as $$
declare v_t text; v_s text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or not (p ? k) then return null; end if;
  v_t := jsonb_typeof(p -> k);
  if v_t = 'null' then return null; end if;
  if v_t = 'boolean' then return (p ->> k)::boolean; end if;
  if v_t = 'string' then
    v_s := lower(btrim(p ->> k));
    if v_s = '' then return null; end if;
    if v_s in ('true', 'yes', '1') then return true; end if;
    if v_s in ('false', 'no', '0') then return false; end if;
  end if;
  raise exception 'NEO_GATE: % must be yes or no.', coalesce(label, k);
end $$;

create or replace function public._jts(p jsonb, k text, label text default null)
returns timestamptz language plpgsql stable set search_path = public as $$
declare v text := public._jtxt(p, k, 64, label);
begin
  if v is null then return null; end if;
  begin
    return v::timestamptz;
  exception when others then
    raise exception 'NEO_GATE: % is not a valid date and time.', coalesce(label, k);
  end;
end $$;

create or replace function public._jdate(p jsonb, k text, label text default null)
returns date language plpgsql stable set search_path = public as $$
declare v text := public._jtxt(p, k, 40, label);
begin
  if v is null then return null; end if;
  begin
    return left(v, 10)::date;
  exception when others then
    raise exception 'NEO_GATE: % is not a valid date.', coalesce(label, k);
  end;
end $$;

create or replace function public._jnum(p jsonb, k text, label text default null)
returns numeric language plpgsql stable set search_path = public as $$
declare v text := public._jtxt(p, k, 40, label);
begin
  if v is null then return null; end if;
  begin
    return v::numeric;
  exception when others then
    raise exception 'NEO_GATE: % must be a number.', coalesce(label, k);
  end;
end $$;

create or replace function public._jint(p jsonb, k text, label text default null, lo int default 0, hi int default 1000000)
returns int language plpgsql stable set search_path = public as $$
declare v numeric := public._jnum(p, k, label);
begin
  if v is null then return null; end if;
  if v <> trunc(v) or v < lo or v > hi then
    raise exception 'NEO_GATE: % must be a whole number between % and %.', coalesce(label, k), lo, hi;
  end if;
  return v::int;
end $$;

create or replace function public._juuid(p jsonb, k text)
returns uuid language plpgsql stable set search_path = public as $$
declare v text := public._jtxt(p, k, 64, k);
begin
  if v is null then return null; end if;
  begin
    return v::uuid;
  exception when others then
    raise exception 'NEO_GATE: % is not a valid UUID.', k;
  end;
end $$;

-- A list of short strings, trimmed, empties dropped, duplicates removed, order kept.
create or replace function public._jtxtarr(p jsonb, k text, maxitems int default 30, maxlen int default 80, label text default null)
returns text[] language plpgsql stable set search_path = public as $$
declare v jsonb; e jsonb; s text; v_out text[] := '{}';
begin
  if p is null or jsonb_typeof(p) <> 'object' or not (p ? k) then return v_out; end if;
  v := p -> k;
  if jsonb_typeof(v) = 'null' then return v_out; end if;
  if jsonb_typeof(v) <> 'array' then
    raise exception 'NEO_GATE: % must be a list.', coalesce(label, k);
  end if;
  if jsonb_array_length(v) > maxitems then
    raise exception 'NEO_GATE: % can have at most % entries.', coalesce(label, k), maxitems;
  end if;
  for e in select value from jsonb_array_elements(v) loop
    if jsonb_typeof(e) not in ('string', 'number') then
      raise exception 'NEO_GATE: % must be a list of words.', coalesce(label, k);
    end if;
    s := btrim(e #>> '{}', E' \t\r\n');
    if s = '' then continue; end if;
    if length(s) > maxlen then
      raise exception 'NEO_GATE: An entry in % is too long — keep it under % characters.', coalesce(label, k), maxlen;
    end if;
    if not (s = any (v_out)) then v_out := array_append(v_out, s); end if;
  end loop;
  return v_out;
end $$;


-- =============================================================================
-- §2  MODULE ACCESS — who may open which module, and as what
-- =============================================================================

create table if not exists public.module_access (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  module     text not null check (module in ('service','rma','qc','neohr')),
  role       text not null check (role in ('desk','tech','lead')),
  granted_by text,
  granted_at timestamptz default now(),
  primary key (profile_id, module)
);

-- Tier of the caller, but only while they are an active staff member. Returns
-- 0 instead of raising: this is evaluated inside RLS policies, where an error
-- would turn "you can't see this" into "the screen is broken".
create or replace function public.my_tier()
returns int
language sql stable security definer
set search_path = public
as $$
  select coalesce((select p.tier from public.profiles p
                    where p.id = auth.uid() and p.active and coalesce(p.is_staff, false)), 0)
$$;

-- Tier 3 and above are leads of every module automatically (that keeps
-- v1.9.11 leads exactly where they are). Everyone else needs a row.
create or replace function public.module_role(p_module text)
returns text
language sql stable security definer
set search_path = public
as $$
  select case
           when public.my_tier() >= 3 then 'lead'
           else (select ma.role
                   from public.module_access ma
                   join public.profiles p on p.id = ma.profile_id
                  where ma.profile_id = auth.uid() and ma.module = p_module
                    and p.active and coalesce(p.is_staff, false))
         end
$$;

-- An unknown minimum role means "nobody", never "everybody" (rank 0 >= 0).
create or replace function public.has_module(p_module text, p_min text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.role_rank(p_min) > 0
     and public.role_rank(public.module_role(p_module)) >= public.role_rank(p_min)
$$;

create or replace function public.my_modules()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
    'service', public.module_role('service'),
    'rma',     public.module_role('rma'),
    'qc',      public.module_role('qc'),
    'neohr',   public.module_role('neohr'),
    'tier',    public.my_tier())
$$;

create or replace function public.svc_reader()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.has_module('service', 'desk')
$$;

create or replace function public.rma_reader()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.has_module('rma', 'desk') or public.has_module('service', 'desk')
$$;

-- The same rule evaluated for SOMEONE ELSE (the target of an assignment, a
-- suggestion, a lead posting for the assignee).
create or replace function public._module_role_of(p_profile_id uuid, p_module text)
returns text
language sql stable security definer
set search_path = public
as $$
  select case when p.tier >= 3 then 'lead'
              else (select ma.role from public.module_access ma
                     where ma.profile_id = p.id and ma.module = p_module) end
    from public.profiles p
   where p.id = p_profile_id and p.active and coalesce(p.is_staff, false)
$$;

-- The caller's profile, or NEO_DENIED. Every RPC starts with this.
create or replace function public._neo_me()
returns public.profiles
language plpgsql stable security definer
set search_path = public
as $$
declare v public.profiles;
begin
  select * into v from public.profiles
   where id = auth.uid() and active and coalesce(is_staff, false);
  if not found then
    raise exception 'NEO_DENIED: Sign in with an active staff account to do this.';
  end if;
  return v;
end $$;

-- An active staff profile by email, or a row of nulls.
create or replace function public._staff_by_email(p_email text)
returns public.profiles
language plpgsql stable security definer
set search_path = public
as $$
declare v public.profiles;
begin
  if nullif(btrim(coalesce(p_email, '')), '') is null then return v; end if;
  select * into v from public.profiles
   where lower(email) = lower(btrim(p_email)) and active and coalesce(is_staff, false)
   limit 1;
  return v;
end $$;


-- =============================================================================
-- §3  CUSTOMERS — one row per normalised phone number
-- =============================================================================

create table if not exists public.customers (
  id         uuid primary key default gen_random_uuid(),
  phone_norm text unique not null check (length(phone_norm) between 7 and 15),
  name       text,
  email      text,
  alt_phone  text,
  kind       text not null default 'person' check (kind in ('person','business','trade_partner')),
  address    text,
  area       text,
  pincode    text,
  landmark   text,
  maps_url   text,
  lat        double precision,
  lng        double precision,
  notes      text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  created_by text
);

-- Upsert by phone. The FIRST name we were given wins (a typo on a later ticket
-- must not rename a regular customer), and an email is only ever filled in.
create or replace function public._customer_upsert(p_phone text, p_name text, p_email text, p_by text)
returns uuid
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_norm text := public.norm_phone(p_phone);
  v_id uuid;
begin
  if not public.phone_ok(p_phone) then return null; end if;
  insert into public.customers as cu (phone_norm, name, email, created_by)
  values (v_norm, nullif(btrim(coalesce(p_name, '')), ''), nullif(lower(btrim(coalesce(p_email, ''))), ''), p_by)
  on conflict (phone_norm) do update
     set name = coalesce(nullif(cu.name, ''), excluded.name),
         email = coalesce(cu.email, excluded.email),
         updated_at = now()
  returning cu.id into v_id;
  return v_id;
end $$;

-- Re-run safety: a customer row written by an earlier copy of norm_phone (10
-- digits, or a "00971…" number kept with its 00) is brought to the current
-- shape, unless that would collide with a row that already has it (then both
-- stay; the lookup matches tickets by phone).
update public.customers c
   set phone_norm = public.norm_phone(c.phone_norm)
 where c.phone_norm is distinct from public.norm_phone(c.phone_norm)
   and length(public.norm_phone(c.phone_norm)) between 7 and 15
   and not exists (select 1 from public.customers c2 where c2.phone_norm = public.norm_phone(c.phone_norm));


-- =============================================================================
-- §4  SERVICE_JOBS — new columns (all nullable or defaulted: v1.9.11 ignores them)
-- =============================================================================

alter table public.service_jobs add column if not exists model_version smallint not null default 1;
alter table public.service_jobs add column if not exists service_type text not null default 'in_store'
  check (service_type in ('in_store','on_site','remote'));
alter table public.service_jobs add column if not exists channel text not null default 'walk_in'
  check (channel in ('walk_in','phone','whatsapp','website','courier','staff'));
alter table public.service_jobs add column if not exists category text
  check (category in ('repair','warranty_claim','upgrade','installation','data_recovery','os_software',
                      'networking','maintenance','diagnosis_only'));
alter table public.service_jobs add column if not exists priority text not null default 'normal'
  check (priority in ('low','normal','high','urgent'));
alter table public.service_jobs add column if not exists priority_reason text;
alter table public.service_jobs add column if not exists priority_set_by text;
alter table public.service_jobs add column if not exists fault_keys text[] not null default '{}';
alter table public.service_jobs add column if not exists customer_id uuid references public.customers(id) on delete set null;
alter table public.service_jobs add column if not exists created_by_email text;
alter table public.service_jobs add column if not exists created_by_name text;
alter table public.service_jobs add column if not exists suggested_tech_email text;
alter table public.service_jobs add column if not exists suggest_reason text;
alter table public.service_jobs add column if not exists assigned_via text
  check (assigned_via in ('claim','manager','legacy','self'));
alter table public.service_jobs add column if not exists assigned_at timestamptz;
alter table public.service_jobs add column if not exists assign_reason text;
alter table public.service_jobs add column if not exists queued_at timestamptz;
alter table public.service_jobs add column if not exists needed_by timestamptz;
alter table public.service_jobs add column if not exists window_start timestamptz;
alter table public.service_jobs add column if not exists window_end timestamptz;
alter table public.service_jobs add column if not exists window_note text;
alter table public.service_jobs add column if not exists visit_start timestamptz;
alter table public.service_jobs add column if not exists visit_end timestamptz;
alter table public.service_jobs add column if not exists visit_count int not null default 0;
alter table public.service_jobs add column if not exists site_address text;
alter table public.service_jobs add column if not exists site_area text;
alter table public.service_jobs add column if not exists site_pincode text;
alter table public.service_jobs add column if not exists site_landmark text;
alter table public.service_jobs add column if not exists site_maps_url text;
alter table public.service_jobs add column if not exists site_lat double precision;
alter table public.service_jobs add column if not exists site_lng double precision;
alter table public.service_jobs add column if not exists site_contact text;
alter table public.service_jobs add column if not exists remote_tool text
  check (remote_tool in ('anydesk','teamviewer','rustdesk','quick_assist','chrome_remote','other'));
alter table public.service_jobs add column if not exists remote_session_ref text;
alter table public.service_jobs add column if not exists remote_consent_at timestamptz;
alter table public.service_jobs add column if not exists converted_from text
  check (converted_from in ('in_store','on_site','remote'));
alter table public.service_jobs add column if not exists accessories text[] not null default '{}';
alter table public.service_jobs add column if not exists condition_note text;
alter table public.service_jobs add column if not exists powers_on boolean;
alter table public.service_jobs add column if not exists data_consent text
  check (data_consent in ('backup_ok','no_backup','customer_backed_up'));
alter table public.service_jobs add column if not exists est_minutes int;
alter table public.service_jobs add column if not exists client_request_id uuid unique;

-- Enumeration CHECKs that predate this file (if any) only know the old keys
-- and would reject 'scheduled', 'returned_rma_pending', an event kind 'claim'
-- or an actor_kind 'system'. For each column below, every PURE enumeration
-- check on it (a compound rule with AND / OR is a business rule and stays) is
-- replaced by one <table>_<column>_v2_check holding the UNION of its old
-- values and ours — never narrower than before. NOT VALID + a tolerant
-- VALIDATE, so one odd legacy row can never block the migration. Re-running
-- folds the previous v2 check into the new one the same way. service_jobs
-- stage / outcome always get the check (the v2 vocabulary is the contract);
-- service_events kind / actor_kind only when one existed, so a column that
-- never had a list does not gain one that an old client could trip over.
do $$
declare
  c record;
  r record;
  v_vals text[];
  v_list text;
  v_name text;
  v_found boolean;
begin
  for c in
    select * from (values
      ('service_jobs', 'stage', true, array[
        'logged','received','diagnosing','quoted','approved','parts_to_order','parts_on_order','rma_raised',
        'at_vendor','back_from_vendor','in_service','verifying','ready','closed','scheduled','en_route',
        'on_site','work_done','revisit_needed','session_booked','in_session','resolved']),
      ('service_jobs', 'outcome', true, array[
        'repaired','unrepairable','declined','no_fault_found','replaced_under_warranty','cancelled',
        'resolved_on_site','resolved_remotely','returned_rma_pending']),
      ('service_events', 'kind', false, array[
        'stage','note','edit','media','claim','release','assign','rma','field','suggest','priority']),
      ('service_events', 'actor_kind', false, array['staff','system','customer','website','neohr'])
    ) as t(tbl, col, always_add, vals)
  loop
    v_name := c.tbl || '_' || c.col || '_v2_check';
    v_vals := c.vals;
    v_found := false;
    for r in
      select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
       where conrelid = format('public.%I', c.tbl)::regclass and contype = 'c'
    loop
      -- Matches "(stage = ANY (ARRAY[" and the varchar form "((stage)::text = ANY ((ARRAY[".
      -- \m…\M: "kind" never matches inside "actor_kind" (underscore is a word character).
      if (r.def ~* ('\m' || c.col || '\M\)?(::[a-z ]+)?\s*=\s*any\s*\(')
          or r.def ~* ('\m' || c.col || '\M\)?(::[a-z ]+)?\s+in\s*\('))
         and r.def !~* '\m(and|or)\M' then
        v_vals := v_vals || coalesce((select array_agg(m[1]) from regexp_matches(r.def, '''([^'']*)''', 'g') as m), '{}'::text[]);
        v_found := true;
        execute format('alter table public.%I drop constraint %I', c.tbl, r.conname);
        if r.conname <> v_name then
          raise notice 'service_v2_rma: folded old constraint % (%) into %', r.conname, r.def, v_name;
        end if;
      end if;
    end loop;
    continue when not (c.always_add or v_found);

    select string_agg(quote_literal(x), ', ' order by x) into v_list
      from (select distinct unnest(v_vals) as x) s where x is not null and x <> '';
    execute format('alter table public.%I add constraint %I check (%I in (%s)) not valid', c.tbl, v_name, c.col, v_list);
    begin
      execute format('alter table public.%I validate constraint %I', c.tbl, v_name);
    exception when check_violation then
      raise notice 'service_v2_rma: a legacy row in %.% has an unknown value; % applies to new writes only',
        c.tbl, c.col, v_name;
    end;
  end loop;
end $$;

create index if not exists sj_open_assignee_idx on public.service_jobs (assignee_email) where stage <> 'closed';
create index if not exists sj_queue_idx on public.service_jobs (queued_at) where assignee_email is null and stage <> 'closed';
create index if not exists sj_phone_norm_idx on public.service_jobs (public.norm_phone(customer_phone));
create index if not exists sj_customer_idx on public.service_jobs (customer_id);
create index if not exists sj_visit_idx on public.service_jobs (visit_start) where visit_start is not null;
create index if not exists sj_created_by_idx on public.service_jobs (created_by_email, created_at desc);


-- =============================================================================
-- §5  SERVICE_ITEMS — every physical thing accepted on a ticket
-- =============================================================================

create table if not exists public.service_items (
  id                text primary key default public.new_text_id('si'),
  job_id            text not null references public.service_jobs(id) on delete cascade,
  sort              int not null default 0,
  is_primary        boolean not null default false,
  kind              text not null default 'other'
                    check (kind in ('pc','laptop','gpu','psu','ram','ssd','hdd','motherboard','cpu','cooler',
                                    'monitor','peripheral','other')),
  label             text,
  serial            text,
  serial_norm       text generated always as
                    (upper(regexp_replace(coalesce(serial, ''), '[^A-Za-z0-9]', '', 'g'))) stored,
  purchase_source   text not null default 'unknown' check (purchase_source in ('neo_tokyo','elsewhere','unknown')),
  build_ticket_id   text references public.tickets(id) on delete set null,
  invoice_no        text,
  purchase_date     date,
  condition_remarks text,
  accessories       text[] not null default '{}',
  powers_on         boolean,
  returned_at       timestamptz,
  created_at        timestamptz default now(),
  created_by        text
);

create unique index if not exists one_primary_item on public.service_items (job_id) where is_primary;
create index if not exists si_serial_norm_idx on public.service_items (serial_norm) where serial_norm <> '';
create index if not exists si_job_idx on public.service_items (job_id, sort);


-- =============================================================================
-- §6  RMA — one row per physical part (rma_cases); parts that arrived together
--     share an rma_intakes row; shipments batch parts to and from vendors.
-- =============================================================================

create table if not exists public.rma_vendors (
  id               bigserial primary key,
  name             text not null unique,
  public_name      text not null,
  kind             text not null default 'brand' check (kind in ('brand','distributor','service_centre')),
  contact          text,
  address          text,
  portal_url       text,
  typical_tat_days int not null default 14 check (typical_tat_days between 1 and 365),
  active           boolean not null default true,
  created_at       timestamptz default now()
);

create table if not exists public.rma_intakes (
  id                 text primary key,
  source             text not null check (source in ('from_ticket','walk_in','courier','field','stock','website')),
  service_job_id     text references public.service_jobs(id) on delete set null,
  sender_kind        text not null default 'customer' check (sender_kind in ('customer','third_party_tech','our_tech','shop')),
  sender_name        text,
  sender_phone       text,
  sender_customer_id uuid references public.customers(id) on delete set null,
  inbound_courier    text,
  inbound_awb        text,
  received_at        timestamptz,
  return_method      text not null default 'collect' check (return_method in ('collect','courier','with_device')),
  return_address     text,
  notes              text,
  created_at         timestamptz default now(),
  created_by_email   text,
  created_by_name    text,
  client_request_id  uuid unique
);

create table if not exists public.rma_cases (
  id                  text primary key,
  public_code         text not null unique,
  intake_id           text not null references public.rma_intakes(id) on delete cascade,
  service_job_id      text references public.service_jobs(id) on delete set null,
  service_item_id     text references public.service_items(id) on delete set null,
  holds_ticket        boolean not null default false,
  kind                text not null default 'other'
                      check (kind in ('pc','laptop','gpu','psu','ram','ssd','hdd','motherboard','cpu','cooler',
                                      'monitor','peripheral','other')),
  brand               text,
  model               text,
  serial              text,
  serial_norm         text generated always as
                      (upper(regexp_replace(coalesce(serial, ''), '[^A-Za-z0-9]', '', 'g'))) stored,
  fault               text,
  diagnosed_by        text not null default 'customer' check (diagnosed_by in ('us','third_party','customer')),
  our_finding         text,
  owner_name          text,
  owner_phone         text,
  purchase_source     text not null default 'unknown' check (purchase_source in ('neo_tokyo','elsewhere','unknown')),
  invoice_no          text,
  purchase_date       date,
  build_ticket_id     text references public.tickets(id) on delete set null,
  vendor_id           bigint references public.rma_vendors(id),
  vendor_rma_no       text,
  expected_back_at    timestamptz,
  vendor_result       text check (vendor_result in ('replaced','repaired','credit_note','rejected','lost',
                                                    'shipped_to_customer')),
  vendor_reason       text,
  replacement_serial  text,
  replacement_serial_norm text generated always as
                      (upper(regexp_replace(coalesce(replacement_serial, ''), '[^A-Za-z0-9]', '', 'g'))) stored,
  data_handling       text check (data_handling in ('wiped_by_us','customer_consents','unreadable_informed')),
  intake_seq          smallint not null default 0,   -- position in the create payload (results come back in order)
  handling_fee        numeric(10,2),
  fee_status          text not null default 'n_a' check (fee_status in ('n_a','quoted','accepted','paid','waived')),
  fee_ref             text,
  fee_note            text,
  return_method       text not null default 'collect' check (return_method in ('collect','courier','with_device')),
  return_address      text,
  return_courier      text,
  return_awb          text,
  advance_replacement boolean not null default false,
  advance_serial      text,
  advance_at          timestamptz,
  stage               text not null default 'received'
                      check (stage in ('with_tech','logged','received','testing','awaiting_docs','ready_to_ship',
                                       'with_vendor','back_from_vendor','customer_decision','ready_to_return',
                                       'returning','closed')),
  stage_since         timestamptz not null default now(),
  disposition         text check (disposition in ('refitted','replaced','repaired','credit_note','rejected_returned',
                                                  'no_fault_found','out_of_warranty','withdrawn','converted_to_repair',
                                                  'restocked','scrapped_with_consent','lost_compensated')),
  handler_email       text,
  handler_name        text,
  followup_job_id     text references public.service_jobs(id) on delete set null,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  created_by_email    text,
  closed_at           timestamptz,
  closed_by           text
);

-- Re-run safety: a table made by an earlier copy of this file gets the
-- amendment columns and the widened stage / result lists.
alter table public.rma_cases add column if not exists replacement_serial_norm text generated always as
  (upper(regexp_replace(coalesce(replacement_serial, ''), '[^A-Za-z0-9]', '', 'g'))) stored;
alter table public.rma_cases add column if not exists data_handling text
  check (data_handling in ('wiped_by_us','customer_consents','unreadable_informed'));
alter table public.rma_cases add column if not exists intake_seq smallint not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.rma_cases'::regclass
                  and conname = 'rma_cases_stage_check' and pg_get_constraintdef(oid) like '%with_tech%') then
    alter table public.rma_cases drop constraint if exists rma_cases_stage_check;
    alter table public.rma_cases add constraint rma_cases_stage_check check (stage in (
      'with_tech','logged','received','testing','awaiting_docs','ready_to_ship','with_vendor','back_from_vendor',
      'customer_decision','ready_to_return','returning','closed'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.rma_cases'::regclass
                  and conname = 'rma_cases_vendor_result_check'
                  and pg_get_constraintdef(oid) like '%shipped_to_customer%') then
    alter table public.rma_cases drop constraint if exists rma_cases_vendor_result_check;
    alter table public.rma_cases add constraint rma_cases_vendor_result_check check (vendor_result in (
      'replaced','repaired','credit_note','rejected','lost','shipped_to_customer'));
  end if;
end $$;

create index if not exists rc_open_stage_idx on public.rma_cases (stage) where stage <> 'closed';
create index if not exists rc_job_idx on public.rma_cases (service_job_id) where service_job_id is not null;
create index if not exists rc_serial_norm_idx on public.rma_cases (serial_norm) where serial_norm <> '';
create index if not exists rc_repl_serial_norm_idx on public.rma_cases (replacement_serial_norm)
  where replacement_serial_norm <> '';
create index if not exists rc_vendor_out_idx on public.rma_cases (vendor_id) where stage = 'with_vendor';
create index if not exists rc_owner_phone_idx on public.rma_cases (public.norm_phone(owner_phone));
create index if not exists rc_intake_idx on public.rma_cases (intake_id);
-- rma_item_media_visible / rma_media_path_visible (§13) look parts up by ticket item.
create index if not exists rc_item_idx on public.rma_cases (service_item_id) where service_item_id is not null;
create index if not exists ri_job_idx on public.rma_intakes (service_job_id) where service_job_id is not null;
create index if not exists ri_sender_phone_idx on public.rma_intakes (public.norm_phone(sender_phone));

-- norm_phone() is IMMUTABLE and these indexes store its results. If an
-- earlier copy of this file built them with an older rule (10 digits, or a
-- "00…" number kept with its 00), the stored keys are stale and lookups
-- would silently miss; rebuild them. On a
-- first run this just rebuilds fresh indexes (small tables).
reindex index public.sj_phone_norm_idx;
reindex index public.rc_owner_phone_idx;
reindex index public.ri_sender_phone_idx;

create table if not exists public.rma_events (
  id               bigserial primary key,
  case_id          text not null references public.rma_cases(id) on delete cascade,
  at               timestamptz not null default now(),
  client_at        timestamptz,
  kind             text not null default 'note',   -- stage | note | edit | media | fee | link | system
  actor_kind       text not null default 'staff',
  actor_email      text,
  actor_name       text,
  from_stage       text,
  to_stage         text,
  body             text,
  customer_visible boolean not null default false,
  meta             jsonb not null default '{}'::jsonb
);
create index if not exists re_case_at_idx on public.rma_events (case_id, at);

-- mode (SPEC-AMENDMENTS A9): only a courier has an AWB; a hand delivery, a
-- vendor pickup or a bus parcel records who carried it (carried_by) or a note.
create table if not exists public.rma_shipments (
  id               bigserial primary key,
  direction        text not null check (direction in ('in_from_customer','out_to_vendor','in_from_vendor','out_to_customer')),
  mode             text not null default 'courier' check (mode in ('courier','hand_delivery','vendor_pickup','bus_parcel')),
  vendor_id        bigint references public.rma_vendors(id),
  courier          text,
  awb              text,
  carried_by       text,
  cost             numeric(10,2),
  notes            text,
  dispatched_at    timestamptz default now(),
  delivered_at     timestamptz,
  created_at       timestamptz default now(),
  created_by_email text
);
alter table public.rma_shipments add column if not exists mode text not null default 'courier'
  check (mode in ('courier','hand_delivery','vendor_pickup','bus_parcel'));
alter table public.rma_shipments add column if not exists carried_by text;

create table if not exists public.rma_shipment_items (
  shipment_id bigint references public.rma_shipments(id) on delete cascade,
  case_id     text references public.rma_cases(id) on delete cascade,
  primary key (shipment_id, case_id)
);
create index if not exists rsi_case_idx on public.rma_shipment_items (case_id);


-- =============================================================================
-- §7  SERVICE_MEDIA — extended, not replaced (v1.9.11 reads job_id + phase)
-- =============================================================================

alter table public.service_media alter column job_id drop not null;
alter table public.service_media add column if not exists rma_case_id text references public.rma_cases(id) on delete cascade;
alter table public.service_media add column if not exists service_item_id text references public.service_items(id) on delete set null;
alter table public.service_media add column if not exists role text
  check (role in ('condition','serial_label','invoice','damage','packing','unboxing','during','after',
                  'vendor_doc','return_condition','other'));
alter table public.service_media add column if not exists remark text;
alter table public.service_media add column if not exists remark_by text;
alter table public.service_media add column if not exists remark_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.service_media'::regclass and conname = 'service_media_owner') then
    alter table public.service_media add constraint service_media_owner
      check (job_id is not null or rma_case_id is not null);
  end if;
  -- An invoice, a serial label or a vendor document is never published to a
  -- customer's tracking page, whatever a checkbox says.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.service_media'::regclass and conname = 'service_media_private_roles') then
    alter table public.service_media add constraint service_media_private_roles
      check (not customer_visible or coalesce(role, 'condition') not in ('invoice','serial_label','vendor_doc'));
  end if;
  -- RMA-only roles (vendor_doc, return_condition, other) have no natural
  -- "phase"; give phase a default so a new-client insert can never trip a NOT
  -- NULL that v1.9.11 always satisfied by sending it.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'service_media'
                and column_name = 'phase' and column_default is null) then
    alter table public.service_media alter column phase set default 'intake';
  end if;
end $$;

create index if not exists sm_case_idx on public.service_media (rma_case_id, created_at) where rma_case_id is not null;
create index if not exists sm_item_idx on public.service_media (service_item_id) where service_item_id is not null;

-- What the photo trays upload: JPEG / PNG / WebP (re-encoded to JPEG by the
-- app), iPhone HEIC / HEIF stored as they are (A22), and PDF invoices and
-- vendor documents. Only ever ADD to an existing list: a null list means
-- "anything allowed", and writing a list there would tighten it (v1.9.11
-- uploads must keep working). The 15 MB size limit is left as it is.
update storage.buckets b
   set allowed_mime_types = (select array_agg(distinct x order by x)
                               from unnest(b.allowed_mime_types || array['image/jpeg','image/png','image/webp',
                                                                         'image/heic','image/heif','application/pdf']) x)
 where b.id = 'service-media'
   and b.allowed_mime_types is not null
   and not (b.allowed_mime_types @> array['image/jpeg','image/png','image/webp','image/heic','image/heif',
                                          'application/pdf']);


-- =============================================================================
-- §8  SERVICE_EVENTS — a meta column for links (old clients never send it)
-- =============================================================================

alter table public.service_events add column if not exists meta jsonb not null default '{}'::jsonb;
create index if not exists se_people_idx on public.service_events (kind, at) where kind in ('claim','release','assign');
-- (Old enumeration checks on service_events.kind / actor_kind were widened in §4.)


-- =============================================================================
-- §9  FIELD ACTIVITY — the NeoHR contract (desktop field buttons are the first producer)
-- =============================================================================

create table if not exists public.field_activity (
  id                uuid primary key default gen_random_uuid(),
  client_request_id uuid not null unique,
  employee_email    text not null,
  employee_name     text,
  module            text not null default 'service',
  ref_type          text not null default 'service_job',
  ref_id            text,
  kind              text not null check (kind in ('punch_in','punch_out','left_base','arrived','departed','note','photo')),
  outcome           text check (outcome in ('done','revisit_needed','parts_needed','customer_absent')),
  at                timestamptz not null,
  received_at       timestamptz not null default now(),
  lat               double precision,
  lng               double precision,
  accuracy_m        double precision,
  note              text,
  media_path        text,
  source            text not null default 'desktop' check (source in ('desktop','neohr')),
  applied           boolean,
  applied_note      text
);
create index if not exists fa_employee_at_idx on public.field_activity (lower(employee_email), at);
create index if not exists fa_ref_idx on public.field_activity (ref_type, ref_id) where ref_id is not null;


-- =============================================================================
-- §10  TRIGGERS
--      All trigger functions are SECURITY DEFINER: they must work the same for
--      a v1.9.11 direct write, a column-grant update, and an RPC — and some of
--      them call internal helpers that no client role may execute.
-- =============================================================================

-- ── customers: keep phone_norm normalised whoever writes it ─────────────────
create or replace function public.tg_customers_touch()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.phone_norm := public.norm_phone(new.phone_norm);
  if tg_op = 'UPDATE' then
    new.updated_at := now();
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  return new;
end $$;

drop trigger if exists trg_customers_touch on public.customers;
create trigger trg_customers_touch before insert or update on public.customers
  for each row execute function public.tg_customers_touch();

-- ── service_jobs BEFORE INSERT: link the customer (old clients too) ─────────
create or replace function public.tg_service_jobs_customer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('neo.migrating', true) = '1' then return new; end if;
  if new.customer_id is null and public.phone_ok(new.customer_phone) then
    new.customer_id := public._customer_upsert(new.customer_phone, new.customer_name, new.customer_email,
                                               coalesce(auth.email(), 'system'));
  end if;
  return new;
end $$;

drop trigger if exists trg_service_jobs_customer on public.service_jobs;
create trigger trg_service_jobs_customer before insert on public.service_jobs
  for each row execute function public.tg_service_jobs_customer();

-- ── service_jobs BEFORE INSERT: fill what an old client cannot know ─────────
create or replace function public.tg_service_jobs_defaults()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_me public.profiles;
begin
  if current_setting('neo.migrating', true) = '1' then return new; end if;

  -- A direct insert (not service_create) carries only what v1.9.11 sends.
  -- Who has the ticket, its priority, a suggestion and the v2 bookkeeping are
  -- set by service_create / claim / assign / priority, which check who may do
  -- what; the guard's step 0 holds the same columns on UPDATE. Every v1.9.11
  -- user is tier 3+ (a lead of every module) and v2 clients always create
  -- through service_create, so this only stops a hand-made write.
  if coalesce(current_setting('neo.rpc', true), '') <> '1' and not public.has_module('service', 'lead')
     and (new.assignee is not null or new.assignee_email is not null or new.assigned_via is not null
          or new.assigned_at is not null or new.assign_reason is not null
          or new.priority is distinct from 'normal' or new.priority_reason is not null or new.priority_set_by is not null
          or new.suggested_tech_email is not null or new.suggest_reason is not null
          or new.queued_at is not null or new.visit_count is distinct from 0 or new.converted_from is not null
          or new.model_version is distinct from 1 or new.service_type is distinct from 'in_store'
          or new.client_request_id is not null or new.created_by_email is not null or new.created_by_name is not null) then
    raise exception 'NEO_DENIED: Create the ticket with New ticket — who has it, its priority and suggestions are set through their own actions.';
  end if;

  -- A v2 ticket still carries a job_kind, because v1.9.11's board and the
  -- website's fallback item label read it. repair_own is decided later, by the
  -- items trigger, once we know the primary item is one of our builds.
  if new.model_version >= 2 and new.job_kind is null then
    new.job_kind := case new.category when 'warranty_claim' then 'warranty_rma'
                                      when 'upgrade' then 'upgrade'
                                      else 'repair_outside' end;
  end if;
  if new.category is null then
    new.category := case new.job_kind when 'warranty_rma' then 'warranty_claim'
                                      when 'upgrade' then 'upgrade'
                                      else 'repair' end;
  end if;

  if new.assignee_email is not null and new.assigned_via is null then
    new.assigned_via := 'legacy';
    new.assigned_at := coalesce(new.assigned_at, now());
  end if;
  if new.queued_at is null and new.assignee_email is null and new.stage is distinct from 'closed' then
    new.queued_at := now();
  end if;

  if new.model_version >= 2 then
    if not public.svc_stage_legal(new.service_type, new.stage) then
      raise exception 'NEO_GATE: % is not a step for % ticket.',
        public._svc_stage_label(new.stage), public._svc_type_phrase(new.service_type);
    end if;
    if new.stage in ('rma_raised','at_vendor','back_from_vendor')
       and current_setting('neo.sync', true) is distinct from '1' then
      raise exception 'NEO_RMA_HOLD: Raise the RMA from the Items tab — the ticket follows the part automatically.';
    end if;
  elsif new.stage is not null and not public.svc_known_stage(new.stage) then
    raise exception 'NEO_GATE: "%" is not a known ticket stage.', new.stage;
  end if;

  if new.created_by_email is null then
    select * into v_me from public.profiles where id = auth.uid();
    if found then
      new.created_by_email := v_me.email;
      new.created_by_name := coalesce(new.created_by_name, v_me.full_name);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_service_jobs_defaults on public.service_jobs;
create trigger trg_service_jobs_defaults before insert on public.service_jobs
  for each row execute function public.tg_service_jobs_defaults();

-- ── service_jobs BEFORE UPDATE: the guard ──────────────────────────────────
-- Order (SPEC §2.4): protected columns, stage/type rules + RMA hold, legacy
-- assignment stamping, close/reopen bookkeeping, customer re-link, updated_at.
create or replace function public.tg_service_jobs_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  -- coalesce: a flag never set in this session reads as NULL, and "not NULL"
  -- would silently skip every check below.
  v_sync boolean := coalesce(current_setting('neo.sync', true), '') = '1';
  v_assign boolean := coalesce(current_setting('neo.assign', true), '') = '1';
  v_rpc boolean := coalesce(current_setting('neo.rpc', true), '') = '1' or v_assign or v_sync
                   or coalesce(current_setting('neo.field', true), '') = '1';
  v_codes text;
begin
  if current_setting('neo.migrating', true) = '1' then return new; end if;

  -- 0. Columns that change only through their own action. v1.9.11 never sends
  --    any of these, so this can only ever stop a hand-made write.
  if not v_rpc then
    if new.model_version is distinct from old.model_version
       or new.public_code is distinct from old.public_code
       or new.service_type is distinct from old.service_type
       or new.converted_from is distinct from old.converted_from
       or new.created_by_email is distinct from old.created_by_email
       or new.created_by_name is distinct from old.created_by_name
       or new.client_request_id is distinct from old.client_request_id
       or new.priority is distinct from old.priority
       or new.priority_reason is distinct from old.priority_reason
       or new.priority_set_by is distinct from old.priority_set_by
       or new.suggested_tech_email is distinct from old.suggested_tech_email
       or new.suggest_reason is distinct from old.suggest_reason
       or new.assigned_via is distinct from old.assigned_via
       or new.assigned_at is distinct from old.assigned_at
       or new.assign_reason is distinct from old.assign_reason
       or new.queued_at is distinct from old.queued_at
       or new.visit_count is distinct from old.visit_count then
      raise exception 'NEO_DENIED: That field changes through its own action (convert, claim, assign, priority, suggestion), not a direct edit.';
    end if;
  end if;

  -- 1. Stage and type.
  if new.stage is distinct from old.stage or new.service_type is distinct from old.service_type then
    if new.model_version >= 2 then
      if not public.svc_stage_legal(new.service_type, new.stage) then
        raise exception 'NEO_GATE: % is not a step for % ticket.',
          public._svc_stage_label(new.stage), public._svc_type_phrase(new.service_type);
      end if;
    elsif not public.svc_known_stage(new.stage) then
      raise exception 'NEO_GATE: "%" is not a known ticket stage.', new.stage;
    end if;

    if not v_sync then
      if new.model_version >= 2 and new.stage is distinct from old.stage
         and new.stage in ('rma_raised','at_vendor','back_from_vendor') then
        raise exception 'NEO_RMA_HOLD: Raise the RMA from the Items tab — the ticket follows the part automatically.';
      end if;

      -- SPEC-AMENDMENTS A2: only PRE-RETURN held parts (with_tech … with_vendor)
      -- own the ticket. While one exists, nobody moves the ticket into or out
      -- of a mirror stage, or to ready / closed, by hand. A held part that is
      -- back (back_from_vendor, customer_decision, ready_to_return, returning)
      -- blocks nothing: people move the ticket on as normal, and closing it
      -- settles those parts (§10 close trigger). The sentence names the RM
      -- codes and also makes sense on a v1.9.11 screen.
      select string_agg(rc.public_code, ', ' order by rc.public_code) into v_codes
        from public.rma_cases rc
       where rc.service_job_id = new.id and rc.holds_ticket
         and rc.stage in ('with_tech','logged','received','testing','awaiting_docs','ready_to_ship','with_vendor');
      if v_codes is not null and new.stage is distinct from old.stage
         and (old.stage in ('rma_raised','at_vendor','back_from_vendor')
              or new.stage in ('rma_raised','at_vendor','back_from_vendor','ready','closed')) then
        raise exception 'NEO_RMA_HOLD: This ticket is waiting on RMA %. Move the part on in the RMA module, or release it from the ticket (update the app on this PC if you don''t see those options).', v_codes;
      end if;

      -- A remote ticket has no mirror stages, so a held part on its way to the
      -- vendor would leave the RMA link nowhere to put it.
      if new.service_type = 'remote' and new.service_type is distinct from old.service_type and v_codes is not null then
        raise exception 'NEO_RMA_HOLD: This ticket is waiting on RMA %. Release it from the ticket before switching to remote.', v_codes;
      end if;
    end if;
  end if;

  -- 2. A direct (v1.9.11) assignee change. Only a lead may make one — every
  --    v1.9.11 user is tier 3+, so a lead. Anyone else takes, hands back or is
  --    given a ticket through service_claim / service_release / service_assign,
  --    which check who may take what (A16 / A17) and write the claim / assign
  --    events the activity report counts. Then stamp it, keep the queue honest.
  if (new.assignee_email is distinct from old.assignee_email or new.assignee is distinct from old.assignee)
     and not v_assign and not public.has_module('service', 'lead') then
    raise exception 'NEO_DENIED: Take, hand back or assign the ticket with its own buttons — only a lead can change who has it directly.';
  end if;
  if new.assignee_email is distinct from old.assignee_email and not v_assign then
    new.assigned_via := case when new.assignee_email is null then null else 'legacy' end;
    -- SPEC-GAP: the SPEC says assigned_at = now() in both directions; on an
    -- unassign it is cleared instead, matching what service_release does.
    new.assigned_at := case when new.assignee_email is null then null else now() end;
    new.assign_reason := null;
    new.queued_at := case when new.assignee_email is null and new.stage <> 'closed' then now() else null end;
  end if;

  -- 3. Close / reopen.
  if new.stage is distinct from old.stage then
    if new.stage = 'closed' then
      new.queued_at := null;
    elsif old.stage = 'closed' and new.assignee_email is null then
      -- SPEC-GAP: a reopened, unassigned ticket goes back into the queue now,
      -- rather than counting its queue age from the day it was created.
      new.queued_at := now();
    end if;
    if new.stage_since is not distinct from old.stage_since then
      new.stage_since := now();
    end if;
  end if;

  -- Keep the customer link pointing at the phone the ticket now carries.
  if new.customer_phone is distinct from old.customer_phone
     and new.customer_id is not distinct from old.customer_id
     and public.phone_ok(new.customer_phone) then
    new.customer_id := public._customer_upsert(new.customer_phone, new.customer_name, new.customer_email,
                                               coalesce(auth.email(), 'system'));
  end if;

  -- 4.
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_service_jobs_guard on public.service_jobs;
create trigger trg_service_jobs_guard before update on public.service_jobs
  for each row execute function public.tg_service_jobs_guard();

-- ── service_jobs AFTER INSERT (v1 rows): give an old client's ticket its
--    primary item, so the Items tab, serial search and RMA-from-ticket work on
--    tickets v1.9.11 creates after this migration (the backfill covers the rest).
create or replace function public.tg_service_jobs_v1_item()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_prev text;
begin
  if current_setting('neo.migrating', true) = '1' then return null; end if;
  if exists (select 1 from public.service_items si where si.job_id = new.id) then return null; end if;
  v_prev := public._flag_set('neo.item_sync');
  insert into public.service_items (id, job_id, sort, is_primary, kind, label, serial, purchase_source,
                                    build_ticket_id, created_at, created_by)
  values (public.new_text_id('si'), new.id, 0, true,
          case when new.build_ticket_id is not null then 'pc' else 'other' end,
          new.device_label, new.device_serial,
          case when new.build_ticket_id is not null then 'neo_tokyo' else 'unknown' end,
          (select t.id from public.tickets t where t.id = new.build_ticket_id),
          coalesce(new.created_at, now()), coalesce(auth.email(), 'system'));
  perform public._flag_restore('neo.item_sync', v_prev);
  return null;
end $$;

drop trigger if exists trg_service_jobs_v1_item on public.service_jobs;
create trigger trg_service_jobs_v1_item after insert on public.service_jobs
  for each row when (new.model_version = 1) execute function public.tg_service_jobs_v1_item();

-- ── service_jobs AFTER UPDATE OF device_label, device_serial: a v1.9.11 edit
--    of the device fields is copied into the primary item, so both agree.
create or replace function public.tg_service_jobs_device_mirror()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_prev text;
begin
  if current_setting('neo.item_sync', true) = '1' or current_setting('neo.migrating', true) = '1' then
    return null;
  end if;
  if new.device_label is not distinct from old.device_label
     and new.device_serial is not distinct from old.device_serial then
    return null;
  end if;
  v_prev := public._flag_set('neo.item_sync');
  if exists (select 1 from public.service_items si where si.job_id = new.id and si.is_primary) then
    update public.service_items
       set label = new.device_label, serial = new.device_serial
     where job_id = new.id and is_primary
       and (label is distinct from new.device_label or serial is distinct from new.device_serial);
  else
    insert into public.service_items (id, job_id, sort, is_primary, kind, label, serial, purchase_source,
                                      build_ticket_id, created_at, created_by)
    values (public.new_text_id('si'), new.id,
            coalesce((select max(si.sort) + 1 from public.service_items si where si.job_id = new.id), 0),
            true, case when new.build_ticket_id is not null then 'pc' else 'other' end,
            new.device_label, new.device_serial,
            case when new.build_ticket_id is not null then 'neo_tokyo' else 'unknown' end,
            (select t.id from public.tickets t where t.id = new.build_ticket_id),
            now(), coalesce(auth.email(), 'system'));
  end if;
  perform public._flag_restore('neo.item_sync', v_prev);
  return null;
end $$;

drop trigger if exists trg_service_jobs_device_mirror on public.service_jobs;
create trigger trg_service_jobs_device_mirror after update of device_label, device_serial on public.service_jobs
  for each row execute function public.tg_service_jobs_device_mirror();

-- ── service_items AFTER INSERT/UPDATE (primary only): the item is the truth
--    for the device; the ticket's device_label / device_serial are its mirror
--    (v1.9.11 and get_service_public read those).
create or replace function public.tg_service_items_sync()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_prev text;
begin
  if current_setting('neo.item_sync', true) = '1' or current_setting('neo.migrating', true) = '1' then
    return null;
  end if;
  if not new.is_primary then return null; end if;
  if tg_op = 'UPDATE'
     and new.label is not distinct from old.label
     and new.serial is not distinct from old.serial
     and new.purchase_source is not distinct from old.purchase_source
     and new.build_ticket_id is not distinct from old.build_ticket_id
     and new.is_primary = old.is_primary then
    return null;
  end if;
  v_prev := public._flag_set('neo.item_sync');
  update public.service_jobs sj
     set device_label = new.label,
         device_serial = new.serial,
         job_kind = case when new.purchase_source = 'neo_tokyo' and new.build_ticket_id is not null
                              and sj.job_kind = 'repair_outside' then 'repair_own' else sj.job_kind end,
         build_ticket_id = coalesce(sj.build_ticket_id, new.build_ticket_id)
   where sj.id = new.job_id
     and (sj.device_label is distinct from new.label
          or sj.device_serial is distinct from new.serial
          or (new.purchase_source = 'neo_tokyo' and new.build_ticket_id is not null and sj.job_kind = 'repair_outside')
          or (sj.build_ticket_id is null and new.build_ticket_id is not null));
  perform public._flag_restore('neo.item_sync', v_prev);
  return null;
end $$;

drop trigger if exists trg_service_items_sync on public.service_items;
create trigger trg_service_items_sync after insert or update on public.service_items
  for each row execute function public.tg_service_items_sync();

-- ── rma_intakes: keep the sender linked to the customer book ────────────────
create or replace function public.tg_rma_intakes_customer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.sender_phone is distinct from old.sender_phone then
    new.sender_customer_id :=
      -- Our own shop and our own technicians are not customers.
      case when new.sender_kind not in ('shop', 'our_tech') and public.phone_ok(new.sender_phone)
           then public._customer_upsert(new.sender_phone, new.sender_name, null, coalesce(auth.email(), 'system'))
           else null end;
  end if;
  return new;
end $$;

drop trigger if exists trg_rma_intakes_customer on public.rma_intakes;
create trigger trg_rma_intakes_customer before insert or update of sender_phone on public.rma_intakes
  for each row execute function public.tg_rma_intakes_customer();

-- ── rma_cases BEFORE UPDATE: legal moves and the invariants of "closed" ─────
create or replace function public.tg_rma_cases_touch()
returns trigger language plpgsql security definer set search_path = public as $$
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

drop trigger if exists trg_rma_cases_touch on public.rma_cases;
create trigger trg_rma_cases_touch before update on public.rma_cases
  for each row execute function public.tg_rma_cases_touch();

-- ── rma_sync_ticket: the ONE writer of a ticket's mirror stage ──────────────
-- Internal (not granted). Called by the rma_cases trigger and by RMA RPCs.
create or replace function public.rma_sync_ticket(p_job_id text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_job public.service_jobs;
  v_target text;
  v_party text;
  v_chase timestamptz;
  v_body text;
  v_list text;
  v_names text[];
  v_n int;
  v_all_good boolean;
  v_prev text;
begin
  -- 1. One ticket at a time: two parts of the same ticket changing at once queue here.
  select * into v_job from public.service_jobs where id = p_job_id for update;
  if not found then return; end if;

  -- 2. The shop has finished (or the customer has the device); the parts go on alone.
  if v_job.stage in ('ready','closed','work_done','resolved') then return; end if;

  -- 4. What the held parts say the ticket should be. "Pre-return" held parts
  --    (A2/A3) are the ones still on their way: with_tech … with_vendor.
  if exists (select 1 from public.rma_cases rc
              where rc.service_job_id = v_job.id and rc.holds_ticket
                and rc.stage in ('with_tech','logged','received','testing','awaiting_docs','ready_to_ship')) then
    -- Shop-side work outranks waiting on a vendor: it is a real new task. A
    -- part that came BACK is not shop-side, so one part returning never drags
    -- the ticket from at_vendor to rma_raised while another is still away.
    v_target := 'rma_raised';
    v_party := null;
    v_chase := null;
    select string_agg(public._item_kind_label(rc.kind) || ' (' || rc.public_code || ')', ', '
                      order by rc.intake_seq, rc.created_at, rc.id)
      into v_list
      from public.rma_cases rc
     where rc.service_job_id = v_job.id and rc.holds_ticket
       and rc.stage in ('with_tech','logged','received','testing','awaiting_docs','ready_to_ship');
    v_body := 'Warranty claim raised: ' || v_list || '.';

  elsif exists (select 1 from public.rma_cases rc
                 where rc.service_job_id = v_job.id and rc.holds_ticket and rc.stage = 'with_vendor') then
    v_target := 'at_vendor';
    -- A13: the customer hears the part's brand (else the vendor's public
    -- name), never a distributor's.
    select coalesce(array_agg(distinct public._rma_party(rc.brand, vd.public_name, vd.kind)
                              order by public._rma_party(rc.brand, vd.public_name, vd.kind))
                      filter (where public._rma_party(rc.brand, vd.public_name, vd.kind) is not null), '{}'::text[]),
           min(rc.expected_back_at)
      into v_names, v_chase
      from public.rma_cases rc
      left join public.rma_vendors vd on vd.id = rc.vendor_id
     where rc.service_job_id = v_job.id and rc.holds_ticket and rc.stage = 'with_vendor';
    v_n := coalesce(array_length(v_names, 1), 0);
    v_party := case when v_n = 0 then null
                    when v_n <= 2 then array_to_string(v_names, ' and ')
                    else v_names[1] || ' and ' || v_names[2] || ' +' || (v_n - 2)::text end;
    select string_agg(public._item_kind_label(rc.kind) || ' (' || rc.public_code || ')', ', '
                      order by rc.intake_seq, rc.created_at, rc.id)
      into v_list
      from public.rma_cases rc
     where rc.service_job_id = v_job.id and rc.holds_ticket and rc.stage = 'with_vendor';
    v_body := 'Waiting on ' || coalesce(v_party, 'the manufacturer') || ' — ' || v_list || ' sent under warranty.';

  elsif v_job.stage in ('rma_raised','at_vendor','back_from_vendor')
        and exists (select 1 from public.rma_cases rc where rc.service_job_id = v_job.id and rc.holds_ticket) then
    -- A3: only when the ticket really had held parts (released parts have
    -- holds_ticket = false and never count) and none is still on its way.
    v_target := 'back_from_vendor';
    v_party := null;
    v_chase := null;
    -- coalesce: bool_and skips NULLs, and a held part that never went to a
    -- vendor (no fault found, withdrawn) must not read as "back from the
    -- manufacturer".
    select bool_and(coalesce(rc.vendor_result in ('replaced','repaired'), false)),
           string_agg(public._item_kind_label(rc.kind) || ' (' || rc.public_code || ') — '
                        || coalesce(public._rma_result_word(rc.vendor_result),
                                    case when rc.stage = 'closed' then lower(public._rma_disposition_label(rc.disposition))
                                         else lower(public._rma_stage_customer(rc.stage, rc.return_method)) end),
                      ', ' order by rc.intake_seq, rc.created_at, rc.id)
      into v_all_good, v_list
      from public.rma_cases rc
     where rc.service_job_id = v_job.id and rc.holds_ticket;
    v_body := case when coalesce(v_all_good, false) then 'Back from the manufacturer: ' else 'Warranty claim update: ' end
              || v_list || '.';
  end if;

  if v_target is null then return; end if;

  -- Same stage: keep the vendor names and the chase date current (one of two
  -- parts came back), without a new timeline entry.
  if v_target = v_job.stage then
    if v_job.waiting_party is distinct from v_party or v_job.next_chase_at is distinct from v_chase then
      v_prev := public._flag_set('neo.sync');
      update public.service_jobs set waiting_party = v_party, next_chase_at = v_chase where id = v_job.id;
      perform public._flag_restore('neo.sync', v_prev);
    end if;
    return;
  end if;

  -- 3. Outside the sync zone (a technician moved the ticket on, e.g. fitted a
  --    loaner): never drag it back. Say so once per target per stay.
  if not (v_job.stage in ('logged','received','diagnosing','rma_raised','at_vendor','back_from_vendor',
                          'revisit_needed','on_site'))
     or (v_job.model_version >= 2 and not public.svc_stage_legal(v_job.service_type, v_target)) then
    if not exists (select 1 from public.service_events se
                    where se.job_id = v_job.id and se.kind = 'rma'
                      and se.meta ->> 'sync_target' = v_target
                      and se.at >= coalesce(v_job.stage_since, '-infinity'::timestamptz)) then
      insert into public.service_events (job_id, kind, actor_kind, actor_name, body, customer_visible, client_at, meta)
      values (v_job.id, 'rma', 'system', 'RMA link',
              'RMA update: ' || v_body || ' The ticket stays at ' || public._svc_stage_label(v_job.stage)
                || ' — move it on by hand when ready.',
              false, now(), jsonb_build_object('sync_target', v_target));
    end if;
    return;
  end if;

  -- 5. Move it, in this transaction, as the RMA link.
  v_prev := public._flag_set('neo.sync');
  update public.service_jobs
     set stage = v_target, stage_since = now(), waiting_party = v_party, next_chase_at = v_chase
   where id = v_job.id;
  perform public._flag_restore('neo.sync', v_prev);

  insert into public.service_events (job_id, kind, actor_kind, actor_name, from_stage, to_stage, body,
                                     customer_visible, client_at, meta)
  values (v_job.id, 'stage', 'system', 'RMA link', v_job.stage, v_target, v_body, true, now(),
          jsonb_build_object('source', 'rma_sync'));
end $$;

-- ── rma_cases AFTER INSERT / UPDATE OF the fields the ticket depends on ─────
create or replace function public.tg_rma_cases_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('neo.rma_nosync', true) = '1' then return null; end if;
  if new.service_job_id is null then return null; end if;
  if tg_op = 'UPDATE'
     and new.stage is not distinct from old.stage
     and new.holds_ticket is not distinct from old.holds_ticket
     and new.vendor_id is not distinct from old.vendor_id
     and new.brand is not distinct from old.brand
     and new.expected_back_at is not distinct from old.expected_back_at then
    return null;
  end if;
  perform public.rma_sync_ticket(new.service_job_id);
  return null;
end $$;

-- brand is in the list because the ticket's "waiting on" names it (A13).
drop trigger if exists trg_rma_cases_sync on public.rma_cases;
create trigger trg_rma_cases_sync after insert or update of stage, holds_ticket, vendor_id, brand, expected_back_at
  on public.rma_cases for each row execute function public.tg_rma_cases_sync();

-- ── rma_cases: the drive-data answer is part of the record (A11) ───────────
-- Written by the RMA desk through the column grant or at creation; either way
-- an internal note says who answered what.
create or replace function public.tg_rma_cases_data_handling()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_old text;
begin
  if tg_op = 'UPDATE' then
    if new.data_handling is not distinct from old.data_handling then return null; end if;
    v_old := old.data_handling;
  elsif new.data_handling is null then
    return null;
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.rma_events (case_id, kind, actor_kind, actor_email, actor_name, body, customer_visible, client_at, meta)
  values (new.id, 'edit', 'staff', coalesce(auth.email(), 'system'), v_name,
          'Data on the drive: ' || public._rma_data_label(new.data_handling)
            || case when v_old is not null then ' (was: ' || public._rma_data_label(v_old) || ')' else '' end,
          false, now(),
          jsonb_strip_nulls(jsonb_build_object('data_handling', new.data_handling, 'from', v_old)));
  return null;
end $$;

drop trigger if exists trg_rma_cases_data_handling on public.rma_cases;
create trigger trg_rma_cases_data_handling after insert or update of data_handling on public.rma_cases
  for each row execute function public.tg_rma_cases_data_handling();

-- ── rma_events AFTER INSERT: the ticket's timeline shows its parts' history ─
-- SPEC-AMENDMENTS A7: kind 'rma', from_stage / to_stage NULL (the RMA stage
-- keys go into meta), and a body already in customer wording — "Graphics card
-- (RM-7KQ2PX4D): With the manufacturer under warranty" — so neither v1.9.11's
-- timeline nor the public page ever shows a raw key like "testing".
create or replace function public.tg_rma_events_mirror()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_case public.rma_cases;
begin
  -- rma_dispatch writes one entry per ticket itself (A9).
  if coalesce(current_setting('neo.no_mirror', true), '') = '1' then return null; end if;
  select * into v_case from public.rma_cases where id = new.case_id;
  if not found or v_case.service_job_id is null then return null; end if;
  insert into public.service_events (job_id, kind, actor_kind, actor_email, actor_name, body,
                                     customer_visible, client_at, meta)
  values (v_case.service_job_id, 'rma', coalesce(new.actor_kind, 'system'), new.actor_email, new.actor_name,
          public._item_kind_label(v_case.kind) || ' (' || v_case.public_code || '): '
            || coalesce(new.body,
                        case when new.to_stage = 'closed' then public._rma_disposition_label(v_case.disposition)
                             when new.customer_visible then public._rma_stage_customer(new.to_stage, v_case.return_method)
                             else public._rma_stage_label(new.to_stage) end,
                        ''),
          new.customer_visible, coalesce(new.client_at, now()),
          jsonb_build_object('rma_case_id', new.case_id, 'rma_event_id', new.id, 'rma_kind', new.kind,
                             'from_stage', new.from_stage, 'to_stage', new.to_stage));
  return null;
end $$;

drop trigger if exists trg_rma_events_mirror on public.rma_events;
create trigger trg_rma_events_mirror after insert on public.rma_events
  for each row execute function public.tg_rma_events_mirror();

-- ── service_jobs AFTER UPDATE OF stage → closed: settle the linked parts ────
-- SPEC-AMENDMENTS A6, row by row:
--   held, back_from_vendor / ready_to_return, replaced|repaired|credit_note
--        → closed 'refitted' (the ticket's primary item itself: replaced /
--          repaired / credit_note — the whole device went and came back)
--   held, rejected                → closed 'rejected_returned'
--   held, lost                    → stays open (the desk settles it)
--   held, customer_decision       → stays open, internal note "decision still pending"
--   fee not n_a / paid / waived   → stays open, internal note "fee still to settle"
--   NOT held, still open, return_method with_device
--        → return_method collect + customer note "returned separately"
-- Anything else (no vendor result, still returning by courier) stays open
-- with an internal note, so the RMA desk sees it and closes it properly.
create or replace function public.tg_service_jobs_closed()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_prev text;
  v_disp text;
  v_primary boolean;
  v_email text := coalesce(auth.email(), 'system');
  v_name text;
  v_note text;
begin
  select full_name into v_name from public.profiles where id = auth.uid();
  for r in
    select * from public.rma_cases rc
     where rc.service_job_id = new.id and rc.stage <> 'closed'
     order by rc.id
     for update
  loop
    if not r.holds_ticket then
      -- (A part replaced from our stock is ours now; nothing goes back for it.)
      if r.return_method = 'with_device' and not r.advance_replacement then
        update public.rma_cases set return_method = 'collect' where id = r.id;
        insert into public.rma_events (case_id, kind, actor_kind, actor_email, actor_name, body, customer_visible, meta)
        values (r.id, 'link', 'system', v_email, v_name,
                'Your ' || lower(public._item_kind_label(r.kind)) || ' will be returned separately — track it as '
                  || r.public_code || '.',
                true, jsonb_build_object('service_job_id', new.id, 'return_method_from', 'with_device'));
      end if;
      continue;
    end if;

    v_note := null;
    if r.stage = 'customer_decision' then
      v_note := 'Ticket closed — decision still pending';
    elsif r.vendor_result = 'lost' then
      v_note := 'Ticket ' || new.public_code || ' closed — this part was lost by the vendor. Settle it here.';
    elsif r.stage not in ('back_from_vendor', 'ready_to_return')
          or coalesce(r.vendor_result, '') not in ('replaced','repaired','credit_note','rejected') then
      v_note := 'Ticket ' || new.public_code || ' closed while this part is at ' || public._rma_stage_label(r.stage)
                || '. Close it here with the right outcome.';
    elsif r.fee_status not in ('n_a','paid','waived') then
      v_note := 'Ticket closed — fee still to settle';
    end if;
    if v_note is not null then
      insert into public.rma_events (case_id, kind, actor_kind, actor_email, actor_name, body, customer_visible, meta)
      values (r.id, case when v_note like '%fee%' then 'fee' else 'system' end, 'system', v_email, v_name, v_note, false,
              jsonb_build_object('service_job_id', new.id));
      continue;
    end if;

    v_primary := r.service_item_id is not null
                 and exists (select 1 from public.service_items si
                              where si.id = r.service_item_id and si.job_id = new.id and si.is_primary);
    v_disp := case when r.vendor_result = 'rejected' then 'rejected_returned'
                   when v_primary then r.vendor_result
                   else 'refitted' end;
    -- The ticket is already closed, so the sync has nothing to do here.
    v_prev := public._flag_set('neo.rma_nosync');
    update public.rma_cases
       set stage = 'closed', stage_since = now(), disposition = v_disp, closed_at = now(), closed_by = v_email
     where id = r.id;
    perform public._flag_restore('neo.rma_nosync', v_prev);
    insert into public.rma_events (case_id, kind, actor_kind, actor_email, actor_name, from_stage, to_stage,
                                   body, customer_visible, meta)
    values (r.id, 'stage', 'system', v_email, v_name, r.stage, 'closed',
            'Returned with the device (' || new.public_code || ')', true,
            jsonb_build_object('service_job_id', new.id, 'disposition', v_disp));
  end loop;
  return null;
end $$;

drop trigger if exists trg_service_jobs_closed on public.service_jobs;
create trigger trg_service_jobs_closed after update of stage on public.service_jobs
  for each row when (new.stage = 'closed' and old.stage is distinct from 'closed')
  execute function public.tg_service_jobs_closed();


-- =============================================================================
-- §11  BACKFILL (existing rows). One DO block so the transaction-local
--      neo.migrating flag covers every statement even if the runner autocommits.
-- =============================================================================

do $$
begin
  perform set_config('neo.migrating', '1', true);

  update public.service_jobs
     set category = case job_kind when 'warranty_rma' then 'warranty_claim'
                                  when 'upgrade' then 'upgrade'
                                  else 'repair' end
   where category is null;

  update public.service_jobs
     set queued_at = created_at
   where queued_at is null and assignee_email is null and stage <> 'closed' and model_version = 1;

  -- SPEC-GAP: the SPEC backfill list omits this; without it an already-assigned
  -- legacy ticket would show "assigned via —".
  update public.service_jobs
     set assigned_via = 'legacy', assigned_at = coalesce(updated_at, created_at)
   where assignee_email is not null and assigned_via is null;

  -- Customers: newest name per phone, existing customer rows keep theirs.
  -- Validity is phone_ok() on the number as typed — the same test the insert
  -- trigger and _customer_upsert apply — so the backfill and a new ticket
  -- agree on who is a customer (an 11-digit Gulf number included).
  insert into public.customers as cu (phone_norm, name, email, created_by)
  select distinct on (s.pn) s.pn, nullif(btrim(coalesce(s.customer_name, '')), ''),
         nullif(lower(btrim(coalesce(s.customer_email, ''))), ''), 'migration:service_v2_rma'
    from (select public.norm_phone(customer_phone) as pn, customer_name, customer_email, created_at
            from public.service_jobs
           where customer_id is null and public.phone_ok(customer_phone)) s
   order by s.pn, s.created_at desc
  on conflict (phone_norm) do update
     set name = coalesce(nullif(cu.name, ''), excluded.name),
         email = coalesce(cu.email, excluded.email),
         updated_at = now();

  update public.service_jobs sj
     set customer_id = cu.id
    from public.customers cu
   where sj.customer_id is null
     and public.phone_ok(sj.customer_phone)
     and cu.phone_norm = public.norm_phone(sj.customer_phone);

  -- One primary item per existing ticket. A hand-typed build id that no
  -- longer exists is dropped from the item (the FK would refuse it) but stays
  -- on the ticket where v1.9.11 shows it.
  insert into public.service_items (id, job_id, sort, is_primary, kind, label, serial, purchase_source,
                                    build_ticket_id, created_at, created_by)
  select public.new_text_id('si'), sj.id, 0, true,
         case when sj.build_ticket_id is not null then 'pc' else 'other' end,
         sj.device_label, sj.device_serial,
         case when sj.build_ticket_id is not null then 'neo_tokyo' else 'unknown' end,
         t.id, coalesce(sj.created_at, now()), 'migration:service_v2_rma'
    from public.service_jobs sj
    left join public.tickets t on t.id = sj.build_ticket_id
   where not exists (select 1 from public.service_items si where si.job_id = sj.id);

  perform set_config('neo.migrating', '', true);
end $$;


-- =============================================================================
-- §12  SEEDS
-- =============================================================================

-- Tier 3+ people are leads automatically and need no rows. Re-running never
-- overwrites a role someone changed in Settings since.
insert into public.module_access (profile_id, module, role, granted_by)
select p.id, s.module, s.role, 'migration:service_v2_rma'
  from (values
          ('anagha.kc@neotokyo.in',     'service', 'desk'),
          ('ancybaby@neotokyo.in',      'service', 'desk'),
          ('adhil.m@neotokyo.in',       'service', 'tech'),
          ('amal.c@neotokyo.in',        'service', 'tech'),
          ('athul.sudheer@neotokyo.in', 'service', 'tech'),
          ('vinayak.s@neotokyo.in',     'service', 'tech'),
          ('anagha.kc@neotokyo.in',     'rma',     'desk'),
          ('ancybaby@neotokyo.in',      'rma',     'desk'),
          ('adhil.m@neotokyo.in',       'rma',     'tech'),
          ('amal.c@neotokyo.in',        'rma',     'tech'),
          ('athul.sudheer@neotokyo.in', 'rma',     'tech'),
          ('vinayak.s@neotokyo.in',     'rma',     'tech')
       ) as s(email, module, role)
  join public.profiles p on lower(p.email) = s.email
on conflict (profile_id, module) do nothing;

insert into public.rma_vendors (name, public_name, kind, typical_tat_days)
select v.name, v.name, 'brand', v.tat
  from (values
          ('ASUS', 14), ('MSI', 14), ('Gigabyte', 14), ('Zotac', 14), ('Sapphire', 14), ('PowerColor', 14),
          ('Inno3D', 14), ('Galax', 14), ('Palit', 14), ('Corsair', 14), ('Cooler Master', 14), ('Deepcool', 14),
          ('Lian Li', 14), ('NZXT', 14), ('Antec', 14), ('Seasonic', 14), ('Thermaltake', 14), ('Ant Esports', 14),
          ('Kingston', 14), ('Crucial', 14), ('G.Skill', 14), ('XPG / ADATA', 14), ('TeamGroup', 14), ('Samsung', 14),
          ('Western Digital', 14), ('Seagate', 14), ('Intel', 21), ('AMD', 21), ('Lenovo', 14), ('HP', 14),
          ('Dell', 14), ('Acer', 14), ('LG', 14), ('BenQ', 14), ('Logitech', 14), ('TP-Link', 14)
       ) as v(name, tat)
on conflict (name) do nothing;


-- =============================================================================
-- §13  ROW LEVEL SECURITY AND TABLE GRANTS
--      Supabase grants ALL on new public tables to anon and authenticated by
--      default; every table here is revoked first and granted exactly.
--      Policies call the helpers through (select …) so they run once per query.
-- =============================================================================

-- module_access
alter table public.module_access enable row level security;
drop policy if exists ma_select on public.module_access;
create policy ma_select on public.module_access for select to authenticated
  using (profile_id = auth.uid() or (select public.my_tier()) >= 4);
revoke all on table public.module_access from anon, authenticated;
grant select on table public.module_access to authenticated;

-- customers
alter table public.customers enable row level security;
drop policy if exists cust_select on public.customers;
drop policy if exists cust_insert on public.customers;
drop policy if exists cust_update on public.customers;
create policy cust_select on public.customers for select to authenticated
  using ((select public.svc_reader()) or (select public.rma_reader()));
create policy cust_insert on public.customers for insert to authenticated
  with check ((select public.svc_reader()) or (select public.rma_reader()));
create policy cust_update on public.customers for update to authenticated
  using ((select public.svc_reader()) or (select public.rma_reader()))
  with check ((select public.svc_reader()) or (select public.rma_reader()));
revoke all on table public.customers from anon, authenticated;
grant select, insert, update on table public.customers to authenticated;

-- A part raised from a ticket keeps the photos the counter took of it (its
-- serial label, its condition) on the TICKET's item, under <jobId>/, not under
-- rma/<caseId>/. An RMA-only member (rma role, no service role) handles that
-- part, so they may SEE those photos — and nothing else of the ticket. These
-- two answer "is this ticket item / this ticket file a part on an RMA case";
-- every case is readable by an RMA reader (rc_select), so the select policies
-- pair them with rma_reader(). Definer, so the lookups are not filtered by the
-- policies that call them (no recursion). Reads only: insert, update and
-- delete keep their rules.
create or replace function public.rma_item_media_visible(p_service_item_id text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.rma_cases c where c.service_item_id = p_service_item_id)
$$;

-- The file behind such a row: exactly its path, inside the ticket's own folder.
create or replace function public.rma_media_path_visible(p_name text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1
                   from public.service_media m
                   join public.rma_cases c on c.service_item_id = m.service_item_id
                  where m.path = p_name
                    and m.job_id is not null
                    and split_part(p_name, '/', 1) = m.job_id)
$$;

-- service_jobs / service_events / service_media: replace every earlier policy
-- (sj_staff, se_staff, smeta_staff = is_staff()) with the module rules.
-- Tier 3+ are leads, so v1.9.11 leads see exactly what they saw before.
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
            where schemaname = 'public' and tablename in ('service_jobs','service_events','service_media')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

alter table public.service_jobs enable row level security;
create policy sj_select on public.service_jobs for select to authenticated
  using ((select public.svc_reader()));
create policy sj_insert on public.service_jobs for insert to authenticated
  with check ((select public.svc_reader()));
create policy sj_update on public.service_jobs for update to authenticated
  using ((select public.svc_reader())) with check ((select public.svc_reader()));
create policy sj_delete on public.service_jobs for delete to authenticated
  using ((select public.has_module('service', 'lead')));
revoke all on table public.service_jobs from anon, authenticated;
grant select, insert, update, delete on table public.service_jobs to authenticated;

-- History is append-only: no update, no delete, for anyone.
-- A direct insert has exactly v1.9.11's shape: kind stage / note / edit /
-- media, no meta, staff, in the writer's own name. Every other kind (claim,
-- release, assign, rma, field, suggest, priority) and every meta is written by
-- the RPCs and triggers (definer, not subject to this policy) — tech_activity
-- counts claims, hand-backs and assignments from those rows, so nobody may
-- forge one, for themselves or for a colleague.
alter table public.service_events enable row level security;
create policy se_select on public.service_events for select to authenticated
  using ((select public.svc_reader()));
create policy se_insert on public.service_events for insert to authenticated
  with check ((select public.svc_reader())
              and kind in ('stage', 'note', 'edit', 'media')
              and meta = '{}'::jsonb
              and actor_kind = 'staff'
              and lower(coalesce(actor_email, '')) = lower(coalesce((select auth.email()), '')));
revoke all on table public.service_events from anon, authenticated;
grant select, insert on table public.service_events to authenticated;

alter table public.service_media enable row level security;
-- Read: the service module; an RMA part's own photos; and (RMA readers) the
-- photos of a ticket item that is on an RMA case.
create policy sm_select on public.service_media for select to authenticated
  using ((select public.svc_reader())
         or (rma_case_id is not null and (select public.rma_reader()))
         or (service_item_id is not null and (select public.rma_reader())
             and public.rma_item_media_visible(service_item_id)));
create policy sm_insert on public.service_media for insert to authenticated
  with check ((select public.svc_reader()) or (rma_case_id is not null and (select public.rma_reader())));
create policy sm_update on public.service_media for update to authenticated
  using ((select public.svc_reader()) or (rma_case_id is not null and (select public.rma_reader())))
  with check ((select public.svc_reader()) or (rma_case_id is not null and (select public.rma_reader())));
-- A lead deletes only rows they can also SELECT: the app's DELETE … RETURNING
-- (PostgREST .delete().select()) is checked against the select policy too, so
-- an RMA lead deletes RMA photos and a service lead deletes any.
create policy sm_delete on public.service_media for delete to authenticated
  using ((select public.has_module('service', 'lead'))
         or (rma_case_id is not null and (select public.has_module('rma', 'lead'))));
revoke all on table public.service_media from anon, authenticated;
grant select, insert, delete on table public.service_media to authenticated;
-- Updates are only ever the remark and the "show customer" tick.
grant update (customer_visible, remark, remark_by, remark_at) on table public.service_media to authenticated;

-- The files behind those rows (bucket service-media) follow the same rule.
-- SPEC-GAP: SPEC §2.11 kept the bucket at is_staff(), but the bucket now also
-- holds customers' purchase invoices, serial labels and vendor documents under
-- rma/<caseId>/, which A19 keeps from sales — and with is_staff() any staff
-- member could list and download them while the table hid the rows.
--   read / upload / update: the service module; files under rma/ also the RMA module.
--   read only: the RMA module also reads a ticket file whose media row is on
--           a ticket item that is on an RMA case (rma_media_path_visible), so
--           the part's counter photos can be signed and shown.
--   delete: the uploader (a failed upload removes its own file), a service
--           lead, or an RMA lead for files under rma/.
-- v1.9.11 users are tier 3+ (leads of every module) and NeoHR technicians hold
-- a service role, so nothing they do changes; the website never touches the
-- bucket. Every earlier policy for this bucket is replaced, whatever its name.
-- If this role may not manage storage policies the old ones stay as they were
-- (the block is all-or-nothing) and a warning says so; the tests then fail
-- loudly on the storage check.
do $$
declare r record;
begin
  for r in select policyname from pg_policies
            where schemaname = 'storage' and tablename = 'objects'
              and (coalesce(qual, '') like '%''service-media''%' or coalesce(with_check, '') like '%''service-media''%')
  loop
    execute format('drop policy if exists %I on storage.objects', r.policyname);
  end loop;
  create policy svcmedia_select on storage.objects for select to authenticated
    using (bucket_id = 'service-media'
           and ((select public.svc_reader())
                or (name like 'rma/%' and (select public.rma_reader()))
                or ((select public.rma_reader()) and public.rma_media_path_visible(name))));
  create policy svcmedia_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'service-media'
                and ((select public.svc_reader()) or (name like 'rma/%' and (select public.rma_reader()))));
  create policy svcmedia_update on storage.objects for update to authenticated
    using (bucket_id = 'service-media'
           and ((select public.svc_reader()) or (name like 'rma/%' and (select public.rma_reader()))))
    with check (bucket_id = 'service-media'
                and ((select public.svc_reader()) or (name like 'rma/%' and (select public.rma_reader()))));
  create policy svcmedia_delete on storage.objects for delete to authenticated
    using (bucket_id = 'service-media'
           and (owner_id = (select auth.uid()::text)
                or (select public.has_module('service', 'lead'))
                or (name like 'rma/%' and (select public.has_module('rma', 'lead')))));
exception when insufficient_privilege or undefined_column then
  raise warning 'service_v2_rma: could not replace the storage policies for bucket service-media (%). Files there are still readable by every staff member; re-run this block as the storage owner.', sqlerrm;
end $$;

-- service_items
alter table public.service_items enable row level security;
drop policy if exists si_select on public.service_items;
drop policy if exists si_insert on public.service_items;
drop policy if exists si_update on public.service_items;
drop policy if exists si_delete on public.service_items;
create policy si_select on public.service_items for select to authenticated
  using ((select public.svc_reader()));
create policy si_insert on public.service_items for insert to authenticated
  with check ((select public.svc_reader()));
create policy si_update on public.service_items for update to authenticated
  using ((select public.svc_reader())) with check ((select public.svc_reader()));
create policy si_delete on public.service_items for delete to authenticated
  using ((select public.has_module('service', 'lead')));
revoke all on table public.service_items from anon, authenticated;
grant select, insert, update, delete on table public.service_items to authenticated;

-- rma_vendors
alter table public.rma_vendors enable row level security;
drop policy if exists rv_select on public.rma_vendors;
drop policy if exists rv_insert on public.rma_vendors;
drop policy if exists rv_update on public.rma_vendors;
create policy rv_select on public.rma_vendors for select to authenticated
  using ((select public.rma_reader()) or (select public.svc_reader()));
create policy rv_insert on public.rma_vendors for insert to authenticated
  with check ((select public.has_module('rma', 'desk')));
create policy rv_update on public.rma_vendors for update to authenticated
  using ((select public.has_module('rma', 'desk'))) with check ((select public.has_module('rma', 'desk')));
revoke all on table public.rma_vendors from anon, authenticated;
grant select, insert, update on table public.rma_vendors to authenticated;
revoke all on sequence public.rma_vendors_id_seq from anon, authenticated;
grant usage, select on sequence public.rma_vendors_id_seq to authenticated;

-- rma_intakes: read for RMA readers; a few descriptive columns editable by the desk.
alter table public.rma_intakes enable row level security;
drop policy if exists ri_select on public.rma_intakes;
drop policy if exists ri_update on public.rma_intakes;
create policy ri_select on public.rma_intakes for select to authenticated
  using ((select public.rma_reader()));
create policy ri_update on public.rma_intakes for update to authenticated
  using ((select public.has_module('rma', 'desk'))) with check ((select public.has_module('rma', 'desk')));
revoke all on table public.rma_intakes from anon, authenticated;
grant select on table public.rma_intakes to authenticated;
grant update (sender_name, sender_phone, inbound_courier, inbound_awb, return_method, return_address, notes)
  on table public.rma_intakes to authenticated;

-- rma_cases: stage, fees, links and results move only through the RPCs.
alter table public.rma_cases enable row level security;
drop policy if exists rc_select on public.rma_cases;
drop policy if exists rc_update on public.rma_cases;
create policy rc_select on public.rma_cases for select to authenticated
  using ((select public.rma_reader()));
create policy rc_update on public.rma_cases for update to authenticated
  using ((select public.has_module('rma', 'desk'))) with check ((select public.has_module('rma', 'desk')));
revoke all on table public.rma_cases from anon, authenticated;
grant select on table public.rma_cases to authenticated;
-- data_handling (A11) is a desk answer like the others; a trigger notes it.
grant update (brand, model, serial, fault, diagnosed_by, our_finding, owner_name, owner_phone, purchase_source,
              invoice_no, purchase_date, build_ticket_id, vendor_id, vendor_rma_no, expected_back_at,
              return_method, return_address, data_handling, updated_at)
  on table public.rma_cases to authenticated;

alter table public.rma_events enable row level security;
drop policy if exists re_select on public.rma_events;
create policy re_select on public.rma_events for select to authenticated
  using ((select public.rma_reader()));
revoke all on table public.rma_events from anon, authenticated;
grant select on table public.rma_events to authenticated;
revoke all on sequence public.rma_events_id_seq from anon, authenticated;

alter table public.rma_shipments enable row level security;
drop policy if exists rs_select on public.rma_shipments;
create policy rs_select on public.rma_shipments for select to authenticated
  using ((select public.rma_reader()));
revoke all on table public.rma_shipments from anon, authenticated;
grant select on table public.rma_shipments to authenticated;
revoke all on sequence public.rma_shipments_id_seq from anon, authenticated;

alter table public.rma_shipment_items enable row level security;
drop policy if exists rsi_select on public.rma_shipment_items;
create policy rsi_select on public.rma_shipment_items for select to authenticated
  using ((select public.rma_reader()));
revoke all on table public.rma_shipment_items from anon, authenticated;
grant select on table public.rma_shipment_items to authenticated;

-- field_activity: your own rows, or a service lead / NeoHR lead / tier 3+
-- (HR, managers) — the same people tech_activity() shows everyone to.
alter table public.field_activity enable row level security;
drop policy if exists fa_select on public.field_activity;
create policy fa_select on public.field_activity for select to authenticated
  using (lower(employee_email) = lower(coalesce(auth.email(), ''))
         or (select public.has_module('service', 'lead'))
         or (select public.has_module('neohr', 'lead'))
         or (select public.my_tier()) >= 3);
revoke all on table public.field_activity from anon, authenticated;
grant select on table public.field_activity to authenticated;


-- =============================================================================
-- §14  SHARED INTERNALS FOR THE RPCs
-- =============================================================================

create or replace function public._svc_ev(
  p_job_id text, p_kind text, p_body text, p_visible boolean,
  p_from text default null, p_to text default null, p_meta jsonb default '{}'::jsonb,
  p_actor_kind text default 'staff', p_actor_email text default null, p_actor_name text default null)
returns public.service_events
language plpgsql volatile security definer
set search_path = public
as $$
declare v public.service_events;
begin
  insert into public.service_events (job_id, kind, actor_kind, actor_email, actor_name, from_stage, to_stage,
                                     body, customer_visible, client_at, meta)
  values (p_job_id, p_kind, coalesce(p_actor_kind, 'staff'), p_actor_email, p_actor_name, p_from, p_to,
          nullif(btrim(coalesce(p_body, '')), ''), coalesce(p_visible, false), now(), coalesce(p_meta, '{}'::jsonb))
  returning * into v;
  return v;
end $$;

create or replace function public._rma_ev(
  p_case_id text, p_kind text, p_body text, p_visible boolean,
  p_from text default null, p_to text default null, p_meta jsonb default '{}'::jsonb,
  p_actor_kind text default 'staff', p_actor_email text default null, p_actor_name text default null)
returns public.rma_events
language plpgsql volatile security definer
set search_path = public
as $$
declare v public.rma_events;
begin
  insert into public.rma_events (case_id, kind, actor_kind, actor_email, actor_name, from_stage, to_stage,
                                 body, customer_visible, client_at, meta)
  values (p_case_id, p_kind, coalesce(p_actor_kind, 'staff'), p_actor_email, p_actor_name, p_from, p_to,
          nullif(btrim(coalesce(p_body, '')), ''), coalesce(p_visible, false), now(), coalesce(p_meta, '{}'::jsonb))
  returning * into v;
  return v;
end $$;

-- A build ticket typed at the counter: the full id (t_…) or the 6-character
-- code printed for customers (the id's tail, uppercased). A typo is an error,
-- never a silently dropped link.
create or replace function public._resolve_build_ticket(p text)
returns text
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_in text := upper(replace(btrim(coalesce(p, '')), '#', ''));
  v_id text;
  v_n int;
begin
  if v_in = '' then return null; end if;
  select t.id into v_id from public.tickets t where upper(t.id) = v_in limit 1;
  if found then return v_id; end if;
  if length(v_in) = 6 then
    select count(*), min(t.id) into v_n, v_id from public.tickets t where upper(right(t.id, 6)) = v_in;
    if v_n = 1 then return v_id; end if;
    if v_n > 1 then
      raise exception 'NEO_GATE: More than one build ends in %. Enter the full build id (t_…).', v_in;
    end if;
  end if;
  raise exception 'NEO_GATE: Build "%" was not found. Check it, or leave it blank.', btrim(p);
end $$;

create or replace function public._svc_item_insert(p_job_id text, p_item jsonb, p_sort int, p_primary boolean, p_by text)
returns public.service_items
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v public.service_items;
  v_n text := ' for item ' || (p_sort + 1)::text;
begin
  if p_item is null or jsonb_typeof(p_item) <> 'object' then
    raise exception 'NEO_GATE: Item % has the wrong shape.', p_sort + 1;
  end if;
  insert into public.service_items (id, job_id, sort, is_primary, kind, label, serial, purchase_source,
                                    build_ticket_id, invoice_no, purchase_date, condition_remarks,
                                    accessories, powers_on, created_by)
  values (public.new_text_id('si'), p_job_id, p_sort, p_primary,
          coalesce(public._vocab(public._jtxt(p_item, 'kind', 20), 'item_kind', 'Item kind'), 'other'),
          public._jtxt(p_item, 'label', 200, 'The make and model' || v_n),
          public._jtxt(p_item, 'serial', 80, 'The serial' || v_n),
          coalesce(public._vocab(public._jtxt(p_item, 'purchase_source', 20), 'purchase_source', 'Where it is from'), 'unknown'),
          public._resolve_build_ticket(public._jtxt(p_item, 'build_ticket_id', 60, 'The build id' || v_n)),
          public._jtxt(p_item, 'invoice_no', 60, 'The invoice number' || v_n),
          public._jdate(p_item, 'purchase_date', 'The purchase date' || v_n),
          public._jtxt(p_item, 'condition_remarks', 2000, 'The condition remarks' || v_n),
          public._jtxtarr(p_item, 'accessories', 30, 80, 'The accessories' || v_n),
          public._jbool(p_item, 'powers_on', 'Powers on' || v_n),
          p_by)
  returning * into v;
  return v;
end $$;

create or replace function public._svc_create_result(p_job_id text, p_dup boolean)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare v_job public.service_jobs;
begin
  select * into v_job from public.service_jobs where id = p_job_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', v_job.id,
    'public_code', v_job.public_code,
    'stage', v_job.stage,
    'customer_id', v_job.customer_id,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', si.id, 'sort', si.sort, 'is_primary', si.is_primary,
                                                           'kind', si.kind, 'label', si.label) order by si.sort, si.id)
                         from public.service_items si where si.job_id = v_job.id), '[]'::jsonb),
    'open_same_phone', coalesce((select jsonb_agg(jsonb_build_object('public_code', o.public_code, 'stage', o.stage,
                                                                     'service_type', o.service_type)
                                                  order by o.created_at desc)
                                   from public.service_jobs o
                                  where public.norm_phone(o.customer_phone) = public.norm_phone(v_job.customer_phone)
                                    and public.phone_ok(v_job.customer_phone)
                                    and o.stage <> 'closed' and o.id <> v_job.id), '[]'::jsonb),
    'duplicate', p_dup,
    -- The whole row only for people who can read tickets anyway: a sales
    -- caller gets ids and codes, never someone else's diagnosis.
    'job', case when public.svc_reader() then to_jsonb(v_job) else null end);
end $$;

-- The body of service_create, shared with rma_move (converted_to_repair).
-- Validates everything before the first write; every write is in the caller's transaction.
create or replace function public._svc_create(p jsonb, p_me public.profiles)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_type text; v_channel text; v_category text; v_priority text; v_priority_reason text;
  v_name text; v_phone text; v_norm text; v_email text; v_fault text; v_faults text[];
  v_in_hand boolean; v_stage text; v_id text; v_code text; v_cust uuid;
  v_site_address text; v_site_area text; v_site_pincode text; v_site_landmark text; v_site_maps text;
  v_site_lat numeric; v_site_lng numeric; v_site_contact text;
  v_wstart timestamptz; v_wend timestamptz; v_wnote text; v_needed timestamptz;
  v_rtool text; v_rref text; v_rconsent timestamptz; v_est int;
  v_sugg public.profiles; v_sugg_email text; v_sugg_reason text;
  v_acc text[]; v_cond text; v_powers boolean; v_consent text; v_hasdata boolean; v_business boolean;
  v_items jsonb; v_n int; v_label text; v_serial text; v_self boolean;
  v_item public.service_items; v_body text; v_prev text; k text; i int; v_crid uuid;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'NEO_GATE: The request is empty.';
  end if;
  v_crid := public._juuid(p, 'client_request_id');

  -- Who and how to reach them.
  v_name := public._jtxt(p, 'customer_name', 120, 'The customer''s name');
  if v_name is null then raise exception 'NEO_GATE: Enter the customer''s name.'; end if;
  v_phone := public._jtxt(p, 'customer_phone', 30, 'The phone number');
  v_norm := public.norm_phone(v_phone);
  if not public.phone_ok(v_phone) then
    raise exception 'NEO_GATE: Enter the customer''s phone number: 10 digits, or with the country code for a number outside India.';
  end if;
  v_email := public._jtxt(p, 'customer_email', 160, 'The email');

  -- What is wrong.
  v_fault := public._jtxt(p, 'reported_fault', 8000, 'The fault description');
  v_faults := public._jtxtarr(p, 'fault_keys', 20, 40, 'The fault list');
  foreach k in array v_faults loop
    if k !~ '^[a-z0-9_]+$' then
      raise exception 'NEO_GATE: "%" is not a fault key.', k;
    end if;
  end loop;
  if v_fault is null and cardinality(v_faults) = 0 then
    raise exception 'NEO_GATE: Describe the fault in the customer''s words, or pick one from the list.';
  end if;
  -- v1.9.11 and the public page read reported_fault; never leave it blank.
  if v_fault is null then v_fault := replace(array_to_string(v_faults, ', '), '_', ' '); end if;

  v_type := coalesce(public._vocab(public._jtxt(p, 'service_type', 20), 'service_type', 'Ticket type'), 'in_store');
  v_channel := coalesce(public._vocab(public._jtxt(p, 'channel', 20), 'channel', 'Channel'), 'walk_in');
  v_category := coalesce(public._vocab(public._jtxt(p, 'category', 30), 'category', 'Category'), 'repair');
  v_priority := coalesce(public._vocab(public._jtxt(p, 'priority', 10), 'priority', 'Priority'), 'normal');
  v_priority_reason := public._jtxt(p, 'priority_reason', 300, 'The priority reason');

  -- Where.
  v_site_address := public._jtxt(p, 'site_address', 500, 'The site address');
  v_site_area := public._jtxt(p, 'site_area', 120, 'The area');
  v_site_pincode := public._jtxt(p, 'site_pincode', 12, 'The pincode');
  v_site_landmark := public._jtxt(p, 'site_landmark', 200, 'The landmark');
  v_site_maps := public._jtxt(p, 'site_maps_url', 1000, 'The map link');
  v_site_contact := public._jtxt(p, 'site_contact', 120, 'The site contact');
  v_site_lat := public._jnum(p, 'site_lat', 'The latitude');
  v_site_lng := public._jnum(p, 'site_lng', 'The longitude');
  if v_site_lat is not null and (v_site_lat < -90 or v_site_lat > 90) then v_site_lat := null; end if;
  if v_site_lng is not null and (v_site_lng < -180 or v_site_lng > 180) then v_site_lng := null; end if;
  if v_site_lat is null or v_site_lng is null then v_site_lat := null; v_site_lng := null; end if;
  if v_type = 'on_site' and v_site_address is null and v_site_area is null then
    raise exception 'NEO_GATE: Add the site address, or at least the area, for an on-site visit.';
  end if;

  -- When.
  v_wstart := public._jts(p, 'window_start', 'The start of the availability window');
  v_wend := public._jts(p, 'window_end', 'The end of the availability window');
  if v_wstart is not null and v_wend is not null and v_wend < v_wstart then
    raise exception 'NEO_GATE: The availability window ends before it starts.';
  end if;
  v_wnote := public._jtxt(p, 'window_note', 300, 'The availability note');
  v_needed := public._jts(p, 'needed_by', 'The needed-by date');

  -- Remote.
  v_rtool := public._vocab(public._jtxt(p, 'remote_tool', 20), 'remote_tool', 'Remote tool');
  v_rref := public._jtxt(p, 'remote_session_ref', 100, 'The session id');
  v_rconsent := public._jts(p, 'remote_consent_at', 'The consent time');

  v_est := public._jint(p, 'est_minutes', 'The estimated time', 0, 100000);

  -- A suggestion only counts if that person can actually take service work.
  v_sugg_email := public._jtxt(p, 'suggested_tech_email', 160, 'The suggested technician');
  if v_sugg_email is not null then
    v_sugg := public._staff_by_email(v_sugg_email);
    if v_sugg.id is null or public.role_rank(public._module_role_of(v_sugg.id, 'service')) < 2 then
      v_sugg_email := null;
    else
      v_sugg_email := v_sugg.email;
    end if;
  end if;
  v_sugg_reason := case when v_sugg_email is not null
                        then public._jtxt(p, 'suggest_reason', 300, 'The reason for the suggestion') end;

  -- At the counter.
  v_acc := public._jtxtarr(p, 'accessories', 30, 80, 'The accessories');
  v_cond := public._jtxt(p, 'condition_note', 2000, 'The condition note');
  v_powers := public._jbool(p, 'powers_on', 'Powers on');
  v_consent := public._vocab(public._jtxt(p, 'data_consent', 30), 'data_consent', 'Data consent');
  v_hasdata := coalesce(public._jbool(p, 'has_customer_data', 'Customer data on board'), false);
  v_business := coalesce(public._jbool(p, 'business', 'Business customer'), false);
  v_in_hand := coalesce(public._jbool(p, 'in_hand', 'In hand'), false);

  v_items := p -> 'items';
  if v_items is not null and jsonb_typeof(v_items) = 'null' then v_items := null; end if;
  if v_items is not null and jsonb_typeof(v_items) <> 'array' then
    raise exception 'NEO_GATE: Items must be a list.';
  end if;
  v_n := coalesce(jsonb_array_length(v_items), 0);
  if v_n > 20 then raise exception 'NEO_GATE: A ticket can hold up to 20 items.'; end if;
  if v_n > 0 then
    v_label := public._jtxt(v_items -> 0, 'label', 200, 'The make and model for item 1');
    v_serial := public._jtxt(v_items -> 0, 'serial', 80, 'The serial for item 1');
  end if;

  -- Only a technician can take their own intake straight to their bench.
  v_self := coalesce(public._jbool(p, 'assign_self', 'Take it myself'), false)
            and public.role_rank(public.module_role('service')) >= 2;

  v_stage := case when v_type = 'in_store' and v_in_hand then 'received' else 'logged' end;

  -- Customer book.
  v_cust := public._customer_upsert(v_phone, v_name, v_email, p_me.email);
  if v_cust is not null then
    if v_type = 'on_site' then
      update public.customers
         set address  = coalesce(nullif(address, ''), v_site_address),
             area     = coalesce(nullif(area, ''), v_site_area),
             pincode  = coalesce(nullif(pincode, ''), v_site_pincode),
             landmark = coalesce(nullif(landmark, ''), v_site_landmark),
             maps_url = coalesce(nullif(maps_url, ''), v_site_maps),
             lat      = coalesce(lat, v_site_lat::double precision),
             lng      = coalesce(lng, v_site_lng::double precision)
       where id = v_cust;
    end if;
    if v_business then
      update public.customers set kind = 'business' where id = v_cust and kind = 'person';
    end if;
  end if;

  -- Ids.
  v_id := public.new_text_id('s');
  for i in 1..5 loop
    v_code := public.new_public_code('NT');
    exit when not exists (select 1 from public.service_jobs where public_code = v_code);
    v_code := null;
  end loop;
  if v_code is null then
    raise exception 'NEO_GATE: Could not make a tracking code just now. Try again.';
  end if;

  v_prev := public._flag_set('neo.rpc');
  insert into public.service_jobs (
    id, public_code, created_at, updated_at, model_version, service_type, channel, category, priority, priority_reason,
    fault_keys, origin, stage, stage_since, received_at,
    customer_name, customer_phone, customer_email, customer_id,
    device_label, device_serial, reported_fault, has_customer_data,
    intake, details, subject,
    created_by_email, created_by_name, suggested_tech_email, suggest_reason,
    assignee, assignee_email, assigned_via, assigned_at, queued_at,
    needed_by, window_start, window_end, window_note,
    site_address, site_area, site_pincode, site_landmark, site_maps_url, site_lat, site_lng, site_contact,
    remote_tool, remote_session_ref, remote_consent_at,
    accessories, condition_note, powers_on, data_consent, est_minutes, client_request_id)
  values (
    v_id, v_code, now(), now(), 2, v_type, v_channel, v_category, v_priority, v_priority_reason,
    v_faults,
    -- SPEC-GAP: origin is a legacy column whose allowed values are not known
    -- here; v1.9.11 always wrote 'counter', so that is the one safe value.
    'counter',
    v_stage, now(), case when v_stage = 'received' then now() end,
    v_name, v_phone, v_email, v_cust,
    v_label, v_serial, v_fault, v_hasdata,
    -- The old intake record, written once, so a v1.9.11 machine still shows it.
    case when v_type = 'in_store'
         then jsonb_build_object('accessories', array_to_string(v_acc, ', '), 'condition', coalesce(v_cond, ''),
                                 'powers_on_at_counter', v_powers, 'taken_by', p_me.full_name, 'taken_at', now())
         else '{}'::jsonb end,
    '{}'::jsonb, '{}'::jsonb,
    p_me.email, p_me.full_name, v_sugg_email, v_sugg_reason,
    case when v_self then p_me.full_name end, case when v_self then p_me.email end,
    case when v_self then 'self' end, case when v_self then now() end,
    case when v_self then null else now() end,
    v_needed, v_wstart, v_wend, v_wnote,
    v_site_address, v_site_area, v_site_pincode, v_site_landmark, v_site_maps,
    v_site_lat::double precision, v_site_lng::double precision, v_site_contact,
    v_rtool, v_rref, v_rconsent,
    v_acc, v_cond, v_powers, v_consent, v_est, v_crid);
  perform public._flag_restore('neo.rpc', v_prev);

  if v_n > 0 then
    for i in 0 .. v_n - 1 loop
      v_item := public._svc_item_insert(v_id, v_items -> i, i, i = 0, p_me.email);
    end loop;
  end if;

  v_body := case when v_stage = 'received'
                 then 'Received at counter. Reported fault: ' || v_fault
                 else 'Request logged by '
                      || coalesce(nullif(split_part(btrim(coalesce(p_me.full_name, '')), ' ', 1), ''), 'our team')
                      || ' (' || public._svc_channel_label(v_channel) || ').' end;
  perform public._svc_ev(v_id, 'stage', v_body, true, null, v_stage, '{}'::jsonb, 'staff', p_me.email, p_me.full_name);

  if v_self then
    perform public._svc_ev(v_id, 'claim', 'Taken by ' || p_me.full_name || ' at intake', false, null, null,
                           jsonb_build_object('tech_email', p_me.email, 'via', 'self'),
                           'staff', p_me.email, p_me.full_name);
  end if;
  if v_sugg_email is not null then
    perform public._svc_ev(v_id, 'suggest', 'Suggested for ' || v_sugg.full_name || coalesce(': ' || v_sugg_reason, ''),
                           false, null, null, jsonb_build_object('suggested_email', v_sugg_email),
                           'staff', p_me.email, p_me.full_name);
  end if;

  return public._svc_create_result(v_id, false);
end $$;

-- Locks in one order everywhere — the ticket(s) first, then the parts — so two
-- people working the same ticket from the two modules wait rather than deadlock.
create or replace function public._rma_lock(p_ids text[])
returns void
language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform 1 from public.service_jobs sj
   where sj.id in (select rc.service_job_id from public.rma_cases rc
                    where rc.id = any (p_ids) and rc.service_job_id is not null)
   order by sj.id
   for update of sj;
  perform 1 from public.rma_cases rc where rc.id = any (p_ids) order by rc.id for update of rc;
end $$;

-- The SPEC §1.4 gates (+ A11 drive data, A12 invoice OR vendor document).
-- Returns sentences; empty means the move may go ahead.
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
    -- A photo counts whether it was taken for this part or, at intake, for the
    -- same ticket item (service_item_id): nobody should unbox a part to
    -- photograph a label the system already has.
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
    -- A11: a drive does not leave the shop until someone has said what
    -- happens to the customer's data on it.
    if p_case.kind in ('ssd', 'hdd') and p_case.data_handling is null then
      v := array_append(v, 'Say what happens to the data on the drive: wiped by us, sent with the customer''s consent, or unreadable and the customer told.');
    end if;
    -- A12: bought elsewhere = the customer's invoice OR a screenshot of the
    -- brand's warranty-check page, and an accepted (or waived) handling fee.
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


-- =============================================================================
-- §15  MODULE ACCESS RPCs
-- =============================================================================

create or replace function public.module_access_set(p_email text, p_module text, p_role text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_target public.profiles;
  v_module text;
  v_role text := nullif(lower(btrim(coalesce(p_role, ''))), '');
begin
  if v_me.tier < 4 then
    raise exception 'NEO_DENIED: Only tier 4 and above can change module access.';
  end if;
  v_module := public._vocab(nullif(lower(btrim(coalesce(p_module, ''))), ''), 'module', 'Module');
  if v_module is null then raise exception 'NEO_GATE: Pick a module.'; end if;
  v_role := public._vocab(v_role, 'module_role', 'Role');
  select * into v_target from public.profiles
   where lower(email) = lower(btrim(coalesce(p_email, ''))) and coalesce(is_staff, false);
  if not found then
    raise exception 'NEO_GATE: No staff profile for "%".', coalesce(btrim(p_email), '');
  end if;

  if v_role is null then
    delete from public.module_access where profile_id = v_target.id and module = v_module;
  else
    insert into public.module_access (profile_id, module, role, granted_by, granted_at)
    values (v_target.id, v_module, v_role, v_me.email, now())
    on conflict (profile_id, module) do update
       set role = excluded.role, granted_by = excluded.granted_by, granted_at = now();
  end if;

  return jsonb_build_object(
    'ok', true, 'email', v_target.email, 'module', v_module, 'role', v_role,
    'effective', case when v_target.tier >= 3 then 'lead' else v_role end);
end $$;

create or replace function public.module_access_list()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare v_me public.profiles := public._neo_me();
begin
  if not (v_me.tier >= 4 or public.has_module('service', 'lead') or public.has_module('rma', 'lead')
          or public.has_module('qc', 'lead') or public.has_module('neohr', 'lead')) then
    raise exception 'NEO_DENIED: Only leads can see module access.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'email', p.email, 'full_name', p.full_name, 'designation', p.designation,
             'tier', p.tier, 'active', p.active, 'auto_lead', p.tier >= 3,
             'service', (select ma.role from public.module_access ma where ma.profile_id = p.id and ma.module = 'service'),
             'rma',     (select ma.role from public.module_access ma where ma.profile_id = p.id and ma.module = 'rma'),
             'qc',      (select ma.role from public.module_access ma where ma.profile_id = p.id and ma.module = 'qc'),
             'neohr',   (select ma.role from public.module_access ma where ma.profile_id = p.id and ma.module = 'neohr'))
           order by p.full_name, p.email)
      from public.profiles p
     where coalesce(p.is_staff, false)), '[]'::jsonb);
end $$;


-- =============================================================================
-- §16  CUSTOMER LOOKUP
-- =============================================================================

create or replace function public.lookup_customer(p_phone text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_norm text := public.norm_phone(p_phone);
  v_full boolean := public.svc_reader() or public.rma_reader();
  v_cust public.customers;
  v_cust_id uuid;
  v_open jsonb; v_recent jsonb; v_total int; v_rma jsonb; v_techs jsonb;
  v_open_n int; v_name text; v_first text; v_last text;
begin
  -- Exact match only. A prefix search would let anyone page through the book.
  if not public.phone_ok(p_phone) then
    if not v_full then
      return jsonb_build_object('phone_norm', v_norm, 'known', false, 'display_name', null, 'open_count', 0,
                                'limited', true);
    end if;
    return jsonb_build_object('phone_norm', v_norm, 'customer', null, 'open_jobs', '[]'::jsonb,
                              'recent_jobs', '[]'::jsonb, 'jobs_total', 0, 'open_rma', '[]'::jsonb,
                              'past_techs', '[]'::jsonb);
  end if;
  select * into v_cust from public.customers where phone_norm = v_norm;
  v_cust_id := v_cust.id;

  -- SPEC-AMENDMENTS A19: someone without service or RMA access (sales, tier
  -- 1) learns only whether the number is known, a short name and how many
  -- tickets are open — enough for "This customer already has 1 open ticket —
  -- the help desk will link it". No codes, ids, technicians or parts.
  if not v_full then
    select count(*) filter (where sj.stage <> 'closed'), count(*),
           (array_agg(sj.customer_name order by sj.created_at desc))[1]
      into v_open_n, v_total, v_name
      from public.service_jobs sj
     where public.norm_phone(sj.customer_phone) = v_norm or (v_cust_id is not null and sj.customer_id = v_cust_id);
    v_name := btrim(coalesce(nullif(btrim(v_cust.name), ''), v_name, ''));
    v_first := nullif(split_part(v_name, ' ', 1), '');
    v_last := nullif(regexp_replace(v_name, '^.*\s', ''), '');
    return jsonb_build_object(
      'phone_norm', v_norm,
      'known', v_cust_id is not null or coalesce(v_total, 0) > 0,
      'display_name', case when v_first is null then null
                           when v_name !~ '\s' then v_first
                           else v_first || ' ' || upper(left(v_last, 1)) || '.' end,
      'open_count', coalesce(v_open_n, 0),
      'limited', true);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', sj.id, 'public_code', sj.public_code,
                                               'service_type', sj.service_type, 'stage', sj.stage,
                                               'device_label', sj.device_label, 'created_at', sj.created_at,
                                               'assignee', sj.assignee)
                            order by sj.created_at desc) filter (where sj.stage <> 'closed'), '[]'::jsonb),
         count(*)
    into v_open, v_total
    from public.service_jobs sj
   where public.norm_phone(sj.customer_phone) = v_norm or (v_cust_id is not null and sj.customer_id = v_cust_id);

  select coalesce(jsonb_agg(x.o order by x.closed_at desc nulls last), '[]'::jsonb) into v_recent
    from (select jsonb_build_object('public_code', sj.public_code, 'service_type', sj.service_type,
                                    'stage', sj.stage, 'outcome', sj.outcome, 'device_label', sj.device_label,
                                    'created_at', sj.created_at, 'closed_at', sj.closed_at,
                                    'assignee', sj.assignee) as o,
                 sj.closed_at
            from public.service_jobs sj
           where (public.norm_phone(sj.customer_phone) = v_norm or (v_cust_id is not null and sj.customer_id = v_cust_id))
             and sj.stage = 'closed'
           order by sj.closed_at desc nulls last
           limit 5) x;

  select coalesce(jsonb_agg(jsonb_build_object('id', rc.id, 'public_code', rc.public_code, 'kind', rc.kind,
                                               'brand', rc.brand, 'model', rc.model, 'stage', rc.stage)
                            order by rc.created_at desc), '[]'::jsonb)
    into v_rma
    from public.rma_cases rc
    join public.rma_intakes ri on ri.id = rc.intake_id
   where rc.stage <> 'closed'
     and (public.norm_phone(rc.owner_phone) = v_norm
          or public.norm_phone(ri.sender_phone) = v_norm
          or (v_cust_id is not null and ri.sender_customer_id = v_cust_id));

  -- SPEC-GAP: only technicians still active are listed — this list feeds a
  -- "Suggest <name>" button, and a suggestion for someone who left is noise.
  select coalesce(jsonb_agg(jsonb_build_object('email', t.email, 'name', t.name, 'jobs', t.jobs, 'last_at', t.last_at)
                            order by t.last_at desc nulls last), '[]'::jsonb)
    into v_techs
    from (select pr.email, max(pr.full_name) as name, count(*) as jobs,
                 max(coalesce(sj.closed_at, sj.assigned_at, sj.updated_at, sj.created_at)) as last_at
            from public.service_jobs sj
            join public.profiles pr on lower(pr.email) = lower(sj.assignee_email)
                                   and pr.active and coalesce(pr.is_staff, false)
           where sj.assignee_email is not null
             and (public.norm_phone(sj.customer_phone) = v_norm or (v_cust_id is not null and sj.customer_id = v_cust_id))
           group by pr.email) t;

  return jsonb_build_object(
    'phone_norm', v_norm,
    'customer', case when v_cust_id is null then null
                     else jsonb_build_object('id', v_cust.id, 'name', v_cust.name, 'email', v_cust.email,
                                             'kind', v_cust.kind, 'address', v_cust.address, 'area', v_cust.area,
                                             'pincode', v_cust.pincode, 'landmark', v_cust.landmark,
                                             'maps_url', v_cust.maps_url) end,
    'open_jobs', v_open,
    'recent_jobs', v_recent,
    'jobs_total', coalesce(v_total, 0),
    'open_rma', v_rma,
    'past_techs', v_techs);
end $$;

-- SPEC-AMENDMENTS A20: find a past Neo Tokyo build — the link between a
-- service item and the build we sold, since build tickets carry no phone.
-- Matches the 6-character receipt code (the id's tail), the customer's name
-- (3+ characters; % and _ are literal), or a serial recorded on the build
-- (tickets.serials, specs.__verify, specs.__procurement). A serial query must
-- have 6+ letters/digits including a digit, so a name never "matches" as a
-- serial. Optional build columns are read through to_jsonb, so a column the
-- live table lacks reads as null instead of breaking the search.
create or replace function public.find_builds(p_query text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_q text := btrim(coalesce(p_query, ''));
  v_code text;
  v_like text;
  v_sn text;
begin
  if not (public.svc_reader() or public.rma_reader()) then
    raise exception 'NEO_DENIED: You don''t have access to look up builds.';
  end if;
  if v_q = '' then return '[]'::jsonb; end if;
  if length(v_q) > 120 then raise exception 'NEO_GATE: That search is too long.'; end if;

  v_code := upper(regexp_replace(v_q, '^#', ''));
  if length(v_q) >= 3 then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  v_sn := upper(regexp_replace(v_q, '[^A-Za-z0-9]', '', 'g'));
  if length(v_sn) < 6 or v_sn !~ '[0-9]' then v_sn := null; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', m.id,
             'code', upper(right(m.id, 6)),
             'customer_name', m.customer_name,
             'created_at', m.created_at,
             'completed_at', m.j -> 'completed_at',
             'handed_over_at', m.j -> 'handed_over_at',
             'summary', nullif(concat_ws(' · ', nullif(btrim(m.j -> 'specs' ->> 'cpu'), ''),
                                         nullif(btrim(m.j -> 'specs' ->> 'gpu'), '')), ''),
             'match', case m.rank when 1 then 'code' when 2 then 'name' else 'serial' end)
           order by m.rank, m.created_at desc nulls last)
      from (select s.*
              from (select t.id, t.customer_name, t.created_at, to_jsonb(t) as j,
                           case
                             when length(v_code) = 6 and upper(right(t.id, 6)) = v_code then 1
                             when v_like is not null and t.customer_name ilike v_like then 2
                             -- Quotes are kept as separators, so a serial is
                             -- matched inside one JSON value, never across a
                             -- key and its value.
                             when v_sn is not null
                                  and (strpos(upper(regexp_replace(coalesce(to_jsonb(t) -> 'serials', 'null'::jsonb)::text,
                                                                   '[^A-Za-z0-9"]', '', 'g')), v_sn) > 0
                                       or strpos(upper(regexp_replace(coalesce(to_jsonb(t) -> 'specs' -> '__verify', 'null'::jsonb)::text,
                                                                      '[^A-Za-z0-9"]', '', 'g')), v_sn) > 0
                                       or strpos(upper(regexp_replace(coalesce(to_jsonb(t) -> 'specs' -> '__procurement', 'null'::jsonb)::text,
                                                                      '[^A-Za-z0-9"]', '', 'g')), v_sn) > 0) then 3
                           end as rank
                      from public.tickets t) s
             where s.rank is not null
             order by s.rank, s.created_at desc nulls last
             limit 10) m), '[]'::jsonb);
end $$;


-- =============================================================================
-- §17  SERVICE RPCs
-- =============================================================================

create or replace function public.service_create(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();     -- sales, desk, techs, leads may all create
  v_crid uuid;
  v_existing text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'NEO_GATE: The request is empty.';
  end if;
  v_crid := public._juuid(p, 'client_request_id');
  if v_crid is not null then
    select id into v_existing from public.service_jobs where client_request_id = v_crid;
    if found then return public._svc_create_result(v_existing, true); end if;
  end if;
  begin
    return public._svc_create(p, v_me);
  exception when unique_violation then
    -- Two submits of the same form raced; the other one won. Hand back its ticket.
    if v_crid is not null then
      select id into v_existing from public.service_jobs where client_request_id = v_crid;
      if found then return public._svc_create_result(v_existing, true); end if;
    end if;
    raise;
  end;
end $$;

create or replace function public.service_move(
  p_job_id text, p_from text, p_to text,
  p_note text default null, p_visible boolean default true, p_extra jsonb default '{}'::jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_job public.service_jobs;
  v_new public.service_jobs;
  x jsonb := case when jsonb_typeof(coalesce(p_extra, '{}'::jsonb)) = 'object' then coalesce(p_extra, '{}'::jsonb)
                  else '{}'::jsonb end;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_conv text; v_outcome text; v_party text; v_chase timestamptz; v_prom timestamptz;
  v_vs timestamptz; v_ve timestamptz;
  v_sa text; v_sar text; v_sp text; v_sl text; v_sm text;
  v_prev text;
begin
  if not public.has_module('service', 'desk') then
    raise exception 'NEO_DENIED: You don''t have access to move service tickets.';
  end if;
  if v_note is not null and length(v_note) > 4000 then
    raise exception 'NEO_GATE: The note is too long — keep it under 4000 characters.';
  end if;

  select * into v_job from public.service_jobs where id = p_job_id for update;
  if not found then raise exception 'NEO_GATE: That ticket no longer exists.'; end if;
  if v_job.stage is distinct from p_from then
    raise exception 'NEO_STALE: Someone moved this ticket to % already. Reopen it to see where it is.',
      public._svc_stage_label(v_job.stage);
  end if;
  if not public.svc_known_stage(p_to) then
    raise exception 'NEO_GATE: Pick a stage to move to.';
  end if;

  v_conv := public._vocab(public._jtxt(x, 'convert_to', 20), 'service_type', 'Ticket type');
  if v_conv = v_job.service_type then v_conv := null; end if;
  if v_conv is null and p_to = v_job.stage then
    raise exception 'NEO_GATE: The ticket is already at %.', public._svc_stage_label(p_to);
  end if;
  if v_conv is not null and v_job.model_version < 2 then
    raise exception 'NEO_GATE: Only tickets created in this version can change type.';
  end if;

  -- Who we are waiting on. Leaving a waiting stage clears the name and the
  -- chase date, so the chase list never names a supplier who holds nothing.
  if p_to in ('at_vendor', 'parts_on_order') then
    v_party := public._jtxt(x, 'waiting_party', 120, 'The supplier name');
    if v_party is null then
      raise exception 'NEO_GATE: Say who we are waiting on — that is the whole point of the chase list.';
    end if;
    v_chase := public._jts(x, 'next_chase_at', 'The expected date');
  end if;

  -- An outcome is required to finish: the customer's page composes "Closed"
  -- from it, and "Closed" on its own tells them nothing.
  if p_to in ('ready', 'closed') then
    v_outcome := public._vocab(public._jtxt(x, 'outcome', 40), 'outcome', 'Outcome');
    if v_outcome is null and p_to = 'closed' and v_job.stage = 'ready' then
      v_outcome := v_job.outcome;
    end if;
    if v_outcome is null then
      raise exception 'NEO_GATE: Say what happened — the customer sees this, and "Closed" on its own tells them nothing.';
    end if;
  end if;

  v_prom := public._jts(x, 'promised_at', 'The promised date');
  v_vs := public._jts(x, 'visit_start', 'The visit start');
  v_ve := public._jts(x, 'visit_end', 'The visit end');
  if coalesce(v_vs, v_job.visit_start) is not null and v_ve is not null and v_ve < coalesce(v_vs, v_job.visit_start) then
    raise exception 'NEO_GATE: The visit ends before it starts.';
  end if;

  v_sa := coalesce(public._jtxt(x, 'site_address', 500, 'The site address'), v_job.site_address);
  v_sar := coalesce(public._jtxt(x, 'site_area', 120, 'The area'), v_job.site_area);
  v_sp := coalesce(public._jtxt(x, 'site_pincode', 12, 'The pincode'), v_job.site_pincode);
  v_sl := coalesce(public._jtxt(x, 'site_landmark', 200, 'The landmark'), v_job.site_landmark);
  v_sm := coalesce(public._jtxt(x, 'site_maps_url', 1000, 'The map link'), v_job.site_maps_url);
  if v_conv = 'on_site' and v_sa is null and v_sar is null then
    raise exception 'NEO_GATE: Add the site address, or at least the area, before switching to on-site.';
  end if;

  v_prev := public._flag_set('neo.rpc');
  update public.service_jobs
     set stage          = p_to,
         stage_since    = now(),
         service_type   = coalesce(v_conv, service_type),
         converted_from = case when v_conv is not null then v_job.service_type else converted_from end,
         waiting_party  = v_party,
         next_chase_at  = v_chase,
         outcome        = case when p_to in ('ready', 'closed') then v_outcome else null end,
         ready_at       = case when p_to = 'ready' then now() when p_to = 'closed' then ready_at else null end,
         closed_at      = case when p_to = 'closed' then now() else null end,
         closed_by      = case when p_to = 'closed' then v_me.email else null end,
         received_at    = case when p_to = 'received' and received_at is null then now() else received_at end,
         promised_at    = coalesce(v_prom, promised_at),
         visit_start    = case when v_conv = 'in_store' then null else coalesce(v_vs, visit_start) end,
         visit_end      = case when v_conv = 'in_store' then null else coalesce(v_ve, visit_end) end,
         site_address   = case when v_conv = 'on_site' then v_sa else site_address end,
         site_area      = case when v_conv = 'on_site' then v_sar else site_area end,
         site_pincode   = case when v_conv = 'on_site' then v_sp else site_pincode end,
         site_landmark  = case when v_conv = 'on_site' then v_sl else site_landmark end,
         site_maps_url  = case when v_conv = 'on_site' then v_sm else site_maps_url end,
         updated_at     = now()
   where id = p_job_id
  returning * into v_new;
  perform public._flag_restore('neo.rpc', v_prev);

  if v_conv is not null then
    perform public._svc_ev(p_job_id, 'stage',
      'Converted from ' || public._svc_type_label(v_job.service_type) || ' to ' || public._svc_type_label(v_conv) || '.',
      true, v_job.stage, p_to, jsonb_build_object('converted_from', v_job.service_type, 'converted_to', v_conv),
      'staff', v_me.email, v_me.full_name);
    if v_note is not null then
      perform public._svc_ev(p_job_id, 'note', v_note, coalesce(p_visible, true), null, null, '{}'::jsonb,
                             'staff', v_me.email, v_me.full_name);
    end if;
  else
    -- The MOVE is always the customer's business; a note attached to it is
    -- not necessarily, so it carries its own tick.
    perform public._svc_ev(p_job_id, 'stage', v_note,
                           case when v_note is not null then coalesce(p_visible, true) else true end,
                           v_job.stage, p_to, '{}'::jsonb, 'staff', v_me.email, v_me.full_name);
  end if;

  return to_jsonb(v_new);
end $$;

create or replace function public.service_claim(
  p_job_id text, p_visit_start timestamptz default null, p_visit_end timestamptz default null,
  p_reason text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_job public.service_jobs;
  v_new public.service_jobs;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_from text;
  v_to text;
  v_when text;
  v_old_start timestamptz;
  v_moved boolean := false;
  v_prev text;
begin
  if not public.has_module('service', 'tech') then
    raise exception 'NEO_DENIED: Only technicians can take tickets from the queue.';
  end if;
  if v_reason is not null and length(v_reason) > 300 then
    raise exception 'NEO_GATE: The reason is too long — keep it under 300 characters.';
  end if;
  if p_visit_start is not null and p_visit_end is not null and p_visit_end < p_visit_start then
    raise exception 'NEO_GATE: The visit ends before it starts.';
  end if;

  -- Atomic: two technicians claiming at once — the second update waits on the
  -- row lock, re-checks "assignee_email is null", finds it taken, and returns 0 rows.
  v_prev := public._flag_set('neo.assign');
  update public.service_jobs
     set assignee = v_me.full_name, assignee_email = v_me.email, assigned_via = 'claim',
         assigned_at = now(), queued_at = null, assign_reason = v_reason
   where id = p_job_id and assignee_email is null and stage <> 'closed'
  returning * into v_new;
  perform public._flag_restore('neo.assign', v_prev);

  -- (Not FOUND: the PERFORM above has already reset it.)
  if v_new.id is null then
    select * into v_job from public.service_jobs where id = p_job_id;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    if v_job.stage = 'closed' then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
    -- A17: the caller already has it (a retry after a lost answer, or a
    -- double press) — that is a success, not "taken by you".
    if lower(coalesce(v_job.assignee_email, '')) = lower(v_me.email) then
      return jsonb_build_object('ok', true, 'already', true, 'job', to_jsonb(v_job));
    end if;
    return jsonb_build_object('ok', false, 'reason', 'taken', 'by', v_job.assignee,
                              'by_email', v_job.assignee_email, 'at', v_job.assigned_at);
  end if;

  v_from := v_new.stage;
  -- (v_new is still the row as it was before the claim: the update above
  -- touched only who has it.)
  v_old_start := v_new.visit_start;
  if p_visit_start is not null and v_new.service_type in ('on_site', 'remote') then
    v_to := case when v_new.service_type = 'on_site' and v_new.stage in ('logged', 'revisit_needed') then 'scheduled'
                 when v_new.service_type = 'remote' and v_new.stage = 'logged' then 'session_booked'
                 else null end;
    -- The desk had already booked a time with the customer and the technician
    -- takes the ticket at a different one: the stage does not change, so
    -- nothing else would tell the customer their visit moved.
    v_moved := v_to is null and v_from in ('scheduled', 'session_booked')
               and v_old_start is not null and p_visit_start is distinct from v_old_start;
    v_prev := public._flag_set('neo.rpc');
    update public.service_jobs
       set visit_start = p_visit_start,
           visit_end   = p_visit_end,
           stage       = coalesce(v_to, stage),
           stage_since = case when v_to is not null then now() else stage_since end
     where id = p_job_id
    returning * into v_new;
    perform public._flag_restore('neo.rpc', v_prev);
    v_when := public._ist(p_visit_start);
  end if;

  perform public._svc_ev(p_job_id, 'claim',
    'Taken by ' || v_me.full_name
      || case when v_moved then ' — visit moved from ' || public._ist(v_old_start) || ' to ' || v_when
              else coalesce(' — visit ' || v_when, '') end
      || coalesce('. Reason: ' || v_reason, ''),
    false, null, null,
    jsonb_build_object('tech_email', v_me.email, 'via', 'claim', 'reason', v_reason,
                       'requested_for', v_new.suggested_tech_email, 'visit_start', p_visit_start)
      || case when v_moved then jsonb_build_object('visit_was', v_old_start) else '{}'::jsonb end,
    'staff', v_me.email, v_me.full_name);
  if v_to is not null then
    perform public._svc_ev(p_job_id, 'stage',
      case when v_to = 'scheduled' then 'Visit booked for ' else 'Remote session booked for ' end || v_when || '.',
      true, v_from, v_to, '{}'::jsonb, 'staff', v_me.email, v_me.full_name);
  elsif v_moved then
    -- A stage-kind line with no stage pair: the ticket stays where it is, so
    -- every timeline (v1.9.11's included) shows just the sentence.
    perform public._svc_ev(p_job_id, 'stage',
      case when v_from = 'scheduled' then 'Visit moved to ' else 'Remote session moved to ' end || v_when || '.',
      true, null, null, jsonb_build_object('visit_was', v_old_start, 'visit_start', p_visit_start),
      'staff', v_me.email, v_me.full_name);
  end if;

  return jsonb_build_object('ok', true, 'job', to_jsonb(v_new));
end $$;

-- Shared by service_release and service_assign(null): clears the assignee and
-- puts a booked-but-not-started visit back to "logged".
create or replace function public._svc_unassign(p_job public.service_jobs, p_me public.profiles, p_reason text, p_via text)
returns public.service_jobs
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_new public.service_jobs;
  v_to text := case when p_job.stage in ('scheduled', 'session_booked') then 'logged' end;
  v_prev text;
begin
  v_prev := public._flag_set('neo.assign');
  update public.service_jobs
     set assignee = null, assignee_email = null, assigned_via = null, assigned_at = null, assign_reason = null,
         queued_at = now(),
         stage = coalesce(v_to, stage),
         stage_since = case when v_to is not null then now() else stage_since end,
         visit_start = case when v_to is not null then null else visit_start end,
         visit_end = case when v_to is not null then null else visit_end end
   where id = p_job.id
  returning * into v_new;
  perform public._flag_restore('neo.assign', v_prev);

  perform public._svc_ev(p_job.id, 'release',
    case when p_via = 'manager' then 'Unassigned by ' || p_me.full_name else 'Handed back by ' || p_me.full_name end
      || case when lower(p_job.assignee_email) <> lower(p_me.email) then ' (was ' || coalesce(p_job.assignee, p_job.assignee_email) || ')' else '' end
      || ': ' || p_reason,
    false, null, null,
    jsonb_build_object('tech_email', p_job.assignee_email, 'by_email', p_me.email, 'reason', p_reason, 'via', p_via),
    'staff', p_me.email, p_me.full_name);
  if v_to is not null then
    perform public._svc_ev(p_job.id, 'stage',
      case when p_job.stage = 'scheduled' then 'We''re rebooking your visit time.'
           else 'We''re rebooking your remote session.' end,
      true, p_job.stage, v_to, '{}'::jsonb, 'staff', p_me.email, p_me.full_name);
  end if;
  return v_new;
end $$;

create or replace function public.service_release(p_job_id text, p_reason text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_job public.service_jobs;
  v_lead boolean := public.has_module('service', 'lead');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_reason is null then raise exception 'NEO_GATE: Say why you''re handing it back.'; end if;
  if length(v_reason) > 300 then raise exception 'NEO_GATE: The reason is too long — keep it under 300 characters.'; end if;
  select * into v_job from public.service_jobs where id = p_job_id for update;
  if not found then raise exception 'NEO_GATE: That ticket no longer exists.'; end if;
  if v_job.assignee_email is null then
    raise exception 'NEO_STALE: Nobody has this ticket now. Reopen it to see the latest.';
  end if;
  if lower(v_job.assignee_email) <> lower(v_me.email) and not v_lead then
    raise exception 'NEO_DENIED: Only the technician who has this ticket, or a lead, can hand it back.';
  end if;
  if v_job.stage = 'closed' then raise exception 'NEO_GATE: This ticket is closed.'; end if;
  if v_job.stage in ('en_route', 'on_site') and not v_lead then
    raise exception 'NEO_GATE: You''re on the way or on site. Check out first, or ask a lead to reassign it.';
  end if;
  return jsonb_build_object('ok', true,
                            'job', to_jsonb(public._svc_unassign(v_job, v_me, v_reason, 'release')));
end $$;

-- The signature grew a 4th parameter (A16); drop the 3-argument version so
-- PostgREST never has two candidates for the same named call.
drop function if exists public.service_assign(text, text, text);

-- SPEC-AMENDMENTS A16. Compare-and-set: p_expected is the assignee the lead's
-- screen showed (null = it showed the ticket unassigned). If someone claimed,
-- released or reassigned it since, nothing changes and the answer is
-- {ok:false, reason:'changed', by, at} — not an error. An UNCLAIMED on-site
-- ticket belongs to the technicians first: a lead may assign it only once it
-- has waited 75% of its queue budget, when it is urgent, or for an
-- "Emergency: …" reason. In-store and remote tickets: any time, with a reason.
create or replace function public.service_assign(
  p_job_id text, p_email text, p_reason text, p_expected text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_job public.service_jobs;
  v_new public.service_jobs;
  v_target public.profiles;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_expected text := nullif(lower(btrim(coalesce(p_expected, ''))), '');
  v_budget numeric;
  v_waited numeric;
  v_prev text;
begin
  if not public.has_module('service', 'lead') then
    raise exception 'NEO_DENIED: Only a lead can assign tickets.';
  end if;
  if v_reason is null then raise exception 'NEO_GATE: Say why you''re assigning it.'; end if;
  if length(v_reason) > 300 then raise exception 'NEO_GATE: The reason is too long — keep it under 300 characters.'; end if;
  select * into v_job from public.service_jobs where id = p_job_id for update;
  if not found then raise exception 'NEO_GATE: That ticket no longer exists.'; end if;
  if v_job.stage = 'closed' then raise exception 'NEO_GATE: This ticket is closed.'; end if;

  -- Compare-and-set (the row is locked, so this is the same as the UPDATE's
  -- "where assignee_email is not distinct from p_expected").
  if nullif(lower(btrim(coalesce(v_job.assignee_email, ''))), '') is distinct from v_expected then
    return jsonb_build_object('ok', false, 'reason', 'changed', 'by', v_job.assignee,
                              'by_email', v_job.assignee_email, 'at', coalesce(v_job.assigned_at, v_job.updated_at));
  end if;

  -- The on-site queue gate.
  if v_job.service_type = 'on_site' and v_job.assignee_email is null
     and nullif(btrim(coalesce(p_email, '')), '') is not null
     and v_job.priority is distinct from 'urgent'
     and v_reason !~* '^emergency:' then
    v_budget := case v_job.priority when 'high' then 4 when 'low' then 24 else 8 end;
    v_waited := extract(epoch from (now() - coalesce(v_job.queued_at, v_job.created_at))) / 3600.0;
    if v_waited < 0.75 * v_budget then
      raise exception 'NEO_GATE: Let the technicians claim on-site tickets first — you can assign this once it has waited % hours, or mark it urgent.',
        rtrim(to_char(0.75 * v_budget, 'FM999990.99'), '.');
    end if;
  end if;

  if nullif(btrim(coalesce(p_email, '')), '') is null then
    if v_job.assignee_email is null then
      return jsonb_build_object('ok', true, 'unchanged', true, 'job', to_jsonb(v_job));
    end if;
    return jsonb_build_object('ok', true,
                              'job', to_jsonb(public._svc_unassign(v_job, v_me, v_reason, 'manager')));
  end if;

  -- Evaluated for the TARGET: tier 3+, or a service tech/lead row.
  v_target := public._staff_by_email(p_email);
  if v_target.id is null or public.role_rank(public._module_role_of(v_target.id, 'service')) < 2 then
    raise exception 'NEO_GATE: % can''t take service tickets. Give them the Tech role in Module access first.',
      coalesce(v_target.full_name, btrim(p_email));
  end if;
  if lower(coalesce(v_job.assignee_email, '')) = lower(v_target.email) then
    return jsonb_build_object('ok', true, 'unchanged', true, 'job', to_jsonb(v_job));
  end if;

  v_prev := public._flag_set('neo.assign');
  update public.service_jobs
     set assignee = v_target.full_name, assignee_email = v_target.email, assigned_via = 'manager',
         assigned_at = now(), queued_at = null, assign_reason = v_reason
   where id = p_job_id
  returning * into v_new;
  perform public._flag_restore('neo.assign', v_prev);

  perform public._svc_ev(p_job_id, 'assign',
    'Assigned to ' || v_target.full_name || ' by ' || v_me.full_name
      || case when v_job.assignee_email is not null then ' (was ' || coalesce(v_job.assignee, v_job.assignee_email) || ')' else '' end
      || ': ' || v_reason,
    false, null, null,
    jsonb_build_object('tech_email', v_target.email, 'from_email', v_job.assignee_email,
                       'by_email', v_me.email, 'reason', v_reason, 'via', 'manager'),
    'staff', v_me.email, v_me.full_name);

  return jsonb_build_object('ok', true, 'job', to_jsonb(v_new));
end $$;

create or replace function public.service_suggest(p_job_id text, p_email text, p_reason text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_job public.service_jobs;
  v_new public.service_jobs;
  v_target public.profiles;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_prev text;
begin
  select * into v_job from public.service_jobs where id = p_job_id for update;
  if not found then raise exception 'NEO_GATE: That ticket no longer exists.'; end if;
  if not (public.has_module('service', 'desk') or lower(coalesce(v_job.created_by_email, '')) = lower(v_me.email)) then
    raise exception 'NEO_DENIED: Only the service desk, or whoever raised this ticket, can suggest a technician.';
  end if;
  if v_job.stage = 'closed' then raise exception 'NEO_GATE: This ticket is closed.'; end if;
  if v_reason is not null and length(v_reason) > 300 then
    raise exception 'NEO_GATE: The reason is too long — keep it under 300 characters.';
  end if;

  if nullif(btrim(coalesce(p_email, '')), '') is null then
    v_prev := public._flag_set('neo.rpc');
    update public.service_jobs set suggested_tech_email = null, suggest_reason = null
     where id = p_job_id returning * into v_new;
    perform public._flag_restore('neo.rpc', v_prev);
    perform public._svc_ev(p_job_id, 'suggest', 'Suggestion cleared', false, null, null,
                           jsonb_build_object('suggested_email', null), 'staff', v_me.email, v_me.full_name);
  else
    v_target := public._staff_by_email(p_email);
    if v_target.id is null or public.role_rank(public._module_role_of(v_target.id, 'service')) < 2 then
      raise exception 'NEO_GATE: % can''t take service tickets.', coalesce(v_target.full_name, btrim(p_email));
    end if;
    v_prev := public._flag_set('neo.rpc');
    update public.service_jobs set suggested_tech_email = v_target.email, suggest_reason = v_reason
     where id = p_job_id returning * into v_new;
    perform public._flag_restore('neo.rpc', v_prev);
    perform public._svc_ev(p_job_id, 'suggest', 'Suggested for ' || v_target.full_name || coalesce(': ' || v_reason, ''),
                           false, null, null, jsonb_build_object('suggested_email', v_target.email),
                           'staff', v_me.email, v_me.full_name);
  end if;

  if public.svc_reader() then
    return jsonb_build_object('ok', true, 'job', to_jsonb(v_new));
  end if;
  return jsonb_build_object('ok', true, 'public_code', v_new.public_code,
                            'suggested_tech_email', v_new.suggested_tech_email, 'suggest_reason', v_new.suggest_reason);
end $$;

create or replace function public.service_set_priority(p_job_id text, p_priority text, p_reason text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_job public.service_jobs;
  v_new public.service_jobs;
  v_p text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_prev text;
begin
  select * into v_job from public.service_jobs where id = p_job_id for update;
  if not found then raise exception 'NEO_GATE: That ticket no longer exists.'; end if;
  if not (public.has_module('service', 'lead')
          or (public.has_module('service', 'desk') and v_job.stage in ('logged', 'received'))) then
    raise exception 'NEO_DENIED: Only a lead can change the priority once work has started.';
  end if;
  v_p := public._vocab(nullif(btrim(coalesce(p_priority, '')), ''), 'priority', 'Priority');
  if v_p is null then raise exception 'NEO_GATE: Pick a priority.'; end if;
  if v_reason is null then raise exception 'NEO_GATE: Say why the priority is changing.'; end if;
  if length(v_reason) > 300 then raise exception 'NEO_GATE: The reason is too long — keep it under 300 characters.'; end if;
  if v_p = v_job.priority then
    return jsonb_build_object('ok', true, 'unchanged', true, 'job', to_jsonb(v_job));
  end if;

  v_prev := public._flag_set('neo.rpc');
  update public.service_jobs
     set priority = v_p, priority_reason = v_reason, priority_set_by = v_me.email
   where id = p_job_id
  returning * into v_new;
  perform public._flag_restore('neo.rpc', v_prev);

  perform public._svc_ev(p_job_id, 'priority',
    'Priority changed from ' || initcap(v_job.priority) || ' to ' || initcap(v_p) || ': ' || v_reason,
    false, null, null, jsonb_build_object('priority_from', v_job.priority, 'priority_to', v_p),
    'staff', v_me.email, v_me.full_name);
  return jsonb_build_object('ok', true, 'job', to_jsonb(v_new));
end $$;

create or replace function public.service_add_item(p_job_id text, p_item jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_job public.service_jobs;
  v_item public.service_items;
  v_count int;
  v_sort int;
  v_primary boolean;
begin
  if not public.has_module('service', 'desk') then
    raise exception 'NEO_DENIED: You don''t have access to change service tickets.';
  end if;
  select * into v_job from public.service_jobs where id = p_job_id for update;
  if not found then raise exception 'NEO_GATE: That ticket no longer exists.'; end if;
  if v_job.stage = 'closed' then raise exception 'NEO_GATE: This ticket is closed.'; end if;
  select count(*), coalesce(max(sort) + 1, 0), not coalesce(bool_or(is_primary), false)
    into v_count, v_sort, v_primary
    from public.service_items where job_id = p_job_id;
  if v_count >= 20 then raise exception 'NEO_GATE: A ticket can hold up to 20 items.'; end if;

  v_item := public._svc_item_insert(p_job_id, p_item, v_sort, v_primary, v_me.email);
  perform public._svc_ev(p_job_id, 'edit',
    'Item added: ' || public._item_kind_label(v_item.kind) || coalesce(' — ' || v_item.label, ''),
    false, null, null, jsonb_build_object('service_item_id', v_item.id), 'staff', v_me.email, v_me.full_name);
  return to_jsonb(v_item);
end $$;

create or replace function public.service_add_note(p_job_id text, p_body text, p_visible boolean default false)
returns jsonb
language plpgsql volatile security definer
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

create or replace function public.service_tech_list()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_day_start timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'email', t.email, 'name', t.full_name, 'designation', t.designation, 'role', t.role,
             'open_count', (select count(*) from public.service_jobs sj
                             where lower(sj.assignee_email) = lower(t.email) and sj.stage <> 'closed'),
             'visits_today', (select count(*) from public.service_jobs sj
                               where lower(sj.assignee_email) = lower(t.email) and sj.stage <> 'closed'
                                 and sj.visit_start >= v_day_start and sj.visit_start < v_day_start + interval '1 day'),
             'in_queue_requested', (select count(*) from public.service_jobs sj
                                     where lower(sj.suggested_tech_email) = lower(t.email)
                                       and sj.assignee_email is null and sj.stage <> 'closed'))
           order by t.full_name, t.email)
      from (select p.email, p.full_name, p.designation,
                   case when p.tier >= 3 then 'lead' else ma.role end as role
              from public.profiles p
              left join public.module_access ma on ma.profile_id = p.id and ma.module = 'service'
             where p.active and coalesce(p.is_staff, false)
               and (p.tier >= 3 or ma.role in ('tech', 'lead'))) t), '[]'::jsonb);
end $$;

create or replace function public.service_my_requests()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare v_me public.profiles := public._neo_me();
begin
  return jsonb_build_object(
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'public_code', sj.public_code, 'service_type', sj.service_type, 'stage', sj.stage,
               'outcome', sj.outcome, 'customer_name', sj.customer_name, 'device_label', sj.device_label,
               'assignee', sj.assignee, 'created_at', sj.created_at, 'promised_at', sj.promised_at,
               'visit_start', sj.visit_start)
             order by sj.created_at desc)
        from public.service_jobs sj
       where lower(sj.created_by_email) = lower(v_me.email)
         and sj.created_at >= now() - interval '60 days'), '[]'::jsonb),
    'rma_units', coalesce((
      select jsonb_agg(jsonb_build_object(
               'public_code', rc.public_code, 'kind', rc.kind, 'brand', rc.brand, 'model', rc.model,
               'stage', rc.stage, 'disposition', rc.disposition, 'created_at', rc.created_at)
             order by rc.created_at desc)
        from public.rma_cases rc
       where lower(rc.created_by_email) = lower(v_me.email)
         and rc.created_at >= now() - interval '60 days'), '[]'::jsonb));
end $$;

-- Public tracking for NT- codes. Recreated (not just replaced) so a different
-- return type on the live function cannot block the migration; grants are
-- re-applied in §22. Keeps every key the website reads today and adds
-- service_type, visit_start, visit_end and rma_units.
drop function if exists public.get_service_public(text, text);
create function public.get_service_public(code text, phone4 text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_code text := upper(btrim(coalesce($1, '')));
  v_p4 text := btrim(coalesce($2, ''));
  v_job public.service_jobs;
begin
  -- The access check is the code + the last 4 digits together; a wrong code and
  -- a wrong phone give the same null, so the page cannot confirm a code exists.
  if v_code = '' or v_p4 !~ '^[0-9]{4}$' then return null; end if;
  select * into v_job from public.service_jobs sj
   where sj.public_code = v_code
     and right(regexp_replace(coalesce(sj.customer_phone, ''), '[^0-9]', '', 'g'), 4) = v_p4;
  if not found then return null; end if;

  return jsonb_build_object(
    'public_code',   v_job.public_code,
    'stage',         v_job.stage,
    'stage_since',   v_job.stage_since,
    'waiting_party', v_job.waiting_party,
    'device_label',  v_job.device_label,
    'job_kind',      v_job.job_kind,
    -- The full name, as the live function returns it today (the page shows it
    -- under "In the name of"); the code + phone digits are the access check.
    'customer_name', v_job.customer_name,
    'promised_at',   v_job.promised_at,
    'outcome',       v_job.outcome,
    'handled_by',    nullif(split_part(btrim(coalesce(v_job.assignee, '')), ' ', 1), ''),
    'created_at',    v_job.created_at,
    'received_at',   v_job.received_at,
    'ready_at',      v_job.ready_at,
    'closed_at',     v_job.closed_at,
    'service_type',  v_job.service_type,
    'visit_start',   v_job.visit_start,
    'visit_end',     v_job.visit_end,
    -- SPEC-GAP: newest first, like the desktop timeline.
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('at', e.at, 'body', e.body, 'to_stage', e.to_stage) order by e.at desc)
        from (select se.at, se.body, se.to_stage from public.service_events se
               where se.job_id = v_job.id and se.customer_visible
               order by se.at desc limit 100) e), '[]'::jsonb),
    'rma_units', coalesce((
      select jsonb_agg(jsonb_build_object(
               'public_code', rc.public_code,
               'label', public._rma_label(rc.kind, rc.brand, rc.model),
               'kind', rc.kind,
               'stage', rc.stage,
               'return_method', rc.return_method,
               'disposition', rc.disposition,
               'stage_since', rc.stage_since,
               -- A23: whether this part holds the ticket, so the page's headline
               -- follows only the parts the ticket is really waiting on (a
               -- released part goes on by itself under its own RM- code).
               'holds_ticket', rc.holds_ticket,
               -- A13: the brand (else the vendor's public name), never a distributor.
               'waiting_party', case when rc.stage = 'with_vendor' then public._rma_party(rc.brand, vd.public_name, vd.kind) end)
             order by rc.created_at, rc.intake_seq, rc.id)
        from public.rma_cases rc
        left join public.rma_vendors vd on vd.id = rc.vendor_id
       where rc.service_job_id = v_job.id), '[]'::jsonb));
end $$;


-- =============================================================================
-- §18  FIELD ACTIVITY RPC
-- =============================================================================

create or replace function public.record_field_activity(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_crid uuid;
  v_kind text; v_outcome text; v_at timestamptz;
  v_lat numeric; v_lng numeric; v_acc numeric;
  v_note text; v_media text; v_source text; v_module text; v_ref_type text; v_ref_id text;
  v_emp public.profiles; v_emp_email text; v_emp_name text; v_asked text;
  v_lead boolean := public.has_module('service', 'lead');
  v_id uuid;
  v_existing public.field_activity;
  v_job public.service_jobs;
  v_to text; v_stage text;
  v_applied boolean := false; v_applied_note text;
  v_implied boolean := false;
  v_absent boolean := false;
  v_vis boolean; v_body text; v_prev text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'NEO_GATE: The request is empty.'; end if;
  v_crid := public._juuid(p, 'client_request_id');
  if v_crid is null then
    raise exception 'NEO_GATE: client_request_id is required — make one UUID per action and reuse it on every retry.';
  end if;

  -- Idempotent: a retry of something already recorded returns what happened then.
  select * into v_existing from public.field_activity where client_request_id = v_crid;
  if found then
    if lower(v_existing.employee_email) <> lower(v_me.email) and not v_lead and v_me.tier < 3 then
      raise exception 'NEO_GATE: That request id was already used for someone else''s activity.';
    end if;
    return jsonb_build_object('id', v_existing.id, 'applied', v_existing.applied, 'applied_note', v_existing.applied_note,
      'duplicate', true,
      'stage', (select sj.stage from public.service_jobs sj
                 where v_existing.ref_type = 'service_job' and sj.id = v_existing.ref_id));
  end if;

  v_kind := public._vocab(public._jtxt(p, 'kind', 20, 'Kind'), 'field_kind', 'Activity kind');
  if v_kind is null then raise exception 'NEO_GATE: Say what happened (kind).'; end if;
  v_outcome := public._vocab(public._jtxt(p, 'outcome', 30, 'Outcome'), 'field_outcome', 'Visit outcome');
  v_at := coalesce(public._jts(p, 'at', 'The time'), now());
  -- A bad GPS fix must never make an offline replay fail forever: drop it, keep the record.
  v_lat := public._jnum(p, 'lat', 'The latitude');
  v_lng := public._jnum(p, 'lng', 'The longitude');
  v_acc := public._jnum(p, 'accuracy_m', 'The accuracy');
  if v_lat is null or v_lng is null or v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180 then
    v_lat := null; v_lng := null; v_acc := null;
  end if;
  if v_acc is not null and v_acc < 0 then v_acc := null; end if;
  v_note := public._jtxt(p, 'note', 2000, 'The note');
  v_media := public._jtxt(p, 'media_path', 500, 'The photo path');
  v_source := coalesce(public._vocab(public._jtxt(p, 'source', 20), 'field_source', 'Source'), 'desktop');
  v_module := coalesce(public._vocab(public._jtxt(p, 'module', 20), 'field_module', 'Module'), 'service');
  v_ref_type := coalesce(public._vocab(public._jtxt(p, 'ref_type', 20), 'field_ref_type', 'Reference type'), 'service_job');
  v_ref_id := public._jtxt(p, 'ref_id', 60, 'The reference id');

  -- Always the signed-in person. A service lead may post for someone else
  -- (e.g. the assignee whose phone died); the desk may not.
  v_emp_email := v_me.email;
  v_emp_name := v_me.full_name;
  v_asked := public._jtxt(p, 'employee_email', 160, 'The employee');
  if v_asked is not null and lower(v_asked) <> lower(v_me.email) and v_lead then
    v_emp := public._staff_by_email(v_asked);
    if v_emp.id is not null then
      v_emp_email := v_emp.email;
      v_emp_name := v_emp.full_name;
    end if;
  end if;

  -- Record first: a duplicate racing this one hits the unique key and cannot
  -- apply the move a second time.
  insert into public.field_activity (client_request_id, employee_email, employee_name, module, ref_type, ref_id,
                                     kind, outcome, at, lat, lng, accuracy_m, note, media_path, source)
  values (v_crid, v_emp_email, v_emp_name, v_module, v_ref_type, v_ref_id, v_kind, v_outcome, v_at,
          v_lat::double precision, v_lng::double precision, v_acc::double precision, v_note, v_media, v_source)
  on conflict (client_request_id) do nothing
  returning id into v_id;
  if v_id is null then
    select * into v_existing from public.field_activity where client_request_id = v_crid;
    return jsonb_build_object('id', v_existing.id, 'applied', v_existing.applied,
                              'applied_note', v_existing.applied_note, 'duplicate', true, 'stage', null);
  end if;

  if v_ref_type = 'service_job' and v_ref_id is not null and v_kind in ('left_base', 'arrived', 'departed') then
    select * into v_job from public.service_jobs where id = v_ref_id for update;
    if not found then
      v_applied_note := 'No change: ticket not found.';
    elsif v_job.service_type <> 'on_site' then
      v_applied_note := 'No change: check-ins only move on-site tickets.';
      v_stage := v_job.stage;
    elsif not (v_lead or lower(coalesce(v_job.assignee_email, '')) = lower(v_emp_email)) then
      v_applied_note := case when v_job.assignee_email is null then 'No change: take the ticket from the queue first.'
                             else 'No change: this ticket is with ' || coalesce(v_job.assignee, v_job.assignee_email) || '.' end;
      v_stage := v_job.stage;
    else
      -- A18: a check-out is accepted from scheduled / en_route / on_site. From
      -- the first two the check-in was simply not pressed (no signal, forgot):
      -- the visit is counted and the timeline says it was assumed. A second
      -- check-out after the ticket moved past on_site changes nothing.
      v_implied := v_kind = 'departed' and v_outcome is not null and v_job.stage in ('scheduled', 'en_route');
      -- Nobody was there: the booked time is spent. SPEC-GAP: the SPEC sends the
      -- ticket back to scheduled, which kept the old slot, so the tracking page
      -- said "we are running late" and the board showed a late visit. It waits
      -- at revisit_needed with no visit time instead: the page says we'll call
      -- to book the follow-up, and the follow-up has a time budget of its own.
      v_absent := v_kind = 'departed' and v_outcome = 'customer_absent';
      v_to := case
        when v_kind = 'left_base' and v_job.stage in ('logged', 'scheduled', 'revisit_needed') then 'en_route'
        when v_kind = 'arrived' and v_job.stage in ('logged', 'scheduled', 'en_route', 'revisit_needed') then 'on_site'
        when v_kind = 'departed' and v_job.stage in ('scheduled', 'en_route', 'on_site') then
          case v_outcome when 'done'            then 'work_done'
                         when 'revisit_needed'  then 'revisit_needed'
                         when 'parts_needed'    then 'parts_to_order'
                         when 'customer_absent' then 'revisit_needed'
                         else null end
        else null end;
      if v_to is null then
        v_applied_note := case when v_kind = 'departed' and v_outcome is null and v_job.stage in ('scheduled', 'en_route', 'on_site')
                               then 'No change: say how the visit ended (outcome).'
                               else 'No change: ticket is at ' || public._svc_stage_label(v_job.stage) || '.' end;
        v_stage := v_job.stage;
      else
        v_prev := public._flag_set('neo.field');
        update public.service_jobs
           set stage = v_to,
               stage_since = case when v_to is distinct from stage then now() else stage_since end,
               visit_count = visit_count + case when v_to = 'on_site' or v_implied then 1 else 0 end,
               visit_start = case when v_absent then null else visit_start end,
               visit_end = case when v_absent then null else visit_end end
         where id = v_job.id;
        perform public._flag_restore('neo.field', v_prev);
        v_applied := true;
        v_stage := v_to;
        v_applied_note := case when v_to = v_job.stage then 'Recorded: ' || public._svc_stage_label(v_to) || '.'
                               else 'Moved to ' || public._svc_stage_label(v_to) || '.' end;
        if v_implied then
          perform public._svc_ev(v_job.id, 'field', 'Check-in was not recorded — assumed.', false, null, null,
            jsonb_build_object('field_activity_id', v_id, 'assumed', 'arrived', 'at', v_at, 'source', v_source),
            'staff', v_emp_email, v_emp_name);
        end if;
        v_vis := v_to in ('en_route', 'on_site', 'work_done') or v_absent;
        -- SPEC-GAP: a customer-visible move carries fixed customer wording; the
        -- technician's own note goes in a separate INTERNAL note, so a candid
        -- remark typed on a phone is never published to the tracking page.
        v_body := case when v_absent then 'We missed you at the visit — we''ll call you to book another time.'
                       else case v_to
                              when 'en_route'       then 'Our technician is on the way.'
                              when 'on_site'        then 'Our technician has arrived.'
                              when 'work_done'      then 'Work done on site. Tell us if anything is still wrong.'
                              when 'revisit_needed' then 'Visit ended — a follow-up visit is needed.'
                              when 'parts_to_order' then 'Visit ended — parts are needed.'
                            end
                  end;
        perform public._svc_ev(v_job.id, 'field', v_body, v_vis, v_job.stage, v_to,
          jsonb_build_object('field_activity_id', v_id, 'lat', v_lat, 'lng', v_lng, 'kind', v_kind,
                             'outcome', v_outcome, 'at', v_at, 'source', v_source),
          'staff', v_emp_email, v_emp_name);
        if v_note is not null then
          perform public._svc_ev(v_job.id, 'note', v_note, false, null, null,
                                 jsonb_build_object('field_activity_id', v_id), 'staff', v_emp_email, v_emp_name);
        end if;
      end if;
    end if;
  elsif v_kind in ('left_base', 'arrived', 'departed') then
    v_applied_note := 'Recorded. No ticket was named, so nothing moved.';
  else
    v_applied_note := 'Recorded.';
  end if;

  update public.field_activity set applied = v_applied, applied_note = v_applied_note where id = v_id;
  return jsonb_build_object('id', v_id, 'applied', v_applied, 'applied_note', v_applied_note,
                            'stage', v_stage, 'duplicate', false);
end $$;


-- =============================================================================
-- §19  RMA RPCs
-- =============================================================================

create or replace function public._rma_create_result(p_intake_id text, p_dup boolean)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
begin
  -- Same shape for a first call and for an idempotent replay (the units list
  -- included), in the order the payload listed them. serial_matches is the one
  -- serial "lookup" left: has this exact part — or the replacement a vendor
  -- sent for it (A15) — been through RMA before?
  return jsonb_build_object(
    'intake_id', p_intake_id,
    'duplicate', p_dup,
    'units', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', rc.id, 'public_code', rc.public_code, 'stage', rc.stage, 'kind', rc.kind,
               'fee_status', rc.fee_status, 'handling_fee', rc.handling_fee,
               'holds_ticket', rc.holds_ticket, 'data_handling', rc.data_handling,
               'serial_matches', coalesce((
                 select jsonb_agg(jsonb_build_object('public_code', o.public_code, 'stage', o.stage,
                                                     'created_at', o.created_at) order by o.created_at desc)
                   from public.rma_cases o
                  where o.intake_id <> p_intake_id and rc.serial_norm <> ''
                    and (o.serial_norm = rc.serial_norm or o.replacement_serial_norm = rc.serial_norm)),
                 '[]'::jsonb))
             order by rc.intake_seq, rc.created_at, rc.id)
        from public.rma_cases rc where rc.intake_id = p_intake_id), '[]'::jsonb));
end $$;

create or replace function public._rma_create(p jsonb, p_me public.profiles, p_desk boolean)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_source text; v_in_hand boolean; v_job_id text; v_holds boolean;
  v_job public.service_jobs;
  v_primary_item text;
  v_sender_kind text; v_sender_name text; v_sender_phone text;
  v_ret_given text; v_ret text; v_ret_addr text; v_in_courier text; v_in_awb text; v_notes text;
  v_units jsonb; v_n int; v_u jsonb; i int; j int; k int;
  v_intake_id text; v_case_id text; v_code text; v_base_stage text; v_stage text;
  v_kind text; v_brand text; v_model text; v_serial text; v_fault text; v_diag text;
  v_owner_name text; v_owner_phone text; v_psrc text; v_inv text; v_pdate date; v_build text; v_item_id text;
  v_fee numeric; v_fee_status text; v_cond text; v_dh text;
  v_vendor_id bigint; v_vendor_pub text; v_vendor_kind text; v_vendor_tat int; v_vrma text; v_exp timestamptz;
  v_already boolean;
  v_unit_holds boolean; v_unit_ret text; v_body text;
  v_ship bigint;
  v_prev text;
begin
  v_source := public._vocab(public._jtxt(p, 'source', 20), 'rma_source', 'Source');
  if v_source is null then raise exception 'NEO_GATE: Say where the part came from.'; end if;
  if v_source in ('field', 'stock') and not p_desk then
    raise exception 'NEO_DENIED: Only the service or RMA desk can log a part from a site visit or from shop stock.';
  end if;
  v_in_hand := coalesce(public._jbool(p, 'in_hand', 'In hand'), false);
  if v_in_hand and not p_desk then
    raise exception 'NEO_DENIED: Only the RMA desk can log a part as received. Log it as expected instead.';
  end if;

  v_job_id := public._jtxt(p, 'service_job_id', 60, 'The ticket');
  v_holds := coalesce(public._jbool(p, 'holds_ticket', 'Holds the ticket'), false);
  if v_source = 'from_ticket' and v_job_id is null then
    raise exception 'NEO_GATE: Pick the ticket this part comes from.';
  end if;
  if v_job_id is not null then
    if not p_desk then
      raise exception 'NEO_DENIED: Only the service or RMA desk can raise an RMA from a ticket.';
    end if;
    -- The ticket is locked before any part is written (ticket-then-part order).
    select * into v_job from public.service_jobs where id = v_job_id for update;
    if not found then raise exception 'NEO_GATE: That ticket no longer exists.'; end if;
    if v_job.stage = 'closed' then
      raise exception 'NEO_GATE: That ticket is closed. Log the part as a walk-in instead.';
    end if;
    select si.id into v_primary_item from public.service_items si where si.job_id = v_job.id and si.is_primary;
  end if;
  if v_holds and v_job.id is null then
    raise exception 'NEO_GATE: A part can only hold a ticket it came from.';
  end if;

  if v_source = 'from_ticket' then
    v_sender_kind := 'customer';
    v_sender_name := v_job.customer_name;
    v_sender_phone := v_job.customer_phone;
  else
    v_sender_kind := coalesce(public._vocab(public._jtxt(p, 'sender_kind', 30), 'sender_kind', 'Sender'),
                              case v_source when 'stock' then 'shop' when 'field' then 'our_tech' else 'customer' end);
    v_sender_name := public._jtxt(p, 'sender_name', 120, 'The sender''s name');
    v_sender_phone := public._jtxt(p, 'sender_phone', 30, 'The sender''s phone');
    if v_sender_kind = 'shop' then v_sender_name := coalesce(v_sender_name, 'Neo Tokyo'); end if;
    if v_sender_kind = 'our_tech' then v_sender_name := coalesce(v_sender_name, p_me.full_name); end if;
    if v_sender_name is null then raise exception 'NEO_GATE: Enter the sender''s name.'; end if;
  end if;

  v_ret_given := public._vocab(public._jtxt(p, 'return_method', 20), 'return_method', 'Return method');
  v_ret := coalesce(v_ret_given, case when v_holds then 'with_device' else 'collect' end);
  if v_ret = 'with_device' and v_job.id is null then
    raise exception 'NEO_GATE: A part can only go back with the device when it came from a ticket.';
  end if;
  v_ret_addr := public._jtxt(p, 'return_address', 500, 'The return address');
  v_in_courier := public._jtxt(p, 'inbound_courier', 60, 'The courier');
  v_in_awb := public._jtxt(p, 'inbound_awb', 60, 'The AWB number');
  v_notes := public._jtxt(p, 'notes', 2000, 'The notes');

  v_units := p -> 'units';
  if v_units is null or jsonb_typeof(v_units) <> 'array' or jsonb_array_length(v_units) = 0 then
    raise exception 'NEO_GATE: Add at least one part.';
  end if;
  v_n := jsonb_array_length(v_units);
  if v_n > 20 then raise exception 'NEO_GATE: One RMA can hold up to 20 parts.'; end if;

  -- received_at is stamped below, once we know a part really is at the counter.
  v_intake_id := public.new_text_id('ri');
  insert into public.rma_intakes (id, source, service_job_id, sender_kind, sender_name, sender_phone,
                                  inbound_courier, inbound_awb, received_at, return_method, return_address,
                                  notes, created_by_email, created_by_name, client_request_id)
  values (v_intake_id, v_source, v_job.id, v_sender_kind, v_sender_name, v_sender_phone,
          v_in_courier, v_in_awb, null, v_ret, v_ret_addr,
          v_notes, p_me.email, p_me.full_name, public._juuid(p, 'client_request_id'));

  -- A8: a part our technician pulled on site starts "with our technician",
  -- whatever in_hand says; it reaches the counter with rma_receive / rma_move.
  v_base_stage := case when v_source = 'field' then 'with_tech' when v_in_hand then 'received' else 'logged' end;

  -- The ticket follows its parts ONCE, after every part exists (like
  -- rma_dispatch, A9): the per-row sync would move it on the first part, name
  -- only that part in the customer's line, and with an A14 part already at the
  -- vendor beside a part in hand, move it twice in one action.
  v_prev := public._flag_set('neo.rma_nosync');
  for i in 0 .. v_n - 1 loop
    v_u := v_units -> i;
    j := i + 1;
    if jsonb_typeof(v_u) <> 'object' then raise exception 'NEO_GATE: Part % has the wrong shape.', j; end if;
    v_kind := coalesce(public._vocab(public._jtxt(v_u, 'kind', 20), 'item_kind', 'Part kind'), 'other');
    v_brand := public._jtxt(v_u, 'brand', 80, 'The brand for part ' || j);
    v_model := public._jtxt(v_u, 'model', 120, 'The model for part ' || j);
    v_serial := public._jtxt(v_u, 'serial', 80, 'The serial for part ' || j);
    v_fault := public._jtxt(v_u, 'fault', 2000, 'The fault for part ' || j);
    if v_fault is null then raise exception 'NEO_GATE: Describe the fault for part %.', j; end if;
    v_diag := coalesce(public._vocab(public._jtxt(v_u, 'diagnosed_by', 20), 'diagnosed_by', 'Diagnosed by'),
                       case v_sender_kind when 'third_party_tech' then 'third_party' when 'customer' then 'customer'
                                          else 'us' end);
    v_owner_name := public._jtxt(v_u, 'owner_name', 120, 'The owner''s name for part ' || j);
    v_owner_phone := public._jtxt(v_u, 'owner_phone', 30, 'The owner''s phone for part ' || j);
    -- A part our technician or the shop sends for a ticket's customer is
    -- tracked with that customer's phone.
    if v_owner_phone is null and v_job.id is not null and v_sender_kind in ('our_tech', 'shop') then
      v_owner_name := coalesce(v_owner_name, v_job.customer_name);
      v_owner_phone := v_job.customer_phone;
    end if;
    v_psrc := coalesce(public._vocab(public._jtxt(v_u, 'purchase_source', 20), 'purchase_source', 'Where it was bought'),
                       'unknown');
    v_inv := public._jtxt(v_u, 'invoice_no', 60, 'The invoice number for part ' || j);
    v_pdate := public._jdate(v_u, 'purchase_date', 'The purchase date for part ' || j);
    -- t_… or the 6-character receipt code, like the service intake; a typo is an error.
    v_build := public._resolve_build_ticket(public._jtxt(v_u, 'build_ticket_id', 60, 'The build id for part ' || j));
    v_item_id := public._jtxt(v_u, 'service_item_id', 60, 'The ticket item for part ' || j);
    if v_item_id is not null and not exists (select 1 from public.service_items si
                                              where si.id = v_item_id and si.job_id = v_job.id) then
      raise exception 'NEO_GATE: Part % names an item that is not on this ticket.', j;
    end if;
    -- SPEC-GAP: rma_cases has no condition column; the remark is kept as an
    -- internal note on the part (below).
    v_cond := public._jtxt(v_u, 'condition_remarks', 2000, 'The condition remarks for part ' || j);
    v_dh := public._vocab(public._jtxt(v_u, 'data_handling', 30), 'data_handling', 'Data on the drive');

    v_vendor_pub := null;
    v_vendor_kind := null;
    v_vendor_tat := null;
    v_vendor_id := public._jint(v_u, 'vendor_id', 'The vendor for part ' || j, 1, 2147483647);
    if v_vendor_id is not null then
      select vd.public_name, vd.kind, vd.typical_tat_days into v_vendor_pub, v_vendor_kind, v_vendor_tat
        from public.rma_vendors vd where vd.id = v_vendor_id;
      if not found then
        raise exception 'NEO_GATE: Part % names a vendor that is not in the list. Pick one from the list.', j;
      end if;
    end if;
    v_vrma := public._jtxt(v_u, 'vendor_rma_no', 60, 'The vendor RMA number for part ' || j);

    -- A14: a part that went to the vendor before this module existed (a
    -- legacy ticket already at "At vendor") is logged straight at with_vendor.
    v_already := coalesce(public._jbool(v_u, 'already_with_vendor', 'Already with the vendor'), false);
    v_exp := null;
    if v_already then
      if not p_desk then
        raise exception 'NEO_DENIED: Only the service or RMA desk can log a part that is already with the vendor.';
      end if;
      if v_vendor_id is null then
        raise exception 'NEO_GATE: Part %: choose the vendor it is with.', j;
      end if;
      v_exp := coalesce(public._jts(v_u, 'expected_back_at', 'The expected date for part ' || j),
                        now() + make_interval(days => coalesce(v_vendor_tat, 14)));
    end if;

    -- A4: a part holds the ticket only while the ticket is somewhere the RMA
    -- link may move it. Sending the ticket's main item (the whole device)
    -- always holds it.
    v_unit_holds := v_holds or (v_item_id is not null and v_item_id is not distinct from v_primary_item);
    if v_unit_holds then
      if v_job.service_type not in ('in_store', 'on_site') then
        raise exception 'NEO_GATE: Only in-store and on-site tickets can wait for a part.';
      end if;
      if v_job.stage not in ('logged','received','diagnosing','rma_raised','at_vendor','back_from_vendor',
                             'revisit_needed','on_site') then
        raise exception 'NEO_GATE: The ticket is at %. Send this part without holding the ticket, or move the ticket back to diagnosing first.',
          public._svc_stage_label(v_job.stage);
      end if;
    end if;
    v_unit_ret := coalesce(v_ret_given, case when v_unit_holds then 'with_device' else 'collect' end);

    -- Tracking and WhatsApp go to the end customer if named, else the sender.
    if v_sender_kind <> 'shop' and not public.phone_ok(coalesce(v_owner_phone, v_sender_phone)) then
      raise exception 'NEO_GATE: Add a phone number for part % — 10 digits, or with the country code. Tracking and WhatsApp updates need it.', j;
    end if;

    v_fee := public._jnum(v_u, 'handling_fee', 'The handling fee for part ' || j);
    if v_fee is not null and (v_fee < 0 or v_fee > 1000000) then
      raise exception 'NEO_GATE: The handling fee for part % is not a sensible amount.', j;
    end if;
    -- A part bought elsewhere is a paid handling service. A zero fee there is
    -- NOT "accepted": the ready-to-ship gate then needs a lead's waiver.
    if v_fee is null and v_psrc = 'elsewhere' then
      v_fee := 300.00; v_fee_status := 'quoted';
    elsif v_fee is not null and v_fee > 0 then
      v_fee_status := 'quoted';
    else
      v_fee_status := 'n_a';
    end if;

    v_stage := case when v_already then 'with_vendor' else v_base_stage end;

    v_code := null;
    for k in 1..5 loop
      v_code := public.new_public_code('RM');
      exit when not exists (select 1 from public.rma_cases where public_code = v_code);
      v_code := null;
    end loop;
    if v_code is null then raise exception 'NEO_GATE: Could not make a tracking code just now. Try again.'; end if;
    v_case_id := public.new_text_id('rc');

    insert into public.rma_cases (id, public_code, intake_id, intake_seq, service_job_id, service_item_id, holds_ticket,
                                  kind, brand, model, serial, fault, diagnosed_by, owner_name, owner_phone,
                                  purchase_source, invoice_no, purchase_date, build_ticket_id,
                                  vendor_id, vendor_rma_no, expected_back_at, data_handling,
                                  handling_fee, fee_status, return_method, return_address,
                                  stage, stage_since, created_by_email)
    values (v_case_id, v_code, v_intake_id, i, v_job.id, v_item_id, v_unit_holds,
            v_kind, v_brand, v_model, v_serial, v_fault, v_diag, v_owner_name, v_owner_phone,
            v_psrc, v_inv, v_pdate, v_build,
            v_vendor_id, v_vrma, v_exp, v_dh,
            v_fee, v_fee_status, v_unit_ret, v_ret_addr,
            v_stage, now(), p_me.email);

    if public.phone_ok(v_owner_phone) then
      perform public._customer_upsert(v_owner_phone, v_owner_name, null, p_me.email);
    end if;

    -- One event per part. When the part came from a ticket, the mirror trigger
    -- copies it onto the ticket's timeline — no second write here.
    v_body := case
                when v_already then 'With ' || coalesce(public._rma_party(v_brand, v_vendor_pub, v_vendor_kind), 'the manufacturer')
                                    || ' under warranty (sent before it was logged here).'
                when v_stage = 'with_tech' then 'With our technician — collected on site. Fault: ' || v_fault
                when v_stage = 'received' then 'Received (' || public._rma_source_label(v_source) || '). Fault: ' || v_fault
                else 'Expected — ' || public._rma_source_label(v_source) end;
    perform public._rma_ev(v_case_id, 'stage', v_body, true, null, v_stage,
                           jsonb_strip_nulls(jsonb_build_object('source', v_source, 'already_with_vendor',
                                                                case when v_already then true end)),
                           'staff', p_me.email, p_me.full_name);
    if v_cond is not null then
      perform public._rma_ev(v_case_id, 'note', 'Condition: ' || v_cond, false, null, null, '{}'::jsonb,
                             'staff', p_me.email, p_me.full_name);
    end if;
  end loop;
  perform public._flag_restore('neo.rma_nosync', v_prev);
  if v_job.id is not null then
    perform public.rma_sync_ticket(v_job.id);
  end if;

  if exists (select 1 from public.rma_cases rc where rc.intake_id = v_intake_id and rc.stage = 'received') then
    update public.rma_intakes set received_at = now() where id = v_intake_id;
  end if;

  -- The inbound parcel, for the logistics record.
  if v_source = 'courier' and (v_in_awb is not null or v_in_courier is not null) then
    insert into public.rma_shipments (direction, mode, courier, awb, dispatched_at, delivered_at, created_by_email)
    values ('in_from_customer', 'courier', v_in_courier, v_in_awb, null, case when v_in_hand then now() end, p_me.email)
    returning id into v_ship;
    insert into public.rma_shipment_items (shipment_id, case_id)
    select v_ship, rc.id from public.rma_cases rc where rc.intake_id = v_intake_id;
  end if;

  return public._rma_create_result(v_intake_id, false);
end $$;

create or replace function public.rma_create(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();     -- any staff; sales may only log expected parts
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

create or replace function public.rma_receive(p_case_ids text[], p_note text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_ids text[];
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_was jsonb;
  r record;
begin
  if not public.has_module('rma', 'desk') then
    raise exception 'NEO_DENIED: You don''t have access to the RMA desk.';
  end if;
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_case_ids, '{}'::text[])) x where x is not null;
  if v_ids is null then raise exception 'NEO_GATE: Pick the parts that arrived.'; end if;
  if v_note is not null and length(v_note) > 2000 then
    raise exception 'NEO_GATE: The note is too long — keep it under 2000 characters.';
  end if;

  perform public._rma_lock(v_ids);
  if (select count(*) from public.rma_cases where id = any (v_ids)) <> cardinality(v_ids) then
    raise exception 'NEO_GATE: One of those parts no longer exists.';
  end if;
  -- Expected parts (logged) and parts our technician brought back from a site
  -- (with_tech, A8) both arrive at the counter this way.
  for r in select * from public.rma_cases where id = any (v_ids) order by id loop
    if r.stage not in ('logged', 'with_tech') then
      raise exception 'NEO_STALE: % is already at %. Reopen it to see where it is.',
        r.public_code, public._rma_stage_label(r.stage);
    end if;
  end loop;
  -- Remember where each one was, for the timeline.
  select jsonb_object_agg(rc.id, rc.stage) into v_was from public.rma_cases rc where rc.id = any (v_ids);

  update public.rma_cases set stage = 'received', stage_since = now() where id = any (v_ids);
  update public.rma_intakes set received_at = now()
   where received_at is null and id in (select intake_id from public.rma_cases where id = any (v_ids));
  update public.rma_shipments s set delivered_at = now()
   where s.direction = 'in_from_customer' and s.delivered_at is null
     and exists (select 1 from public.rma_shipment_items si where si.shipment_id = s.id and si.case_id = any (v_ids));

  for r in select * from public.rma_cases where id = any (v_ids) order by id loop
    perform public._rma_ev(r.id, 'stage',
                           case when v_was ->> r.id = 'with_tech' then 'Your part is at our counter now. Fault: '
                                else 'Your part has arrived. Fault: ' end || coalesce(r.fault, ''),
                           true, v_was ->> r.id, 'received', '{}'::jsonb, 'staff', v_me.email, v_me.full_name);
    if v_note is not null then
      perform public._rma_ev(r.id, 'note', v_note, false, null, null, '{}'::jsonb, 'staff', v_me.email, v_me.full_name);
    end if;
  end loop;

  return jsonb_build_object('units', coalesce((
    select jsonb_agg(jsonb_build_object('id', rc.id, 'public_code', rc.public_code, 'stage', rc.stage) order by rc.id)
      from public.rma_cases rc where rc.id = any (v_ids)), '[]'::jsonb));
end $$;

create or replace function public.rma_move(
  p_case_id text, p_from text, p_to text,
  p_note text default null, p_visible boolean default true, p_extra jsonb default '{}'::jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  x jsonb := case when jsonb_typeof(coalesce(p_extra, '{}'::jsonb)) = 'object' then coalesce(p_extra, '{}'::jsonb)
                  else '{}'::jsonb end;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_case public.rma_cases;
  v_proj public.rma_cases;
  v_new public.rma_cases;
  v_intake public.rma_intakes;
  v_disp text; v_rc text; v_rawb text; v_find text; v_coll text;
  v_problems text[];
  v_follow jsonb; v_follow_id text; v_follow_code text;
  v_ship bigint;
  v_body text;
begin
  if not public.has_module('rma', 'desk') then
    raise exception 'NEO_DENIED: You don''t have access to move RMA parts.';
  end if;
  if v_note is not null and length(v_note) > 4000 then
    raise exception 'NEO_GATE: The note is too long — keep it under 4000 characters.';
  end if;

  perform public._rma_lock(array[p_case_id]);
  select * into v_case from public.rma_cases where id = p_case_id;
  if not found then raise exception 'NEO_GATE: That part no longer exists.'; end if;
  if v_case.stage is distinct from p_from then
    raise exception 'NEO_STALE: Someone moved this part to % already. Reopen it to see where it is.',
      public._rma_stage_label(v_case.stage);
  end if;
  if p_to = 'with_vendor' then raise exception 'NEO_GATE: Use Dispatch to send parts to the vendor.'; end if;
  if p_to = 'back_from_vendor' or v_case.stage = 'with_vendor' then
    raise exception 'NEO_GATE: Record the vendor result instead.';
  end if;
  if not public.rma_transition_ok(v_case.stage, p_to) then
    raise exception 'NEO_GATE: % is not a next step from %.',
      public._rma_stage_label(p_to), public._rma_stage_label(v_case.stage);
  end if;

  v_disp := public._vocab(public._jtxt(x, 'disposition', 40), 'disposition', 'Disposition');
  v_rc := public._jtxt(x, 'return_courier', 60, 'The courier');
  v_rawb := public._jtxt(x, 'return_awb', 60, 'The AWB number');
  v_find := public._jtxt(x, 'our_finding', 4000, 'Our finding');
  v_coll := public._jtxt(x, 'collected_by', 120, 'Who collected it');

  -- A part we never had at the counter (expected, or still with our
  -- technician — A8) can only be withdrawn.
  if v_case.stage in ('logged', 'with_tech') and p_to = 'closed' then
    v_disp := coalesce(v_disp, 'withdrawn');
    if v_disp <> 'withdrawn' then
      raise exception 'NEO_GATE: A part we never received can only be closed as withdrawn.';
    end if;
  end if;
  if v_disp = 'converted_to_repair' and p_to <> 'closed' then
    raise exception 'NEO_GATE: Moving to a paid repair closes the RMA — pick Closed.';
  end if;

  -- Check the gates against the part as it WILL be.
  v_proj := v_case;
  v_proj.disposition := coalesce(v_disp, v_case.disposition);
  v_proj.return_awb := coalesce(v_rawb, v_case.return_awb);
  v_problems := public._rma_gate_problems(v_proj, p_to);
  if cardinality(v_problems) > 0 then
    raise exception 'NEO_GATE: %', array_to_string(v_problems, ' ');
  end if;

  select * into v_intake from public.rma_intakes where id = v_case.intake_id;

  -- A paid repair is a new in-store ticket made by the same code as the counter.
  -- Its reported fault is the customer's own words (the part's fault, already
  -- on its public timeline), because _svc_create publishes reported_fault in
  -- the first customer line. Our finding is internal: it becomes the new
  -- ticket's diagnosis.
  if v_disp = 'converted_to_repair' then
    if not public.phone_ok(coalesce(nullif(btrim(v_case.owner_phone), ''), v_intake.sender_phone)) then
      raise exception 'NEO_GATE: Add the customer''s phone number before opening a paid repair.';
    end if;
    v_follow := public._svc_create(jsonb_build_object(
      'service_type', 'in_store', 'channel', 'staff', 'category', 'repair', 'priority', 'normal', 'in_hand', true,
      'customer_name', coalesce(nullif(btrim(v_case.owner_name), ''), v_intake.sender_name, 'Customer'),
      'customer_phone', coalesce(nullif(btrim(v_case.owner_phone), ''), v_intake.sender_phone),
      'reported_fault', coalesce(v_case.fault, 'Paid repair after warranty claim ' || v_case.public_code),
      'items', jsonb_build_array(jsonb_build_object(
                 'kind', v_case.kind,
                 'label', nullif(btrim(concat_ws(' ', v_case.brand, v_case.model)), ''),
                 'serial', v_case.serial,
                 'purchase_source', v_case.purchase_source,
                 'build_ticket_id', v_case.build_ticket_id,
                 'invoice_no', v_case.invoice_no,
                 'purchase_date', v_case.purchase_date))), v_me);
    v_follow_id := v_follow ->> 'id';
    v_follow_code := v_follow ->> 'public_code';
    if coalesce(v_find, v_case.our_finding) is not null then
      update public.service_jobs set diagnosis = coalesce(v_find, v_case.our_finding) where id = v_follow_id;
    end if;
    perform public._svc_ev(v_follow_id, 'note', 'Opened from warranty claim ' || v_case.public_code || '.', true,
                           null, null, jsonb_build_object('rma_case_id', v_case.id), 'staff', v_me.email, v_me.full_name);
  end if;

  update public.rma_cases
     set stage           = p_to,
         stage_since     = now(),
         disposition     = coalesce(v_disp, disposition),
         our_finding     = coalesce(v_find, our_finding),
         return_courier  = coalesce(v_rc, return_courier),
         return_awb      = coalesce(v_rawb, return_awb),
         -- The part physically went by courier; the method follows the fact.
         return_method   = case when p_to = 'returning' then 'courier' else return_method end,
         followup_job_id = coalesce(v_follow_id, followup_job_id),
         closed_at       = case when p_to = 'closed' then now() else closed_at end,
         closed_by       = case when p_to = 'closed' then v_me.email else closed_by end
   where id = p_case_id
  returning * into v_new;

  if p_to = 'received' then
    update public.rma_intakes set received_at = coalesce(received_at, now()) where id = v_case.intake_id;
  end if;
  if p_to = 'returning' then
    insert into public.rma_shipments (direction, courier, awb, created_by_email)
    values ('out_to_customer', v_new.return_courier, v_new.return_awb, v_me.email)
    returning id into v_ship;
    insert into public.rma_shipment_items (shipment_id, case_id) values (v_ship, v_new.id);
  end if;

  v_body := coalesce(v_note,
                     case when p_to = 'closed' and v_disp = 'converted_to_repair'
                          then 'Moved to a paid repair (' || v_follow_code || ')'
                          when p_to = 'closed' then public._rma_disposition_label(v_new.disposition)
                          else null end);
  perform public._rma_ev(p_case_id, 'stage', v_body,
                         case when v_note is not null then coalesce(p_visible, true) else true end,
                         v_case.stage, p_to,
                         jsonb_strip_nulls(jsonb_build_object('followup_job_id', v_follow_id, 'shipment_id', v_ship,
                                                              'collected_by', v_coll)),
                         'staff', v_me.email, v_me.full_name);
  if v_coll is not null then
    perform public._rma_ev(p_case_id, 'note', 'Collected by ' || v_coll, false, null, null, '{}'::jsonb,
                           'staff', v_me.email, v_me.full_name);
  end if;

  return to_jsonb(v_new) || jsonb_build_object('followup_job_code', v_follow_code);
end $$;

-- SPEC-AMENDMENTS A9 widened the signature (p_mode, p_carried_by); drop the
-- 6-argument version so PostgREST has exactly one candidate.
drop function if exists public.rma_dispatch(text[], bigint, text, text, numeric, text);

-- Send parts to a vendor in one shipment. A courier needs its AWB; a hand
-- delivery, a vendor pickup or a bus parcel needs who carried it or a note.
-- Locks the linked tickets (by id) before the parts, moves every part in one
-- statement with the per-part sync held back, then syncs each ticket ONCE and
-- writes ONE customer line per ticket — not one per part (A9).
create or replace function public.rma_dispatch(
  p_case_ids text[], p_vendor_id bigint, p_mode text default 'courier', p_courier text default null,
  p_awb text default null, p_cost numeric default null, p_note text default null, p_carried_by text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_ids text[];
  v_vendor public.rma_vendors;
  v_mode text;
  v_courier text := nullif(btrim(coalesce(p_courier, '')), '');
  v_awb text := nullif(btrim(coalesce(p_awb, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_carried text := nullif(btrim(coalesce(p_carried_by, '')), '');
  v_ship bigint;
  v_problems text[] := '{}';
  v_p text[];
  v_other text;
  v_how text;
  r public.rma_cases;
  j record;
  v_body text;
  v_prev text;
  v_prev2 text;
begin
  if not public.has_module('rma', 'desk') then
    raise exception 'NEO_DENIED: You don''t have access to the RMA desk.';
  end if;
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_case_ids, '{}'::text[])) x where x is not null;
  if v_ids is null then raise exception 'NEO_GATE: Pick the parts to send.'; end if;
  if cardinality(v_ids) > 100 then raise exception 'NEO_GATE: Send at most 100 parts in one dispatch.'; end if;
  v_mode := coalesce(public._vocab(nullif(btrim(coalesce(p_mode, '')), ''), 'ship_mode', 'How it goes'), 'courier');
  select * into v_vendor from public.rma_vendors where id = p_vendor_id;
  if not found then raise exception 'NEO_GATE: Pick a vendor.'; end if;
  if not v_vendor.active then raise exception 'NEO_GATE: % is marked inactive. Pick another vendor.', v_vendor.name; end if;
  if v_mode = 'courier' and v_awb is null then
    raise exception 'NEO_GATE: Enter the AWB (tracking number) from the courier slip.';
  end if;
  if v_mode <> 'courier' and v_carried is null and v_note is null then
    raise exception 'NEO_GATE: Say who carried it, or add a note.';
  end if;
  if p_cost is not null and (p_cost < 0 or p_cost > 1000000) then
    raise exception 'NEO_GATE: The courier cost is not a sensible amount.';
  end if;
  if length(coalesce(v_courier, '')) > 60 or length(coalesce(v_awb, '')) > 60 or length(coalesce(v_note, '')) > 2000
     or length(coalesce(v_carried, '')) > 120 then
    raise exception 'NEO_GATE: The courier, AWB, carrier name or note is too long.';
  end if;

  -- Tickets first (ordered by id), then the parts: no deadlock with a ticket move.
  perform public._rma_lock(v_ids);
  if (select count(*) from public.rma_cases where id = any (v_ids)) <> cardinality(v_ids) then
    raise exception 'NEO_GATE: One of those parts no longer exists.';
  end if;
  for r in select * from public.rma_cases where id = any (v_ids) order by id loop
    if r.stage <> 'ready_to_ship' then
      raise exception 'NEO_STALE: % is at %, not ready to ship. Reopen it to see where it is.',
        r.public_code, public._rma_stage_label(r.stage);
    end if;
    if r.vendor_id is not null and r.vendor_id <> p_vendor_id then
      select name into v_other from public.rma_vendors where id = r.vendor_id;
      raise exception 'NEO_GATE: % is set for %. Change its vendor first, or dispatch it with that vendor.',
        r.public_code, coalesce(v_other, 'another vendor');
    end if;
    r.vendor_id := p_vendor_id;
    v_p := public._rma_gate_problems(r, 'with_vendor');
    if cardinality(v_p) > 0 then
      v_problems := array_append(v_problems, r.public_code || ': ' || array_to_string(v_p, ' '));
    end if;
  end loop;
  if cardinality(v_problems) > 0 then
    raise exception 'NEO_GATE: %', array_to_string(v_problems, ' ');
  end if;

  insert into public.rma_shipments (direction, mode, vendor_id, courier, awb, carried_by, cost, notes, created_by_email)
  values ('out_to_vendor', v_mode, p_vendor_id, v_courier, v_awb, v_carried, p_cost, v_note, v_me.email)
  returning id into v_ship;
  insert into public.rma_shipment_items (shipment_id, case_id) select v_ship, x from unnest(v_ids) x;

  -- One statement; the ticket sync waits until every part has moved.
  v_prev := public._flag_set('neo.rma_nosync');
  update public.rma_cases
     set stage = 'with_vendor', stage_since = now(), vendor_id = p_vendor_id,
         expected_back_at = now() + make_interval(days => v_vendor.typical_tat_days)
   where id = any (v_ids);
  perform public._flag_restore('neo.rma_nosync', v_prev);

  -- How it went, in words a customer may read. The carrier's name stays internal.
  v_how := case v_mode
             when 'courier'       then case when v_courier is not null or v_awb is not null
                                            then ' (' || concat_ws(' ', v_courier, v_awb) || ')' else '' end
             when 'hand_delivery' then ' (hand delivered)'
             when 'vendor_pickup' then ' (collected by the vendor)'
             when 'bus_parcel'    then ' (by bus parcel' || coalesce(', ' || nullif(concat_ws(' ', v_courier, v_awb), ''), '') || ')'
           end;

  -- Each part's own timeline; the ticket timelines get one line each below.
  v_prev2 := public._flag_set('neo.no_mirror');
  for r in select * from public.rma_cases where id = any (v_ids) order by id loop
    perform public._rma_ev(r.id, 'stage',
                           'Sent to ' || coalesce(public._rma_party(r.brand, v_vendor.public_name, v_vendor.kind), 'the manufacturer')
                             || ' under warranty' || v_how,
                           true, 'ready_to_ship', 'with_vendor',
                           jsonb_strip_nulls(jsonb_build_object('shipment_id', v_ship, 'vendor_id', p_vendor_id,
                                                                'mode', v_mode, 'carried_by', v_carried)),
                           'staff', v_me.email, v_me.full_name);
  end loop;
  perform public._flag_restore('neo.no_mirror', v_prev2);

  for j in
    select rc.service_job_id as job_id,
           string_agg(public._item_kind_label(rc.kind) || ' (' || rc.public_code || ')', ', '
                      order by rc.intake_seq, rc.created_at, rc.id) as list,
           array_agg(distinct coalesce(public._rma_party(rc.brand, v_vendor.public_name, v_vendor.kind), 'the manufacturer')) as parties,
           array_agg(rc.id order by rc.id) as ids
      from public.rma_cases rc
     where rc.id = any (v_ids) and rc.service_job_id is not null
     group by rc.service_job_id
     order by rc.service_job_id
  loop
    perform public._svc_ev(j.job_id, 'rma',
      j.list || ': Sent to ' || case when cardinality(j.parties) = 1 then j.parties[1] else 'the manufacturers' end
        || ' under warranty' || v_how,
      true, null, null,
      jsonb_build_object('rma_case_ids', to_jsonb(j.ids), 'shipment_id', v_ship, 'mode', v_mode),
      'staff', v_me.email, v_me.full_name);
    perform public.rma_sync_ticket(j.job_id);
  end loop;

  return jsonb_build_object('shipment_id', v_ship, 'mode', v_mode, 'units', coalesce((
    select jsonb_agg(jsonb_build_object('id', rc.id, 'public_code', rc.public_code, 'stage', rc.stage,
                                        'expected_back_at', rc.expected_back_at) order by rc.id)
      from public.rma_cases rc where rc.id = any (v_ids)), '[]'::jsonb));
end $$;

create or replace function public.rma_vendor_result(
  p_case_id text, p_result text, p_reason text default null, p_replacement_serial text default null,
  p_courier text default null, p_awb text default null, p_note text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_case public.rma_cases;
  v_new public.rma_cases;
  v_result text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_serial text := nullif(btrim(coalesce(p_replacement_serial, '')), '');
  v_courier text := nullif(btrim(coalesce(p_courier, '')), '');
  v_awb text := nullif(btrim(coalesce(p_awb, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_vname text;
  v_to text;
  v_ship bigint;
  v_body text;
  v_item public.service_items;
begin
  if not public.has_module('rma', 'desk') then
    raise exception 'NEO_DENIED: You don''t have access to the RMA desk.';
  end if;
  v_result := public._vocab(nullif(btrim(coalesce(p_result, '')), ''), 'vendor_result', 'Vendor result');
  if v_result is null then raise exception 'NEO_GATE: Pick what the vendor did.'; end if;
  if v_result = 'replaced' and v_serial is null then
    raise exception 'NEO_GATE: Type the serial of the replacement part.';
  end if;
  if v_result = 'rejected' and v_reason is null then
    raise exception 'NEO_GATE: Say why the vendor declined the claim.';
  end if;
  if length(coalesce(v_reason, '')) > 1000 or length(coalesce(v_serial, '')) > 80 or length(coalesce(v_note, '')) > 2000
     or length(coalesce(v_courier, '')) > 60 or length(coalesce(v_awb, '')) > 60 then
    raise exception 'NEO_GATE: One of the fields is too long.';
  end if;

  perform public._rma_lock(array[p_case_id]);
  select * into v_case from public.rma_cases where id = p_case_id;
  if not found then raise exception 'NEO_GATE: That part no longer exists.'; end if;
  if v_case.stage <> 'with_vendor' then
    raise exception 'NEO_STALE: This part is at %, not with the vendor. Reopen it to see where it is.',
      public._rma_stage_label(v_case.stage);
  end if;
  -- A13: the customer reads the brand, never a distributor's name.
  select public._rma_party(v_case.brand, vd.public_name, vd.kind) into v_vname from public.rma_vendors vd where vd.id = v_case.vendor_id;
  v_vname := coalesce(v_vname, public._rma_party(v_case.brand, null, null), 'the manufacturer');

  -- lost → the customer decides what happens next; shipped_to_customer (A10)
  -- → the vendor sent it straight to the customer, so it is on its way back
  -- (the vendor's AWB is optional); everything else → back at the shop.
  v_to := case when v_result = 'lost' then 'customer_decision'
               when v_result = 'shipped_to_customer' then 'returning'
               else 'back_from_vendor' end;
  update public.rma_cases
     set vendor_result = v_result, vendor_reason = v_reason,
         replacement_serial = case when v_result = 'replaced' then v_serial else coalesce(v_serial, replacement_serial) end,
         return_method = case when v_result = 'shipped_to_customer' then 'courier' else return_method end,
         return_courier = case when v_result = 'shipped_to_customer' then coalesce(v_courier, return_courier) else return_courier end,
         return_awb = case when v_result = 'shipped_to_customer' then coalesce(v_awb, return_awb) else return_awb end,
         stage = v_to, stage_since = now()
   where id = p_case_id
  returning * into v_new;

  if v_courier is not null or v_awb is not null then
    insert into public.rma_shipments (direction, mode, vendor_id, courier, awb, notes, dispatched_at, delivered_at,
                                      created_by_email)
    values (case when v_result = 'shipped_to_customer' then 'out_to_customer' else 'in_from_vendor' end, 'courier',
            v_case.vendor_id, v_courier, v_awb,
            case when v_result = 'shipped_to_customer' then 'Shipped by the vendor straight to the customer' end,
            now(), case when v_result = 'shipped_to_customer' then null else now() end, v_me.email)
    returning id into v_ship;
    insert into public.rma_shipment_items (shipment_id, case_id) values (v_ship, p_case_id);
  end if;

  v_body := case v_result
              when 'replaced'    then 'Back from ' || v_vname || ': replaced'
              when 'repaired'    then 'Back from ' || v_vname || ': repaired'
              when 'credit_note' then 'Back from ' || v_vname || ': settled by credit note'
              when 'rejected'    then v_vname || ' declined the claim: ' || v_reason
              when 'lost'        then 'The part was lost in transit with ' || v_vname
                                      || '. We''ll call you about the next step.'
              when 'shipped_to_customer'
                                 then v_vname || ' shipped it straight to you'
                                      || case when v_courier is not null or v_awb is not null
                                              then ' (' || concat_ws(' ', v_courier, v_awb) || ')' else '' end
                                      || '. Tell us when it arrives.'
            end;
  perform public._rma_ev(p_case_id, 'stage', v_body, true, 'with_vendor', v_to,
                         jsonb_strip_nulls(jsonb_build_object('vendor_result', v_result, 'shipment_id', v_ship)),
                         'staff', v_me.email, v_me.full_name);
  if v_note is not null then
    perform public._rma_ev(p_case_id, 'note', v_note, false, null, null, '{}'::jsonb, 'staff', v_me.email, v_me.full_name);
  end if;

  -- A15: a replacement part carries a new serial. The ticket's item (and, for
  -- the main item, the ticket's device serial) now names the part the
  -- customer will actually get back.
  if v_result = 'replaced' and v_case.service_item_id is not null then
    select * into v_item from public.service_items where id = v_case.service_item_id for update;
    if found and v_item.serial is distinct from v_serial then
      update public.service_items set serial = v_serial where id = v_item.id;
      perform public._rma_ev(p_case_id, 'edit',
        'Serial changed from ' || coalesce(nullif(btrim(v_item.serial), ''), '(none)') || ' to ' || v_serial || ' (replacement)',
        false, null, null, jsonb_build_object('service_item_id', v_item.id, 'serial_from', v_item.serial, 'serial_to', v_serial),
        'staff', v_me.email, v_me.full_name);
    end if;
  end if;

  return to_jsonb(v_new);
end $$;

create or replace function public.rma_set_fee(
  p_case_id text, p_amount numeric default null, p_status text default null,
  p_ref text default null, p_note text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_case public.rma_cases;
  v_new public.rma_cases;
  v_status text;
  v_ref text := nullif(btrim(coalesce(p_ref, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_amount numeric;
  v_body text;
begin
  if not public.has_module('rma', 'desk') then
    raise exception 'NEO_DENIED: You don''t have access to the RMA desk.';
  end if;
  v_status := public._vocab(nullif(btrim(coalesce(p_status, '')), ''), 'fee_status', 'Fee status');
  if v_status is null then raise exception 'NEO_GATE: Pick the fee status.'; end if;
  if v_status in ('waived', 'n_a') and not public.has_module('rma', 'lead') then
    raise exception 'NEO_DENIED: Only a lead can waive or remove a fee.';
  end if;
  if v_status in ('waived', 'n_a') and v_note is null then
    raise exception 'NEO_GATE: Say why there is no fee to pay.';
  end if;
  if v_status = 'paid' and v_ref is null then
    raise exception 'NEO_GATE: Enter the bill number for the payment.';
  end if;
  if p_amount is not null and (p_amount < 0 or p_amount > 1000000) then
    raise exception 'NEO_GATE: That is not a sensible amount.';
  end if;
  if length(coalesce(v_ref, '')) > 60 or length(coalesce(v_note, '')) > 1000 then
    raise exception 'NEO_GATE: The bill number or note is too long.';
  end if;

  perform public._rma_lock(array[p_case_id]);
  select * into v_case from public.rma_cases where id = p_case_id;
  if not found then raise exception 'NEO_GATE: That part no longer exists.'; end if;
  if v_case.stage = 'closed' then raise exception 'NEO_GATE: This part is closed.'; end if;
  v_amount := coalesce(p_amount, v_case.handling_fee);
  if v_status in ('quoted', 'accepted', 'paid') and v_amount is null then
    raise exception 'NEO_GATE: Enter the fee amount.';
  end if;
  -- A zero fee "accepted" or "paid" is a waiver by another name: it would
  -- pass the ready-to-ship and closing gates with no lead and no reason
  -- (_rma_create keeps the same rule). A lead records it as a waiver.
  if v_status in ('quoted', 'accepted', 'paid') and v_amount <= 0 then
    if not public.has_module('rma', 'lead') then
      raise exception 'NEO_DENIED: A zero fee is a waiver — ask a lead to waive it.';
    end if;
    raise exception 'NEO_GATE: A zero fee is a waiver — choose Waived and say why.';
  end if;

  update public.rma_cases
     set handling_fee = v_amount, fee_status = v_status,
         fee_ref = case when v_status = 'paid' then v_ref else coalesce(v_ref, fee_ref) end,
         fee_note = coalesce(v_note, fee_note)
   where id = p_case_id
  returning * into v_new;

  v_body := case v_status
              when 'quoted'   then 'Fee ' || public._inr(v_amount) || ' quoted'
              when 'accepted' then 'Fee ' || public._inr(v_amount) || ' accepted by the customer'
              when 'paid'     then 'Fee ' || public._inr(v_amount) || ' paid (bill ' || v_ref || ')'
              when 'waived'   then 'Fee waived: ' || v_note
              when 'n_a'      then 'No fee: ' || v_note
            end;
  perform public._rma_ev(p_case_id, 'fee', v_body, false, null, null,
                         jsonb_build_object('fee_from', v_case.fee_status, 'fee_to', v_status, 'amount', v_amount),
                         'staff', v_me.email, v_me.full_name);
  return to_jsonb(v_new);
end $$;

-- A5 added p_return_method / p_return_address; drop the 4-argument version so
-- PostgREST has exactly one candidate.
drop function if exists public.rma_release_hold(text[], text, text, text);

-- The customer takes the device home (or the ticket carries on) while the
-- held part goes on under warranty claim by itself. SPEC-AMENDMENTS A5:
--   1. the ticket moves FIRST (as the RMA link), with its own timeline line;
--   2. only then do the parts stop holding it — the automatic sync then sees
--      "ready" (nothing to do) or a stage outside its zone, so no false "back
--      from vendor" line can appear.
-- Where the ticket may go: in-store (and every v1 ticket) → ready (outcome
-- required, normally returned_rma_pending) or in_service; on-site →
-- revisit_needed or work_done. The released parts are collected later, or
-- couriered back when p_return_method = 'courier' with p_return_address.
create or replace function public.rma_release_hold(
  p_case_ids text[], p_job_to text default null, p_outcome text default null, p_note text default null,
  p_return_method text default null, p_return_address text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_ids text[];
  v_jobs text[];
  v_job public.service_jobs;
  v_newjob public.service_jobs;
  v_to text := nullif(btrim(coalesce(p_job_to, '')), '');
  v_outcome text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_rm text := nullif(btrim(coalesce(p_return_method, '')), '');
  v_raddr text := nullif(btrim(coalesce(p_return_address, '')), '');
  v_type text;
  v_remaining text;
  v_codes text;
  v_parts text;
  v_prev text;
  v_body text;
  r public.rma_cases;
begin
  -- SPEC-GAP: the release button lives on the ticket's Items tab too, so the
  -- service desk may use it as well as the RMA desk.
  if not (public.has_module('rma', 'desk') or public.has_module('service', 'desk')) then
    raise exception 'NEO_DENIED: You don''t have access to release parts from tickets.';
  end if;
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_case_ids, '{}'::text[])) x where x is not null;
  if v_ids is null then raise exception 'NEO_GATE: Pick the parts to release.'; end if;
  if v_note is not null and length(v_note) > 2000 then
    raise exception 'NEO_GATE: The note is too long — keep it under 2000 characters.';
  end if;
  v_rm := public._vocab(v_rm, 'return_method', 'Return method');
  if v_rm = 'with_device' then
    raise exception 'NEO_GATE: A released part no longer goes back inside the device. Choose collect or courier.';
  end if;
  if v_rm = 'courier' and v_raddr is null then
    raise exception 'NEO_GATE: Enter the address to courier the part back to.';
  end if;
  if length(coalesce(v_raddr, '')) > 500 then
    raise exception 'NEO_GATE: The return address is too long — keep it under 500 characters.';
  end if;

  select array_agg(distinct rc.service_job_id) into v_jobs from public.rma_cases rc where rc.id = any (v_ids);
  if (select count(*) from public.rma_cases where id = any (v_ids)) <> cardinality(v_ids) then
    raise exception 'NEO_GATE: One of those parts no longer exists.';
  end if;
  if v_jobs is null or cardinality(v_jobs) <> 1 or v_jobs[1] is null then
    raise exception 'NEO_GATE: Those parts are not all held by one ticket. Release them one ticket at a time.';
  end if;

  perform public._rma_lock(v_ids);
  select * into v_job from public.service_jobs where id = v_jobs[1];
  -- A closed ticket stays closed. A6 closes a ticket while some held parts
  -- stay open (lost, waiting on the customer, a fee to settle); releasing one
  -- later only lets the part go on by itself. Moving the ticket (as the RMA
  -- link, past every guard) would reopen it, wipe its outcome and close time
  -- and tell the customer a device they already have is ready to collect.
  -- Both screens always send a target, so it is ignored rather than refused.
  if v_job.stage = 'closed' then
    v_to := null;
  end if;
  for r in select * from public.rma_cases where id = any (v_ids) order by id loop
    if not r.holds_ticket or r.stage = 'closed' then
      raise exception 'NEO_STALE: % is not holding the ticket any more. Reopen it to see the latest.', r.public_code;
    end if;
  end loop;
  select string_agg(public_code, ', ' order by public_code) into v_codes from public.rma_cases where id = any (v_ids);

  -- Held parts that stay held and are still on their way (A2).
  select string_agg(rc.public_code, ', ' order by rc.public_code) into v_remaining
    from public.rma_cases rc
   where rc.service_job_id = v_job.id and rc.holds_ticket and not (rc.id = any (v_ids))
     and rc.stage in ('with_tech','logged','received','testing','awaiting_docs','ready_to_ship','with_vendor');

  v_type := case when v_job.model_version >= 2 then coalesce(v_job.service_type, 'in_store') else 'in_store' end;
  if v_to is not null then
    if (v_type = 'on_site' and v_to not in ('revisit_needed', 'work_done'))
       or (v_type <> 'on_site' and v_to not in ('ready', 'in_service')) then
      raise exception 'NEO_GATE: %',
        case when v_type = 'on_site'
             then 'Pick where the ticket goes now: a follow-up visit (revisit needed) or work done.'
             else 'Pick where the ticket goes now: ready to collect, or back on the bench.' end;
    end if;
    if v_remaining is not null and v_to is distinct from v_job.stage then
      raise exception 'NEO_RMA_HOLD: This ticket is also waiting on RMA %. Release that part too, or move it on in the RMA module.', v_remaining;
    end if;
    if v_to = 'ready' then
      v_outcome := coalesce(public._vocab(nullif(btrim(coalesce(p_outcome, '')), ''), 'outcome', 'Outcome'),
                            'returned_rma_pending');
    end if;
  elsif v_job.stage in ('rma_raised', 'at_vendor', 'back_from_vendor') and v_remaining is null then
    raise exception 'NEO_GATE: Say where the ticket goes now — it can''t keep waiting on a part it no longer holds.';
  end if;

  -- What the customer is told about each part: "your graphics card is still
  -- with ASUS — track it as RM-…" (A5, A13: the brand, never a distributor).
  select string_agg('your ' || lower(public._item_kind_label(rc.kind))
                      || case when rc.stage = 'with_vendor'
                              then ' is still with ' || coalesce(public._rma_party(rc.brand, vd.public_name, vd.kind), 'the manufacturer')
                              else ' is still under warranty claim' end
                      || ' — track it as ' || rc.public_code,
                    '; ' order by rc.intake_seq, rc.created_at, rc.id)
    into v_parts
    from public.rma_cases rc
    left join public.rma_vendors vd on vd.id = rc.vendor_id
   where rc.id = any (v_ids);

  -- 1. Move the ticket first, as the RMA link (the guard's hold rule is met
  --    by construction: the remaining-parts check above).
  if v_to is not null and v_to <> v_job.stage then
    v_prev := public._flag_set('neo.sync');
    update public.service_jobs
       set stage = v_to, stage_since = now(), waiting_party = null, next_chase_at = null,
           outcome = case when v_to in ('ready', 'closed') then v_outcome else null end,
           ready_at = case when v_to = 'ready' then now() when v_to = 'closed' then ready_at else null end,
           closed_at = case when v_to = 'closed' then now() else null end,
           closed_by = case when v_to = 'closed' then v_me.email else null end
     where id = v_job.id
    returning * into v_newjob;
    perform public._flag_restore('neo.sync', v_prev);
    v_body := case when v_to = 'ready' then 'Collected; ' || v_parts || '.'
                   else upper(left(v_parts, 1)) || substr(v_parts, 2) || '. It continues on its own.' end;
    perform public._svc_ev(v_job.id, 'stage', v_body, true, v_job.stage, v_to,
                           jsonb_build_object('released_rma', v_codes), 'staff', v_me.email, v_me.full_name);
  end if;

  -- 2. Then release the parts. The sync now finds nothing to do.
  update public.rma_cases
     set holds_ticket = false,
         return_method = coalesce(v_rm, 'collect'),
         return_address = case when v_rm = 'courier' then v_raddr else return_address end
   where id = any (v_ids);

  for r in select * from public.rma_cases where id = any (v_ids) order by id loop
    perform public._rma_ev(r.id, 'link',
      'Released from ' || v_job.public_code || ' — this part now continues on its own. '
        || case when r.return_method = 'courier' then 'We''ll courier it back to you when it''s ready.'
                else 'We''ll tell you when it''s ready to collect.' end,
      true, null, null, jsonb_build_object('service_job_id', v_job.id, 'return_method', r.return_method),
      'staff', v_me.email, v_me.full_name);
  end loop;

  if v_note is not null then
    perform public._svc_ev(v_job.id, 'note', v_note, false, null, null, '{}'::jsonb, 'staff', v_me.email, v_me.full_name);
  end if;

  select * into v_newjob from public.service_jobs where id = v_job.id;
  return jsonb_build_object(
    'ok', true,
    'job', case when public.svc_reader() then to_jsonb(v_newjob) else null end,
    'units', coalesce((select jsonb_agg(jsonb_build_object('id', rc.id, 'public_code', rc.public_code, 'stage', rc.stage,
                                                           'holds_ticket', rc.holds_ticket, 'return_method', rc.return_method)
                                        order by rc.id)
                         from public.rma_cases rc where rc.id = any (v_ids)), '[]'::jsonb));
end $$;

create or replace function public.rma_advance_replace(p_case_id text, p_stock_serial text, p_note text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_serial text := nullif(btrim(coalesce(p_stock_serial, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_case public.rma_cases;
  v_new public.rma_cases;
  v_job public.service_jobs;
  v_to text;
  v_remaining boolean;
  v_prev text;
begin
  -- SPEC-GAP: as rma_release_hold — offered from the ticket's Items tab too.
  if not (public.has_module('rma', 'desk') or public.has_module('service', 'desk')) then
    raise exception 'NEO_DENIED: You don''t have access to replace parts from stock.';
  end if;
  if v_serial is null then raise exception 'NEO_GATE: Type the serial of the part from stock.'; end if;
  if length(v_serial) > 80 or length(coalesce(v_note, '')) > 2000 then
    raise exception 'NEO_GATE: The serial or note is too long.';
  end if;

  perform public._rma_lock(array[p_case_id]);
  select * into v_case from public.rma_cases where id = p_case_id;
  if not found then raise exception 'NEO_GATE: That part no longer exists.'; end if;
  if v_case.stage = 'closed' then raise exception 'NEO_GATE: This part is closed.'; end if;
  if v_case.advance_replacement then raise exception 'NEO_GATE: This part was already replaced from stock.'; end if;

  -- The customer's part becomes shop stock; when it later closes the desk uses
  -- disposition "restocked". It no longer holds the ticket.
  v_prev := public._flag_set('neo.rma_nosync');
  update public.rma_cases
     set advance_replacement = true, advance_serial = v_serial, advance_at = now(), holds_ticket = false
   where id = p_case_id
  returning * into v_new;
  perform public._flag_restore('neo.rma_nosync', v_prev);

  perform public._rma_ev(p_case_id, 'link',
    'Replaced from our stock — your ' || lower(public._item_kind_label(v_case.kind)) || ' is fitted.',
    true, null, null, jsonb_build_object('advance_serial', v_serial), 'staff', v_me.email, v_me.full_name);
  if v_note is not null then
    perform public._rma_ev(p_case_id, 'note', v_note, false, null, null, '{}'::jsonb, 'staff', v_me.email, v_me.full_name);
  end if;

  if v_case.holds_ticket and v_case.service_job_id is not null then
    select * into v_job from public.service_jobs where id = v_case.service_job_id;
    v_remaining := exists (select 1 from public.rma_cases rc
                            where rc.service_job_id = v_job.id and rc.holds_ticket
                              and rc.stage in ('with_tech','logged','received','testing','awaiting_docs','ready_to_ship','with_vendor'));
    if v_job.stage in ('rma_raised', 'at_vendor', 'back_from_vendor') then
      if not v_remaining then
        -- "Back from vendor" would be untrue: the part is still out. Back to the bench.
        -- SPEC-GAP: an on-site ticket has no bench stage; it goes to revisit_needed.
        v_to := case when v_job.service_type = 'on_site' then 'revisit_needed' else 'in_service' end;
        v_prev := public._flag_set('neo.sync');
        update public.service_jobs
           set stage = v_to, stage_since = now(), waiting_party = null, next_chase_at = null
         where id = v_job.id;
        perform public._flag_restore('neo.sync', v_prev);
        perform public._svc_ev(v_job.id, 'stage', 'Fitting a replacement part from our stock.', true, v_job.stage, v_to,
                               jsonb_build_object('rma_case_id', p_case_id), 'staff', v_me.email, v_me.full_name);
      else
        perform public.rma_sync_ticket(v_job.id);
      end if;
    end if;
    select * into v_job from public.service_jobs where id = v_case.service_job_id;
  end if;

  return jsonb_build_object('ok', true, 'unit', to_jsonb(v_new),
                            'job', case when v_job.id is not null and public.svc_reader() then to_jsonb(v_job) end);
end $$;

create or replace function public.rma_claim(p_case_id text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_case public.rma_cases;
  v_new public.rma_cases;
begin
  if not public.has_module('rma', 'tech') then
    raise exception 'NEO_DENIED: Only RMA technicians can take parts.';
  end if;
  update public.rma_cases
     set handler_email = v_me.email, handler_name = v_me.full_name
   where id = p_case_id and handler_email is null and stage <> 'closed'
  returning * into v_new;
  if v_new.id is null then
    select * into v_case from public.rma_cases where id = p_case_id;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    if v_case.stage = 'closed' then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
    return jsonb_build_object('ok', false, 'reason', 'taken', 'by', v_case.handler_name, 'by_email', v_case.handler_email);
  end if;
  perform public._rma_ev(p_case_id, 'edit', 'Taken by ' || v_me.full_name, false, null, null,
                         jsonb_build_object('handler_email', v_me.email), 'staff', v_me.email, v_me.full_name);
  return jsonb_build_object('ok', true, 'unit', to_jsonb(v_new));
end $$;

create or replace function public.rma_add_note(p_case_id text, p_body text, p_visible boolean default false)
returns jsonb
language plpgsql volatile security definer
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

-- Public tracking for RM- codes. Same discipline as get_service_public: the
-- code + last 4 digits of the tracking phone, one null for every failure, and a
-- curated list — never serial, phone, address, fee, invoice or vendor RMA no.
create or replace function public.get_rma_public(code text, phone4 text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_code text := upper(btrim(coalesce($1, '')));
  v_p4 text := btrim(coalesce($2, ''));
  v_case public.rma_cases;
  v_intake public.rma_intakes;
  v_vendor text;
  v_vendor_kind text;
begin
  if v_code = '' or v_p4 !~ '^[0-9]{4}$' then return null; end if;
  select * into v_case from public.rma_cases rc where rc.public_code = v_code;
  if not found then return null; end if;
  select * into v_intake from public.rma_intakes where id = v_case.intake_id;
  if right(regexp_replace(coalesce(nullif(btrim(v_case.owner_phone), ''), v_intake.sender_phone, ''), '[^0-9]', '', 'g'), 4)
     is distinct from v_p4 then
    return null;
  end if;
  -- A13: the brand when known, else the vendor's public name — never a distributor's.
  select public_name, kind into v_vendor, v_vendor_kind from public.rma_vendors where id = v_case.vendor_id;
  v_vendor := public._rma_party(v_case.brand, v_vendor, v_vendor_kind);

  return jsonb_build_object(
    'public_code',      v_case.public_code,
    'label',            public._rma_label(v_case.kind, v_case.brand, v_case.model),
    'kind',             v_case.kind,
    'stage',            v_case.stage,
    'stage_since',      v_case.stage_since,
    'created_at',       v_case.created_at,
    'received_at',      v_intake.received_at,
    'return_method',    v_case.return_method,
    'disposition',      v_case.disposition,
    'vendor_result',    case when v_case.vendor_result in ('replaced','repaired','credit_note','rejected','shipped_to_customer')
                             then v_case.vendor_result end,
    'waiting_party',    case when v_case.stage = 'with_vendor' then v_vendor end,
    -- SPEC-GAP: only while the part is at the vendor; afterwards a stale date
    -- would read as a promise.
    'expected_back_at', case when v_case.stage = 'with_vendor' then v_case.expected_back_at end,
    'handled_by',       nullif(split_part(btrim(coalesce(v_case.handler_name, '')), ' ', 1), ''),
    'linked_job_code',  (select sj.public_code from public.service_jobs sj where sj.id = v_case.service_job_id),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('at', e.at, 'body', e.body, 'to_stage', e.to_stage) order by e.at desc)
        from (select re.at, re.body, re.to_stage from public.rma_events re
               where re.case_id = v_case.id and re.customer_visible
               order by re.at desc limit 100) e), '[]'::jsonb));
end $$;


-- =============================================================================
-- §20  VIEWS FOR NeoHR (security_invoker: the caller's own RLS applies)
-- =============================================================================

-- The open queue. No phone, no address: area, pincode and a ~1 km location.
drop view if exists public.v_service_queue;
create view public.v_service_queue with (security_invoker = true) as
select sj.id, sj.public_code, sj.service_type, sj.category, sj.priority, sj.fault_keys, sj.device_label,
       sj.site_area, sj.site_pincode,
       round(sj.site_lat::numeric, 2)::double precision as lat,
       round(sj.site_lng::numeric, 2)::double precision as lng,
       sj.window_start, sj.window_end, sj.window_note, sj.est_minutes, sj.queued_at,
       sj.suggested_tech_email, sj.suggest_reason, sj.created_at, sj.stage,
       nullif(split_part(btrim(coalesce(sj.customer_name, '')), ' ', 1), '') as customer_first_name
  from public.service_jobs sj
 where sj.stage <> 'closed' and sj.assignee_email is null;

-- My day: everything I hold, with what I need to get there.
drop view if exists public.v_tech_day;
create view public.v_tech_day with (security_invoker = true) as
select sj.id, sj.public_code, sj.service_type, sj.category, sj.priority, sj.stage, sj.stage_since,
       sj.fault_keys, sj.reported_fault, sj.device_label, sj.customer_name, sj.customer_phone,
       sj.site_address, sj.site_area, sj.site_pincode, sj.site_landmark, sj.site_maps_url,
       sj.site_lat, sj.site_lng, sj.site_contact,
       sj.window_start, sj.window_end, sj.window_note, sj.visit_start, sj.visit_end, sj.visit_count,
       sj.est_minutes, sj.remote_tool, sj.remote_session_ref, sj.promised_at, sj.needed_by,
       sj.assigned_at, sj.assigned_via, sj.updated_at
  from public.service_jobs sj
 where sj.stage <> 'closed'
   and lower(sj.assignee_email) = lower(coalesce(auth.email(), ''));

revoke all on table public.v_service_queue, public.v_tech_day from anon, authenticated, public;
grant select on table public.v_service_queue, public.v_tech_day to authenticated;

-- Per person per day (shop time) — SPEC-AMENDMENTS A24: an RPC, not a view,
-- so the "who may see whose rows" rule is one explicit check instead of a
-- view predicate. A service lead or a NeoHR lead (tier 3+ are both) sees
-- everyone; anyone else gets only their own rows. Default range: the last
-- 30 days; at most 366 days per call.
drop view if exists public.v_tech_activity;

create or replace function public.tech_activity(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me public.profiles := public._neo_me();
  v_all boolean := public.has_module('service', 'lead') or public.has_module('neohr', 'lead');
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_to date := coalesce(p_to, v_today);
  v_from date := coalesce(p_from, coalesce(p_to, v_today) - 30);
  v_lo timestamptz;
  v_hi timestamptz;
begin
  if v_to < v_from then raise exception 'NEO_GATE: The end date is before the start date.'; end if;
  if v_to - v_from > 366 then raise exception 'NEO_GATE: Ask for at most a year at a time.'; end if;
  v_lo := v_from::timestamp at time zone 'Asia/Kolkata';
  v_hi := (v_to + 1)::timestamp at time zone 'Asia/Kolkata';

  return coalesce((
    with ev as (
      select lower(fa.employee_email) as employee_email,
             (fa.at at time zone 'Asia/Kolkata')::date as day,
             fa.kind, fa.outcome, fa.at, fa.employee_name as name, true as self_action
        from public.field_activity fa
       where fa.at >= v_lo and fa.at < v_hi
         and (v_all or lower(fa.employee_email) = lower(v_me.email))
      union all
      select lower(se.meta ->> 'tech_email'),
             (se.at at time zone 'Asia/Kolkata')::date,
             'ev_' || se.kind, null, se.at, null,
             coalesce(lower(se.meta ->> 'by_email'), lower(se.meta ->> 'tech_email')) = lower(se.meta ->> 'tech_email')
        from public.service_events se
       where se.kind in ('claim', 'release', 'assign') and se.meta ? 'tech_email'
         and se.at >= v_lo and se.at < v_hi
         and (v_all or lower(se.meta ->> 'tech_email') = lower(v_me.email))
    ),
    agg as (
      select ev.employee_email,
             ev.day,
             coalesce(max(pr.full_name), max(ev.name)) as employee_name,
             count(*) filter (where ev.kind = 'ev_claim') as claims,
             count(*) filter (where ev.kind = 'ev_release' and ev.self_action) as releases,
             count(*) filter (where ev.kind = 'ev_release' and not ev.self_action) as released_by_lead,
             count(*) filter (where ev.kind = 'ev_assign') as manager_assigns,
             count(*) filter (where ev.kind = 'left_base') as visits_left,
             count(*) filter (where ev.kind = 'arrived') as visits_arrived,
             count(*) filter (where ev.kind = 'departed' and ev.outcome = 'done') as visits_done,
             count(*) filter (where ev.kind = 'departed' and ev.outcome = 'revisit_needed') as revisits,
             count(*) filter (where ev.kind = 'departed' and ev.outcome = 'parts_needed') as parts_needed,
             count(*) filter (where ev.kind = 'departed' and ev.outcome = 'customer_absent') as customer_absent,
             count(*) filter (where ev.kind = 'punch_in') as punch_ins,
             count(*) filter (where ev.kind = 'punch_out') as punch_outs,
             min(ev.at) as first_at,
             max(ev.at) as last_at
        from ev
        left join public.profiles pr on lower(pr.email) = ev.employee_email
       where ev.employee_email is not null
       group by ev.employee_email, ev.day
    )
    select jsonb_agg(to_jsonb(agg) order by agg.day desc, agg.employee_email) from agg), '[]'::jsonb);
end $$;


-- =============================================================================
-- §21  REALTIME
-- =============================================================================

do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'service_v2_rma: publication supabase_realtime not found; realtime for the new tables skipped';
    return;
  end if;
  foreach t in array array['service_items', 'rma_cases', 'rma_intakes', 'service_media'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


-- =============================================================================
-- §22  FUNCTION PRIVILEGES
--      Postgres grants EXECUTE to PUBLIC by default and Supabase adds anon and
--      authenticated. Every function in this file is revoked from all three,
--      then granted exactly: the API and the RLS helpers to authenticated, the
--      two tracking lookups to anon as well. Internals stay unreachable.
-- =============================================================================

do $$
declare
  r record;
  v_all text[] := array[
    -- helpers
    'norm_phone','phone_ok','role_rank','new_public_code','new_text_id','_vocab_list','_vocab','svc_stage_legal',
    'svc_known_stage','rma_transition_ok','_svc_stage_label','_svc_type_label','_svc_type_phrase',
    '_svc_channel_label','_svc_outcome_label','_item_kind_label','_rma_label','_rma_stage_label',
    '_rma_disposition_label','_rma_stage_customer','_rma_source_label','_rma_result_word','_rma_party',
    '_rma_data_label','_ist','_inr',
    '_flag_set','_flag_restore','_jtxt','_jbool','_jts','_jdate','_jnum','_jint','_juuid','_jtxtarr',
    'my_tier','module_role','has_module','my_modules','svc_reader','rma_reader','_module_role_of',
    'rma_item_media_visible','rma_media_path_visible',
    '_neo_me','_staff_by_email','_customer_upsert',
    -- triggers and the RMA link
    'tg_customers_touch','tg_service_jobs_customer','tg_service_jobs_defaults','tg_service_jobs_guard',
    'tg_service_jobs_v1_item','tg_service_jobs_device_mirror','tg_service_items_sync','tg_rma_intakes_customer',
    'tg_rma_cases_touch','rma_sync_ticket','tg_rma_cases_sync','tg_rma_cases_data_handling','tg_rma_events_mirror',
    'tg_service_jobs_closed',
    -- internals
    '_svc_ev','_rma_ev','_resolve_build_ticket','_svc_item_insert','_svc_create_result','_svc_create',
    '_rma_lock','_rma_gate_problems','_svc_unassign','_rma_create_result','_rma_create',
    -- API
    'module_access_set','module_access_list','lookup_customer','find_builds','service_create','service_move',
    'service_claim','service_release','service_assign','service_suggest','service_set_priority','service_add_item',
    'service_add_note','service_tech_list','service_my_requests','get_service_public','record_field_activity',
    'tech_activity','rma_create','rma_receive','rma_move','rma_dispatch','rma_vendor_result','rma_set_fee',
    'rma_release_hold','rma_advance_replace','rma_claim','rma_add_note','get_rma_public'];
  v_authenticated text[] := array[
    -- used inside RLS policies, views and column defaults, or harmless pure rules
    -- (_vocab_list because svc_known_stage, an invoker function, reads it)
    'norm_phone','phone_ok','role_rank','new_text_id','svc_stage_legal','svc_known_stage','rma_transition_ok','_vocab_list',
    'my_tier','module_role','has_module','my_modules','svc_reader','rma_reader',
    'rma_item_media_visible','rma_media_path_visible',
    -- API
    'module_access_set','module_access_list','lookup_customer','find_builds','service_create','service_move',
    'service_claim','service_release','service_assign','service_suggest','service_set_priority','service_add_item',
    'service_add_note','service_tech_list','service_my_requests','get_service_public','record_field_activity',
    'tech_activity','rma_create','rma_receive','rma_move','rma_dispatch','rma_vendor_result','rma_set_fee',
    'rma_release_hold','rma_advance_replace','rma_claim','rma_add_note','get_rma_public'];
  v_anon text[] := array['get_service_public', 'get_rma_public'];
begin
  for r in
    select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as sig, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any (v_all)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname = any (v_authenticated) then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
    if r.proname = any (v_anon) then
      execute format('grant execute on function %s to anon', r.sig);
    end if;
  end loop;
end $$;

-- =============================================================================
-- End of service_v2_rma. Run sql/service-v2.tests.sql next (it rolls back).
-- =============================================================================
