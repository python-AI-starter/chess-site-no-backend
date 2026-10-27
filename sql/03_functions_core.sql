-- Core functions: SAN, utilities, finalization, matchmaking.
-- All functions are security definer with a pinned search_path.

-- milliseconds from timestamptz (for the client)
create or replace function public.api_ms(p_t timestamptz)
returns bigint language sql immutable as
$$ select (extract(epoch from p_t) * 1000)::bigint $$;

-- ban check
create or replace function public.p_is_banned(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select is_banned from public.profiles where id = p_uid), false) $$;

-- position key for repetition checks: first 4 FEN fields
create or replace function public.pos_key(p_fen text)
returns text language sql immutable as
$$ select array_to_string((string_to_array(p_fen, ' '))[1:4], ' ') $$;

-- SAN notation for the move history. A thin wrapper over the board
-- cores: one parse_fen, one chess_play_move_b, one chess_san_b. Illegal
-- moves still produce the base SAN without check suffixes.
create or replace function public.chess_san(p_fen text, p_uci text)
returns text language plpgsql immutable as $$
declare
    v_b   chess_board;
    v_res chess_move_result;
begin
    if p_fen is null or p_uci is null then
        return p_uci;
    end if;
    if p_uci !~ '^[a-h][1-8][a-h][1-8][qrbn]?$' then
        return p_uci;
    end if;
    v_b := public.chess_parse_fen(p_fen);
    v_res := public.chess_play_move_b(v_b, p_uci);
    if not v_res.is_legal then
        -- illegal move: base SAN without check suffixes
        return public.chess_san_b(v_b, p_uci, false, false);
    end if;
    return public.chess_san_b(v_b, p_uci, v_res.is_check, v_res.reason = 'checkmate');
end $$;

-- Game finalization (private)
create or replace function public._finish_game(
    p_game_id uuid, p_result text, p_winner uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
    g            games%rowtype;
    v_counted    boolean;
    v_rw         int;
    v_rb         int;
    v_score_w    float;
    v_expected_w float;
    v_delta_w    int;
begin
    select * into g from games where id = p_game_id for update;
    if not found then return; end if;
    if g.status in ('finished','aborted') then return; end if; -- idempotent

    v_counted := coalesce(jsonb_array_length(g.moves), 0) >= 2; -- both players moved

    -- the result is always recorded (including first-move flags and
    -- cheats); rating and stats apply only when both sides moved
    update games set status = 'finished', result = p_result, winner = p_winner,
                     reason = p_reason, finished_at = now()
    where id = g.id;

    if not v_counted then return; end if;
    if g.white is null or g.black is null then return; end if;

    select rating into v_rw from profiles where id = g.white;
    select rating into v_rb from profiles where id = g.black;

    if g.rated and v_rw is not null and v_rb is not null then
        v_score_w    := case when p_result = '1-0' then 1.0
                             when p_result = '0-1' then 0.0 else 0.5 end;
        v_expected_w := 1.0 / (1.0 + power(10.0, (v_rb - v_rw)::float / 400.0));
        v_delta_w    := round(32 * (v_score_w - v_expected_w))::int;
    else
        v_delta_w := 0;
    end if;

    update profiles set
        games  = games + 1,
        wins   = wins   + (case when p_result = '1-0' then 1 else 0 end),
        losses = losses + (case when p_result = '0-1' then 1 else 0 end),
        draws  = draws  + (case when p_result = '1/2-1/2' then 1 else 0 end),
        rating = case when g.rated then greatest(100, rating + v_delta_w) else rating end
    where id = g.white;

    update profiles set
        games  = games + 1,
        wins   = wins   + (case when p_result = '0-1' then 1 else 0 end),
        losses = losses + (case when p_result = '1-0' then 1 else 0 end),
        draws  = draws  + (case when p_result = '1/2-1/2' then 1 else 0 end),
        rating = case when g.rated then greatest(100, rating - v_delta_w) else rating end
    where id = g.black;

    update games set rating_delta = jsonb_build_object('white', v_delta_w, 'black', -v_delta_w)
    where id = g.id;
end $$;

-- Server time
create or replace function public.server_now_ms()
returns bigint language sql volatile as
$$ select public.api_ms(clock_timestamp()) $$;

-- Quick pairing
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

revoke execute on function public.quick_pair(int, int) from anon;

-- Cancel seek
create or replace function public.cancel_seek()
returns void language sql security definer set search_path = public as
$$ delete from seeks where user_id = auth.uid() $$;

revoke execute on function public.cancel_seek() from anon;

-- Create challenge (friend game via link; p_invitee is set for a
-- direct challenge and restricts joining to that player)
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

revoke execute on function public.create_challenge(int, int, boolean, text, uuid) from anon;

-- Cancel own waiting challenge
create or replace function public.cancel_waiting_game(p_game_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    delete from games
    where id = p_game_id and status = 'waiting'
      and (white = v_uid or black = v_uid);
end $$;

revoke execute on function public.cancel_waiting_game(uuid) from anon;

-- Join a challenge
create or replace function public.join_game(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    g     games%rowtype;
begin
    if v_uid is null then raise exception 'Требуется вход'; end if;
    if public.p_is_banned(v_uid) then raise exception 'Аккаунт заблокирован'; end if;

    select * into g from games where id = p_game_id for update;
    if not found then raise exception 'Партия не найдена'; end if;

    if g.status = 'active' and (g.white = v_uid or g.black = v_uid) then
        -- already my active game
        return jsonb_build_object('ok', true, 'game', to_jsonb(g),
                                  'server_now_ms', public.api_ms(clock_timestamp()));
    end if;
    if g.status <> 'waiting' then raise exception 'К этой партии уже нельзя присоединиться'; end if;
    if g.white = v_uid or g.black = v_uid then
        return jsonb_build_object('ok', true, 'game', to_jsonb(g),
                                  'server_now_ms', public.api_ms(clock_timestamp()));
    end if;
    if g.white is not null and g.black is not null then
        raise exception 'Партия уже полная'; end if;

    update games set
        white = coalesce(white, v_uid),
        black = case when white is null then black else v_uid end,
        status = 'active',
        last_move_at = now()
    where id = g.id returning * into g;

    return jsonb_build_object('ok', true, 'game', to_jsonb(g),
                              'legal_moves', to_jsonb(public.chess_get_moves(g.fen)),
                              'server_now_ms', public.api_ms(clock_timestamp()));
end $$;

revoke execute on function public.join_game(uuid) from anon;
