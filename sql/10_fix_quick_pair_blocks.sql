-- Quick pairing respects player blocks: two players with a block
-- between them (either direction) are never paired and keep waiting
-- for other opponents. Same rule as create_challenge in 08_blocks.sql.
-- Idempotent; depends on 03/08.

create or replace function public.quick_pair(p_initial_ms int, p_increment_ms int)
returns uuid language plpgsql security definer set search_path = public as $$
declare
    v_uid      uuid := auth.uid();
    v_game     uuid;
    v_opponent uuid;
    v_white    uuid;
    v_black    uuid;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;
    if p_initial_ms not between 30000 and 7200000 then raise exception 'Неверный контроль времени'; end if;
    if p_increment_ms not between 0 and 60000 then raise exception 'Неверная добавка'; end if;

    delete from seeks where user_id = v_uid; -- drop own stale seek
    -- drop abandoned seeks: their owners left without cancelling, and
    -- such challenges must not linger in the open list or get paired
    delete from seeks where created_at < now() - interval '2 hours';

    -- already playing?
    select id into v_game from games
    where status = 'active' and (white = v_uid or black = v_uid)
    limit 1;
    if v_game is not null then return v_game; end if;

    -- look for an opponent: same category, not banned, free of active
    -- games (a pending link challenge does not block quick pairing), and
    -- no mutual block between the two (the same rule as challenges,
    -- enforced in both directions)
    select s.user_id into v_opponent
    from seeks s
    join profiles p on p.id = s.user_id
    where s.initial_ms = p_initial_ms
      and s.increment_ms = p_increment_ms
      and s.user_id <> v_uid
      and p.is_banned = false
      and not exists (select 1 from games g
                      where g.status = 'active'
                        and (g.white = s.user_id or g.black = s.user_id))
      and not exists (
          select 1 from public.blocked_users b
          where (b.blocker_id = s.user_id and b.blocked_id = v_uid)
             or (b.blocker_id = v_uid and b.blocked_id = s.user_id))
    order by s.created_at
    limit 1
    for update of s skip locked;

    if v_opponent is not null then
        delete from seeks where user_id = v_opponent;
        if random() < 0.5 then
            v_white := v_uid; v_black := v_opponent;
        else
            v_white := v_opponent; v_black := v_uid;
        end if;
        insert into games (white, black, status, rated, initial_ms, increment_ms,
                           white_ms, black_ms, last_move_at, position_history)
        values (v_white, v_black, 'active', true, p_initial_ms, p_increment_ms,
                p_initial_ms, p_initial_ms, now(),
                array[public.pos_key('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')])
        returning id into v_game;
        return v_game;
    end if;

    -- no opponent found: join the queue
    insert into seeks (user_id, initial_ms, increment_ms)
    values (v_uid, p_initial_ms, p_increment_ms)
    on conflict (user_id) do update
        set initial_ms = excluded.initial_ms,
            increment_ms = excluded.increment_ms,
            created_at = now();
    return null;
end $$;

revoke execute on function public.quick_pair(int, int) from anon, public;
grant  execute on function public.quick_pair(int, int) to authenticated;
