-- Player blocks. A blocked player cannot DM or challenge the blocker
-- (enforced in both directions), and may still write to the global chat
-- where the blocker's client hides those messages. RLS: each user reads
-- only their own list; writes go through RPCs.
-- Idempotent; depends on 02/05/06.

-- 1. Table
create table if not exists public.blocked_users (
    blocker_id uuid not null references public.profiles(id) on delete cascade,
    blocked_id uuid not null references public.profiles(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (blocker_id, blocked_id),
    constraint no_self_block check (blocker_id <> blocked_id)
);
create index if not exists blocked_by_blocked_idx
    on public.blocked_users (blocked_id);

alter table public.blocked_users enable row level security;

-- each user reads only their OWN blocked list
drop policy if exists "blocks_select_own" on public.blocked_users;
create policy "blocks_select_own" on public.blocked_users for select to authenticated
    using (blocker_id = auth.uid());
-- no insert/update/delete policies: writes go through the RPCs below

-- 2. RPC: block / unblock
create or replace function public.block_user(p_target uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    if p_target is null then raise exception 'Игрок не указан'; end if;
    if p_target = v_uid then raise exception 'Нельзя заблокировать самого себя'; end if;
    if not exists (select 1 from public.profiles where id = p_target) then
        raise exception 'Игрок не найден';
    end if;
    insert into public.blocked_users (blocker_id, blocked_id)
    values (v_uid, p_target)
    on conflict (blocker_id, blocked_id) do nothing;
end $$;

create or replace function public.unblock_user(p_target uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then raise exception 'Требуется вход'; end if;
    delete from public.blocked_users
    where blocker_id = auth.uid() and blocked_id = p_target;
end $$;

-- 3. send_dm: a block in either direction denies the message
create or replace function public.send_dm(p_recipient uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    v_row dm_messages%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    if p_recipient is null or p_recipient = v_uid then
        raise exception 'Нельзя написать самому себе';
    end if;
    if not exists (select 1 from public.profiles where id = p_recipient) then
        raise exception 'Получатель не найден';
    end if;
    -- BLOCKS: enforced in both directions
    if exists (
        select 1 from public.blocked_users b
        where (b.blocker_id = p_recipient and b.blocked_id = v_uid)
           or (b.blocker_id = v_uid and b.blocked_id = p_recipient)
    ) then
        raise exception 'Отправка невозможна: один из игроков заблокировал другого';
    end if;
    if p_body is null or char_length(btrim(p_body)) not between 1 and 2000 then
        raise exception 'Сообщение должно быть от 1 до 2000 символов';
    end if;
    -- rate limit
    if exists (select 1 from public.dm_messages d
               where d.sender_id = v_uid
                 and d.created_at > now() - interval '800 milliseconds') then
        raise exception 'Слишком быстро — подождите секунду';
    end if;
    insert into public.dm_messages (sender_id, recipient_id, body)
    values (v_uid, p_recipient, btrim(p_body)) returning * into v_row;
    return jsonb_build_object('ok', true, 'message', to_jsonb(v_row));
end $$;

-- 4. create_challenge: a blocked player cannot be challenged
create or replace function public.create_challenge(
    p_initial_ms int, p_increment_ms int, p_rated boolean,
    p_color text default 'random', p_invitee uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    v_me_white boolean;
    v_game uuid;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    if p_initial_ms not between 30000 and 7200000 then raise exception 'Неверный контроль времени'; end if;
    if p_increment_ms not between 0 and 60000 then raise exception 'Неверная добавка'; end if;
    if p_color not in ('white','black','random') then raise exception 'Неверный цвет'; end if;
    if p_invitee is not null then
        if p_invitee = v_uid then raise exception 'Нельзя вызвать самого себя'; end if;
        if not exists (select 1 from public.profiles p where p.id = p_invitee) then
            raise exception 'Игрок не найден';
        end if;
        if public.p_is_banned(p_invitee) then raise exception 'Игрок заблокирован'; end if;
        -- BLOCKS: enforced in both directions
        if exists (
            select 1 from public.blocked_users b
            where (b.blocker_id = p_invitee and b.blocked_id = v_uid)
               or (b.blocker_id = v_uid and b.blocked_id = p_invitee)
        ) then
            raise exception 'Вызов невозможен: один из игроков заблокировал другого';
        end if;
    end if;

    if p_color = 'white' then v_me_white := true;
    elsif p_color = 'black' then v_me_white := false;
    else v_me_white := random() < 0.5;
    end if;

    insert into games (white, black, invitee, status, rated, initial_ms, increment_ms,
                       white_ms, black_ms, last_move_at, position_history)
    values (case when v_me_white then v_uid end,
            case when v_me_white then null else v_uid end,
            p_invitee,
            'waiting', p_rated, p_initial_ms, p_increment_ms,
            p_initial_ms, p_initial_ms, now(),
            array[public.pos_key('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')])
    returning id into v_game;
    return v_game;
end $$;

-- 5. Permissions
revoke execute on function public.block_user(uuid)   from public, anon;
revoke execute on function public.unblock_user(uuid) from public, anon;
grant  execute on function public.block_user(uuid)   to authenticated;
grant  execute on function public.unblock_user(uuid) to authenticated;
