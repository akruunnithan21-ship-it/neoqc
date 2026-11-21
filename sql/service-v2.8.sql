-- ════════════════════════════════════════════════════════════════════════════
--  Neo OS 1.13 — server v2.8: itemised quotes, approved line by line
--  (owner's decisions, 2026-11-21):
--    * a quote is lines of parts, labour or other, each with a quantity and a
--      price that INCLUDES GST; the total says "incl. GST";
--    * a diagnosis must be written before a quote goes out;
--    * staff record the customer's answer line by line ("do the SSD, skip the
--      screen"), with how it came (counter, phone, WhatsApp) and who took it.
--
--  service_quotes: one row per quote sent; a new quote while one is still
--  waiting replaces it ("withdrawn"). Staff read it (svc_reader); nobody
--  writes it directly — only through the two functions below.
--
--  service_quote_send(job, from, lines, diagnosis, note, promised_at)
--    saves the diagnosis on the ticket, stores the quote and moves the ticket
--    to `quoted` through service_move (its checks, its history line). A
--    revised quote on a ticket already at `quoted` stays there and adds a
--    note instead. In-store and on-site tickets only.
--  service_quote_decide(quote, approved line numbers, via, note)
--    records the answer; any line approved → `approved`; none → declined:
--    in-store `ready`, on-site `closed`, with the outcome "declined".
--
--  Additive: no existing table, column or function changes.
--  After it: sql/service-v2.8-rollback.sql undoes it.
-- ════════════════════════════════════════════════════════════════════════════
begin;

create table if not exists public.service_quotes (
  id                text primary key,
  job_id            text not null references public.service_jobs(id) on delete cascade,
  version           int  not null check (version >= 1),
  status            text not null default 'sent'
                    check (status in ('sent','approved','partly_approved','declined','withdrawn')),
  lines             jsonb not null
                    check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 30),
  total             numeric(12,2) not null check (total >= 0),
  approved_total    numeric(12,2) check (approved_total is null or approved_total >= 0),
  gst_included      boolean not null default true,
  note              text check (note is null or char_length(note) <= 1000),
  sent_at           timestamptz not null default now(),
  sent_by_email     text,
  sent_by_name      text,
  decided_at        timestamptz,
  decided_by_email  text,
  decided_by_name   text,
  decided_via       text check (decided_via is null or decided_via in ('counter','phone','whatsapp','other')),
  decision_note     text check (decision_note is null or char_length(decision_note) <= 1000),
  unique (job_id, version)
);
create index if not exists service_quotes_job_idx on public.service_quotes (job_id, version desc);

alter table public.service_quotes enable row level security;
revoke all on table public.service_quotes from anon, authenticated, public;
grant select on table public.service_quotes to authenticated;
drop policy if exists sq_select on public.service_quotes;
create policy sq_select on public.service_quotes for select to authenticated
  using ((select public.svc_reader()));

-- ₹ amount the way the shop writes it: 4,500 · 1,25,000 · 4,500.50
create or replace function public._inr(p numeric)
returns text
language sql immutable
set search_path to 'public'
as $$
select '₹' || to_char(trunc(coalesce(p, 0)), 'FM99,99,99,990')
       || case when coalesce(p, 0) <> trunc(coalesce(p, 0))
               then '.' || lpad((round((coalesce(p, 0) - trunc(coalesce(p, 0))) * 100))::int::text, 2, '0')
               else '' end
$$;

create or replace function public.service_quote_send(p_job_id text, p_from text, p_lines jsonb, p_diagnosis text,
                                                     p_note text default null, p_promised_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_me public.profiles := public._neo_me();
  v_job public.service_jobs;
  v_diag text := nullif(btrim(coalesce(p_diagnosis, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_lines jsonb := '[]'::jsonb;
  v_list text := '';
  l jsonb; v_kind text; v_text text; v_qty int; v_price numeric; v_total numeric := 0;
  v_n int; i int; v_ver int; v_id text; v_q public.service_quotes; v_job_out jsonb; v_body text; v_prev text;
begin
  if not public.has_module('service', 'desk') then
    raise exception 'NEO_DENIED: You don''t have access to quote service tickets.';
  end if;
  if v_diag is null then raise exception 'NEO_GATE: Write the diagnosis first — what is actually wrong.'; end if;
  if length(v_diag) > 4000 then raise exception 'NEO_GATE: The diagnosis is too long — keep it under 4000 characters.'; end if;
  if v_note is not null and length(v_note) > 1000 then
    raise exception 'NEO_GATE: The quote note is too long — keep it under 1000 characters.';
  end if;

  select * into v_job from public.service_jobs where id = p_job_id for update;
  if not found then raise exception 'NEO_GATE: That ticket no longer exists.'; end if;
  if v_job.stage is distinct from p_from then
    raise exception 'NEO_STALE: Someone moved this ticket to % already. Reopen it to see where it is.',
      public._svc_stage_label(v_job.stage);
  end if;
  if v_job.service_type = 'remote' then
    raise exception 'NEO_GATE: Quotes are for in-store and on-site tickets. For a remote session, send the amount by message.';
  end if;
  if v_job.stage in ('ready', 'closed') then
    raise exception 'NEO_GATE: This ticket is finished. A new quote needs a new ticket.';
  end if;

  if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'NEO_GATE: The quote lines must be a list.'; end if;
  v_n := jsonb_array_length(p_lines);
  if v_n = 0 then raise exception 'NEO_GATE: Add at least one line to the quote.'; end if;
  if v_n > 30 then raise exception 'NEO_GATE: A quote can have up to 30 lines.'; end if;
  for i in 0 .. v_n - 1 loop
    l := p_lines -> i;
    if jsonb_typeof(l) is distinct from 'object' then raise exception 'NEO_GATE: Quote line % can''t be read.', i + 1; end if;
    v_kind := coalesce(public._jtxt(l, 'kind', 10, 'The kind of line ' || (i + 1)), 'part');
    if v_kind not in ('part', 'labour', 'other') then raise exception 'NEO_GATE: Quote line % has an unknown kind.', i + 1; end if;
    v_text := public._jtxt(l, 'text', 200, 'Quote line ' || (i + 1));
    if v_text is null then raise exception 'NEO_GATE: Quote line % needs a description.', i + 1; end if;
    v_qty := coalesce(public._jint(l, 'qty', 'The quantity on line ' || (i + 1), 1, 99), 1);
    v_price := public._jnum(l, 'price', 'The price on line ' || (i + 1));
    if v_price is null or v_price < 0 or v_price > 10000000 then
      raise exception 'NEO_GATE: Give quote line % a price from ₹0 to ₹1,00,00,000.', i + 1;
    end if;
    v_price := round(v_price, 2);
    v_total := v_total + v_qty * v_price;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('n', i + 1, 'kind', v_kind, 'text', v_text,
                 'qty', v_qty, 'price', v_price, 'amount', v_qty * v_price));
    if i < 5 then
      v_list := v_list || case when i > 0 then '; ' else '' end || v_text
                || case when v_qty > 1 then ' ×' || v_qty else '' end || ' ' || public._inr(v_qty * v_price);
    end if;
  end loop;
  if v_n > 5 then v_list := v_list || '; and ' || (v_n - 5) || ' more'; end if;

  -- The diagnosis goes on the ticket (internal), as the Details form would.
  v_prev := public._flag_set('neo.rpc');
  update public.service_jobs set diagnosis = v_diag, updated_at = now() where id = p_job_id;
  perform public._flag_restore('neo.rpc', v_prev);

  -- An earlier quote still waiting for an answer is replaced by this one.
  update public.service_quotes set status = 'withdrawn' where job_id = p_job_id and status = 'sent';
  select coalesce(max(version), 0) + 1 into v_ver from public.service_quotes where job_id = p_job_id;
  v_id := public.new_text_id('q');
  insert into public.service_quotes (id, job_id, version, status, lines, total, gst_included, note, sent_by_email, sent_by_name)
  values (v_id, p_job_id, v_ver, 'sent', v_lines, v_total, true, v_note, v_me.email, v_me.full_name)
  returning * into v_q;

  -- What the customer reads on the tracking page.
  v_body := case when v_ver > 1 then 'Revised quote ' else 'Quote ' end || public._inr(v_total) || ' incl. GST: ' || v_list || '.';
  if v_job.stage = 'quoted' then
    perform public._svc_ev(p_job_id, 'note', v_body, true, null, null,
      jsonb_build_object('quote_id', v_id, 'version', v_ver), 'staff', v_me.email, v_me.full_name);
    select to_jsonb(j) into v_job_out from public.service_jobs j where j.id = p_job_id;
  else
    v_job_out := public.service_move(p_job_id, p_from, 'quoted', v_body, true,
      case when p_promised_at is not null then jsonb_build_object('promised_at', p_promised_at) else '{}'::jsonb end);
  end if;
  return jsonb_build_object('ok', true, 'quote', to_jsonb(v_q), 'job', v_job_out);
end $$;

create or replace function public.service_quote_decide(p_quote_id text, p_approved int[], p_via text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_me public.profiles := public._neo_me();
  v_q public.service_quotes;
  v_job public.service_jobs;
  v_via text := nullif(btrim(coalesce(p_via, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_ok int[] := coalesce(p_approved, '{}'::int[]);
  v_lines jsonb := '[]'::jsonb;
  v_n int; i int; l jsonb; v_on boolean; v_appr numeric := 0; v_cnt int := 0;
  v_skipped text := '';
  v_status text; v_to text; v_body text; v_job_out jsonb;
begin
  if not public.has_module('service', 'desk') then
    raise exception 'NEO_DENIED: You don''t have access to record quote answers.';
  end if;
  if v_via is null or v_via not in ('counter', 'phone', 'whatsapp', 'other') then
    raise exception 'NEO_GATE: Say how the customer answered — at the counter, on the phone or on WhatsApp.';
  end if;
  if v_note is not null and length(v_note) > 1000 then
    raise exception 'NEO_GATE: The note is too long — keep it under 1000 characters.';
  end if;
  select * into v_q from public.service_quotes where id = p_quote_id for update;
  if not found then raise exception 'NEO_GATE: That quote no longer exists.'; end if;
  select * into v_job from public.service_jobs where id = v_q.job_id for update;
  if v_q.status <> 'sent'
     or exists (select 1 from public.service_quotes x where x.job_id = v_q.job_id and x.version > v_q.version) then
    raise exception 'NEO_STALE: This quote was already answered or replaced. Reopen the ticket to see the latest.';
  end if;
  if v_job.stage is distinct from 'quoted' then
    raise exception 'NEO_STALE: The ticket is no longer waiting on this quote — it is at %.', public._svc_stage_label(v_job.stage);
  end if;

  v_n := jsonb_array_length(v_q.lines);
  if exists (select 1 from unnest(v_ok) a where a is null or a < 1 or a > v_n) then
    raise exception 'NEO_GATE: One of the approved lines is not on this quote.';
  end if;
  for i in 0 .. v_n - 1 loop
    l := v_q.lines -> i;
    v_on := ((l ->> 'n')::int = any (v_ok));
    if v_on then
      v_appr := v_appr + (l ->> 'amount')::numeric;
      v_cnt := v_cnt + 1;
    else
      v_skipped := v_skipped || case when v_skipped <> '' then '; ' else '' end || (l ->> 'text');
    end if;
    v_lines := v_lines || jsonb_build_array(l || jsonb_build_object('approved', v_on));
  end loop;
  v_status := case when v_cnt = 0 then 'declined' when v_cnt = v_n then 'approved' else 'partly_approved' end;

  update public.service_quotes
     set status = v_status, lines = v_lines, approved_total = v_appr,
         decided_at = now(), decided_by_email = v_me.email, decided_by_name = v_me.full_name,
         decided_via = v_via, decision_note = v_note
   where id = p_quote_id
   returning * into v_q;

  if v_status = 'declined' then
    v_body := 'Quote declined.';
    v_to := case when v_job.service_type = 'on_site' then 'closed' else 'ready' end;
    v_job_out := public.service_move(v_job.id, 'quoted', v_to, v_body, true, jsonb_build_object('outcome', 'declined'));
  else
    v_body := case when v_status = 'approved' then 'Quote approved: ' || public._inr(v_appr) || ' incl. GST.'
                   else 'Quote partly approved: ' || public._inr(v_appr) || ' of ' || public._inr(v_q.total)
                        || ' incl. GST. Not doing: ' || v_skipped || '.' end;
    v_job_out := public.service_move(v_job.id, 'quoted', 'approved', v_body, true, '{}'::jsonb);
  end if;
  return jsonb_build_object('ok', true, 'quote', to_jsonb(v_q), 'job', v_job_out);
end $$;

revoke all on function public.service_quote_send(text, text, jsonb, text, text, timestamptz) from public, anon;
revoke all on function public.service_quote_decide(text, int[], text, text) from public, anon;
grant execute on function public.service_quote_send(text, text, jsonb, text, text, timestamptz) to authenticated;
grant execute on function public.service_quote_decide(text, int[], text, text) to authenticated;

commit;
