-- ════════════════════════════════════════════════════════════════════════════
--  Neo Service 1.14 — server v2.10: phone-only technicians (owner's decision,
--  2026-11-21): "from now on only the senior technicians and the others get
--  login for the neo service app". A technician who works only from the phone
--  app keeps the service role and the service pool — so jobs can still be
--  assigned to them and the phone app works exactly as before — but the
--  desktop app shows them a "use the phone app" notice with Sign out.
--
--  staff_work.phone_only (default false). my_modules() returns it as the
--  extra key 'phone_only'; every existing key and rule stays the same, so the
--  phone app (which ignores keys it does not know) is not affected.
--  staff_update keeps working: it writes named columns only, so saving a
--  person in Settings → People never resets phone_only.
--
--  Additive. Who is phone-only is set separately (staff_work.phone_only).
--  After it: sql/service-v2.10-rollback.sql undoes it.
-- ════════════════════════════════════════════════════════════════════════════
begin;

do $guard$
begin
  if md5(pg_get_functiondef('public.my_modules()'::regprocedure)) <> 'bd5157bb83344e3d5e825dbd3ce552a4' then
    raise exception 'v2.10: my_modules() is not the version this migration expects; not changing it';
  end if;
end $guard$;

alter table public.staff_work add column if not exists phone_only boolean not null default false;

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
'tier',    public.my_tier(),
'build_pool',   coalesce(w.build_pool, false),
'service_pool', coalesce(w.service_pool, false),
'build_level',  w.build_level,
'phone_only',   coalesce(w.phone_only, false))
from (select 1) x
left join lateral (select ws.*, sw.phone_only
from public.profiles p
cross join lateral public._work_settings(p.id) ws
left join public.staff_work sw on sw.profile_id = p.id
where p.id = auth.uid() and p.active and coalesce(p.is_staff, false)) w on true
$$;

revoke all on function public.my_modules() from public, anon;
grant execute on function public.my_modules() to authenticated;

commit;
