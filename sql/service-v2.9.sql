-- ════════════════════════════════════════════════════════════════════════════
--  Neo OS 1.13 — server v2.9: handover — payment, who collected it, and the
--  delivery receipt's facts (owner's decisions, 2026-11-21):
--    * staff record the amount received and how (cash, UPI, card, bank
--      transfer); a bill can be paid in more than one way;
--    * paying less than the bill is allowed — the balance due is noted on the
--      ticket and printed on the receipt;
--    * the receipt prints the work done, the bill and who collected it.
--
--  service_payments: one row per payment received. Staff read it
--  (svc_reader); nobody writes it directly — only service_handover.
--  service_jobs gains bill_total, collected_by_name and collected_by_phone.
--
--  service_handover(job, from, outcome, bill_total, payments, collected_by,
--                   collected_phone, work_done, note)
--    from Ready (in-store), Work done (on-site) or Resolved (remote): saves
--    the payments and the receipt facts, writes a staff-only line with the
--    money, and closes the ticket through service_move (its checks, its
--    customer-visible line, its outcome rule).
--
--  Additive: no existing column, table or function changes.
--  After it: sql/service-v2.9-rollback.sql undoes it.
-- ════════════════════════════════════════════════════════════════════════════
begin;

alter table public.service_jobs add column if not exists bill_total numeric(12,2);
alter table public.service_jobs add column if not exists collected_by_name text;
alter table public.service_jobs add column if not exists collected_by_phone text;
alter table public.service_jobs drop constraint if exists service_jobs_bill_total_check;
alter table public.service_jobs add constraint service_jobs_bill_total_check
  check (bill_total is null or (bill_total >= 0 and bill_total <= 10000000));
alter table public.service_jobs drop constraint if exists service_jobs_collected_by_check;
alter table public.service_jobs add constraint service_jobs_collected_by_check
  check ((collected_by_name is null or char_length(collected_by_name) between 1 and 120)
     and (collected_by_phone is null or char_length(collected_by_phone) between 1 and 30));

create table if not exists public.service_payments (
  id                 text primary key,
  job_id             text not null references public.service_jobs(id) on delete cascade,
  amount             numeric(12,2) not null check (amount > 0 and amount <= 10000000),
  method             text not null check (method in ('cash','upi','card','bank_transfer')),
  reference          text check (reference is null or char_length(reference) <= 80),
  received_at        timestamptz not null default now(),
  received_by_email  text,
  received_by_name   text
);
create index if not exists service_payments_job_idx on public.service_payments (job_id, received_at);

alter table public.service_payments enable row level security;
revoke all on table public.service_payments from anon, authenticated, public;
grant select on table public.service_payments to authenticated;
drop policy if exists sp_select on public.service_payments;
create policy sp_select on public.service_payments for select to authenticated
  using ((select public.svc_reader()));

create or replace function public.service_handover(p_job_id text, p_from text, p_outcome text, p_bill_total numeric,
                                                   p_payments jsonb, p_collected_by text default null,
                                                   p_collected_phone text default null, p_work_done text default null,
                                                   p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_me public.profiles := public._neo_me();
  v_job public.service_jobs;
  v_outcome text := public._vocab(nullif(btrim(coalesce(p_outcome, '')), ''), 'outcome', 'Outcome');
  v_by text := nullif(btrim(coalesce(p_collected_by, '')), '');
  v_ph text := nullif(btrim(coalesce(p_collected_phone, '')), '');
  v_work text := nullif(btrim(coalesce(p_work_done, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_bill numeric := round(p_bill_total, 2);
  v_pays jsonb := coalesce(p_payments, '[]'::jsonb);
  v_n int; i int; l jsonb; v_amt numeric; v_method text; v_ref text; v_paid numeric := 0;
  v_list text := ''; v_line text; v_body text; v_prev text; v_job_out jsonb; v_out jsonb;
begin
  if not public.has_module('service', 'desk') then
    raise exception 'NEO_DENIED: You don''t have access to hand over service tickets.';
  end if;
  select * into v_job from public.service_jobs where id = p_job_id for update;
  if not found then raise exception 'NEO_GATE: That ticket no longer exists.'; end if;
  if v_job.stage is distinct from p_from then
    raise exception 'NEO_STALE: Someone moved this ticket to % already. Reopen it to see where it is.',
      public._svc_stage_label(v_job.stage);
  end if;
  if v_job.stage not in ('ready', 'work_done', 'resolved') then
    raise exception 'NEO_GATE: Hand a ticket over once it is ready (or the work is done).';
  end if;
  if v_outcome is null and v_job.outcome is null then
    raise exception 'NEO_GATE: Say what happened — the customer sees this, and “Closed” on its own tells them nothing.';
  end if;
  if v_bill is null or v_bill < 0 or v_bill > 10000000 then
    raise exception 'NEO_GATE: Give the bill total incl. GST — ₹0 if there is no charge.';
  end if;
  if v_by is not null and length(v_by) > 120 then raise exception 'NEO_GATE: The collector''s name is too long.'; end if;
  if v_ph is not null and length(v_ph) > 30 then raise exception 'NEO_GATE: The collector''s phone number is too long.'; end if;
  if v_work is not null and length(v_work) > 4000 then raise exception 'NEO_GATE: Keep the work done under 4000 characters.'; end if;
  if v_note is not null and length(v_note) > 1000 then raise exception 'NEO_GATE: Keep the note under 1000 characters.'; end if;

  if jsonb_typeof(v_pays) is distinct from 'array' then raise exception 'NEO_GATE: The payments must be a list.'; end if;
  v_n := jsonb_array_length(v_pays);
  if v_n > 6 then raise exception 'NEO_GATE: A handover takes up to 6 payments.'; end if;
  for i in 0 .. v_n - 1 loop
    l := v_pays -> i;
    if jsonb_typeof(l) is distinct from 'object' then raise exception 'NEO_GATE: Payment % can''t be read.', i + 1; end if;
    v_amt := public._jnum(l, 'amount', 'Payment ' || (i + 1));
    if v_amt is null or v_amt <= 0 or v_amt > 10000000 then raise exception 'NEO_GATE: Give payment % an amount above ₹0.', i + 1; end if;
    v_method := public._jtxt(l, 'method', 20, 'How payment ' || (i + 1) || ' was made');
    if v_method is null or v_method not in ('cash', 'upi', 'card', 'bank_transfer') then
      raise exception 'NEO_GATE: Say how payment % was made — cash, UPI, card or bank transfer.', i + 1;
    end if;
    v_ref := public._jtxt(l, 'reference', 80, 'The reference for payment ' || (i + 1));
    v_paid := v_paid + round(v_amt, 2);
  end loop;
  if v_paid > v_bill then
    raise exception 'NEO_GATE: The payments (%) add up to more than the bill (%).', public._inr(v_paid), public._inr(v_bill);
  end if;

  for i in 0 .. v_n - 1 loop
    l := v_pays -> i;
    v_amt := round(public._jnum(l, 'amount', 'Payment'), 2);
    v_method := public._jtxt(l, 'method', 20, 'Method');
    v_ref := public._jtxt(l, 'reference', 80, 'Reference');
    insert into public.service_payments (id, job_id, amount, method, reference, received_by_email, received_by_name)
    values (public.new_text_id('pay'), p_job_id, v_amt, v_method, v_ref, v_me.email, v_me.full_name);
    v_line := case v_method when 'cash' then 'cash' when 'upi' then 'UPI' when 'card' then 'card' else 'bank transfer' end;
    v_list := v_list || case when i > 0 then ', ' else '' end || public._inr(v_amt) || ' by ' || v_line
              || coalesce(' (ref ' || v_ref || ')', '');
  end loop;

  v_prev := public._flag_set('neo.rpc');
  update public.service_jobs
     set bill_total = v_bill, collected_by_name = v_by, collected_by_phone = v_ph,
         work_done = coalesce(v_work, work_done), updated_at = now()
   where id = p_job_id;
  perform public._flag_restore('neo.rpc', v_prev);

  -- The money, for staff only.
  v_body := 'Bill ' || public._inr(v_bill) || ' incl. GST. '
            || case when v_n = 0 then 'Nothing paid'
                    else 'Paid ' || public._inr(v_paid) || ': ' || v_list end || '.'
            || case when v_paid < v_bill then ' Balance due ' || public._inr(v_bill - v_paid) || '.' else '' end
            || coalesce(' ' || v_note, '');
  perform public._svc_ev(p_job_id, 'note', v_body, false, null, null,
    jsonb_build_object('bill_total', v_bill, 'paid', v_paid, 'balance', v_bill - v_paid),
    'staff', v_me.email, v_me.full_name);

  -- What the customer reads, and the close itself.
  v_job_out := public.service_move(p_job_id, p_from, 'closed',
    'Handed over' || coalesce(' to ' || v_by, '') || '.', true,
    case when v_outcome is not null then jsonb_build_object('outcome', v_outcome) else '{}'::jsonb end);

  select coalesce(jsonb_agg(to_jsonb(sp) order by sp.received_at, sp.id), '[]'::jsonb) into v_out
    from public.service_payments sp where sp.job_id = p_job_id;
  return jsonb_build_object('ok', true, 'job', v_job_out, 'payments', v_out,
                            'paid', v_paid, 'balance', v_bill - v_paid);
end $$;

revoke all on function public.service_handover(text, text, text, numeric, jsonb, text, text, text, text) from public, anon;
grant execute on function public.service_handover(text, text, text, numeric, jsonb, text, text, text, text) to authenticated;

commit;
