-- ==========================================================================
-- NEO QC v2.0.0 — AUTH & PROFILES SETUP (Phase 1, ADDITIVE — safe for 1.8.5)
-- --------------------------------------------------------------------------
-- Run this whole file in the Supabase SQL Editor. It only CREATES new objects
-- (profiles table, an avatars storage bucket, a signup trigger) and does NOT
-- touch `tickets` / `component_prices`, so machines still on 1.8.5 keep working.
-- The real database lockdown (P2) happens later, at the 2.0.0 fleet cutover.
-- ==========================================================================

-- 1) PROFILES — one row per staff member, linked to the Supabase Auth account.
--    Tier drives all permissions. name/designation/tier are OWNER-set (not self-
--    editable); mobile + avatar are self-editable (enforced by column grants).
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text unique not null,
  full_name   text not null default '',
  designation text,
  tier        int  not null default 1 check (tier between 1 and 5),
  department  text,                              -- sales | service | tech | exec (optional)
  mobile      text,
  avatar_url  text,
  active      boolean not null default true,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table public.profiles enable row level security;

-- A logged-in user may READ their own profile.
drop policy if exists "profiles self read" on public.profiles;
create policy "profiles self read"
  on public.profiles for select
  using (auth.uid() = id);

-- A logged-in user may UPDATE their own row...
drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self update"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ...but only these COLUMNS. Column-level grants stop a user changing their own
-- tier / name / designation even though they can update their row.
revoke update on public.profiles from authenticated;
grant  update (mobile, avatar_url, updated_at) on public.profiles to authenticated;
grant  select on public.profiles to authenticated;

-- 2) AUTO-CREATE a profile stub whenever you add a user in the Auth dashboard.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, full_name, tier)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', new.email), 1)
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3) AVATARS storage bucket (WhatsApp-style profile picture). Public read so the
--    picture displays; a user can only write files under their own uid folder
--    (path convention: avatars/<uid>/dp.jpg).
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatar read all" on storage.objects;
create policy "avatar read all"
  on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists "avatar write own" on storage.objects;
create policy "avatar write own"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatar update own" on storage.objects;
create policy "avatar update own"
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ==========================================================================
-- AFTER running the SQL, in the Supabase DASHBOARD:
--   A. Authentication → Providers → Email: ENABLE it, and turn OFF
--      "Confirm email" (we have no real @neotokyo.in inboxes).
--   B. Authentication → Users → "Add user" for each person below, tick
--      "Auto Confirm User", set the PIN as the password:
--        ananthakrishnan@neotokyo.in   (8-digit PIN)   → you, T5
--        kiran.raj@neotokyo.in         (6-digit PIN)   → Kiran, T1
--   C. Back in the SQL Editor, set their real designation + tier:
--        update public.profiles set full_name='Ananthakrishnan A R',
--          designation='Founder / CTO', tier=5, department='exec'
--          where email='ananthakrishnan@neotokyo.in';
--        update public.profiles set full_name='Kiran Raj',
--          designation='Sales Executive', tier=1, department='sales'
--          where email='kiran.raj@neotokyo.in';
-- ==========================================================================
