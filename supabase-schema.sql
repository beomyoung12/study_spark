create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 16),
  updated_at timestamptz not null default now()
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 24),
  invite_code text not null unique,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.schedules (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, group_id)
);

create index if not exists group_members_user_idx on public.group_members(user_id);
create index if not exists schedules_group_idx on public.schedules(group_id);

create or replace function public.is_group_member(p_group_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = p_user_id
  );
$$;

create or replace function public.shares_group_with(p_other_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.group_members mine
    join public.group_members theirs on theirs.group_id = mine.group_id
    where mine.user_id = auth.uid() and theirs.user_id = p_other_user
  );
$$;

revoke all on function public.is_group_member(uuid, uuid) from public;
grant execute on function public.is_group_member(uuid, uuid) to anon, authenticated;
revoke all on function public.shares_group_with(uuid) from public;
grant execute on function public.shares_group_with(uuid) to anon, authenticated;

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.schedules enable row level security;

drop policy if exists "profiles_select_shared" on public.profiles;
create policy "profiles_select_shared" on public.profiles
for select to anon, authenticated
using (id = auth.uid() or public.shares_group_with(id));

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles
for insert to anon, authenticated
with check (id = auth.uid());

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
for update to anon, authenticated
using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "groups_select_members" on public.groups;
create policy "groups_select_members" on public.groups
for select to anon, authenticated
using (public.is_group_member(id));

drop policy if exists "groups_update_owner" on public.groups;
create policy "groups_update_owner" on public.groups
for update to anon, authenticated
using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "members_select_group" on public.group_members;
create policy "members_select_group" on public.group_members
for select to anon, authenticated
using (user_id = auth.uid() or public.is_group_member(group_id));

drop policy if exists "schedules_select_group" on public.schedules;
create policy "schedules_select_group" on public.schedules
for select to anon, authenticated
using (public.is_group_member(group_id));

drop policy if exists "schedules_insert_self" on public.schedules;
create policy "schedules_insert_self" on public.schedules
for insert to anon, authenticated
with check (user_id = auth.uid() and public.is_group_member(group_id));

drop policy if exists "schedules_update_self" on public.schedules;
create policy "schedules_update_self" on public.schedules
for update to anon, authenticated
using (user_id = auth.uid() and public.is_group_member(group_id))
with check (user_id = auth.uid() and public.is_group_member(group_id));

create or replace function public.create_study_group(
  p_group_name text,
  p_display_name text
)
returns table (group_id uuid, invite_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_id uuid := gen_random_uuid();
  v_invite_code text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if char_length(trim(p_group_name)) not between 1 and 24 then raise exception 'invalid group name'; end if;
  if char_length(trim(p_display_name)) not between 1 and 16 then raise exception 'invalid display name'; end if;

  loop
    v_invite_code := upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10));
    exit when not exists (select 1 from public.groups g where g.invite_code = v_invite_code);
  end loop;

  insert into public.profiles(id, display_name, updated_at)
  values (auth.uid(), trim(p_display_name), now())
  on conflict (id) do update set display_name = excluded.display_name, updated_at = now();

  insert into public.groups(id, name, invite_code, owner_id)
  values (v_group_id, trim(p_group_name), v_invite_code, auth.uid());

  insert into public.group_members(group_id, user_id)
  values (v_group_id, auth.uid());

  return query select v_group_id, v_invite_code;
end;
$$;

create or replace function public.join_study_group(
  p_invite_code text,
  p_display_name text
)
returns table (group_id uuid, invite_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_id uuid;
  v_invite_code text := upper(trim(p_invite_code));
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if char_length(trim(p_display_name)) not between 1 and 16 then raise exception 'invalid display name'; end if;

  select g.id into v_group_id from public.groups g where g.invite_code = v_invite_code;
  if v_group_id is null then raise exception 'invite not found'; end if;

  insert into public.profiles(id, display_name, updated_at)
  values (auth.uid(), trim(p_display_name), now())
  on conflict (id) do update set display_name = excluded.display_name, updated_at = now();

  insert into public.group_members(group_id, user_id)
  values (v_group_id, auth.uid())
  on conflict do nothing;

  return query select v_group_id, v_invite_code;
end;
$$;

revoke all on function public.create_study_group(text, text) from public;
grant execute on function public.create_study_group(text, text) to anon, authenticated;
revoke all on function public.join_study_group(text, text) from public;
grant execute on function public.join_study_group(text, text) to anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'schedules'
  ) then
    alter publication supabase_realtime add table public.schedules;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_members'
  ) then
    alter publication supabase_realtime add table public.group_members;
  end if;
end $$;
