-- ════════════════════════════════════════════════════════════════════════════
--  Undo server v2.10 (phone-only technicians): my_modules() goes back to its
--  v2.2 body (no 'phone_only' key) and staff_work loses phone_only. Desktop
--  1.14 reads a missing key as "not phone-only", so it keeps working.
-- ════════════════════════════════════════════════════════════════════════════
begin;

create or replace function public.my_modules()
returns jsonb
language sql stable security definer
set search_path = public
as $function$
select jsonb_build_object(
'service', public.module_role('service'),
'rma',     public.module_role('rma'),
'qc',      public.module_role('qc'),
'neohr',   public.module_role('neohr'),
'tier',    public.my_tier(),
'build_pool',   coalesce(w.build_pool, false),
'service_pool', coalesce(w.service_pool, false),
'build_level',  w.build_level)
from (select 1) x
left join lateral (select ws.*
from public.profiles p
cross join lateral public._work_settings(p.id) ws
where p.id = auth.uid() and p.active and coalesce(p.is_staff, false)) w on true
$function$;

revoke all on function public.my_modules() from public, anon;
grant execute on function public.my_modules() to authenticated;

alter table public.staff_work drop column if exists phone_only;

commit;
