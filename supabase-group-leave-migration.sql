-- Supabase SQL Editor에서 이 파일 전체를 한 번 실행하세요.
-- 기존 그룹 생성 함수가 extensions.gen_random_bytes를 찾도록 함께 보정합니다.
alter function public.create_study_group(text, text)
set search_path = public, extensions;

create or replace function public.leave_study_group(p_group_id uuid)
returns table (account_deleted boolean, remaining_group_count integer)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_owner_id uuid;
  v_next_owner uuid;
  v_remaining integer;
begin
  if v_user_id is null then raise exception 'authentication required'; end if;
  if not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = v_user_id
  ) then
    raise exception 'group membership not found';
  end if;

  select g.owner_id into v_owner_id
  from public.groups g
  where g.id = p_group_id
  for update;

  if v_owner_id = v_user_id then
    select gm.user_id into v_next_owner
    from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id <> v_user_id
    order by gm.joined_at
    limit 1;
    if v_next_owner is not null then
      update public.groups set owner_id = v_next_owner where id = p_group_id;
    end if;
  end if;

  delete from public.schedules
  where group_id = p_group_id and user_id = v_user_id;
  delete from public.group_members
  where group_id = p_group_id and user_id = v_user_id;

  if not exists (select 1 from public.group_members gm where gm.group_id = p_group_id) then
    delete from public.groups where id = p_group_id;
  end if;

  select count(*)::integer into v_remaining
  from public.group_members gm
  where gm.user_id = v_user_id;

  if v_remaining = 0 then
    delete from public.profiles where id = v_user_id;
    delete from auth.users where id = v_user_id;
    return query select true, 0::integer;
  else
    return query select false, v_remaining;
  end if;
end;
$$;

revoke all on function public.leave_study_group(uuid) from public;
grant execute on function public.leave_study_group(uuid) to anon, authenticated;
